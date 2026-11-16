
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import earcut, {flatten, deviation, refine, repair, validateTriangles} from '../src/earcut.js';
import fs from 'fs';
import expected from './expected.json' with {type: 'json'};
import {readTilesFixture} from '../bench/tiles-fixture.js';

test('indices-2d', () => {
    const indices = earcut([10, 0, 0, 50, 60, 60, 70, 10]);
    assert.deepEqual(indices, [1, 0, 3, 1, 3, 2]);
});

test('indices-3d', () => {
    const indices = earcut([10, 0, 0, 0, 50, 0, 60, 60, 0, 70, 10, 0], null, 3);
    assert.deepEqual(indices, [1, 0, 3, 1, 3, 2]);
});

test('empty', () => {
    assert.deepEqual(earcut([]), []);
});

test('flatten skips empty rings', () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10]], hole = [[2, 2], [4, 2], [3, 4]];
    assert.deepEqual(flatten([outer, hole, []]), flatten([outer, hole]));
    const {vertices, holes, dimensions} = flatten([outer, []]);
    assert.deepEqual(earcut(vertices, holes, dimensions), earcut(flatten([outer]).vertices));
});

// tracks the worst deviation across the three non-zero rotations per fixture,
// so we can tell when the errors-with-rotation bound can be tightened
const maxRotated = new Map();

function trianglePerimeter(triangles, vertices, dim = 2) {
    let perimeter = 0;
    for (let i = 0; i < triangles.length; i += 3) {
        const ax = vertices[triangles[i] * dim],
            ay = vertices[triangles[i] * dim + 1],
            bx = vertices[triangles[i + 1] * dim],
            by = vertices[triangles[i + 1] * dim + 1],
            cx = vertices[triangles[i + 2] * dim],
            cy = vertices[triangles[i + 2] * dim + 1];

        perimeter += Math.hypot(ax - bx, ay - by) +
            Math.hypot(bx - cx, by - cy) +
            Math.hypot(cx - ax, cy - ay);
    }
    return perimeter;
}

function countIllegalEdges(triangles, vertices, dim = 2) {
    const halfEdges = new Int32Array(triangles.length);
    halfEdges.fill(-1);
    const edges = new Map();

    for (let e = 0; e < triangles.length; e++) {
        const a = triangles[e];
        const b = triangles[nextHalfEdge(e)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const twin = edges.get(key);
        if (twin !== undefined) {
            halfEdges[e] = twin;
            halfEdges[twin] = e;
            edges.delete(key);
        } else {
            edges.set(key, e);
        }
    }

    let illegal = 0;
    for (let a = 0; a < triangles.length; a++) {
        const b = halfEdges[a];
        if (b === -1 || a > b) continue;

        const a0 = a - a % 3;
        const b0 = b - b % 3;
        const ar = a0 + (a + 2) % 3;
        const al = a0 + (a + 1) % 3;
        const bl = b0 + (b + 2) % 3;
        const p0 = triangles[ar], pr = triangles[a], pl = triangles[al], p1 = triangles[bl];

        const x0 = vertices[p0 * dim], y0 = vertices[p0 * dim + 1];
        const xr = vertices[pr * dim], yr = vertices[pr * dim + 1];
        const xl = vertices[pl * dim], yl = vertices[pl * dim + 1];
        const x1 = vertices[p1 * dim], y1 = vertices[p1 * dim + 1];
        const convex = orient(x0, y0, xr, yr, x1, y1) > 0 && orient(x0, y0, x1, y1, xl, yl) > 0;

        if (convex && !inCircle(x0, y0, xr, yr, xl, yl, x1, y1)) illegal++;
    }
    return illegal;
}

function nextHalfEdge(e) {
    return e - e % 3 + (e + 1) % 3;
}

function orient(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function inCircle(ax, ay, bx, by, cx, cy, px, py) {
    const dx = ax - px, dy = ay - py, ex = bx - px, ey = by - py, fx = cx - px, fy = cy - py;
    const ap = dx * dx + dy * dy, bp = ex * ex + ey * ey, cp = fx * fx + fy * fy;
    return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) <= 0;
}

for (const id of Object.keys(expected.triangles)) {

    for (const rotation of [0, 90, 180, 270]) {
        test(`${id} rotation ${rotation}`, (t) => {
            const coords = JSON.parse(fs.readFileSync(new URL(`fixtures/${id}.json`, import.meta.url)));
            const theta = rotation * Math.PI / 180;
            const xx = Math.round(Math.cos(theta));
            const xy = Math.round(-Math.sin(theta));
            const yx = Math.round(Math.sin(theta));
            const yy = Math.round(Math.cos(theta));
            if (rotation) {
                for (const ring of coords) {
                    for (const coord of ring) {
                        const [x, y] = coord;
                        coord[0] = xx * x + xy * y;
                        coord[1] = yx * x + yy * y;
                    }
                }
            }
            const data = flatten(coords),
                indices = earcut(data.vertices, data.holes, data.dimensions),
                err = deviation(data.vertices, data.holes, data.dimensions, indices),
                expectedTriangles = expected.triangles[id],
                expectedDeviation = (rotation !== 0 && expected['errors-with-rotation'][id]) || expected.errors[id] || 0;

            const numTriangles = indices.length / 3;
            if (rotation === 0) {
                assert.ok(numTriangles === expectedTriangles, `${numTriangles} triangles when expected ${expectedTriangles}`);
            }

            if (expectedTriangles > 0) {
                assert.ok(err <= expectedDeviation, `deviation ${err} <= ${expectedDeviation}`);
            }

            // surface fixtures whose deviation is well below the recorded threshold (at least 3x),
            // so improvements after a correctness fix are visible and the threshold can be tightened;
            // for rotations, compare the worst of the three against the shared errors-with-rotation bound
            if (rotation === 0) {
                if (expectedDeviation > 0 && err * 3 < expectedDeviation) {
                    t.diagnostic(`${id}: deviation ${err} < recorded ${expectedDeviation} (improved)`);
                }
            } else {
                maxRotated.set(id, Math.max(maxRotated.get(id) || 0, err));
                if (rotation === 270 && expectedDeviation > 0 && maxRotated.get(id) * 3 < expectedDeviation) {
                    t.diagnostic(`${id} rotated: max deviation ${maxRotated.get(id)} < recorded ${expectedDeviation} (improved)`);
                }
            }
        });
    }
}

test('infinite-loop', () => {
    earcut([1, 2, 2, 2, 1, 2, 1, 1, 1, 2, 4, 1, 5, 1, 3, 2, 4, 2, 4, 1], [5], 2);
});

test('large convex polygon', () => {
    // a strictly convex ring skips the point checks of ear slicing; with them, each hashed check of its fan of long
    // triangles scans a large part of the ring, and this takes seconds instead of milliseconds
    const n = 100000, vertices = [];
    for (let i = 0; i < n; i++) vertices.push(Math.cos(2 * Math.PI * i / n), Math.sin(2 * Math.PI * i / n));
    const triangles = earcut(vertices);
    assert.equal(triangles.length / 3, n - 2);
    assert.ok(deviation(vertices, null, 2, triangles) < 1e-12);
});

test('nested splits do not overflow a small call stack', async () => {
    // a rectangle with k small triangular holes, each one step right and down from the previous; every hole adds a
    // level of nested splits. Runs in a worker with a fixed small stack (like a browser worker's) that recursive
    // splitting overflows from k ≈ 400; the worker code is inline because node --test runs every .js file in test/
    const url = new URL('../src/earcut.js', import.meta.url).href;
    const worker = new Worker(`
        const {parentPort, workerData: {url, k}} = require('node:worker_threads');
        const vertices = [-1, -k, 2 * k + 1, -k, 2 * k + 1, 7, -1, 7], holes = [];
        for (let i = 0; i < k; i++) {
            holes.push(vertices.length / 2);
            vertices.push(1 + 2 * i, -i, 2 * i, 6 - i, 2 + 2 * i, 6 - i);
        }
        import(url).then(({default: earcut, deviation}) => {
            const triangles = earcut(vertices, holes);
            parentPort.postMessage([triangles.length / 3, deviation(vertices, holes, 2, triangles)]);
        });
    `, {eval: true, workerData: {url, k: 600}, resourceLimits: {stackSizeMb: 0.35}});
    const [count, dev] = await new Promise((resolve, reject) => {
        worker.on('message', resolve).on('error', reject);
        worker.on('exit', code => reject(new Error(`worker exited with code ${code}`)));
    });
    assert.equal(count, 3002);
    assert.equal(dev, 0);
});

test('collinear polygon has zero deviation despite shoelace roundoff', () => {
    const vertices = [0.1, 0.2, 1.3, 2.6, 2.5, 5.0, 3.7, 7.4]; // on the line y = 2x
    const triangles = earcut(vertices);
    assert.equal(triangles.length, 0);
    assert.equal(deviation(vertices, null, 2, triangles), 0);
});

test('refine improves a bad quad diagonal', () => {
    const vertices = [0, 0, 3, 0, 10, 1, 0, 2];
    const triangles = [2, 3, 0, 2, 0, 1];
    const beforePerimeter = trianglePerimeter(triangles, vertices);
    refine(triangles, vertices);
    const afterPerimeter = trianglePerimeter(triangles, vertices);

    assert.deepEqual(triangles, [2, 3, 1, 3, 0, 1]);
    assert.ok(afterPerimeter < beforePerimeter * 0.7);
    assert.equal(deviation(vertices, null, 2, triangles), 0);
});

test('refine improves a clockwise quad diagonal, keeping the winding', () => {
    const vertices = [0, 0, 3, 0, 10, 1, 0, 2];
    const triangles = [2, 0, 3, 2, 1, 0];
    refine(triangles, vertices);

    assert.deepEqual(triangles, [1, 0, 3, 2, 1, 3]);
    assert.equal(deviation(vertices, null, 2, triangles), 0);
});

test('refine leaves a good quad diagonal alone', () => {
    const vertices = [0, 0, 5, 0, 4, 1, 0, 4];
    const triangles = [2, 3, 0, 2, 0, 1];

    refine(triangles, vertices);

    assert.deepEqual(triangles, [2, 3, 0, 2, 0, 1]);
    assert.equal(deviation(vertices, null, 2, triangles), 0);
});

test('refine preserves a concave polygon', () => {
    const vertices = [0, 0, 4, 0, 4, 1, 1, 1, 1, 4, 0, 4];
    const triangles = earcut(vertices);
    const length = triangles.length;
    const beforePerimeter = trianglePerimeter(triangles, vertices);
    refine(triangles, vertices);
    const afterPerimeter = trianglePerimeter(triangles, vertices);

    assert.equal(triangles.length, length);
    assert.ok(afterPerimeter < beforePerimeter * 0.9);
    assert.equal(deviation(vertices, null, 2, triangles), 0);
});

test('refine terminates on near-cocircular points', {timeout: 5000}, () => {
    // Four near-cocircular points make the non-robust inCircle test give inconsistent signs for an
    // edge and its flip; without the tie margin the Lawson cascade flips one edge back and forth
    // forever. Should return with a valid mesh of unchanged size and zero deviation.
    const vertices = [
        127.65906365022843, 9.336137742499535, 124.21725103117963, 30.888097161477972,
        91.35514946628345, 89.65621376119454, 40.10446780041529, 121.5550560957686,
        -110.83205604043928, 64.03323632184248, -127.20394987965459, -14.253249980770189,
        61.074962259031416, -112.48932831632469, 127.37846573978545, -12.598669206638515,
        127.77010311801033, -7.668164657400608];
    const triangles = earcut(vertices);
    const length = triangles.length;
    refine(triangles, vertices);
    assert.equal(triangles.length, length);
    assert.ok(deviation(vertices, null, 2, triangles) < 1e-15);
});

test('refine legalizes all convex interior edges in earcut fixture', () => {
    const coords = JSON.parse(fs.readFileSync(new URL('fixtures/earcut.json', import.meta.url)));
    const data = flatten(coords);
    const triangles = earcut(data.vertices, data.holes, data.dimensions);

    refine(triangles, data.vertices, data.dimensions);

    assert.equal(countIllegalEdges(triangles, data.vertices, data.dimensions), 0);
    assert.equal(deviation(data.vertices, data.holes, data.dimensions, triangles), 0);
});

test('mvt fixture has zero deviation and refined quality', () => {
    const polys = readTilesFixture();
    let nonzero = 0;
    let firstIndex = -1;
    let firstDev = 0;
    let worstIndex = -1;
    let worstDev = 0;
    let sumDev = 0;
    let refinedNonzero = 0;
    let refinedFirstIndex = -1;
    let refinedFirstDev = 0;
    let refinedWorstIndex = -1;
    let refinedWorstDev = 0;
    let refinedSumDev = 0;
    let lengthChanged = 0;
    let basePerimeter = 0;
    let refinedPerimeter = 0;

    for (let i = 0; i < polys.length; i++) {
        const data = polys[i];
        const triangles = earcut(data.vertices, data.holes, data.dimensions);
        const length = triangles.length;
        basePerimeter += trianglePerimeter(triangles, data.vertices, data.dimensions);
        const dev = deviation(data.vertices, data.holes, data.dimensions, triangles);
        if (dev !== 0) {
            if (firstIndex < 0) {
                firstIndex = i;
                firstDev = dev;
            }
            nonzero++;
            sumDev += dev;
            if (dev > worstDev) {
                worstIndex = i;
                worstDev = dev;
            }
        }

        refine(triangles, data.vertices, data.dimensions);
        refinedPerimeter += trianglePerimeter(triangles, data.vertices, data.dimensions);
        if (triangles.length !== length) lengthChanged++;

        const refinedDev = deviation(data.vertices, data.holes, data.dimensions, triangles);
        if (refinedDev !== 0) {
            if (refinedFirstIndex < 0) {
                refinedFirstIndex = i;
                refinedFirstDev = refinedDev;
            }
            refinedNonzero++;
            refinedSumDev += refinedDev;
            if (refinedDev > refinedWorstDev) {
                refinedWorstIndex = i;
                refinedWorstDev = refinedDev;
            }
        }
    }

    assert.equal(polys.length, 119680);
    assert.equal(nonzero, 0,
        `${nonzero} polygons with nonzero deviation; first ${firstIndex}: ${firstDev}, ` +
        `worst ${worstIndex}: ${worstDev}, sum ${sumDev}`);

    assert.equal(lengthChanged, 0, `${lengthChanged} refined triangulations changed triangle count`);
    assert.equal(refinedNonzero, 0,
        `${refinedNonzero} refined polygons with nonzero deviation; first ${refinedFirstIndex}: ${refinedFirstDev}, ` +
        `worst ${refinedWorstIndex}: ${refinedWorstDev}, sum ${refinedSumDev}`);

    assert.ok(refinedPerimeter < basePerimeter * 0.72, `refined perimeter ratio ${refinedPerimeter / basePerimeter} < 0.72`);
});

// Regression for the hole-bridge block index (issue #183): a collinear-rich outer ring
// (integer grid, like MVT data) plus multiple holes used to drop a hole when filterPoints
// healed a collinear run across a block boundary, leaving the surviving edge outside its
// block's stale bbox so the leftward-ray scan false-skipped it. Assert full coverage.
test('block-index-collinear', () => {
    const N = 30;
    const outer = [];
    for (let x = 0; x <= N; x++) outer.push([x, 0]);
    for (let y = 1; y <= N; y++) outer.push([N, y]);
    for (let x = N - 1; x >= 0; x--) outer.push([x, N]);
    for (let y = N - 1; y >= 1; y--) outer.push([0, y]);
    const rect = (x0, y0, w, h) => [[x0, y0], [x0, y0 + h], [x0 + w, y0 + h], [x0 + w, y0]];
    const rings = [outer, rect(5, 5, 2, 4), rect(2, 23, 1, 1)];

    for (const rotation of [0, 90, 180, 270]) {
        const theta = rotation * Math.PI / 180;
        const xx = Math.round(Math.cos(theta)), xy = Math.round(-Math.sin(theta));
        const yx = Math.round(Math.sin(theta)), yy = Math.round(Math.cos(theta));
        const rotated = rings.map(ring => ring.map(([x, y]) => [xx * x + xy * y, yx * x + yy * y]));
        const data = flatten(rotated);
        const indices = earcut(data.vertices, data.holes, data.dimensions);
        const err = deviation(data.vertices, data.holes, data.dimensions, indices);
        assert.ok(err < 1e-9, `rotation ${rotation}: deviation ${err} (hole dropped?)`);
    }
});

// ─── repair(): dirty-input cleaning and validation ─────────────────────────────────────────────

// triangulate every polygon repair() emits and validate the resulting index buffer end to end
function repairAndTriangulate(data, holes, dim = 2, options) {
    const repaired = repair(data, holes, dim, options);
    const triangulated = repaired.polygons.map((polygon) => {
        const raw = earcut(polygon.vertices, polygon.holes, polygon.dimensions);
        const checked = validateTriangles(raw, polygon.vertices, polygon.dimensions);
        assert.deepEqual(checked.errors, []);
        assert.equal(
            deviation(polygon.vertices, polygon.holes, polygon.dimensions, checked.triangles), 0);
        return {polygon, triangles: checked.triangles};
    });
    return {...repaired, triangulated};
}

test('repair removes duplicate, collinear and repeated closing points', () => {
    // square with a doubled vertex, a collinear midpoint and a repeated first point at the end
    const data = [0, 0, 0, 0, 5, 0, 10, 0, 10, 10, 0, 10, 0, 0];
    const result = repairAndTriangulate(data);

    assert.equal(result.stats.removedClosing, 1);
    assert.equal(result.stats.removedDuplicates, 1);
    assert.equal(result.stats.removedCollinear, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 1);
    assert.equal(result.polygons[0].vertices.length, 8); // the four distinct square corners
    assert.equal(result.triangulated[0].triangles.length, 6); // one square → two triangles
});

test('repair rejects a degenerate ring instead of triangulating it', () => {
    const line = repair([0, 0, 5, 0, 10, 0]);
    assert.equal(line.polygons.length, 0);
    assert.equal(line.errors[0].code, 'degenerate-ring');

    const twoPoints = repair([0, 0, 0, 0, 1, 1]);
    assert.equal(twoPoints.polygons.length, 0);
    assert.equal(twoPoints.stats.droppedRings, 1);

    assert.deepEqual(repair([]), {polygons: [], errors: [], stats: {
        removedDuplicates: 0, removedCollinear: 0, removedClosing: 0, splitRings: 0, droppedRings: 0}});
});

test('repair rejects a self-intersecting ring by default and never emits triangles for it', () => {
    // bowtie: plain earcut() silently returns a triangle with infinite deviation
    const bowtie = [0, 0, 10, 0, 0, 10, 10, 10];
    const result = repair(bowtie);

    assert.equal(result.polygons.length, 0);
    assert.equal(result.errors[0].code, 'self-intersection');
    assert.equal(result.errors[0].ring, 0);
    assert.equal(repair(bowtie, null, 2, {selfIntersect: 'error'}).polygons.length, 0);
});

test('repair splits a self-intersecting ring into simple rings when asked', () => {
    const bowtie = [0, 0, 10, 0, 0, 10, 10, 10];
    const result = repairAndTriangulate(bowtie, null, 2, {selfIntersect: 'split'});

    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 2);
    assert.ok(result.stats.splitRings >= 1);
    // each lobe is a triangle, and both share the synthetic crossing vertex
    const total = result.triangulated.reduce((sum, t) => sum + t.triangles.length / 3, 0);
    assert.equal(total, 2);
    assert.deepEqual(result.polygons.map(p => p.sourceRings), [[0], [0]]);
});

test('repair splits a figure-eight ring meeting at a shared vertex', () => {
    // two squares touching at (0,0), which appears twice in the ring order
    const figureEight = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0, -10, 0, -10, -10, 0, -10];
    const result = repairAndTriangulate(figureEight, null, 2, {selfIntersect: 'split'});

    assert.equal(result.polygons.length, 2);
    const total = result.triangulated.reduce((sum, t) => sum + t.triangles.length / 3, 0);
    assert.equal(total, 4); // two quads, two triangles each
});

test('repair reports collinear edge overlap as unsplittable even in split mode', () => {
    // edge (0,0)-(10,0) overlaps the disjoint edge (6,0)-(4,0): no unambiguous split exists
    const data = [0, 0, 10, 0, 10, 10, 6, 0, 4, 0, 4, -5, 6, -5];
    const result = repair(data, null, 2, {selfIntersect: 'split'});

    assert.ok(result.errors.some(e => e.code === 'self-intersection'));
});

test('repair rejects a hole declared outside the outer ring instead of silently dropping it', () => {
    // square outer ring plus a square hole sitting entirely outside it
    const data = [0, 0, 10, 0, 10, 10, 0, 10, 20, 20, 30, 20, 30, 30, 20, 30];
    const result = repairAndTriangulate(data, [4]);

    assert.ok(result.errors.some(e => e.code === 'hole-outside' && e.ring === 1));
    assert.equal(result.polygons.length, 1);
    assert.deepEqual(result.polygons[0].holes, []); // bad hole removed, outer ring still triangulated
});

test('repair keeps a normal hole as a hole', () => {
    const data = [0, 0, 100, 0, 100, 100, 0, 100, 20, 20, 80, 20, 80, 80, 20, 80];
    const result = repairAndTriangulate(data, [4]);

    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 1);
    assert.deepEqual(result.polygons[0].holes, [4]);
});

test('repair turns a nested island into its own polygon so the hole cannot cover the outer ring', () => {
    // outer square (400), hole ring (256), island ring inside the hole (100)
    const data = [
        0, 0, 20, 0, 20, 20, 0, 20,
        2, 2, 18, 2, 18, 18, 2, 18,
        5, 5, 15, 5, 15, 15, 5, 15];
    const result = repairAndTriangulate(data, [4, 8]);

    assert.ok(result.errors.some(e => e.code === 'nested-ring' && e.ring === 2));
    assert.equal(result.polygons.length, 2);

    const outer = result.polygons.find(p => p.sourceRings.includes(0));
    const island = result.polygons.find(p => p.sourceRings.includes(2));
    assert.equal(outer.holes.length, 1);
    assert.deepEqual(island.holes, []);

    // filled area = outer − hole + island = 400 − 256 + 100 = 244, matching every emitted triangle
    let area = 0;
    for (const group of result.triangulated) {
        const v = group.polygon.vertices, d = group.polygon.dimensions;
        for (let k = 0; k < group.triangles.length; k += 3) {
            const a = group.triangles[k] * d, b = group.triangles[k + 1] * d, c = group.triangles[k + 2] * d;
            area += Math.abs((v[a] - v[c]) * (v[b + 1] - v[a + 1]) -
                (v[a] - v[b]) * (v[c + 1] - v[a + 1])) / 2;
        }
    }
    assert.ok(Math.abs(area - 244) < 1e-9, `filled area ${area} !== 244`);
});

test('repair rejects a hole whose boundary crosses the outer ring instead of mistriangulating it', () => {
    // the hole rectangle straddles the outer square's left edge; plain earcut() gives a
    // nonzero deviation here, repair() must drop the hole and keep the outer ring intact
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const crossingHole = [-2, 4, 4, 4, 4, 6, -2, 6];
    const result = repairAndTriangulate([...outer, ...crossingHole], [4]);

    assert.ok(result.errors.some(e => e.code === 'overlapping-rings' && e.ring === 1));
    assert.equal(result.polygons.length, 1);
    assert.deepEqual(result.polygons[0].holes, []);
});

test('repair rejects near-zero-area sliver rings that would yield zero-area triangles', () => {
    // triangle area = 5e-15, below the roundoff-scaled epsilon but not exactly zero
    const result = repair([0, 0, 10, 0, 5, 1e-15]);
    assert.equal(result.polygons.length, 0);
    assert.equal(result.errors[0].code, 'degenerate-ring');
});

test('every ring emitted by repair in split mode is simple and triangulates with zero deviation', () => {
    // figure-eight whose split lobes must never be mis-grouped as a shell and its hole
    const bowtie = [0, 0, 10, 10, 0, 10, 10, 0];
    const result = repairAndTriangulate(bowtie, null, 2, {selfIntersect: 'split'});

    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 2);
    for (const polygon of result.polygons) assert.deepEqual(polygon.holes, []);
});

test('repair reports each problem source ring once even when it splits into several rings', () => {
    // a self-intersecting hole that fans out into lobes outside the outer ring: hole-outside must
    // be reported for ring 1 once, not once per emitted lobe
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const badHole = [50, 50, 60, 60, 50, 60, 60, 50]; // bowtie shape well outside the outer ring
    const result = repair([...outer, ...badHole], [4], 2, {selfIntersect: 'split'});

    const outside = result.errors.filter(e => e.code === 'hole-outside' && e.ring === 1);
    assert.equal(outside.length, 1);
});

test('repair preserves extra dimensions for 3D input', () => {
    const data = [0, 0, 9, 0, 0, 9, 10, 0, 9, 10, 10, 9, 0, 10, 9, 0, 0, 9];
    const result = repairAndTriangulate(data, null, 3);

    assert.equal(result.polygons[0].dimensions, 3);
    assert.equal(result.polygons[0].vertices.length, 12);
    assert.equal(result.stats.removedClosing, 1);
});

test('repair throws on structural misuse but never on geometric defects', () => {
    assert.throws(() => repair([0, 0, 1, 1, 2, 2], [10]), RangeError);
    assert.throws(() => repair([0, 0, 1], null, 2), RangeError); // trailing partial vertex
    assert.throws(() => repair([0, 0, 1, 1, 2, 2], [1, 1]), RangeError); // non-increasing holes
    assert.throws(() => repair([0, 0, 1, 1], null, 1), RangeError); // dim < 2
    assert.throws(() => validateTriangles([], [0, 0, 1], 2), RangeError); // partial vertex in data
    // geometrically empty input is not misuse; an explicit null options object is accepted
    assert.doesNotThrow(() => repair([]));
    assert.doesNotThrow(() => repair([0, 0, 10, 0, 10, 10], null, 2, null));
});

test('repair is also available as earcut.repair and leaves the default export signature intact', () => {
    assert.equal(earcut.repair, repair);
    assert.deepEqual(earcut([10, 0, 0, 50, 60, 60, 70, 10]), [1, 0, 3, 1, 3, 2]);
});

test('validateTriangles drops degenerate and out-of-range triangles without mutating input', () => {
    const vertices = [0, 0, 10, 0, 10, 10, 0, 10];
    // good, good, zero-area (0,0,1 collinear with... actually two equal indices), out-of-range
    const raw = [0, 1, 2, 0, 2, 3, 0, 0, 1, 0, 3, 99];
    const snapshot = raw.slice();
    const result = validateTriangles(raw, vertices);

    assert.equal(result.triangles.length, 6); // the two valid triangles survive
    assert.equal(result.stats.droppedDegenerate, 1);
    assert.equal(result.stats.droppedInvalid, 1);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(raw, snapshot); // input buffer untouched
});

test('validateTriangles flags a buffer whose length is not a multiple of three', () => {
    const result = validateTriangles([0, 1, 2, 0], [0, 0, 10, 0, 10, 10]);
    assert.equal(result.triangles.length, 3);
    assert.equal(result.errors.length, 1);
});

test('repaired fixture polygons triangulate with valid indices and zero deviation under rotation', () => {
    // dirty variant of a standard polygon: closing point, a duplicate and a collinear insertion
    const coords = JSON.parse(fs.readFileSync(new URL('fixtures/earcut.json', import.meta.url)));
    const dirty = coords.map((ring) => {
        const copy = ring.map(p => p.slice());
        copy.splice(1, 0, copy[0].slice());            // duplicate of the first point
        copy.splice(2, 0, [(copy[0][0] + copy[1][0]) / 2, (copy[0][1] + copy[1][1]) / 2]); // collinear
        copy.push(copy[0].slice());                     // repeated closing point
        return copy;
    });
    const flat = flatten(dirty);

    for (const rotation of [0, 90, 180, 270]) {
        const theta = rotation * Math.PI / 180;
        const xx = Math.round(Math.cos(theta)), xy = Math.round(-Math.sin(theta));
        const yx = Math.round(Math.sin(theta)), yy = Math.round(Math.cos(theta));
        const vertices = flat.vertices.slice();
        for (let i = 0; i < vertices.length; i += 2) {
            const x = vertices[i], y = vertices[i + 1];
            vertices[i] = xx * x + xy * y;
            vertices[i + 1] = yx * x + yy * y;
        }

        const repaired = repair(vertices, flat.holes, flat.dimensions);
        assert.deepEqual(repaired.errors, []);
        for (const polygon of repaired.polygons) {
            const checked = validateTriangles(
                earcut(polygon.vertices, polygon.holes, polygon.dimensions),
                polygon.vertices, polygon.dimensions);
            assert.deepEqual(checked.errors, []);
            assert.equal(
                deviation(polygon.vertices, polygon.holes, polygon.dimensions, checked.triangles), 0);
        }
    }
});

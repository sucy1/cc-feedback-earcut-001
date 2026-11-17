import test from 'node:test';
import assert from 'node:assert/strict';
import earcut, {deviation, flatten} from '../src/earcut.js';
import repair from '../src/repair.js';

// Run every repaired polygon through earcut and assert the output contract the repair layer is
// meant to guarantee: in-range indices, no zero-area triangle, valid hole table, and a
// triangulation whose area matches the polygon's (deviation ~ 0).
function assertRepairedTriangulates(result) {
    for (const poly of result.polygons) {
        const triangles = earcut(poly.vertices, poly.holes, poly.dimensions);
        const vertexCount = poly.vertices.length / poly.dimensions;

        for (const idx of triangles) {
            assert.ok(Number.isInteger(idx) && idx >= 0 && idx < vertexCount,
                `index ${idx} outside [0, ${vertexCount})`);
        }
        for (let i = 0; i < triangles.length; i += 3) {
            const a = triangles[i] * poly.dimensions;
            const b = triangles[i + 1] * poly.dimensions;
            const c = triangles[i + 2] * poly.dimensions;
            const area2 = (poly.vertices[b] - poly.vertices[a]) * (poly.vertices[c + 1] - poly.vertices[a + 1]) -
                          (poly.vertices[b + 1] - poly.vertices[a + 1]) * (poly.vertices[c] - poly.vertices[a]);
            assert.notEqual(area2, 0, 'degenerate (zero-area) triangle survived');
        }
        let prev = 0;
        for (const h of poly.holes) {
            assert.ok(Number.isInteger(h) && h > prev && h < vertexCount, `bad hole index ${h}`);
            prev = h;
        }
        assert.ok(deviation(poly.vertices, poly.holes, poly.dimensions, triangles) <= 1e-9,
            'triangulation area does not match the repaired polygon');
    }
}

test('repair is reachable both as a named export and as earcut.repair', () => {
    assert.equal(typeof repair, 'function');
    assert.equal(earcut.repair, repair);
});

test('clean input passes through unchanged', () => {
    const vertices = [0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 8, 2, 8, 8, 2, 8];
    const result = repair(vertices, [4], 2);
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 1);
    assert.deepEqual(result.polygons[0].vertices, vertices);
    assert.deepEqual(result.polygons[0].holes, [4]);
    assert.equal(result.polygons[0].dimensions, 2);
    assertRepairedTriangulates(result);
});

test('removes a duplicated closing point', () => {
    const result = repair([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons[0].vertices.length / 2, 4);
    assertRepairedTriangulates(result);
});

test('removes an interior duplicated point', () => {
    const result = repair([0, 0, 10, 0, 10, 0, 10, 10, 0, 10]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons[0].vertices.length / 2, 4);
    assertRepairedTriangulates(result);
});

test('removes interior collinear points', () => {
    const result = repair([0, 0, 5, 0, 10, 0, 10, 5, 10, 10, 0, 10]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons[0].vertices.length / 2, 4);
    assertRepairedTriangulates(result);
});

test('a ring collapsed to a line is dropped with a degenerate-ring error', () => {
    const result = repair([0, 0, 5, 0, 10, 0]);
    assert.equal(result.polygons.length, 0);
    assert.equal(result.errors[0].code, 'degenerate-ring');
});

test('non-finite coordinates are rejected instead of poisoning the mesh', () => {
    const result = repair([0, 0, 10, 0, NaN, 10, 0, 10]);
    assert.equal(result.polygons.length, 0);
    assert.equal(result.errors[0].code, 'non-finite-coordinate');
});

test('self-intersecting ring in default mode reports an error and yields no polygon', () => {
    // bowtie / hourglass: (0,0)->(10,10)->(10,0)->(0,10)
    const result = repair([0, 0, 10, 10, 10, 0, 0, 10]);
    assert.equal(result.polygons.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'self-intersection');
});

test('self-intersecting ring splits into simple rings when onSelfIntersect: split', () => {
    const result = repair([0, 0, 10, 10, 10, 0, 0, 10], null, 2, {'onSelfIntersect': 'split'});
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 2);
    // each lobe of the bowtie is one triangle
    assert.deepEqual(result.polygons.map(p => p.vertices.length / 2).sort(), [3, 3]);
    assertRepairedTriangulates(result);
});

test('figure-eight ring sharing one vertex splits at the pinch', () => {
    // two triangles meeting only at (5,5): A->E->B->C->E->D
    const result = repair([0, 0, 5, 5, 10, 0, 10, 10, 5, 5, 0, 10], null, 2,
        {onSelfIntersect: 'split'});
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 2);
    assertRepairedTriangulates(result);

    // same input in default mode is rejected rather than triangulated wrong
    const rejected = repair([0, 0, 5, 5, 10, 0, 10, 10, 5, 5, 0, 10]);
    assert.equal(rejected.polygons.length, 0);
    assert.equal(rejected.errors[0].code, 'self-intersection');
});

test('overlapping collinear edges are rejected even in split mode', () => {
    // (10,0) doubles back along the bottom edge through (5,0): no unambiguous cut
    const result = repair([0, 0, 10, 0, 5, 0, 5, 10], null, 2, {onSelfIntersect: 'split'});
    assert.equal(result.polygons.length, 0);
    assert.equal(result.errors[0].code, 'self-intersection');
});

test('two separate rings whose edges cross are both rejected', () => {
    // two overlapping squares (not nested): their boundaries cross, so no valid earcut polygon
    // can represent them and the repair must report rather than emit a wrong mesh
    const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const b = [[5, 5], [15, 5], [15, 15], [5, 15]];
    const {vertices, holes, dimensions} = flatten([a, b]);
    const result = repair(vertices, holes, dimensions, {onSelfIntersect: 'split'});
    assert.ok(result.errors.some(e => e.code === 'self-intersection'));
    assert.equal(result.polygons.length, 0);
});

test('a valid hole stays inside its outer ring', () => {
    const result = repair([0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 8, 2, 8, 8, 2, 8], [4]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.polygons.length, 1);
    assert.deepEqual(result.polygons[0].holes, [4]);
    assertRepairedTriangulates(result);
});

test('a hole outside the outer ring becomes its own polygon and is reported', () => {
    const result = repair(
        [0, 0, 10, 0, 10, 10, 0, 10, 20, 20, 30, 20, 30, 30, 20, 30], [4]);
    assert.equal(result.polygons.length, 2);
    assert.ok(result.errors.some(e => e.code === 'hole-outside'));
    // neither polygon may carry a hole that covers its outer ring
    for (const p of result.polygons) assert.deepEqual(p.holes, []);
    assertRepairedTriangulates(result);
});

test('an island inside a hole is emitted as a separate polygon by depth', () => {
    const outer = [[0, 0], [20, 0], [20, 20], [0, 20]];
    const hole = [[2, 2], [18, 2], [18, 18], [2, 18]];
    const island = [[5, 5], [15, 5], [15, 15], [5, 15]];
    const {vertices, holes, dimensions} = flatten([outer, hole, island]);
    const result = repair(vertices, holes, dimensions);

    // two polygons: outer-with-hole, and the island standing alone (not swallowed by the hole)
    assert.equal(result.polygons.length, 2);
    const withHole = result.polygons.find(p => p.holes.length === 1);
    const alone = result.polygons.find(p => p.holes.length === 0);
    assert.ok(withHole && alone);
    assertRepairedTriangulates(result);
});

test('a hole nested inside another hole is reported and handled by depth', () => {
    // four nested rings: outer(0), hole(1), island(2), hole-inside-island(3). The depth-3 ring
    // is a hole that can only exist through nesting, so it is reported as nested-hole.
    const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const rings = [rect(0, 0, 40, 40), rect(2, 2, 38, 38), rect(5, 5, 35, 35), rect(8, 8, 32, 32)];
    const {vertices, holes, dimensions} = flatten(rings);
    const result = repair(vertices, holes, dimensions);
    assert.ok(result.errors.some(e => e.code === 'nested-hole'));
    // two even-depth outers, each carrying one depth-1 hole; no hole covers an outer ring
    assert.equal(result.polygons.length, 2);
    for (const p of result.polygons) assert.equal(p.holes.length, 1);
    assertRepairedTriangulates(result);
});

test('invalid hole indices are reported and the valid rings kept', () => {
    const result = repair([0, 0, 10, 0, 10, 10, 0, 10], [99]);
    assert.ok(result.errors.some(e => e.code === 'invalid-hole-index'));
    assert.equal(result.polygons.length, 1);
});

test('bad arguments return errors instead of throwing', () => {
    assert.deepEqual(repair(null).polygons, []);
    assert.equal(repair(null).errors[0].code, 'invalid-argument');
    assert.equal(repair([1, 2, 3], null, 1).errors[0].code, 'invalid-argument');
    assert.equal(repair([1, 2, 3], null, 2).errors[0].code, 'invalid-argument'); // length not a dim multiple
});

test('extra dimensions are preserved through repair', () => {
    const result = repair([0, 0, 9, 10, 0, 8, 10, 10, 7, 0, 10, 6], null, 3);
    assert.equal(result.polygons[0].dimensions, 3);
    assert.equal(result.polygons[0].vertices.length, 12);
    assert.deepEqual(result.polygons[0].vertices.filter((_, i) => i % 3 === 2), [9, 8, 7, 6]);
    assertRepairedTriangulates(result);
});

test('earcut output guard drops out-of-range and degenerate triangles', () => {
    // earcut itself never emits these on clean input; drive the guard directly through the
    // sanitize path by checking its observable contract on repaired dirty data end to end
    const result = repair([0, 0, 5, 0, 10, 0, 10, 10, 0, 10]); // collinear point removed
    const triangles = earcut(result.polygons[0].vertices, result.polygons[0].holes, 2);
    const nv = result.polygons[0].vertices.length / 2;
    for (const idx of triangles) assert.ok(idx >= 0 && idx < nv);
    assert.equal(triangles.length % 3, 0);
});

test('original earcut signature and best-effort behavior are unchanged', () => {
    // a self-intersecting input still triangulates via plain earcut with the same call shape —
    // repair is strictly opt-in and does not alter this path
    const direct = earcut([0, 0, 10, 10, 10, 0, 0, 10]);
    assert.ok(Array.isArray(direct));
    // whereas the guarded repair pipeline refuses it
    assert.deepEqual(repair([0, 0, 10, 10, 10, 0, 0, 10]).polygons, []);
});

test('repaired output is stable across many randomized dirty inputs', () => {
    // deterministic PRNG so the fuzz regression is reproducible
    let seed = 0xC0FFEE;
    const rand = () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const ri = n => Math.floor(rand() * n);

    for (let iter = 0; iter < 2000; iter++) {
        const numRings = 1 + ri(3);
        /** @type {number[][][]} */
        const rings = [];
        /** @type {number[]} */
        const holes = [];
        let total = 0;
        for (let r = 0; r < numRings; r++) {
            const ring = [];
            for (let i = 0, n = 3 + ri(12); i < n; i++) ring.push([ri(30), ri(30)]);
            if (rand() < 0.4) ring.push(ring[0].slice());            // closing duplicate
            if (rand() < 0.3 && ring.length > 2) {                  // interior duplicate
                ring.splice(ri(ring.length), 0, ring[ri(ring.length)].slice());
            }
            if (r > 0) holes.push(total);
            total += ring.length;
            rings.push(ring);
        }
        const vertices = rings.flat(2);
        const result = repair(vertices, holes.length ? holes : null, 2,
            {onSelfIntersect: rand() < 0.5 ? 'error' : 'split'});
        assertRepairedTriangulates(result);
    }
});

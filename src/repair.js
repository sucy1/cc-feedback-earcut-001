/**
 * @typedef {object} Ring
 * @property {number[][]} pts ring vertices, each a `dim`-tuple of coordinates
 * @property {boolean} hole whether the ring came from `holeIndices` (vs the outer ring)
 * @property {string} label human-readable ring name for error messages
 */

/**
 * @typedef {object} CleanedPolygon
 * @property {number[]} data flat cleaned vertex coordinates
 * @property {number[]} holes indices (in vertices, not coordinates) where each hole ring starts
 */

/**
 * @typedef {object} RepairOptions
 * @property {'error' | 'split'} [selfIntersection='error'] how to handle a self-intersecting
 * ring: 'error' rejects the ring (recorded in `errors`, no output for it); 'split' splits
 * it into simple rings at the crossing points, inserting new vertices
 */

/**
 * Clean and validate dirty polygon input for {@link earcut}. Cleaning steps, in order:
 *
 * 1. silently clean each ring: drop non-finite vertices, consecutive duplicate points, a
 *    duplicated closing point, and collinear points;
 * 2. self-intersecting rings are either rejected (`selfIntersection: 'error'`, the default)
 *    or split into simple rings at the crossing points (`'split'`) — never passed on as-is;
 * 3. holes are validated: a hole not contained in the outer ring (including one covering it)
 *    or crossing another ring is dropped with an error; nested holes are handled by depth —
 *    a hole inside a hole is a solid island and becomes its own outer ring.
 *
 * Because vertices are removed (and, when splitting, inserted), the result is a list of NEW
 * polygons (one per outer ring, counting islands) — triangulate each and concatenate.
 *
 * @param {ArrayLike<number>} data flat array of vertex coordinates
 * @param {ArrayLike<number> | null} [holeIndices] indices (in vertices, not coordinates) where each hole ring starts
 * @param {number} [dim=2] number of coordinates per vertex in `data`
 * @param {RepairOptions} [options]
 * @returns {{polygons: CleanedPolygon[], errors: string[]}} cleaned polygons and every
 * problem found (empty when the input was clean)
 */
export function cleanPolygon(data, holeIndices, dim = 2, options) {
    const mode = options && options.selfIntersection === 'split' ? 'split' : 'error';
    /** @type {string[]} */
    const errors = [];
    /** @type {CleanedPolygon[]} */
    const polygons = [];

    if (!Number.isInteger(dim) || dim < 2) {
        errors.push(`dim must be an integer >= 2, got ${dim}`);
        return {polygons, errors};
    }

    const rings = readRings(data, holeIndices, dim, mode, errors);

    /** @type {Ring[]} */
    const outerRings = [];
    /** @type {Ring[]} */
    const holeRings = [];
    for (const r of rings) (r.hole ? holeRings : outerRings).push(r);

    if (outerRings.length === 0) {
        for (const h of holeRings) errors.push(`${h.label}: no valid outer ring; hole dropped`);
        return {polygons, errors};
    }

    // validate holes: each must lie inside an outer ring and not cross any kept ring
    /** @type {Ring[]} */
    const kept = outerRings.slice();
    for (const h of holeRings) {
        let contained = false;
        for (const o of outerRings) {
            if (ringContainsRing(o.pts, h.pts)) { contained = true; break; }
        }
        if (!contained) {
            errors.push(outerRings.some(o => ringContainsRing(h.pts, o.pts)) ?
                `${h.label}: hole covers the outer ring; hole dropped` :
                `${h.label}: hole is not inside the outer ring; hole dropped`);
            continue;
        }
        let crosses = false;
        for (const k of kept) {
            if (ringsCross(k.pts, h.pts)) { crosses = true; break; }
        }
        if (crosses) {
            errors.push(`${h.label}: hole crosses another ring boundary; hole dropped`);
            continue;
        }
        kept.push(h);
    }

    // containment hierarchy: a ring's depth is the number of kept rings containing it.
    // Even-depth rings are solid (the outer ring, or islands inside holes); odd-depth rings
    // are holes of their immediate container — so a hole inside a hole becomes a new outer ring.
    const areas = kept.map(r => Math.abs(ringArea(r.pts)));
    const depth = new Array(kept.length).fill(0);
    const parent = new Array(kept.length).fill(-1);
    for (let i = 0; i < kept.length; i++) {
        for (let j = 0; j < kept.length; j++) {
            if (i === j || areas[j] <= areas[i]) continue;
            if (!ringContainsRing(kept[j].pts, kept[i].pts)) continue;
            depth[i]++;
            if (parent[i] === -1 || areas[j] < areas[parent[i]]) parent[i] = j;
        }
    }

    /** @type {Map<number, {outer: Ring, holes: Ring[]}>} */
    const groups = new Map();
    for (let i = 0; i < kept.length; i++) {
        if (depth[i] % 2 === 0) groups.set(i, {outer: kept[i], holes: []});
    }
    for (let i = 0; i < kept.length; i++) {
        if (depth[i] % 2 === 1) {
            const g = groups.get(parent[i]);
            if (g) g.holes.push(kept[i]);
            else errors.push(`${kept[i].label}: no containing polygon found; ring dropped`);
        }
    }

    for (const g of groups.values()) polygons.push(flattenGroup(g));

    return {polygons, errors};
}

// split the input into rings, clean each one, and normalize self-intersections
/** @param {ArrayLike<number>} data @param {ArrayLike<number> | null | undefined} holeIndices @param {number} dim @param {'error' | 'split'} mode @param {string[]} errors @returns {Ring[]} */
function readRings(data, holeIndices, dim, mode, errors) {
    const n = Math.floor(data.length / dim);
    /** @type {Ring[]} */
    const rings = [];

    if (data.length % dim !== 0) {
        errors.push(`data length ${data.length} is not a multiple of dim ${dim}; trailing coordinates ignored`);
    }

    // hole indices must be strictly increasing and point inside the vertex range
    /** @type {number[]} */
    const starts = [];
    if (holeIndices) {
        let prev = 0;
        for (let k = 0; k < holeIndices.length; k++) {
            const h = holeIndices[k];
            if (!Number.isInteger(h) || h <= prev || h >= n) {
                errors.push(`invalid hole index ${h}; expected an integer in (${prev}, ${n})`);
                continue;
            }
            starts.push(h);
            prev = h;
        }
    }

    const ranges = [];
    let prev = 0;
    for (const s of starts) {
        ranges.push([prev, s]);
        prev = s;
    }
    ranges.push([prev, n]);

    for (let r = 0; r < ranges.length; r++) {
        const hole = r > 0;
        const label = hole ? `hole ${r}` : 'outer ring';
        const pts = cleanRing(data, ranges[r][0] * dim, ranges[r][1] * dim, dim, errors, label);
        if (!pts) continue;
        for (const simple of normalizeRing(pts, mode, errors, label)) {
            rings.push({pts: simple, hole, label});
        }
    }
    return rings;
}

// drop non-finite vertices, consecutive/closing duplicates and collinear points
/** @param {ArrayLike<number>} data @param {number} start @param {number} end @param {number} dim @param {string[]} errors @param {string} label @returns {number[][] | null} */
function cleanRing(data, start, end, dim, errors, label) {
    /** @type {number[][]} */
    const pts = [];
    for (let i = start; i < end; i += dim) {
        if (!Number.isFinite(data[i]) || !Number.isFinite(data[i + 1])) {
            errors.push(`${label}: non-finite coordinate at vertex ${i / dim}; vertex dropped`);
            continue;
        }
        /** @type {number[]} */
        const p = [];
        for (let d = 0; d < dim; d++) p.push(data[i + d]);
        const last = pts[pts.length - 1];
        if (last && sameXY(last, p)) continue; // consecutive duplicate
        pts.push(p);
    }

    // duplicated closing point (first === last)
    while (pts.length > 1 && sameXY(pts[0], pts[pts.length - 1])) pts.pop();

    // collinear points, swept to a fixpoint (one removal can expose another)
    let changed = true;
    while (changed && pts.length > 2) {
        changed = false;
        for (let i = 0; i < pts.length; i++) {
            const prev = pts[(i + pts.length - 1) % pts.length];
            const cur = pts[i];
            const next = pts[(i + 1) % pts.length];
            if (!sameXY(prev, next) && orient(prev, cur, next) === 0 && between(prev, cur, next)) {
                pts.splice(i, 1);
                i--;
                changed = true;
            }
        }
    }

    if (pts.length < 3) {
        errors.push(`${label}: fewer than 3 distinct vertices after cleaning; ring dropped`);
        return null;
    }
    return pts;
}

// break a self-intersecting ring into simple rings, or reject it in 'error' mode
/** @param {number[][]} pts @param {'error' | 'split'} mode @param {string[]} errors @param {string} label @returns {number[][][]} */
function normalizeRing(pts, mode, errors, label) {
    /** @type {number[][][]} */
    const simple = [];
    const stack = [pts];
    // each split consumes one crossing; a split never creates new crossings (the new edges are
    // sub-segments of original edges), so the original crossing count bounds the loop
    let guard = pts.length * pts.length + 1;

    while (stack.length) {
        const ring = /** @type {number[][]} */ (stack.pop());
        const hit = findCrossing(ring);
        if (!hit) {
            simple.push(ring);
            continue;
        }
        if (mode === 'error') {
            errors.push(`${label}: self-intersection between edges ${hit.i} and ${hit.j}; ring rejected (pass {selfIntersection: 'split'} to repair it)`);
            continue;
        }
        if (guard-- <= 0) {
            errors.push(`${label}: too many self-intersections; ring rejected`);
            continue;
        }
        // split at the crossing: edges (i, i+1) and (j, j+1) become two rings,
        // each closed through its own copy of the intersection point
        const n = ring.length;
        const p1 = lerpPoint(ring[hit.i], ring[(hit.i + 1) % n], hit.t1);
        const p2 = lerpPoint(ring[hit.j], ring[(hit.j + 1) % n], hit.t2);
        stack.push(
            [p2, ...ring.slice(hit.j + 1), ...ring.slice(0, hit.i + 1)],
            [p1, ...ring.slice(hit.i + 1, hit.j + 1)]);
    }
    return simple;
}

// flatten one polygon group (outer ring + its holes) to earcut's input format
/** @param {{outer: Ring, holes: Ring[]}} group @returns {CleanedPolygon} */
function flattenGroup(group) {
    /** @type {number[]} */
    const data = [];
    for (const p of group.outer.pts) data.push(...p);
    /** @type {number[]} */
    const holes = [];
    for (const h of group.holes) {
        holes.push(data.length / group.outer.pts[0].length);
        for (const p of h.pts) data.push(...p);
    }
    return {data, holes};
}

// find the first proper (interior-to-interior) crossing between non-adjacent edges of a ring
/** @param {number[][]} ring @returns {{i: number, j: number, t1: number, t2: number} | null} */
function findCrossing(ring) {
    const n = ring.length;
    for (let i = 0; i < n - 2; i++) {
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue; // first and last edges are adjacent
            const hit = segIntersection(ring[i], ring[i + 1], ring[j], ring[(j + 1) % n]);
            if (hit) return {i, j, t1: hit.t1, t2: hit.t2};
        }
    }
    return null;
}

// whether any edge of one ring properly crosses an edge of the other
/** @param {number[][]} r1 @param {number[][]} r2 @returns {boolean} */
function ringsCross(r1, r2) {
    for (let i = 0; i < r1.length; i++) {
        for (let j = 0; j < r2.length; j++) {
            if (segIntersection(r1[i], r1[(i + 1) % r1.length], r2[j], r2[(j + 1) % r2.length])) return true;
        }
    }
    return false;
}

// proper intersection of segments ab and cd: both segments crossed strictly through their
// interiors (endpoint touches and collinear overlaps don't count). Returns the intersection
// parameter along each segment.
/** @param {number[]} a @param {number[]} b @param {number[]} c @param {number[]} d @returns {{t1: number, t2: number} | null} */
function segIntersection(a, b, c, d) {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    if (!((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) ||
        !((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return null;

    const dx1 = b[0] - a[0], dy1 = b[1] - a[1];
    const dx2 = d[0] - c[0], dy2 = d[1] - c[1];
    const denom = dx1 * dy2 - dy1 * dx2;
    return {
        t1: ((c[0] - a[0]) * dy2 - (c[1] - a[1]) * dx2) / denom,
        t2: ((c[0] - a[0]) * dy1 - (c[1] - a[1]) * dx1) / denom
    };
}

// interpolate a point on segment ab at parameter t, across all dimensions
/** @param {number[]} a @param {number[]} b @param {number} t @returns {number[]} */
function lerpPoint(a, b, t) {
    /** @type {number[]} */
    const p = [];
    for (let d = 0; d < a.length; d++) p.push(a[d] + (b[d] - a[d]) * t);
    return p;
}

// whether `ring` lies strictly inside `container` (the rings never cross by the time this is
// called, so one off-boundary vertex decides); vertices exactly on the boundary are skipped
/** @param {number[][]} container @param {number[][]} ring @returns {boolean} */
function ringContainsRing(container, ring) {
    for (const p of ring) {
        if (!pointOnBoundary(container, p[0], p[1])) return pointInRing(container, p[0], p[1]);
    }
    return false; // every vertex on the container's boundary — coincident, not contained
}

/** @param {number[][]} ring @param {number} x @param {number} y @returns {boolean} */
function pointInRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yi - yj) + xi) inside = !inside;
    }
    return inside;
}

/** @param {number[][]} ring @param {number} x @param {number} y @returns {boolean} */
function pointOnBoundary(ring, x, y) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if ((b[0] - a[0]) * (y - a[1]) === (x - a[0]) * (b[1] - a[1]) &&
            x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) &&
            y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1])) return true;
    }
    return false;
}

// signed area of a ring (same convention as earcut's signedArea)
/** @param {number[][]} pts @returns {number} */
function ringArea(pts) {
    let sum = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        sum += (pts[j][0] - pts[i][0]) * (pts[i][1] + pts[j][1]);
    }
    return sum;
}

/** @param {number[]} a @param {number[]} b @param {number[]} c @returns {number} */
function orient(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** @param {number[]} a @param {number[]} b @returns {boolean} */
function sameXY(a, b) {
    return a[0] === b[0] && a[1] === b[1];
}

// whether collinear point b lies between a and c
/** @param {number[]} a @param {number[]} b @param {number[]} c @returns {boolean} */
function between(a, b, c) {
    return (b[0] - a[0]) * (c[0] - a[0]) + (b[1] - a[1]) * (c[1] - a[1]) >= 0 &&
        (b[0] - c[0]) * (a[0] - c[0]) + (b[1] - c[1]) * (a[1] - c[1]) >= 0;
}

/**
 * Opt-in repair layer for dirty polygon input: ring cleaning, self-intersection handling and
 * hole-containment validation, run before {@link earcut}. The core earcut() call stays a
 * best-effort fast path — nothing here runs unless a caller explicitly asks for it.
 *
 * A repaired polygon is given back in the same flat shape earcut consumes, so the typical flow is:
 *
 * ```js
 * const {polygons, errors} = earcut.repair(data, holes, dim);
 * if (errors.length) { /* caller decides: log, drop, surface to the user *\/ }
 * const triangles = [];
 * for (const p of polygons) triangles.push(...earcut(p.vertices, p.holes, p.dimensions));
 * ```
 */

/**
 * @typedef {object} RepairError
 * @property {string} code machine-readable error code, one of:
 *   `invalid-argument`, `non-finite-coordinate`, `degenerate-ring`,
 *   `self-intersection`, `hole-outside`, `nested-hole`, `invalid-hole-index`
 * @property {string} message human-readable explanation
 * @property {number} [ringIndex] 0-based index of the offending ring in the input (when applicable)
 * @property {number} [holeIndex] index into the input `holeIndices` array (when applicable)
 */

/**
 * @typedef {object} RepairedPolygon
 * @property {number[]} vertices flat vertex coordinates of one simple polygon (outer ring + holes)
 * @property {number[]} holes hole start indices (in vertices), as accepted by earcut
 * @property {number} dimensions coordinates per vertex, copied from the input
 */

/**
 * @typedef {object} RepairResult
 * @property {RepairedPolygon[]} polygons repaired, earcut-ready polygons; empty when nothing valid remains
 * @property {RepairError[]} errors all problems found, including those repaired automatically
 */

/**
 * @typedef {object} RepairOptions
 * @property {'error' | 'split'} [onSelfIntersect] `'error'` (default) rejects a self-crossing ring
 *   with an error and drops it; `'split'` cuts it at the crossings into simple rings instead
 */

/** @typedef {{x: number, y: number, dim: number, coords: number[]}} Point */

/**
 * A ring known to be simple, with its resolved nesting depth (even = polygon outer ring,
 * odd = hole) and the index of the input ring it came from.
 *
 * @typedef {object} SimpleRing
 * @property {Point[]} ring
 * @property {number} depth
 * @property {number} inputIndex
 */

const MAX_SPLITS = 10000; // backstop against pathological input; normal rings split far fewer times

/**
 * Validate and repair a polygon in the same flat form {@link earcut} takes.
 *
 * Never throws on geometric dirtiness — every problem is reported in `errors` and the returned
 * `polygons` only contain rings known to be simple and properly nested. A self-intersecting outer
 * ring in the default mode therefore yields zero polygons (and an error), never a bad mesh.
 *
 * @param {ArrayLike<number>} data flat array of vertex coordinates
 * @param {ArrayLike<number> | null} [holeIndices] indices (in vertices) where each hole ring starts
 * @param {number} [dim=2] number of coordinates per vertex in `data`
 * @param {RepairOptions} [options]
 * @returns {RepairResult}
 */
export default function repair(data, holeIndices, dim = 2, options = {}) {
    const mode = options.onSelfIntersect === 'split' ? 'split' : 'error';
    /** @type {RepairError[]} */
    const errors = [];

    if (!data || typeof data.length !== 'number') {
        errors.push({code: 'invalid-argument', message: 'repair: `data` must be an array-like of coordinates'});
        return {polygons: [], errors};
    }
    if (!Number.isInteger(dim) || dim < 2) {
        errors.push({code: 'invalid-argument', message: `repair: dimensions must be an integer >= 2, got ${dim}`});
        return {polygons: [], errors};
    }
    const numVertices = data.length / dim;
    if (!Number.isInteger(numVertices)) {
        errors.push({code: 'invalid-argument', message: `repair: data length ${data.length} is not a multiple of dimensions ${dim}`});
        return {polygons: [], errors};
    }

    // --- split the flat input into rings, validating the hole index table as we go ---
    /** @type {number[]} */
    const ringStarts = [0];
    /** @type {boolean[]} */
    const isHole = [false];
    if (holeIndices && holeIndices.length) {
        let prev = 0;
        for (let h = 0; h < holeIndices.length; h++) {
            const idx = holeIndices[h];
            if (!Number.isInteger(idx) || idx <= prev || idx >= numVertices) {
                errors.push({
                    code: 'invalid-hole-index',
                    holeIndex: h,
                    message: `repair: hole index ${idx} is out of range or not strictly increasing`
                });
                continue;
            }
            ringStarts.push(idx);
            isHole.push(true);
            prev = idx;
        }
    }

    /**
     * @typedef {object} RawRing
     * @property {Point[]} ring
     * @property {boolean} isHole
     * @property {number} inputIndex
     */

    /** @type {RawRing[]} */
    const rings = [];
    for (let r = 0; r < ringStarts.length; r++) {
        const start = ringStarts[r];
        const end = r < ringStarts.length - 1 ? ringStarts[r + 1] : numVertices;
        /** @type {Point[]} */
        const ring = [];
        for (let v = start; v < end; v++) {
            const off = v * dim;
            const x = data[off], y = data[off + 1];
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                errors.push({
                    code: 'non-finite-coordinate',
                    ringIndex: r,
                    message: `repair: ring ${r} contains a non-finite coordinate; ring dropped`
                });
                ring.length = 0;
                break;
            }
            const coords = [];
            for (let d = 0; d < dim; d++) coords.push(data[off + d]);
            ring.push({x, y, dim, coords});
        }
        if (ring.length) rings.push({ring, isHole: isHole[r], inputIndex: r});
    }

    // --- clean and (optionally) split each ring ---
    /** @type {SimpleRing[]} */
    const simpleRings = [];
    for (const entry of rings) {
        const cleaned = cleanRing(entry.ring);
        if (cleaned.length < 3) {
            errors.push({
                code: 'degenerate-ring',
                ringIndex: entry.inputIndex,
                message: `repair: ring ${entry.inputIndex} collapsed to ${cleaned.length} point(s); ring dropped`
            });
            continue;
        }

        /** @type {Point[][]} */
        const worklist = [cleaned];
        let splits = 0;
        let rejected = false;
        while (worklist.length) {
            // a cut can leave the crossing point duplicated or expose collinear runs around it,
            // so re-clean every piece before testing it again
            const current = cleanRing(/** @type {Point[]} */ (worklist.pop()));
            if (current.length < 3) continue; // a sliver that collapsed entirely — nothing of value lost
            const hit = findSelfIntersection(current);
            if (!hit) {
                simpleRings.push({ring: current, depth: -1, inputIndex: entry.inputIndex});
            } else if (hit.overlap) {
                errors.push({
                    code: 'self-intersection',
                    ringIndex: entry.inputIndex,
                    message: `repair: ring ${entry.inputIndex} has overlapping collinear edges, which cannot be split unambiguously; ring dropped`
                });
                rejected = true;
                break;
            } else if (mode === 'error') {
                errors.push({
                    code: 'self-intersection',
                    ringIndex: entry.inputIndex,
                    message: `repair: ring ${entry.inputIndex} is self-intersecting; set onSelfIntersect: 'split' to decompose it`
                });
                rejected = true;
                break;
            } else {
                if (++splits > MAX_SPLITS) {
                    errors.push({
                        code: 'self-intersection',
                        ringIndex: entry.inputIndex,
                        message: `repair: ring ${entry.inputIndex} needed more than ${MAX_SPLITS} splits; ring dropped`
                    });
                    rejected = true;
                    break;
                }
                worklist.push(...splitRing(current, hit));
            }
        }
        if (rejected) {
            // a rejected input ring may already have emitted pieces from earlier splits; remove them
            for (let i = simpleRings.length - 1; i >= 0; i--) {
                if (simpleRings[i].inputIndex === entry.inputIndex) simpleRings.splice(i, 1);
            }
        }
    }

    // --- pairwise ring relations ---
    // Two simple rings are either disjoint (touching at points counts as disjoint), nested
    // (one strictly contains the other), or overlapping (their edges cross). Only nesting is
    // representable in an earcut polygon; an overlap means the input topology itself cannot be
    // repaired into a valid polygon, so it is reported and both pieces are dropped rather than
    // silently emitting a wrong mesh. Splits of one ring normally produce disjoint/touching
    // lobes — an overlap here means the original ring had no clean decomposition.
    // This is O(rings² · edge product), so it only runs when more than one ring survived; a
    // single simple ring has nothing to relate and skips it entirely (the common building case).
    /** @type {Set<number>} */
    const dropped = new Set();
    /** @type {Set<number>} input ring indices already reported, so one bad ring logs one error */
    const reported = new Set();
    if (simpleRings.length > 1) {
        for (let a = 0; a < simpleRings.length; a++) {
            for (let b = a + 1; b < simpleRings.length; b++) {
                const relation = ringRelation(simpleRings[a].ring, simpleRings[b].ring);
                if (relation === 'overlap') {
                    for (const idx of [a, b]) {
                        const inputIndex = simpleRings[idx].inputIndex;
                        if (!reported.has(inputIndex)) {
                            reported.add(inputIndex);
                            errors.push({
                                code: 'self-intersection',
                                ringIndex: inputIndex,
                                message: `repair: rings derived from input ring ${inputIndex} overlap and cannot form a valid polygon; rings dropped`
                            });
                        }
                    }
                    dropped.add(a);
                    dropped.add(b);
                }
            }
        }
        if (dropped.size) {
            for (let i = simpleRings.length - 1; i >= 0; i--) {
                if (dropped.has(i)) simpleRings.splice(i, 1);
            }
        }
    }

    // --- containment hierarchy: assign every surviving ring a nesting depth ---
    // Depth is 1 + the deepest ring strictly containing it. Even depth => outer ring of a
    // polygon, odd depth => a hole of the nearest even ancestor; an even ring inside a hole is
    // an island, emitted as its own polygon, so a hole can never end up covering an outer ring.
    // With overlaps removed, containment is a strict forest: the rings strictly containing a
    // given ring are exactly its ancestor chain, so its depth is simply their count. That needs
    // no dependency on other rings' resolved depths (no fixpoint, no recursion — deep nesting
    // never touches the call stack), only one point-in-ring test per ordered ring pair.
    for (const entry of simpleRings) {
        let depth = 0;
        const sample = entry.ring[0];
        for (const other of simpleRings) {
            if (other !== entry && ringStrictlyContains(other.ring, sample)) depth++;
        }
        entry.depth = depth;
    }

    for (const entry of simpleRings) {
        const source = rings.find(r => r.inputIndex === entry.inputIndex);
        if (source && source.isHole && entry.depth % 2 === 0) {
            errors.push({
                code: 'hole-outside',
                ringIndex: entry.inputIndex,
                message: `repair: hole ring ${entry.inputIndex} is not inside the outer ring; treated as a separate polygon`
            });
        }
        if (entry.depth >= 2 && entry.depth % 2 === 1) {
            errors.push({
                code: 'nested-hole',
                ringIndex: entry.inputIndex,
                message: `repair: ring ${entry.inputIndex} is a hole nested inside another hole; nesting handled by depth`
            });
        }
    }

    return {polygons: buildPolygons(simpleRings, dim, errors), errors};
}

/**
 * Classify how two simple closed rings relate to each other.
 *
 * - `'overlap'`: an edge of one crosses an edge of the other in its interior (the interiors
 *   intersect without nesting)
 * - `'contains-a'` / `'contains-b'`: one ring strictly contains the other
 * - `'disjoint'`: no shared interior, including rings that only touch at boundary points
 *
 * @param {Point[]} ra @param {Point[]} rb @returns {'overlap' | 'contains-a' | 'contains-b' | 'disjoint'}
 */
function ringRelation(ra, rb) {
    for (let i = 0; i < ra.length; i++) {
        const a = ra[i], b = ra[(i + 1) % ra.length];
        for (let j = 0; j < rb.length; j++) {
            const c = rb[j], d = rb[(j + 1) % rb.length];
            // proper crossing only: boundary touches are allowed between split pieces
            const o1 = cross(a, b, c), o2 = cross(a, b, d);
            const o3 = cross(c, d, a), o4 = cross(c, d, b);
            if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
                ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 'overlap';
        }
    }
    if (ringStrictlyContains(ra, rb[0])) return 'contains-a';
    if (ringStrictlyContains(rb, ra[0])) return 'contains-b';
    return 'disjoint';
}

/**
 * Remove repeated points, the duplicated closing point of a closed ring and interior collinear
 * points. Preserves the full coordinate tuple (extra dimensions are carried through untouched).
 *
 * Comparisons use a relative epsilon because split intersections are computed by linear
 * interpolation on two different edges: the same geometric point comes back with last-bit FP
 * differences, so an exact `===` leaves near-duplicate vertices behind and earcut emits a
 * near-zero-area sliver from them.
 *
 * @param {Point[]} ring
 * @returns {Point[]}
 */
function cleanRing(ring) {
    // drop consecutive (near-)duplicates, including a closing point equal to the first
    /** @type {Point[]} */
    const out = [];
    for (const p of ring) {
        const last = out[out.length - 1];
        if (!last || !nearlySame(last, p)) out.push(p);
    }
    if (out.length > 1 && nearlySame(out[0], out[out.length - 1])) out.pop();

    // remove interior collinear points to a fixpoint (a removal can expose the next point)
    let changed = true;
    while (changed && out.length > 2) {
        changed = false;
        for (let i = 0; i < out.length; i++) {
            const prev = out[(i - 1 + out.length) % out.length];
            const p = out[i];
            const next = out[(i + 1) % out.length];
            if (nearlyCollinear(prev, p, next) && onSegment(prev, p, next)) {
                out.splice(i, 1);
                changed = true;
                break;
            }
        }
    }
    return out;
}

/**
 * Relative FP tolerance scaled to the coordinate magnitudes involved — a fixed epsilon is wrong
 * for both tiny and huge coordinate systems. Matches the scale argument of the shoelace roundoff
 * bound used elsewhere (length * max² * EPSILON).
 *
 * @param {Point[]} points
 * @returns {number}
 */
function epsilonOf(points) {
    let max = 0;
    for (const p of points) max = Math.max(max, Math.abs(p.x), Math.abs(p.y));
    return max * Number.EPSILON * 8;
}

/**
 * @param {Point} p1 @param {Point} p2 @returns {boolean}
 */
function nearlySame(p1, p2) {
    const eps = Math.max(1, Math.abs(p1.x), Math.abs(p1.y), Math.abs(p2.x), Math.abs(p2.y)) * Number.EPSILON * 8;
    return Math.abs(p1.x - p2.x) <= eps && Math.abs(p1.y - p2.y) <= eps;
}

/**
 * Whether p is collinear with the line through prev/next up to FP roundoff in the cross product.
 *
 * @param {Point} prev @param {Point} p @param {Point} next @returns {boolean}
 */
function nearlyCollinear(prev, p, next) {
    const eps = epsilonOf([prev, p, next]);
    return Math.abs(cross(prev, p, next)) <= eps * eps;
}

/**
 * @typedef {object} Intersection
 * @property {Point} point intersection point (snapped to an existing vertex when the crossing is at one)
 * @property {number} i first edge index (edge crossing) or first vertex index (duplicate vertex)
 * @property {number} j second edge index (edge crossing) or second vertex index (duplicate vertex)
 * @property {boolean} [duplicate] true when i/j are indices of one non-adjacent repeated vertex
 * @property {boolean} [overlap] true for overlapping collinear edges (ambiguous, never split)
 */

/**
 * Find the first pair of non-adjacent edges that touch or cross. Returns null when the ring is
 * simple. Adjacent edges sharing their common endpoint are the ring itself, not an intersection.
 *
 * The all-pairs check is O(n²) but only edges whose bboxes overlap can intersect, so edges are
 * bucketed into a uniform spatial grid over the ring's bbox: each edge is tested only against
 * edges sharing a cell. For a typical ring (building outline, circle) cells hold a constant
 * number of edges, making this expected O(n); a degenerate grid where every edge lands in one
 * cell degrades gracefully to the O(n²) comparison set.
 *
 * @param {Point[]} ring
 * @returns {Intersection | null}
 */
function findSelfIntersection(ring) {
    const n = ring.length;
    // non-adjacent repeated vertex: a figure-eight pinch (two lobes sharing one point). It makes
    // the ring non-simple and intersectEdges' boundary cases don't see it because the shared
    // point is an endpoint of both touching edges. Hash vertices by exact coordinates so this is
    // O(n) rather than an all-pairs scan; the only legitimate repeated vertex is the closing
    // pair (0, n-1), which we ignore.
    /** @type {Map<number, number[]>} */
    const vertexBuckets = new Map();
    for (let i = 0; i < n; i++) {
        const key = hashPoint(ring[i]);
        const list = vertexBuckets.get(key);
        if (list) {
            for (const j of list) {
                if (i === 0 && j === n - 1) continue; // closing adjacency
                if (sameXY(ring[i], ring[j])) return {point: ring[i], i, j, duplicate: true};
            }
            list.push(i);
        } else {
            vertexBuckets.set(key, [i]);
        }
    }

    // edge bboxes plus the ring bbox that sizes the grid
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    /** @type {Float64Array} */
    const eMinX = new Float64Array(n);
    /** @type {Float64Array} */
    const eMinY = new Float64Array(n);
    /** @type {Float64Array} */
    const eMaxX = new Float64Array(n);
    /** @type {Float64Array} */
    const eMaxY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const loX = Math.min(a.x, b.x), hiX = Math.max(a.x, b.x);
        const loY = Math.min(a.y, b.y), hiY = Math.max(a.y, b.y);
        eMinX[i] = loX; eMaxX[i] = hiX; eMinY[i] = loY; eMaxY[i] = hiY;
        if (loX < minX) minX = loX; if (hiX > maxX) maxX = hiX;
        if (loY < minY) minY = loY; if (hiY > maxY) maxY = hiY;
    }

    // ~one edge per cell on a square grid; clamp the count so a pathological ring still gets a
    // usable table rather than allocating n² cells
    const grid = Math.max(1, Math.ceil(Math.sqrt(n)));
    const spanX = maxX - minX, spanY = maxY - minY;
    /**
     * @param {number} v @param {number} min @param {number} span
     * @returns {number}
     */
    const cell = (v, min, span) => span === 0 ? 0 :
        Math.min(grid - 1, Math.max(0, Math.floor((v - min) / span * grid)));
    /** @type {Map<number, number[]>} */
    const buckets = new Map();
    /** @param {number} edgeIndex @param {number} cx @param {number} cy */
    const place = (edgeIndex, cx, cy) => {
        const key = cy * grid + cx;
        const list = buckets.get(key);
        if (list) list.push(edgeIndex);
        else buckets.set(key, [edgeIndex]);
    };
    for (let i = 0; i < n; i++) {
        const c0x = cell(eMinX[i], minX, spanX), c1x = cell(eMaxX[i], minX, spanX);
        const c0y = cell(eMinY[i], minY, spanY), c1y = cell(eMaxY[i], minY, spanY);
        for (let cx = c0x; cx <= c1x; cx++) {
            for (let cy = c0y; cy <= c1y; cy++) place(i, cx, cy);
        }
    }

    // each edge pair sharing a cell is visited once; adjacency and exact bbox are re-checked
    /** @type {Set<number>} */
    const seen = new Set();
    for (const list of buckets.values()) {
        for (let u = 0; u < list.length; u++) {
            const i = list[u];
            for (let v = u + 1; v < list.length; v++) {
                const j = list[v];
                if ((i + 1) % n === j || (j + 1) % n === i) continue;
                const key = i * n + j;
                if (seen.has(key)) continue;
                seen.add(key);
                if (eMaxX[j] < eMinX[i] || eMinX[j] > eMaxX[i] ||
                    eMaxY[j] < eMinY[i] || eMinY[j] > eMaxY[i]) continue;
                const hit = intersectEdges(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]);
                if (hit) return {point: hit.point, i, j, overlap: hit.overlap === true};
            }
        }
    }
    return null;
}

/**
 * @typedef {object} EdgeHit
 * @property {Point} point
 * @property {boolean} [overlap]
 */

/**
 * Intersection of two closed segments. Proper crossings and non-collinear T-junctions return a
 * splittable point; collinear overlap (including a vertex running back along another edge) is
 * flagged ambiguous because one of the two cut rings would be degenerate.
 *
 * @param {Point} a @param {Point} b @param {Point} c @param {Point} d
 * @returns {EdgeHit | null}
 */
function intersectEdges(a, b, c, d) {
    const o1 = cross(a, b, c), o2 = cross(a, b, d);
    const o3 = cross(c, d, a), o4 = cross(c, d, b);
    const collinear = o1 === 0 && o2 === 0;

    // overlapping collinear edges: no unambiguous split point — reject rather than guess
    if (collinear &&
        (onSegment(a, c, b) || onSegment(a, d, b) || onSegment(c, a, d) || onSegment(c, b, d))) {
        return {point: a, overlap: true};
    }

    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
        ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
        const t = o3 / (o2 - o1); // a + t*(b-a); o3 and (o2-o1) share the edge (c,d) normal
        return {point: makePoint(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), a.dim)};
    }

    // boundary cases: a vertex of one segment lies in the INTERIOR of the other.
    // - if it is collinear with that edge (the orientation to the edge alone is 0), an edge
    //   doubles back over another edge: ambiguous (one cut ring would be degenerate), so reject
    // - otherwise it is a real T-junction, splittable at the vertex
    // A touch at an endpoint shared by both edges is just a repeated vertex, not a crossing —
    // splitRing produces those on purpose when it closes the two cut rings, and flagging them
    // would make every split re-detect itself forever.
    if (o1 === 0 && onSegment(a, c, b) && !sameXY(c, a) && !sameXY(c, b)) {
        return {point: c, overlap: true};
    }
    if (o2 === 0 && onSegment(a, d, b) && !sameXY(d, a) && !sameXY(d, b)) {
        return {point: d, overlap: true};
    }
    if (o3 === 0 && onSegment(c, a, d) && !sameXY(a, c) && !sameXY(a, d)) {
        return {point: a, overlap: true};
    }
    if (o4 === 0 && onSegment(c, b, d) && !sameXY(b, c) && !sameXY(b, d)) {
        return {point: b, overlap: true};
    }
    return null;
}

/**
 * Cut a closed ring at a self-intersection into two closed rings.
 *
 * For a duplicated-vertex pinch, the shared vertex already sits at both positions, so the ring is
 * cut directly at them. For an edge crossing, the crossing point is inserted (or reused if it is
 * an existing vertex) on both crossing edges first, so the two resulting cycles each close
 * through the shared point.
 *
 * @param {Point[]} ring
 * @param {Intersection} hit
 * @returns {Point[][]}
 */
function splitRing(ring, hit) {
    if (hit.duplicate) {
        const [p, q] = hit.i < hit.j ? [hit.i, hit.j] : [hit.j, hit.i];
        const ring1 = ring.slice(p, q + 1);
        const ring2 = ring.slice(q).concat(ring.slice(0, p + 1));
        return [ring1, ring2];
    }

    // insert the crossing point at the interior of each edge, descending by index so the first
    // insertion doesn't shift the second. When the crossing is a vertex, snap and insert nothing.
    /** @type {{index: number, point: Point}[]} */
    const inserts = [];
    collectInsert(ring, hit.i, hit.point, inserts);
    collectInsert(ring, hit.j, hit.point, inserts);
    inserts.sort((p, q) => q.index - p.index);

    /** @type {Point[]} */
    const linear = ring.slice();
    for (const ins of inserts) linear.splice(ins.index, 0, ins.point);

    // locate the two occurrences of the crossing point in the now-open linear sequence
    /** @type {number[]} */
    const positions = [];
    for (let k = 0; k < linear.length; k++) {
        if (sameXY(linear[k], hit.point)) positions.push(k);
    }
    const [p, q] = positions;

    const ring1 = linear.slice(p, q + 1);
    const ring2 = linear.slice(q).concat(linear.slice(0, p + 1));
    return [ring1, ring2];
}

/**
 * Decide where on edge `edgeIndex` the crossing point lands: at an existing endpoint (reuse it)
 * or in the edge interior (insert a fresh vertex after the edge's start vertex).
 *
 * @param {Point[]} ring @param {number} edgeIndex @param {Point} point
 * @param {{index: number, point: Point}[]} inserts
 */
function collectInsert(ring, edgeIndex, point, inserts) {
    const n = ring.length;
    const start = ring[edgeIndex];
    const end = ring[(edgeIndex + 1) % n];
    if (sameXY(point, start) || sameXY(point, end)) return; // existing vertex, nothing to insert
    inserts.push({index: edgeIndex + 1, point: copyPoint(point, start.dim)});
}

/**
 * Group simple rings into earcut-ready polygons by nesting depth. Every even-depth ring opens a
 * polygon; the odd-depth rings directly inside it become its holes. An even ring nested inside a
 * hole (an island) opens its own polygon rather than being swallowed.
 *
 * @param {SimpleRing[]} simpleRings
 * @param {number} dim
 * @param {RepairError[]} errors
 * @returns {RepairedPolygon[]}
 */
function buildPolygons(simpleRings, dim, errors) {
    /** @type {RepairedPolygon[]} */
    const polygons = [];
    const outers = simpleRings.filter(r => r.depth % 2 === 0);

    for (const outer of outers) {
        /** @type {number[]} */
        const vertices = [];
        /** @type {number[]} */
        const holes = [];

        /** @param {SimpleRing} entry */
        const append = (entry) => {
            if (entry.ring.length < 3) return;
            const start = vertices.length / dim;
            for (const p of entry.ring) {
                for (let d = 0; d < dim; d++) vertices.push(p.coords[d]);
            }
            if (entry !== outer) holes.push(start);
        };

        append(outer);
        // holes of this polygon: odd-depth rings whose nearest even ancestor is this outer
        for (const candidate of simpleRings) {
            if (candidate.depth % 2 === 1 && nearestEvenAncestor(candidate, simpleRings) === outer) {
                append(candidate);
            }
        }
        polygons.push({vertices, holes, dimensions: dim});
    }

    if (!polygons.length && simpleRings.length) {
        errors.push({code: 'degenerate-ring', message: 'repair: no valid outer ring remained after repair'});
    }
    return polygons;
}

/**
 * Find the even-depth ring that directly owns an odd-depth ring: the smallest (deepest) even ring
 * strictly containing it.
 *
 * @param {SimpleRing} target
 * @param {SimpleRing[]} all
 * @returns {SimpleRing | null}
 */
function nearestEvenAncestor(target, all) {
    /** @type {SimpleRing | null} */
    let best = null;
    const sample = target.ring[0];
    for (const candidate of all) {
        if (candidate === target || candidate.depth % 2 !== 0) continue;
        if (ringStrictlyContains(candidate.ring, sample) && (!best || candidate.depth > best.depth)) best = candidate;
    }
    return best;
}

/**
 * Whether point p lies strictly inside a simple ring (on the boundary => false).
 *
 * @param {Point[]} ring @param {Point} p @returns {boolean}
 */
function ringStrictlyContains(ring, p) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if (cross(a, b, p) === 0 && onSegment(a, p, b)) return false; // boundary is not "strictly inside"
        if ((a.y > p.y) !== (b.y > p.y) &&
            p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

// --- tiny point/vector helpers (kept local so repair.js has no imports and tree-shakes alone) ---

/**
 * Hash key for exact-coordinate vertex dedup. Two points with the same x and y (compared exactly
 * with sameXY after a hash hit) must hash equally; distinct points should usually differ. Mixes
 * the two coordinate bit patterns with the FNV-ish constants earcut itself uses elsewhere.
 *
 * @param {Point} p @returns {number}
 */
function hashPoint(p) {
    const xb = typeof p.x === 'number' ? doubleHash(p.x) : 0;
    const yb = typeof p.y === 'number' ? doubleHash(p.y) : 0;
    return Math.imul(xb ^ 0x9e3779b1, 31) ^ yb;
}

/**
 * @param {number} v @returns {number}
 */
function doubleHash(v) {
    // fold the 64-bit float representation into a 32-bit int; -0 and +0 share a key, which is
    // fine because sameXY treats them as equal anyway
    const buf = doubleHash.buf;
    buf[0] = v;
    return buf[1] ^ buf[0];
}
/** @type {Int32Array} */
doubleHash.buf = new Int32Array(new Float64Array(1).buffer);

/** @param {Point} p1 @param {Point} p2 @returns {boolean} */
function sameXY(p1, p2) {
    return p1.x === p2.x && p1.y === p2.y;
}

/** signed area*2 of triangle (p, q, r); 0 means collinear
 * @param {Point} p @param {Point} q @param {Point} r @returns {number} */
function cross(p, q, r) {
    return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
}

/** collinear point q lies on closed segment pr
 * @param {Point} p @param {Point} q @param {Point} r @returns {boolean} */
function onSegment(p, q, r) {
    return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
           q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

/**
 * @param {number} x @param {number} y @param {number} dim @returns {Point}
 */
function makePoint(x, y, dim) {
    const coords = [];
    coords.push(x, y);
    for (let d = 2; d < dim; d++) coords.push(0);
    return {x, y, dim, coords};
}

/**
 * @param {Point} p @param {number} dim @returns {Point}
 */
function copyPoint(p, dim) {
    return {x: p.x, y: p.y, dim, coords: p.coords.slice()};
}

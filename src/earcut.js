/**
 * A vertex in a circular doubly linked list representing a polygon ring.
 * `prev`/`next` are always linked (set immediately after {@link createNode}), so they're typed
 * non-null; `prevZ`/`nextZ` are the z-order list links and are null at the ends.
 *
 * @typedef {object} Node
 * @property {number} i vertex index in the coordinates array
 * @property {number} x vertex x coordinate
 * @property {number} y vertex y coordinate
 * @property {Node} prev previous vertex node in the polygon ring
 * @property {Node} next next vertex node in the polygon ring
 * @property {number} z z-order curve value; doubles as the owning block index during eliminateHoles
 * @property {Node | null} prevZ previous node in z-order
 * @property {Node | null} nextZ next node in z-order
 */

// single-vertex holes to preserve through filterPoints (steiner points); kept off the Node
// shape since they're rare — the empty-set fast path means non-steiner inputs pay nothing
/** @type {Set<Node>} */
const steiners = new Set();

// halves of split polygons waiting to be triangulated, drained by earcut in a loop so that the
// call stack doesn't grow with the nesting depth of splits
/** @type {Node[]} */
const splitStack = [];

// set by filterPoints whenever it removes at least one node; read by earcutLinked's stall
// handler to decide whether another clip pass is worth attempting before the costlier stages
let filteredOut = false;

/**
 * Triangulate a polygon given as a flat array of vertex coordinates.
 *
 * @param {ArrayLike<number>} data flat array of vertex coordinates
 * @param {ArrayLike<number> | null} [holeIndices] indices (in vertices, not coordinates) where each hole ring starts
 * @param {number} [dim=2] number of coordinates per vertex in `data`
 * @returns {number[]} triangles as triplets of vertex indices into `data`
 * @example earcut([10,0, 0,50, 60,60, 70,10]); // [1,0,3, 3,2,1]
 */
export default function earcut(data, holeIndices, dim = 2) {

    const hasHoles = holeIndices && holeIndices.length;
    const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
    if (steiners.size) steiners.clear();

    let outerNode = linkedList(data, 0, outerLen, dim, true);
    /** @type {number[]} */
    const triangles = [];

    if (!outerNode || outerNode.next === outerNode.prev) return triangles;

    let minX = 0, minY = 0, invSize = 0;

    if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);

    // if the shape is not too simple, we'll use z-order curve hash later; calculate polygon bbox
    if (data.length > 80 * dim) {
        minX = data[0];
        minY = data[1];
        let maxX = minX;
        let maxY = minY;

        for (let i = dim; i < outerLen; i += dim) {
            const x = data[i];
            const y = data[i + 1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }

        // minX, minY and invSize are later used to transform coords into integers for z-order calculation
        invSize = Math.max(maxX - minX, maxY - minY);
        invSize = invSize !== 0 ? 32767 / invSize : 0;
    }

    earcutLinked(outerNode, triangles, minX, minY, invSize);
    while (splitStack.length) earcutLinked(/** @type {Node} */ (splitStack.pop()), triangles, minX, minY, invSize);

    return triangles;
}

// create a circular doubly linked list from polygon points in the specified winding order
/** @param {ArrayLike<number>} data @param {number} start @param {number} end @param {number} dim @param {boolean} clockwise @returns {Node | null} */
function linkedList(data, start, end, dim, clockwise) {
    /** @type {Node | null} */
    let last = null;

    if (clockwise === (signedArea(data, start, end, dim) > 0)) {
        for (let i = start; i < end; i += dim) last = insertNode(i / dim | 0, data[i], data[i + 1], last);
    } else {
        for (let i = end - dim; i >= start; i -= dim) last = insertNode(i / dim | 0, data[i], data[i + 1], last);
    }

    if (last && equals(last, last.next)) {
        removeNode(last);
        last = last.next;
    }

    return last;
}

// Remove collinear or coincident points; removability depends only on a node's immediate
// neighbors, so we sweep forward and re-check the predecessor after each removal. With no `end`
// we sweep the whole ring, lapping until nothing is removable (the fixpoint the clipper needs).
// With an explicit `end` we heal only the dirty window around a bridge/diagonal cut, stopping at
// `end` rather than lapping — O(window) instead of O(ring).
/** @param {Node} start @param {Node} [end] @returns {Node} */
function filterPoints(start, end = start) {
    const full = end === start;

    let p = start, again;
    do {
        again = false;
        if (p !== p.next && (steiners.size === 0 || !steiners.has(p)) &&
            (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
            if (full || p === end) end = p.prev; // pull the stop bound back past the removal
            filteredOut = true;
            removeNode(p);
            p = p.prev;         // re-check the predecessor
            again = true;
        } else if (full || p !== end) {
            p = p.next;
            again = !full;      // local heal: keep looping until the sweep reaches end
        }
    } while (again || p !== end);

    return end;
}

// main ear slicing loop which triangulates a polygon (given as a linked list)
/** @param {Node} ear @param {number[]} triangles @param {number} minX @param {number} minY @param {number} invSize */
function earcutLinked(ear, triangles, minX, minY, invSize) {
    // interlink polygon nodes in z-order
    if (invSize) indexCurve(ear, minX, minY, invSize);

    // a strictly convex ring has no vertex that could block an ear, so skip the point checks until a candidate fails;
    // without this, a big convex ring is cut as one fan of long triangles and each hashed check scans O(n) points
    let stop = ear, cured = false, convex = invSize ? isConvex(ear) : false;

    // iterate through ears, slicing them one by one
    while (ear.prev !== ear.next) {
        const prev = ear.prev;
        /** @type {Node} */
        const next = ear.next;

        if (area(prev, ear, next) < 0 && (convex || (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)))) {
            triangles.push(prev.i, ear.i, next.i); // cut off the triangle

            removeNode(ear);
            ear = next;
            stop = next;
            continue;
        }

        convex = false;
        ear = next;

        // if we looped through the whole remaining polygon and can't find any more ears
        if (ear === stop) {
            // try filtering collinear/coincident points and slicing again — repeat as long as
            // filtering actually removes nodes, since each removal can expose new ears
            filteredOut = false;
            ear = filterPoints(ear);
            if (filteredOut) { stop = ear; continue; }

            // filtering is exhausted: cure small local self-intersections once, then retry
            if (!cured) {
                ear = cureLocalIntersections(ear, triangles);
                stop = ear;
                cured = true;
                continue;
            }

            // as a last resort, try splitting the remaining polygon into two
            splitEarcut(ear);
            break;
        }
    }
}

// check whether every vertex of a ring is strictly convex
/** @param {Node} start @returns {boolean} */
function isConvex(start) {
    let p = start;
    do {
        if (area(p.prev, p, p.next) >= 0) return false;
        p = p.next;
    } while (p !== start);
    return true;
}

// check whether a polygon node forms a valid ear with adjacent nodes
/** @param {Node} ear @returns {boolean} */
function isEar(ear) {
    // reflex check (area(a, b, c) >= 0) is hoisted into the earcutLinked caller to avoid non-inlined call here
    const a = ear.prev, b = ear, c = ear.next,
        ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y,
        x0 = Math.min(ax, bx, cx), // triangle bbox
        y0 = Math.min(ay, by, cy),
        x1 = Math.max(ax, bx, cx),
        y1 = Math.max(ay, by, cy);

    // make sure we don't have other points inside the potential ear
    let p = c.next;
    while (p !== a) {
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && !(ax === p.x && ay === p.y) &&
            pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
        p = p.next;
    }
    return true;
}

/** @param {Node} ear @param {number} minX @param {number} minY @param {number} invSize @returns {boolean} */
function isEarHashed(ear, minX, minY, invSize) {
    // reflex check is hoisted into the earcutLinked caller (see isEar)
    const a = ear.prev, b = ear, c = ear.next,
        ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y,
        x0 = Math.min(ax, bx, cx), // triangle bbox
        y0 = Math.min(ay, by, cy),
        x1 = Math.max(ax, bx, cx),
        y1 = Math.max(ay, by, cy),
        minZ = zOrder(x0, y0, minX, minY, invSize), // z-order range for the current triangle bbox;
        maxZ = zOrder(x1, y1, minX, minY, invSize);

    let p = ear.prevZ;
    while (p && p.z >= minZ) { // look for points inside the triangle in decreasing z-order
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== c && !(ax === p.x && ay === p.y) &&
            pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
        p = p.prevZ;
    }
    let n = ear.nextZ;
    while (n && n.z <= maxZ) { // look for points in increasing z-order
        if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== c && !(ax === n.x && ay === n.y) &&
            pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
        n = n.nextZ;
    }
    return true;
}

// go through all polygon nodes and cure small local self-intersections
/** @param {Node} start @param {number[]} triangles @returns {Node} */
function cureLocalIntersections(start, triangles) {
    let p = start;
    let cured = false;
    do {
        const a = p.prev,
            b = p.next.next;

        if (intersects(a, p, p.next, b, false) && locallyInside(a, b) && locallyInside(b, a)) {

            triangles.push(a.i, p.i, b.i);

            // remove two nodes involved
            removeNode(p);
            removeNode(p.next);

            p = start = b;
            cured = true;
        }
        p = p.next;
    } while (p !== start);

    return cured ? filterPoints(p) : p;
}

// try splitting polygon into two and triangulate them independently
/** @param {Node} start */
function splitEarcut(start) {
    // look for a valid diagonal that divides the polygon into two
    let a = start;
    do {
        let b = a.next.next;
        while (b !== a.prev) {
            if (a.i !== b.i && isValidDiagonal(a, b)) {
                // split the polygon in two by the diagonal
                let c = splitPolygon(a, b);

                // filter colinear points around the cuts
                a = filterPoints(a, a.next);
                c = filterPoints(c, c.next);

                // queue both halves for earcut, a on top so it's triangulated first
                splitStack.push(c, a);
                return;
            }
            b = b.next;
        }
        a = a.next;
    } while (a !== start);
}

// true only while eliminateHoles merges holes, so removeNode keeps the block index live (growBlock)
let indexActive = false;

// link every hole into the outer loop, producing a single-ring polygon without holes
/** @param {ArrayLike<number>} data @param {ArrayLike<number>} holeIndices @param {Node} outerNode @param {number} dim @returns {Node} */
function eliminateHoles(data, holeIndices, outerNode, dim) {
    const queue = [];

    for (let i = 0, len = holeIndices.length; i < len; i++) {
        const start = holeIndices[i] * dim;
        const end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
        const list = /** @type {Node} */ (linkedList(data, start, end, dim, false));
        if (list === list.next) steiners.add(list);
        queue.push(getLeftmost(list));
    }

    queue.sort(compareXYSlope);

    // block-bbox index for findHoleBridge, grown append-only as holes merge (see notes
    // above buildBlockIndex). Seed it with the outer ring, then append each merged hole.
    buildBlockIndex(data.length / dim, holeIndices.length);
    indexSegment(outerNode, outerNode);

    // process holes from left to right; indexActive lets removeNode keep block bboxes live as
    // filterPoints heals edges during merges (see growBlock)
    indexActive = true;
    for (let i = 0; i < queue.length; i++) {
        outerNode = eliminateHole(queue[i], outerNode);
    }
    indexActive = false;

    // collapse collinear/coincident points across the whole merged ring once before clipping
    return filterPoints(outerNode);
}

/** @param {Node} a @param {Node} b @returns {number} */
function compareXYSlope(a, b) {
    // when the left-most point of 2 holes meet at a vertex, sort the holes counterclockwise so that when we find
    // the bridge to the outer shell is always the point that they meet at.
    return a.x - b.x || a.y - b.y ||
        (a.next.y - a.y) / (a.next.x - a.x) -
        (b.next.y - b.y) / (b.next.x - b.x);
}

// find a bridge between vertices that connects hole with an outer ring and link it
/** @param {Node} hole @param {Node} outerNode @returns {Node} */
function eliminateHole(hole, outerNode) {
    const bridge = findHoleBridge(hole, outerNode);
    if (!bridge) {
        return outerNode;
    }

    const bridgeReverse = splitPolygon(bridge, hole);

    // index the merged-in segment before filtering: in ring order the splice runs
    // bridge -> hole -> bridgeReverse -> bridge2 -> (bridge's old next), covering the
    // hole's edges and both new slit edges. filterPoints below only drops collinear /
    // coincident points, so these bboxes stay valid (conservative) supersets.
    const bridge2 = bridgeReverse.next;
    indexSegment(bridge, bridge2.next);

    // heal collinear/coincident points around the two new slit edges, but leave bridge2 alone: dropping it as collinear
    // would leave bridge lying on the healed edge, where a later hole could bridge into it from outside its sector
    filterPoints(bridgeReverse.prev, bridgeReverse);

    // likewise, if bridge lies strictly between its prev and hole, healing would drop it and leave bridge2 on the healed
    // edge; skip the heal then (a spike at bridge, e.g. a hole touching an outer edge, still needs it)
    const a = bridge.prev;
    if (area(a, bridge, hole) === 0 && (a.x - bridge.x) * (hole.x - bridge.x) + (a.y - bridge.y) * (hole.y - bridge.y) < 0) return bridge;

    return filterPoints(bridge, bridge.next);
}

// Block-bbox index for findHoleBridge (issue #183): one [minX,minY,maxX,maxY] bbox per K
// consecutive ring edges, in a flat Float64Array, so the leftward-ray scan can skip whole
// blocks in O(1) instead of walking the entire merged ring. Grown append-only — the outer
// ring seeds it, then each merged hole appends a segment (head node, stop node, K-blocks
// over head..stop); independent segments, not a ring tiling, since splices land mid-ring.
// Buffers are sized once from the input upper bound and reused across calls.
//
// filterPoints only drops collinear/coincident points, so a stale bbox stays a conservative
// superset of its live edges (never a false skip); the scan skips dead nodes (p.prev.next !==
// p) and lazily advances a dead stop. Blocks are scanned in append (not ring) order, so the
// chosen bridge can differ from the un-indexed code — a different but equally valid result.
const K = 16; // edges per block

let blockBBox = new Float64Array(0); // [minX,minY,maxX,maxY] per block
let numBlocks = 0;
/** @type {Node[]} */
const blockHead = []; // first node of each block's segment
/** @type {Node[]} */
const blockStop = []; // node just past each block's segment (exclusive walk bound)

/** @param {number} maxNodes @param {number} numHoles */
function buildBlockIndex(maxNodes, numHoles) {
    // upper bound: every input node indexed once, +2 bridge nodes per hole, plus a partial
    // trailing block per appended segment (outer ring + one per hole)
    const maxBlocks = Math.ceil((maxNodes + 2 * numHoles) / K) + numHoles + 2;
    if (blockBBox.length < maxBlocks * 4) blockBBox = new Float64Array(maxBlocks * 4);
    numBlocks = 0;
}

// index the ring run head..stop (exclusive) as ceil(len / K) blocks; head === stop means
// the whole ring. each block's bbox covers both endpoints of every edge it owns.
/** @param {Node} head @param {Node} stop */
function indexSegment(head, stop) {
    let p = head;
    do {
        const b = numBlocks++;
        blockHead[b] = p;
        let minX = p.x, minY = p.y, maxX = p.x, maxY = p.y;
        let k = 0;
        do {
            const c = p.next; // edge p->c; bbox must bound both endpoints
            p.z = b; // reuse z as the owning block during eliminateHoles (see growBlock)
            if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
            if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
            p = c;
        } while (++k < K && p !== stop);
        blockStop[b] = p;
        const g = b * 4;
        blockBBox[g] = minX; blockBBox[g + 1] = minY; blockBBox[g + 2] = maxX; blockBBox[g + 3] = maxY;
    } while (p !== stop);
}

// when filterPoints heals an edge head->tail (removing the collinear node between them), the
// healed edge can extend past head's frozen block bbox if its old far endpoint lived in another
// block; grow head's block bbox to cover tail so the leftward-ray prune can't false-skip it.
/** @param {Node} head @param {Node} tail */
function growBlock(head, tail) {
    const g = head.z * 4;
    if (tail.x < blockBBox[g]) blockBBox[g] = tail.x;
    if (tail.y < blockBBox[g + 1]) blockBBox[g + 1] = tail.y;
    if (tail.x > blockBBox[g + 2]) blockBBox[g + 2] = tail.x;
    if (tail.y > blockBBox[g + 3]) blockBBox[g + 3] = tail.y;
}

/** @param {number} b @returns {Node} */
function liveBlockStop(b) {
    let stop = blockStop[b];
    while (stop.prev.next !== stop) stop = stop.next;
    blockStop[b] = stop;
    return stop;
}

// the block's head node can be removed by filterPoints during merges; advance it to the next
// live node so the walk doesn't start on (and immediately terminate at) a dead node. For the
// single full-ring seed block (head === stop) the same forward advance keeps them equal, so the
// do-while still laps the whole ring instead of collapsing to an empty walk.
/** @param {number} b @returns {Node} */
function liveBlockHead(b) {
    let head = blockHead[b];
    while (head.prev.next !== head) head = head.next;
    blockHead[b] = head;
    return head;
}

// David Eberly's algorithm for finding a bridge between hole and outer polygon
/** @param {Node} hole @param {Node} outerNode @returns {Node | null} */
function findHoleBridge(hole, outerNode) {
    let p = outerNode;
    const hx = hole.x;
    const hy = hole.y;
    let qx = -Infinity;
    /** @type {Node | undefined} */
    let m;

    // find a segment intersected by a ray from the hole's leftmost point to the left;
    // segment's endpoint with lesser x will be potential connection point
    // unless they intersect at a vertex, then choose the vertex
    if (equals(hole, p)) return p;

    // scan blocks; skip any whose bbox can't hold a crossing that beats qx and lies left
    // of hx (the prune Morton order can't express — explicit per-axis [minY,maxY]/[minX,maxX])
    for (let b = 0, g = 0; b < numBlocks; b++, g += 4) {
        if (hy < blockBBox[g + 1] || hy > blockBBox[g + 3] || blockBBox[g] > hx || blockBBox[g + 2] <= qx) continue;

        // ensure the walk's exclusive bound is live so we don't overrun into other blocks
        const stop = liveBlockStop(b);

        p = liveBlockHead(b);
        do {
            if (equals(hole, p.next)) return p.next;
            else if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
                const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
                if (x <= hx && x > qx) {
                    qx = x;
                    m = p.x < p.next.x ? p : p.next;
                    if (x === hx) return m; // hole touches outer segment; pick leftmost endpoint
                }
            }
            p = p.next;
        } while (p !== stop);
    }

    if (!m) return null;

    // look for points inside the triangle of hole point, segment intersection and endpoint;
    // if there are no points found, we have a valid connection;
    // otherwise choose the point of the minimum angle with the ray as connection point

    const mx = m.x;
    const my = m.y;
    const tminY = Math.min(hy, my); // the triangle's y span; x span is [mx, hx]
    const tmaxY = Math.max(hy, my);
    let tanMin = Infinity;

    // scan the same blocks; skip any whose bbox can't overlap the triangle's [mx,hx]×[tminY,tmaxY] box
    for (let b = 0, g = 0; b < numBlocks; b++, g += 4) {
        if (blockBBox[g + 2] < mx || blockBBox[g] > hx || blockBBox[g + 3] < tminY || blockBBox[g + 1] > tmaxY) continue;

        const stop = liveBlockStop(b);

        p = liveBlockHead(b);
        do {
            if (hx >= p.x && p.x >= mx && hx !== p.x &&
                    pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {

                const tan = Math.abs(hy - p.y) / (hx - p.x); // tangential

                // if hole point sits on p's horizontal edge (T-junction touch): the bridge runs
                // along that edge — locallyInside rejects it as collinear, but it's valid
                if ((locallyInside(p, hole) || (p.y === hy && p.next.y === hy && p.next.x > hx)) &&
                    (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
                    m = p;
                    tanMin = tan;
                }
            }

            p = p.next;
        } while (p !== stop);
    }

    return m;
}

// whether sector in vertex m contains sector in vertex p in the same coordinates
/** @param {Node} m @param {Node} p @returns {boolean} */
function sectorContainsSector(m, p) {
    return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

// scratch buffers reused across calls and grown on demand: two node-ref arrays that
// ping-pong during the radix passes, plus parallel z-value arrays so the passes read
// z from contiguous memory instead of dereferencing each node. 256-entry histogram for
// 8-bit digits; the small histogram keeps per-call setup cheap (most rings are short)
/** @type {Node[]} */
const sortArr = [];
/** @type {Node[]} */
let sortBuf = [];
let zArr = new Uint32Array(0);
let zBuf = new Uint32Array(0);
const counts = new Uint32Array(256);

// interlink polygon nodes in z-order: collect into an array, sort by z, relink
/** @param {Node} start @param {number} minX @param {number} minY @param {number} invSize */
function indexCurve(start, minX, minY, invSize) {
    let p = start;
    let n = 0;
    do {
        // always (re)compute: z may still hold a block index left over from eliminateHoles
        p.z = zOrder(p.x, p.y, minX, minY, invSize);
        sortArr[n++] = p;
        p = p.next;
    } while (p !== start);

    sortNodes(n);

    /** @type {Node | null} */
    let prev = null;
    for (let i = 0; i < n; i++) {
        const node = sortArr[i];
        node.prevZ = prev;
        if (prev) prev.nextZ = node;
        prev = node;
    }
    /** @type {Node} */ (prev).nextZ = null;

    // drop the node refs but keep the capacity: setting length to 0 leaves sortBuf unresized
    // (its growth is gated on zArr), so the radix scatter regrows it out of order every call
    sortArr.fill(/** @type {Node} */ (/** @type {unknown} */ (null)), 0, n);
    sortBuf.fill(/** @type {Node} */ (/** @type {unknown} */ (null)), 0, n);
}

// sort the first n nodes of sortArr by z, in place: insertion sort for small n (cheaper
// than histogram setup), else LSD radix in four 8-bit passes (covering z's 30 bits)
/** @param {number} n */
function sortNodes(n) {
    if (n <= 32) {
        for (let i = 1; i < n; i++) {
            const node = sortArr[i], z = node.z;
            let j = i - 1;
            while (j >= 0 && sortArr[j].z > z) { sortArr[j + 1] = sortArr[j]; j--; }
            sortArr[j + 1] = node;
        }
        return;
    }

    if (zArr.length < n) {
        zArr = new Uint32Array(n);
        zBuf = new Uint32Array(n);
        sortBuf = new Array(n);
    }
    for (let i = 0; i < n; i++) zArr[i] = sortArr[i].z;

    // even pass count lands the sorted result back in sortArr
    radixPass(n, sortArr, zArr, sortBuf, zBuf, 0);
    radixPass(n, sortBuf, zBuf, sortArr, zArr, 8);
    radixPass(n, sortArr, zArr, sortBuf, zBuf, 16);
    radixPass(n, sortBuf, zBuf, sortArr, zArr, 24);
}

// one LSD radix pass: stably scatter the first n nodes (and their z) from src to dst,
// bucketed by the 8-bit digit of z at the given bit shift
/** @param {number} n @param {Node[]} src @param {Uint32Array} srcZ @param {Node[]} dst @param {Uint32Array} dstZ @param {number} shift */
function radixPass(n, src, srcZ, dst, dstZ, shift) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(srcZ[i] >>> shift) & 0xff]++;
    // turn per-bucket counts into start offsets (prefix sum)
    let sum = 0;
    for (let b = 0; b < 256; b++) { const c = counts[b]; counts[b] = sum; sum += c; }
    for (let i = 0; i < n; i++) {
        const z = srcZ[i];
        const pos = counts[(z >>> shift) & 0xff]++;
        dst[pos] = src[i];
        dstZ[pos] = z;
    }
}

// z-order of a point given coords and inverse of the longer side of data bbox
/** @param {number} x @param {number} y @param {number} minX @param {number} minY @param {number} invSize @returns {number} */
function zOrder(x, y, minX, minY, invSize) {
    // coords are transformed into non-negative 15-bit integer range
    x = (x - minX) * invSize | 0;
    y = (y - minY) * invSize | 0;

    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;

    y = (y | (y << 8)) & 0x00FF00FF;
    y = (y | (y << 4)) & 0x0F0F0F0F;
    y = (y | (y << 2)) & 0x33333333;
    y = (y | (y << 1)) & 0x55555555;

    return x | (y << 1);
}

// find the leftmost node of a polygon ring
/** @param {Node} start @returns {Node} */
function getLeftmost(start) {
    let p = start,
        leftmost = start;
    do {
        if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
        p = p.next;
    } while (p !== start);

    return leftmost;
}

// check if a point lies within a convex triangle
/** @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {number} cx @param {number} cy @param {number} px @param {number} py @returns {boolean} */
function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
    return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
           (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
           (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

// check if a diagonal between two polygon nodes is valid (lies in polygon interior)
/** @param {Node} a @param {Node} b @returns {boolean} true when the diagonal is valid */
function isValidDiagonal(a, b) {
    const zeroLength = equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0; // degenerate case
    return a.next.i !== b.i && (zeroLength || locallyInside(a, b) && locallyInside(b, a) && // // locally visible
        (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) && // no opposite-facing sectors
        !intersectsPolygon(a, b) && (zeroLength || middleInside(a, b)); // doesn't intersect other edges, diagonal inside polygon
}

// signed area of a triangle
/** @param {Node} p @param {Node} q @param {Node} r @returns {number} */
function area(p, q, r) {
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

// check if two points are equal
/** @param {Node} p1 @param {Node} p2 @returns {boolean} */
function equals(p1, p2) {
    return p1.x === p2.x && p1.y === p2.y;
}

// check if two segments intersect; by default includes collinear boundary touches
/** @param {Node} p1 @param {Node} q1 @param {Node} p2 @param {Node} q2 @param {boolean} [includeBoundary] @returns {boolean} */
function intersects(p1, q1, p2, q2, includeBoundary = true) {
    const o1 = area(p1, q1, p2);
    const o2 = area(p1, q1, q2);
    const o3 = area(p2, q2, p1);
    const o4 = area(p2, q2, q1);

    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;

    if (!includeBoundary) return false;

    if (o1 === 0 && onSegment(p1, p2, q1)) return true; // p1, q1 and p2 are collinear and p2 lies on p1q1
    if (o2 === 0 && onSegment(p1, q2, q1)) return true; // p1, q1 and q2 are collinear and q2 lies on p1q1
    if (o3 === 0 && onSegment(p2, p1, q2)) return true; // p2, q2 and p1 are collinear and p1 lies on p2q2
    if (o4 === 0 && onSegment(p2, q1, q2)) return true; // p2, q2 and q1 are collinear and q1 lies on p2q2

    return false;
}

// for collinear points p, q, r, check if point q lies on segment pr
/** @param {Node} p @param {Node} q @param {Node} r @returns {boolean} */
function onSegment(p, q, r) {
    return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

// check if a polygon diagonal intersects any polygon segments
/** @param {Node} a @param {Node} b @returns {boolean} */
function intersectsPolygon(a, b) {
    // diagonal bbox; an edge whose bbox can't overlap it can't intersect it, so
    // skip the orientation test for those (the common case — the diagonal is short)
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);

    let p = a;
    do {
        const n = p.next;
        if ((p.x > maxX && n.x > maxX) || (p.x < minX && n.x < minX) ||
            (p.y > maxY && n.y > maxY) || (p.y < minY && n.y < minY)) {
            p = n;
            continue;
        }
        if (p.i !== a.i && n.i !== a.i && p.i !== b.i && n.i !== b.i &&
                intersects(p, n, a, b)) return true;
        p = n;
    } while (p !== a);

    return false;
}

// check if a polygon diagonal is locally inside the polygon
/** @param {Node} a @param {Node} b @returns {boolean} */
function locallyInside(a, b) {
    return area(a.prev, a, a.next) < 0 ?
        area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 :
        area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

// check if the middle point of a polygon diagonal is inside the polygon
/** @param {Node} a @param {Node} b @returns {boolean} */
function middleInside(a, b) {
    let p = a;
    let inside = false;
    const px = (a.x + b.x) / 2;
    const py = (a.y + b.y) / 2;
    do {
        const n = p.next;
        if (((p.y > py) !== (n.y > py)) && (px < (n.x - p.x) * (py - p.y) / (n.y - p.y) + p.x))
            inside = !inside;
        p = n;
    } while (p !== a);

    return inside;
}

// link two polygon vertices with a bridge; if the vertices belong to the same ring, it splits polygon into two;
// if one belongs to the outer ring and another to a hole, it merges it into a single ring
/** @param {Node} a @param {Node} b @returns {Node} */
function splitPolygon(a, b) {
    const a2 = createNode(a.i, a.x, a.y),
        b2 = createNode(b.i, b.x, b.y),
        an = a.next,
        bp = b.prev;

    a.next = b;
    b.prev = a;

    a2.next = an;
    an.prev = a2;

    b2.next = a2;
    a2.prev = b2;

    bp.next = b2;
    b2.prev = bp;

    return b2;
}

// create a node and optionally link it with previous one (in a circular doubly linked list)
/** @param {number} i @param {number} x @param {number} y @param {Node | null} last @returns {Node} */
function insertNode(i, x, y, last) {
    const p = createNode(i, x, y);

    if (!last) {
        p.prev = p;
        p.next = p;

    } else {
        p.next = last.next;
        p.prev = last;
        last.next.prev = p;
        last.next = p;
    }
    return p;
}

/** @param {Node} p */
function removeNode(p) {
    p.next.prev = p.prev;
    p.prev.next = p.next;

    if (p.prevZ) p.prevZ.nextZ = p.nextZ;
    if (p.nextZ) p.nextZ.prevZ = p.prevZ;

    // keep the hole-bridge index's block bboxes covering the healed prev->next edge
    if (indexActive) growBlock(p.prev, p.next);
}

/** @param {number} i @param {number} x @param {number} y @returns {Node} */
function createNode(i, x, y) {
    // prev/next are assigned by the caller before any read, so the null init is cast away here
    return /** @type {Node} */ (/** @type {unknown} */ ({
        i, // vertex index in coordinates array
        x, y, // vertex coordinates
        prev: null, // previous and next vertex nodes in a polygon ring
        next: null,
        z: 0, // z-order curve value; doubles as owning block in the hole-bridge index during eliminateHoles
        prevZ: null, // previous and next nodes in z-order
        nextZ: null
    }));
}

/**
 * Return the relative difference between the polygon area and the area of its triangulation —
 * a value near 0 means a correct triangulation. Useful for verifying output in tests.
 *
 * @param {ArrayLike<number>} data
 * @param {ArrayLike<number> | null} holeIndices
 * @param {number} dim number of coordinates per vertex in `data`
 * @param {ArrayLike<number>} triangles output of {@link earcut}
 * @returns {number}
 * @example deviation(data, holes, dim, earcut(data, holes, dim)); // ~0 if correct
 */
export function deviation(data, holeIndices, dim, triangles) {
    const hasHoles = holeIndices && holeIndices.length;
    const outerLen = hasHoles ? holeIndices[0] * dim : data.length;

    let polygonArea = Math.abs(signedArea(data, 0, outerLen, dim));
    if (hasHoles) {
        for (let i = 0, len = holeIndices.length; i < len; i++) {
            const start = holeIndices[i] * dim;
            const end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
            polygonArea -= Math.abs(signedArea(data, start, end, dim));
        }
    }

    let trianglesArea = 0;
    for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i] * dim;
        const b = triangles[i + 1] * dim;
        const c = triangles[i + 2] * dim;
        trianglesArea += Math.abs(
            (data[a] - data[c]) * (data[b + 1] - data[a + 1]) -
            (data[a] - data[b]) * (data[c + 1] - data[a + 1]));
    }

    // with no triangles, a polygon area within shoelace roundoff of zero (which scales with the
    // squared coordinate magnitude) means the input was degenerate rather than mistriangulated
    if (trianglesArea === 0) {
        let max = 0;
        for (let i = 0; i < data.length; i += dim) max = Math.max(max, Math.abs(data[i]), Math.abs(data[i + 1]));
        return Math.abs(polygonArea) <= data.length * max * max * Number.EPSILON ? 0 : 1;
    }
    return Math.abs((trianglesArea - polygonArea) / polygonArea);
}

/** @param {ArrayLike<number>} data @param {number} start @param {number} end @param {number} dim @returns {number} */
function signedArea(data, start, end, dim) {
    let sum = 0;
    for (let i = start, j = end - dim; i < end; i += dim) {
        sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
        j = i;
    }
    return sum;
}

/**
 * Turn a polygon in multi-dimensional array form (e.g. as in GeoJSON) into the flat form Earcut accepts.
 *
 * @param {ReadonlyArray<ReadonlyArray<ArrayLike<number>>>} data array of rings; the first ring is the outer contour, the rest are holes
 * @returns {{vertices: number[], holes: number[], dimensions: number}}
 * @example const {vertices, holes, dimensions} = flatten(geojson.coordinates);
 */
export function flatten(data) {
    const vertices = [];
    const holes = [];
    const dimensions = data[0][0].length;
    let holeIndex = 0;

    for (const ring of data) {
        for (const p of ring) {
            for (let d = 0; d < dimensions; d++) vertices.push(p[d]);
        }
        if (holeIndex && ring.length) holes.push(holeIndex);
        holeIndex += ring.length;
    }
    return {vertices, holes, dimensions};
}

// Reusable module-level scratch for refine():
//   he      = twin half-edge of each edge, or -1 on the polygon boundary
//   hTable  = open-addressing hash, slot -> half-edge index, valid iff hStamp[slot] === gen
//   edgeStamp = pending-in-stack flag, cleared when the edge is popped
/** @type {Int32Array} */ let edgeStack;
/** @type {Int32Array} */ let he;
/** @type {Int32Array} */ let hTable;
/** @type {Uint32Array} */ let hStamp;
/** @type {Uint8Array} */ let edgeStamp;
let hMask = 0, gen = 0;

/**
 * Refine a triangulation toward the constrained Delaunay triangulation by legalizing every
 * interior edge in place with Lawson flips — maximizing the minimum angle and removing most
 * slivers. An optional post-pass for {@link earcut} output, or any manifold triangle-index array
 * indexing into `coords`. Adapted from delaunator's edge legalization.
 *
 * Uses non-robust predicates: float input is fine, and the worst case is a not-quite-Delaunay
 * edge, never an invalid mesh.
 *
 * @param {number[]} triangles triangle indices, as returned by {@link earcut}; mutated in place
 * @param {ArrayLike<number>} coords the flat vertex coordinates passed to {@link earcut}
 * @param {number} [dim=2] number of coordinates per vertex in `coords`
 * @example refine(earcut(data), data);
 */
export function refine(triangles, coords, dim = 2) {
    const t = triangles;
    const n = t.length;
    if (n < 6) return;

    // the predicates below assume CCW triangles; for a CW mesh, swapping each edge's endpoints
    // mirrors them, so take the winding from the first non-degenerate triangle
    let cw = false;
    for (let k = 0, o = 0; o === 0 && k < n; k += 3) {
        const a = t[k] * dim, b = t[k + 1] * dim, c = t[k + 2] * dim;
        o = orient(coords[a], coords[a + 1], coords[b], coords[b + 1], coords[c], coords[c + 1]);
        cw = o < 0;
    }

    ensureScratch(n);
    gen++;              // bumping the generation logically empties the hash (no clearing)
    he.fill(-1, 0, n);

    // Build half-edge twins with an undirected-edge hash; consumed slots mark linked pairs. As each
    // pair is linked we seed the stack with one representative (s, the earlier-inserted edge) — this
    // fuses the initial "push every interior edge" pass into the build, saving a full O(n) scan.
    // edgeStamp is all-zero here (balanced push/pop leaves it clean) and each pair links once, so
    // the seed write needs no dedup guard.
    let i = 0;
    for (let e = 0; e < n; e++) {
        const a = t[e], b = t[nextHE(e)];
        const lo = a < b ? a : b, hi = a < b ? b : a;
        let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)) & hMask;
        while (hStamp[h] === gen) {
            const s = hTable[h];
            // s === -1 marks a consumed slot (a pair already linked) — skip past it
            if (s !== -1) {
                const sa = t[s], sb = t[nextHE(s)];
                if ((sa === lo && sb === hi) || (sa === hi && sb === lo)) {
                    he[e] = s; he[s] = e; hTable[h] = -1; // link, then consume the slot
                    edgeStamp[s] = 1; edgeStack[i++] = s; // seed the interior edge for the cascade
                    break;
                }
            }
            h = (h + 1) & hMask;
        }
        if (hStamp[h] !== gen) { hTable[h] = e; hStamp[h] = gen; } // first occurrence: insert
    }

    while (i > 0) {
        const a = edgeStack[--i];
        edgeStamp[a] = 0;
        const b = he[a];
        if (b === -1) continue;

        const a0 = a - a % 3;
        const b0 = b - b % 3;
        const ar = a0 + (a + 2) % 3;
        const al = a0 + (a + 1) % 3;
        const bl = b0 + (b + 2) % 3;
        const br = b0 + (b + 1) % 3;
        const p0 = t[ar], pr = t[cw ? al : a], pl = t[cw ? a : al], p1 = t[bl];

        const x0 = coords[p0 * dim], y0 = coords[p0 * dim + 1];
        const xr = coords[pr * dim], yr = coords[pr * dim + 1];
        const xl = coords[pl * dim], yl = coords[pl * dim + 1];
        const x1 = coords[p1 * dim], y1 = coords[p1 * dim + 1];

        // Test inCircle first: most interior edges are already Delaunay (inCircle true → no flip),
        // so this short-circuits before the two convexity orients on the common path. The quad must
        // also be convex (both new triangles CCW) — flipping a reflex quad would push a triangle
        // outside the polygon. Boundary/hole edges need no guard — they self-protect via he === -1.
        if (!inCircle(x0, y0, xr, yr, xl, yl, x1, y1) &&
            orient(x0, y0, xr, yr, x1, y1) > 0 && orient(x0, y0, x1, y1, xl, yl) > 0) {
            t[a] = p1; t[b] = p0;
            const hbl = he[bl], har = he[ar];
            he[a] = hbl; if (hbl !== -1) he[hbl] = a;
            he[b] = har; if (har !== -1) he[har] = b;
            he[ar] = bl; he[bl] = ar;

            // re-check the quad's four outer edges; skip boundary edges (he === -1) and any
            // already queued (edgeStamp), which also keeps the stack bounded by n.
            if (hbl    !== -1 && edgeStamp[a]  === 0) { edgeStamp[a]  = 1; edgeStack[i++] = a; }
            if (har    !== -1 && edgeStamp[b]  === 0) { edgeStamp[b]  = 1; edgeStack[i++] = b; }
            if (he[al] !== -1 && edgeStamp[al] === 0) { edgeStamp[al] = 1; edgeStack[i++] = al; }
            if (he[br] !== -1 && edgeStamp[br] === 0) { edgeStamp[br] = 1; edgeStack[i++] = br; }
        }
    }
}

/** @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {number} cx @param {number} cy */
function orient(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// Whether p is inside or exactly on the circumcircle of triangle (a, b, c). Sign is negated vs the
// usual predicate to match earcut's CCW winding — the standard sign would build the anti-Delaunay
// mesh. Cocircular quads are legal ties, so refine only flips when this returns false.
/** @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {number} cx @param {number} cy @param {number} px @param {number} py */
function inCircle(ax, ay, bx, by, cx, cy, px, py) {
    const dx = ax - px, dy = ay - py, ex = bx - px, ey = by - py, fx = cx - px, fy = cy - py;
    const ap = dx * dx + dy * dy, bp = ex * ex + ey * ey, cp = fx * fx + fy * fy;
    // A near-cocircular quad is a legal Delaunay tie, but roundoff can flag both an edge and its
    // flip as illegal, cascading into an endless flip loop (#205) — so treat a determinant within
    // a small margin of zero as a tie. The determinant's worst-case roundoff error is provably
    // below 9e-16·(ap + bp + cp)² (Shewchuk-style bound), so the margin guarantees every executed
    // flip is illegal in exact arithmetic, and Lawson flipping always terminates.
    const s = ap + bp + cp;
    return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) <= 1e-13 * s * s;
}

/** @param {number} e */
function nextHE(e) { // next half-edge within the same triangle
    return e - e % 3 + (e + 1) % 3;
}

// Grow the scratch arrays on demand (like earcut's z-order arrays). Allocating lazily here rather
// than at module load lets the whole refine() block tree-shake away for callers who don't use it.
/** @param {number} n */
function ensureScratch(n) {
    // edgeStack holds at most one entry per half-edge (edgeStamp dedups), so n is a safe cap —
    // sizing it up front lets the cascade push without a bounds/grow check.
    if (!edgeStack || edgeStack.length < n) edgeStack = new Int32Array(n);
    if (!he || he.length < n) he = new Int32Array(n);
    if (!edgeStamp || edgeStamp.length < n) edgeStamp = new Uint8Array(n);
    let size = 1;
    while (size < n * 4) size <<= 1; // power-of-two table, load factor <= 0.25
    if (!hTable || hTable.length < size) { hTable = new Int32Array(size); hStamp = new Uint32Array(size); }
    hMask = size - 1;
}

// ─── dirty-input repair layer ──────────────────────────────────────────────────────────────────
//
// earcut() assumes a valid polygon (see the "Robustness" section of the README) and on dirty data
// can silently emit overlapping or out-of-polygon triangles, loop forever, or throw. The functions
// below form an explicit pre/post layer instead: repair() turns a flat dirty polygon into a list of
// clean simple polygons that are safe to feed earcut(), reporting every problem it found rather
// than papering over it; validateTriangles() checks an index buffer before it reaches the GPU.
// Nothing here is on the earcut() hot path — the main function keeps its signature and behavior.

/**
 * What repair() should do with a self-intersecting ring:
 * - `'error'` (default): reject the ring, record an error and emit no triangles for it;
 * - `'split'`: cut the ring at each crossing into simple rings (figure-eight → two lobes);
 *   overlaps that cannot be split unambiguously are still rejected with an error.
 * @typedef {'split' | 'error'} SelfIntersectStrategy
 */

/**
 * @typedef {'duplicate-point' | 'collinear-point' | 'closing-point' | 'degenerate-ring' | 'self-intersection' | 'hole-outside' | 'nested-ring' | 'overlapping-rings'} RepairErrorCode
 */

/**
 * @typedef {object} RepairError
 * @property {RepairErrorCode} code machine-readable error code
 * @property {number} [ring] index of the offending input ring (0 = outer ring), when applicable
 * @property {string} message human-readable explanation
 */

/**
 * A clean simple polygon ready for earcut(): a flat vertex array plus the start indices of its
 * hole rings, in exactly the shape earcut() takes. `sourceRings` maps each emitted ring back to
 * the input ring it was derived from (a split ring fans out into several emitted rings sharing one
 * source index).
 * @typedef {object} RepairedPolygon
 * @property {number[]} vertices flat coordinate array, `dimensions` values per vertex
 * @property {number[]} holes hole ring start indices, in vertices
 * @property {number} dimensions coordinates per vertex
 * @property {number[]} sourceRings input-ring index of each emitted ring
 */

/**
 * @typedef {object} RepairStats
 * @property {number} removedDuplicates coincident points collapsed onto their neighbor
 * @property {number} removedCollinear collinear middle points removed
 * @property {number} removedClosing repeated first/last closing points removed
 * @property {number} splitRings rings cut into simple rings at self-intersections
 * @property {number} droppedRings rings rejected as untriangulable
 */

/**
 * @typedef {object} RepairResult
 * @property {RepairedPolygon[]} polygons clean simple polygons; triangulate each with earcut()
 * @property {RepairError[]} errors every problem found, in the order it was detected
 * @property {RepairStats} stats counts of what the repair pass did
 */

/**
 * Clean and validate a dirty polygon before triangulation.
 *
 * The cleaning pass, per ring, removes repeated closing points, consecutive duplicate points and
 * collinear middle points. Self-intersecting rings are either split into simple rings or rejected
 * outright, depending on `options.selfIntersect`. Holes are then checked against the outer ring
 * and arranged into a containment hierarchy: a ring nested in a hole (an island) becomes its own
 * output polygon, so a hole can never cover the outer ring, and a declared hole found outside the
 * outer ring is rejected with a `hole-outside` error instead of being silently dropped.
 *
 * Never throws on geometric problems — they land in `errors` and the offending geometry is excluded
 * from `polygons`, so the caller decides what to do. Structural misuse (bad `dim`, malformed
 * `holeIndices`) still throws, since no repair policy can interpret it.
 *
 * @param {ArrayLike<number>} data flat array of vertex coordinates, as taken by earcut()
 * @param {ArrayLike<number> | null} [holeIndices] indices (in vertices) where each hole ring starts
 * @param {number} [dim=2] number of coordinates per vertex in `data`
 * @param {{selfIntersect?: SelfIntersectStrategy}} [options]
 * @returns {RepairResult}
 * @example
 * const {polygons, errors} = earcut.repair(data, holes, 2);
 * const triangles = polygons.flatMap(p => earcut(p.vertices, p.holes, p.dimensions));
 */
export function repair(data, holeIndices = null, dim = 2, options) {
    const strategy = options && options.selfIntersect === 'split' ? 'split' : 'error';

    if (!Number.isInteger(dim) || dim < 2) {
        throw new RangeError(`earcut.repair: dim must be an integer >= 2, got ${dim}`);
    }
    if (data.length % dim !== 0) {
        throw new RangeError('earcut.repair: data length is not a multiple of dim (trailing partial vertex)');
    }
    const vertexCount = data.length / dim;

    /** @type {RepairError[]} */
    const errors = [];
    /** @type {RepairStats} */
    const stats = {
        removedDuplicates: 0,
        removedCollinear: 0,
        removedClosing: 0,
        splitRings: 0,
        droppedRings: 0
    };

    // split the flat input into per-ring vertex ranges; hole indices must be strictly increasing
    // and point inside the array — a bogus index is a caller bug, not a geometric defect
    /** @type {Array<[number, number]>} */
    const ranges = [[0, holeIndices && holeIndices.length ? holeIndices[0] : vertexCount]];
    if (holeIndices) {
        for (let i = 0; i < holeIndices.length; i++) {
            const h = holeIndices[i];
            if (!Number.isInteger(h) || h <= 0 || h >= vertexCount) {
                throw new RangeError(`earcut.repair: hole index ${h} out of range [1, ${vertexCount - 1}]`);
            }
            if (i > 0 && h <= holeIndices[i - 1]) {
                throw new RangeError(`earcut.repair: hole indices must be strictly increasing (${holeIndices[i - 1]} >= ${h})`);
            }
            const end = i < holeIndices.length - 1 ? holeIndices[i + 1] : vertexCount;
            ranges.push([h, end]);
        }
    }

    // coordinate pool: original vertices keep their index; split crossings append synthetic ones
    if (vertexCount === 0) return {polygons: [], errors, stats};
    /** @type {number[][]} */
    const pool = new Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
        const p = new Array(dim);
        for (let d = 0; d < dim; d++) p[d] = data[v * dim + d];
        pool[v] = p;
    }
    /** @param {number} a @param {number} b @returns {boolean} */
    const samePoint = (a, b) => {
        const pa = pool[a], pb = pool[b];
        for (let d = 0; d < dim; d++) if (pa[d] !== pb[d]) return false;
        return true;
    };
    /** @param {number} a @param {number} b @param {number} c @returns {number} */
    const orient3 = (a, b, c) => {
        const pa = pool[a], pb = pool[b], pc = pool[c];
        return (pb[0] - pa[0]) * (pc[1] - pb[1]) - (pb[1] - pa[1]) * (pc[0] - pb[0]);
    };
    /** @param {number} a @param {number} b @param {number} t @returns {number} */
    const lerpPoint = (a, b, t) => {
        const pa = pool[a], pb = pool[b], p = new Array(dim);
        for (let d = 0; d < dim; d++) p[d] = pa[d] + (pb[d] - pa[d]) * t;
        pool.push(p);
        return pool.length - 1;
    };

    /**
     * @typedef {object} CleanRing
     * @property {number[]} ids pool vertex ids in ring order, no repeated closing point
     * @property {number} source input-ring index this ring derives from
     * @property {number} area signed (shoelace) area, filled in after splitting is done
     * @property {CleanRing | null} parent containing ring in the containment hierarchy
     * @property {number} depth 0 for outer-level shells, 1 for holes, 2 for islands, ...
     */

    /** @type {CleanRing[]} */
    const rings = [];

    // remove closing/duplicate/collinear points from a ring id list. Consecutive duplicates are
    // collapsed in a linear sweep first, because a duplicated vertex makes the orientation test
    // read 0 and would otherwise be miscounted (and mis-handled) as collinear; the collinear sweep
    // then loops to a fixpoint since each removal can make a previously non-collinear pair collinear.
    /** @param {number[]} ids @param {number} source @returns {number[] | null} */
    function cleanRing(ids, source) {
        if (ids.length >= 2 && samePoint(ids[ids.length - 1], ids[0])) {
            ids.pop();
            stats.removedClosing++;
        }

        // linear dedup of consecutive coincident vertices, keeping the first of each run
        if (ids.length >= 2) {
            /** @type {number[]} */
            const deduped = [ids[0]];
            for (let k = 1; k < ids.length; k++) {
                if (samePoint(ids[k], deduped[deduped.length - 1])) {
                    stats.removedDuplicates++;
                } else {
                    deduped.push(ids[k]);
                }
            }
            ids = deduped;
        }

        let changed = true;
        while (changed && ids.length >= 3) {
            changed = false;
            /** @type {number[]} */
            const out = [];
            for (let k = 0; k < ids.length; k++) {
                const prev = ids[(k + ids.length - 1) % ids.length];
                const cur = ids[k];
                const next = ids[(k + 1) % ids.length];
                if (!samePoint(prev, cur) && !samePoint(cur, next) && orient3(prev, cur, next) === 0) {
                    stats.removedCollinear++;
                    changed = true;
                } else {
                    out.push(cur);
                }
            }
            ids = out;
        }
        if (ids.length < 3) {
            errors.push({
                code: 'degenerate-ring',
                ring: source,
                message: `ring ${source} collapsed to fewer than 3 distinct points and cannot be triangulated`
            });
            stats.droppedRings++;
            return null;
        }
        return ids;
    }

    // find the first self-intersection of a simple-ordered id list. Proper crossings and
    // T-junctions are splittable; collinear overlaps are ambiguous and reported as unsplittable,
    // so they get a dedicated first pass — otherwise an earlier T-junction on the same ring could
    // be cut away before the overlapping pair is ever inspected.
    /**
     * @param {number[]} ids
     * @returns {{kind: 'proper' | 'touch' | 'duplicate' | 'collinear', i: number, j: number, id: number} | null}
     */
    function findSelfIntersection(ids) {
        const n = ids.length;

        // non-adjacent repeated vertex: split at the shared point, no synthetic vertex needed
        for (let i = 0; i < n; i++) {
            for (let j = i + 2; j < n; j++) {
                if ((i !== 0 || j !== n - 1) && samePoint(ids[i], ids[j])) {
                    return {kind: 'duplicate', i, j, id: ids[i]};
                }
            }
        }

        // pass 1: collinear edge pairs whose segments overlap (and which don't merely meet at a
        // shared endpoint) — an overlap has no unambiguous simple-ring decomposition
        for (let i = 0; i < n; i++) {
            const a = ids[i], b = ids[(i + 1) % n];
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue; // adjacent edges in the circular ordering
                const c = ids[j], d = ids[(j + 1) % n];
                if (orient3(a, b, c) === 0 && orient3(a, b, d) === 0 &&
                        bboxesOverlap(a, b, c, d) &&
                        !samePoint(a, c) && !samePoint(a, d) && !samePoint(b, c) && !samePoint(b, d)) {
                    return {kind: 'collinear', i, j, id: -1};
                }
            }
        }

        // pass 2: proper crossings and T-junctions
        for (let i = 0; i < n; i++) {
            const a = ids[i], b = ids[(i + 1) % n];
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue; // edges share vertex a: adjacent in the circle
                const c = ids[j], d = ids[(j + 1) % n];
                const d1 = orient3(c, d, a), d2 = orient3(c, d, b);
                const d3 = orient3(a, b, c), d4 = orient3(a, b, d);
                const crosses = ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
                    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));

                if (crosses) {
                    // A + t(B - A) where orient(A,B,P(t)) = d3 + t(d4 - d3) = 0
                    const t = d3 / (d3 - d4);
                    return {kind: 'proper', i, j, id: lerpPoint(a, b, t)};
                }

                // T-junction: a vertex of one edge lies strictly inside the other edge
                if (d3 === 0 && onSegmentPool(a, b, c)) return {kind: 'touch', i, j, id: c};
                if (d4 === 0 && onSegmentPool(a, b, d)) return {kind: 'touch', i, j, id: d};
                if (d1 === 0 && onSegmentPool(c, d, a)) return {kind: 'touch', i: j, j: i, id: a};
                if (d2 === 0 && onSegmentPool(c, d, b)) return {kind: 'touch', i: j, j: i, id: b};
            }
        }
        return null;
    }

    /** @param {number} p @param {number} q @param {number} r @returns {boolean} */
    function onSegmentPool(p, q, r) {
        const pp = pool[p], qp = pool[q], rp = pool[r];
        return rp[0] <= Math.max(pp[0], qp[0]) && rp[0] >= Math.min(pp[0], qp[0]) &&
            rp[1] <= Math.max(pp[1], qp[1]) && rp[1] >= Math.min(pp[1], qp[1]);
    }
    /** @param {number} a @param {number} b @param {number} c @param {number} d @returns {boolean} */
    function bboxesOverlap(a, b, c, d) {
        const pa = pool[a], pb = pool[b], pc = pool[c], pd = pool[d];
        return Math.max(pa[0], pb[0]) >= Math.min(pc[0], pd[0]) &&
            Math.min(pa[0], pb[0]) <= Math.max(pc[0], pd[0]) &&
            Math.max(pa[1], pb[1]) >= Math.min(pc[1], pd[1]) &&
            Math.min(pa[1], pb[1]) <= Math.max(pc[1], pd[1]);
    }

    // recursively split-or-reject one cleaned ring. `budget` bounds the recursion: every split
    // strictly shortens both children, so more cuts than original vertices means the ring never
    // converges (defensive — the splittable cases always shrink on the first cut).
    /** @param {number[]} ids @param {number} source @param {number} budget */
    function resolveRing(ids, source, budget) {
        const hit = findSelfIntersection(ids);
        if (!hit) {
            rings.push({ids, source, area: 0, parent: null, depth: -1});
            return;
        }

        if (hit.kind === 'collinear' || strategy === 'error' || budget <= 0) {
            /** @type {string} */
            let message;
            if (hit.kind === 'collinear') {
                message = `ring ${source} has overlapping collinear edges, which cannot be split unambiguously`;
            } else if (strategy === 'error') {
                message = `ring ${source} is self-intersecting; pass {selfIntersect: 'split'} to split it into simple rings`;
            } else {
                message = `ring ${source} did not converge after splitting and was rejected`;
            }
            errors.push({code: 'self-intersection', ring: source, message});
            stats.droppedRings++;
            return;
        }

        stats.splitRings++;
        const {i, j, id} = hit;
        const n = ids.length;
        // cut at the crossing: lobe 1 runs i+1..j, lobe 2 wraps j+1..i; each opens and closes
        // through the shared crossing point, which cleanRing() immediately collapses
        const child1 = cleanRing([id, ...ids.slice(i + 1, j + 1)], source);
        const child2 = cleanRing([id, ...ids.slice(j + 1), ...ids.slice(0, i + 1)], source);
        if (!child1 || !child2 || child1.length >= n || child2.length >= n) {
            errors.push({
                code: 'self-intersection',
                ring: source,
                message: `ring ${source} produced a non-simple split and was rejected`
            });
            stats.droppedRings++;
            return;
        }
        resolveRing(child1, source, budget - 1);
        resolveRing(child2, source, budget - 1);
    }

    for (let r = 0; r < ranges.length; r++) {
        const [start, end] = ranges[r];
        const ids = [];
        for (let v = start; v < end; v++) ids.push(v);
        const cleaned = cleanRing(ids, r);
        if (cleaned) resolveRing(cleaned, r, cleaned.length);
    }

    if (rings.length === 0) return {polygons: [], errors, stats};

    // area below which a ring is treated as degenerate. Splitting at a crossing can leave a
    // sliver lobe whose points are nearly coincident; its absolute shoelace area is non-zero but
    // below the float roundoff of the coordinate magnitude, and feeding it to earcut yields
    // zero-area triangles. The threshold mirrors deviation(): O(n) edges, each O(max²) in area.
    let maxCoord = 0;
    for (const p of pool) {
        maxCoord = Math.max(maxCoord, Math.abs(p[0]), Math.abs(p[1]));
    }
    const areaEpsilon = pool.length * maxCoord * maxCoord * Number.EPSILON;

    // signed shoelace area; reject zero-area and sub-epsilon survivors (collinear-after-split lobes)
    for (const ring of rings) {
        let sum = 0;
        for (let k = 0, n = ring.ids.length; k < n; k++) {
            const p = pool[ring.ids[k]], q = pool[ring.ids[(k + 1) % n]];
            sum += p[0] * q[1] - q[0] * p[1];
        }
        ring.area = sum / 2;
        if (Math.abs(ring.area) <= areaEpsilon) {
            errors.push({
                code: 'degenerate-ring',
                ring: ring.source,
                message: `ring ${ring.source} has ${ring.area === 0 ? 'zero' : 'near-zero'} area and cannot be triangulated`
            });
        }
    }
    for (let k = rings.length - 1; k >= 0; k--) {
        if (Math.abs(rings[k].area) <= areaEpsilon) { rings.splice(k, 1); stats.droppedRings++; }
    }
    if (rings.length === 0) return {polygons: [], errors, stats};

    // reject ring pairs that cross or share an edge segment: rings may meet at vertices (the lobes
    // of a split ring do), but overlapping boundaries make a containment hierarchy meaningless
    /** @param {CleanRing} a @param {CleanRing} b @returns {boolean} */
    function ringsOverlap(a, b) {
        const ai = a.ids, bi = b.ids;
        for (let i = 0; i < ai.length; i++) {
            const p = ai[i], q = ai[(i + 1) % ai.length];
            for (let j = 0; j < bi.length; j++) {
                const r = bi[j], s = bi[(j + 1) % bi.length];
                if (samePoint(p, r) || samePoint(p, s) || samePoint(q, r) || samePoint(q, s)) continue;
                const d1 = orient3(r, s, p), d2 = orient3(r, s, q);
                const d3 = orient3(p, q, r), d4 = orient3(p, q, s);
                if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
                    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
                if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0 && bboxesOverlap(p, q, r, s)) return true;
                if ((d3 === 0 && onSegmentPool(p, q, r)) || (d4 === 0 && onSegmentPool(p, q, s)) ||
                    (d1 === 0 && onSegmentPool(r, s, p)) || (d2 === 0 && onSegmentPool(r, s, q))) return true;
            }
        }
        return false;
    }
    for (let pass = 0; pass < rings.length; pass++) {
        let dropped = false;
        for (let i = 0; i < rings.length && !dropped; i++) {
            for (let j = i + 1; j < rings.length; j++) {
                if (ringsOverlap(rings[i], rings[j])) {
                    // drop the smaller ring; ties prefer the later (hole-side) one
                    const victim = Math.abs(rings[i].area) <= Math.abs(rings[j].area) ? i : j;
                    const ring = rings[victim];
                    errors.push({
                        code: 'overlapping-rings',
                        ring: ring.source,
                        message: `ring ${ring.source} overlaps another ring's boundary and was rejected`
                    });
                    rings.splice(victim, 1);
                    stats.droppedRings++;
                    dropped = true;
                    break;
                }
            }
        }
        if (!dropped) break;
    }

    // ray-casting point-in-ring. After the overlap pass no two surviving ring boundaries cross or
    // touch (except at shared vertices), so one representative vertex of `inner` is enough to decide
    // containment — a boundary hit only happens for lobes meeting at a point, which aren't nested.
    /** @param {CleanRing} ring @param {number} x @param {number} y @returns {boolean} */
    function pointInRing(ring, x, y) {
        let inside = false;
        const ids = ring.ids;
        for (let k = 0, j = ids.length - 1; k < ids.length; j = k++) {
            const px = pool[ids[k]][0], py = pool[ids[k]][1];
            const qx = pool[ids[j]][0], qy = pool[ids[j]][1];
            if ((py > y) !== (qy > y) && x < (qx - px) * (y - py) / (qy - py) + px) inside = !inside;
        }
        return inside;
    }
    /** @param {CleanRing} ring @param {number} id @returns {boolean} */
    function pointOnRing(ring, id) {
        const ids = ring.ids;
        for (let k = 0; k < ids.length; k++) {
            const a = ids[k], b = ids[(k + 1) % ids.length];
            if (orient3(a, b, id) === 0 && onSegmentPool(a, b, id)) return true;
            if (samePoint(a, id)) return true;
        }
        return false;
    }
    /** @param {CleanRing} outer @param {CleanRing} inner @returns {boolean} */
    function ringContains(outer, inner) {
        if (Math.abs(outer.area) <= Math.abs(inner.area)) return false;
        // containment requires EVERY inner vertex inside the outer ring; a single representative
        // would misclassify a hole whose boundary crosses the outer ring while one vertex stays in.
        // Boundary vertices are skipped (rings may legitimately touch) and only decisive inside/
        // outside verdicts count, so rings meeting at a point still resolve to not-contained.
        let decisive = 0;
        for (const id of inner.ids) {
            if (pointOnRing(outer, id)) continue;
            decisive++;
            if (!pointInRing(outer, pool[id][0], pool[id][1])) return false;
        }
        return decisive > 0;
    }

    // build the containment hierarchy: parent = smallest ring strictly containing this one.
    // Rings produced by splitting the SAME input ring are sibling shells, never a nesting: a
    // figure-eight's lobes may geometrically overlap in bbox but neither is a hole of the other.
    /** @param {CleanRing[]} survivors */
    function buildHierarchy(survivors) {
        for (const ring of survivors) {
            /** @type {CleanRing | null} */
            let parent = null;
            for (const candidate of survivors) {
                if (candidate === ring || candidate.source === ring.source ||
                        !ringContains(candidate, ring)) continue;
                if (!parent || Math.abs(candidate.area) < Math.abs(parent.area)) parent = candidate;
            }
            ring.parent = parent;
            ring.depth = parent ? parent.depth + 1 : 0;
        }
    }
    buildHierarchy(rings);

    // a declared hole (source > 0) with no containing ring sits outside the outer ring. A split
    // hole fans out into several rings sharing one source, so report each source ring once.
    /** @type {Set<number>} */
    const outsideReported = new Set();
    /** @param {CleanRing[]} survivors */
    function dropOutsideHoles(survivors) {
        for (let k = survivors.length - 1; k >= 0; k--) {
            const ring = survivors[k];
            if (ring.depth === 0 && ring.source > 0 && !outsideReported.has(ring.source)) {
                outsideReported.add(ring.source);
                errors.push({
                    code: 'hole-outside',
                    ring: ring.source,
                    message: `hole ring ${ring.source} is not inside the outer ring and was rejected`
                });
                stats.droppedRings++;
                survivors.splice(k, 1);
            }
        }
    }
    dropOutsideHoles(rings);
    buildHierarchy(rings);

    // depth parity: even = filled shell, odd = hole. An island (even depth >= 2) nested in a hole
    // becomes its own polygon, so holes never cover the outer ring; record the nesting explicitly.
    // Split siblings share a source, so the nested-ring notice is likewise emitted once per source.
    /** @type {Set<number>} */
    const nestedReported = new Set();
    for (const ring of rings) {
        if (ring.depth >= 2 && !nestedReported.has(ring.source)) {
            nestedReported.add(ring.source);
            const tail = ring.depth % 2 === 0 ?
                'and was emitted as a separate island polygon' :
                'and was attached as a hole of its island';
            errors.push({
                code: 'nested-ring',
                ring: ring.source,
                message: `ring ${ring.source} is nested ${ring.depth} levels deep ${tail}`
            });
        }
    }

    // group rings into output polygons: each even-depth shell owns itself plus the odd-depth holes
    // whose nearest even ancestor it is; the outer shell and every island are separate polygons

    // final safety gate: a ring that survived every earlier pass must actually be simple. Sibling
    // lobes split from the same source ring can overlap each other, and the overlap-rejection pass
    // only handles ring pairs — so re-check each ring against itself and reject any that still
    // crosses. Emitting a self-intersecting shell would make earcut() produce wrong triangles,
    // which is exactly the failure repair() exists to prevent.
    /** @param {CleanRing} ring @returns {boolean} */
    function isSimpleRing(ring) {
        const ids = ring.ids, n = ids.length;
        for (let i = 0; i < n; i++) {
            const a = ids[i], b = ids[(i + 1) % n];
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue; // adjacent circular edges
                const c = ids[j], d = ids[(j + 1) % n];
                const d1 = orient3(c, d, a), d2 = orient3(c, d, b);
                const d3 = orient3(a, b, c), d4 = orient3(a, b, d);
                if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
                    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return false;
                // collinear overlap (shared endpoints are allowed), or a T-junction in the interior
                if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0 && bboxesOverlap(a, b, c, d) &&
                        !samePoint(a, c) && !samePoint(a, d) && !samePoint(b, c) && !samePoint(b, d)) {
                    return false;
                }
                if ((d3 === 0 && onSegmentPool(a, b, c)) || (d4 === 0 && onSegmentPool(a, b, d)) ||
                        (d1 === 0 && onSegmentPool(c, d, a)) || (d2 === 0 && onSegmentPool(c, d, b))) {
                    return false;
                }
            }
        }
        return true;
    }
    // do the boundaries of two distinct rings cross or overlap (a shared vertex is allowed)?
    /** @param {CleanRing} shell @param {CleanRing} hole @returns {boolean} */
    function ringsCross(shell, hole) {
        const ai = shell.ids, bi = hole.ids;
        for (let i = 0; i < ai.length; i++) {
            const a = ai[i], b = ai[(i + 1) % ai.length];
            for (let j = 0; j < bi.length; j++) {
                const c = bi[j], d = bi[(j + 1) % bi.length];
                if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) continue;
                const d1 = orient3(c, d, a), d2 = orient3(c, d, b);
                const d3 = orient3(a, b, c), d4 = orient3(a, b, d);
                if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
                    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
                if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0 && bboxesOverlap(a, b, c, d)) return true;
                if ((d3 === 0 && onSegmentPool(a, b, c)) || (d4 === 0 && onSegmentPool(a, b, d)) ||
                        (d1 === 0 && onSegmentPool(c, d, a)) || (d2 === 0 && onSegmentPool(c, d, b))) {
                    return true;
                }
            }
        }
        return false;
    }
    /** @type {Set<number>} */
    const nonsimpleReported = new Set();
    for (let k = rings.length - 1; k >= 0; k--) {
        if (!isSimpleRing(rings[k])) {
            const ring = rings[k];
            if (!nonsimpleReported.has(ring.source)) {
                nonsimpleReported.add(ring.source);
                errors.push({
                    code: 'self-intersection',
                    ring: ring.source,
                    message: `ring ${ring.source} could not be decomposed into simple rings and was rejected`
                });
            }
            rings.splice(k, 1);
            stats.droppedRings++;
        }
    }
    // dropping a shell orphans the holes nested in it; rebuild the hierarchy and re-run the
    // outside-hole sweep, since an orphaned declared hole must not be emitted as a root shell
    buildHierarchy(rings);
    dropOutsideHoles(rings);
    buildHierarchy(rings);

    /** @type {Map<CleanRing, CleanRing[]>} */
    const byOwner = new Map();
    for (const ring of rings) {
        if (ring.depth % 2 === 0) {
            byOwner.set(ring, [ring]);
        } else {
            /** @type {CleanRing} */
            let owner = ring;
            while (owner.depth % 2 !== 0) {
                owner = /** @type {CleanRing} */ (owner.parent);
            }
            const group = byOwner.get(owner);
            if (group) group.push(ring);
        }
    }

    /** @type {RepairedPolygon[]} */
    const polygons = [];
    /** @type {Set<number>} */
    const crossingReported = new Set();
    // emit outer-ring-derived polygons first, islands after; within a polygon, shell then holes
    const owners = [...byOwner.keys()].sort((a, b) => a.source - b.source || Math.abs(b.area) - Math.abs(a.area));
    for (const owner of owners) {
        const group = byOwner.get(owner);
        if (!group) continue;
        const shell = group[0];
        // a hole whose boundary crosses its shell (or a sibling hole) cannot be triangulated as a
        // hole; reject it and emit the shell without it rather than produce overlapping triangles
        const holes = group.slice(1).sort((a, b) => a.source - b.source).filter((hole) => {
            let crosses = ringsCross(shell, hole);
            if (!crosses) {
                for (const other of group) {
                    if (other !== shell && other !== hole && ringsCross(other, hole)) { crosses = true; break; }
                }
            }
            if (crosses) {
                stats.droppedRings++;
                if (!crossingReported.has(hole.source)) {
                    crossingReported.add(hole.source);
                    errors.push({
                        code: 'overlapping-rings',
                        ring: hole.source,
                        message: `hole ring ${hole.source} crosses another ring's boundary and was rejected`
                    });
                }
            }
            return !crosses;
        });
        /** @type {number[]} */
        const vertices = [];
        /** @type {number[]} */
        const holesOut = [];
        /** @type {number[]} */
        const sourceRings = [];
        for (const ring of [shell, ...holes]) {
            if (ring !== shell) holesOut.push(vertices.length / dim);
            sourceRings.push(ring.source);
            for (const id of ring.ids) vertices.push(...pool[id]);
        }
        polygons.push({vertices, holes: holesOut, dimensions: dim, sourceRings});
    }

    return {polygons, errors, stats};
}

/**
 * @typedef {object} TriangleValidationStats
 * @property {number} droppedDegenerate zero-area triangles removed
 * @property {number} droppedInvalid triangles with out-of-range or non-integer indices removed
 */

/**
 * @typedef {object} TriangleValidationResult
 * @property {number[]} triangles the surviving triplets, ready for a vertex buffer
 * @property {RepairError[]} errors one entry per invalid triplet (degenerate drops are not errors)
 * @property {TriangleValidationStats} stats
 */

/**
 * Validate an earcut() index buffer against its vertex data: every index must be an integer in
 * `[0, vertexCount)`, the buffer length must be a multiple of three, and zero-area (degenerate)
 * triangles are removed. Returns a new array — the input is never mutated. Degenerate triangles
 * are counted in `stats` rather than reported as errors: after repairing dirty input their absence
 * is expected, whereas an out-of-range index would feed the GPU garbage and is always an error.
 *
 * @param {ArrayLike<number>} triangles triangle indices, as returned by earcut()
 * @param {ArrayLike<number>} data flat coordinate array the indices refer into
 * @param {number} [dim=2] number of coordinates per vertex in `data`
 * @returns {TriangleValidationResult}
 */
export function validateTriangles(triangles, data, dim = 2) {
    if (!Number.isInteger(dim) || dim < 2 || data.length % dim !== 0) {
        throw new RangeError('validateTriangles: data length is not a multiple of dim');
    }
    const vertexCount = data.length / dim;
    /** @type {number[]} */
    const kept = [];
    /** @type {RepairError[]} */
    const errors = [];
    let droppedDegenerate = 0;
    let droppedInvalid = 0;

    if (triangles.length % 3 !== 0) {
        errors.push({
            code: 'degenerate-ring',
            message: `triangle list length ${triangles.length} is not a multiple of 3; trailing indices ignored`
        });
    }

    const triplets = Math.floor(triangles.length / 3);
    for (let t = 0; t < triplets; t++) {
        const k = t * 3;
        const a = triangles[k], b = triangles[k + 1], c = triangles[k + 2];
        const valid = Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c) &&
            a >= 0 && b >= 0 && c >= 0 && a < vertexCount && b < vertexCount && c < vertexCount;

        if (!valid) {
            errors.push({
                code: 'overlapping-rings',
                message: `triangle ${t} has an index outside [0, ${vertexCount - 1}]: [${a}, ${b}, ${c}]`
            });
            droppedInvalid++;
            continue;
        }

        const ax = data[a * dim], ay = data[a * dim + 1];
        const bx = data[b * dim], by = data[b * dim + 1];
        const cx = data[c * dim], cy = data[c * dim + 1];
        if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) {
            droppedDegenerate++;
            continue;
        }
        kept.push(a, b, c);
    }

    return {
        triangles: kept,
        errors,
        stats: {droppedDegenerate, droppedInvalid}
    };
}

// expose repair() as earcut.repair while keeping the default-export function signature untouched
earcut.repair = repair;

import test from 'node:test';
import assert from 'node:assert/strict';
import earcut, {repair} from '../src/earcut.js';

function trianglesArea(data, triangles, dim = 2) {
    let sum = 0;
    for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i] * dim, b = triangles[i + 1] * dim, c = triangles[i + 2] * dim;
        sum += Math.abs((data[b] - data[a]) * (data[c + 1] - data[a + 1]) -
            (data[b + 1] - data[a + 1]) * (data[c] - data[a])) / 2;
    }
    return sum;
}

// every triangle must index a real vertex and have non-zero area
function assertValidTriangles(data, triangles, dim = 2) {
    const n = data.length / dim;
    for (const idx of triangles) assert.ok(idx >= 0 && idx < n, `index ${idx} out of range`);
    for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i] * dim, b = triangles[i + 1] * dim, c = triangles[i + 2] * dim;
        assert.notEqual((data[b] - data[a]) * (data[c + 1] - data[a + 1]) -
            (data[b + 1] - data[a + 1]) * (data[c] - data[a]), 0, 'zero-area triangle');
    }
}

const square = [0, 0, 10, 0, 10, 10, 0, 10];

test('repair is exposed as a named export and as earcut.repair', () => {
    assert.equal(earcut.repair, repair);
    assert.equal(typeof repair, 'function');
});

test('clean input matches earcut output exactly', () => {
    const data = [...square, 2, 2, 4, 2, 4, 4];
    const holes = [4];
    const result = repair(data, holes);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.data, data);
    assert.deepEqual(result.triangles, earcut(data, holes));
    assertValidTriangles(result.data, result.triangles);
});

test('removes duplicate, collinear and closing points', () => {
    const dirty = [0, 0, 5, 0, 10, 0, 10, 0, 10, 10, 0, 10, 0, 0];
    const result = repair(dirty);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.data, square);
    assert.deepEqual(result.triangles, earcut(square));
    assertValidTriangles(result.data, result.triangles);
});

test('does not remove spike tips (collinear but not between neighbors)', () => {
    // 5,5 is a spike tip: collinear with the edge direction but outside its neighbors' segment
    const spiked = [0, 0, 10, 0, 5, 0, 10, 10, 0, 10];
    const result = repair(spiked);
    assert.ok(result.triangles.length > 0);
    assertValidTriangles(result.data, result.triangles);
});

test('drops non-finite vertices with an error', () => {
    const result = repair([0, 0, 10, 0, NaN, 5, 10, 10, 0, 10]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /non-finite/);
    assert.deepEqual(result.data, square);
    assertValidTriangles(result.data, result.triangles);
});

test('rejects a ring with fewer than 3 distinct vertices', () => {
    const result = repair([1, 1, 1, 1, 2, 2]);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.triangles, []);
    assert.deepEqual(result.data, []);
});

test('self-intersecting outer ring: error mode rejects the ring', () => {
    const bowtie = [0, 0, 2, 2, 2, 0, 0, 2];
    const result = repair(bowtie);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /self-intersection/);
    assert.deepEqual(result.triangles, []);
    assert.deepEqual(result.data, []);
});

test('self-intersecting outer ring: split mode triangulates both lobes', () => {
    const bowtie = [0, 0, 2, 2, 2, 0, 0, 2];
    const result = repair(bowtie, null, 2, {selfIntersection: 'split'});
    assert.deepEqual(result.errors, []);
    assert.equal(trianglesArea(result.data, result.triangles), 2); // two unit-area lobes
    assertValidTriangles(result.data, result.triangles);
});

test('self-intersecting hole: error mode drops the hole, keeps the outer ring', () => {
    const hole = [4, 4, 8, 8, 8, 4, 4, 8]; // bowtie
    const outer = [0, 0, 20, 0, 20, 20, 0, 20];
    const result = repair([...outer, ...hole], [4]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /self-intersection/);
    assert.equal(trianglesArea(result.data, result.triangles), 400);
    assertValidTriangles(result.data, result.triangles);
});

test('self-intersecting hole: split mode cuts both lobes out of the outer ring', () => {
    const hole = [4, 4, 8, 8, 8, 4, 4, 8]; // bowtie, two lobes of area 4 each
    const outer = [0, 0, 20, 0, 20, 20, 0, 20];
    const result = repair([...outer, ...hole], [4], 2, {selfIntersection: 'split'});
    assert.deepEqual(result.errors, []);
    assert.equal(trianglesArea(result.data, result.triangles), 400 - 8);
    assertValidTriangles(result.data, result.triangles);
});

test('hole outside the outer ring is dropped with an error', () => {
    const hole = [20, 20, 30, 20, 30, 30];
    const result = repair([...square, ...hole], [4]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /not inside the outer ring/);
    assert.deepEqual(result.triangles, earcut(square));
    assertValidTriangles(result.data, result.triangles);
});

test('hole covering the outer ring is dropped with an error', () => {
    const hole = [-10, -10, 20, -10, 20, 20, -10, 20];
    const result = repair([...square, ...hole], [4]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /covers the outer ring/);
    assert.deepEqual(result.triangles, earcut(square));
    assertValidTriangles(result.data, result.triangles);
});

test('hole crossing the outer boundary is dropped with an error', () => {
    const hole = [5, 5, 15, 5, 15, 15, 5, 15]; // half inside, half outside
    const result = repair([...square, ...hole], [4]);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.triangles, earcut(square));
    assertValidTriangles(result.data, result.triangles);
});

test('nested holes: a hole inside a hole is a solid island', () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];       // area 100
    const hole = [1, 1, 9, 1, 9, 9, 1, 9];            // area 64
    const island = [3, 3, 7, 3, 7, 7, 3, 7];          // area 16
    const result = repair([...outer, ...hole, ...island], [4, 8]);
    assert.deepEqual(result.errors, []);
    assert.equal(trianglesArea(result.data, result.triangles), 100 - 64 + 16);
    assertValidTriangles(result.data, result.triangles);
});

test('three nesting levels: hole inside an island cuts again', () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];       // area 100
    const hole = [1, 1, 9, 1, 9, 9, 1, 9];            // area 64
    const island = [3, 3, 7, 3, 7, 7, 3, 7];          // area 16
    const isleHole = [4, 4, 6, 4, 6, 6, 4, 6];        // area 4
    const result = repair([...outer, ...hole, ...island, ...isleHole], [4, 8, 12]);
    assert.deepEqual(result.errors, []);
    assert.equal(trianglesArea(result.data, result.triangles), 100 - 64 + 16 - 4);
    assertValidTriangles(result.data, result.triangles);
});

test('invalid hole indices are reported and ignored', () => {
    for (const holes of [[0], [4, 4], [10], [-1]]) {
        const result = repair(square, holes);
        assert.ok(result.errors.length > 0, `holes ${holes} should error`);
        assert.deepEqual(result.triangles, earcut(square));
        assertValidTriangles(result.data, result.triangles);
    }
});

test('dim=3 vertices keep their extra coordinates through cleaning', () => {
    const dirty = [0, 0, 7, 10, 0, 8, 10, 0, 8, 10, 10, 9, 0, 10, 1];
    const result = repair(dirty, null, 3);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.data, [0, 0, 7, 10, 0, 8, 10, 10, 9, 0, 10, 1]);
    assert.deepEqual(result.triangles, earcut(result.data, null, 3));
    assertValidTriangles(result.data, result.triangles, 3);
});

test('split mode interpolates extra dimensions at crossing points', () => {
    const bowtie = [0, 0, 10, 2, 2, 20, 2, 0, 30, 0, 2, 40];
    const result = repair(bowtie, null, 3, {selfIntersection: 'split'});
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.length % 3, 0);
    assertValidTriangles(result.data, result.triangles, 3);
});

test('does not mutate the input arrays', () => {
    const data = [0, 0, 5, 0, 10, 0, 10, 0, 10, 10, 0, 10, 0, 0];
    const holes = [];
    const snapshot = data.slice();
    repair(data, holes);
    assert.deepEqual(data, snapshot);
    assert.deepEqual(holes, []);
});

test('empty input', () => {
    const result = repair([]);
    assert.deepEqual(result, {data: [], triangles: [], errors: ['outer ring: fewer than 3 distinct vertices after cleaning; ring dropped']});
});

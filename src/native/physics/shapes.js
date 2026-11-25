'use strict';
// Boxes and the per-axis collision of vanilla (TASK-20261125-076): Shapes.collide with its 1e-7 tolerance, Entity.collideWithShapes' axis order (Y first,
// then the larger of X / Z last), and the cells BlockCollisions visits. A box is a plain array [minX, minY, minZ, maxX, maxY, maxZ].
const EPS = 1e-7;

const box = (x0, y0, z0, x1, y1, z1) => [x0, y0, z0, x1, y1, z1];
const move = (b, dx, dy, dz) => [b[0] + dx, b[1] + dy, b[2] + dz, b[3] + dx, b[4] + dy, b[5] + dz];
/** AABB.expandTowards: grow the box toward the movement. */
const expandTowards = (b, dx, dy, dz) => [dx < 0 ? b[0] + dx : b[0], dy < 0 ? b[1] + dy : b[1], dz < 0 ? b[2] + dz : b[2], dx > 0 ? b[3] + dx : b[3], dy > 0 ? b[4] + dy : b[4], dz > 0 ? b[5] + dz : b[5]];
const deflate = (b, d) => [b[0] + d, b[1] + d, b[2] + d, b[3] - d, b[4] - d, b[5] - d];
/** AABB.intersects: strict overlap on all three axes. */
const intersects = (a, b) => a[0] < b[3] && a[3] > b[0] && a[1] < b[4] && a[4] > b[1] && a[2] < b[5] && a[5] > b[2];

/**
 * Shapes.collide on one axis (0 x, 1 y, 2 z) of the moving box `b` against `shapes` (boxes in world coordinates): the largest part of `d` the box can travel.
 * Overlap on the other axes and the "in front of the box" test use the game's 1e-7 tolerance (VoxelShape.collideX with findIndex(min + 1e-7) / (max - 1e-7)).
 */
function collideAxis(axis, b, shapes, d) {
    const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
    for (const s of shapes) {
        if (Math.abs(d) < EPS) return 0;                  // checked before each shape, as Shapes.collide does
        if (!(b[o1] + EPS < s[o1 + 3] && b[o1 + 3] - EPS >= s[o1] && b[o2] + EPS < s[o2 + 3] && b[o2 + 3] - EPS >= s[o2])) continue;
        if (d > 0) {
            if (s[axis] > b[axis + 3] - EPS) { const g = s[axis] - b[axis + 3]; if (g >= -EPS && g < d) d = g; }
        } else if (s[axis + 3] <= b[axis] + EPS) {
            const g = s[axis + 3] - b[axis]; if (g <= EPS && g > d) d = g;
        }
    }
    return d;
}

/** Entity.collideWithShapes: Y, then (|x| < |z|: Z then X, else X then Z). Returns [dx, dy, dz]. */
function collideWithShapes(v, b, shapes) {
    if (!shapes.length) return [v[0], v[1], v[2]];
    let [dx, dy, dz] = v;
    if (dy !== 0) { dy = collideAxis(1, b, shapes, dy); if (dy !== 0) b = move(b, 0, dy, 0); }
    const zFirst = Math.abs(dx) < Math.abs(dz);
    if (zFirst && dz !== 0) { dz = collideAxis(2, b, shapes, dz); if (dz !== 0) b = move(b, 0, 0, dz); }
    if (dx !== 0) { dx = collideAxis(0, b, shapes, dx); if (!zFirst && dx !== 0) b = move(b, dx, 0, 0); }
    if (!zFirst && dz !== 0) dz = collideAxis(2, b, shapes, dz);
    return [dx, dy, dz];
}

/**
 * The block collision boxes BlockCollisions yields for the query box `q`: cells from floor(min - 1e-7) - 1 to floor(max + 1e-7) + 1; a cell on one outer face
 * only for a shape taller or wider than its cell (fences, walls: hasLargeCollisionShape), edges and corners never; a shape only when it overlaps `q`.
 * `shapesAt(x, y, z)` gives the collision boxes of a cell in cell coordinates ([] for none, null for an unloaded cell).
 */
function blockBoxes(q, shapesAt) {
    const out = [];
    const x0 = Math.floor(q[0] - EPS) - 1, x1 = Math.floor(q[3] + EPS) + 1;
    const y0 = Math.floor(q[1] - EPS) - 1, y1 = Math.floor(q[4] + EPS) + 1;
    const z0 = Math.floor(q[2] - EPS) - 1, z1 = Math.floor(q[5] + EPS) + 1;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
        const edge = (x === x0 || x === x1 ? 1 : 0) + (y === y0 || y === y1 ? 1 : 0) + (z === z0 || z === z1 ? 1 : 0);
        if (edge >= 2) continue;
        const sh = shapesAt(x, y, z);
        if (!sh || !sh.length) continue;
        if (edge === 1 && !sh.some((s) => s[0] < 0 || s[1] < 0 || s[2] < 0 || s[3] > 1 || s[4] > 1 || s[5] > 1)) continue;
        for (const s of sh) {
            const w = [s[0] + x, s[1] + y, s[2] + z, s[3] + x, s[4] + y, s[5] + z];
            if (intersects(w, q)) out.push(w);
        }
    }
    return out;
}

module.exports = { EPS, box, move, expandTowards, deflate, intersects, collideAxis, collideWithShapes, blockBoxes };

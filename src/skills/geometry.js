'use strict';
// Pure geometry of the player's view: look angles, view rays, ray casts through block shapes, aim points.
// Conventions are Mineflayer's (radians; yaw 0 looks to -z, yaw grows counter-clockwise seen from above; pitch > 0 looks up).
// Nothing here touches a bot: blocks come from a `shapesAt(x, y, z)` accessor returning the collision/outline boxes of the
// block in that cell as [[x0,y0,z0,x1,y1,z1], ...] relative to the cell (empty array = nothing to hit).

const EYE = 1.62;            // standing eye height (vanilla 1.20.1)
const BLOCK_REACH = 4.5;     // vanilla survival client reach for blocks
const ENTITY_REACH = 3.0;    // vanilla survival client reach for entities
// Face numbering of the protocol: 0 down, 1 up, 2 north (-z), 3 south (+z), 4 west (-x), 5 east (+x).
const FACES = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

/** Yaw and pitch that look from `eye` at `p` (both {x,y,z}). */
function lookAngles(eye, p) {
    const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Unit view direction of yaw/pitch. */
function viewDir(yaw, pitch) {
    const c = Math.cos(pitch);
    return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

/** Smallest signed difference a - b of two angles, in (-PI, PI]. */
function angleDiff(a, b) {
    let d = (a - b) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d <= -Math.PI) d += 2 * Math.PI;
    return d;
}

/** Slab test of a ray against an axis-aligned box [x0,y0,z0,x1,y1,z1]. Returns {t, face} of the entry point, or null. */
function rayBox(o, d, b) {
    let tmin = -Infinity, tmax = Infinity, face = -1;
    const axes = [['x', 0, 4, 5], ['y', 1, 0, 1], ['z', 2, 2, 3]];
    for (const [k, i, negFace, posFace] of axes) {
        const lo = b[i], hi = b[i + 3];
        if (Math.abs(d[k]) < 1e-12) {
            if (o[k] < lo || o[k] > hi) return null;
            continue;
        }
        let t1 = (lo - o[k]) / d[k], t2 = (hi - o[k]) / d[k];
        // Entering through the low plane means the ray travels +k, i.e. it hits the face whose normal is -k.
        let f = d[k] > 0 ? negFace : posFace;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tmin) { tmin = t1; face = f; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    return { t: Math.max(tmin, 0), face };
}

/**
 * First block shape hit by the ray from `o` along unit `d` within `maxDist` (voxel walk, Amanatides & Woo).
 * Returns {x, y, z, face, t, point} or null. Cells whose shapes the ray misses are passed through (grass, open doors).
 */
function raycast(o, d, maxDist, shapesAt) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const step = { x: Math.sign(d.x), y: Math.sign(d.y), z: Math.sign(d.z) };
    const next = (c, k) => (step[k] > 0 ? c + 1 - o[k] : o[k] - c) / Math.abs(d[k] || 1e-12);
    const tMax = { x: d.x ? next(x, 'x') : Infinity, y: d.y ? next(y, 'y') : Infinity, z: d.z ? next(z, 'z') : Infinity };
    const tDelta = { x: d.x ? 1 / Math.abs(d.x) : Infinity, y: d.y ? 1 / Math.abs(d.y) : Infinity, z: d.z ? 1 / Math.abs(d.z) : Infinity };
    for (let i = 0; i < 64; i++) {
        let best = null;
        for (const s of shapesAt(x, y, z) || []) {
            const h = rayBox(o, d, [x + s[0], y + s[1], z + s[2], x + s[3], y + s[4], z + s[5]]);
            if (h && (!best || h.t < best.t)) best = h;
        }
        if (best && best.t <= maxDist) {
            return { x, y, z, face: best.face, t: best.t, point: { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t } };
        }
        const k = tMax.x < tMax.y ? (tMax.x < tMax.z ? 'x' : 'z') : (tMax.y < tMax.z ? 'y' : 'z');
        if (tMax[k] > maxDist) return null;
        if (k === 'x') x += step.x; else if (k === 'y') y += step.y; else z += step.z;
        tMax[k] += tDelta[k];
    }
    return null;
}

/**
 * Aim points on the block at `cell` that the eye can see within `reach`: face centres first, then inner points of
 * each visible face, nearest first. Each entry is {point, face, dist}; the ray to `point` hits this block first.
 * `face` (optional) restricts to one protocol face.
 */
function aimPoints(eye, cell, shapesAt, { reach = BLOCK_REACH, face = null, limit = 4 } = {}) {
    const out = [];
    const shapes = shapesAt(cell.x, cell.y, cell.z) || [];
    for (const s of shapes) {
        const box = [cell.x + s[0], cell.y + s[1], cell.z + s[2], cell.x + s[3], cell.y + s[4], cell.z + s[5]];
        for (let f = 0; f < 6; f++) {
            if (face !== null && f !== face) continue;
            const [nx, ny, nz] = FACES[f];
            const axis = nx ? 0 : ny ? 1 : 2;
            const plane = (nx || ny || nz) > 0 ? box[axis + 3] : box[axis];
            const eyeAxis = [eye.x, eye.y, eye.z][axis];
            if ((nx || ny || nz) > 0 ? eyeAxis <= plane : eyeAxis >= plane) continue;   // face turned away from the eye
            const [a1, a2] = [0, 1, 2].filter((a) => a !== axis);
            for (const [u, v] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
                const p = [0, 0, 0];
                p[axis] = plane;
                p[a1] = box[a1] + (box[a1 + 3] - box[a1]) * u;
                p[a2] = box[a2] + (box[a2 + 3] - box[a2]) * v;
                const point = { x: p[0], y: p[1], z: p[2] };
                const dist = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
                if (dist > reach) continue;
                const d = { x: (point.x - eye.x) / dist, y: (point.y - eye.y) / dist, z: (point.z - eye.z) / dist };
                const hit = raycast(eye, d, dist + 0.01, shapesAt);
                if (hit && hit.x === cell.x && hit.y === cell.y && hit.z === cell.z) out.push({ point, face: hit.face, dist });
            }
        }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, limit);
}

/** Distance from `p` to the nearest point of box [x0,y0,z0,x1,y1,z1]. */
function distToBox(p, b) {
    const dx = Math.max(b[0] - p.x, 0, p.x - b[3]), dy = Math.max(b[1] - p.y, 0, p.y - b[4]), dz = Math.max(b[2] - p.z, 0, p.z - b[5]);
    return Math.hypot(dx, dy, dz);
}

/** The bounding box of an entity standing at `pos` with width w and height h. */
const entityBox = (pos, w, h) => [pos.x - w / 2, pos.y, pos.z - w / 2, pos.x + w / 2, pos.y + h, pos.z + w / 2];

module.exports = { EYE, BLOCK_REACH, ENTITY_REACH, FACES, lookAngles, viewDir, angleDiff, rayBox, raycast, aimPoints, distToBox, entityBox };

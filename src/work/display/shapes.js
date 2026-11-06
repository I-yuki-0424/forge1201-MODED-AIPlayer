'use strict';
// Shapes for the in-game display (display/overlay.js): points on lines, outlines and posts, and the particle command for a point.
// Pure functions, no game access. A point is {x, y, z, c} with c an index into PALETTE (the colour) and an optional size `s`.

/** Dust colours (r g b, 0..1): distinct on grass, stone and in the dark. A bot or a lane takes colour `i % PALETTE.length`. */
const PALETTE = Object.freeze([
    [1, 0.25, 0.25], [0.25, 0.6, 1], [0.3, 1, 0.35], [1, 0.85, 0.2], [0.85, 0.4, 1], [0.2, 1, 0.9], [1, 0.55, 0.15], [1, 1, 1],
]);

const DUST_SIZE = 3;
const round2 = (v) => Math.round(v * 100) / 100;

/** Points along a segment a -> b (both [x, y, z] or {x, y, z}), `spacing` blocks apart, both ends included. */
function segment(a, b, spacing, c, s) {
    const A = vec(a), B = vec(b), len = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z), n = Math.max(1, Math.ceil(len / Math.max(0.25, spacing)));
    const out = [];
    for (let i = 0; i <= n; i++) { const t = i / n; out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: A.z + (B.z - A.z) * t, c, s }); }
    return out;
}
const vec = (p) => (Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p);

/** The outline of the X-Z rectangle of a block box {x0, x1, z0, z1} at height y (the block edges: x1 + 1 is the far face). */
function rectOutline(box, y, spacing, c, s) {
    const x0 = box.x0, x1 = box.x1 + 1, z0 = box.z0, z1 = box.z1 + 1;
    return [...segment([x0, y, z0], [x1, y, z0], spacing, c, s), ...segment([x1, y, z0], [x1, y, z1], spacing, c, s), ...segment([x1, y, z1], [x0, y, z1], spacing, c, s), ...segment([x0, y, z1], [x0, y, z0], spacing, c, s)];
}

/** Four corner posts of a box between heights y0 and y1. */
function corners(box, y0, y1, spacing, c, s) {
    const out = [];
    for (const x of [box.x0, box.x1 + 1]) for (const z of [box.z0, box.z1 + 1]) out.push(...segment([x, y0, z], [x, y1, z], spacing, c, s));
    return out;
}

/**
 * Keep at most `n` of the points, evenly spread (a thinned line is still a line; a cut-off line is not). Order is kept.
 */
function thin(points, n) {
    if (points.length <= n) return points;
    const out = [], step = points.length / n;
    for (let i = 0; i < n; i++) out.push(points[Math.floor(i * step)]);
    return out;
}

/**
 * `particle` command for a point, seen by the players the selector `viewers` matches. `force`: visible from far away. A plain point is
 * three dust particles of size 3 (the largest that stays crisp; size 1 was too faint to see), a point with `k: 'rod'` is a few end rods:
 * white, glowing, they last longer; used for marks (a destination, the top of a tag column).
 */
function dustCommand(p, viewers) {
    if (p.k === 'rod') return `particle minecraft:end_rod ${round2(p.x)} ${round2(p.y)} ${round2(p.z)} 0.08 0.2 0.08 0.01 3 force ${viewers}`;
    const [r, g, b] = PALETTE[((p.c % PALETTE.length) + PALETTE.length) % PALETTE.length];
    return `particle minecraft:dust ${r} ${g} ${b} ${p.s || DUST_SIZE} ${round2(p.x)} ${round2(p.y)} ${round2(p.z)} 0.05 0.05 0.05 0 3 force ${viewers}`;
}

module.exports = { PALETTE, segment, rectOutline, corners, thin, dustCommand };

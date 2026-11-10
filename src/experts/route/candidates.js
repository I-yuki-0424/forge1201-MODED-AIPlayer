'use strict';
// Chunk-exit routing, part 1: where can the bot go next? (owner 2026-11-10: "for a movement target, RL decides for each chunk at which point to leave it and enter the next one,
// the path calculator makes the route in between; in the destination chunk RL makes waypoints, one per 3 blocks of the straight-line distance to the arrival point").
// Pure: the world is the interface of src/skills/world.js (`kindAt`), the path calculator is src/skills/planner.js. The same code builds the candidates in the bots and in the
// training simulator (tools/route/sim.js), so what the policy saw in training is what it sees live.
const { standable } = require('../../skills/world');
const { reachableAsync } = require('../../skills/planner');

const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const chunkOf = (v) => Math.floor(v / 16);
const ckey = (cx, cz) => `${cx},${cz}`;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WP_EVERY = 3;                 // one waypoint per this many blocks of the straight-line distance (rounded down)
const WP_RADIUS = 2;                // waypoint candidates: columns within this many blocks of the ideal point
const PER_COLUMN = 2;               // standable cells kept per border column (caves and ledges: the ones nearest the bot's level)
const MAX_K = 48;                   // candidates per decision

/** The next chunk on the straight line between two chunks: {x, z} in {-1, 0, 1}. */
function chunkStep(c0, c1) {
    const dx = c1.x - c0.x, dz = c1.z - c0.z, n = Math.max(Math.abs(dx), Math.abs(dz));
    if (!n) return { x: 0, z: 0 };
    return { x: sgn(dx) * Math.round(Math.abs(dx) / n), z: sgn(dz) * Math.round(Math.abs(dz) / n) };
}

/** Standable cells of the column x,z between y0 and y1 (top first). */
function stands(w, x, z, y0, y1, out = []) {
    for (let y = y1; y >= y0; y--) if (standable(w, x, y, z)) out.push(y);
    return out;
}

/** Number of waypoints for a straight-line distance d to the arrival point: one per 3 blocks, rounded down. */
const waypointCount = (d) => Math.floor(d / WP_EVERY);

/**
 * The entry cells of the neighbouring chunks: the first row of the chunk beyond each side, 16 columns each, the standable cells nearest the bot's level.
 * Sides are sorted by the dot product with the chunk step: forward (> 0), lateral (0), back (< 0, only when `back`). Rows: [{x, y, z, side: 'fwd'|'lat'|'back', diag}].
 */
function exitCandidates(w, here, to, { back = false, ty = null } = {}) {
    const c0 = { x: chunkOf(here.x), z: chunkOf(here.z) }, step = chunkStep(c0, { x: chunkOf(to.x), z: chunkOf(to.z) }), out = [];
    const yTop = Math.min(318, Math.max(here.y, ty === null ? here.y : ty) + 6), yBot = Math.max(-63, Math.min(here.y, ty === null ? here.y : ty) - 6);
    for (const [sx, sz] of SIDES) {
        const dot = sx * step.x + sz * step.z, side = dot > 0 ? 'fwd' : dot === 0 ? 'lat' : 'back';
        if (side === 'back' && !back) continue;
        const ex = sx > 0 ? 16 * (c0.x + 1) : 16 * c0.x - 1, ez = sz > 0 ? 16 * (c0.z + 1) : 16 * c0.z - 1;
        for (let i = 0; i < 16; i++) {
            const x = sx ? ex : 16 * c0.x + i, z = sz ? ez : 16 * c0.z + i;
            const ys = stands(w, x, z, yBot, yTop).sort((a, b) => Math.abs(a - here.y) - Math.abs(b - here.y)).slice(0, PER_COLUMN);
            for (const y of ys) out.push({ x, y, z, side, dir: [sx, sz], diag: 0 });
        }
    }
    if (step.x && step.z) {                                                             // the corner cell of the diagonal chunk
        const x = step.x > 0 ? 16 * (c0.x + 1) : 16 * c0.x - 1, z = step.z > 0 ? 16 * (c0.z + 1) : 16 * c0.z - 1;
        for (const y of stands(w, x, z, yBot, yTop).sort((a, b) => Math.abs(a - here.y) - Math.abs(b - here.y)).slice(0, PER_COLUMN)) out.push({ x, y, z, side: 'fwd', dir: [step.x, step.z], diag: 1 });
    }
    return out;
}

/**
 * The waypoint candidates inside the destination chunk: cells within WP_RADIUS blocks of the ideal point, which lies `frac` of the way from here to the arrival point (the last
 * waypoint is the arrival point itself). Rows: [{x, y, z, side: 'wp', off}] with `off` the distance from the ideal point.
 */
function waypointCandidates(w, here, to, frac, { ty = null } = {}) {
    const px = here.x + (to.x - here.x) * frac, pz = here.z + (to.z - here.z) * frac, py = ty === null ? here.y : Math.round(here.y + (ty - here.y) * frac);
    const ux = to.x - here.x, uz = to.z - here.z, n = Math.hypot(ux, uz) || 1, dir = [Math.abs(ux) >= Math.abs(uz) ? sgn(ux) : 0, Math.abs(ux) >= Math.abs(uz) ? 0 : sgn(uz)], out = [];
    for (let dx = -WP_RADIUS; dx <= WP_RADIUS; dx++) for (let dz = -WP_RADIUS; dz <= WP_RADIUS; dz++) {
        const x = Math.round(px) + dx, z = Math.round(pz) + dz;
        const ys = stands(w, x, z, py - 4, py + 4).sort((a, b) => Math.abs(a - py) - Math.abs(b - py)).slice(0, 1);
        for (const y of ys) out.push({ x, y, z, side: 'wp', dir, diag: 0, off: Math.hypot(x - px, z - pz) });
    }
    void n;
    return out;
}

/** What lies ahead of a cell in direction `dir`: the share of the 3 x 5 patch beyond it that can be stood on at about its level (open), is water, is walled in, and its mean rise. */
function ahead(w, c, dir) {
    const [dx, dz] = dir[0] || dir[1] ? dir : [1, 0], px = -dz, pz = dx;
    let open = 0, water = 0, wall = 0, rise = 0, n = 0;
    for (let a = 1; a <= 5; a++) for (let s = -1; s <= 1; s++) {
        const x = c.x + dx * a + px * s, z = c.z + dz * a + pz * s;
        n++;
        let found = null;
        for (let y = c.y + 3; y >= c.y - 3; y--) if (standable(w, x, y, z)) { found = y; break; }
        if (found !== null) { open++; rise += found - c.y; continue; }
        const k = w.kindAt(x, c.y, z), kb = w.kindAt(x, c.y - 1, z);
        if (k === 'water' || kb === 'water') water++; else if (k === 'solid' || w.kindAt(x, c.y + 1, z) === 'solid') wall++;
    }
    return { open: open / n, water: water / n, wall: wall / n, rise: open ? rise / open / 3 : 0 };
}

/** The Dijkstra reach of the path calculator around the bot: a Map 'x,y,z' -> cost, and whether the search ran to the end (not cut by its node budget). */
async function reachMap(w, here, { maxNodes = 2500, radius = 32 } = {}) {
    const r = await reachableAsync(w, here, { maxNodes, radius }), m = new Map();       // sliced: 2,500 cells in one go froze the other bots for tens of milliseconds
    for (const [x, y, z, c] of r.cells) m.set(`${x},${y},${z}`, c);
    return { cost: m, complete: r.cells.length < maxNodes, nodes: r.cells.length, radius, path: r.path };
}


/**
 * Frontier cells: the cells of the path calculator's own reach that gain most toward the arrival point (3-D when the level is known), at least 4 blocks apart. They are reached by
 * construction, so they are what lets the policy take a haul road or a ledge that lies inside the reach but not on a chunk border. Rows: [{x, y, z, side: 'reach'}].
 */
function frontierCandidates(reach, here, to, ty, k = 8) {
    const d3 = (c) => Math.hypot(c.x - to.x, c.z - to.z, ty === null ? 0 : c.y - ty), d0 = d3(here), best = [];
    for (const key of reach.cost.keys()) {
        const [x, y, z] = key.split(',').map(Number), c = { x, y, z }, g = d0 - d3(c);
        if (g <= 1) continue;
        best.push({ ...c, g });
    }
    best.sort((a, b) => b.g - a.g || a.x - b.x || a.z - b.z || a.y - b.y);
    const out = [];
    for (const c of best) {
        if (out.length >= k) break;
        if (out.some((o) => Math.max(Math.abs(o.x - c.x), Math.abs(o.z - c.z)) < 4 && Math.abs(o.y - c.y) <= 2)) continue;
        const dx = to.x - c.x, dz = to.z - c.z;
        out.push({ x: c.x, y: c.y, z: c.z, side: 'reach', dir: Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)], diag: 0 });
    }
    return out;
}

module.exports = { frontierCandidates, stands, chunkStep, exitCandidates, waypointCandidates, waypointCount, ahead, reachMap, chunkOf, ckey, hd, MAX_K, WP_EVERY };

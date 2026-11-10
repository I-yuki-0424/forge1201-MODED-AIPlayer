'use strict';
// RL-MOVE-v3, the rules: what each action does to a cell world and when it is allowed. A line-for-line port of rl3/sim.py (the simulator the policy was trained on), over a `view`:
//   view.code(x, y, z) -> a cell code (spec.CODE)      view.inBox(x, y, z) -> natural blocks may be dug here (the pit)      view.bots: [{x, y, z}] other bots' feet cells
// The golden file tests/golden_move3.json (written by `python -m rl3.cli golden`) holds states, the simulator's observation and mask; tests/test_move3_pure.js compares this code with it.
const { CODE: C, DIRS, A, NA, PACK_CAP, MAX_HP } = require('./spec');

const passable = (c) => c === C.AIR;
const solid = (c) => c === C.SOLID || c === C.OWN || c === C.OTHER || c === C.ROCK;
const standable = (v, x, y, z) => passable(v.code(x, y, z)) && passable(v.code(x, y + 1, z)) && solid(v.code(x, y - 1, z));
const diggable = (v, c, x, y, z) => c === C.OWN || (c === C.SOLID && v.inBox(x, y, z));
const botAt = (bots, x, y, z) => bots.some((b) => b.x === x && b.z === z && (b.y === y || b.y + 1 === y || b.y === y + 1));
const dist3 = (p, t) => Math.sqrt((p.x - t.x) ** 2 + (p.z - t.z) ** 2 + (0.7 * (p.y - t.y)) ** 2);

/** Fall from feet cell (x, y, z): {y: landing feet cell, dead, dmg}; `airAt` is a cell y treated as air (a block just broken). `minY`: the world's floor (no landing above it = dead). */
function fall(v, x, y, z, airAt = null, minY = -64) {
    let land = null, hit = C.AIR;
    for (let yy = y - 1; yy >= minY; yy--) {
        const c = yy === airAt ? C.AIR : v.code(x, yy, z);
        if (c !== C.AIR && c !== C.WATER) { land = yy + 1; hit = c; break; }
    }
    if (land === null || hit === C.LAVA) return { y, dead: true, dmg: 0 };
    const wet = (land === airAt ? C.AIR : v.code(x, land, z)) === C.WATER, dist = y - land;
    return { y: land, dead: false, dmg: wet ? 0 : Math.max(0, dist - 3) };
}

/** The result of every action: [{valid, pos: {x, y, z}, ...effect}] (NA entries). `s`: {pos, tgt, pack, hp}. */
function results(v, s, o = {}) {
    const { x, y, z } = s.pos, out = new Array(NA), bots = v.bots || [], minY = o.minY === undefined ? -64 : o.minY;
    const here = standable(v, x, y, z), P = { x, y, z };
    const walk = (d) => {
        const [dx, dz] = DIRS[d], nx = x + dx, nz = z + dz;
        const up = standable(v, nx, y + 1, nz) && passable(v.code(x, y + 2, z));
        const leave = passable(v.code(nx, y, nz)) && passable(v.code(nx, y + 1, nz));
        let land = null, run = true;
        for (let k = 0; k < 4 && land === null; k++) {
            run = run && passable(v.code(nx, y - k, nz));
            if (leave && run && standable(v, nx, y - k, nz)) land = y - k;
        }
        const ny = up ? y + 1 : land;
        const ok = here && (up || land !== null) && !botAt(bots, nx, ny, nz) && v.code(nx, ny, nz) === C.AIR;
        return { valid: !!ok, pos: { x: nx, y: ok ? ny : y, z: nz }, kind: 'move' };
    };
    for (let d = 0; d < 4; d++) out[A.WALK + d] = walk(d);
    for (let d = 0; d < 4; d++) {
        const [dx, dz] = DIRS[d], fx = x + dx, fz = z + dz, c = v.code(fx, y - 1, fz);
        out[A.BRIDGE + d] = { valid: here && (c === C.AIR || c === C.WATER) && passable(v.code(fx, y, fz)) && passable(v.code(fx, y + 1, fz)) && s.pack >= 1 && !botAt(bots, fx, y, fz), pos: { x: fx, y, z: fz }, cell: { x: fx, y: y - 1, z: fz }, kind: 'place' };
    }
    for (let d = 0; d < 4; d++) {
        const [dx, dz] = DIRS[d], nx = x + dx, nz = z + dz, c0 = v.code(nx, y, nz), c1 = v.code(nx, y + 1, nz);
        const d0 = diggable(v, c0, nx, y, nz), d1 = diggable(v, c1, nx, y + 1, nz);
        out[A.DIG + d] = { valid: here && (d0 || d1) && s.pack < PACK_CAP, pos: P, cell: { x: nx, y: d0 ? y : y + 1, z: nz }, kind: 'dig' };
    }
    out[A.PILLAR] = { valid: here && passable(v.code(x, y + 2, z)) && s.pack >= 1, pos: { x, y: y + 1, z }, kind: 'pillar' };
    const under = v.code(x, y - 1, z);
    out[A.DESCEND] = { valid: here && passable(v.code(x, y - 2, z)) && passable(v.code(x, y - 3, z)) && s.pack >= 0 && under !== C.ROCK && under !== C.OTHER, pos: { x, y: y - 1, z }, kind: 'descend' };
    out[A.DIGUP] = { valid: here && diggable(v, v.code(x, y + 2, z), x, y + 2, z) && s.pack < PACK_CAP, pos: P, cell: { x, y: y + 2, z }, kind: 'dig' };
    const f = fall(v, x, y, z, y - 1, minY);
    out[A.DIGDOWN] = { valid: here && diggable(v, under, x, y - 1, z) && s.pack < PACK_CAP && !f.dead && (s.hp === undefined ? MAX_HP : s.hp) - f.dmg >= 5, pos: { x, y: f.y, z }, cell: { x, y: y - 1, z }, kind: 'dig' };
    let best = -1, bx = 0, bz = 0, any = false;
    for (const [dx, dz] of DIRS) {
        const c = v.code(x + dx, y - 1, z + dz), d = Math.hypot(x + dx - s.tgt.x, z + dz - s.tgt.z);
        if (c === C.OWN) { any = true; if (d > best) { best = d; bx = x + dx; bz = z + dz; } }
    }
    out[A.UNLAY] = { valid: here && any && s.pack < PACK_CAP, pos: P, cell: { x: bx, y: y - 1, z: bz }, kind: 'dig' };
    out[A.WAIT] = { valid: true, pos: P, kind: 'wait' };
    // sidestep: one step away from the nearest other bot
    let near = 99, nb = null;
    for (const b of bots) { const d = Math.hypot(b.x - x, b.z - z); if (d < near) { near = d; nb = b; } }
    let sbest = -1, sp = P, sok = false;
    if (nb) for (let d = 0; d < 4; d++) {
        const r = out[A.WALK + d], dd = Math.hypot(r.pos.x - nb.x, r.pos.z - nb.z);
        if (r.valid && dd > sbest && dd > near) { sbest = dd; sp = r.pos; sok = true; }
    }
    out[A.SIDESTEP] = { valid: sok && near < 3, pos: sp, kind: 'move' };
    return out;
}

const mask = (v, s, o) => results(v, s, o).map((r) => r.valid);
const arrived = (p, t, near, nearY) => Math.hypot(p.x - t.x, p.z - t.z) <= near && Math.abs(p.y - t.y) <= nearY;

module.exports = { passable, solid, standable, diggable, botAt, dist3, fall, results, mask, arrived };

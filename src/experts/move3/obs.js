'use strict';
// RL-MOVE-v3, the observation: a line-for-line port of rl3/obs.py (observe). Float32Array of spec.OBS_DIM.
const { CODE: C, PR, PATCH, NCH, RAY_DIRS, RAY_LEN, NVEC, HORIZON, MAX_HP, NA, OBS_PATCH, OBS_VIS, OBS_DIM } = require('./spec');
const R = require('./rules');

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * v: view (rules.js); s: {pos, tgt, near, nearY, pack, hp, t, since, last, visits: Map 'x,z' -> count}. Returns a Float32Array (a new one unless `out` is given).
 */
function observe(v, s, out = new Float32Array(OBS_DIM)) {
    out.fill(0);
    const { x, y, z } = s.pos, bots = v.bots || [];
    const [PX, PY, PZ] = PATCH;
    for (let i = 0; i < PX; i++) for (let j = 0; j < PY; j++) for (let k = 0; k < PZ; k++) {
        const gx = x - PR[0] + i, gy = y - PR[1] + j, gz = z - PR[2] + k, c = v.code(gx, gy, gz), cell = (i * PY + j) * PZ + k;
        if (R.solid(c)) out[0 * PX * PY * PZ + cell] = 1;
        if (R.diggable(v, c, gx, gy, gz)) out[1 * PX * PY * PZ + cell] = 1;
        if (c === C.WATER) out[2 * PX * PY * PZ + cell] = 1;
        if (c === C.LAVA) out[3 * PX * PY * PZ + cell] = 1;
        if (c === C.OTHER || bots.some((b) => b.x === gx && b.z === gz && (gy === b.y || gy === b.y + 1))) out[4 * PX * PY * PZ + cell] = 1;
    }
    for (let i = 0; i < PX; i++) for (let k = 0; k < PZ; k++) out[OBS_PATCH + i * PZ + k] = Math.min(s.visits.get(`${x - PR[0] + i},${z - PR[2] + k}`) || 0, 4) / 4;
    const o = OBS_PATCH + OBS_VIS, d = [s.tgt.x - x, s.tgt.y - y, s.tgt.z - z], dh = Math.hypot(d[0], d[2]), d3 = R.dist3(s.pos, s.tgt), floor = v.code(x, y - 1, z);
    const vec = [clip(d[0] / 32, -1.5, 1.5), clip(d[1] / 32, -1.5, 1.5), clip(d[2] / 32, -1.5, 1.5), clip(dh / 48, 0, 1.5), clip(d3 / 48, 0, 1.5), dh > 1e-6 ? d[0] / dh : 0, dh > 1e-6 ? d[2] / dh : 0,
        clip(s.pack / 32, 0, 2), (s.hp === undefined ? MAX_HP : s.hp) / MAX_HP, clip(s.since / 50, 0, 2), s.t / HORIZON, s.near / 3, s.nearY / 4,
        v.inBox(x, y, z) ? 1 : 0, floor === C.OWN ? 1 : 0, floor === C.OTHER ? 1 : 0, R.standable(v, x, y, z) ? 1 : 0];
    for (let i = 0; i < vec.length; i++) out[o + i] = vec[i];
    out[o + vec.length + clip(s.last, 0, NA - 1)] = 1;
    let p = o + vec.length + NA;
    for (const [dx, dz] of RAY_DIRS) {
        let run = 0, alive = true;
        for (let k = 1; k <= RAY_LEN; k++) { alive = alive && R.standable(v, x + k * dx, y, z + k * dz); if (alive) run++; }
        out[p++] = run / RAY_LEN;
    }
    const near = bots.map((b) => ({ dx: b.x - x, dz: b.z - z, d: Math.hypot(b.x - x, b.z - z) })).sort((a, b) => a.d - b.d).slice(0, 2);
    for (let i = 0; i < 2; i++) { const b = near[i]; out[p++] = b ? clip(b.dx / 8, -1, 1) : 0; out[p++] = b ? clip(b.dz / 8, -1, 1) : 0; }
    if (p - o !== NVEC) throw new Error(`move3 obs: vector of ${p - o}, spec says ${NVEC}`);
    return out;
}

module.exports = { observe };

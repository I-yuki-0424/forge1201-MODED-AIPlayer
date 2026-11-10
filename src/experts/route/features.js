'use strict';
// Chunk-exit routing, part 2: the numbers the policy sees. A candidate row (DK) and one context vector (DC), both built from the loaded world only (no oracle: the
// reach of the path calculator is what the bot itself can compute). Layout is the contract with models/experts/route.json (`dk`, `dc`).
const { ahead, hd, chunkOf, ckey, MAX_K } = require('./candidates');

const DK = 21, DC = 9;
const FEATURES = ['prog', 'rem', 'lat', 'dyc', 'dyt', 'dyt_gain', 'reached', 'cost', 'in_range', 'open', 'water', 'wall', 'slope', 'visits', 'tabu', 'back', 'lateral', 'diag_or_off', 'cont', 'frontier', 'lat_blocked'];
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * state: { here, to, ty (arrival level or null), cands, reach ({cost: Map, complete, radius}), mem ({visits: Map, failed: [cell], prev: 'cx,cz' | null}), legs, stalls, failsLeg, wp (true in the destination chunk) }.
 * Returns { cands (at most MAX_K, the order of the rows), feat: Float64Array(K * DK), ctx: Float64Array(DC) }.
 */
function build(st) {
    const { here, to, ty, reach, mem } = st, d0 = hd(here, to), ux = (to.x - here.x) / (d0 || 1), uz = (to.z - here.z) / (d0 || 1);
    const rch = (c) => reach.cost.get(`${c.x},${c.y},${c.z}`);
    let cands = st.cands.map((c) => ({ ...c, rc: rch(c) }));
    // The way ahead is blocked when most of the cells across the border toward the target cannot be walked to (a wall, a ravine, a pit wall): the sides and the frontier are what is left.
    const fwd = cands.filter((c) => c.side === 'fwd'), blocked = st.wp || !fwd.length ? (st.wp ? 0 : 1) : 1 - fwd.filter((c) => c.rc !== undefined).length / fwd.length;
    const pm = mem.move, pmn = pm ? Math.hypot(pm.x, pm.z) : 0;
    if (cands.length > MAX_K) {                                           // keep the ones the path calculator can reach, then the ones that gain most
        cands.sort((a, b) => ((b.rc !== undefined) - (a.rc !== undefined)) || (d0 - hd(b, to)) - (d0 - hd(a, to)) || a.x - b.x || a.z - b.z || a.y - b.y);
        cands = cands.slice(0, MAX_K);
    }
    const K = cands.length, feat = new Float64Array(K * DK);
    cands.forEach((c, k) => {
        const o = k * DK, d1 = hd(c, to), a = ahead(st.w, c, c.dir);
        const lat = (c.x - here.x) * -uz + (c.z - here.z) * ux;
        const tabu = mem.failed.some((f) => Math.abs(f.x - c.x) <= 2 && Math.abs(f.z - c.z) <= 2 && Math.abs(f.y - c.y) <= 3) ? 1 : 0;
        const key = ckey(chunkOf(c.x), chunkOf(c.z));
        feat[o + 0] = clip((d0 - d1) / 16, -1.5, 1.5);
        feat[o + 1] = clip(d1 / 256, 0, 1);
        feat[o + 2] = clip(lat / 16, -2, 2);
        feat[o + 3] = clip((c.y - here.y) / 32, -2, 2);
        feat[o + 4] = ty === null ? 0 : clip(Math.abs(ty - c.y) / 64, 0, 2);
        feat[o + 5] = ty === null ? 0 : clip((Math.abs(ty - here.y) - Math.abs(ty - c.y)) / 16, -2, 2);
        feat[o + 6] = c.rc !== undefined ? 1 : 0;
        feat[o + 7] = c.rc !== undefined ? clip(c.rc / 64, 0, 2) : 0;
        feat[o + 8] = Math.max(Math.abs(c.x - here.x), Math.abs(c.z - here.z)) <= reach.radius ? 1 : 0;
        feat[o + 9] = a.open; feat[o + 10] = a.water; feat[o + 11] = a.wall; feat[o + 12] = a.rise;
        feat[o + 13] = clip((mem.visits.get(key) || 0) / 3, 0, 2);
        feat[o + 14] = tabu;
        feat[o + 15] = c.side === 'back' || key === mem.prev ? 1 : 0;
        feat[o + 16] = c.side === 'lat' ? 1 : 0;
        feat[o + 17] = c.side === 'wp' ? clip(c.off / 4, 0, 1) : c.diag;
        const mx = c.x - here.x, mz = c.z - here.z, mn = Math.hypot(mx, mz);
        feat[o + 18] = pmn > 0.5 && mn > 0.5 ? (mx * pm.x + mz * pm.z) / (mn * pmn) : 0;       // inertia: the same way as the last leg (follows a wall instead of turning back at every chunk)
        feat[o + 19] = c.side === 'reach' ? 1 : 0;
        feat[o + 20] = c.side === 'lat' || c.side === 'reach' ? blocked : 0;
    });
    const ctx = new Float64Array(DC);
    ctx[0] = clip(d0 / 256, 0, 1.5); ctx[1] = ty === null ? 0 : clip(Math.abs(ty - here.y) / 64, 0, 2); ctx[2] = clip(st.stalls / 3, 0, 2); ctx[3] = clip(st.legs / 20, 0, 2);
    ctx[4] = st.wp ? 1 : 0; ctx[5] = K / MAX_K; ctx[6] = reach.complete ? 1 : 0; ctx[7] = clip(st.failsLeg / 4, 0, 2); ctx[8] = blocked;
    return { cands, feat, ctx };
}

module.exports = { build, DK, DC, FEATURES };

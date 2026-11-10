'use strict';
// The pit's learned station planner as a unit runner (docs/proposed/PIT-EXPERT-v1.md). A unit of the `expert` method is one BAND (two layers) of a whole chunk. Instead of tiles in a fixed
// order, the expert (src/experts/pit: a scoring network over every column of the chunk the bot could stand on) chooses WHERE TO STAND next and how deep to dig from there; everything
// within the arm's reach is then dug, blind (the server checks only the distance), cell by cell with the usual water rule (pit.js `handle`). It also digs the leftovers of earlier units
// that stand above the band within reach, which is what "mining the blocks that were not dug" means here. The walk to a station is pit.js `goToStation` (lift, bridge, pillar, descend are there).
// Pure apart from `env` (w, here, exec, run ...) and the functions pit.js hands in; the tests drive it with a fake world.
const M = require('../../experts/pit/model');
const P = require('../../experts/pit/policy');
const { SOLID, ROCK, WATER, AIR, N, H } = M;

const MAX_FAILS_ROW = 4;                      // stations in a row that could not be reached or dug: the unit fails with the first reason

/** The chunk as the model sees it: m[x][z][y], y 0 = the lower layer of the band at world level `yb`. Cells the unit must not dig (fixtures, kept road, trees out of reach, bedrock, unloaded) are ROCK. */
function buildModel(c, ox, oz, yb) {
    const { env, plan, region, aerialTree, UNBREAKABLE } = c, w = env.w, meta = region.meta, m = [];
    const bare = (n) => String(n || '').replace(/^minecraft:/, '');
    for (let x = 0; x < N; x++) {
        m.push([]);
        for (let z = 0; z < N; z++) {
            const col = new Int8Array(H), wx = ox + x, wz = oz + z, inside = wx <= meta.x1 && wz <= meta.z1;
            const keep = inside ? plan.road.keep.get(`${wx},${wz}`) : undefined;
            for (let y = 0; y < H; y++) {
                const wy = yb + y;
                if (!inside || wy < meta.bottom) { col[y] = ROCK; continue; }
                const k = w.kindAt(wx, wy, wz);
                if (k === 'air' || k === 'climb') continue;
                if (k === 'water' || k === 'liquid') { col[y] = WATER; continue; }
                if (k === 'solid' || k === 'partial') {
                    const name = bare(w.nameAt && w.nameAt(wx, wy, wz));
                    if (wy > meta.top || UNBREAKABLE.test(name) || (keep !== undefined && wy <= keep) || (plan.accepted && plan.accepted.has(`${wx},${wy},${wz}`)) || aerialTree({ x: wx, y: wy, z: wz })) col[y] = ROCK;
                    else col[y] = SOLID;
                    continue;
                }
                col[y] = ROCK;                                           // danger (lava), unknown (not loaded), anything else: left alone
            }
            m[x].push(col);
        }
    }
    return m;
}

/**
 * @param c  { plan, region, unit, env, r (result counters), cells (the unit's cells), handle (pit.js: one cell with the water rule), open, goToStation(S), sweepDrops, UNBREAKABLE, aerialTree, CELL_FAILS, EXPERT_BAND }
 * @returns { ok, reason?, detail } like runUnit
 */
async function runExpert(c) {
    const { env, region, r, handle, open, CELL_FAILS } = c, meta = region.meta, layer = c.unit, band = c.EXPERT_BAND;
    const ox = meta.x0, oz = meta.z0, yb = meta.top - band * layer - (band - 1);
    const model = P.defaultModel(), stats = { stations: 0, cells: 0, planMs: 0, fails: 0, model: model ? (model.meta && model.meta.name) || 'net' : 'greedy' };
    r.expert = stats;
    const failedCols = new Set(), failures = [];
    let lastN = 0, failsRow = 0, first = null;
    for (let t = 0; t < M.MAX_STATIONS; t++) {
        if (env.cancel && env.cancel.cancelled) return { ok: false, reason: 'cancelled', detail: { ...r } };
        if (env.wrongDim && env.wrongDim()) return { ok: false, reason: 'wrong_dimension', detail: { why: 'the bot is not in the dimension of the job', botSide: true, stage: 'dimension', ...r } };
        const t0 = Date.now(), here = env.here();
        const m = buildModel(c, ox, oz, yb);
        if (!M.bandLeft(m)) break;                                       // nothing left to dig in this band (or above it within the chunk)
        const bot = [Math.max(0, Math.min(N - 1, here.x - ox)), Math.max(0, Math.min(N - 1, here.z - oz))];
        const obs = M.observe({ m, bot, t, lastN });
        const ban = new Set();
        obs.cand.forEach((q, k) => { if (failedCols.has(`${q.x},${q.z}`)) ban.add(k); });
        const k = P.choose(model, obs, ban);
        stats.planMs += Date.now() - t0;
        if (k < 0) {
            const left = M.bandLeft(m);
            return first || { ok: false, reason: 'unreachable', detail: { why: `${left} cells of the band are left and no station can reach them`, stage: 'expert', left, ...r } };
        }
        const q = obs.cand[k], { f } = M.columns(m), S = { x: ox + q.x, y: yb + f[q.x][q.z], z: oz + q.z };
        stats.stations++;
        let g = (here.x === S.x && here.y === S.y && here.z === S.z) ? null : await c.goToStation(S);
        // goToStation answers null both when the bot stands there and when it could not be brought closer ("work from where it is"): the expert needs the exact place.
        if (!g) { const at = env.here(); if (at.x !== S.x || at.y !== S.y || at.z !== S.z) g = { ok: false, reason: 'unreachable', detail: { why: 'could not stand at the station', stage: 'expert_station', cell: S, at, ...r } }; }
        if (g) {                                                        // this place cannot be reached: another one, four in a row end the unit
            first = first || g; stats.fails++;
            for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) failedCols.add(`${q.x + dx},${q.z + dz}`);          // what cannot be reached is usually a whole corner: not its neighbours either
            if (g.reason === 'died' || g.reason === 'disconnected' || g.reason === 'cancelled' || g.reason === 'wrong_dimension' || ++failsRow >= MAX_FAILS_ROW) return g;
            continue;
        }
        failsRow = 0;
        // Dig what is in reach, top layer first, nearest first; a cell that cannot be done does not stop the others (as in a tile): the second failure ends the unit.
        const eye = { x: S.x + 0.5, y: S.y + 1.62, z: S.z + 0.5 };
        const set = M.digSet(m, q.x, q.z, f[q.x][q.z], q.depth).map(([cx, cz, y]) => ({ x: ox + cx, y: yb + y, z: oz + cz }));
        set.sort((a, b) => b.y - a.y || Math.hypot(a.x + 0.5 - eye.x, a.z + 0.5 - eye.z) - Math.hypot(b.x + 0.5 - eye.x, b.z + 0.5 - eye.z));
        let dug = 0;
        for (const cell of set) {
            if (open(cell)) continue;
            const res = await handle(cell, false);
            if (res === 'defer') { r.deferred = (r.deferred || 0) + 1; continue; }
            if (res) {
                if (!CELL_FAILS.has(res.reason) || failures.length >= 1) return failures[0] || res;
                failures.push(res); r.failedCells = failures.length; failedCols.add(`${q.x},${q.z}`); continue;
            }
            dug++;
        }
        lastN = dug; stats.cells += dug;
        if (r.mined && env.items) { const sd = await c.sweepDrops(env, S); r.picked = (r.picked || 0) + (sd.picked || 0); r.seen = (r.seen || 0) + (sd.seen || 0); if (sd.fail) r.pickFail = sd.fail; }
        if (!dug && !set.length) failedCols.add(`${q.x},${q.z}`);       // the model saw cells that the world does not hold: not this place again
    }
    if (failures.length) return { ...failures[0], detail: { ...failures[0].detail, failedCells: failures.length, mined: r.mined } };
    const left = (() => { let n = 0; for (const cell of c.cells) if (!open(cell) && !c.UNBREAKABLE.test(String(env.w.nameAt(cell.x, cell.y, cell.z) || '')) && !c.aerialTree(cell)) n++; return n; })();
    if (left && stats.stations >= M.MAX_STATIONS) return { ok: false, reason: 'timeout', detail: { why: `${left} cells left after ${M.MAX_STATIONS} stations`, stage: 'expert', left, ...r } };
    r.blocksPerStation = stats.stations ? Math.round((stats.cells / stats.stations) * 10) / 10 : 0;
    return { ok: true, reason: null, detail: r };
}

module.exports = { runExpert, buildModel };

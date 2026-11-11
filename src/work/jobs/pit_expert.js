'use strict';
// The pit's learned station planner as a unit runner (docs/implemented/PIT-EXPERT-v1.md). A unit of the `expert` method is one BAND (two layers) of a whole chunk. Instead of tiles in a fixed
// order, the expert (src/experts/pit: a scoring network over every column of the chunk the bot could stand on) chooses WHERE TO STAND next and how deep to dig from there; everything
// within the arm's reach is then dug, blind (the server checks only the distance), cell by cell with the usual water rule (pit.js `handle`). It also digs the leftovers of earlier units
// that stand above the band within reach, which is what "mining the blocks that were not dug" means here. The walk to a station is pit.js `goToStation` (lift, bridge, pillar, descend are there).
// Pure apart from `env` (w, here, exec, run ...) and the functions pit.js hands in; the tests drive it with a fake world.
const M = require('../../experts/pit/model');
const P = require('../../experts/pit/policy');
const { SOLID, ROCK, WATER, AIR, N, H } = M;

const MAX_FAILS_ROW = 6;                      // stations in a row that could not be reached or dug: the unit fails with the first reason

/**
 * The best station by dig count minus a soft distance cost over EVERY column of the chunk that can be stood on (not only those the model's step-by-step walk reaches), or null.
 * `skip(col)` leaves a column out (failed before, no floor). Same station shape as `M.observe`'s candidates: {x, z, depth, n}.
 */
function hopStation(m, bot, skip) {
    const tb = M.table(m, bot); let best = null;
    for (let x = 0; x < M.N; x++) for (let z = 0; z < M.N; z++) {
        if (!tb.ok[x][z] || skip({ x, z })) continue;
        for (let d = 0; d < M.ND; d++) {
            const n = tb.nd[x][z][d] + tb.nw[x][z][d]; if (n <= 0) continue;
            const score = n - 0.15 * Math.hypot(x - bot[0], z - bot[1]);
            if (!best || score > best.score) best = { x, z, depth: d + 1, n, score };
        }
    }
    return best;
}

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
    const { env, plan, region, r, handle, open, CELL_FAILS } = c, meta = region.meta, layer = c.unit, band = c.EXPERT_BAND;
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
        const ban = new Set(), { f: feet } = M.columns(m);
        // A station needs a real block under the feet. The model (and the simulator it was trained on) treats a column with nothing in the band as ground at the band's level, because in a
        // ground pit solid rock lies under the band; over the End's void it does not, and 52 of 60 failed stations on the live pit of 2026-11-11 were cells of air over air that nobody
        // could stand on ("could not stand at the station", then the 7 x 7 ban wiped out every candidate: "no station can reach them").
        const floored = (q) => { const k = env.w.kindAt(ox + q.x, yb + feet[q.x][q.z] - 1, oz + q.z); return k === 'solid' || k === 'partial'; };
        obs.cand.forEach((q, k) => { if (failedCols.has(`${q.x},${q.z}`) || !floored(q)) ban.add(k); });
        let k = P.choose(model, obs, ban), q = k < 0 ? null : obs.cand[k];
        // No station the model can WALK to (its walk steps up one block at most, so a second island across a gap of void is unreachable for it): hop to the best station with a real floor,
        // far ones at a soft cost; goToStation bridges the gap (bot/bridge.js). Only after the walkable ones are used up, and never to a column that already failed.
        if (!q) { q = hopStation(m, bot, (c) => failedCols.has(`${c.x},${c.z}`) || !floored(c)); if (q) stats.hops = (stats.hops || 0) + 1; }
        stats.planMs += Date.now() - t0;
        if (!q) {
            const left = M.bandLeft(m);
            // Over a void the last block of an island is the one the bot stood on (its own support: digging it drops the bot into the void). pit.js already leaves such a block on purpose
            // (`standsOnFloater`); when nothing but such supports is left the unit is done, and says so (skipped / floating), as the tile sweep does.
            if (!first && left) {
                const rest = [];
                for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) for (let y = 0; y < H; y++) if (m[x][z][y] === SOLID) rest.push({ x: ox + x, y: yb + y, z: oz + z });
                const bare = (c) => ![1, 2, 3].some((d) => { const k = env.w.kindAt(c.x, c.y - d, c.z); return k === 'solid' || k === 'partial'; });
                if (rest.length && rest.every(bare) && stats.stations > 0) {
                    for (const c of rest) if (plan.accepted) plan.accepted.add(`${c.x},${c.y},${c.z}`);
                    r.skipped = (r.skipped || 0) + rest.length; r.floating = (r.floating || 0) + rest.length; r.supports = rest.length;
                    break;
                }
            }
            return first || { ok: false, reason: 'unreachable', detail: { why: `${left} cells of the band are left and no station can reach them`, stage: 'expert', left, ...r } };
        }
        const { f } = M.columns(m), S = { x: ox + q.x, y: yb + f[q.x][q.z], z: oz + q.z };
        stats.stations++;
        let g = (here.x === S.x && here.y === S.y && here.z === S.z) ? null : await c.goToStation(S);
        // goToStation answers null both when the bot stands there and when it could not be brought closer ("work from where it is"): the expert needs the exact place.
        if (!g) { const at = env.here(); if (at.x !== S.x || at.y !== S.y || at.z !== S.z) g = { ok: false, reason: 'unreachable', detail: { why: 'could not stand at the station', stage: 'expert_station', cell: S, at, ...r } }; }
        if (g) {                                                        // this place cannot be reached: another one, four in a row end the unit
            first = first || g; stats.fails++;
            for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) failedCols.add(`${q.x + dx},${q.z + dz}`);          // what cannot be reached is usually a whole corner: not its neighbours either
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
            // A water seal or a pick-up can walk the bot away from its station (placing needs a face to stand in front of): back to the station before the next cell, or the cell is out of reach
            // (live 2026-11-11: "too far to dig", 9 blocks). If it cannot get back, this station is over; the next decision starts from where the bot really is.
            { const at = env.here(); if (at.x !== S.x || at.y !== S.y || at.z !== S.z) { await c.goToStation(S); const back = env.here(); if (back.x !== S.x || back.y !== S.y || back.z !== S.z) { r.movedAway = (r.movedAway || 0) + 1; break; } } }
            let res = await handle(cell, false);
            // The seal inside `handle` may itself have walked the bot off (and the mine then fails 'too far'): back to the station, once more.
            if (res && res !== 'defer') { const at2 = env.here(); if (at2.x !== S.x || at2.y !== S.y || at2.z !== S.z) { await c.goToStation(S); const b2 = env.here(); if (b2.x === S.x && b2.y === S.y && b2.z === S.z) res = await handle(cell, false); } }
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

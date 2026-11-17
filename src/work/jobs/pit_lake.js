'use strict';
// Lake fill (owner 2026-11-16, T26 mine_b on a coast/aquifer chunk). A body of water inside the pit cannot be emptied (a lake refills from its own sources; a bucket takes one source and the
// neighbours make another), it can only be REPLACED by blocks, which are then dug like rock. The per-cell water rule (pit.js `seal`) fills the water next to the cell it is about to dig and
// digs the cell: from the shore that reaches four blocks into the lake, and the bot cannot stand on air over water, so what lies further in is never reached (live 2026-11-16: the coast chunk of
// seed 8573729881198107154 held an enclosed lake of 110 cells per layer, ten layers deep; 38 minutes, 1 of 12 units done, `place` hanging for minutes in the router's walks).
//
// This pass is the coffer-dam: the first time the dig meets the water, the whole connected body inside the box (and the one-cell ring around it, where it is plugged for good) is filled
// FIRST, from standing places the bot can really use (the shore, then the top of its own fill), the farthest cell in reach first so that the near blocks do not hide the far faces. The fill
// blocks are plain blocks (not registered temporaries): the dig takes them out like stone, top layer first, and nothing can flow in because every neighbour is solid.
//
// The order is COLUMN-COMPLETE (a cell is placed only when every fluid cell below it in its column is already solid): a block laid over unfilled water hides the water beneath it from every
// ray (placing needs a clear line to a face), and nothing under a finished platform can ever be filled again. The platform therefore grows only over finished columns, and what it reaches is
// bounded by the arm: a column whose bottom cell is farther than REACH from every place the bot can stand is out of reach. A body deeper than about two layers beyond the shore therefore
// comes back as `too_deep` (fast, with the measured depth) instead of being tried for an hour; the caller keeps the per-cell rule for what lies within reach of the rim. (Deep water needs a
// different tool: falling blocks poured into the top cell of a column, or a bot that can breathe under water.)
// Pure given `c` ({env, plan, goToStation, isFluid, sealItem}); the tests drive it with a fake world.
const { standable } = require('../../skills/world');

const NB6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const MAX_CELLS = 4000;          // a body larger than this is filled in part (the per-cell rule goes on with the rest)
const MAX_ROUNDS = 80;           // stations per call
const REACH = 4.0;               // eye to the centre of the target cell
const EYE = 1.62;
const MAX_ROW_FAILS = 5;         // rounds in a row without a placement end the call
const key = (x, y, z) => `${x},${y},${z}`;

/**
 * The connected fluid (6-neighbour) around the `seeds`, inside the pit's box plus a one-cell ring, from the box bottom up to one above its top. Water below the box cannot run up into it.
 * Returns { cells: [{x,y,z}], truncated }.
 */
function component(w, box, seeds, isFluid, max = MAX_CELLS, slab = null) {
    const lo = slab ? Math.max(box.bottom, slab.lo) : box.bottom, hi = slab ? Math.min(box.top + 1, slab.hi) : box.top + 1;          // slab: only these levels (the layered rule: the level to dig and the floor under it)
    const inside = (x, y, z) => x >= box.x0 - 1 && x <= box.x1 + 1 && z >= box.z0 - 1 && z <= box.z1 + 1 && y >= lo && y <= hi;
    const seen = new Set(), out = [], queue = [];
    for (const s of seeds) { const k = key(s.x, s.y, s.z); if (!seen.has(k) && inside(s.x, s.y, s.z) && isFluid(w, s.x, s.y, s.z)) { seen.add(k); queue.push(s); } }
    let truncated = false;
    while (queue.length) {
        const c = queue.shift();
        if (out.length >= max) { truncated = true; break; }
        out.push({ x: c.x, y: c.y, z: c.z });
        for (const [a, b, d] of NB6) {
            const n = { x: c.x + a, y: c.y + b, z: c.z + d }, k = key(n.x, n.y, n.z);
            if (seen.has(k) || !inside(n.x, n.y, n.z) || !isFluid(w, n.x, n.y, n.z)) continue;
            seen.add(k); queue.push(n);
        }
    }
    return { cells: out, truncated };
}

const solidAt = (w, x, y, z) => { const k = w.kindAt(x, y, z); return k === 'solid' || k === 'partial'; };
/** A fluid cell with a solid neighbour: a block can be placed into it (against that neighbour). */
const hasSupport = (w, f) => NB6.some(([a, b, d]) => solidAt(w, f.x + a, f.y + b, f.z + d));

/** Does a straight line from the eye to the centre of `f` cross a solid cell on the way (the cell itself and the eye's own cells excluded)? Coarse march in steps of a quarter block. */
function blocked(w, eye, f) {
    const tx = f.x + 0.5, ty = f.y + 0.5, tz = f.z + 0.5, dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z, len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return false;
    const n = Math.max(1, Math.ceil(len * 4));
    for (let i = 1; i < n; i++) {
        const t = i / n, x = Math.floor(eye.x + dx * t), y = Math.floor(eye.y + dy * t), z = Math.floor(eye.z + dz * t);
        if (x === f.x && y === f.y && z === f.z) break;
        if (solidAt(w, x, y, z)) return true;
    }
    return false;
}
const eyeOf = (S) => ({ x: S.x + 0.5, y: S.y + EYE, z: S.z + 0.5 });
const dist = (eye, f) => Math.hypot(eye.x - (f.x + 0.5), eye.y - (f.y + 0.5), eye.z - (f.z + 0.5));

/** The standing cell (feet) that reaches the most fillable cells, with a soft cost for the walk; null when none reaches any. `skip(key)` leaves cells out. */
function chooseStation(w, fillable, here, skip) {
    const cand = new Map();
    for (const f of fillable) {
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 0; dy <= 5; dy++) {
            const S = { x: f.x + dx, y: f.y + dy, z: f.z + dz }, k = key(S.x, S.y, S.z);
            if (cand.has(k) || skip(k)) continue;
            cand.set(k, standable(w, S.x, S.y, S.z) ? S : null);
        }
    }
    let best = null;
    for (const S of cand.values()) {
        if (!S) continue;
        const eye = eyeOf(S);
        let gain = 0;
        for (const f of fillable) if (dist(eye, f) <= REACH && !(f.x === S.x && f.z === S.z && (f.y === S.y || f.y === S.y + 1)) && !blocked(w, eye, f)) gain++;
        if (!gain) continue;
        const score = gain - 0.12 * Math.hypot(S.x - here.x, S.y - here.y, S.z - here.z);
        if (!best || score > best.score) best = { ...S, gain, score };
    }
    return best;
}

/**
 * Fill the body of fluid around `seeds`. Returns { ok, filled, cells, stations, harvested, truncated, left, reason?, detail? }. ok is true when no fluid of the body is left; a body that cannot be
 * finished (no standing place, no blocks) comes back ok:false with the reason, and the caller goes on with the per-cell rule (nothing is lost: the blocks placed stay useful).
 */
async function fillLake(c, seeds) {
    const { env, plan, isFluid, sealItem } = c, w = env.w, box = plan.box;
    // c.slab {lo, hi}: the layered rule (owner 2026-11-17) fills only the level to dig and the floor under it, however deep the water goes; c.exact: exactly the seeds that are still fluid, no growth
    // (the floor cell under a cell that was just opened). The blocks are registered as temporary blocks of kind `lake` (the next layer digs them, the job's end takes the rest).
    const grow = (cells0) => (c.exact ? cells0.filter((f) => isFluid(w, f.x, f.y, f.z)) : component(w, box, cells0, isFluid, c.max || MAX_CELLS, c.slab).cells);
    const body = c.exact ? { cells: grow(seeds.filter((f) => f.y >= box.bottom && f.y <= box.top + 1)), truncated: false } : component(w, box, seeds, isFluid, c.max || MAX_CELLS, c.slab);
    const stats = { ok: false, cells: body.cells.length, filled: 0, stations: 0, harvested: 0, truncated: body.truncated, left: body.cells.length, placed: [] };
    if (!body.cells.length) return { ...stats, ok: true, left: 0 };
    const bannedStation = new Set(), cellFails = new Map();
    let rowFails = 0, cells = body.cells;
    // column-complete: no unfilled fluid below (a platform over water hides it)
    const lowest = new Map();
    const refreshLowest = () => { lowest.clear(); for (const f of cells) { if (!isFluid(w, f.x, f.y, f.z)) continue; const k = `${f.x},${f.z}`; if (!lowest.has(k) || f.y < lowest.get(k)) lowest.set(k, f.y); } };
    const lowestAt = (f) => lowest.get(`${f.x},${f.z}`);
    const baseOk = (f) => f.y <= lowestAt(f);
    const done = (extra = {}) => ({ ...stats, left: cells.filter((f) => isFluid(w, f.x, f.y, f.z)).length, ...extra });
    for (let round = 0; round < (c.rounds || MAX_ROUNDS); round++) {
        if (env.cancel && env.cancel.cancelled) return done({ reason: 'cancelled' });
        // the body as it is now: what is still fluid, and what the fluid has spread into since
        cells = grow(cells);
        const rem = cells.filter((f) => (cellFails.get(key(f.x, f.y, f.z)) || 0) < 2);
        if (!cells.length) return done({ ok: true });
        refreshLowest();
        const fillable = rem.filter((f) => hasSupport(w, f) && baseOk(f));
        if (!fillable.length) return done({ reason: 'unsupported', detail: { why: 'fluid with no solid neighbour to place against', cells: cells.length } });
        const here = env.here();
        const S = chooseStation(w, fillable, here, (k) => bannedStation.has(k));
        if (!S) { let deep = 0; for (const f of cells) { const lo = lowestAt(f); if (lo !== undefined) deep = Math.max(deep, f.y - lo + 1); } return done({ reason: stats.filled || stats.stations ? 'too_deep' : 'unreachable', detail: { why: 'no standing place reaches the bottom of the remaining water', cells: cells.length, columnDepth: deep } }); }
        stats.stations++;
        if (S.x !== here.x || S.y !== here.y || S.z !== here.z) {
            const g = await c.goToStation({ x: S.x, y: S.y, z: S.z });
            const at = env.here();
            if (g || at.x !== S.x || at.y !== S.y || at.z !== S.z) { bannedStation.add(key(S.x, S.y, S.z)); if (++rowFails >= MAX_ROW_FAILS) return done({ reason: (g && g.reason) || 'unreachable', detail: { why: 'could not stand at the fill stations', last: g && g.detail } }); continue; }
        }
        // place: the farthest cell in reach first (the near blocks would hide the far faces), re-reading what is supported after every block
        const eye = eyeOf(env.here());
        let placed = 0;
        for (let guard = 0; guard < 120; guard++) {
            refreshLowest();
            const todo = cells.filter((f) => isFluid(w, f.x, f.y, f.z) && (cellFails.get(key(f.x, f.y, f.z)) || 0) < 2 && baseOk(f) && hasSupport(w, f) && dist(eye, f) <= REACH
                && !(f.x === Math.floor(env.here().x) && f.z === Math.floor(env.here().z) && (f.y === env.here().y || f.y === env.here().y + 1)) && !blocked(w, eye, f));
            if (!todo.length) break;
            todo.sort((a, b) => dist(eye, b) - dist(eye, a));
            const f = todo[0];
            let item = sealItem(env);
            if (!item && env.run && env.within) { const hv = await env.run('harvest', { items: c.items }); if (hv.ok && hv.detail && hv.detail.got) { stats.harvested++; item = sealItem(env); } }
            if (!item) return done({ reason: 'missing_item', detail: { why: 'no blocks left to fill the lake with', filled: stats.filled } });
            const p = await env.exec('place', { x: f.x, y: f.y, z: f.z, item, fluid: true, temp: 'lake' }, { raw: true, maxTicks: 160 });
            if (p.ok) { stats.filled++; placed++; rowFails = 0; stats.placed.push({ x: f.x, y: f.y, z: f.z }); continue; }
            if (p.reason === 'died' || p.reason === 'disconnected' || p.reason === 'cancelled') return done({ reason: p.reason, detail: p.detail });
            const k = key(f.x, f.y, f.z); cellFails.set(k, (cellFails.get(k) || 0) + 1);
        }
        if (!placed) { bannedStation.add(key(S.x, S.y, S.z)); if (++rowFails >= MAX_ROW_FAILS) return done({ reason: 'stuck', detail: { why: 'nothing could be placed from the fill stations' } }); }
    }
    return done({ reason: 'timeout', detail: { why: `${c.rounds || MAX_ROUNDS} stations used` } });
}

module.exports = { fillLake, component, chooseStation, hasSupport, blocked, MAX_CELLS };

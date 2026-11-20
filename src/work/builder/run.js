'use strict';
// Running a unit (rewrite 2026-11-18, TASK-20261117-070). A unit is a few nearby cells. The bot (1) fetches what they need in one trip, (2) picks a STATION (stations.js: where one stands to
// place many of them), (3) walks there with NAV (`env.travel`: walks, pillars up, bridges, and now descends; it owns its temporary blocks), (4) places every cell the station serves, blind, with
// the recipe that gives the blueprint's state (orient.js), and reads the state back. It uses the same layers as the pit: NAV for every move, `place` / `mine` / `pour` / `activate` for the
// blocks, `take_many` for the chests; nothing here walks by itself, builds a scaffold of its own or teleports. A cell whose support is not there yet is left for later: the unit is handed
// back unfinished (`partial`) and another unit goes first.
const O = require('../jobs/orient');
const C = require('./cells');
const S = require('./stations');
const P = require('./plan');
const supply = require('./supply');
const posts = require('./posts');
const { sturdy } = require('./order');

const D = O.DIR;
const UNIT_BUDGET_MS = 150000;
const FATAL = new Set(['died', 'disconnected', 'cancelled', 'wrong_dimension']);
const POSITIONAL = new Set(['unreachable', 'not_visible', 'stuck', 'precondition_failed', 'timeout']);
const at = (c, d) => ({ x: c.x + D[d][0], y: c.y + D[d][1], z: c.z + D[d][2] });
const ok = { ok: true };
const bad = (reason, detail, stage) => ({ ok: false, reason, detail, stage });
const nm = (w, x, y, z) => String(w.nameAt(x, y, z) || '').replace(/^minecraft:/, '');

/** A block a click can land on: not air, a fluid, a plant, or an unloaded cell. */
function presentAt(w, p) { const k = w.kindAt(p.x, p.y, p.z), n = nm(w, p.x, p.y, p.z); return k !== 'unknown' && k !== 'water' && k !== 'liquid' && !!n && !C.REPLACEABLE.test(n) && n !== 'lava'; }

/** Is the cell done: the block with the placement-decided properties (and nothing left to right-click), a source of the fluid, or the water in a waterlogged block? */
function right(c, w) {
    const b = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
    if (c.waterlog) return !!b && !!b.getProperties && String(b.getProperties().waterlogged) === 'true';
    if (C.kindOf(c) === 'fluid') return !!b && b.name === c.block && (!b.getProperties || (b.getProperties().level || '0') === '0');
    return b ? C.stateMatches(b, c) : nm(w, c.x, c.y, c.z) === c.block;                // placement-decided state only: open / delay are a polish pass (right-click) that may fail without holding anything up
}
/** Cheap form for the gate (a name, no block object): is something of the cell's block there? */
const placedName = (c, w) => (c.waterlog ? false : nm(w, c.x, c.y, c.z) === c.block);

/** Can the cell be placed now: everything it waits for stands, and so does the support it was planned on (a seed needs none: it gets a temporary block beside it). */
function cellReady(plan, c, w) {
    for (const k of c.pre || []) {
        const q = plan.byKey.get(k);
        if (!q) continue;
        if (q.waterlog ? !right(q, w) : nm(w, q.x, q.y, q.z) !== q.block) return false;
    }
    if (c.waterlog || c.seed || !c.sup) return true;
    return presentAt(w, at(c, c.sup));
}

/** `cellReady` for the cells a station serves one after the other: what a cell waits for may be placed from the same station a moment before (`local`: keys placed so far). */
function readyLocal(plan, c, w, local) {
    for (const k of c.pre || []) {
        if (local.has(k)) continue;
        const q = plan.byKey.get(k);
        if (!q) continue;
        if (q.waterlog ? !right(q, w) : nm(w, q.x, q.y, q.z) !== q.block) return false;
    }
    return true;
}

/** Gate of the ledger: may unit u be claimed now (by bot `id` at `pos`)? Before any bot has looked at the world: when the units it hangs on are settled. */
const WINDOW = 14;                                        // units ahead of the first unfinished one OF ITS AREA that may be started: the order stays bottom-up (a floating piece high up is not begun before the floor around it)
function gateOf(plan, job, u, id = null, pos = null) {
    if (id !== null && !posts.allows(plan, job, u, id, pos, Date.now())) return false;           // another bot's area (posts.js)
    const w = job.world, r = job.ledger.regions.get('b0');
    // Layer mode: a level opens when every unit of the levels below is done or parked. 'layer': one barrier across all the areas; 'zlayer' (owner 2026-11-19: "divide into areas first, then split
    // each area into layers"): one barrier per area, so a bot never waits for another area's level (cells that hang on another area wait on their own).
    // (When nothing has been placed for 60 s the barrier is off: a cell that waits for one a parked unit did not place would hold every level above it for ever; layer run 3, 2026-11-19: 425 cells, no claim after 12 minutes.)
    if (r && (plan.mode === 'layer' || plan.mode === 'zlayer') && Date.now() - (job.lastProgress || 0) < 60000) {
        const L = plan.unitLayer[u], lv = plan.mode === 'zlayer' ? plan.zoneLevels[plan.zones.ofUnit[u]] : plan.levels, list = lv.list;
        // `levelWindow` (0 = strict): levels above the lowest unsettled one that may already be worked (the first levels are thin: one bot builds them and the others wait)
        let low = 0; while (low < list.length && lv.of.get(list[low]).every((v) => r.state[v] === 2 || r.state[v] === 3)) low++;
        const mine = list.indexOf(L);
        if (mine > low + plan.levelWindow) return false;
    }
    if (r && plan.mode === 'area') {
        const z = plan.zones.ofUnit[u], [a, b] = plan.zones.units[z];
        if (!job.first) job.first = [];
        let f = Math.max(job.first[z] || a, a);
        while (f < b && (r.state[f] === 2 || r.state[f] === 3 || r.attempts[f] > 0)) f++;          // a unit that failed is not waited for: the window moves on
        job.first[z] = f;
        // A floating piece (a seed) waits for the plain units around it, but not for ever: as soon as no plain unit of its area can be started any more it is open (live 2026-11-21: 600 units hung on
        // floating pieces, the gate said "open now 0" and the crew stood idle until 90 s had passed without a single placement, again and again).
        if (u > f + WINDOW && Date.now() - (job.lastProgress || 0) < (plan.seedUnit[u] ? 90000 : 15000) && !(plan.seedUnit[u] && !plainOpen(plan, job, z, r))) return false;          // the window yields when nothing has been placed for 15 s (the unit at its front may wait for cells of a failed one), for a floating piece after 90 s
    }
    if (!w) return !r || plan.deps[u].every((d) => r.state[d] === 2 || r.state[d] === 3);
    let any = false;
    for (const c of plan.units[u]) { if (placedName(c, w) && right(c, w)) continue; any = true; if (cellReady(plan, c, w)) return true; }
    return !any;                                                              // nothing left in it: let a bot close it
}

/** Is some unit of area z without a floating piece still pending and ready to go (a cell whose support and waits stand)? Cached for a second: the gate asks for every unit. */
function plainOpen(plan, job, z, r) {
    const now = Date.now(), c = job.plainCache || (job.plainCache = []);
    if (c[z] && now - c[z].t < 1000) return c[z].v;
    const w = job.world, [a, b] = plan.zones.units[z]; let v = false;
    for (let u = a; u < b && !v; u++) {
        if (r.state[u] !== 0 || plan.seedUnit[u]) continue;
        if (!w) { v = plan.deps[u].every((d) => r.state[d] === 2 || r.state[d] === 3); continue; }
        for (const q of plan.units[u]) if (!(placedName(q, w) && right(q, w)) && cellReady(plan, q, w)) { v = true; break; }
    }
    c[z] = { t: now, v };
    return v;
}

/** The order a bot is offered claimable units: its own area first, bottom-up (posts.js), then other areas. */
function pickNear(plan, job, cands, o) { return posts.order(plan, job, cands, o); }

const TRACE = !!process.env.BUILD_TRACE, T0 = Date.now();                // the trace lines carry the seconds since the process began
/**
 * A bot that stands in a cell of the plan (feet or head) that is not placed yet is in the way of whoever places there (live 2026-11-18: an idle builder stood in the gap of a ring for five
 * minutes and three others failed `not_confirmed`): it steps to the nearest cell outside the plan where a body fits, on a floor.
 */
async function clearOfPlan(plan, env) {
    if (!env.bot || !env.travel) return;
    const w = env.w, f = env.here(), inPlan = (x, y, z) => plan.cellSet.has(`${x},${y},${z}`) && !placedName(plan.byKey.get(`${x},${y},${z}`) || {}, w);
    if (!inPlan(f.x, f.y, f.z) && !inPlan(f.x, f.y + 1, f.z)) return;
    const view = S.viewOf(w, plan.cellSet);
    let best = null;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -2; dy <= 2; dy++) {
        const c = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
        if (!view.solid(c.x, c.y - 1, c.z) || !view.free(c.x, c.y, c.z) || !view.free(c.x, c.y + 1, c.z) || plan.cellSet.has(`${c.x},${c.y},${c.z}`) || plan.cellSet.has(`${c.x},${c.y + 1},${c.z}`)) continue;
        if (env.others && env.others().some((o) => Math.abs(o.x - (c.x + 0.5)) < 1.2 && Math.abs(o.z - (c.z + 0.5)) < 1.2)) continue;
        const d = Math.abs(dx) + Math.abs(dz) + 2 * Math.abs(dy);
        if (!best || d < best.d) best = { ...c, d };
    }
    if (best) await env.travel({ x: best.x, y: best.y, z: best.z }, { near: 0, nearY: 0, maxSegments: 8, stuckAfter: 2, footNodes: 2000, why: 'out of the way of the structure' });
}

/**
 * A bot that cannot leave where it stands (run 3, 2026-11-18: one bot stood on a wall 13 levels up for 12 minutes, "no move from here", every unit handed back as `partial` or failed in the
 * supply trip, so the worker's own recovery never ran): after a unit that placed nothing and could not walk, at the same place again, the escape ladder of the worker (jump, sidestep, step
 * back, wait, descend) is run, one rung per time.
 */
async function unstrand(plan, job, me, env) {
    const s = job.strand && job.strand[me]; if (!s || !env.recover) return;
    const f = env.here();
    if (f.x !== s.x || f.y !== s.y || f.z !== s.z) { delete job.strand[me]; return; }
    if (++s.n < 2) return;
    if (TRACE && s.n === 2 && env.w) { const g = (dy) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => `${env.w.nameAt(f.x + dx, f.y + dy, f.z + dz) || '?'}/${env.w.kindAt(f.x + dx, f.y + dy, f.z + dz)}`).join(' '); console.log(`[build] ${me} strand view at ${f.x},${f.y},${f.z}: y+1 ${g(1)} | y ${g(0)} | y-1 ${g(-1)} | y-2 ${g(-2)}`); }
    if (TRACE) console.log(`[build] ${Math.round((Date.now() - T0) / 1000)}s ${me} stranded at ${f.x},${f.y},${f.z} (${s.n}): escape`);
    // Stranded again and again within minutes (run 8, 2026-11-18: three bots stepped from one wall compartment of the plate into the next for ten minutes; the step off moved them, so the ladder
    // never got to its last rung): down to the deck, a block at a time, the way a player does (moves.js descend; it breaks what is under the feet, the final look of the build puts it back).
    const now = Date.now(), hist = job.strandHist[me] = (job.strandHist[me] || []).filter((t) => now - t < 240000); hist.push(now);
    try {
        // never through the structure (owner 2026-11-19: a bot broke a glass cell and dropped through it): only when the block under the feet is not a cell of the plan
        if (hist.length >= 3 && env.run && f.y > plan.origin.y && !plan.cellSet.has(`${f.x},${f.y - 1},${f.z}`)) {
            job.strandHist[me] = [];
            const d = await env.run('descend', { levels: Math.min(40, f.y - plan.origin.y) });
            if (TRACE) console.log(`[build] ${me} descend: ${d.ok ? JSON.stringify(d.detail || {}).slice(0, 120) : d.reason + ' ' + JSON.stringify(d.detail || {}).slice(0, 160)}`);
            if (d.ok || (d.detail && d.detail.levels)) return;
        }
        // Walled in by its own work (live 2026-11-21: a bot on a pumpkin between beds and trapdoors on the first floor, no step, no edge, 40 minutes): dig out through the structure; what it digs is placed
        // again by the unit that owns the cell (reopenDamaged), and the final look catches the rest.
        if (s.n >= 4 && env.travel && f.y > plan.origin.y + 1) {
            // the nearest free cell of the ground outside the structure (not the cell straight below: that is a cell of the plan)
            const view = env.w ? S.viewOf(env.w, plan.cellSet) : null; let g = null;
            if (view) for (let d = 2; d <= 24 && !g; d++) for (let dx = -d; dx <= d && !g; dx++) for (let dz = -d; dz <= d && !g; dz++) { if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue; const x = f.x + dx, z = f.z + dz; if (view.solid(x, plan.origin.y - 1, z) && view.free(x, plan.origin.y, z) && view.free(x, plan.origin.y + 1, z) && !plan.cellSet.has(`${x},${plan.origin.y},${z}`) && !plan.cellSet.has(`${x},${plan.origin.y + 1},${z}`)) g = { x, y: plan.origin.y, z }; }
            const t = await env.travel(g || { x: f.x, y: plan.origin.y, z: f.z }, { near: 1, nearY: 1, maxSegments: 24, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, digStructure: true, why: 'dig out of the structure' });
            if (TRACE) console.log(`[build] ${me} dig out: ${t.ok ? 'ok' : t.reason}`);
            reopenDamaged(plan, job, env);
            if (t.ok) return;
            // NAV plans nothing from a cell whose floor is a partial block (live 2026-11-21: three builders stood on beds they had placed, "partial plan, 0 moves", 40 minutes each): the block under the
            // feet (or the one in the feet cell, a bed or a slab the bot stands on top of) is mined; the bot drops onto what is below, and the unit that owns the cell places it again.
            // (the cells the bot's FOOTPRINT rests on, not only its own column: live 2026-11-21 a bot stood at y 210.5 on the edge of a slab in the next cell, with air under its own cell)
            const pp = env.bot && env.bot.entity ? env.bot.entity.position : null, under = [];
            if (pp) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const yy of [Math.floor(pp.y - 0.001), Math.floor(pp.y - 0.001) - 1, Math.floor(pp.y)]) {
                const cx = Math.floor(pp.x) + dx, cz = Math.floor(pp.z) + dz;
                if (pp.x + 0.31 > cx && pp.x - 0.31 < cx + 1 && pp.z + 0.31 > cz && pp.z - 0.31 < cz + 1) under.push({ x: cx, y: yy, z: cz });
            }
            if (env.exec && env.w) for (const c of [...under, { x: f.x, y: f.y, z: f.z }, { x: f.x, y: f.y - 1, z: f.z }]) {
                const k = env.w.kindAt(c.x, c.y, c.z);
                if (k !== 'partial' && k !== 'solid') continue;
                const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false, blind: true }, { raw: true, maxTicks: 300 });          // blind: no approach (NAV plans nothing from here)
                if (TRACE) console.log(`[build] ${me} mined the ${env.w.nameAt(c.x, c.y, c.z) || 'block'} it stood on at ${c.x},${c.y},${c.z}: ${m.ok ? 'ok' : m.reason}`);
                reopenDamaged(plan, job, env);
                if (m.ok) return;
            }
        }
        if (env.stepOff && (s.n === 2 || s.n === 4)) { const o = await env.stepOff({ maxDrop: s.n >= 4 ? 8 : 3 }); if (TRACE) console.log(`[build] ${me} step off: ${o.ok ? 'to ' + JSON.stringify(o.to) : 'no edge'}`); if (o.ok) return; }          // once per place: over the edge of what it stands on
        await env.recover(Math.min(6, s.n + 1), { reason: 'unreachable', detail: { why: 'stranded' } });
    } catch (_) { /* a failed fix is tried again with the next */ }
}

/** Units that are done but whose cells no longer hold their block (a walk through the structure dug them) go back to pending. */
function reopenDamaged(plan, job, env) {
    const r = job.ledger.regions.get('b0'), now = Date.now(); let n = 0;
    if (!r) return 0;
    for (let u = 0; u < plan.units.length; u++) if (r.state[u] === 2 && plan.units[u].some((c) => !right(c, env.w)) && job.ledger.requeueUnit('b0', u, now)) n++;
    if (TRACE && n) console.log(`[build] ${Math.round((Date.now() - T0) / 1000)}s ${n} unit(s) reopened: a walk dug cells of the structure`);
    return n;
}

async function runUnit(plan, job, regionId, u, env) {
    const me = env.bot ? env.bot.username : null;
    if (!job.strand) { job.strand = {}; job.strandHist = {}; }
    if (me) await unstrand(plan, job, me, env);
    const t0 = Date.now(), res = await runUnit0(plan, job, regionId, u, env).finally(() => { if (me && job.posts) posts.resting(job, me); });
    if (me) { const f = env.here(), d = res.detail || {}; if (d.noMove && !(d.placed > 0)) { const s = job.strand[me]; if (!s || s.x !== f.x || s.y !== f.y || s.z !== f.z) job.strand[me] = { x: f.x, y: f.y, z: f.z, n: 0 }; } else delete job.strand[me]; }
    if (res.ok ? !res.partial || (res.detail && res.detail.placed > 0) : (res.detail && res.detail.placed > 0)) job.lastProgress = Date.now();
    try { await clearOfPlan(plan, env); } catch (_) { /* getting out of the way is a courtesy */ }
    if (TRACE) console.log(`[build] ${Math.round((Date.now() - T0) / 1000)}s ${env.bot ? env.bot.username : '?'} u${u.unit} ${res.ok ? (res.partial ? 'partial' : 'ok') : 'FAILED ' + res.reason} ${Math.round((Date.now() - t0) / 100) / 10}s ${JSON.stringify(res.detail || {}).slice(0, 900)}`);
    return res;
}
async function runUnit0(plan, job, regionId, u, env) {
    const bot = env.bot || null;
    job.world = env.w;
    const r = { placed: 0, skipped: 0, fixed: 0, poured: 0, stations: 0, trips: 0 };
    // the structure's materials are held back from temporary use (pillars) while the bot works on it, and its cells are never dug by a walk (NAV reads __keep)
    if (bot) {
        bot.__reserve = new Map(Object.entries(supply.remaining(plan, env.w)));
        bot.__keep = (x, y, z) => plan.cellSet.has(`${x},${y},${z}`);
        bot.__avoidFloor = null;                                               // a leftover block of another builder is a floor like any other (the action layer refused to start a walk from one: 'expanded 1')
        // the beds of the plan (foot and head) and its chests / barrels / shulker boxes are the crew's own work, also those a run before this one placed: they may be mined again (fixtures.js protects every other bed)
        if (bot.__bedsOwn !== plan) { bot.__bedsOwn = plan; const ps = require('../../skills/fixtures').placedSet(bot); for (const c of plan.list) { if (/(^|_)(chest|trapped_chest|barrel|shulker_box)$/.test(c.block)) ps.add(`${c.x},${c.y},${c.z}`); if (/_bed$/.test(c.block)) { ps.add(`${c.x},${c.y},${c.z}`); const d = D[(c.props || {}).facing]; if (d) ps.add(`${c.x + d[0]},${c.y},${c.z + d[2]}`); } } }
        bot.__noCollect = true;                                                  // the drops of its temporary blocks are left where they fall (the supply holds enough)
    }
    const cells = plan.units[u.unit], tried = new Set(), me = bot ? bot.username : null;
    if (bot && plan.wanted && Object.keys(plan.wanted).length) { try { const g = await supply.giveBack(env, plan, P.needsOf(cells.filter((c) => !right(c, env.w)), env.w)); if (TRACE && g) console.log(`[build] ${me} gave back ${g} items the crew waits for`); } catch (_) { /* a courtesy */ } }
    if (me && job.posts) posts.working(plan, job, me, u.unit);
    if (!job.waits) job.waits = {};
    if (!job.noStation) job.noStation = {};
    let idle = 0, last = null, down = 0;
    const tStart = Date.now();
    if (!job.budget) job.budget = {};
    for (let round = 0; round < 18; round++) {
        if (env.cancelled && env.cancelled()) return { ok: false, reason: 'cancelled', detail: { ...r } };
        // A unit is a few nearby cells: more than UNIT_BUDGET_MS on it (a stateful block placed again and again, trips for an item that is not there) is a sink, not progress (run 1: 495 s on three
        // cells at the top). The unit goes back unfinished and the bot works elsewhere; the third time it is a failure (the ledger parks it after a few of those).
        if (round > 0 && Date.now() - tStart > UNIT_BUDGET_MS) {
            const n = job.budget[u.unit] = (job.budget[u.unit] || 0) + 1, todo0 = cells.filter((c) => !right(c, env.w)).length;
            if (n <= 3) return { ok: true, partial: true, holdMs: 20000, detail: { ...r, waiting: todo0, why: 'unit time budget used' } };
            return { ok: false, reason: 'timeout', detail: { why: 'unit time budget used three times', ...(last || {}), ...r } };
        }
        const todo = cells.filter((c) => !right(c, env.w));
        if (!todo.length) {
            delete job.waits[u.unit]; delete job.noStation[u.unit];
            // polish: right-click what stands in the wrong open / delay state (a few tries per unit, never a failure)
            let tries = 0;
            for (const c of cells) { if (tries >= 4 || (env.cancelled && env.cancelled())) break; const b = env.w.blockAt ? env.w.blockAt(c.x, c.y, c.z) : null; if (b && !c.waterlog && C.stateMatches(b, c) && C.useMismatch(b, c)) { tries++; await nearFor(plan, c, env); await fixUse(c, env, r); } }
            return { ok: true, reason: null, detail: r };
        }
        const ready = todo.filter((c) => cellReady(plan, c, env.w));
        if (!ready.length) return { ok: true, partial: true, holdMs: 6000, detail: { ...r, waiting: todo.length } };
        // One trip fetches the materials for the whole RUN of units of this bot's area that fit in its pack, not only for this unit (owner 2026-11-18: "build one small component, then fetch
        // materials: 5 s of placing, 30 s of walking"). A trip is made only when this unit lacks something.
        const unitNeed = P.needsOf(todo, env.w);
        const rs = await supply.restock(env, plan, supply.batch(env.bot, plan, u.unit, env.w, unitNeed), { trigger: unitNeed, topup: false, reserve: 3 });
        if (rs.trips) r.trips += rs.trips;
        if (rs.dug) reopenDamaged(plan, job, env);                                   // a supply walk through the structure dug cells: the units that own them place them again
        if (TRACE && (rs.trips || !rs.ok)) console.log(`[build] ${Math.round((Date.now() - T0) / 1000)}s ${me} u${u.unit} restock ${rs.ok ? 'ok' : 'SHORT'} trips=${rs.trips || 0} unit-need ${JSON.stringify(unitNeed)} have ${JSON.stringify(Object.fromEntries(Object.keys(unitNeed).map((it) => [it, env.have(it)])))} free-slots ${env.bot ? supply.emptySlots(env.bot) : '?'}${rs.ok ? '' : ' ' + JSON.stringify({ short: rs.detail && rs.detail.short, lastTravel: rs.detail && rs.detail.lastTravel, lastTake: rs.detail && rs.detail.lastTake }).slice(0, 300)}`);
        if (!rs.ok) return { ok: false, reason: rs.reason, detail: { ...(rs.detail || {}), cell: ready[0], stage: 'stock', ...r, ...(rs.detail && rs.detail.lastTravel ? { noMove: true } : {}) } };
        const view = S.viewOf(env.w, plan.cellSet);
        const dg = {};
        let walk = null;
        if (env.bot && env.here().y > plan.origin.y + 1) { try { const rs = await require('../../skills/planner').reachableAsync(env.w, env.here(), { maxNodes: 9000, radius: 40 }); walk = (x, y, z) => rs.has(x, y, z); } catch (_) { walk = null; } }          // only from the structure: from the ground NAV can climb to any place          // where the bot can walk from here (3000 cells): native stations outside it are not offered
        const st = S.chooseStation(view, todo, { diag: dg, reach: walk, first: (c) => cellReady(plan, c, env.w), from: env.here(), avoid: env.others ? env.others() : [], skip: tried, ok: (c, local) => readyLocal(plan, c, env.w, local) });
        let stUse = st;
        if (!stUse && env.others && env.others().length) {
            // the only places are taken by other bots: wait twice (they move on), then use them anyway (a bot that has stopped for good stood on the key spot of the tower for ten minutes and everyone waited)
            const free = S.chooseStation(view, todo, { from: env.here(), avoid: [], skip: tried, reach: walk, first: (c) => cellReady(plan, c, env.w), ok: (c, local) => readyLocal(plan, c, env.w, local) });
            if (free) { const k = (job.waits[u.unit] = (job.waits[u.unit] || 0) + 1); if (k <= 2) return { ok: true, partial: true, holdMs: 4000, detail: { ...r, waiting: todo.length, why: 'the only standing places are taken by other bots' } }; stUse = free; }
        }
        // nowhere to stand that this bot can walk, bridge or climb to from where it is (it is on the platform, the cells are in another compartment): back to the ground by NAV, then again
        if (!st && walk && env.here().y > plan.origin.y + 1 && ++down <= 2) {
            const c0 = todo[0]; let g = null;
            for (let d = 3; d <= 9 && !g; d++) for (let dx = -d; dx <= d && !g; dx++) for (let dz = -d; dz <= d && !g; dz++) { if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue; const x = c0.x + dx, z = c0.z + dz; if (view.solid(x, plan.origin.y - 1, z) && view.free(x, plan.origin.y, z) && view.free(x, plan.origin.y + 1, z) && !plan.cellSet.has(`${x},${plan.origin.y},${z}`)) g = { x, y: plan.origin.y, z }; }
            if (g) { let t = await env.travel(g, { near: 1, nearY: 1, maxSegments: 16, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, why: 'back to the ground' }); if (!t.ok && ['unreachable', 'stuck'].includes(t.reason) && down >= 2) { t = await env.travel(g, { near: 1, nearY: 1, maxSegments: 24, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, digStructure: true, why: 'back to the ground (through the structure)' }); reopenDamaged(plan, job, env); } if (!t.ok) r.noMove = true; if (t.ok || t.reason === 'stuck' || t.reason === 'unreachable') continue; }
        }
        // No place this bot can stand at (it is in a compartment of the platform, far from the cells): another bot, or this one from somewhere else, may. Not a failure of the unit until it has happened six times.
        if (!stUse && (job.noStation[u.unit] = (job.noStation[u.unit] || 0) + 1) <= 6) return { ok: true, partial: true, holdMs: 6000, detail: { ...r, noMove: true, waiting: todo.length, why: 'no standing place from where this bot is', diag: dg } };
        if (!stUse) return { ok: false, reason: 'unreachable', detail: { why: 'no standing place within reach of the next cells', diag: dg, c0: { x: todo[0].x, y: todo[0].y, z: todo[0].z, block: todo[0].block }, from: env.here(), cell: ready[0], stage: 'station', tried: tried.size, ...r } };
        const st2 = stUse;
        const sk = `${stUse.S.x},${stUse.S.y},${stUse.S.z}`;
        r.stations++;
        if (TRACE) console.log(`[build] ${Math.round((Date.now() - T0) / 1000)}s ${bot ? bot.username : '?'} u${u.unit} round ${round}: station ${stUse.kind} ${sk} serves ${stUse.serves.length}/${todo.length}${stUse.bridge ? ' (bridge ' + stUse.bridge.g + ')' : ''} from ${JSON.stringify(env.here())}`);
        const f = env.here(), real = !!env.bot;                                          // (a test environment without a bot has no position to check)
        if (real && (f.x !== stUse.S.x || f.y !== stUse.S.y || f.z !== stUse.S.z)) {
            let t = await env.travel({ x: stUse.S.x, y: stUse.S.y, z: stUse.S.z }, { near: 0, nearY: 0, maxSegments: 16, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, why: `build station (${stUse.kind})` });
            // The way to a station high in the structure runs through the structure itself (live 2026-11-21: six builders pillared up under the first floor's plate again and again, "3 segments
            // without getting closer", 60 s each): the second time a walk to the same station fails, NAV may dig through the structure; the units that own the dug cells place them again.
            if (!t.ok && ['stuck', 'unreachable'].includes(t.reason) && (job.digWalk = job.digWalk || {}, job.digWalk[sk] = (job.digWalk[sk] || 0) + 1) >= 2) {
                t = await env.travel({ x: stUse.S.x, y: stUse.S.y, z: stUse.S.z }, { near: 0, nearY: 0, maxSegments: 24, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, digStructure: true, why: `build station (${stUse.kind}), through the structure` });
                reopenDamaged(plan, job, env);
                if (TRACE) console.log(`[build] ${me} walk to ${sk} through the structure: ${t.ok ? 'ok' : t.reason}`);
            }
            const g = env.here();
            if (!t.ok || g.x !== stUse.S.x || g.y !== stUse.S.y || g.z !== stUse.S.z) {
                if (t.reason && FATAL.has(t.reason)) return { ok: false, reason: t.reason, detail: { ...r } };
                r.noMove = true; tried.add(sk); last = { reason: t.reason || 'unreachable', why: `walk to the station ${sk} (${stUse.kind}): ${(t.detail && (t.detail.why || (t.detail.nav && 'nav'))) || ''}`, station: sk, nav: t.detail && t.detail.nav };
                if (++idle >= 5) return { ok: false, reason: last.reason, detail: { ...last, cell: ready[0], stage: 'station', ...r } };
                continue;
            }
        }
        const before = r.placed + r.skipped + r.fixed + r.poured;
        for (const sv of stUse.serves) {
            const res = sv.temp ? await buildWithTemp(plan, sv, env, r) : await buildCell(plan, sv.cell, sv.sup, env, r, sv.jump);
            if (res.ok) continue;
            if (FATAL.has(res.reason)) return { ok: false, reason: res.reason, detail: { ...(res.detail || {}), ...r } };
            last = { reason: res.reason, ...(res.detail || {}), stage: res.stage, cell: sv.cell, station: sk };
            if (res.reason === 'blocked') return { ok: true, partial: true, holdMs: 3000, detail: { ...r, waiting: todo.length, why: res.detail && res.detail.why } };        // somebody stands there: another unit meanwhile
            if (res.reason === 'missing_item') break;                                     // the next round fetches it
            if (POSITIONAL.has(res.reason)) { tried.add(sk); break; }
            // One cell failed after others of the unit were placed (run 4, 2026-11-18: the key unit of the tower, 19 cells placed, the 20th a temporary support: the whole unit failed and nobody
            // took it for 230 s): the unit goes back unfinished, not failed; a unit that placed nothing fails as before.
            if (r.placed + r.poured + r.fixed > 0) return { ok: true, partial: true, holdMs: 4000, detail: { ...r, waiting: todo.length, why: `a cell failed (${res.reason}) after others were placed`, failure: last } };
            return { ok: false, reason: res.reason, detail: { ...last, ...r } };
        }
        if (r.placed + r.skipped + r.fixed + r.poured === before) { if (++idle >= 4) return { ok: false, reason: (last && last.reason) || 'stuck', detail: { ...(last || {}), why: (last && last.why) || 'no progress at the station', stage: (last && last.stage) || 'place', ...r } }; } else idle = 0;
    }
    return { ok: false, reason: 'timeout', detail: { why: 'more than 18 rounds in one unit', ...(last || {}), ...r } };
}

/** A cell whose support is a temporary block placed beside it first (taken away afterwards): the block, the cell, then the block is mined again (blind, not collected). */
async function buildWithTemp(plan, sv, env, r) {
    const w = env.w, T = sv.temp, c = sv.cell;
    const item = env.tempItem ? env.tempItem(1) : null;
    if (!item) return bad('missing_item', { item: 'cobblestone', why: 'no block for a temporary support' }, 'support');
    if (!C.REPLACEABLE.test(nm(w, T.x, T.y, T.z)) && nm(w, T.x, T.y, T.z) === C.bare(item)) await env.exec('mine', { x: T.x, y: T.y, z: T.z, collect: false, blind: true }, { raw: true, maxTicks: 200 });          // a leftover temporary block (another bot's): out of the way first
    let p = await env.exec('place', { x: T.x, y: T.y, z: T.z, item, temp: 'scaffold' }, { raw: true, maxTicks: 220 });
    if (!p.ok && env.command && ['unreachable', 'not_visible', 'stuck', 'precondition_failed'].includes(p.reason)) p = await env.command('place', { x: T.x, y: T.y, z: T.z, item, temp: 'scaffold' });
    if (!p.ok) return { ...p, stage: 'support' };
    const res = await buildCell(plan, c, sv.sup, env, r);
    if (w.kindAt(T.x, T.y, T.z) === 'solid' && nm(w, T.x, T.y, T.z) === C.bare(item)) await env.exec('mine', { x: T.x, y: T.y, z: T.z, collect: false, blind: true }, { raw: true, maxTicks: 200 });
    return res;
}

/** One cell: skip it when it is right, dig out what is wrong, place it with the recipe that gives its state, read the state back, right-click what needs it. */
async function buildCell(plan, c, sup, env, r, jump = false) {
    const w = env.w;
    if (c.waterlog || C.kindOf(c) === 'fluid') return pourCell(c, env, r);
    // A portal forms only in an EMPTY frame: whatever a scaffold or a walk left inside it (a pumpkin, fire of an earlier try) is taken out first (live 2026-11-21: two pumpkins inside the first
    // portal, the lighting failed "cell holds fire", and the end-of-build tidy never ran because the unlit portal counted as missing).
    if (c.ignite && c.bodyCells) for (const q of c.bodyCells) {
        const n = nm(w, q.x, q.y, q.z);
        if (!n || /^(air|cave_air|void_air|nether_portal)$/.test(n) || (q.x === c.x && q.y === c.y && q.z === c.z && n === 'fire')) continue;
        await nearFor(plan, q, env);                                                                      // within reach of the leftover (the body of a portal is 14 long)
        let m = await env.exec('mine', { x: q.x, y: q.y, z: q.z, collect: false, blind: true }, { raw: true, maxTicks: 300 });
        if (!m.ok) m = await env.exec('mine', { x: q.x, y: q.y, z: q.z, collect: false }, { raw: true, maxTicks: 300 });
        if (TRACE) console.log(`[build] cleared ${n} out of the portal at ${q.x},${q.y},${q.z}: ${m.ok ? 'ok' : m.reason}`);
        if (!m.ok && !/^(fire|soul_fire)$/.test(n)) return { ...m, stage: 'clear-portal' };
    }
    const item = C.itemFor(c.block), cur = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
    if (cur ? C.stateMatches(cur, c) : nm(w, c.x, c.y, c.z) === c.block) { if (!C.useMismatch(cur, c)) { r.skipped++; return ok; } return fixUse(c, env, r); }
    const curName = cur ? cur.name : nm(w, c.x, c.y, c.z);
    if (curName && !C.REPLACEABLE.test(curName) && !(/^(water|lava)$/.test(curName) && w.kindAt(c.x, c.y, c.z) !== 'solid')) {
        // From the station of the cell the block is in reach: a blind dig needs no standing place with a line of sight (a wrong block inside the structure had none: "goal reach block, expanded 6000")
        let m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, blind: true, collect: false }, { raw: true, maxTicks: 400 });
        if (!m.ok) m = await env.exec('mine', { x: c.x, y: c.y, z: c.z }, { raw: true, maxTicks: 400 });
        if (!m.ok) return { ...m, stage: 'clear' };
    }
    if (env.have(item) < 1) return bad('missing_item', { item }, 'stock');
    return placeOriented(c, item, sup, env, r, jump);
}

/** Another bot's body in the cell (the server refuses a block placed into a player). */
const botIn = (env, c) => !!env.others && env.others().some((o) => Math.floor(o.x) === c.x && Math.floor(o.z) === c.z && (Math.floor(o.y) === c.y || Math.floor(o.y) + 1 === c.y));
async function placeOriented(c, item, sup, env, r, jump = false) {
    let lastNc = null, lastGot = null;
    // the bot's own body in the cell (a station inside a cell of the plan, which is then the next to place): one step aside first, unless the block goes under its feet: then the bot jumps and
    // places it (`jump`, the last cell of a station, or any cell at the feet with the floor under it: the place command does it, block.js `jumpPlace`)
    { const f = env.here(); if (env.bot && f.x === c.x && f.z === c.z && (c.y === f.y || c.y === f.y + 1) && env.stepAside && !(jump && c.y === f.y)) await env.stepAside(); }
    if (botIn(env, c)) return bad('blocked', { why: 'another bot stands in the cell', block: c.block }, 'entity');
    const w = env.w, blockArg = c.block !== item ? { block: c.block } : {}, tried = new Set();
    const solidAt = (d) => { const q = at(c, d); return presentAt(w, q) && sturdy(nm(w, q.x, q.y, q.z), d, C.bare(c.block)); };
    const all = O.recipes(c.block, c.props, solidAt);
    if (!all.length) return bad('invalid_target', { why: 'no placement recipe for this state', block: c.block, props: c.props }, 'recipe');
    for (let attempt = 0; attempt < 4; attempt++) {
        const feet = env.here();
        const usable = all.filter((x) => !tried.has(x) && presentAt(w, at(c, x.support)) && (!env.bot || S.reachTo(feet, at(c, x.support)) <= S.REACH + 0.3));
        usable.sort((a, b) => (a.support === sup ? 0 : 1) - (b.support === sup ? 0 : 1) || (require('../../skills/world').isInteractive(nm(w, at(c, a.support).x, at(c, a.support).y, at(c, a.support).z)) ? 1 : 0) - (require('../../skills/world').isInteractive(nm(w, at(c, b.support).x, at(c, b.support).y, at(c, b.support).z)) ? 1 : 0));
        const q = usable[0];
        if (!q) return bad('unreachable', { why: 'no recipe whose support is present and within reach from here', block: c.block, lastNotConfirmed: lastNc, feet, present: all.map((x) => `${x.support}:${presentAt(w, at(c, x.support)) ? 'y' : 'n'}:${S.reachTo(feet, at(c, x.support)).toFixed(1)}`).filter((v, i, a) => a.indexOf(v) === i), supports: all.map((x) => x.support).filter((v, i, a) => a.indexOf(v) === i) }, 'reach');
        // a cell that water has flowed into (run 60a, 2026-11-19: `cell holds water`, a unit failed for it): the block goes in over the water, as in the game
        const wet = /^(water|lava)$/.test(nm(w, c.x, c.y, c.z));
        const args = { x: c.x, y: c.y, z: c.z, item, ...blockArg, ...(wet ? { fluid: true } : {}), recipe: { support: q.support, face: q.face, hy: q.hy, yRot: q.yRot, pitch: q.pitch } };
        let p = await env.exec('place', args, { raw: true, maxTicks: 220 });
        // a precondition the station did not foresee (the body in the cell, an entity in the way, a support out of reach): the router's remedy, once (it moves the bot, then places)
        if (!p.ok && ['unreachable', 'not_visible', 'stuck', 'precondition_failed'].includes(p.reason) && env.command) p = await env.command('place', args);
        if (!p.ok && p.reason === 'not_confirmed') {
            // the block may have gone in and the confirmation be late (the update packet): look again for up to 2 s before trying another recipe
            for (let k = 0; k < 8 && !(w.blockAt && C.stateMatches(w.blockAt(c.x, c.y, c.z), c)); k++) await new Promise((res) => setTimeout(res, 250));
            if (w.blockAt && C.stateMatches(w.blockAt(c.x, c.y, c.z), c)) { r.late = (r.late || 0) + 1; p = { ok: true }; }
        }
        if (!p.ok) { if (p.reason === 'not_confirmed') { if (botIn(env, c)) return bad('blocked', { why: 'another bot stands in the cell', block: c.block }, 'entity'); tried.add(q); lastNc = p.detail; continue; } return { ...p, stage: 'place' }; }
        const now = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
        if (now && !C.stateMatches(now, c)) {
            r.fixed++; tried.add(q); lastGot = { name: now.name, props: now.getProperties ? now.getProperties() : {}, recipe: { support: q.support, face: q.face, hy: q.hy, yRot: q.yRot, pitch: q.pitch } };
            let m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, blind: true, collect: false }, { raw: true, maxTicks: 300 });
            if (!m.ok) m = await env.exec('mine', { x: c.x, y: c.y, z: c.z }, { raw: true, maxTicks: 300 });
            if (!m.ok) return { ...m, stage: 'redo' };
            continue;
        }
        r.placed++;
        return now && C.useMismatch(now, c) ? fixUse(c, env, r) : ok;
    }
    return bad('not_confirmed', { why: 'no placement recipe gave the wanted state', block: c.block, props: c.props, tried: tried.size, lastGot }, 'state');
}

/**
 * Stand within reach of a block that is to be right-clicked (live 2026-11-21: four birch trapdoors above the lava tower stood placed but closed, for the whole run: the polish clicked from wherever the bot
 * happened to be). Nothing to do when the eye is within 4.4 of the block; else the nearest cell with a floor and room for the body within 4 of it, walked to by NAV.
 */
async function nearFor(plan, c, env) {
    if (!env.bot || !env.travel || !env.w) return;
    const f = env.here();
    if (S.reachTo(f, c) <= 4.4) return;
    const view = S.viewOf(env.w, plan.cellSet); let best = null;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -4; dy <= 2; dy++) {
        const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        if (!view.solid(q.x, q.y - 1, q.z) || !S.bodyFits(view, q, env.others ? env.others() : []) || plan.cellSet.has(`${q.x},${q.y},${q.z}`) || plan.cellSet.has(`${q.x},${q.y + 1},${q.z}`) || S.reachTo(q, c) > 4.3) continue;
        const d = Math.abs(q.x - f.x) + Math.abs(q.z - f.z) + 2 * Math.abs(q.y - f.y);
        if (!best || d < best.d) best = { ...q, d };
    }
    if (best) await env.travel({ x: best.x, y: best.y, z: best.z }, { near: 0, nearY: 0, maxSegments: 16, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, why: 'next to a block to right-click' });
}

/** open / delay: right-click until the state is the wanted one (a trapdoor toggles once, a repeater steps its delay 1..4). */
async function fixUse(c, env, r) {
    for (let k = 0; k < 27; k++) {
        const b = env.w.blockAt ? env.w.blockAt(c.x, c.y, c.z) : null, um = C.useMismatch(b, c);
        if (!um) { r.fixed++; return ok; }
        if (k >= 5 && um[0] !== 'note') break;                                              // a note block takes up to 24 clicks, the others at most a few
        let a = await env.exec('activate', { x: c.x, y: c.y, z: c.z, blind: true }, { raw: true, maxTicks: 160 });          // from the station, no line of sight needed (a gate inside the structure)
        if (!a.ok) { if (TRACE) console.log(`[build] blind right-click of ${c.block}@${c.x},${c.y},${c.z}: ${a.reason} ${JSON.stringify(a.detail || {}).slice(0, 200)} from ${JSON.stringify(env.here())}`); a = await env.exec('activate', { x: c.x, y: c.y, z: c.z }, { raw: true, maxTicks: 160 }); }
        if (!a.ok) { r.useFailed = (r.useFailed || 0) + 1; if (TRACE) console.log(`[build] right-click of ${c.block}@${c.x},${c.y},${c.z} failed: ${a.reason} ${JSON.stringify(a.detail || {}).slice(0, 260)} from ${JSON.stringify(env.here())}`); return ok; }                          // the block stands; only its open / delay is wrong (not compared by the static verdict): the unit is not failed for it, and what hangs on it is not held up
    }
    r.useFailed = (r.useFailed || 0) + 1;
    return ok;
}

/** A water or lava source (a bucket on the cell) or the water of a waterlogged block (a bucket on the block itself). */
async function pourCell(c, env, r) {
    const item = c.waterlog ? 'water_bucket' : C.itemFor(c.block);
    if (right(c, env.w)) { r.skipped++; return ok; }
    if (c.waterlog && nm(env.w, c.x, c.y, c.z) !== C.bare(c.of)) return bad('precondition_failed', { why: 'the block to waterlog is not there', block: c.of }, 'pour');
    if (env.have(item) < 1) return bad('missing_item', { item }, 'stock');
    const p = await env.exec('pour', { x: c.x, y: c.y, z: c.z, item, ...(c.waterlog ? { waterlog: true } : {}) }, { raw: true, maxTicks: 300 });
    if (!p.ok) return { ...p, stage: 'pour' };
    // The bot's view follows the server's answer a moment later. A pour that leaves the cell something else (run 5, 2026-11-18: the cell held FLOWING water of a neighbouring source, level 1,
    // and 18 rounds of buckets were poured into it: 280 s and 18 buckets) is a failure with what the cell holds, not progress.
    for (let k = 0; k < 6 && !right(c, env.w); k++) await new Promise((res) => setTimeout(res, 200));
    if (!right(c, env.w)) { const b = env.w.blockAt ? env.w.blockAt(c.x, c.y, c.z) : null; return bad('not_confirmed', { why: 'the pour did not make the cell what the blueprint wants', block: c.block, now: b ? `${b.name}${JSON.stringify(b.getProperties ? b.getProperties() : {})}` : null }, 'pour'); }
    r.poured++;
    return ok;
}

module.exports = { runUnit, gateOf, pickNear, cellReady, readyLocal, right, placedName, buildCell, presentAt };

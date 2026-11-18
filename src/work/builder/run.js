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
const { sturdy } = require('./order');

const D = O.DIR;
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
    if (c.waterlog) return !!b && !!b.getProperties && b.getProperties().waterlogged === 'true';
    if (C.kindOf(c) === 'fluid') return !!b && b.name === c.block && (!b.getProperties || (b.getProperties().level || '0') === '0');
    return b ? C.stateMatches(b, c) && !C.useMismatch(b, c) : nm(w, c.x, c.y, c.z) === c.block;
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

/** Gate of the ledger: may unit u be claimed now? Before any bot has looked at the world: when the units it hangs on are settled. */
function gateOf(plan, job, u) {
    const w = job.world;
    if (!w) { const r = job.ledger.regions.get('b0'); return !r || plan.deps[u].every((d) => r.state[d] === 2 || r.state[d] === 3); }
    let any = false;
    for (const c of plan.units[u]) { if (placedName(c, w) && right(c, w)) continue; any = true; if (cellReady(plan, c, w)) return true; }
    return !any;                                                              // nothing left in it: let a bot close it
}

/** The order a bot is offered claimable units: the nearest to where it stands first, the earlier in the plan on a tie. */
function pickNear(plan, cands, { pos }) {
    const d = (i) => Math.hypot(plan.centre[i].x - pos.x, plan.centre[i].z - pos.z) + 0.25 * i;
    return cands.slice().sort((a, b) => d(a) - d(b));
}

async function runUnit(plan, job, regionId, u, env) {
    const bot = env.bot || null;
    job.world = env.w;
    const r = { placed: 0, skipped: 0, fixed: 0, poured: 0, stations: 0, trips: 0 };
    // the structure's materials are held back from temporary use (pillars) while the bot works on it, and its cells are never dug by a walk (NAV reads __keep)
    if (bot) {
        bot.__reserve = new Map(Object.entries(supply.remaining(plan, env.w)));
        bot.__keep = (x, y, z) => plan.cellSet.has(`${x},${y},${z}`);
    }
    const cells = plan.units[u.unit], tried = new Set();
    let idle = 0, last = null;
    for (let round = 0; round < 18; round++) {
        if (env.cancelled && env.cancelled()) return { ok: false, reason: 'cancelled', detail: { ...r } };
        const todo = cells.filter((c) => !right(c, env.w));
        if (!todo.length) return { ok: true, reason: null, detail: r };
        const ready = todo.filter((c) => cellReady(plan, c, env.w));
        if (!ready.length) return { ok: true, partial: true, holdMs: 6000, detail: { ...r, waiting: todo.length } };
        const rs = await supply.restock(env, plan, P.needsOf(ready, env.w));
        if (rs.trips) r.trips += rs.trips;
        if (!rs.ok) return { ok: false, reason: rs.reason, detail: { ...(rs.detail || {}), cell: ready[0], stage: 'stock', ...r } };
        const view = S.viewOf(env.w, plan.cellSet);
        const st = S.chooseStation(view, todo, { from: env.here(), avoid: env.others ? env.others() : [], skip: tried, ok: (c, local) => readyLocal(plan, c, env.w, local) });
        if (!st) return { ok: false, reason: 'unreachable', detail: { why: 'no standing place within reach of the next cells', cell: ready[0], stage: 'station', tried: tried.size, ...r } };
        const sk = `${st.S.x},${st.S.y},${st.S.z}`;
        r.stations++;
        const f = env.here(), real = !!env.bot;                                          // (a test environment without a bot has no position to check)
        if (real && (f.x !== st.S.x || f.y !== st.S.y || f.z !== st.S.z)) {
            const t = await env.travel({ x: st.S.x, y: st.S.y, z: st.S.z }, { near: 0, nearY: 0, why: `build station (${st.kind})` });
            const g = env.here();
            if (!t.ok || g.x !== st.S.x || g.y !== st.S.y || g.z !== st.S.z) {
                if (t.reason && FATAL.has(t.reason)) return { ok: false, reason: t.reason, detail: { ...r } };
                tried.add(sk); last = { reason: t.reason || 'unreachable', why: `walk to the station ${sk} (${st.kind}): ${(t.detail && (t.detail.why || (t.detail.nav && 'nav'))) || ''}`, station: sk, nav: t.detail && t.detail.nav };
                if (++idle >= 5) return { ok: false, reason: last.reason, detail: { ...last, cell: ready[0], stage: 'station', ...r } };
                continue;
            }
        }
        const before = r.placed + r.skipped + r.fixed + r.poured;
        for (const sv of st.serves) {
            const res = await buildCell(plan, sv.cell, sv.sup, env, r);
            if (res.ok) continue;
            if (FATAL.has(res.reason)) return { ok: false, reason: res.reason, detail: { ...(res.detail || {}), ...r } };
            last = { reason: res.reason, ...(res.detail || {}), stage: res.stage, cell: sv.cell, station: sk };
            if (res.reason === 'missing_item') break;                                     // the next round fetches it
            if (POSITIONAL.has(res.reason)) { tried.add(sk); break; }
            return { ok: false, reason: res.reason, detail: { ...last, ...r } };
        }
        if (r.placed + r.skipped + r.fixed + r.poured === before) { if (++idle >= 4) return { ok: false, reason: (last && last.reason) || 'stuck', detail: { ...(last || {}), why: (last && last.why) || 'no progress at the station', stage: (last && last.stage) || 'place', ...r } }; } else idle = 0;
    }
    return { ok: false, reason: 'timeout', detail: { why: 'more than 18 rounds in one unit', ...(last || {}), ...r } };
}

/** One cell: skip it when it is right, dig out what is wrong, place it with the recipe that gives its state, read the state back, right-click what needs it. */
async function buildCell(plan, c, sup, env, r) {
    const w = env.w;
    if (c.waterlog || C.kindOf(c) === 'fluid') return pourCell(c, env, r);
    const item = C.itemFor(c.block), cur = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
    if (cur ? C.stateMatches(cur, c) : nm(w, c.x, c.y, c.z) === c.block) { if (!C.useMismatch(cur, c)) { r.skipped++; return ok; } return fixUse(c, env, r); }
    const curName = cur ? cur.name : nm(w, c.x, c.y, c.z);
    if (curName && !C.REPLACEABLE.test(curName) && !(/^(water|lava)$/.test(curName) && w.kindAt(c.x, c.y, c.z) !== 'solid')) {
        const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z }, { raw: true, maxTicks: 400 });
        if (!m.ok) return { ...m, stage: 'clear' };
    }
    if (env.have(item) < 1) return bad('missing_item', { item }, 'stock');
    return placeOriented(c, item, sup, env, r);
}

async function placeOriented(c, item, sup, env, r) {
    const w = env.w, blockArg = c.block !== item ? { block: c.block } : {}, tried = new Set();
    const solidAt = (d) => { const q = at(c, d); return presentAt(w, q) && sturdy(nm(w, q.x, q.y, q.z), d, C.bare(c.block)); };
    const all = O.recipes(c.block, c.props, solidAt);
    if (!all.length) return bad('invalid_target', { why: 'no placement recipe for this state', block: c.block, props: c.props }, 'recipe');
    for (let attempt = 0; attempt < 4; attempt++) {
        const feet = env.here();
        const usable = all.filter((x) => !tried.has(x) && presentAt(w, at(c, x.support)) && (!env.bot || S.reachTo(feet, at(c, x.support)) <= S.REACH + 0.3));
        usable.sort((a, b) => (a.support === sup ? 0 : 1) - (b.support === sup ? 0 : 1) || (require('../../skills/world').isInteractive(nm(w, at(c, a.support).x, at(c, a.support).y, at(c, a.support).z)) ? 1 : 0) - (require('../../skills/world').isInteractive(nm(w, at(c, b.support).x, at(c, b.support).y, at(c, b.support).z)) ? 1 : 0));
        const q = usable[0];
        if (!q) return bad('unreachable', { why: 'no recipe whose support is present and within reach from here', block: c.block, supports: all.map((x) => x.support).filter((v, i, a) => a.indexOf(v) === i) }, 'reach');
        const args = { x: c.x, y: c.y, z: c.z, item, ...blockArg, recipe: { support: q.support, face: q.face, hy: q.hy, yRot: q.yRot, pitch: q.pitch } };
        let p = await env.exec('place', args, { raw: true, maxTicks: 220 });
        // a precondition the station did not foresee (the body in the cell, an entity in the way, a support out of reach): the router's remedy, once (it moves the bot, then places)
        if (!p.ok && ['unreachable', 'not_visible', 'stuck', 'precondition_failed'].includes(p.reason) && env.command) p = await env.command('place', args);
        if (!p.ok) { if (p.reason === 'not_confirmed') { tried.add(q); continue; } return { ...p, stage: 'place' }; }
        const now = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
        if (now && !C.stateMatches(now, c)) {
            r.fixed++; tried.add(q);
            const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z }, { raw: true, maxTicks: 300 });
            if (!m.ok) return { ...m, stage: 'redo' };
            continue;
        }
        r.placed++;
        return now && C.useMismatch(now, c) ? fixUse(c, env, r) : ok;
    }
    return bad('not_confirmed', { why: 'no placement recipe gave the wanted state', block: c.block, props: c.props, tried: tried.size }, 'state');
}

/** open / delay: right-click until the state is the wanted one (a trapdoor toggles once, a repeater steps its delay 1..4). */
async function fixUse(c, env, r) {
    for (let k = 0; k < 5; k++) {
        const b = env.w.blockAt ? env.w.blockAt(c.x, c.y, c.z) : null, um = C.useMismatch(b, c);
        if (!um) { r.fixed++; return ok; }
        const a = await env.exec('activate', { x: c.x, y: c.y, z: c.z }, { raw: true, maxTicks: 160 });
        if (!a.ok) return { ...a, stage: 'use' };
    }
    return bad('not_confirmed', { why: 'the block would not take the wanted state by right-clicking', block: c.block, props: c.props }, 'use');
}

/** A water or lava source (a bucket on the cell) or the water of a waterlogged block (a bucket on the block itself). */
async function pourCell(c, env, r) {
    const item = c.waterlog ? 'water_bucket' : C.itemFor(c.block);
    if (right(c, env.w)) { r.skipped++; return ok; }
    if (c.waterlog && nm(env.w, c.x, c.y, c.z) !== C.bare(c.of)) return bad('precondition_failed', { why: 'the block to waterlog is not there', block: c.of }, 'pour');
    if (env.have(item) < 1) return bad('missing_item', { item }, 'stock');
    const p = await env.exec('pour', { x: c.x, y: c.y, z: c.z, item, ...(c.waterlog ? { waterlog: true } : {}) }, { raw: true, maxTicks: 300 });
    if (!p.ok) return { ...p, stage: 'pour' };
    r.poured++;
    return ok;
}

module.exports = { runUnit, gateOf, pickNear, cellReady, readyLocal, right, placedName, buildCell, presentAt };

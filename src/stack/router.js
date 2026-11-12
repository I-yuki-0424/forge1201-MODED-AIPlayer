'use strict';
// The router of the command stack (docs/implemented/COMMAND-STACK-v1.md). It is the only place that knows what to do when an instruction's precondition does not hold.
//
//   top (operator, Pit, Build, gather)  ->  ROUTER  ->  instructions (src/skills, atomic: check, act or halt)  ->  body
//
// An instruction answers `precondition_failed` with the unmet conditions and the measured values; it never walks, equips or names a remedy. The router reads that answer AND the state
// (is the bot enclosed? how far is the target? what is in the hand?) and writes the chain: `mine` far from the block and the bot sealed in -> unstick, move, equip, mine; far and free ->
// move, equip, mine. The same error, two chains. After every step the state is read again (nothing is remembered but a no-progress guard), so a chain is never replayed blindly.
// Rule-based on purpose: the rules are the teacher a learned router or expert is later trained and judged against (docs/implemented/COMMAND-STACK-v1.md, "Learning").
const { reachableAsync } = require('../skills/planner');
const { standable } = require('../skills/world');
const { reachGoal, AIM_REACH, centre, hdist } = require('../skills/motion');
const { ENTITY_REACH } = require('../skills/geometry');
const { supports } = require('../skills/commands/block');

const ROUTED = new Set(['mine', 'place', 'activate', 'attack', 'pickup', 'tunnel']);
const MAX_STEPS = 8;              // instruction attempts, at most
const FAR = 28;                   // across: farther than this the target is walked to in legs (env.travel: router, legs, movement expert), not planned in one go
const CLOSED = 300;               // fewer reachable cells than this around the bot (planner reach, radius 32): a pocket or a shaft, not open ground
const FATAL = new Set(['died', 'disconnected', 'cancelled']);

/** The cell (block) or entity position the instruction works on, or null (tunnel: the bot's own cell). */
function targetOf(deps, name, args) {
    if (['mine', 'place', 'activate'].includes(name)) return { kind: 'block', x: args.x, y: args.y, z: args.z, name };
    if (name === 'attack' || name === 'pickup') {
        const bot = deps.bot;
        let e = args.entity !== undefined ? bot.entities[args.entity] : null;
        if (!e && args.item) {
            const me = bot.entity.position, dropped = (x) => (x && x.name === 'item' && x.getDroppedItem ? x.getDroppedItem() : null);
            e = Object.values(bot.entities).filter((x) => { const s = dropped(x); return s && s.name === args.item; }).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null;
        }
        return e ? { kind: 'entity', x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), pos: e.position, name } : null;
    }
    return null;
}

/** Standing cells from which the target is within reach (and in view), nearest to `here` first. */
function standCells(deps, t, here, { radius = 5, limit = 14 } = {}) {
    const w = deps.w, out = [];
    // What has to be in view: the block itself (mine, activate); for `place` the cell is air, so the supports it is placed against (as the command's own approach does); an entity: within arm's length.
    let isGoal = null;
    if (t.kind === 'block' && t.name === 'place') {
        const free = (c) => !(c.x === t.x && c.z === t.z && (c.y === t.y || c.y + 1 === t.y)), goals = supports(w, t).map((r) => reachGoal(w, r.cell, { face: r.face, reach: AIM_REACH - 0.5, ok: free }));
        isGoal = (c) => free(c) && goals.some((g) => g.isGoal(c));
    } else if (t.kind === 'block') {
        const g = reachGoal(w, t, { reach: AIM_REACH - 0.5, ok: (c) => !(c.x === t.x && c.z === t.z) });
        isGoal = (c) => g.isGoal(c);
    }
    // vertical window: eye 1.62 above the feet and a reach of 4.2 allow feet from 5 below the block to 3 above its top
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -5; dy <= 4; dy++) {
        const c = { x: t.x + dx, y: t.y + dy, z: t.z + dz };
        if (!standable(w, c.x, c.y, c.z)) continue;
        const ok = isGoal ? isGoal(c) : hdist(centre(c), t.pos) <= ENTITY_REACH - 0.8 && Math.abs(c.y - t.y) <= 1;
        if (ok) out.push({ ...c, d: Math.hypot(c.x - here.x, c.y - here.y, c.z - here.z) });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, limit).map(({ x, y, z }) => ({ x, y, z }));
}

/** Is the bot in a closed region (a pocket, a shaft)? `reach` is the planner's reachable set from its cell. Decidable: the search ran dry before it found `CLOSED` cells. */
const isClosed = (reach) => reach.cells.length < CLOSED;

/**
 * The rule table: (unmet conditions, state) -> the steps to take now, or a failure. Pure given `deps` (w, here), so it is tested without a server. Async only because the planner's reach
 * search is sliced (other bots run in between: 20 bots decide in one process).
 * Steps: {do:'travel', to}, {do:'unstick'}, {do:'move', to}, {do:'equip', item}.
 */
async function decide(deps, goal, unmet, st) {
    const needs = new Set(unmet.map((u) => u.need)), steps = [];
    const t = targetOf(deps, goal.name, goal.args), here = deps.here();
    const positional = needs.has('chunk_loaded') || needs.has('in_reach') || needs.has('line_of_sight');
    if (positional) {
        if (!t) return { fail: { reason: 'invalid_target', detail: { why: 'the target is gone' } } };
        const across = hdist(here, t);
        if (needs.has('chunk_loaded') || across > FAR) {
            if (st.travelled) return { fail: { reason: 'unreachable', detail: { why: needs.has('chunk_loaded') ? 'the target chunk is still not loaded after a long walk toward it' : 'still far after a long walk toward it', across: Math.round(across) } } };
            steps.push({ do: 'travel', to: t });
        } else {
            const reach = await reachableAsync(deps.w, here, { maxNodes: 2500, radius: 32 });
            const cands = standCells(deps, t, here), open = cands.filter((c) => reach.has(c.x, c.y, c.z));
            if (open.length) {
                steps.push({ do: 'move', to: open[0] });
            } else if (!cands.length) {
                // no cell from which the target could be reached exists at all (it is buried in rock): walking, travelling and unsticking cannot help; the caller (gather) digs toward it or skips it.
                // Before, a bot in its own tunnel (a closed region of a few dozen cells) was 'stuck' and dug itself back to the surface (acceptance, iron prospecting).
                return { fail: { reason: 'unreachable', detail: { why: 'no standing cell within reach of the target exists (it is inside rock)', region: reach.cells.length } } };
            } else if (isClosed(reach)) {
                // the target is outside the small region the bot is in: it is stuck, whatever else is the matter
                if (st.escaped >= 2) return { fail: { reason: 'stuck', detail: { why: 'enclosed, and two escapes did not open a way', region: reach.cells.length } } };
                steps.push({ do: 'unstick', region: reach.cells.length });
            } else if (!st.travelled) {
                steps.push({ do: 'travel', to: t, why: `no standing cell near the target is reachable by the planner (candidates ${cands.length}, reachable ${open.length}, region ${reach.cells.length}, start ${reach.cells.length ? 'in the planner' : 'NOT a planner cell'})` });       // the movement expert may still find a way
            } else {
                return { fail: { reason: 'unreachable', detail: { why: 'no standing cell within reach of the target can be walked to', candidates: cands.length } } };
            }
        }
    }
    for (const u of unmet) if ((u.need === 'tool_held' || u.need === 'item_held') && !steps.some((s) => s.do === 'equip' && s.item === u.item)) steps.push({ do: 'equip', item: u.item });
    // an item that is not in the pack at all comes first (it may take the bot elsewhere); the position and the hand are then read again
    for (const u of unmet) if (u.need === 'item_in_pack') steps.unshift({ do: 'obtain', item: u.item, count: u.count || 1 });
    if (!steps.length) return { fail: { reason: 'invalid_args', detail: { why: `no rule for ${[...needs].join(', ')}` } } };
    return { steps };
}

/** Run one step with the instruction layer / the walkers; {ok, reason, detail} like an instruction. */
async function perform(deps, s) {
    switch (s.do) {
        case 'move': return deps.exec('move_to', { x: s.to.x, y: s.to.y, z: s.to.z }, { atomic: true });
        case 'travel': return deps.travel({ x: s.to.x, y: s.to.y, z: s.to.z, level: s.to.y }, { near: 3, nearY: 3 });
        case 'unstick': return deps.escape ? deps.escape() : { ok: false, reason: 'stuck', detail: { why: 'no stuck-escape expert in this environment' } };
        case 'equip': return deps.exec('equip', { item: s.item }, { atomic: true });
        case 'obtain': return deps.obtain ? deps.obtain(s.item, s.count) : { ok: false, reason: 'missing_item', detail: { item: s.item, why: 'this environment cannot get items' } };
        default: return { ok: false, reason: 'internal', detail: { why: `unknown step ${s.do}` } };
    }
}

/**
 * Carry out the goal `{name, args}` (an instruction and its arguments, as the top sends them). Resolves to the instruction's result; `detail.router` lists the steps taken.
 * deps: { bot, w, here(), exec(name, args, opts) -> result (the action layer), travel(target, opts), escape(), cancelled() }
 */
async function run(deps, goal) {
    const chain = [], seen = new Map(), st = { travelled: false, escaped: 0 };
    let last = null;
    const done = (r) => (chain.length ? { ...r, detail: { ...(r.detail || {}), router: chain } } : r);
    for (let i = 0; i < MAX_STEPS; i++) {
        if (deps.cancelled && deps.cancelled()) return done({ ok: false, reason: 'cancelled', detail: {} });
        const r = await deps.exec(goal.name, goal.args, { atomic: true });
        if (r.ok || r.reason !== 'precondition_failed') return done(r);
        const unmet = (r.detail && r.detail.unmet) || [], here = deps.here();
        const key = JSON.stringify([unmet.map((u) => `${u.need}:${u.item || ''}`), here.x, here.y, here.z]);
        seen.set(key, (seen.get(key) || 0) + 1);
        if (seen.get(key) > 2) return done({ ok: false, reason: last && last.reason && !FATAL.has(last.reason) ? last.reason : 'stuck', detail: { why: 'the same unmet precondition at the same place after two attempts to fix it', unmet, last: last && last.detail } });
        const d = await decide(deps, goal, unmet, st);
        if (d.fail) return done({ ok: false, reason: d.fail.reason, detail: { ...d.fail.detail, unmet } });
        for (const s of d.steps) {
            const sr = await perform(deps, s);
            if (s.do === 'travel') st.travelled = true;
            if (s.do === 'obtain') chain.push({ do: 'obtain', item: s.item, count: s.count, ok: !!sr.ok, ...(sr.ok ? {} : { reason: sr.reason }), steps: sr.detail && sr.detail.steps });
            if (s.do === 'unstick') st.escaped++;
            if (s.do !== 'obtain') chain.push({ do: s.do, need: unmet.map((u) => u.need), ...(s.why ? { why: s.why } : {}), ...(s.to ? { to: [s.to.x, s.to.y, s.to.z] } : {}), ...(s.item ? { item: s.item } : {}), ...(s.region !== undefined ? { region: s.region } : {}), ok: !!sr.ok, ...(sr.ok ? {} : { reason: sr.reason }) });
            if (!sr.ok) { last = sr; if (FATAL.has(sr.reason)) return done(sr); break; }       // read the state again and decide again
        }
    }
    return done({ ok: false, reason: last && last.reason && !FATAL.has(last.reason) ? last.reason : 'stuck', detail: { why: `the router gave up after ${MAX_STEPS} attempts`, last: last && last.detail } });
}

module.exports = { run, decide, standCells, isClosed, targetOf, perform, ROUTED, FAR, CLOSED, MAX_STEPS };

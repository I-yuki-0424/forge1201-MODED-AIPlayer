'use strict';
// NAV, the walker (docs/implemented/NAV-v1.md): plan a segment with plan.js, carry it out with the action layer's own commands, replan, until the goal holds. One mover for every
// walk the bots make (env.travel: journeys, pit stations, the router's `travel` and `unstick` steps), in place of the chain voidnav -> learned walk -> chunk router -> legs -> movement expert.
//
// Temporary blocks are this file's business from placement to removal, so none outlives the walk that needed it (owner 2026-11-14, problem 1):
//   - a run of pillar steps in one column is ONE pillar move (each level breaks the block two below), so a climb of n levels leaves one block, under the feet at the top;
//   - a bridge across a gap takes each block away once the bot has passed it (bridge move without `keep`), so it too leaves one block, under the feet;
//   - that last block, and any registered block of this bot within reach, is broken as soon as the bot stands on something else, before the next segment;
//   - removal never walks: what is out of reach stays registered for the next pass, and the walk's result says so (`left`). The cleanup's own moves never place a block.
const P = require('./plan');
const night = require('./shelter');
const fixtures = require('../skills/fixtures');

const FATAL = new Set(['died', 'disconnected', 'cancelled', 'wrong_dimension']);
const WALKS = new Set(['walk', 'up', 'drop', 'swim', 'climb']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const TRACE = !!process.env.NAV_TRACE;
const say = (env, m) => { if (TRACE) console.log(`[nav] ${env.bot ? env.bot.username : '?'} ${m}`); };

/**
 * The watch over a walk (owner 2026-11-14, Move A: a bot was blown up by a creeper 20 s after it set out, Normal difficulty at night). A hostile mob that comes close stops the step at once
 * (the walker's cancel token) and is fought (the action layer's `attack`, sword first); hunger is fed between steps. Melee mobs within 4.5 blocks and level, a creeper within 7.
 */
const MOBS = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|spider|cave_spider|creeper|witch|pillager|vindicator|slime|silverfish|endermite|phantom|breeze|parched|zombie_nautilus|camel_husk)$/;
function watch(env) {
    const bot = env.bot;
    // hurt a moment ago: the shooter is fought too (a skeleton or a pillager within 16; T26: bots were shot dead walking on)
    let hp = bot && bot.health, hurtAt = 0;
    const onHealth = () => { if (Number.isFinite(hp) && bot.health < hp) hurtAt = Date.now(); hp = bot.health; };
    if (bot && bot.on) bot.on('health', onHealth);
    const dispose = () => { if (bot && bot.removeListener) bot.removeListener('health', onHealth); };
    const danger = () => {
        if (!bot || !bot.entity || !bot.entities) return null;
        const p = bot.entity.position, hurt = Date.now() - hurtAt < 3000; let best = null;
        for (const e of Object.values(bot.entities)) {
            if (!e || e === bot.entity || !e.position || !MOBS.test(String(e.name || ''))) continue;
            const d = e.position.distanceTo(p), r = e.name === 'creeper' ? 7 : hurt ? 16 : 4.5;
            if (d <= r && Math.abs(e.position.y - p.y) <= (hurt ? 8 : 3) && (!best || d < best.d)) best = { id: e.id, name: e.name, d };
        }
        return best;
    };
    const base = env.cancel || { cancelled: false };
    // The fighting itself is the fight reflex's (work/bot/reflex.js: in sight only, for every command). The walk only notices that a reflex took the body (its step comes back
    // cancelled) and plans again; stopping a step for a mob it could not see (behind a wall, across water) cost T26 two walks ("eight segments without getting closer").
    const token = { get cancelled() { return !!base.cancelled; }, fighting: false };
    const fight = async () => {
        token.fighting = true; let fought = 0;
        try {
            for (let i = 0; i < 8 && !base.cancelled; i++) {
                const t = danger(); if (!t) break;
                fought++;
                const r = await env.exec('attack', { entity: t.id }, { raw: true, maxTicks: 240, cancel: base });
                if (r && ['died', 'disconnected'].includes(r.reason)) return { fought, ended: r.reason };
            }
        } finally { token.fighting = false; }
        return { fought };
    };
    const feed = async () => { if (bot && bot.food !== undefined && (bot.food <= 14 || (bot.health < 12 && bot.food < 20))) await env.exec('eat', {}, { raw: true, maxTicks: 200, cancel: base }); };
    return { danger, token, fight, feed, dispose };
}

/** What breaking a block costs with the bot's pack (null: never). Hardness 0..~5 with the right tool, more by hand; obsidian and harder, and unbreakable blocks, are never broken by a walk. */
function digCostFor(bot) {
    const reg = bot.registry, tools = new Set(bot.inventory.items().map((i) => i.type));
    const memo = new Map();
    return (name) => {
        if (memo.has(name)) return memo.get(name);
        const b = reg.blocksByName[name];
        let c = null;
        if (b && b.diggable !== false && Number.isFinite(b.hardness) && b.hardness >= 0 && b.hardness < 20 && !fixtures.isBox(name) && !fixtures.isBed(name) && !/^(chest|trapped_chest|ender_chest|barrel|furnace|blast_furnace|smoker|crafting_table|spawner|end_portal_frame|bedrock|reinforced_deepslate)$/.test(name)) {
            const harvest = !b.harvestTools || Object.keys(b.harvestTools).some((id) => tools.has(Number(id)));
            const toolFits = b.material && bot.inventory.items().some((i) => reg.items[i.type] && /_(pickaxe|axe|shovel|hoe|sword)$/.test(reg.items[i.type].name) && String(b.material).includes(reg.items[i.type].name.split('_').pop()));
            c = b.hardness * (toolFits ? 0.5 : harvest ? 2.5 : 6);
            if (c > 12) c = null;                                                  // by hand through stone: walk round instead
        }
        memo.set(name, c);
        return c;
    };
}

/** Cells the walk must leave alone: containers and beds, another bot's temporary blocks (it may stand on them), the feet cell of another bot. */
function protectedFor(env) {
    const bot = env.bot, w = env.w, T = bot && bot.__temps, dim = fixtures.dimOf(bot), me = bot && bot.username;
    const spots = env.spots ? env.spots() : [];
    return (x, y, z) => {
        const n = String((w.nameAt && w.nameAt(x, y, z)) || '');
        if (fixtures.isBox(n) || fixtures.isBed(n)) return true;
        if (bot && bot.__keep && bot.__keep(x, y, z)) return true;                                  // a cell of the structure the bot is building
        const r = T && T.get(dim, { x, y, z });
        if (r && r.by && r.by !== me) return true;
        return spots.some((s) => s.name !== me && Math.floor(s.x) === x && Math.floor(s.z) === z && (Math.floor(s.y) - 1 === y || Math.floor(s.y) === y || Math.floor(s.y) + 1 === y));
    };
}

/** Break the movement blocks of this bot within reach (never the one under its feet, never walking for it). Returns {removed, left: [cells out of reach]}. */
async function tidy(env, { reach = 4.2 } = {}) {
    const bot = env.bot, T = bot && bot.__temps, out = { removed: 0, left: [] };
    if (!T) return out;
    const dim = fixtures.dimOf(bot), me = bot.username, f = env.here();
    const mine = T.list((r) => r.dim === dim && r.by === me && (r.kind === 'pillar' || r.kind === 'bridge' || r.kind === 'scaffold' || r.kind === 'reflex'));
    for (const r of mine) {
        if (env.cancel && env.cancel.cancelled) break;
        if (env.w.kindAt(r.x, r.y, r.z) !== 'solid') { T.remove(dim, r); continue; }                  // gone already
        const nm = String((env.w.nameAt && env.w.nameAt(r.x, r.y, r.z)) || '');
        if ((r.item && !nm.endsWith(String(r.item).replace(/^minecraft:/, ''))) || (bot.__keep && bot.__keep(r.x, r.y, r.z))) { T.remove(dim, r); continue; }      // another block there now (a wall of the build took the cell): not ours any more
        const P0 = bot.entity.position, under = r.y === f.y - 1 && P0.x + 0.3 > r.x && P0.x - 0.3 < r.x + 1 && P0.z + 0.3 > r.z && P0.z - 0.3 < r.z + 1;
        if (under) { out.left.push(r); continue; }           // standing on it, the feet cell or the edge of the body (a bot on a wall's edge fell when its pillar block went: a loop of pillar, step, fall)
        const p = bot.entity.position, d = Math.hypot(r.x + 0.5 - p.x, r.y + 0.5 - (p.y + 1.62), r.z + 0.5 - p.z);
        if (d > reach + 0.6) { out.left.push(r); continue; }
        let m = await env.exec('mine', { x: r.x, y: r.y, z: r.z, collect: true }, { raw: true, maxTicks: 200 });
        if (!m.ok && env.w.kindAt(r.x, r.y, r.z) === 'solid') m = await env.exec('mine', { x: r.x, y: r.y, z: r.z, collect: false, blind: true }, { raw: true, maxTicks: 200 });
        if (m.ok || env.w.kindAt(r.x, r.y, r.z) !== 'solid') { T.remove(dim, r); out.removed++; } else out.left.push(r);
    }
    return out;
}

/** A standing cell next to `here` on ground that is not a registered block, still a goal cell: where the bot steps to take away the block it stands on. */
function stepOff(env, here, goal) {
    const w = env.w, T = env.bot && env.bot.__temps, dim = fixtures.dimOf(env.bot);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, 1, -1]) {
        const c = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
        if (P.nodeKindOf(P.view(w), c.x, c.y, c.z, false) !== 'stand') continue;
        if (T && T.has(dim, { x: c.x, y: c.y - 1, z: c.z })) continue;
        if (goal.is({ ...c, kind: 'stand' })) return c;
    }
    return null;
}

/** The plan cut into steps the action layer runs: walks (one move_to to the end of a run of walking moves), digs, a pillar run, a bridge run, a dig down. */
function steps(path) {
    const out = [];
    for (let i = 1; i < path.length; i++) {
        const n = path[i], last = out[out.length - 1];
        if (WALKS.has(n.move) && !(n.dig && n.dig.length)) { if (last && last.kind === 'walk' && last.cells.length < 16) last.cells.push(n); else out.push({ kind: 'walk', cells: [n] }); continue; }
        if (n.move === 'pillar') { if (last && last.kind === 'pillar' && last.cells[last.cells.length - 1].x === n.x && last.cells[last.cells.length - 1].z === n.z) last.cells.push(n); else out.push({ kind: 'pillar', cells: [n] }); continue; }
        if (n.move === 'bridge') { if (last && last.kind === 'bridge' && last.cells[last.cells.length - 1].y === n.y && last.cells.length < 32) last.cells.push(n); else out.push({ kind: 'bridge', cells: [n] }); continue; }
        out.push({ kind: n.move === 'digdown' ? 'digdown' : 'dig', cells: [n] });
    }
    return out;
}

/** Break `c` until it is passable (a falling block above it refills it: up to six times). */
async function clearCell(env, c) {
    for (let i = 0; i < 6; i++) {
        const k = env.w.kindAt(c.x, c.y, c.z);
        if (k === 'air' || k === 'climb' || k === 'water') return { ok: true };
        let m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false }, { raw: true, maxTicks: 400 });
        if (!m.ok && env.w.kindAt(c.x, c.y, c.z) === 'solid' && !FATAL.has(m.reason)) m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false, blind: true }, { raw: true, maxTicks: 400 });
        if (!m.ok && FATAL.has(m.reason)) return m;
        if (!m.ok && env.w.kindAt(c.x, c.y, c.z) === 'solid') return m;
        await sleep(120);
    }
    return { ok: env.w.kindAt(c.x, c.y, c.z) !== 'solid', reason: 'stuck', detail: { why: 'a falling block keeps filling the cell', cell: c } };
}

/** Carry out one step; {ok, reason?, detail?}. */
async function perform(env, s) {
    const end = s.cells[s.cells.length - 1];
    switch (s.kind) {
        case 'walk': {
            const r = await env.exec('move_to', { x: end.x, y: end.y, z: end.z }, { raw: true, maxTicks: 60 + 40 * s.cells.length });
            if (r.ok || FATAL.has(r.reason)) return r;
            // the action layer's own planner may not take the same way: cell by cell
            for (const c of s.cells) { const q = await env.exec('move_to', { x: c.x, y: c.y, z: c.z }, { raw: true, maxTicks: 120 }); if (!q.ok) return q; }
            return { ok: true };
        }
        case 'dig': {
            for (const c of end.dig) { const r = await clearCell(env, c); if (!r.ok) return r; }
            return env.exec('move_to', { x: end.x, y: end.y, z: end.z }, { raw: true, maxTicks: 160 });
        }
        case 'digdown': {
            const f0 = env.here();
            const r = await clearCell(env, end.dig[0]);
            if (!r.ok) return r;
            for (let i = 0; i < 40; i++) { const f = env.here(); if (f.y < f0.y && env.bot.entity.onGround) return { ok: true }; await sleep(100); }
            return { ok: false, reason: 'stuck', detail: { why: 'the floor was broken but the bot did not come down' } };
        }
        case 'pillar': {
            for (const n of s.cells) for (const c of n.dig) { /* the pillar move clears the head room itself */ void c; }
            return env.run('pillar', { levels: s.cells.length });
        }
        case 'bridge': {
            const f = env.here();
            return env.run('bridge', { y: f.y, cells: s.cells.map((c) => ({ x: c.x, z: c.z })) });
        }
        default: return { ok: false, reason: 'internal', detail: { why: `no step ${s.kind}` } };
    }
}

/**
 * Walk to `target`: {x, z, y?} (a cell; without y the column at any level), {x, z, level} (that column, near that level), or {surface: true} (a standing cell under the open sky).
 * `o`: near (default 1), nearY (default 1; 8 for a level), noPlace (no pillar or bridge), noDig, maxSegments (default 80), maxNodes (per segment, default 14000).
 * `env`: w, here(), exec(name, args, opts), run(name, args), bot, cancel?, spots?, wrongDim?.
 * Returns {ok, reason?, detail: {segments, steps, pillars, bridges, digs, removed, left, at}}.
 */
async function go(env0, target, o = {}) {
    const W = watch(env0);
    try { return await walk(W, env0, target, o); } finally { W.dispose(); }
}

async function walk(W, env0, target, o) {
    const env = Object.create(env0);
    env.exec = (n, a, opt = {}) => env0.exec(n, a, { ...opt, cancel: opt.cancel || W.token });
    env.run = env0.run;
    const bot = env.bot, info = { segments: 0, steps: 0, pillars: 0, bridges: 0, digs: 0, removed: 0, left: 0, replans: 0, fights: 0 };
    const surface = !!target.surface;
    const lvl = Number.isInteger(target.level) && !Number.isInteger(target.y);
    const t = surface ? null : { x: target.x, y: Number.isInteger(target.y) ? target.y : (lvl ? target.level : undefined), z: target.z };
    const near = o.near === undefined ? 1 : o.near, nearY = o.nearY === undefined ? (lvl ? 8 : 1) : o.nearY;
    const goal = surface ? P.surfaceGoal(env.w, env.here()) : P.cellGoal(t, { near, nearY });
    const done = (r) => ({ ...r, detail: { ...(r.detail || {}), nav: { ...info, at: env.here() } } });
    say(env, `goal ${surface ? 'surface' : JSON.stringify(t)} near ${near}/${nearY}${o.why ? ' (' + o.why + ')' : ''} from ${JSON.stringify(env.here())}${TRACE ? ' <- ' + String(new Error().stack).split('\n').slice(3, 7).map((l) => l.trim().replace(/^at /, '').replace(/\(\/app\//, '(')).join(' < ') : ''}`);
    let bestD = surface ? Infinity : hd(env.here(), t), still = 0, failsHere = 0, lastFail = null;
    const maxSeg = o.maxSegments || 80;
    for (let seg = 0; seg < maxSeg; seg++) {
        if (env0.cancel && env0.cancel.cancelled) return done({ ok: false, reason: 'cancelled' });
        if (env.wrongDim && env.wrongDim()) return done({ ok: false, reason: 'wrong_dimension' });
        const here = env.here();
        if (goal.is({ ...here, kind: 'stand' })) {
            let td = await tidy(env); info.removed += td.removed;
            // standing on its own last block (the top of a pillar, the end of a bridge): one step onto natural ground that still satisfies the goal, then that block goes too
            if (td.left.some((r) => r.x === here.x && r.z === here.z && r.y === here.y - 1)) {
                const off = stepOff(env, here, goal);
                if (off && (await env.exec('move_to', off, { raw: true, maxTicks: 120 })).ok) { td = await tidy(env); info.removed += td.removed; }
            }
            info.left = td.left.length;
            return done({ ok: true, ...(td.left.length ? { left: td.left.map((r) => ({ x: r.x, y: r.y, z: r.z })) } : {}) });
        }
        // the night under the open sky: fight what is close, then dig in until the morning (shelter.js); `noShelter` for walks that must not wait (a reflex, the cleanup)
        if (!o.noShelter && night.isNight(bot) && P.seesSky(env.w, here.x, here.y, here.z)) {
            const sh = await night.shelter(env, digCostFor(bot), { cancel: env0.cancel });
            info.nights = (info.nights || 0) + 1; info.waited = (info.waited || 0) + (sh.waited || 0);
            say(env, `night: ${sh.ok ? `sheltered ${sh.waited} s` : sh.reason}`);
            if (sh.ok && sh.waited) continue;                                      // the morning: plan again from the hole
        }
        // the plan: the goal, or (beyond the loaded chunks) the reachable cell nearest it, not deep under the start
        const y0 = here.y, score = surface ? (n) => goal.h(n) : (n) => goal.h(n) + 0.6 * Math.max(0, y0 - n.y - 2);
        // under water (sunk in a lake or the sea, T26 move_a: "not standing anywhere the planner can start from" at the sea floor, a pillar tried from the bottom): up to the surface first
        if (bot && bot.entity && bot.entity.isInWater && !P.nodeKindOf(P.view(env.w), here.x, here.y, here.z, false)) {
            bot.setControlState('jump', true);
            for (let i = 0; i < 60 && bot.entity.isInWater && !P.nodeKindOf(P.view(env.w), env.here().x, env.here().y, env.here().z, false); i++) await sleep(100);
            bot.setControlState('jump', false);
            if (P.nodeKindOf(P.view(env.w), env.here().x, env.here().y, env.here().z, false)) continue;
        }
        const start = { ...here, ...(bot && bot.entity && bot.entity.onGround && !bot.entity.isInWater ? { ground: true } : {}) };           // on a slab, a fence top, a bed: a start the grid would not call a node
        const plan = await P.planAsync(env.w, start, goal, { dig: digCostFor(bot), protectedCell: protectedFor(env), noPlace: !!o.noPlace, noDig: !!o.noDig, maxNodes: o.maxNodes || 14000, score });
        info.segments++;
        if (!plan) {
            // not on a node (in a bush, half in a wall, mid-air): let the body settle, then the action layer's walk to the nearest cell
            await sleep(400);
            if (++failsHere > 4) return done({ ok: false, reason: 'stuck', detail: { why: 'the bot is not standing anywhere the planner can start from', at: here } });
            continue;
        }
        say(env, `seg ${seg} from ${here.x},${here.y},${here.z}: ${plan.partial ? 'partial' : 'full'} plan, ${plan.path.length - 1} moves (${[...new Set(plan.path.slice(1).map((n) => n.move))].join(',')}), ${plan.expanded} cells`);
        if (plan.path.length <= 1) return done({ ok: false, reason: 'unreachable', detail: { why: plan.partial ? 'no move gets the bot any closer (every way is closed or unsafe)' : 'no way', expanded: plan.expanded } });
        const list = steps(plan.path);
        let failed = null;
        for (const s of list) {
            if (env0.cancel && env0.cancel.cancelled) return done({ ok: false, reason: 'cancelled' });
            await W.feed();
            const r = await perform(env, s);
            if (!r.ok && r.reason === 'cancelled' && !(env0.cancel && env0.cancel.cancelled)) { for (let i = 0; i < 150 && bot && bot.__preempt; i++) await sleep(100); info.fights++; failed = { step: s.kind, reason: 'interrupted', at: env.here(), reflex: true }; break; }
            info.steps++;
            if (s.kind === 'pillar') info.pillars += s.cells.length; else if (s.kind === 'bridge') info.bridges += s.cells.length; else if (s.kind === 'dig' || s.kind === 'digdown') info.digs++;
            say(env, `  ${s.kind} x${s.cells.length} -> ${s.cells[s.cells.length - 1].x},${s.cells[s.cells.length - 1].y},${s.cells[s.cells.length - 1].z}: ${r.ok ? 'ok' : r.reason + ' ' + JSON.stringify(r.detail || {}).slice(0, 200)}`);
            if (!r.ok) { failed = { step: s.kind, reason: r.reason, why: r.detail && (r.detail.why || r.detail.goal), at: env.here() }; if (FATAL.has(r.reason)) return done({ ok: false, reason: r.reason, detail: { failed } }); break; }
            // a movement block of this bot that it no longer stands on goes now
            if (s.kind === 'walk' || s.kind === 'dig' || s.kind === 'digdown') { const td = await tidy(env); info.removed += td.removed; }
        }
        if (failed) {
            info.replans++;
            const k = `${failed.at.x},${failed.at.y},${failed.at.z}:${failed.step}`;
            if (failed.reason !== 'interrupted') { failsHere = k === lastFail ? failsHere + 1 : 1; lastFail = k; }
            if (failsHere >= 4) return done({ ok: false, reason: failed.reason || 'stuck', detail: { why: `the same step failed four times here: ${failed.step} (${failed.why || failed.reason})`, failed } });
            await sleep(250);
        }
        const now = env.here(), d = surface ? 0 : hd(now, t);
        if (!surface && !(failed && failed.reason === 'interrupted')) { if (d < bestD - 2) { bestD = d; still = 0; } else if (++still >= 8) return done({ ok: false, reason: 'stuck', detail: { why: `eight segments without getting closer (${Math.round(d)} blocks left)`, failed } }); }
    }
    return done({ ok: false, reason: 'timeout', detail: { why: `more than ${maxSeg} segments` } });
}

/**
 * The end of a job (or anything that wants none left): walk to each movement block of this bot still registered in its dimension, nearest first, never placing a block on the way, and break it.
 * Returns {removed, left}. `max` blocks per call.
 */
async function sweep(env, { max = 60 } = {}) {
    const bot = env.bot, T = bot && bot.__temps, out = { removed: 0, left: 0 };
    if (!T) return out;
    const dim = fixtures.dimOf(bot), me = bot.username;
    for (let i = 0; i < max; i++) {
        if (env.cancel && env.cancel.cancelled) break;
        const f = env.here(), list = T.list((r) => r.dim === dim && r.by === me && ['pillar', 'bridge', 'scaffold', 'reflex'].includes(r.kind)).sort((a, b) => Math.hypot(a.x - f.x, a.y - f.y, a.z - f.z) - Math.hypot(b.x - f.x, b.y - f.y, b.z - f.z));
        if (!list.length) break;
        const r = list[0];
        if (env.w.kindAt(r.x, r.y, r.z) === 'unknown' && Math.hypot(r.x - f.x, r.z - f.z) > 100) { out.left = list.length; break; }
        const before = T.size;
        let td = await tidy(env); out.removed += td.removed;
        if (T.size < before) continue;
        const t = { x: r.x, y: r.y + 1, z: r.z }, opt = { near: 3, nearY: 3, noPlace: true, noShelter: true, maxSegments: 12 };
        const g = env.nav ? await env.nav(t, opt) : await go(env, t, opt);
        td = await tidy(env); out.removed += td.removed;
        if (T.size >= before) { if (!g.ok) T.remove(dim, r); out.left++; }          // unreachable without placing: forgotten (reported), not walked to for ever
    }
    return out;
}

module.exports = { go, tidy, sweep, steps, digCostFor, protectedFor, perform };

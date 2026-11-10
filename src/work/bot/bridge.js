'use strict';
// Working where the floor is an abyss (owner 2026-11-09). Two moves written like the others in moves.js (an `async (ctx, args)` over per-tick input frames, NOT in the RL action
// matrix) and the one routine that uses them:
//   bridge     {y, cells: [{x, z}...], items?}  walk out along `cells` on level y, laying a block under the next cell wherever there is none ("ninja bridging": sneak, so that the
//              body cannot leave the block it stands on, walk to the very edge, put the block against the side face of the one under the feet, step onto it)
//   sneak_walk {y, cells}                       walk along cells with sneak held (the way back: a normal walk could step off a one-block-wide bridge)
//   workOver(env, work, opt)                    bridge to a cell beside `work`, do the job there (mine / place / nothing), walk back to the safe cell: the end. The bridge stays.
// Why a bridge and not "place a block, break it": the block you break is the one you stand next to, the next must be placed, broken ... it never ends (owner). Nothing is broken here.
// Live-untested (owner: operation testing is not needed for this batch); the planning is tested on a fake world (tests/test_work_bridge_pure.js).
const { SkillError } = require('../../skills/runner');
const { feetCell, aimAtBlock } = require('../../skills/motion');
const { holdItem, count } = require('../../skills/commands/item');
const { FACES } = require('../../skills/geometry');
const abyss = require('./abyss');
const tempblocks = require('./tempblocks');

// Cheap blocks that do not fall (never sand or gravel: they would drop into the abyss) and are common where an abyss is: End stone, blackstone, netherrack.
const BRIDGE_ITEMS = ['cobblestone', 'cobbled_deepslate', 'netherrack', 'end_stone', 'blackstone', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'basalt'];
const FREE = new Set(['air', 'climb']);
const yawOf = (dx, dz) => Math.atan2(-dx, -dz);
const FALL = 1.2;                    // lower than the level it walks on by this much = it has stepped off

const fellIf = (ctx, y, placed) => { if (ctx.bot.entity.position.y < y - FALL) throw new SkillError('stuck', { why: 'the bot left the bridge (it is falling)', level: y, done: placed }); };

/** One block under the next cell, then onto it. `F`: the feet cell the bot stands in, `N`: the cell to go to (one step along x or z). */
async function extend(ctx, y, F, N, items, placed) {
    const bot = ctx.bot, w = ctx.world, dx = N.x - F.x, dz = N.z - F.z;
    if (Math.abs(dx) + Math.abs(dz) !== 1) throw new SkillError('invalid_args', { why: 'bridge cells must follow each other one step along x or z', from: F, to: N });
    const yaw = yawOf(dx, dz), walk = { forward: true, sneak: true, yaw, pitch: 0 };
    const floor = { x: N.x, y: y - 1, z: N.z }, support = { x: F.x, y: y - 1, z: F.z };
    if (w.kindAt(floor.x, floor.y, floor.z) === 'air') {
        const item = BRIDGE_ITEMS.find((n) => bot.registry.blocksByName[n] && count(bot, n) >= 1) || tempblocks.choose(bot.inventory.items().map((i) => ({ name: i.name, count: i.count })), bot.registry, { valueOf: require('./janitor').valueOf });
        if (!item) throw new SkillError('missing_item', { item: BRIDGE_ITEMS[0], why: 'no block to bridge with (cobblestone, netherrack, end stone ...)', tried: BRIDGE_ITEMS, done: placed.length });
        if (w.kindAt(support.x, support.y, support.z) !== 'solid') throw new SkillError('invalid_target', { why: 'nothing solid under the feet to place against', cell: support, done: placed.length });
        await holdItem(ctx, item);
        // To the very edge of the block under the feet: the sneaking body cannot go farther, and from there the side face is in view.
        const off = () => { const p = bot.entity.position; return (p.x - (F.x + 0.5)) * dx + (p.z - (F.z + 0.5)) * dz; };
        ctx.phase('bridge_edge', { cell: F });
        await ctx.until(() => { fellIf(ctx, y, placed.length); return off() >= 0.6; }, 40, 'stuck', walk);
        await ctx.idle(2);
        const face = FACES.findIndex((f) => f[0] === dx && f[1] === 0 && f[2] === dz);
        ctx.phase('bridge_place', { cell: floor, against: support });
        await aimAtBlock(ctx, support, { face, frame: { sneak: true } });
        const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak: true };
        await ctx.tick({ ...look, use: true });
        await ctx.tick(look);
        await ctx.until(() => w.blockAt(floor.x, floor.y, floor.z)?.name === item, 12, 'not_confirmed', look);
        placed.push(floor);
        if (bot.__temps) bot.__temps.add({ dim: require('../../skills/fixtures').dimOf(bot), x: floor.x, y: floor.y, z: floor.z, item, kind: ctx.__road ? 'road' : 'bridge', by: bot.username });          // the shared list (temps.js): a bridge block is a movement block; a road (the shared way from the platform to the work) stays
    }
    await ctx.until(() => { fellIf(ctx, y, placed.length); const f = feetCell(bot.entity.position); return f.x === N.x && f.z === N.z && f.y === y && bot.entity.onGround; }, 40, 'stuck', walk);
}

/** bridge {y, cells, items?}: see the top of the file. Returns { placed: [cells], at: the feet cell }. */
async function bridge(ctx, { y, cells, keep = false, road = false }) {
    const bot = ctx.bot;
    if (!Number.isInteger(y) || !Array.isArray(cells) || !cells.length || cells.length > 64) throw new SkillError('invalid_args', { why: 'y and 1..64 cells {x, z}' });
    if (!bot.entity.onGround) await ctx.until(() => bot.entity.onGround, 40, 'stuck');
    const placed = [];
    ctx.__road = !!road;
    for (const N of cells) {
        const F = feetCell(bot.entity.position);
        if (F.y !== y) throw new SkillError('invalid_target', { why: `the bot stands at y ${F.y}, the bridge is at y ${y}`, at: F });
        await extend(ctx, y, F, N, BRIDGE_ITEMS, placed);
        // Passed = not needed (owner 2026-11-10: "once a placed block has been passed, destroy it immediately"): the block the bot stood on one step ago, if the bot laid it, is taken away from
        // here, as the pillar takes the one two below. A bridge that must be walked back (`keep`: workOver) stays until the way back has been walked.
        if (!keep && !road) {
            const old = { x: F.x, y: y - 1, z: F.z }, T = bot.__temps, dim = require('../../skills/fixtures').dimOf(bot), rec = T && T.get(dim, old);
            if (rec && rec.kind === 'bridge' && rec.by === bot.username) {
                ctx.phase('bridge_unlay', { cell: old });
                const r = await require('../../skills/commands/block').mine(ctx, { ...old, collect: false, blind: true }).then(() => null, (e) => e);
                if (r && !(r instanceof SkillError && ['invalid_target', 'missing_tool', 'unreachable'].includes(r.reason))) throw r;
            }
        }
    }
    return { placed, at: feetCell(bot.entity.position) };
}

/** sneak_walk {y, cells}: along the cells, sneaking, one at a time (each at most 40 ticks). */
async function sneakWalk(ctx, { y, cells, unlay = false }) {
    const bot = ctx.bot;
    let prev = feetCell(bot.entity.position);
    if (!Number.isInteger(y) || !Array.isArray(cells) || !cells.length || cells.length > 128) throw new SkillError('invalid_args', { why: 'y and 1..128 cells {x, z}' });
    for (const N of cells) {
        const frame = () => { const p = bot.entity.position; return { forward: true, sneak: true, pitch: 0, yaw: yawOf(N.x + 0.5 - p.x, N.z + 0.5 - p.z) }; };
        ctx.phase('sneak_walk', { to: N });
        await ctx.until(() => { fellIf(ctx, y, 0); const f = feetCell(bot.entity.position), p = bot.entity.position; return f.x === N.x && f.z === N.z && Math.hypot(p.x - (N.x + 0.5), p.z - (N.z + 0.5)) < 0.35; }, 40, 'stuck', frame);
        // Walking back over a kept bridge (unlay): the block just left is taken away, one step behind the bot, so that nothing of the bridge is left once it is home.
        if (unlay && bot.__temps) {
            const old = { x: prev.x, y: y - 1, z: prev.z }, T = bot.__temps, dim = require('../../skills/fixtures').dimOf(bot), rec = T.get(dim, old);
            if (rec && rec.kind === 'bridge' && rec.by === bot.username && (old.x !== N.x || old.z !== N.z)) {
                ctx.phase('bridge_unlay', { cell: old });
                const r = await require('../../skills/commands/block').mine(ctx, { ...old, collect: false, blind: true }).then(() => null, (e) => e);
                if (r && !(r instanceof SkillError && ['invalid_target', 'missing_tool', 'unreachable'].includes(r.reason))) throw r;
            }
        }
        prev = N;
    }
    return { at: feetCell(bot.entity.position) };
}

const MOVES = {
    bridge: { fn: bridge, ticks: (a) => 120 + 160 * ((a.cells && a.cells.length) || 1) },
    sneak_walk: { fn: sneakWalk, ticks: (a) => 80 + 60 * ((a.cells && a.cells.length) || 1) },
};

/**
 * Do `opt.job` at `work` {x, y, z} that lies over (or beyond) a gap, from the safe feet cell `opt.from` (default: where the bot stands): bridge to a cell beside it, do the job,
 * walk back to `from`. The result is the job's, with `detail.bridge` {from, stand, placed, returned} either way; a bridge that failed half way is walked back too.
 * `env`: here(), w, run(name, args), exec(name, args), goBack?() (the server puts it back on its feet when the walk back fails), cancel?.
 * `opt`: { from, minY (the dimension's floor, default -64), maxLen (blocks of bridge, default 40), job: 'mine' | 'place' | null, item (for place), collect }
 */
async function workOver(env, work, opt = {}) {
    const from = opt.from || env.here(), minY = Number.isInteger(opt.minY) ? opt.minY : -64;
    const info = { from, placed: [], returned: false };
    const stands = abyss.standCells(env.w, work, from).filter((c) => c.y === from.y);
    if (!stands.length) return { ok: false, reason: 'invalid_target', detail: { why: 'no free cell beside the work cell at the level of the bridge', work, bridge: info } };
    let plan = null, tried = [];
    for (const s of stands) { const p = abyss.plan(env.w, from, s, { maxLen: opt.maxLen || 40 }); if (p.ok) { plan = p; info.stand = s; break; } tried.push({ stand: s, reason: p.reason, why: p.detail && p.detail.why }); }
    if (!plan) return { ok: false, reason: tried[0].reason, detail: { why: tried[0].why, tried, work, bridge: info } };
    info.length = plan.length; info.toPlace = plan.place.length;
    // The way back is the way out, cell by cell, from wherever on it the bot stands; off the route (it was pushed) only the server can put it back.
    const back = async () => {
        const route = [from, ...plan.path], h0 = env.here(), i = route.findIndex((c) => c.x === h0.x && c.z === h0.z);
        if (i === 0) { info.returned = true; return; }
        if (i > 0) {
            const r = await env.run('sneak_walk', { y: from.y, cells: route.slice(0, i).reverse().map((c) => ({ x: c.x, z: c.z })), unlay: true });
            const h = env.here(); info.returned = !!r.ok && h.x === from.x && h.z === from.z;
        }
        if (!info.returned && env.goBack) { const g = await env.goBack('back from a bridge'); info.returned = !!g.ok; info.goBack = true; }
    };
    let result;
    for (const seg of plan.segments) {
        if (env.cancel && env.cancel.cancelled) { result = { ok: false, reason: 'cancelled', detail: {} }; break; }
        const r = await env.run('bridge', { y: from.y, cells: seg.cells.map((c) => ({ x: c.x, z: c.z })), keep: true });          // kept: the bot walks back over it, and takes it away then
        if (r.detail && r.detail.placed) info.placed.push(...r.detail.placed);
        if (!r.ok) { result = { ok: false, reason: r.reason, detail: { ...(r.detail || {}), stage: 'bridge' } }; break; }
    }
    if (!result) {
        if (opt.job === 'mine') result = await env.exec('mine', { x: work.x, y: work.y, z: work.z, collect: opt.collect !== false });
        else if (opt.job === 'place') result = await env.exec('place', { x: work.x, y: work.y, z: work.z, item: opt.item });
        else result = { ok: true, detail: {} };
    }
    await back();
    const out = { ok: result.ok !== false, reason: result.ok === false ? result.reason : null, detail: { ...(result.detail || {}), bridge: info } };
    if (out.ok && !info.returned) return { ok: false, reason: 'stuck', detail: { ...out.detail, why: 'the work is done but the bot could not walk back to the safe cell' } };
    return out;
}

/**
 * The bridge from the safe feet cell `from` toward the column of `to` {x, z}, on `from`'s level, as far as it goes: it ends on the first cell that has solid ground under it (land), or
 * in front of a wall (the flank of an island: the walk or the dig goes on from there), a cell not loaded, a fluid, or after `maxLen` placed blocks. Pure. Same shape as `abyss.plan`,
 * plus `landed` (the end has solid ground) and `stop` (why it ended: 'land' | 'wall' | 'not_loaded' | 'hazard' | 'length' | 'target'). Nothing to place = `invalid_target`.
 * Why: a bot that arrives on the End's obsidian platform has 20-40 blocks of void between it and the island; walking, lifting and rising by pillar all go nowhere (live 2026-11-10).
 */
function planToward(w, from, to, { maxLen = 40 } = {}) {
    if (!from || !to || !Number.isInteger(to.x) || !Number.isInteger(to.z)) return { ok: false, reason: 'invalid_args', detail: { why: 'from and to {x, z} needed' } };
    if (w.kindAt(from.x, from.y - 1, from.z) !== 'solid') return { ok: false, reason: 'invalid_target', detail: { why: 'the start of a bridge needs a solid floor (a safe cell)', cell: { x: from.x, y: from.y - 1, z: from.z } } };
    const path = [], place = [], segments = [];
    let prev = { x: from.x, z: from.z }, stop = 'target', landed = false;
    for (const p of abyss.line(from, to)) {
        const floor = w.kindAt(p.x, from.y - 1, p.z), feet = w.kindAt(p.x, from.y, p.z), head = w.kindAt(p.x, from.y + 1, p.z);
        if (floor === 'unknown' || feet === 'unknown' || head === 'unknown') { stop = 'not_loaded'; break; }
        if (!FREE.has(feet) || !FREE.has(head)) { stop = 'wall'; break; }
        if (floor === 'air') { if (place.length >= maxLen) { stop = 'length'; break; } place.push({ x: p.x, y: from.y - 1, z: p.z }); }
        else if (floor !== 'solid') { stop = 'hazard'; break; }
        path.push(p);
        const dir = [p.x - prev.x, p.z - prev.z], last = segments[segments.length - 1];
        if (last && last.dir[0] === dir[0] && last.dir[1] === dir[1]) last.cells.push(p); else segments.push({ dir, cells: [p] });
        prev = p;
        if (floor === 'solid') { stop = 'land'; landed = true; break; }
    }
    if (!place.length) return { ok: false, reason: 'invalid_target', detail: { why: `nothing to bridge toward ${to.x} ${to.z} (${stop === 'wall' ? 'a wall' : stop === 'not_loaded' ? 'not loaded' : stop === 'hazard' ? 'a fluid under the way' : 'ground already'})`, stop } };
    return { ok: true, path, place, segments, length: path.length, landed, stop };
}

/**
 * The gap on the level line from `here` toward `S` {x, z}: walk the cells x first, then z, while they have solid ground under them and free feet and head. The first cell with NO floor at
 * all down to `minY` ends it: { edge: the last cell with ground (`here` itself when the bot stands at the edge), atEdge }. Null: no gap on the way (a wall, a fluid, a chunk not loaded, land
 * all the way, a pit with a floor). The bot may stand anywhere on a base beside the void (live 2026-11-10: the iron-block base east of the End platform); it walks to the edge, then bridges.
 */
function gapOn(w, here, S, minY) {
    if (w.kindAt(here.x, here.y - 1, here.z) !== 'solid') return null;
    let prev = { x: here.x, z: here.z };
    for (const p of abyss.line(here, S)) {
        const floor = w.kindAt(p.x, here.y - 1, p.z), feet = w.kindAt(p.x, here.y, p.z), head = w.kindAt(p.x, here.y + 1, p.z);
        if (floor === 'unknown' || feet === 'unknown' || head === 'unknown' || !FREE.has(feet) || !FREE.has(head)) return null;
        if (floor === 'air') return abyss.over(w, { x: p.x, y: here.y, z: p.z }, minY) ? { edge: prev, atEdge: prev.x === here.x && prev.z === here.z } : null;
        if (floor !== 'solid') return null;
        prev = p;
    }
    return null;
}

/**
 * A standable cell near `here` from which a gap toward `S` can be bridged, nearest first (null: none). For a bot whose own level is blocked (it stands on a base two levels under the End's platform:
 * the platform is its ceiling, live 2026-11-10): the cell on the platform, up to `radius` blocks away and 3 levels up or down. Pure.
 */
function launchCells(w, here, S, minY, { radius = 12, n = 4 } = {}) {
    const found = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (const dy of [0, 1, 2, 3, -1, -2, -3]) {
        if (!dx && !dz && !dy) continue;
        const c = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
        if (w.kindAt(c.x, c.y, c.z) !== 'air' || w.kindAt(c.x, c.y + 1, c.z) !== 'air' || w.kindAt(c.x, c.y - 1, c.z) !== 'solid') continue;
        if (gapOn(w, c, S, minY)) found.push({ ...c, d: Math.hypot(dx, dz) + Math.abs(dy) });
    }
    found.sort((a, b) => a.d - b.d);
    const out = [];
    for (const c of found) { if (out.length >= n) break; if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) + Math.abs(o.y - c.y) > 3)) out.push({ x: c.x, y: c.y, z: c.z }); }      // distinct places, not four neighbours of one
    return out;
}
const launchCell = (w, here, S, minY, o) => launchCells(w, here, S, minY, { ...o, n: 1 })[0] || null;

/** Is the bot at the edge of a gap toward `S` (the next step is over nothing at all)? */
const gapAhead = (w, here, S, minY) => { const g = gapOn(w, here, S, minY); return !!g && g.atEdge; };

/**
 * Cross a gap toward the station `S` {x, z}: a level bridge from where the bot stands (planToward), laid by the `bridge` move. The bridge stays. Returns { ok, placed, landed, at } or the failure of the move.
 * `env`: here(), w, run(name, args), cancel?. `opt.minY`: the dimension's floor, `opt.maxLen`.
 */
async function bridgeToward(env, S, opt = {}) {
    const from = env.here(), plan = planToward(env.w, from, S, { maxLen: opt.maxLen || 40 });
    if (!plan.ok) return plan;
    const placed = [];
    for (const seg of plan.segments) {
        if (env.cancel && env.cancel.cancelled) return { ok: false, reason: 'cancelled', detail: { placed: placed.length } };
        const r = await env.run('bridge', { y: from.y, cells: seg.cells.map((c) => ({ x: c.x, z: c.z })), road: !!opt.road });
        if (r.detail && r.detail.placed) placed.push(...r.detail.placed);
        if (!r.ok) return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), stage: 'bridge', placed: placed.length } };
    }
    return { ok: true, placed: placed.length, landed: plan.landed, stop: plan.stop, at: env.here() };
}

module.exports = { bridge, sneakWalk, workOver, planToward, gapOn, launchCell, launchCells, gapAhead, bridgeToward, MOVES, BRIDGE_ITEMS };

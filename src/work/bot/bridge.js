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

// Cheap blocks that do not fall (never sand or gravel: they would drop into the abyss) and are common where an abyss is: End stone, blackstone, netherrack.
const BRIDGE_ITEMS = ['cobblestone', 'cobbled_deepslate', 'netherrack', 'end_stone', 'blackstone', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'basalt'];
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
        const item = BRIDGE_ITEMS.find((n) => bot.registry.blocksByName[n] && count(bot, n) >= 1);
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
    }
    await ctx.until(() => { fellIf(ctx, y, placed.length); const f = feetCell(bot.entity.position); return f.x === N.x && f.z === N.z && f.y === y && bot.entity.onGround; }, 40, 'stuck', walk);
}

/** bridge {y, cells, items?}: see the top of the file. Returns { placed: [cells], at: the feet cell }. */
async function bridge(ctx, { y, cells }) {
    const bot = ctx.bot;
    if (!Number.isInteger(y) || !Array.isArray(cells) || !cells.length || cells.length > 64) throw new SkillError('invalid_args', { why: 'y and 1..64 cells {x, z}' });
    if (!bot.entity.onGround) await ctx.until(() => bot.entity.onGround, 40, 'stuck');
    const placed = [];
    for (const N of cells) {
        const F = feetCell(bot.entity.position);
        if (F.y !== y) throw new SkillError('invalid_target', { why: `the bot stands at y ${F.y}, the bridge is at y ${y}`, at: F });
        await extend(ctx, y, F, N, BRIDGE_ITEMS, placed);
    }
    return { placed, at: feetCell(bot.entity.position) };
}

/** sneak_walk {y, cells}: along the cells, sneaking, one at a time (each at most 40 ticks). */
async function sneakWalk(ctx, { y, cells }) {
    const bot = ctx.bot;
    if (!Number.isInteger(y) || !Array.isArray(cells) || !cells.length || cells.length > 128) throw new SkillError('invalid_args', { why: 'y and 1..128 cells {x, z}' });
    for (const N of cells) {
        const frame = () => { const p = bot.entity.position; return { forward: true, sneak: true, pitch: 0, yaw: yawOf(N.x + 0.5 - p.x, N.z + 0.5 - p.z) }; };
        ctx.phase('sneak_walk', { to: N });
        await ctx.until(() => { fellIf(ctx, y, 0); const f = feetCell(bot.entity.position), p = bot.entity.position; return f.x === N.x && f.z === N.z && Math.hypot(p.x - (N.x + 0.5), p.z - (N.z + 0.5)) < 0.35; }, 40, 'stuck', frame);
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
            const r = await env.run('sneak_walk', { y: from.y, cells: route.slice(0, i).reverse().map((c) => ({ x: c.x, z: c.z })) });
            const h = env.here(); info.returned = !!r.ok && h.x === from.x && h.z === from.z;
        }
        if (!info.returned && env.goBack) { const g = await env.goBack('back from a bridge'); info.returned = !!g.ok; info.goBack = true; }
    };
    let result;
    for (const seg of plan.segments) {
        if (env.cancel && env.cancel.cancelled) { result = { ok: false, reason: 'cancelled', detail: {} }; break; }
        const r = await env.run('bridge', { y: from.y, cells: seg.cells.map((c) => ({ x: c.x, z: c.z })) });
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

module.exports = { bridge, sneakWalk, workOver, MOVES, BRIDGE_ITEMS };

'use strict';
// Movements that only the pure-bot work layer uses. They are written like the action layer's commands (one `async (ctx, args)` over
// per-tick input frames, run by skills/runner.js, ending in a named reason) but are NOT registered in skills/index.js COMMANDS: the
// RL action matrix and its spec hash stay what every checkpoint was trained on (docs/proposed/WORKERS-v1.md).
const { run, SkillError } = require('../skills/runner');
const { feetCell } = require('../skills/motion');
const { holdItem, count } = require('../skills/commands/item');
const { mine } = require('../skills/commands/block');

/** Low-value blocks a bot may stack: tagged temporary blocks first, then what a pit produces anyway. Never sand or gravel (they fall). */
const TEMP_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate'];

const PLACE_ABOVE = 1.002;        // feet this far above the old feet cell's floor: the placed block no longer touches the body (jump: 0.42, 0.75, 1.0013 ...)

/**
 * pillar {levels, items?}: rise `levels` blocks straight up on a column of low-value blocks, leaving nothing behind (owner 2026-11-06):
 * look down, jump, place a block under the feet at the top of the jump, land on it; then break the block TWO below the feet (the one
 * placed the round before) without a line of sight, since the block between hides it (the server checks only the reach). One block is
 * under the bot at any time. The last block stays under the bot (it must stand on something); `finishPillar` takes it away from the
 * side. The first block placed sits on the ground the bot started on, which is never broken. Cost: one block per level (the broken
 * block drops into the shaft), taken from `items` in order (default TEMP_ITEMS).
 */
async function pillar(ctx, { levels, items = TEMP_ITEMS }) {
    const bot = ctx.bot, w = ctx.world;
    if (!Number.isInteger(levels) || levels < 1 || levels > 320) throw new SkillError('invalid_args', { why: 'levels 1..320' });
    const start = feetCell(bot.entity.position);
    if (!bot.entity.onGround) await ctx.until(() => bot.entity.onGround, 40, 'stuck');
    let prev = null, placed = 0;
    for (let i = 0; i < levels; i++) {
        const f = feetCell(bot.entity.position);
        if (w.kindAt(f.x, f.y - 1, f.z) !== 'solid') throw new SkillError('invalid_target', { why: 'nothing solid under the feet', at: f, done: placed });
        for (const dy of [1, 2]) if (w.kindAt(f.x, f.y + dy, f.z) !== 'air') throw new SkillError('invalid_target', { why: 'no head room above for the jump', at: { x: f.x, y: f.y + dy, z: f.z }, done: placed });
        const item = items.find((n) => bot.registry.blocksByName[n] && count(bot, n) >= 1);
        if (!item) throw new SkillError('missing_item', { item: items[0], why: 'no low-value block to stack', tried: items, done: placed });
        await holdItem(ctx, item);
        const look = { yaw: bot.entity.yaw, pitch: -Math.PI / 2 };
        ctx.phase('pillar_jump', { level: i + 1, of: levels });
        await ctx.tick({ ...look, jump: true });
        await ctx.until(() => bot.entity.position.y >= f.y + PLACE_ABOVE, 14, 'stuck', { ...look, jump: true });
        await ctx.tick({ ...look, use: true });
        await ctx.tick(look);
        const cell = f, got = () => w.blockAt(cell.x, cell.y, cell.z)?.name === item;
        await ctx.until(got, 12, 'not_confirmed', look);
        await ctx.until(() => bot.entity.onGround && feetCell(bot.entity.position).y === f.y + 1, 30, 'stuck', look);
        placed++;
        // The block placed the round before is now two below the feet.
        if (prev) {
            ctx.phase('pillar_unstack', { cell: prev });
            const r = await mine(ctx, { ...prev, collect: false, blind: true }).then(() => null, (e) => e);
            if (r && !(r instanceof SkillError && (r.reason === 'invalid_target' || r.reason === 'missing_tool'))) throw r;          // already gone is fine; no pickaxe for cobblestone leaves the column (cheap)
        }
        prev = cell;
    }
    const top = feetCell(bot.entity.position);
    return { from: start, top, last: prev, levels: placed };
}

/**
 * Take the pillar's last block away after stepping off it: `env.exec('mine', last)` from where the bot stands now (it walks to reach).
 * Returns what mine returned; a block already gone counts as done.
 */
async function finishPillar(env, last) {
    if (!last) return { ok: true };
    if (env.w.kindAt(last.x, last.y, last.z) !== 'solid') return { ok: true };
    return env.exec('mine', { ...last, collect: false });
}

const MOVES = { pillar: { fn: pillar, ticks: (a) => 200 + 90 * (a.levels || 1) } };

/** Run one of the work layer's own movements on `bot` (same result shape as skills.execute). */
function runMove(bot, name, args = {}, opts = {}) {
    const m = MOVES[name];
    if (!m) return Promise.resolve({ ok: false, reason: 'invalid_args', detail: { why: `unknown move ${name}`, known: Object.keys(MOVES) }, ticks: 0, ms: 0, phases: [], trace: [] });
    return run(bot, m.fn, args, { ...opts, maxTicks: opts.maxTicks || m.ticks(args) });
}

module.exports = { pillar, finishPillar, runMove, MOVES, TEMP_ITEMS };

'use strict';
// Movements that only the pure-bot work layer uses. They are written like the action layer's commands (one `async (ctx, args)` over
// per-tick input frames, run by skills/runner.js, ending in a named reason) but are NOT registered in skills/index.js COMMANDS: the
// RL action matrix and its spec hash stay what every checkpoint was trained on (docs/proposed/WORKERS-v1.md).
const { run, SkillError } = require('../../skills/runner');
const { feetCell } = require('../../skills/motion');
const { holdItem, count } = require('../../skills/commands/item');
const { mine } = require('../../skills/commands/block');
const { openAt, station, CONTAINERS, inPlayer } = require('../../skills/commands/gui');
const options = require('../../skills/options');

/** Low-value blocks a bot may stack: tagged temporary blocks first, then what a pit produces anyway. Never sand or gravel (they fall). */
const TEMP_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate'];

const HAND_ITEMS = ['dirt', 'coarse_dirt', 'grass_block'];          // blocks a bot breaks without a tool (and they do not fall)
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
        // A block overhead is broken first (owner 2026-11-07): the cell above the head, then the head cell if it is closed too.
        for (const dy of [2, 1]) {
            const c = { x: f.x, y: f.y + dy, z: f.z };
            if (w.kindAt(c.x, c.y, c.z) === 'air') continue;
            ctx.phase('pillar_clear_overhead', { cell: c });
            const r = await mine(ctx, { ...c, collect: false }).then(() => null, (e) => e);
            if (r || w.kindAt(c.x, c.y, c.z) !== 'air') throw new SkillError('invalid_target', { why: 'no head room above for the jump', at: c, done: placed, cause: r && r.reason });
        }
        // Without a pickaxe only blocks that break by hand can be taken away again: dirt first (owner 2026-11-07), else the usual low-value blocks.
        const handOnly = !bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'));
        const order = handOnly ? [...HAND_ITEMS, ...items.filter((n) => !HAND_ITEMS.includes(n))] : items;
        const item = order.find((n) => bot.registry.blocksByName[n] && count(bot, n) >= 1);
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

const WALK_FAILS = new Set(['unreachable', 'stuck', 'timeout', 'not_confirmed']);
/**
 * Move to a cell, climbing when there is no way on foot (owner 2026-11-06, 2-3: `move_to` goes down by falling but not up). First the
 * normal `move_to`. When that finds no way and the target is higher than the bot: clear the column above the head if it is solid, rise
 * on a pillar of temporary blocks (pillar: one block under the feet at a time, the one two below taken away again), walk the last
 * stretch, and take the last pillar block away from the side. Temporary blocks always go as a pair: the last one is noted in
 * `env.temp` (when the env has one) until it is gone, and `cleanTemp` takes whatever was left. `env`: exec, run, w, here().
 * Returns {ok, how: 'walked' | 'climbed', levels?, reason?, detail?}.
 */
async function climbTo(env, t, { maxLevels = 64 } = {}) {
    let r = await env.exec('move_to', t);
    if (r.ok) return { ok: true, how: 'walked' };
    let here = env.here(), dy = t.y - here.y;
    if (!WALK_FAILS.has(r.reason) || dy < 1) return { ok: false, reason: r.reason, detail: r.detail };
    if (dy > maxLevels) return { ok: false, reason: 'invalid_args', detail: { why: `${dy} levels up is more than ${maxLevels}` } };
    // Rise next to the target, not wherever the bot happens to stand (a wall is climbed at its foot): walk to the standable cell near the
    // target's column that is closest to it and can be reached without climbing, then pillar from there.
    const near = approachCells(env.w, t, here);
    for (const c of near.slice(0, 4)) { if ((await env.exec('move_to', c)).ok) { here = env.here(); dy = t.y - here.y; break; } }
    if (dy < 1) { r = await env.exec('move_to', t); return r.ok ? { ok: true, how: 'walked' } : { ok: false, reason: r.reason, detail: r.detail }; }
    // Room to rise: two free cells above every level. A solid roof is dug (a shaft the bot makes is its own to make); fluid or lava is not.
    for (let k = 1; k <= dy + 1; k++) {
        const c = { x: here.x, y: here.y + k, z: here.z }, kind = env.w.kindAt(c.x, c.y, c.z);
        if (kind === 'solid') { const m = await env.exec('mine', { ...c, collect: false }); if (!m.ok && env.w.kindAt(c.x, c.y, c.z) === 'solid') return { ok: false, reason: m.reason, detail: { ...(m.detail || {}), stage: 'clear_roof', cell: c } }; }
        else if (kind !== 'air' && kind !== 'climb' && kind !== 'unknown') return { ok: false, reason: 'invalid_target', detail: { why: `${kind} in the way above the bot`, cell: c } };
    }
    const p = await env.run('pillar', { levels: dy });
    const last = p.detail && p.detail.last;
    if (last && env.temp) env.temp.set(`${last.x},${last.y},${last.z}`, last);
    if (!p.ok) return { ok: false, reason: p.reason, detail: { ...(p.detail || {}), stage: 'pillar', levels: dy } };
    r = await env.exec('move_to', t);
    const fin = await finishPillar(env, last);
    if (fin.ok && last && env.temp) env.temp.delete(`${last.x},${last.y},${last.z}`);
    if (!r.ok) return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), stage: 'walk_after_climb', levels: dy } };
    return { ok: true, how: 'climbed', levels: dy, ...(fin.ok ? {} : { left: last }) };
}

/** Standable cells within 6 blocks (horizontally) of the target column, at or below one block above the bot's feet, nearest to the target first (never the target's own column). */
function approachCells(w, t, here) {
    const out = [];
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
        const d = Math.hypot(dx, dz); if (d < 1 || d > 6) continue;
        const x = t.x + dx, z = t.z + dz;
        for (let y = here.y + 1; y >= here.y - 8; y--) {
            if (w.kindAt(x, y, z) === 'air' && w.kindAt(x, y + 1, z) === 'air' && w.kindAt(x, y - 1, z) === 'solid') { out.push({ x, y, z, d }); break; }
        }
    }
    return out.sort((a, b) => a.d - b.d).map(({ x, y, z }) => ({ x, y, z }));
}

/** Take away temporary blocks that are still standing (a climb that was cut short): not the one the bot stands on. Returns how many are gone. */
async function cleanTemp(env) {
    if (!env.temp || !env.temp.size) return 0;
    let n = 0;
    const f = env.here();
    for (const [k, c] of [...env.temp]) {
        if (env.w.kindAt(c.x, c.y, c.z) !== 'solid') { env.temp.delete(k); continue; }
        if (c.x === f.x && c.z === f.z && c.y === f.y - 1) continue;                       // standing on it
        const m = await env.exec('mine', { ...c, collect: false });
        if (m.ok || env.w.kindAt(c.x, c.y, c.z) !== 'solid') { env.temp.delete(k); n++; }
    }
    return n;
}


const TIER_ORDER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/**
 * A tool is worn out for the purpose of taking one: few uses left (the work layer's own limits, whether or not retireWorn is on, because a tool
 * that breaks in the next minute is no replacement). Unlike `options.isWorn` this does not depend on the bot's switch.
 */
function wornOut(item) {
    const left = options.usesLeft(item);
    return left !== null && left <= Math.max(options.DEFAULTS.wornMin, Math.ceil(item.maxDurability * options.DEFAULTS.wornReserve));
}

/** The tool to take out of a list of stacks: {pick: the best usable one (tier, then uses left) or null, worn: how many of the class are worn out}. Pure. */
function pickUsable(items, cls) {
    const tier = (n) => { const i = TIER_ORDER.indexOf(n.split('_')[0]); return i < 0 ? TIER_ORDER.length : i; };
    const ofClass = items.filter((i) => i.name.endsWith(`_${cls}`));
    const usable = ofClass.filter((i) => !wornOut(i)).sort((a, b) => tier(a.name) - tier(b.name) || options.usesLeft(b) - options.usesLeft(a));
    return { pick: usable[0] || null, worn: ofClass.length - usable.length };
}

/**
 * take_usable {class, x, y, z}: open the container at x y z and take ONE tool of that class that can be used: not worn out, the best tier
 * first, then the one with the most uses left (owner 2026-11-06: the tools chest handed out worn pickaxes). `withdraw` takes the first stack
 * of a name, which may be the worn one, so this picks the slot itself and shift-clicks it. Reason `missing_item` when the chest has none.
 */
async function takeUsable(ctx, { class: cls, x, y, z }) {
    const bot = ctx.bot;
    if (!['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].includes(cls)) throw new SkillError('invalid_args', { why: 'class: pickaxe, axe, shovel, sword or hoe' });
    const win = await openAt(ctx, station(ctx, CONTAINERS, { x, y, z }, 'container'), (b) => bot.openContainer(b));
    try {
        const { pick, worn } = pickUsable(win.containerItems(), cls);
        if (!pick) throw new SkillError('missing_item', { item: cls, where: 'container', why: `no usable ${cls} in the container`, worn });
        const before = inPlayer(win, pick.type);
        ctx.phase('take_usable', { item: pick.name, left: options.usesLeft(pick), slot: pick.slot });
        await ctx.during(bot.clickWindow(pick.slot, 0, 1), 60);                            // shift-click: the stack goes to the player's inventory
        await ctx.until(() => inPlayer(win, pick.type) >= before + 1, 20);
        return { item: pick.name, left: options.usesLeft(pick), skippedWorn: worn };
    } finally { bot.closeWindow(win); }
}

const MOVES = { pillar: { fn: pillar, ticks: (a) => 200 + 90 * (a.levels || 1) }, take_usable: { fn: takeUsable, ticks: () => 800 } };

/** Run one of the work layer's own movements on `bot` (same result shape as skills.execute). */
function runMove(bot, name, args = {}, opts = {}) {
    const m = MOVES[name];
    if (!m) return Promise.resolve({ ok: false, reason: 'invalid_args', detail: { why: `unknown move ${name}`, known: Object.keys(MOVES) }, ticks: 0, ms: 0, phases: [], trace: [] });
    return run(bot, m.fn, args, { ...opts, maxTicks: opts.maxTicks || m.ticks(args) });
}

module.exports = { pillar, finishPillar, climbTo, cleanTemp, runMove, takeUsable, pickUsable, wornOut, MOVES, TEMP_ITEMS };

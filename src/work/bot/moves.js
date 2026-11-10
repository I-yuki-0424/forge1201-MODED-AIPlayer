'use strict';
// Movements that only the pure-bot work layer uses. They are written like the action layer's commands (one `async (ctx, args)` over
// per-tick input frames, run by skills/runner.js, ending in a named reason) but are NOT registered in skills/index.js COMMANDS: the
// RL action matrix and its spec hash stay what every checkpoint was trained on (docs/proposed/WORKERS-v1.md).
const { run, SkillError } = require('../../skills/runner');
const { feetCell } = require('../../skills/motion');
const { holdItem, count } = require('../../skills/commands/item');
const { mine, dropOf } = require('../../skills/commands/block');
const { openAt, station, openBox, CONTAINERS, inPlayer, inContainer } = require('../../skills/commands/gui');
const options = require('../../skills/options');
const fixtures = require('../../skills/fixtures');
const tempblocks = require('./tempblocks');

/** The preferred low-value blocks (what a pit produces anyway). Since 2026-11-10 ANY block that can be placed, does not fall and is of low value qualifies (tempblocks.js); this list is only its first choice. */
const TEMP_ITEMS = tempblocks.BASE;
const heldOf = (bot) => bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));

const HAND_ITEMS = ['dirt', 'coarse_dirt', 'grass_block'];          // blocks a bot breaks without a tool (and they do not fall)
const PLACE_ABOVE = 1.002;        // feet this far above the old feet cell's floor: the placed block no longer touches the body (jump: 0.42, 0.75, 1.0013 ...)

const valueOf = () => require('./janitor').valueOf;
/**
 * pillar {levels, items?}: rise `levels` blocks straight up on a column of low-value blocks, leaving nothing behind (owner 2026-11-06):
 * look down, jump, place a block under the feet at the top of the jump, land on it; then break the block TWO below the feet (the one
 * placed the round before) without a line of sight, since the block between hides it (the server checks only the reach). One block is
 * under the bot at any time. The last block stays under the bot (it must stand on something); `finishPillar` takes it away from the
 * side. The first block placed sits on the ground the bot started on, which is never broken. Cost: one block per level (the broken
 * block drops into the shaft), taken from `items` in order (default TEMP_ITEMS).
 */
async function pillar(ctx, { levels, items = null, within = null }) {
    const bot = ctx.bot, w = ctx.world;
    if (!Number.isInteger(levels) || levels < 1 || levels > 320) throw new SkillError('invalid_args', { why: 'levels 1..320' });
    const start = feetCell(bot.entity.position);
    if (!bot.entity.onGround) await ctx.until(() => bot.entity.onGround, 40, 'stuck');
    let prev = null, placed = 0;
    for (let i = 0; i < levels; i++) {
        const f = feetCell(bot.entity.position);
        if (w.kindAt(f.x, f.y - 1, f.z) !== 'solid') throw new SkillError('invalid_target', { why: 'nothing solid under the feet', at: f, done: placed });
        // Never ride on another bot's scaffolding (owner 2026-11-11): its owner takes it away, and a bot standing on it falls. The caller steps aside and tries again.
        const under = bot.__temps && bot.__temps.get(fixtures.dimOf(bot), { x: f.x, y: f.y - 1, z: f.z });
        if (under && under.by && under.by !== bot.username && under.kind !== 'road' && under.kind !== 'seal' && under.kind !== 'rescue') throw new SkillError('invalid_target', { why: "standing on another bot's block", crowded: true, at: f, done: placed, by: under.by });
        // The first block of a pillar goes on top of the block under the feet: never of a chest, Ender chest or shulker box (it could not be opened any more).
        if (fixtures.coversContainer(w, f)) throw new SkillError('invalid_target', { why: 'standing on a container: a pillar here would cover it', at: f, done: placed });
        // A block overhead is broken first (owner 2026-11-07): the cell above the head, then the head cell if it is closed too.
        for (const dy of [2, 1]) {
            const c = { x: f.x, y: f.y + dy, z: f.z };
            if (w.kindAt(c.x, c.y, c.z) === 'air') continue;
            ctx.phase('pillar_clear_overhead', { cell: c });
            const r = await mine(ctx, { ...c, collect: false, hand: true }).then(() => null, (e) => e);          // a worn tool or bare hands: slow, but the way up is open
            if (r || w.kindAt(c.x, c.y, c.z) !== 'air') throw new SkillError('invalid_target', { why: 'no head room above for the jump', at: c, done: placed, cause: r && r.reason });
        }
        // Without a pickaxe only blocks that break by hand can be taken away again: dirt first (owner 2026-11-07), else the usual low-value blocks.
        // Any placeable, non-falling, low-value block in the pack counts (owner 2026-11-10: cobblestone alone ran out), the usual ones first.
        const handOnly = !bot.inventory.items().some((i) => i.name.endsWith('_pickaxe') && !options.isWorn(bot, i));          // no usable pickaxe: blocks that break fast by hand first
        const pick = () => (items ? [...(handOnly ? HAND_ITEMS : []), ...items].find((n) => bot.registry.blocksByName[n] && count(bot, n) >= 1) : tempblocks.choose(heldOf(bot), bot.registry, { hand: handOnly, valueOf: valueOf() })) || null;
        let item = pick();
        // Nothing to stack (owner 2026-11-09: "no blocks to climb with" ended the climb in a pit): inside the pit's own box the bot takes a block from the part that is not dug
        // yet, beside it or over its head. It is dug later anyway, and the block is what the pillar needs.
        let harvest = null;
        if (!item && within) { harvest = await harvestBlock(ctx, f, within, items); item = pick(); }
        if (!item) throw new SkillError('missing_item', { item: (items || TEMP_ITEMS)[0], why: 'no low-value block to stack', tried: items || 'any placeable low-value block', done: placed, ...(harvest ? { harvest } : {}) });
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
        if (bot.__temps) bot.__temps.add({ dim: fixtures.dimOf(bot), x: cell.x, y: cell.y, z: cell.z, item, kind: 'pillar', by: bot.username });       // the shared list of placed blocks (temps.js)
        // The block placed the round before is now two below the feet.
        if (prev) {
            ctx.phase('pillar_unstack', { cell: prev });
            const r = await mine(ctx, { ...prev, collect: false, blind: true, hand: true }).then(() => null, (e) => e);        // without a pickaxe by hand: the routine is the same (owner 2026-11-07)
            if (r && !(r instanceof SkillError && (r.reason === 'invalid_target' || r.reason === 'missing_tool'))) throw r;          // already gone is fine; no pickaxe for cobblestone leaves the column (cheap)
        }
        prev = cell;
    }
    const top = feetCell(bot.entity.position);
    return { from: start, top, last: prev, levels: placed };
}

/**
 * One step of `descend` from the feet cell `f` (pure): what the cells under the feet allow. `kindAt(x, y, z)` as the world model gives it.
 * { act: 'place_break' } air two below: put a block there (against the underside of the block under the feet, blind), then break the one under the feet;
 * { act: 'break' } solid two below: the ground is there, break the block under the feet and drop onto it; { act: 'stop', reason } nothing solid under the feet, a fluid or an unloaded cell below.
 */
function descendStep(kindAt, f) {
    if (kindAt(f.x, f.y - 1, f.z) !== 'solid') return { act: 'stop', reason: 'nothing solid under the feet' };
    const k = kindAt(f.x, f.y - 2, f.z);
    if (k === 'solid') return { act: 'break' };
    if (k === 'air' || k === 'climb') return { act: 'place_break' };
    return { act: 'stop', reason: k === 'unknown' ? 'the cell below is not loaded' : `${k} below` };
}

/**
 * descend {levels}: the reverse of `pillar` (owner 2026-11-10: bots on a high leftover block "get stuck with no way down", and were killed): go down `levels` blocks on one column, leaving nothing behind
 * but the block under the feet. Per level: a block is put into the cell TWO below the feet against the underside of the block the bot stands on (placed blind: the server checks only the reach,
 * and the body's `cell` frame names the face), then the block under the feet is broken and the bot drops one cell onto the new one. The same block comes back with the dig, so the pack keeps
 * its count; no fall is longer than one block. Stops early on the ground (solid two below: the last step only breaks the block under the feet) and reports what it did.
 */
async function descend(ctx, { levels }) {
    const bot = ctx.bot, w = ctx.world;
    if (!Number.isInteger(levels) || levels < 1 || levels > 320) throw new SkillError('invalid_args', { why: 'levels 1..320' });
    if (!bot.entity.onGround) await ctx.until(() => bot.entity.onGround, 40, 'stuck');
    const start = feetCell(bot.entity.position);
    let done = 0, stopped = null;
    for (let i = 0; i < levels; i++) {
        const f = feetCell(bot.entity.position), step = descendStep((x, y, z) => w.kindAt(x, y, z), f);
        if (step.act === 'stop') { if (!done) throw new SkillError('invalid_target', { why: step.reason, at: f }); stopped = step.reason; break; }
        const under = { x: f.x, y: f.y - 1, z: f.z }, below = { x: f.x, y: f.y - 2, z: f.z };
        if (fixtures.coversContainer(w, f)) throw new SkillError('invalid_target', { why: 'standing on a container', at: f, done });
        if (step.act === 'place_break') {
            const handOnly = !bot.inventory.items().some((it) => it.name.endsWith('_pickaxe') && !options.isWorn(bot, it));
            const item = tempblocks.choose(heldOf(bot), bot.registry, { hand: handOnly, valueOf: valueOf() });
            if (!item) throw new SkillError('missing_item', { item: TEMP_ITEMS[0], why: 'no low-value block to go down on', tried: 'any placeable low-value block', done });
            await holdItem(ctx, item);
            ctx.phase('descend_place', { cell: below });
            await ctx.tick({ use: true, cell: { x: under.x, y: under.y, z: under.z, face: 0 } });         // face 0 = the underside of the block under the feet
            await ctx.tick({});
            await ctx.until(() => w.blockAt(below.x, below.y, below.z)?.name === item, 12, 'not_confirmed');
            if (bot.__temps) bot.__temps.add({ dim: fixtures.dimOf(bot), x: below.x, y: below.y, z: below.z, item, kind: 'pillar', by: bot.username });
        }
        ctx.phase('descend_break', { cell: under });
        const r = await mine(ctx, { ...under, collect: false, blind: true, hand: true }).then(() => null, (e) => e);
        if (r && !(r instanceof SkillError && r.reason === 'invalid_target')) throw r;
        await ctx.until(() => bot.entity.onGround && feetCell(bot.entity.position).y === f.y - 1, 40, 'stuck');
        done++;
        if (step.act === 'break') break;                                                                    // on the ground
    }
    return { from: start, at: feetCell(bot.entity.position), levels: done, ...(stopped ? { stopped } : {}) };
}

/**
 * Dig one stackable block out of the undug part of a pit box next to the bot (`within` = the box {x0,x1,z0,z1,top,bottom}): the four sides at feet and head level, then the cell over
 * the head. Only a block whose drop is one of `items` (stone gives cobblestone, dirt gives dirt: never sand or gravel, they fall), only inside the box, never beside a fluid.
 * Up to six tries; returns {tried, got} (got: the item name now in the pack, or null). Pure of the walk: the bot stays where it is.
 */
async function harvestBlock(ctx, f, within, items) {
    const bot = ctx.bot, w = ctx.world, out = { tried: 0, got: null };
    const wanted = (n) => (Array.isArray(items) && items.length ? items.includes(n) : false) || tempblocks.isTemp(n, bot.registry, valueOf());      // the caller's list, or any temporary block (tempblocks.js)
    const have = () => (Array.isArray(items) && items.find((n) => bot.registry.blocksByName[n] && count(bot, n) >= 1)) || tempblocks.choose(heldOf(bot), bot.registry, { valueOf: valueOf() });
    const inside = (c) => c.x >= within.x0 && c.x <= within.x1 && c.z >= within.z0 && c.z <= within.z1 && c.y <= within.top && c.y >= within.bottom;
    const wet = (c) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => ['water', 'liquid', 'danger'].includes(w.kindAt(c.x + dx, c.y + dy, c.z + dz)));
    const cand = [];
    for (const dy of [1, 0]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cand.push({ x: f.x + dx, y: f.y + dy, z: f.z + dz });
    cand.push({ x: f.x, y: f.y + 2, z: f.z });
    for (const c of cand) {
        if (out.tried >= 6) break;
        if (!inside(c) || w.kindAt(c.x, c.y, c.z) !== 'solid' || wet(c)) continue;
        const b = w.blockAt(c.x, c.y, c.z), drop = b && dropOf(bot, b);
        if (!drop || !wanted(drop)) continue;
        out.tried++;
        ctx.phase('pillar_harvest', { cell: c, block: b.name });
        const r = await mine(ctx, { ...c, collect: true }).then(() => null, (e) => e);
        if (r && !(r instanceof SkillError)) throw r;
        const got = have();
        if (got) { out.got = got; break; }
    }
    return out;
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
    let n = 0, tried = 0;
    const f = env.here(), fails = env.tempFails || (env.tempFails = new Map());
    for (const [k, c] of [...env.temp]) {
        if (env.w.kindAt(c.x, c.y, c.z) !== 'solid') { env.temp.delete(k); continue; }
        if (c.x === f.x && c.z === f.z && c.y === f.y - 1) continue;                       // standing on it
        // Only what is within a few steps (owner 2026-11-10: temporary blocks and the work were tangled in a loop of walking to far blocks), six blocks a call, three tries a block:
        // the placer takes its blocks away as it passes them (pillar, bridge); this is only for what a cut-short climb left beside it.
        if (Math.hypot(c.x - f.x, c.z - f.z) > 6 || Math.abs(c.y - f.y) > 6 || tried >= 6 || (fails.get(k) || 0) >= 3) continue;
        tried++;
        const m = await env.exec('mine', { ...c, collect: false });
        if (m.ok || env.w.kindAt(c.x, c.y, c.z) !== 'solid') { env.temp.delete(k); fails.delete(k); n++; } else fails.set(k, (fails.get(k) || 0) + 1);
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
    const win = await openAt(ctx, station(ctx, CONTAINERS, { x, y, z }, 'container'), (b) => openBox(bot, b));
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

/**
 * deposit_many {items: [{item, count}], x, y, z}: put several kinds of items into the container at x y z through ONE open window (the plain `deposit` opens and closes it per kind:
 * about 1.5 s each, so a visit with ten kinds held the one door of the chest for 15 s and 11-15 bots stood in its line, live 2026-11-09). Per kind the same call and the same check as
 * `deposit`; a kind that cannot be put in is reported and the next one is tried. A full chest is reported per kind (`container_full`, with what did go in) and the run goes on. Returns { done: [{item, moved}], failed: [{item, reason, detail?}] }.
 */
/** Does the container have room for `it` (an empty slot, or a stack of the same item that is not full)? A full chest does not throw: the transfer just does not happen. */
function roomFor(win, it) {
    const cont = win.slots.slice(0, win.inventoryStart), max = it.stackSize || 64;
    return cont.some((s) => !s || (s.type === it.id && s.count < max));
}
async function depositMany(ctx, { items, x, y, z }) {
    const bot = ctx.bot;
    if (!Array.isArray(items) || !items.length || items.length > 60) throw new SkillError('invalid_args', { why: 'items: 1 to 60 of {item, count}' });
    for (const o of items) if (!o || !/^[a-z0-9_]+(:[a-z0-9_]+)?$/.test(o.item) || !Number.isInteger(o.count) || o.count < 1 || o.count > 2304) throw new SkillError('invalid_args', { why: 'each item: {item: name, count: 1..2304}' });
    const win = await openAt(ctx, station(ctx, CONTAINERS, { x, y, z }, 'container'), (b) => openBox(bot, b));
    const done = [], failed = [];
    try {
        for (const o of items) {
            const it = bot.registry.itemsByName[o.item];
            if (!it) { failed.push({ item: o.item, reason: 'invalid_args' }); continue; }
            const have = inPlayer(win, it.id), n = Math.min(o.count, have);
            if (n < 1) { failed.push({ item: o.item, reason: 'missing_item' }); continue; }
            const c0 = inContainer(win, it.id);
            if (!roomFor(win, it)) { failed.push({ item: o.item, reason: 'container_full' }); continue; }          // nothing fits: no attempt (a full chest answers with silence, and the wait for it ends as `not_confirmed`)
            ctx.phase('deposit', { item: o.item, count: n });
            try {
                await ctx.during(win.deposit(it.id, null, n), 60);
                await ctx.until(() => inContainer(win, it.id) >= c0 + n, 20);
                done.push({ item: o.item, moved: n });
            } catch (e) {
                if (!(e instanceof SkillError) && !/destination full/.test(String(e && e.message))) throw e;
                const full = /destination full/.test(String(e.message)) || (e.reason === 'not_confirmed' && inContainer(win, it.id) < c0 + n && !roomFor(win, it));         // it filled up on the way: part went in
                // What went in before the container filled up counts, and a full container does not end the run: the next kind may still merge into a partly filled stack of its own.
                const part = inContainer(win, it.id) - c0; if (part > 0) done.push({ item: o.item, moved: part, partial: true });
                failed.push({ item: o.item, reason: full ? 'container_full' : e.reason || 'error', ...(part > 0 ? { moved: part } : {}) });
                if (!full && ['died', 'disconnected', 'cancelled'].includes(e.reason)) throw e;
            }
        }
    } finally { bot.closeWindow(win); }
    return { done, failed };
}

/**
 * stash_worn {item, damage, x, y, z}: put ONE exact stack (the item with exactly this much wear) into the container at x y z (owner 2026-11-09: a diamond tool that is
 * stopped before it breaks is kept, not thrown away). `deposit` takes the first stack of a name, which may be the good one, so the slot is picked here and shift-clicked.
 */
async function stashWorn(ctx, { item, damage, x, y, z }) {
    const bot = ctx.bot;
    if (typeof item !== 'string' || !Number.isInteger(damage)) throw new SkillError('invalid_args', { why: 'item and damage' });
    const win = await openAt(ctx, station(ctx, CONTAINERS, { x, y, z }, 'container'), (b) => openBox(bot, b));
    try {
        const slot = win.items().find((i) => i.name === item && (i.durabilityUsed || 0) === damage);
        if (!slot) throw new SkillError('missing_item', { item, why: `no ${item} with ${damage} wear in the pack` });
        const before = win.containerItems().reduce((n, i) => n + (i.type === slot.type ? i.count : 0), 0);
        ctx.phase('stash_worn', { item, damage });
        await ctx.during(bot.clickWindow(slot.slot, 0, 1), 60);                              // shift-click: the stack goes to the container
        await ctx.until(() => win.containerItems().reduce((n, i) => n + (i.type === slot.type ? i.count : 0), 0) > before, 20, 'not_confirmed');
        return { item, damage };
    } finally { bot.closeWindow(win); }
}

/** mine_hand {x, y, z}: break one block with a worn tool or bare hands (the way out of a pit when no usable pickaxe is left), no drop collected. */
const mineHand = (ctx, a) => mine(ctx, { x: a.x, y: a.y, z: a.z, collect: false, hand: true });

// harvest: one stackable block out of the undug part of the pit beside the bot (for the water rule when the pack holds nothing to seal with: a chest tagged `any` is insert-only, so there is
// nothing to fetch back). `within` is the pit box (the environment adds it), `items` what is wanted.
const harvest = async (ctx, a) => harvestBlock(ctx, feetCell(ctx.bot.entity.position), a.within, a.items || []);
const MOVES = { descend: { fn: descend, ticks: (a) => 200 + 200 * (a.levels || 1) }, mine_hand: { fn: mineHand, ticks: () => 400 }, harvest: { fn: harvest, ticks: () => 700 }, pillar: { fn: pillar, ticks: (a) => 200 + 260 * (a.levels || 1) }, take_usable: { fn: takeUsable, ticks: () => 800 }, deposit_many: { fn: depositMany, ticks: (a) => 400 + 120 * ((a.items && a.items.length) || 1) }, stash_worn: { fn: stashWorn, ticks: () => 800 } };
Object.assign(MOVES, require('./bridge').MOVES);          // bridge, sneak_walk: work over an abyss (bridge.js; no circular import: it does not need this file)

/** Run one of the work layer's own movements on `bot` (same result shape as skills.execute). */
function runMove(bot, name, args = {}, opts = {}) {
    const m = MOVES[name];
    if (!m) return Promise.resolve({ ok: false, reason: 'invalid_args', detail: { why: `unknown move ${name}`, known: Object.keys(MOVES) }, ticks: 0, ms: 0, phases: [], trace: [] });
    return run(bot, m.fn, args, { ...opts, maxTicks: opts.maxTicks || m.ticks(args) });
}

module.exports = { pillar, descend, descendStep, harvestBlock, finishPillar, climbTo, cleanTemp, runMove, takeUsable, depositMany, stashWorn, pickUsable, wornOut, MOVES, TEMP_ITEMS };

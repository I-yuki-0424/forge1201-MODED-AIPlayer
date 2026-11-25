'use strict';
// set_contents (TASK-20261125-076, owner Large 3.4): make a container hold given items in given slots — a sorter's filter hopper, the chest a comparator
// reads at a chosen strength — with items from the bot's own pack. An instruction of the command stack (docs/implemented/COMMAND-STACK-v1.md): its
// preconditions (in reach, the items in the pack) are in src/skills/preconditions.js and the router makes them true; the command itself never walks.
//
// The screen is opened with the use key on the block, like a person; the clicks are planned on the game's own rules (src/native/inventory: menu.js) and
// sent by the native protocol client, which keeps the server's state; the result is graded from the FULL window contents the server sends back
// (a sync after the clicks), never from the prediction. One re-plan from the server's state when the first round did not land.
//
//   set_contents {x, y, z, contents: [{slot, item, count}], exact?}    the slots named; with exact every other slot is emptied into the pack
//   set_contents {x, y, z, signal, item, exact?}                        the fewest `item` that make a comparator read `signal` (0..15) from it
const { SkillError } = require('../runner');
const { approachBlock, aimAtBlock } = require('../motion');
const native = require('../../native/inventory');

// containers whose screen is a plain slot grid (chest / barrel / shulker 27 or 54, hopper 5, dispenser / dropper 9)
const CONTAINER = native.CONTAINER;
const CLICKS_PER_TICK = 8;

/** The goal list: `contents` as given (validated against the window's size), or the contents for `signal`. */
function goalOf(bot, args, size) {
    if (args.signal !== undefined) {
        const it = bot.registry.itemsByName[args.item];
        if (!it) throw new SkillError('invalid_args', { item: args.item, why: 'unknown item' });
        try { return native.contentsForSignal({ size, item: args.item, maxStack: it.stackSize, strength: args.signal }); } catch (e) { throw new SkillError('invalid_args', { why: e.message }); }
    }
    for (const c of args.contents) {
        if (c.slot >= size) throw new SkillError('invalid_args', { why: `slot ${c.slot} is outside the container's ${size} slots` });
        const it = bot.registry.itemsByName[c.item];
        if (!it) throw new SkillError('invalid_args', { item: c.item, why: 'unknown item' });
        if (c.count > Math.min(99, it.stackSize)) throw new SkillError('invalid_args', { why: `${c.count} ${c.item} do not fit in one slot (at most ${it.stackSize})` });
    }
    return args.contents.map((c) => ({ slot: c.slot, item: c.item, count: c.count, comp: '' }));
}

/** Slots of the container block's screen, from the block alone (a chest joined to its neighbour is 54). */
function sizeOf(block) {
    const n = block && block.name;
    if (n === 'hopper') return 5;
    if (n === 'dropper' || n === 'dispenser') return 9;
    if ((n === 'chest' || n === 'trapped_chest') && block.getProperties && ['left', 'right'].includes(String(block.getProperties().type))) return 54;
    return 27;
}

/** The items the goal needs in all, per item name (the pack must hold them: the precondition `item_in_pack`). `size`: the container's slots. */
function needOf(bot, args, size) {
    if (args.signal !== undefined) {
        if (args.signal === 0) return [];
        const it = bot.registry.itemsByName[args.item];
        try { return [{ item: args.item, count: native.contentsForSignal({ size, item: args.item, maxStack: it ? it.stackSize : 64, strength: args.signal }).reduce((a, c) => a + c.count, 0) }]; } catch (_) { return []; }   // an unreachable strength: the command says invalid_args
    }
    const m = new Map();
    for (const c of args.contents || []) m.set(c.item, (m.get(c.item) || 0) + c.count);
    return [...m].map(([item, count]) => ({ item, count }));
}

async function openWindow(ctx, cell, nw) {
    const bot = ctx.bot;
    await approachBlock(ctx, cell);
    const hit = await aimAtBlock(ctx, cell, { frame: { sneak: false } });
    const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak: false };
    ctx.phase('open', { face: hit.face });
    await ctx.tick({ ...look, use: true });
    await ctx.until(() => !!(nw.cur && nw.cur.loaded), 20, 'not_confirmed', look);
    if (!nw.cur.menu) { closeWindow(bot, nw); throw new SkillError('invalid_target', { why: `the screen ${nw.cur.type} is not a container grid` }); }
    return nw.cur;
}
function closeWindow(bot, nw) {
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch (_) { /* mineflayer's copy closes with it */ } } else nw.close();
    nw.onClose();
}

async function setContents(ctx, args) {
    const bot = ctx.bot, { x, y, z } = args, cell = { x, y, z }, exact = !!args.exact;
    const b0 = ctx.world.blockAt(x, y, z);
    if (!b0) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (!CONTAINER.test(b0.name)) throw new SkillError('invalid_target', { block: b0.name, why: 'not a container with a slot grid' });
    const nw = native.attach(bot);
    const win = await openWindow(ctx, cell, nw);
    try {
        const size = win.menu.L.n;
        const goal = goalOf(bot, args, size);
        let last = null;
        for (let round = 0; round < 2; round++) {
            const plan = native.planClicks(nw.menu(), goal, { exact });
            if (plan.missing.length) throw new SkillError('missing_item', { where: 'pack', missing: plan.missing });
            if (plan.noRoom) throw new SkillError('invalid_target', { why: 'the container holds items that must come out and the pack has no room for them' });
            ctx.phase('click', { round, clicks: plan.clicks.length, slots: goal.length });
            for (let i = 0; i < plan.clicks.length; i++) {
                const [s, b, m] = plan.clicks[i];
                nw.click(s, b, m);
                if ((i + 1) % CLICKS_PER_TICK === 0) await ctx.tick({});
            }
            await ctx.tick({});
            await ctx.during(nw.sync(), 40);                                 // the server's full window contents: the only grade
            last = native.compare(nw.menu(), goal, { exact });
            if (!last.length) break;
            ctx.phase('replan', { differs: last.length, corrections: nw.stats.corrections });
        }
        if (last.length) throw new SkillError('not_confirmed', { differs: last.slice(0, 8), corrections: nw.stats.corrections });
        const m = nw.menu(), held = m.slots.slice(0, size).filter(Boolean).map((s) => ({ item: s.name, count: s.count }));
        const signal = native.signalOf(held, size, (n) => (bot.registry.itemsByName[n] ? bot.registry.itemsByName[n].stackSize : 64));
        return { block: b0.name, size, slots: goal.length, signal, corrections: nw.stats.corrections };
    } finally {
        closeWindow(bot, nw);
    }
}

module.exports = { setContents, goalOf, needOf, sizeOf, CONTAINER };

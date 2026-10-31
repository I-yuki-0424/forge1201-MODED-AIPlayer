'use strict';
// Commands behind a block's screen: craft, smelt, deposit, withdraw. The bot walks to the block and puts the crosshair
// on it like any other block command; opening the screen and the clicks inside it are Mineflayer's window helpers
// (bot.craft, openFurnace, openContainer: sequences of window clicks), run while the game clock keeps ticking.
const { SkillError } = require('../runner');
const { approachBlock, aimAtBlock } = require('../motion');
const { count } = require('./item');

const STATION_RANGE = 16;
const FUEL = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100, stick: 0.5 };
const fuelValue = (name) => FUEL[name] ?? (/_planks$|_log$|_wood$|_stem$/.test(name) ? 1.5 : 0);
const CONTAINERS = /^(chest|trapped_chest|barrel)$/;

/** The block at {x,y,z} if it matches, else the nearest matching block within range. */
function station(ctx, re, at, what) {
    const bot = ctx.bot;
    if (at.x !== undefined) {
        const b = ctx.world.blockAt(at.x, at.y, at.z);
        if (!b || !re.test(b.name)) throw new SkillError('invalid_target', { want: what, found: b && b.name, at });
        return b;
    }
    const b = bot.findBlock({ matching: (blk) => re.test(blk.name), maxDistance: STATION_RANGE });
    if (!b) throw new SkillError('no_station', { want: what, range: STATION_RANGE });
    return b;
}

/** Walk to the block, aim at it, then open its screen. */
async function openAt(ctx, block, open) {
    const c = { x: block.position.x, y: block.position.y, z: block.position.z };
    await approachBlock(ctx, c);
    await aimAtBlock(ctx, c);
    ctx.phase('open', { block: block.name, at: c });
    return ctx.during(open(ctx.world.blockAt(c.x, c.y, c.z)), 40);
}

/** craft {item, count, x?, y?, z?}: craft at least `count` of `item`, in the 2x2 grid or at a crafting table. */
async function craft(ctx, { item, count: n = 1, x, y, z }) {
    const bot = ctx.bot, it = bot.registry.itemsByName[item];
    if (!it || !bot.recipesAll(it.id, null, true).length) throw new SkillError('invalid_args', { item, why: 'no crafting recipe' });
    const before = count(bot, item);
    let table = null, recipe = x === undefined ? bot.recipesFor(it.id, null, n, null)[0] : null;
    if (!recipe) {
        recipe = bot.recipesFor(it.id, null, n, true)[0];
        if (!recipe) throw new SkillError('missing_materials', { item, count: n });
        table = station(ctx, /^crafting_table$/, { x, y, z }, 'crafting_table');
    }
    const times = Math.ceil(n / recipe.result.count);
    if (table) {
        const c = table.position;
        await approachBlock(ctx, c);
        await aimAtBlock(ctx, c);
        table = ctx.world.blockAt(c.x, c.y, c.z);
    }
    ctx.phase('craft', { item, times, table: !!table });
    await ctx.during(bot.craft(recipe, times, table), 60 + 40 * times);
    await ctx.until(() => count(bot, item) >= before + n, 20);
    return { item, made: count(bot, item) - before, table: !!table };
}

/** smelt {item, count, x?, y?, z?}: smelt `count` of `item` in a furnace, fuelled from the inventory; take the output. */
async function smelt(ctx, { item, count: n = 1, x, y, z }) {
    const bot = ctx.bot, it = bot.registry.itemsByName[item];
    if (!it) throw new SkillError('invalid_args', { item });
    if (count(bot, item) < n) throw new SkillError('missing_item', { item, want: n, have: count(bot, item) });
    const fuel = bot.inventory.items().filter((i) => i.name !== item && fuelValue(i.name) > 0)
        .map((i) => ({ name: i.name, id: i.type, need: Math.ceil(n / fuelValue(i.name)), have: count(bot, i.name) }))
        .filter((f) => f.have >= f.need).sort((a, b) => a.need - b.need)[0];
    if (!fuel) throw new SkillError('missing_materials', { why: 'no fuel for the batch', item, count: n });
    const block = station(ctx, /^(furnace|smoker|blast_furnace)$/, { x, y, z }, 'furnace');
    const furnace = await openAt(ctx, block, (b) => bot.openFurnace(b));
    const out0 = furnace.outputItem()?.count || 0;
    ctx.phase('load', { fuel: fuel.name, fuel_count: fuel.need });
    await ctx.during(furnace.putFuel(fuel.id, null, fuel.need), 40);
    await ctx.during(furnace.putInput(it.id, null, n), 40);
    ctx.phase('wait_smelt', { ticks_expected: 200 * n });
    await ctx.until(() => (furnace.outputItem()?.count || 0) - out0 >= n, 200 * n + 200, 'not_confirmed');
    const out = furnace.outputItem().name, before = count(bot, out);
    ctx.phase('take', { item: out });
    await ctx.during(furnace.takeOutput(), 40);
    bot.closeWindow(furnace);
    await ctx.until(() => count(bot, out) >= before + n, 20);
    return { input: item, output: out, made: count(bot, out) - before, fuel: fuel.name };
}

const inContainer = (win, id) => win.containerItems().reduce((s, i) => s + (i.type === id ? i.count : 0), 0);

/** deposit {item, count, x, y, z}: put `count` of `item` into the container at x,y,z. */
async function deposit(ctx, { item, count: n, x, y, z }) {
    const bot = ctx.bot, it = bot.registry.itemsByName[item];
    if (!it) throw new SkillError('invalid_args', { item });
    if (count(bot, item) < n) throw new SkillError('missing_item', { item, want: n, have: count(bot, item) });
    const win = await openAt(ctx, station(ctx, CONTAINERS, { x, y, z }, 'container'), (b) => bot.openContainer(b));
    const c0 = inContainer(win, it.id);
    ctx.phase('deposit', { item, count: n });
    await ctx.during(win.deposit(it.id, null, n), 60);
    await ctx.until(() => inContainer(win, it.id) >= c0 + n, 20);
    bot.closeWindow(win);
    return { item, moved: n };
}

/** withdraw {item, count, x, y, z}: take `count` of `item` out of the container at x,y,z. */
async function withdraw(ctx, { item, count: n, x, y, z }) {
    const bot = ctx.bot, it = bot.registry.itemsByName[item];
    if (!it) throw new SkillError('invalid_args', { item });
    const before = count(bot, item);
    const win = await openAt(ctx, station(ctx, CONTAINERS, { x, y, z }, 'container'), (b) => bot.openContainer(b));
    if (inContainer(win, it.id) < n) { bot.closeWindow(win); throw new SkillError('missing_item', { item, where: 'container', want: n }); }
    ctx.phase('withdraw', { item, count: n });
    await ctx.during(win.withdraw(it.id, null, n), 60);
    await ctx.until(() => count(bot, item) >= before + n, 20);
    bot.closeWindow(win);
    return { item, moved: n };
}

module.exports = { craft, smelt, deposit, withdraw, fuelValue };

'use strict';
// Inventory and hand: equip, eat, toss. Input used: hotbar keys 1-9, number-key swaps and shift-clicks in the player's
// own inventory screen (window 0, always open on the server), the use button, and the Q and F keys.
const { SkillError } = require('../runner');

// Player inventory window (id 0) slot numbers.
const SLOT = { head: 5, chest: 6, legs: 7, feet: 8, hotbar0: 36, off_hand: 45 };
const ARMOR_SUFFIX = { head: /_helmet$|^turtle_helmet$|_head$|^carved_pumpkin$/, chest: /_chestplate$|^elytra$/, legs: /_leggings$/, feet: /_boots$/ };

const count = (bot, name) => bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
    + (bot.inventory.slots[SLOT.off_hand]?.name === name ? bot.inventory.slots[SLOT.off_hand].count : 0);

/**
 * The registry name for an item id as a person or an LLM writes it: "minecraft:stone" -> "stone"; a namespaced mod id is
 * kept when the registry knows it under that name, else its bare part is tried ("create:wrench" -> "wrench").
 */
function resolveItemName(bot, id) {
    const s = String(id).toLowerCase().replace(/^minecraft:/, '');
    if (bot.registry.itemsByName[s] || !s.includes(':')) return s;
    const bare = s.slice(s.indexOf(':') + 1);
    return bot.registry.itemsByName[bare] ? bare : s;
}

/** Window-0 slot of a stack of `name`: the selected hotbar slot first, then the hotbar, then the main inventory. */
function slotOf(bot, name) {
    const s = bot.inventory.slots, sel = SLOT.hotbar0 + bot.quickBarSlot;
    if (s[sel]?.name === name) return sel;
    for (let i = SLOT.hotbar0; i < SLOT.hotbar0 + 9; i++) if (s[i]?.name === name) return i;
    for (let i = 9; i < 36; i++) if (s[i]?.name === name) return i;
    return -1;
}

/** Click in the player's inventory and wait until the client's copy shows the result. */
async function click(ctx, slot, button, mode, settled) {
    await ctx.during(ctx.bot.clickWindow(slot, button, mode), 20);
    await ctx.until(settled, 20);
}

/** Put a stack of `name` in the main hand: hotbar key if it is on the hotbar, else a number-key swap into the hotbar. */
async function holdItem(ctx, name) {
    const bot = ctx.bot;
    if (bot.heldItem?.name === name) return;
    const slot = slotOf(bot, name);
    if (slot < 0) throw new SkillError('missing_item', { item: name });
    if (slot >= SLOT.hotbar0) {
        await ctx.tick({ hotbar: slot - SLOT.hotbar0 });
    } else {
        // Hover the stack and press the number of a hotbar slot: an empty one if there is one, else the selected one.
        const s = bot.inventory.slots;
        let hb = [...Array(9).keys()].find((i) => !s[SLOT.hotbar0 + i]);
        if (hb === undefined) hb = bot.quickBarSlot;
        ctx.phase('swap_to_hotbar', { from: slot, hotbar: hb });
        await click(ctx, slot, hb, 2, () => bot.inventory.slots[SLOT.hotbar0 + hb]?.name === name);
        await ctx.tick({ hotbar: hb });
    }
    await ctx.until(() => bot.heldItem?.name === name, 10, 'not_confirmed');
}

/** equip {item, dest}: put the item in the main hand, the off hand or its armour slot. */
async function equip(ctx, { item, dest = 'hand' }) {
    const bot = ctx.bot;
    if (dest === 'hand') { await holdItem(ctx, item); return { slot: bot.quickBarSlot }; }
    if (dest === 'off_hand') {
        if (bot.inventory.slots[SLOT.off_hand]?.name === item) return {};
        await holdItem(ctx, item);
        ctx.phase('swap_hands');
        await ctx.tick({ swap: true });                       // F: swap main hand and off hand
        await ctx.until(() => bot.inventory.slots[SLOT.off_hand]?.name === item, 20);
        return {};
    }
    if (!ARMOR_SUFFIX[dest].test(item)) throw new SkillError('invalid_args', { item, dest, why: 'item does not fit that slot' });
    const target = SLOT[dest];
    if (bot.inventory.slots[target]?.name === item) return {};
    const from = slotOf(bot, item);
    if (from < 0) throw new SkillError('missing_item', { item });
    if (!bot.inventory.slots[target]) {
        ctx.phase('shift_click', { from });
        await click(ctx, from, 0, 1, () => bot.inventory.slots[target]?.name === item);    // shift-click moves armour onto the body
    } else {
        // Occupied: pick the piece up, click the armour slot (swaps), put the old piece where the new one was.
        ctx.phase('swap_armor', { from });
        await click(ctx, from, 0, 0, () => !bot.inventory.slots[from]);
        await click(ctx, target, 0, 0, () => bot.inventory.slots[target]?.name === item);
        await click(ctx, from, 0, 0, () => !!bot.inventory.slots[from] && !bot.inventory.selectedItem);
    }
    return {};
}

/** eat {item?}: eat one item of food (the most nourishing one when no item is named). */
async function eat(ctx, { item } = {}) {
    const bot = ctx.bot;
    if (bot.food >= 20) throw new SkillError('invalid_target', { why: 'not hungry (food 20)' });
    const foods = bot.registry.foodsByName;
    const name = item || bot.inventory.items().filter((i) => foods[i.name]).sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0]?.name;
    if (!name || !foods[name]) throw new SkillError(name ? 'invalid_args' : 'missing_item', { item: name || 'food' });
    await holdItem(ctx, name);
    const n0 = count(bot, name), f0 = bot.food;
    ctx.phase('eat', { item: name, food: f0 });
    // Look slightly up, away from blocks, so the click goes to the item rather than to a block (as a player would).
    await ctx.until(() => count(bot, name) < n0, 60, 'not_confirmed', { use: true, pitch: 0.6 });
    await ctx.tick({});
    await ctx.until(() => bot.food > f0, 20, 'not_confirmed');
    return { item: name, food: [f0, bot.food] };
}

/** toss {item, count}: drop `count` items with Q (one) and Ctrl+Q (whole stack) from the main hand. */
async function toss(ctx, { item, count: n }) {
    const bot = ctx.bot;
    const have = count(bot, item);
    if (have < n) throw new SkillError('missing_item', { item, have, want: n });
    const target = have - n;
    ctx.phase('toss', { item, count: n });
    while (count(bot, item) > target) {
        await holdItem(ctx, item);
        const before = count(bot, item), inHand = bot.heldItem.count, left = before - target;
        ctx.phase('drop', { in_hand: inHand, left });
        await ctx.tick({ drop: left >= inHand ? 'stack' : 'one' });
        await ctx.until(() => count(bot, item) < before, 20);
    }
    return { item, left: count(bot, item) };
}

module.exports = { equip, eat, toss, holdItem, count, slotOf, click, resolveItemName, SLOT };

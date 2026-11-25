'use strict';
// Can a bot get a block back by breaking it, with the tools it carries? A built block dug out to open a cell the build order closed in is put back afterwards, so it must come
// back as its own item: glass drops nothing without Silk Touch, stone drops cobblestone, obsidian needs a diamond pickaxe; dug anyway, the crew runs short of it later
// (owner 2026-11-25). Vanilla's answer comes from the loot tables (minecraft-data `blockLoot`: drops with silkTouch / noSilkTouch conditions) and the block's `harvestTools`;
// the tool's enchantments from its item components (26.1) or its NBT. Mods (Forge, later) bring their own tools, enchantments and drops: `register(rule)` adds a rule that is
// asked first; it returns true or false to decide, or undefined to leave it to vanilla.
const RULES = [];
/** rule({ bot, block, item, tool, enchants }) -> true | false | undefined (tool: the item stack or null for the bare hand; enchants: Map name -> level). */
function register(rule) { RULES.push(rule); }

/** The enchantments of an item stack: Map name -> level (26.1 `enchantments` component, or NBT through prismarine-item). */
function enchantsOf(bot, it) {
    const out = new Map();
    if (!it) return out;
    for (const c of it.components || []) {
        if (!c || !/enchantments$/.test(String(c.type)) || /stored/.test(String(c.type))) continue;
        const list = (c.data && (c.data.enchantments || c.data)) || [];
        for (const e of Array.isArray(list) ? list : []) {
            const id = e.id ?? e.type ?? e.enchantment, lv = Number(e.level ?? e.lvl ?? 1);
            const name = typeof id === 'number' ? ((bot.registry.enchantments && bot.registry.enchantments[id]) || {}).name : String(id || '').replace(/^minecraft:/, '');
            if (name) out.set(name, lv);
        }
    }
    if (!out.size) { try { for (const e of it.enchants || []) if (e && e.name) out.set(String(e.name).replace(/^minecraft:/, ''), Number(e.lvl || 1)); } catch (_) { /* no NBT */ } }
    return out;
}

const TOOLISH = /(_pickaxe|_axe|_shovel|_hoe|shears|_sword)$/;

/**
 * Does breaking `blockName` with `tool` (an item stack, or null for the hand) give `item` back? Vanilla: the block must be harvestable with the tool (harvestTools), and a drop
 * of `item` must hold under the tool's Silk Touch (a drop marked silkTouch needs it, one marked noSilkTouch needs it absent). A drop by chance (saplings) does not count.
 */
function gives(bot, blockName, item, tool) {
    const enchants = enchantsOf(bot, tool), block = bot.registry.blocksByName[blockName];
    for (const rule of RULES) { const v = rule({ bot, block: blockName, item, tool, enchants }); if (v === true || v === false) return v; }
    if (!block) return false;
    if (block.harvestTools && !(tool && block.harvestTools[tool.type])) return false;
    const loot = bot.registry.blockLoot && bot.registry.blockLoot[blockName];
    if (!loot) return false;                                     // no table: not known to come back
    const silk = (enchants.get('silk_touch') || 0) > 0;
    return (loot.drops || []).some((d) => d.item === item && (d.dropChance ?? 1) >= 0.5 && !(d.silkTouch && !silk) && !(d.noSilkTouch && silk));
}

/**
 * The tool the bot should break `blockName` with to get `item` back: { ok, tool } (tool null: the hand does it), or { ok: false, why }. Among the tools it carries, the one
 * that gives it back with the fewest enchantments (Silk Touch is kept for where it is needed).
 */
function getBack(bot, blockName, item) {
    const tools = bot.inventory.items().filter((i) => TOOLISH.test(i.name)).sort((a, b) => enchantsOf(bot, a).size - enchantsOf(bot, b).size);
    for (const t of tools) if (gives(bot, blockName, item, t)) return { ok: true, tool: t };
    if (gives(bot, blockName, item, null)) return { ok: true, tool: null };
    const loot = bot.registry.blockLoot && bot.registry.blockLoot[blockName], d = loot && (loot.drops || []).find((x) => x.item === item);
    return { ok: false, why: !loot ? 'no loot table' : !d ? `${blockName} never drops ${item}` : d.silkTouch ? 'needs Silk Touch' : 'no tool that harvests it' };
}

module.exports = { register, enchantsOf, gives, getBack };

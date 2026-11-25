'use strict';
// How long a block takes to break, as the game computes it (TASK-20261125-076): BlockState.getDestroyProgress and Player.getDestroySpeed of 1.20-1.21, from the
// connected version's data (minecraft-data: hardness, the tool multipliers of the block's material, the tools that harvest it) and the player's state
// (main-hand tool and its enchantments, haste / conduit power, mining fatigue, eyes in water, on the ground; from 1.21 the attributes mining_efficiency,
// block_break_speed and submerged_mining_speed the server sends). The client adds the per-tick progress as a FLOAT and breaks at >= 1.0
// (MultiPlayerGameMode.continueDestroyBlock); the tick count here is that float sum, which is one tick more than ceil(1 / progress) for some speeds.
// The server accepts the finish at 70 % of the time it counted (ServerPlayerGameMode: progress x (ticks + 1) >= 0.7), so a client that waits the full
// count is never early.
const f = Math.fround;
const FATIGUE = [1, 0.3, 0.09, 0.0027, 8.1e-4];

/** Enchantment levels of an item in any of the shapes prismarine-item gives (list [{name, lvl}], components {enchantments: [{id, level}]} or {levels}). */
function enchantLevel(item, name, registry) {
    if (!item) return 0;
    const raw = item.enchants;
    const nm = (id) => (typeof id === 'string' ? id.replace(/^minecraft:/, '') : ((registry && registry.enchantments && registry.enchantments[id]) || {}).name);
    let list = [];
    if (Array.isArray(raw)) list = raw.map((e) => ({ name: nm(e.name ?? e.id), lvl: e.lvl ?? e.level }));
    else if (raw && Array.isArray(raw.enchantments)) list = raw.enchantments.map((e) => ({ name: nm(e.id), lvl: e.level }));
    else if (raw && raw.levels && typeof raw.levels === 'object') list = Object.entries(raw.levels).map(([k, v]) => ({ name: nm(k), lvl: v }));
    const hit = list.find((e) => e.name === name);
    return hit ? Number(hit.lvl) || 0 : 0;
}

/** An attribute's value from mineflayer's entity.attributes ({value, modifiers}), or undefined when the server sent none. */
function attr(attributes, registry, name) {
    const a = registry.attributesByName && registry.attributesByName[name];
    const e = a && attributes ? attributes[a.resource] : undefined;
    if (!e || typeof e.value !== 'number') return undefined;
    const mods = Array.isArray(e.modifiers) ? e.modifiers : [];
    let d = e.value; for (const m of mods) if (m.operation === 0) d += m.amount;
    let v = d; for (const m of mods) if (m.operation === 1) v += d * m.amount;
    for (const m of mods) if (m.operation === 2) v *= 1 + m.amount;
    return v;
}
const effectLevel = (effects, registry, name) => { const d = registry.effectsByName && registry.effectsByName[name]; const e = d && effects ? effects[d.id] : null; return e ? e.amplifier + 1 : 0; };

/**
 * Per-tick progress and ticks to break `block` (prismarine Block) for a player: p = { held (prismarine Item or null), helmet, effects, attributes, onGround,
 * eyeInWater, creative }. Returns { progress, ticks (Infinity when it never breaks, 0 for an instant break), correctTool, speed }.
 */
function destroy(registry, block, p = {}) {
    if (p.creative) return { progress: Infinity, ticks: 0, correctTool: true, speed: Infinity };
    const hardness = block.hardness;
    if (hardness === -1 || hardness === null || hardness === undefined) return { progress: 0, ticks: Infinity, correctTool: false, speed: 0 };
    const held = p.held || null, tool = held ? held.type : null;
    const mult = registry.materials ? registry.materials[block.material] : null;
    // Inventory.getDestroySpeed: the tool's speed for this block, 1 without a matching rule
    let s = f(tool !== null && mult && mult[tool] ? mult[tool] : 1);
    // efficiency: level^2 + 1 (1.21: the mining_efficiency attribute the held tool's enchantment gives; read from the tool itself, because the server's
    // attribute update for a tool just taken in hand arrives a tick later than the swap)
    if (s > 1) { const lv = enchantLevel(held, 'efficiency', registry); if (lv > 0) s = f(s + f(lv * lv + 1)); }
    const haste = Math.max(effectLevel(p.effects, registry, 'Haste'), effectLevel(p.effects, registry, 'ConduitPower'));
    if (haste > 0) s = f(s * f(1 + f(haste * f(0.2))));
    const fatigue = effectLevel(p.effects, registry, 'MiningFatigue');
    if (fatigue > 0) s = f(s * f(FATIGUE[Math.min(fatigue, 4)]));
    const scale = attr(p.attributes, registry, 'playerBlockBreakSpeed');
    if (scale !== undefined) s = f(s * f(scale));
    if (p.eyeInWater) {
        const sub = attr(p.attributes, registry, 'playerSubmergedMiningSpeed');
        if (sub !== undefined) s = f(s * f(sub));
        else if (!enchantLevel(p.helmet, 'aqua_affinity', registry)) s = f(s / 5);
    }
    if (!p.onGround) s = f(s / 5);
    const harvest = !block.harvestTools || (tool !== null && !!block.harvestTools[tool]);
    const progress = f(f(s / f(hardness)) / (harvest ? 30 : 100));
    if (!(progress > 0)) return { progress, ticks: Infinity, correctTool: harvest, speed: s };
    if (progress >= 1) return { progress, ticks: 0, correctTool: harvest, speed: s };
    let acc = f(0), ticks = 0;
    while (acc < 1 && ticks < 1e6) { acc = f(acc + progress); ticks++; }
    return { progress, ticks, correctTool: harvest, speed: s };
}

/** mineflayer's bot.digTime(block) -> milliseconds, computed natively from the bot's state. */
function botDigTime(bot) {
    return function digTime(block) {
        const eye = bot.blockAt ? bot.blockAt(bot.entity.position.offset(0, 1.62, 0)) : null;
        const eyeInWater = !!eye && (eye.name === 'water' || eye.name === 'bubble_column' || (eye.getProperties && eye.getProperties().waterlogged === true));
        const helmet = bot.inventory && bot.inventory.slots ? bot.inventory.slots[5] : null;
        const r = destroy(bot.registry, block, { held: bot.heldItem || null, helmet, effects: bot.entity.effects, attributes: bot.entity.attributes, onGround: !!bot.entity.onGround, eyeInWater, creative: bot.game && bot.game.gameMode === 'creative' });
        return r.ticks === Infinity ? Infinity : r.ticks * 50;
    };
}

module.exports = { destroy, botDigTime, enchantLevel };

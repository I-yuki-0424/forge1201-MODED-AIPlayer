'use strict';
// World model for the skills: what a cell is for walking and what a block looks like to a ray. Read-only.
// `fromBot(bot)` adapts a Mineflayer bot; tests build the same interface from a plain map (tests/test_skills_pure.js).

const DANGER = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose', 'powder_snow',
    'cobweb', 'campfire', 'soul_campfire', 'pointed_dripstone']);
const LIQUID = new Set(['water', 'lava', 'bubble_column']);
// Blocks the use key acts on (vanilla opens or toggles them instead of placing the held block against them).
const INTERACTIVE = /(^|_)(chest|barrel|crafting_table|furnace|smoker|door|trapdoor|fence_gate|lever|button|bed|anvil|shulker_box|hopper|dispenser|dropper|brewing_stand|enchanting_table|loom|grindstone|stonecutter|cartography_table|smithing_table|note_block|repeater|comparator|daylight_detector|bell|lectern|composter|cake|beacon)$/;

/**
 * Walking kind of a block: 'air' (walk through), 'solid' (full or near-full collision box: stand on it), 'liquid', 'danger'
 * (never step in or on), 'partial' (some other collision shape: slabs, fences, closed doors; treated as an obstacle),
 * 'unknown' (chunk not loaded).
 */
function kindOf(block) {
    if (!block) return 'unknown';
    if (DANGER.has(block.name)) return 'danger';
    if (LIQUID.has(block.name)) return 'liquid';
    if (block.boundingBox === 'empty') return 'air';
    const s = block.shapes || [];
    // A full cube, or one box over the whole cell up to >= 0.8 (mud, soul sand, dirt path, farmland): the bot stands on
    // top of it in the cell above (motion.feetCell), so for walking it is ground like a full block.
    if (s.length === 1 && s[0][0] <= 0 && s[0][1] <= 0 && s[0][2] <= 0 && s[0][3] >= 1 && s[0][4] >= 0.8 && s[0][5] >= 1) return 'solid';
    return 'partial';
}

/**
 * Boxes a view ray can hit, relative to the cell. Collision shapes where the block has them; small outline boxes for
 * the non-colliding blocks a player aims at (levers, buttons, torches, open fence gates). Other non-colliding blocks
 * (grass, flowers, air) are transparent here: the crosshair passes through them in this model.
 */
function shapesOf(block) {
    if (!block) return [];
    if (block.shapes && block.shapes.length) return block.shapes;
    const n = block.name;
    if (/(^|_)(lever|button)$/.test(n)) {
        const p = block.getProperties ? block.getProperties() : {};
        if (p.face === 'ceiling') return [[0.25, 0.6, 0.25, 0.75, 1, 0.75]];
        if (p.face === 'wall') {
            // `facing` points away from the supporting block.
            return [{ north: [0.25, 0.2, 0.6, 0.75, 0.8, 1], south: [0.25, 0.2, 0, 0.75, 0.8, 0.4],
                west: [0.6, 0.2, 0.25, 1, 0.8, 0.75], east: [0, 0.2, 0.25, 0.4, 0.8, 0.75] }[p.facing] || [0.25, 0.2, 0.25, 0.75, 0.8, 0.75]];
        }
        return [[0.25, 0, 0.25, 0.75, 0.4, 0.75]];
    }
    if (/torch$/.test(n)) return [[0.375, 0, 0.375, 0.625, 0.625, 0.625]];
    if (/fence_gate$/.test(n)) return [[0, 0, 0.375, 1, 1, 0.625], [0.375, 0, 0, 0.625, 1, 1]];
    return [];
}

const isInteractive = (name) => INTERACTIVE.test(name || '');

/** World interface over a Mineflayer bot: blockAt, kindAt, shapesAt (all by integer cell). */
function fromBot(bot) {
    const Vec3 = require('vec3');
    const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z), false);
    return { blockAt, kindAt: (x, y, z) => kindOf(blockAt(x, y, z)), shapesAt: (x, y, z) => shapesOf(blockAt(x, y, z)) };
}

/** A player fits in the cell (feet and head free) and has solid support below. */
function standable(w, x, y, z) {
    return w.kindAt(x, y, z) === 'air' && w.kindAt(x, y + 1, z) === 'air' && w.kindAt(x, y - 1, z) === 'solid';
}

module.exports = { kindOf, shapesOf, isInteractive, fromBot, standable, DANGER };

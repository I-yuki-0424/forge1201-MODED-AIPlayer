'use strict';
// Observation of the RL policy: only what a player's client legitimately knows (own state, own inventory, loaded blocks,
// the block under the crosshair). No server-only state, no hidden goal progress (DPOD CLAUDE.md "answer leakage").
// Field names, shapes and dtypes are declared once in `obsSpec()` and sent in `hello`; the policy side refuses any
// message whose fields differ.
const Vec3 = require('vec3');
const { ITEMS, GOAL_DIM, encodeGoal } = require('./goal');

const GRID_R = 4;            // horizontal radius, in blocks
const GRID_Y0 = -1, GRID_Y1 = 2;   // layers relative to the block the bot's feet are in
const GRID_N = (2 * GRID_R + 1) ** 2 * (GRID_Y1 - GRID_Y0 + 1);
const CURSOR_REACH = 5;
const ENT_N = 4, ENT_R = 8;     // nearest ENT_N entities within ENT_R blocks: [kind, dx, dy, dz] each

// Closed block categories. Anything unnamed falls back on its collision shape, so modded blocks are covered.
const CATEGORIES = ['air', 'soil', 'stone', 'log', 'leaves', 'planks', 'liquid', 'ore', 'sand', 'other_solid', 'unloaded'];
const CAT = Object.fromEntries(CATEGORIES.map((c, i) => [c, i]));
const SOIL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'farmland', 'mud', 'dirt_path', 'rooted_dirt', 'mycelium']);
const STONE = /^(stone|cobblestone|deepslate|andesite|diorite|granite|bedrock|tuff|cobbled_deepslate)$/;

function categoryOf(block) {
    if (!block) return CAT.unloaded;
    const n = block.name;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') return CAT.air;
    if (SOIL.has(n)) return CAT.soil;
    if (STONE.test(n)) return CAT.stone;
    if (/_(log|wood)$/.test(n)) return CAT.log;
    if (n.endsWith('_leaves')) return CAT.leaves;
    if (n.endsWith('_planks')) return CAT.planks;
    if (n === 'water' || n === 'lava') return CAT.liquid;
    if (n.endsWith('_ore')) return CAT.ore;
    if (n === 'sand' || n === 'red_sand' || n === 'gravel') return CAT.sand;
    return block.boundingBox === 'block' ? CAT.other_solid : CAT.air;
}

const f = (name, shape, dtype) => ({ name, shape, dtype });
function obsSpec() {
    return {
        fields: [
            f('pos', [3], 'float'), f('vel', [3], 'float'), f('look', [4], 'float'), f('on_ground', [], 'bool'),
            f('health', [], 'float'), f('food', [], 'float'), f('held_slot', [], 'int'),
            f('inventory', [ITEMS.length], 'int'), f('grid', [GRID_N], 'int'),
            f('cursor_block', [], 'int'), f('cursor_dist', [], 'float'),
            f('entities', [ENT_N * 4], 'float'), f('goal', [GOAL_DIM], 'float'), f('step_frac', [], 'float'),
        ],
    };
}

const r = (x) => Math.round(x * 1e4) / 1e4;

// kind: 1 dropped item, 2 mob, 3 player, 4 other; 0 = empty slot of the fixed-size list. Offsets are relative to the bot.
const entityKind = (en) => (en.name === 'item' ? 1 : en.type === 'player' ? 3 : /mob|hostile|animal|passive/.test(en.type || '') ? 2 : 4);

function nearbyEntities(bot) {
    const p = bot.entity.position;
    const near = Object.values(bot.entities).filter((en) => en !== bot.entity && en.position && en.position.distanceTo(p) <= ENT_R)
        .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p)).slice(0, ENT_N);
    const out = [];
    for (let i = 0; i < ENT_N; i++) {
        const en = near[i];
        out.push(...(en ? [entityKind(en), r(en.position.x - p.x), r(en.position.y - p.y), r(en.position.z - p.z)] : [0, 0, 0, 0]));
    }
    return out;
}

function inventoryCounts(bot) {
    const inv = {};
    for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
    return inv;
}

/** @param ep {goal, origin, step} current episode */
function observe(bot, ep) {
    const e = bot.entity, p = e.position;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const grid = [];
    for (let dy = GRID_Y0; dy <= GRID_Y1; dy++) {
        for (let dz = -GRID_R; dz <= GRID_R; dz++) {
            for (let dx = -GRID_R; dx <= GRID_R; dx++) grid.push(categoryOf(bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz))));
        }
    }
    const inv = inventoryCounts(bot);
    const cur = bot.blockAtCursor(CURSOR_REACH);
    return {
        pos: [r(p.x), r(p.y), r(p.z)],
        vel: [r(e.velocity.x), r(e.velocity.y), r(e.velocity.z)],
        look: [r(Math.sin(e.yaw)), r(Math.cos(e.yaw)), r(Math.sin(e.pitch)), r(Math.cos(e.pitch))],
        on_ground: !!e.onGround,
        health: r(bot.health ?? 0), food: r(bot.food ?? 0),
        held_slot: bot.quickBarSlot,
        inventory: ITEMS.map((n) => inv[n] || 0),
        grid,
        cursor_block: cur ? categoryOf(cur) : CAT.air,
        cursor_dist: cur ? r(cur.intersect.distanceTo(p.offset(0, e.eyeHeight ?? 1.62, 0))) : -1,
        entities: nearbyEntities(bot),
        goal: encodeGoal(ep.goal, p, ep.origin).map(r),
        step_frac: r(ep.step / ep.goal.max_steps),
    };
}

module.exports = { CATEGORIES, CAT, GRID_N, GRID_R, categoryOf, obsSpec, observe, inventoryCounts };

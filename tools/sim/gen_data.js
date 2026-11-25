'use strict';
// Data tables of the Rust simulator (tools/sim), from the same sources as the real environment: minecraft-data 1.20.1 (blocks,
// items, recipes, materials, foods, entities) and the mod set's registry (vocabulary only), vocab() exactly as src/rl/skill_space.js.
//   docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node tools/sim/gen_data.js
// SIM_MC_VERSION=1.21.1 writes data/data-1.21.1.json instead: the same block, recipe and food tables for the version a recorded trace was
// made on (`forgeaip-sim replay`, docs/implemented/SIM-PARITY-v1.md); its item and entity lists are that version's own (no RL vocabulary).
const fs = require('fs');
const VERSION = process.env.SIM_MC_VERSION || '1.20.1', RL = VERSION === '1.20.1';
const mc = require('minecraft-data')(VERSION);
if (!mc) throw new Error(`minecraft-data has no ${VERSION}`);
const { vocab, CMDS } = require('../../src/rl/skill_space');
const { CATEGORIES } = require('../../src/rl/observation');
const voc = RL ? vocab(mc, require('../../modpack/forgeaip-create.registry.json'))
    : { items: ['', ...mc.itemsArray.map((i) => i.name)], entities: ['', ...mc.entitiesArray.map((e) => e.name)] };
const catOf = (b) => {
    const n = b.name;
    if (['air', 'cave_air', 'void_air'].includes(n)) return 'air';
    if (['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'farmland', 'mud', 'dirt_path', 'rooted_dirt', 'mycelium'].includes(n)) return 'soil';
    if (/^(stone|cobblestone|deepslate|andesite|diorite|granite|bedrock|tuff|cobbled_deepslate)$/.test(n)) return 'stone';
    if (/_(log|wood)$/.test(n)) return 'log';
    if (n.endsWith('_leaves')) return 'leaves';
    if (n.endsWith('_planks')) return 'planks';
    if (n === 'water' || n === 'lava') return 'liquid';
    if (n.endsWith('_ore')) return 'ore';
    if (['sand', 'red_sand', 'gravel'].includes(n)) return 'sand';
    return b.boundingBox === 'block' ? 'other_solid' : 'air';
};
const kindOf = (b) => {
    if (['air', 'cave_air', 'void_air'].includes(b.name)) return 'air';
    if (b.name === 'water' || b.name === 'lava') return 'liquid';
    if (/^(ladder|vine|scaffolding|twisting_vines|weeping_vines|cave_vines)/.test(b.name)) return 'climb';
    return b.boundingBox === 'block' ? 'solid' : 'passable';
};
const itemName = (id) => (mc.items[id] ? mc.items[id].name : null);
const blocks = [];
for (let id = 0; id <= Math.max(...mc.blocksArray.map((b) => b.id)); id++) {
    const b = mc.blocks[id];
    if (!b) { blocks.push(null); continue; }
    const mat = mc.materials[b.material] || {};
    blocks.push({ n: b.name, h: b.hardness === null ? -1 : b.hardness, d: !!b.diggable, k: kindOf(b), c: CATEGORIES.indexOf(catOf(b)),
        ht: b.harvestTools ? Object.keys(b.harvestTools).map((i) => itemName(Number(i))).filter(Boolean) : null,
        dr: (b.drops || []).map((d) => itemName(typeof d === 'object' ? d.drop : d)).filter(Boolean),
        tm: Object.fromEntries(Object.entries(mat).map(([i, m]) => [itemName(Number(i)), m]).filter(([n]) => n)) });
}
const recipes = [];
for (const [rid, list] of Object.entries(mc.recipes)) {
    const r = itemName(Number(rid));
    for (const rec of list) {
        const n = {};
        const put = (id) => { const nm = id === null || id === undefined || id < 0 ? null : itemName(id); if (nm) n[nm] = (n[nm] || 0) + 1; };
        let table = false;
        if (rec.inShape) { table = rec.inShape.length > 2 || rec.inShape.some((row) => row.length > 2); rec.inShape.flat().forEach(put); }
        else (rec.ingredients || []).forEach(put);
        if (!rec.inShape && (rec.ingredients || []).length > 4) table = true;
        recipes.push({ r, c: rec.result.count || 1, n, t: table });
    }
}
const foods = Object.fromEntries(mc.foodsArray.map((f) => [f.name, [f.foodPoints, f.saturation]]));
// Per block state (versions other than the RL one): the walking kind and the aim shapes exactly as the action layer's world model sees them
// (src/skills/world.js kindOf / shapesOf: air, solid, partial, water, climb, liquid, danger), and the collision boxes (prismarine-block shapes) the
// body collides with. `states[id] = [block id, kind, aim shape index, collision shape index]`, shapes deduplicated in `shapes`.
let states = null, shapes = null;
if (!RL) {
    const { kindOf: wKind, shapesOf } = require('../../src/skills/world');
    const B = require('prismarine-block')(VERSION);
    const sIx = new Map(); shapes = [];
    const shapeId = (list) => { const k = JSON.stringify(list || []); if (!sIx.has(k)) { sIx.set(k, shapes.length); shapes.push(list || []); } return sIx.get(k); };
    states = [];
    for (const b of mc.blocksArray) {
        blocks[b.id].ds = b.defaultState;
        // the block's properties in protocol order (state id = minStateId + mixed radix over them, the last one fastest): region files name states by them
        blocks[b.id].ms = b.minStateId;
        blocks[b.id].sp = (b.states || []).map((st) => [st.name, st.type === 'bool' ? ['true', 'false'] : (st.values || Array.from({ length: st.num_values }, (_, i) => String(i))).map(String)]);
        for (let id = b.minStateId; id <= b.maxStateId; id++) {
            const blk = B.fromStateId(id, 0);
            // the properties the player movement reads (src/native/physics/blocks.js): fluid levels, waterlogging, scaffolding, trapdoors, ladders, bubble columns
            const pr = blk.getProperties ? blk.getProperties() : {};
            const keep = {};
            for (const k of ['level', 'waterlogged', 'distance', 'bottom', 'open', 'facing', 'drag']) if (pr[k] !== undefined && (['water', 'lava', 'scaffolding', 'ladder', 'bubble_column'].includes(b.name) || /_trapdoor$/.test(b.name) || (k === 'waterlogged' && (pr[k] === true || pr[k] === 'true')))) keep[k] = String(pr[k]);
            states[id] = [b.id, wKind(blk), shapeId(shapesOf(blk)), shapeId(blk.shapes), ...(Object.keys(keep).length ? [keep] : [])];
        }
    }
}
const out = { version: VERSION, items: voc.items, entities: voc.entities, cmds: CMDS, blocks, recipes, foods, categories: CATEGORIES, ...(states ? { states, shapes } : {}) };
const file = RL ? 'tools/sim/data/data.json' : `tools/sim/data/data-${VERSION}.json`;
fs.writeFileSync(file, JSON.stringify(out));
console.log(VERSION, 'items', voc.items.length, 'entities', voc.entities.length, 'blocks', blocks.length, 'recipes', recipes.length, 'bytes', fs.statSync(file).size);

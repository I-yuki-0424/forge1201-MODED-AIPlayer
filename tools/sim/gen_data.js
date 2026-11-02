'use strict';
// Data tables of the Rust simulator (tools/sim), from the same sources as the real environment: minecraft-data 1.20.1 (blocks,
// items, recipes, materials, foods, entities) and the mod set's registry (vocabulary only), vocab() exactly as src/rl/skill_space.js.
//   docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node tools/sim/gen_data.js
const fs = require('fs');
const mc = require('minecraft-data')('1.20.1');
const { vocab, CMDS } = require('../../src/rl/skill_space');
const { CATEGORIES } = require('../../src/rl/observation');
const reg = require('../../modpack/forgeaip-create.registry.json');
const voc = vocab(mc, reg);
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
const out = { items: voc.items, entities: voc.entities, cmds: CMDS, blocks, recipes, foods, categories: CATEGORIES };
fs.writeFileSync('tools/sim/data/data.json', JSON.stringify(out));
console.log('items', voc.items.length, 'entities', voc.entities.length, 'blocks', blocks.length, 'recipes', recipes.length, 'bytes', fs.statSync('tools/sim/data/data.json').size);

// Tests of src/transport/mod_registry.js with synthetic FML3 registry-sync payloads (the wire format of Forge 1.20.1
// HandshakeMessages.S2CRegistry + ForgeRegistry.Snapshot) and a small dump table. The live check against a Create
// server is scripts/world/registry-check.js.
const assert = require('assert');
const { parseRegistrySync, hasContentMods, install } = require('../src/transport/mod_registry');

function test(name, fn) { console.log(`--- test: ${name} ---`); fn(); console.log('[OK]'); }

const varint = (v) => { const out = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const str = (s) => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s)]);
/** One disc-3 payload: registry name, hasSnapshot, ids map, then empty aliases/overrides/blocked. */
function payload(registry, entries) {
    const parts = [Buffer.from([3]), str(registry), Buffer.from([1]), varint(entries.length)];
    for (const [name, id] of entries) parts.push(str(name), varint(id));
    parts.push(varint(0), varint(0), varint(0));
    return Buffer.concat(parts);
}

const fresh = () => require('prismarine-registry')('1.20.1');
const base = fresh();
const vanillaBlocks = base.blocksArray.slice().sort((a, b) => a.id - b.id).map((b) => [`minecraft:${b.name}`, b.id]);
const vanillaItems = base.itemsArray.map((i) => [`minecraft:${i.name}`, i.id]);
const nB = vanillaBlocks.length, nI = 1 + Math.max(...vanillaItems.map((i) => i[1]));
const vanillaStates = 1 + Math.max(...base.blocksArray.map((b) => b.maxStateId));

const table = {
    format: 1, blockStates: vanillaStates + 8 + 1,
    shapes: [[[0.375, 0, 0.375, 0.625, 1, 0.625]], [[0, 0, 0, 1, 1, 1]], []],
    blocks: [
        { name: 'create:shaft', states: 8, defaultState: 1, // 4 x 2 = 8 states (a made-up 4-value axis keeps the product small and asymmetric)
          properties: [{ name: 'axis', type: 'enum', values: ['x', 'y', 'z', 'w'] }, { name: 'waterlogged', type: 'bool', values: ['true', 'false'] }],
          shape: [0, 0, 0, 0, 0, 0, 0, 0], hardness: 1.5, resistance: 6, air: false, liquid: false, transparent: true, light: 0, requiresTool: false, tool: 'pickaxe', item: 'create:shaft' },
        { name: 'create:andesite_casing', states: 1, defaultState: 0, properties: [], shape: 1, hardness: 2, resistance: 6, transparent: false, light: 0, requiresTool: true, tool: 'axe', tier: 'stone', item: 'create:andesite_casing' },
    ],
    items: [{ name: 'create:shaft', id: nI, stackSize: 64 }, { name: 'create:wrench', id: nI + 1, stackSize: 1 }],
};

const createSync = () => [
    payload('minecraft:block', [...vanillaBlocks, ['create:shaft', nB], ['create:andesite_casing', nB + 1]]),
    payload('minecraft:item', [...vanillaItems, ['create:shaft', nI], ['create:wrench', nI + 1], ['create:andesite_casing', nI + 2]]),
    payload('minecraft:fluid', [['minecraft:empty', 0], ['minecraft:water', 2]]),
];

test('registry sync decodes field by field; content mods only beyond minecraft and forge', () => {
    const sync = parseRegistrySync(createSync());
    assert.strictEqual(sync.get('minecraft:block').get('create:shaft'), nB);
    assert.strictEqual(sync.get('minecraft:item').get('minecraft:dirt'), base.itemsByName.dirt.id);
    assert.strictEqual(sync.get('minecraft:fluid').size, 2);
    assert.strictEqual(hasContentMods(sync), true);
    const vanilla = parseRegistrySync([payload('minecraft:block', vanillaBlocks), payload('minecraft:item', [...vanillaItems, ['forge:bucket_filling', nI]])]);
    assert.strictEqual(hasContentMods(vanilla), false);
    assert.throws(() => parseRegistrySync([Buffer.from([3, 5, 0x61])]), /truncated/);
});

test('install: exact state ids, names, properties, shapes, tools and items; vanilla untouched', () => {
    const reg = fresh();
    const dirtItem = reg.itemsByName.dirt.id, dirtState = reg.blocksByName.dirt.minStateId;
    const r = install(reg, parseRegistrySync(createSync()), table);
    assert.deepStrictEqual({ blocks: r.blocks, states: r.states, items: r.items, missing: r.missing, error: r.error, note: r.note },
        { blocks: 2, states: 9, items: 3, missing: [], error: undefined, note: undefined });
    const shaft = reg.blocksByStateId[vanillaStates + 3];
    assert.strictEqual(shaft.name, 'create:shaft');
    assert.strictEqual(reg.blocksByStateId[vanillaStates + 8].name, 'create:andesite_casing');
    assert.deepStrictEqual(reg.blocksByName['create:shaft'].shapes, [[0.375, 0, 0.375, 0.625, 1, 0.625]]);
    assert.strictEqual(reg.blocksByName['create:andesite_casing'].boundingBox, 'block');
    assert.strictEqual(reg.blocksByName['create:andesite_casing'].material, 'mineable/axe');
    assert.ok(reg.blocksByName['create:andesite_casing'].harvestTools[reg.itemsByName.stone_axe.id]);
    assert.ok(!reg.blocksByName['create:andesite_casing'].harvestTools[reg.itemsByName.wooden_axe.id]);
    assert.deepStrictEqual(reg.blocksByName['create:shaft'].drops, [nI]);
    assert.strictEqual(reg.items[nI + 1].name, 'create:wrench');
    assert.strictEqual(reg.items[nI + 1].stackSize, 1);
    assert.strictEqual(reg.itemsByName.dirt.id, dirtItem);
    assert.strictEqual(reg.blocksByStateId[dirtState].name, 'dirt');
    // prismarine-block decodes properties with the last one varying fastest: state index 3 = axis y, waterlogged false.
    const Block = require('prismarine-block')(reg);
    const b = Block.fromStateId(vanillaStates + 3, 0);
    assert.strictEqual(b.name, 'create:shaft');
    assert.deepStrictEqual(b.getProperties(), { axis: 'y', waterlogged: false });
    assert.deepStrictEqual(b.shapes, [[0.375, 0, 0.375, 0.625, 1, 0.625]]);
});

test('no table or a block missing from it: no blocks (state ids would be guesses), items still exact', () => {
    const reg = fresh();
    const r = install(reg, parseRegistrySync(createSync()), null);
    assert.match(r.error, /2 mod blocks not in the table/);
    assert.strictEqual(r.blocks, 0);
    assert.strictEqual(reg.blocksByStateId[vanillaStates], undefined);
    assert.strictEqual(reg.items[nI + 1].name, 'create:wrench');
});

test('a vanilla block or item off its minecraft-data place stops the install', () => {
    const swapped = vanillaBlocks.slice(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    const r = install(fresh(), parseRegistrySync([payload('minecraft:block', swapped.map(([n], i) => [n, i]))]), table);
    assert.match(r.error, /minecraft-data says/);
    const items = install(fresh(), parseRegistrySync([payload('minecraft:block', vanillaBlocks), payload('minecraft:item', [['minecraft:dirt', 999]])]), table);
    assert.match(items.error, /vanilla item minecraft:dirt has id 999/);
});

console.log('All mod registry tests passed.');

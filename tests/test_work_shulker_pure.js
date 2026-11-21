// Materials inside shulker boxes inside a chest (owner 2026-11-21, creative server): what a bot reads of a box, and the supply that lifts one out, sets it down and takes from it. Fake bot, no game.
const assert = require('assert');
const moves = require('../src/work/bot/moves');
const supply = require('../src/work/builder/supply');
const sites = require('../src/work/bot/sites');

setTimeout(() => { console.error('test watchdog'); process.exit(2); }, 20000).unref();
const items = { 1087: { name: 'white_bed' }, 36: { name: 'oak_planks' }, 733: { name: 'lever' } };
const bot = { registry: { items, itemsByName: Object.fromEntries(Object.entries(items).map(([id, v]) => [v.name, { id: Number(id), stackSize: v.name === 'white_bed' ? 1 : 64, name: v.name }])) } };
const box = (slot, contents) => ({ slot, name: 'white_shulker_box', components: [{ type: 'container', data: { contents } }] });
const stack = (itemId, itemCount) => ({ itemId, itemCount, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] });

console.log('--- test: a shulker box stack is read through its container component ---');
assert.deepStrictEqual(moves.shulkerHolds(bot, box(0, [stack(1087, 1), stack(1087, 1), stack(36, 64)])), { white_bed: 2, oak_planks: 64 });
assert.deepStrictEqual(moves.shulkerHolds(bot, { name: 'stone', components: [] }), {});
assert.deepStrictEqual(moves.shulkerHolds(bot, { name: 'white_shulker_box' }), {}, 'no components at all');
assert.deepStrictEqual(moves.shulkerHolds(bot, box(0, [stack(99999, 3)])), {}, 'an id the registry does not know is ignored');
console.log('[OK]');

console.log('--- test: the purpose `materials` exists, is a container the bots take from, and ranks before the rest ---');
assert.ok(sites.PURPOSES.materials && sites.CONTAINER_PURPOSES.has('materials'));
console.log('[OK]');

console.log('--- test: restock lifts a shulker box out of the chest, sets it down, takes from it and keeps it as a source ---');
(async () => {
    const calls = [], inv = { white_bed: 0 }, chest = { x: 898, y: 73, z: 723 };
    const plan = { units: [[{ x: 1, y: 70, z: 1, block: 'white_bed', props: {} }]], materials: { white_bed: 1 } };
    const fake = { inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45, slots: [] }, registry: bot.registry };
    const env = {
        bot: fake, w: { nameAt: () => 'air', kindAt: (x, y, z) => (y < 0 ? 'solid' : 'air') }, here: () => ({ x: 0, y: 0, z: 0 }), pos: () => ({ x: 0, y: 0, z: 0 }), have: (it) => inv[it] || 0, cancelled: () => false,
        sites: { sources: (from, prefer) => { calls.push(['sources', prefer]); return [chest]; } },
        travel: async () => ({ ok: true }),
        exec: async (name, a) => { calls.push([name, a.item, a.x, a.y, a.z]); return { ok: true }; },
        run: async (name, a) => {
            calls.push([name, a.x, a.y, a.z]);
            if (name === 'take_many' && a.x === chest.x) return { ok: true, detail: { got: [], missing: [{ item: 'white_bed', want: 1 }], shulkers: [{ slot: 0, name: 'white_shulker_box', has: { white_bed: 27 } }] } };
            if (name === 'take_shulker') return { ok: true, detail: { took: 'white_shulker_box', has: { white_bed: 27 } } };
            if (name === 'take_many') { inv.white_bed = 1; return { ok: true, detail: { got: [{ item: 'white_bed', moved: 1 }], missing: [] } }; }
            return { ok: true, detail: {} };
        },
    };
    const r = await supply.restock(env, plan, { white_bed: 1 }, { topup: false, reserve: 3 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.unpacked, 1);
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'sources')[0], ['sources', 'materials'], 'materials chests are asked for first');
    assert.deepStrictEqual(plan.boxes, [{ x: 1, y: 0, z: 0, shulker: true }]);
    assert.ok(calls.some((c) => c[0] === 'place' && c[1] === 'white_shulker_box' && c[2] === 1), 'the box is set down beside the bot');
    const takes = calls.filter((c) => c[0] === 'take_many');
    assert.deepStrictEqual(takes.map((c) => c[1]), [898, 1], 'first the chest, then the placed box');
    // the next trip goes to the placed box first (it is known to hold the item)
    inv.white_bed = 0; calls.length = 0;
    env.run = async (name, a) => { calls.push([name, a.x]); inv.white_bed = 1; return { ok: true, detail: { got: [{ item: 'white_bed', moved: 1 }], missing: [] } }; };
    const r2 = await supply.restock(env, plan, { white_bed: 1 }, { topup: false, reserve: 3 });
    assert.strictEqual(r2.ok, true); assert.deepStrictEqual(calls.filter((c) => c[0] === 'take_many')[0], ['take_many', 1], 'the placed box is visited first');
    console.log('[OK]');

    console.log('--- test: no free cell: the box goes back into the chest and the trip reports what is short ---');
    const plan2 = { units: plan.units, materials: plan.materials }, calls2 = [];
    const env2 = { ...env, have: () => 0, w: { nameAt: () => 'air', kindAt: () => 'air' }, exec: async () => ({ ok: true }),
        run: async (name, a) => { calls2.push(name); if (name === 'take_many') return { ok: true, detail: { got: [], missing: [{ item: 'white_bed', want: 1 }], shulkers: [{ slot: 0, name: 'white_shulker_box', has: { white_bed: 27 } }] } }; if (name === 'take_shulker') return { ok: true, detail: { took: 'white_shulker_box', has: { white_bed: 27 } } }; return { ok: true, detail: {} }; } };
    const r3 = await supply.restock(env2, plan2, { white_bed: 1 }, { topup: false, reserve: 3 });
    assert.strictEqual(r3.ok, false); assert.strictEqual(r3.reason, 'missing_item'); assert.ok(calls2.includes('deposit_many'), 'the box was put back');
    console.log('[OK]');
})().catch((e) => { console.error(e); process.exit(1); });

console.log('--- test: temporary blocks: pumpkin is none by default, one once the operator names it; a builder takes a stack along, but a missing one never fails the unit ---');
(async () => {
    const TB = require('../src/work/bot/tempblocks'), vo = require('../src/work/bot/janitor').valueOf;
    const reg = { blocksByName: { pumpkin: { boundingBox: 'block', diggable: true, hardness: 1 }, cobblestone: { boundingBox: 'block', diggable: true, hardness: 2 } } };
    assert.strictEqual(TB.isTemp('pumpkin', reg, vo), false);
    assert.deepStrictEqual(TB.setExtra('pumpkin'), ['pumpkin']);
    assert.strictEqual(TB.isTemp('pumpkin', reg, vo), true); assert.strictEqual(TB.preferred(), 'pumpkin'); assert.strictEqual(TB.BASE[0], 'pumpkin', 'the shared array is updated in place');
    assert.throws(() => TB.setExtra('Bad Name'), /item name/); assert.throws(() => TB.setExtra('a,b,c,d,e,f'), /at most 5/);
    const pack = (items) => ({ registry: { ...reg, items: {}, itemsByName: {} }, inventory: { items: () => items, inventoryStart: 9, inventoryEnd: 45, slots: [] } });
    assert.deepStrictEqual(supply.tempWish(pack([])), { item: 'pumpkin', n: 64 });
    const b2 = pack([]); supply.tempWish(b2); assert.strictEqual(supply.tempWish(b2), null, 'one try in five minutes');
    assert.strictEqual(supply.tempWish(pack([{ name: 'pumpkin', count: 30 }])), null, 'enough in the pack');
    // a trip for a missing temporary block is soft: the unit does not fail on it
    const plan = { units: [[{ x: 1, y: 70, z: 1, block: 'white_bed', props: {} }]], materials: { white_bed: 1 } }, have = { white_bed: 1 };
    const env = { bot: { inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45, slots: [] }, registry: bot.registry }, w: { nameAt: () => 'air', kindAt: () => 'air' }, here: () => ({ x: 0, y: 0, z: 0 }), pos: () => ({ x: 0, y: 0, z: 0 }),
        have: (it) => have[it] || 0, cancelled: () => false, sites: { sources: () => [{ x: 5, y: 5, z: 5 }] }, travel: async () => ({ ok: true }), exec: async () => ({ ok: true }),
        run: async () => ({ ok: true, detail: { got: [], missing: [{ item: 'pumpkin', want: 64 }] } }) };
    const r = await supply.restock(env, plan, { white_bed: 1, pumpkin: 64 }, { trigger: { white_bed: 1, pumpkin: 64 }, soft: ['pumpkin'], topup: false, reserve: 3 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const r2 = await supply.restock(env, plan, { white_bed: 2 }, { trigger: { white_bed: 2 }, topup: false, reserve: 3 });
    assert.strictEqual(r2.ok, false, 'a missing MATERIAL still fails');
    TB.setExtra(''); assert.strictEqual(TB.preferred(), 'cobblestone'); assert.strictEqual(TB.isTemp('pumpkin', reg, vo), false);
    console.log('[OK]');
})().catch((e) => { console.error(e); process.exit(1); });

console.log('--- test: the stock reader walks the stacks one request at a time (an RCON reply is at most 4096 bytes), counts shulker contents apart, and says so when a read fails ---');
(async () => {
    const { LitematicPart } = require('../src/work/service/litematic'), read = LitematicPart.prototype._readStock;
    const head = '1, 2, 3 has the following block data: ';
    const els = [
        head + '{Slot: 0b, id: "minecraft:white_shulker_box", count: 1, components: {"minecraft:container": [{slot: 0, item: {id: "minecraft:white_bed"}}, {slot: 1, item: {id: "minecraft:white_bed"}}, {slot: 2, item: {id: "minecraft:lever", count: 64}}]}}',
        head + '{Slot: 5b, id: "minecraft:stone", count: 30}',
    ];
    const asked = [], o = { rcon: async (c) => { asked.push(c); const m = /Items\[(\d+)\]$/.exec(c); const i = Number(m[1]); return els[i] || `Found no elements matching Items[${i}]`; } };
    const r = await read.call(o, 1, 2, 3);
    assert.deepStrictEqual(r, { loose: { stone: 30 }, boxed: { white_bed: 2, lever: 64 }, boxes: 1 });
    assert.deepStrictEqual(asked, ['data get block 1 2 3 Items[0]', 'data get block 1 2 3 Items[1]', 'data get block 1 2 3 Items[2]']);
    assert.deepStrictEqual(await read.call({ rcon: async () => 'Found no elements matching Items[0]' }, 1, 2, 3), { loose: {}, boxed: {}, boxes: 0 }, 'an empty container');
    await assert.rejects(read.call({ rcon: async () => { throw new Error('rcon: connection closed'); } }, 1, 2, 3), /reading the container at 1 2 3/);
    await assert.rejects(read.call({ rcon: async () => head + '{Slot: 0b, id: "minecraft:stone", count: 3' }, 1, 2, 3), /stack 0/);
    console.log('[OK]');
})().catch((e) => { console.error(e); process.exit(1); });

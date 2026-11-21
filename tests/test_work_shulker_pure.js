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

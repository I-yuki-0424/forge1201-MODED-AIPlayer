// Temporary blocks (owner 2026-11-10): any placeable, non-falling, low-value block is a climbing block, and a stack of them is kept back when a bot stores things. Pure.
const assert = require('assert');
const tb = require('../src/work/bot/tempblocks');
const janitor = require('../src/work/bot/janitor');
const { Sites } = require('../src/work/bot/sites');

setTimeout(() => { console.error('test watchdog: still running after 20 s'); process.exit(2); }, 20000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const reg = (o) => ({ blocksByName: Object.fromEntries(Object.entries(o).map(([n, v]) => [n, { name: n, boundingBox: 'block', diggable: true, hardness: 1, ...v }])) });

(async () => {
    await test('isTemp: low-value full blocks yes; falling blocks, shapes, valuables and hard blocks no', () => {
        for (const n of ['cobblestone', 'minecraft:dirt', 'end_stone', 'blackstone', 'netherrack', 'basalt', 'create:limestone', 'terracotta', 'sandstone', 'tuff']) assert.ok(tb.isTemp(n), n);
        for (const n of ['sand', 'red_sand', 'gravel', 'white_concrete_powder', 'anvil', 'dragon_egg', 'scaffolding', 'cobblestone_slab', 'stone_stairs', 'cobblestone_wall', 'diamond_block', 'oak_planks', 'glass', 'iron_ore', 'obsidian']) assert.ok(!tb.isTemp(n), n);
    });
    await test('isTemp with a registry: the data decides (box, diggable, hardness); a value from the table counts for a mod block', () => {
        const r = reg({ cobblestone: {}, end_stone: { hardness: 3 }, obsidian: { hardness: 50 }, bedrock: { hardness: -1, diggable: false }, 'mod:rubble': {}, 'mod:fancy': {}, stone_slab: { boundingBox: 'empty' } });
        assert.ok(tb.isTemp('cobblestone', r)); assert.ok(tb.isTemp('end_stone', r)); assert.ok(!tb.isTemp('obsidian', r)); assert.ok(!tb.isTemp('bedrock', r));
        assert.ok(!tb.isTemp('mod:rubble', r), 'unknown to the table: not low value');
        assert.ok(tb.isTemp('mod:rubble', r, (n) => (n === 'mod:rubble' ? 2 : 50)), 'valued at 2: low');
        assert.ok(!tb.isTemp('mod:fancy', r, (n) => (n === 'mod:rubble' ? 2 : 50)));
        assert.ok(!tb.isTemp('cobblestone', reg({})), 'a name the registry does not know is no block');
    });
    await test('order / choose: the usual blocks first, then the biggest stack; dirt first without a pickaxe; nothing that falls', () => {
        const held = [{ name: 'sand', count: 64 }, { name: 'end_stone', count: 40 }, { name: 'basalt', count: 12 }, { name: 'dirt', count: 3 }, { name: 'cobblestone', count: 5 }, { name: 'diamond', count: 2 }];
        assert.deepStrictEqual(tb.order(held), ['cobblestone', 'dirt', 'end_stone', 'basalt']);
        assert.deepStrictEqual(tb.order(held, null, { hand: true }), ['dirt', 'cobblestone', 'end_stone', 'basalt']);
        assert.strictEqual(tb.choose(held), 'cobblestone'); assert.strictEqual(tb.choose(held, null, { min: 6 }), 'end_stone'); assert.strictEqual(tb.choose(held, null, { min: 99 }), null);
        assert.strictEqual(tb.choose([{ name: 'sand', count: 64 }, { name: 'gravel', count: 64 }]), null, 'only falling blocks: none');
        assert.strictEqual(tb.choose([{ name: 'end_stone', count: 2 }]), 'end_stone', 'no cobblestone needed');
    });
    await test('reserve: one stack over as few kinds as possible, the biggest first; less than a stack = all of it', () => {
        const r = tb.reserve(new Map([['cobblestone', 200], ['end_stone', 30], ['sand', 500], ['diamond', 3]]));
        assert.deepStrictEqual([...r], [['cobblestone', 64]]);
        const r2 = tb.reserve(new Map([['cobblestone', 20], ['end_stone', 30], ['dirt', 40]]));
        assert.deepStrictEqual([...r2], [['dirt', 40], ['end_stone', 24]]);
        assert.deepStrictEqual([...tb.reserve(new Map([['diamond', 3]]))], []);
    });
    await test('janitor keeps one stack of temporary blocks when it stores everything, with and without a depot, whichever kind the pack holds', () => {
        const pol = janitor.pitPolicy({ depot: { kind: 'chest', x: 0, y: 0, z: 0 } });
        const items = [{ name: 'end_stone', count: 200 }, { name: 'netherrack', count: 128 }, { name: 'coal', count: 30 }, { name: 'dirt', count: 10 }];
        const ops = janitor.plan(items, 2, pol);
        const left = (n, have) => have - ops.filter((o) => o.item === n).reduce((a, o) => a + o.count, 0);
        const kept = left('end_stone', 200) + left('netherrack', 128) + left('dirt', 10);
        assert.ok(kept >= 64, `kept ${kept}`);
        assert.strictEqual(left('end_stone', 200), 64, 'the biggest stack is the one kept');
        assert.strictEqual(left('coal', 30), 0, 'what is not a climbing block is stored');
        // no depot: it is thrown away only below neverToss, and the reserve stays
        const ops2 = janitor.plan([{ name: 'cobblestone', count: 100 }, { name: 'dirt', count: 100 }, { name: 'gravel', count: 100 }], 0, janitor.pitPolicy());
        const k2 = (n, have) => have - ops2.filter((o) => o.item === n).reduce((a, o) => a + o.count, 0);
        assert.ok(k2('cobblestone', 100) + k2('dirt', 100) >= 64);
        assert.strictEqual(k2('gravel', 100), 0, 'gravel is worth nothing and falls: gone');
        // a tiny stack is kept whole
        const ops3 = janitor.plan([{ name: 'tuff', count: 20 }, { name: 'coal', count: 64 }], 0, pol);
        assert.ok(!ops3.some((o) => o.item === 'tuff'), 'less than a stack of the only climbing block stays');
    });
})().catch((e) => { console.error(e); process.exit(1); });

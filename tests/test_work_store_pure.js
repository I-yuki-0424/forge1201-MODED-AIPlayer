// Storing (owner 2026-11-10: "it stores one stack and comes back right away"): a trip to a container takes everything that may be stored, a full container is
// followed by the next one in the same trip, and a container that said "full" is not walked to again at once. Pure: fake environment, no server.
const assert = require('assert');
const janitor = require('../src/work/bot/janitor');
const { Sites } = require('../src/work/bot/sites');

setTimeout(() => { console.error('test watchdog: still running after 20 s'); process.exit(2); }, 20000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const items = (o) => Object.entries(o).map(([name, count]) => ({ name, count }));

(async () => {
    await test('plan: with a container, one trip stores every stack above the protected minimum, not just enough for freeTarget', () => {
        const have = { cobblestone: 640, dirt: 300, gravel: 200, coal: 90, raw_iron: 70, diamond: 5, iron_pickaxe: 1, bread: 12 };
        const sites = new Sites([{ name: 'main', x: 5, y: 64, z: 5, purpose: 'any' }]);
        const ops = janitor.plan(items(have), 3, janitor.pitPolicy({ sites: () => sites }));
        const kinds = ops.filter((o) => o.op === 'deposit').map((o) => o.item).sort();
        assert.deepStrictEqual(kinds, ['coal', 'cobblestone', 'diamond', 'dirt', 'gravel', 'raw_iron'], 'everything of value goes in, tools and food stay');
        assert.strictEqual(ops.find((o) => o.item === 'cobblestone').count, 640 - 64, 'one stack (64) of climbing blocks stays: it covers the 16 cobblestone the water rule needs (owner 2026-11-10)');
        const lazy = janitor.plan(items(have), 3, janitor.pitPolicy({ sites: () => sites, dumpAll: false }));
        assert.ok(lazy.filter((o) => o.op === 'deposit').length < kinds.length, 'the old behaviour (stop at freeTarget) is still there with dumpAll off');
        assert.deepStrictEqual(janitor.plan(items({ cobblestone: 30, bread: 4 }), 30, janitor.pitPolicy({ sites: () => sites })), [], 'no trip when there is room');
    });

    await test('plan: with tagged sites but none that stores an item (a tools chest and a take-only supply chest), junk is thrown away and valuables stay: no deposit that cannot succeed', () => {
        const sites = new Sites([{ name: 't', x: 5, y: 64, z: 5, purpose: 'tools' }, { name: 'c', x: 9, y: 64, z: 5, purpose: 'free' }]);
        const ops = janitor.plan(items({ cobblestone: 640, dirt: 300, gravel: 200, diamond: 5, raw_iron: 70, iron_pickaxe: 1 }), 3, janitor.pitPolicy({ sites: () => sites }));
        assert.deepStrictEqual(ops.filter((o) => o.op === 'deposit'), [], 'nothing can be deposited');
        const tossed = ops.filter((o) => o.op === 'toss').map((o) => o.item).sort();
        assert.ok(tossed.includes('cobblestone') && tossed.includes('dirt'), `junk goes: ${tossed}`);
        assert.ok(!tossed.includes('diamond') && !tossed.includes('raw_iron') && !tossed.includes('iron_pickaxe'), 'valuables and tools stay');
        const any = new Sites([{ name: 'a', x: 5, y: 64, z: 5, purpose: 'any' }]);
        assert.ok(janitor.plan(items({ cobblestone: 640 }), 3, janitor.pitPolicy({ sites: () => any })).some((o) => o.op === 'deposit'), 'with a chest that takes anything, it is still stored');
    });

    await test('maintain: a full container takes what fits, the rest goes to the next container in the same trip, and the full one is skipped for two minutes', async () => {
        const sites = new Sites([{ name: 'a', x: 5, y: 64, z: 5, purpose: 'any' }, { name: 'b', x: 9, y: 64, z: 5, purpose: 'any' }]);
        const have = { cobblestone: 400, dirt: 200, coal: 80, raw_iron: 70 }, calls = [];
        const env = {
            inv: () => ({ items: items(have), slotsFree: 2, worn: [] }), pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), w: {}, exec: async () => ({ ok: true }),
            run: async (name, a) => {
                calls.push([name, `${a.x},${a.z}`, a.items.map((i) => i.item).join('+')]);
                if (a.x === 5) return { ok: true, detail: { done: [{ item: 'coal', moved: 80 }, { item: 'cobblestone', moved: 100, partial: true }], failed: [{ item: 'cobblestone', reason: 'container_full', moved: 100 }, { item: 'dirt', reason: 'container_full' }] } };
                return { ok: true, detail: { done: a.items.map((i) => ({ item: i.item, moved: i.count })), failed: [] } };
            },
            visit: async (box, fn) => fn(),
        };
        // the approach to a container needs the real world: replace it by a no-op for this test
        const reach = require('../src/work/bot/reach'), orig = reach.approach; reach.approach = async () => null;
        try {
            const m = await janitor.maintain(env, janitor.pitPolicy({ sites: () => sites }));
            assert.ok(m.ok, JSON.stringify(m));
            const at = (xz) => calls.filter((c) => c[1] === xz).map((c) => c[2]);
            assert.ok(at('5,5').length === 1 && at('9,5').length === 1, JSON.stringify(calls));
            assert.deepStrictEqual(at('9,5')[0].split('+').sort(), ['cobblestone', 'dirt'], 'what the first container could not take goes to the second one in the same trip');
            assert.ok(env.fullBoxes.get('5,64,5') > Date.now(), 'the full one is remembered');
            calls.length = 0; await janitor.maintain(env, janitor.pitPolicy({ sites: () => sites }));
            assert.ok(calls.every((c) => c[1] === '9,5'), 'the next trip goes straight to the other container: ' + JSON.stringify(calls));
        } finally { reach.approach = orig; }
    });

    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

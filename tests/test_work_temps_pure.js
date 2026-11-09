// The shared list of placed blocks (owner 2026-11-10): registered when placed, forgotten when broken, cleaned up when it is safe; beds are fixtures; nothing is put on a chest.
// Pure: fake world and environment, no server.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Temps, cleanTemps, uncover, holdsNothingBack } = require('../src/work/bot/temps');
const fixtures = require('../src/skills/fixtures');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 20 s'); process.exit(2); }, 20000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

/** A world of named cells (default air); kindAt follows the names. */
function world(init = {}) {
    const m = new Map(Object.entries(init)), key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) || 'air';
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'unknown' ? 'unknown' : 'solid'; };
    return { nameAt, kindAt, blockAt: (x, y, z) => ({ name: nameAt(x, y, z) }), set: (x, y, z, n) => (n ? m.set(key(x, y, z), n) : m.delete(key(x, y, z))) };
}
const botOf = (name, x, z, dim = 'minecraft:overworld') => ({ username: name, game: { dimension: dim }, entity: { position: { x, y: 64, z } } });

(async () => {
    await test('registry: add, forget, per dimension, newest placement wins, bounded, kept as JSON and loaded again', () => {
        let t = 1000; const T = new Temps(() => t);
        T.add({ dim: 'overworld', x: 1, y: 2, z: 3, item: 'cobblestone', kind: 'seal', by: 'A' }); T.add({ dim: 'nether', x: 1, y: 2, z: 3, item: 'dirt', kind: 'pillar', by: 'B' });
        assert.strictEqual(T.size, 2, 'the same cell in another dimension is another block');
        assert.deepStrictEqual(T.counts(), { seal: 1, pillar: 1 });
        T.add({ dim: 'overworld', x: 1, y: 2, z: 3, item: 'dirt', kind: 'pillar', by: 'C' }); assert.strictEqual(T.size, 2); assert.strictEqual(T.get('overworld', { x: 1, y: 2, z: 3 }).by, 'C');
        assert.strictEqual(T.add({ x: 1.5, y: 2, z: 3 }), null, 'a cell is whole numbers'); assert.strictEqual(T.add({ dim: 'overworld', x: 9, y: 9, z: 9, kind: 'bogus' }).kind, 'pillar', 'a kind outside the list is a pillar');
        assert.ok(T.remove('overworld', { x: 1, y: 2, z: 3 })); assert.ok(!T.has('overworld', { x: 1, y: 2, z: 3 })); assert.ok(!T.remove('overworld', { x: 1, y: 2, z: 3 }), 'forgetting twice is fine');
        const json = JSON.parse(JSON.stringify(T.toJSON())), U = new Temps(() => t); U.load(json); assert.strictEqual(U.size, T.size);
        t += 4 * 24 * 3600 * 1000; assert.strictEqual(T.toJSON().length, 0, 'what is older than three days is not kept (the world is checked before anything is broken anyway)');
        U.load([{ dim: 'x'.repeat(200), x: 1, y: 1, z: 1 }, { x: 'a' }, null, 5]); assert.strictEqual(U.size, T.size, 'bad rows are ignored');
    });

    await test('env.temp view: what this bot placed or what stands within 10 blocks, Map-like; seals are not in it', () => {
        const T = new Temps(), a = botOf('A', 0, 0), view = T.view(a);
        view.set('5,60,5', { x: 5, y: 60, z: 5 }); T.add({ dim: 'overworld', x: 100, y: 60, z: 100, kind: 'pillar', by: 'B' }); T.add({ dim: 'overworld', x: 3, y: 64, z: 2, kind: 'reflex', by: 'B' }); T.add({ dim: 'overworld', x: 2, y: 64, z: 2, kind: 'seal', by: 'B' });
        assert.strictEqual(view.size, 2, 'its own pillar block and the reflex block beside it; not the far one, not the seal');
        assert.deepStrictEqual([...view].map(([k]) => k).sort(), ['3,64,2', '5,60,5']);
        assert.ok(view.has('5,60,5')); assert.ok(view.delete('5,60,5')); assert.strictEqual(view.size, 1); assert.ok(!view.delete('nonsense'));
        const nether = T.view(botOf('A', 0, 0, 'minecraft:the_nether')); assert.strictEqual(nether.size, 0, 'another dimension');
    });

    await test('holdsNothingBack: a seal with water beside or above it stays, an unloaded cell is never judged safe', () => {
        const w = world({ '0,0,0': 'cobblestone' }); assert.ok(holdsNothingBack(w, { x: 0, y: 0, z: 0 }));
        w.set(1, 0, 0, 'water'); assert.ok(!holdsNothingBack(w, { x: 0, y: 0, z: 0 })); w.set(1, 0, 0, null); w.set(0, 1, 0, 'water'); assert.ok(!holdsNothingBack(w, { x: 0, y: 0, z: 0 }));
        w.set(0, 1, 0, null); w.set(0, -1, 0, 'water'); assert.ok(holdsNothingBack(w, { x: 0, y: 0, z: 0 }), 'water below flows away from it, it is not held back');
        w.set(0, 0, 1, 'unknown'); assert.ok(!holdsNothingBack(w, { x: 0, y: 0, z: 0 }));
    });

    await test('cleanTemps: pillar and rescue blocks go, a seal that holds water stays, gone blocks are forgotten, a claimed block is left to its bot, another block is not ours', async () => {
        const w = world({ '0,64,0': 'cobblestone', '1,64,0': 'dirt', '5,64,5': 'cobblestone', '6,64,5': 'water', '9,64,9': 'cobblestone', '3,64,3': 'stone' });
        const T = new Temps(), bot = botOf('A', 0, 0), mined = [];
        T.add({ dim: 'overworld', x: 0, y: 64, z: 0, item: 'cobblestone', kind: 'pillar', by: 'B' }); T.add({ dim: 'overworld', x: 1, y: 64, z: 0, item: 'dirt', kind: 'rescue', by: 'B' });
        T.add({ dim: 'overworld', x: 5, y: 64, z: 5, item: 'cobblestone', kind: 'seal', by: 'B' });                     // water beside it
        T.add({ dim: 'overworld', x: 7, y: 64, z: 7, item: 'cobblestone', kind: 'seal', by: 'B' });                     // already gone
        T.add({ dim: 'overworld', x: 3, y: 64, z: 3, item: 'cobblestone', kind: 'pillar', by: 'B' });                   // the world has stone there now: not ours
        T.add({ dim: 'overworld', x: 9, y: 64, z: 9, item: 'cobblestone', kind: 'seal', by: 'B' }); T.claim('overworld', { x: 9, y: 64, z: 9 }, 'C');       // another bot is on its way
        const env = { bot, temps: T, w, here: () => ({ x: 0, y: 64, z: 1 }), exec: async (n, a) => { mined.push(`${a.x},${a.y},${a.z}`); w.set(a.x, a.y, a.z, null); return { ok: true }; } };
        const r = await cleanTemps(env, { radius: 20 });
        assert.deepStrictEqual(mined.sort(), ['0,64,0', '1,64,0'], JSON.stringify(mined));
        assert.deepStrictEqual([r.broken, r.forgotten, r.kept], [2, 2, 1], JSON.stringify(r));
        assert.ok(T.has('overworld', { x: 5, y: 64, z: 5 }), 'the seal that holds water back is still listed'); assert.ok(T.has('overworld', { x: 9, y: 64, z: 9 }));
        assert.ok(!T.has('overworld', { x: 0, y: 64, z: 0 }) && !T.has('overworld', { x: 7, y: 64, z: 7 }) && !T.has('overworld', { x: 3, y: 64, z: 3 }));
        // water gone: the seal can go; with a box only what lies inside it (and two cells around) is looked at
        w.set(6, 64, 5, null); mined.length = 0;
        const r2 = await cleanTemps(env, { box: { x0: 0, x1: 10, z0: 0, z1: 10, top: 70, bottom: 60 }, max: 5 });
        assert.deepStrictEqual(mined, ['5,64,5'], JSON.stringify(mined)); assert.strictEqual(r2.broken, 1);
        const far = await cleanTemps(env, { box: { x0: 100, x1: 110, z0: 100, z1: 110, top: 70, bottom: 60 } }); assert.strictEqual(far.tried, 0, 'outside the box nothing is touched');
    });

    await test('uncover: a block of ours on top of a chest is taken away; a block the world made is never touched', async () => {
        const w = world({ '5,64,5': 'chest', '5,65,5': 'cobblestone', '8,64,8': 'chest', '8,65,8': 'stone' }), T = new Temps(), mined = [];
        T.add({ dim: 'overworld', x: 5, y: 65, z: 5, item: 'cobblestone', kind: 'seal', by: 'A' });
        const env = { bot: botOf('A', 0, 0), temps: T, w, exec: async (n, a) => { mined.push(`${a.x},${a.y},${a.z}`); w.set(a.x, a.y, a.z, null); return { ok: true }; } };
        assert.strictEqual(await uncover(env, { x: 5, y: 64, z: 5 }), true); assert.deepStrictEqual(mined, ['5,65,5']);
        assert.strictEqual(await uncover(env, { x: 8, y: 64, z: 8 }), false); assert.strictEqual(mined.length, 1);
    });

    await test('fixtures: a bed is never broken (it may be a respawn point), nothing goes on top of a chest, Ender chest or shulker box', () => {
        for (const n of ['red_bed', 'minecraft:white_bed', 'create:something_bed']) assert.ok(fixtures.isBed(n), n);
        for (const n of ['bedrock', 'bedside_lamp', 'stone']) assert.ok(!fixtures.isBed(n), n);
        const w = world({ '1,64,1': 'chest', '2,64,2': 'ender_chest', '3,64,3': 'purple_shulker_box', '4,64,4': 'enderstorage:ender_chest', '5,64,5': 'barrel', '6,64,6': 'stone' });
        for (const c of [[1, 65, 1], [2, 65, 2], [3, 65, 3], [4, 65, 4]]) assert.ok(fixtures.coversContainer(w, { x: c[0], y: c[1], z: c[2] }), c.join());
        for (const c of [[5, 65, 5], [6, 65, 6], [1, 66, 1], [9, 9, 9]]) assert.ok(!fixtures.coversContainer(w, { x: c[0], y: c[1], z: c[2] }), `${c.join()} (a barrel opens with a block on top; the cell must be directly above)`);
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-')), svc = new WorkService({ dataDir: d, factory: () => ({}), restore: false });
        assert.ok(svc.isFixture('red_bed', 1, 64, 1), 'the service protects a bed even when no bot placed or tagged it'); assert.ok(!svc.isFixture('stone', 1, 64, 1));
        svc.temps.add({ dim: 'overworld', x: 1, y: 2, z: 3, kind: 'seal' }); assert.strictEqual(svc.status().temps.seal, 1, 'the page can show how many placed blocks are listed');
        svc.save(); const again = new WorkService({ dataDir: d, factory: () => ({}), restore: false }); return again.restore().then(() => { assert.ok(again.temps.has('overworld', { x: 1, y: 2, z: 3 }), 'kept across a restart'); clearTimeout(svc._saveTimer); fs.rmSync(d, { recursive: true }); });
    });

    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

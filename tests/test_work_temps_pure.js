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
        let t0 = 1000; const T = new Temps(() => t0).attach({ alive: (n) => n !== 'B', others: () => [] }), a = botOf('A', 0, 0), view = T.view(a);
        view.set('5,60,5', { x: 5, y: 60, z: 5 }); T.add({ dim: 'overworld', x: 100, y: 60, z: 100, kind: 'pillar', by: 'B' }); T.add({ dim: 'overworld', x: 3, y: 64, z: 2, kind: 'reflex', by: 'B' }); T.add({ dim: 'overworld', x: 2, y: 64, z: 2, kind: 'seal', by: 'B' }); T.add({ dim: 'overworld', x: 4, y: 64, z: 4, kind: 'rescue', by: 'B' }); T.add({ dim: 'overworld', x: 5, y: 64, z: 4, kind: 'rescue', by: 'A' });
        assert.strictEqual(view.size, 1, 'its own pillar block only: another bot\'s block beside it is not ours (owner 2026-11-10: scaffolds were destroyed under their placers); not the far one, not the seal, not a fill of the water rescue');
        t0 += 30000; assert.strictEqual(view.size, 2, 'an orphan (its placer B is gone) older than 20 s and with nobody near it is taken by whoever passes');
        assert.deepStrictEqual([...view].map(([k]) => k).sort(), ['3,64,2', '5,60,5']);
        const busy = new Temps(() => t0).attach({ alive: () => false, others: () => [{ name: 'Z', x: 3.5, y: 65, z: 2.5 }] }); busy.add({ dim: 'overworld', x: 3, y: 64, z: 2, kind: 'reflex', by: 'B' }); t0 += 30000;
        assert.strictEqual(busy.view(a).size, 0, 'another bot stands on / beside it: never taken');
        const alive = new Temps(() => t0).attach({ alive: () => true, others: () => [] }); alive.add({ dim: 'overworld', x: 3, y: 64, z: 2, kind: 'reflex', by: 'B' }); t0 += 30000;
        assert.strictEqual(alive.view(a).size, 0, 'its placer is still playing: it takes it away itself');
        t0 -= 0;
        assert.ok(view.has('5,60,5')); assert.ok(view.delete('5,60,5')); assert.strictEqual(view.size, 1); assert.ok(!view.delete('nonsense'));
        const nether = T.view(botOf('A', 0, 0, 'minecraft:the_nether')); assert.strictEqual(nether.size, 0, 'another dimension');
    });

    await test('holdsNothingBack: a seal with water beside or above it stays, an unloaded cell is never judged safe', () => {
        const w = world({ '0,0,0': 'cobblestone' }); assert.ok(holdsNothingBack(w, { x: 0, y: 0, z: 0 }));
        w.set(1, 0, 0, 'water'); assert.ok(!holdsNothingBack(w, { x: 0, y: 0, z: 0 })); w.set(1, 0, 0, null); w.set(0, 1, 0, 'water'); assert.ok(!holdsNothingBack(w, { x: 0, y: 0, z: 0 }));
        w.set(0, 1, 0, null); w.set(0, -1, 0, 'water'); assert.ok(holdsNothingBack(w, { x: 0, y: 0, z: 0 }), 'water below flows away from it, it is not held back');
        w.set(0, 0, 1, 'unknown'); assert.ok(!holdsNothingBack(w, { x: 0, y: 0, z: 0 }));
    });

    await test('cleanTemps: pillar and scaffold blocks go, a seal or a rescue fill that holds water stays, gone blocks are forgotten, a claimed block is left to its bot, another block is not ours', async () => {
        const w = world({ '0,64,0': 'cobblestone', '1,64,0': 'dirt', '5,64,5': 'cobblestone', '6,64,5': 'water', '9,64,9': 'cobblestone', '3,64,3': 'stone' });
        let tc = 1000; const T = new Temps(() => tc).attach({ alive: () => false, others: () => [] }), bot = botOf('A', 0, 0), mined = [];
        T.add({ dim: 'overworld', x: 0, y: 64, z: 0, item: 'cobblestone', kind: 'pillar', by: 'B' }); T.add({ dim: 'overworld', x: 1, y: 64, z: 0, item: 'dirt', kind: 'scaffold', by: 'B' });
        T.add({ dim: 'overworld', x: 5, y: 64, z: 5, item: 'cobblestone', kind: 'seal', by: 'B' });                     // water beside it
        T.add({ dim: 'overworld', x: 7, y: 64, z: 7, item: 'cobblestone', kind: 'seal', by: 'B' });                     // already gone
        T.add({ dim: 'overworld', x: 3, y: 64, z: 3, item: 'cobblestone', kind: 'pillar', by: 'B' });                   // the world has stone there now: not ours
        T.add({ dim: 'overworld', x: 9, y: 64, z: 9, item: 'cobblestone', kind: 'seal', by: 'B' }); T.claim('overworld', { x: 9, y: 64, z: 9 }, 'C');       // another bot is on its way
        const env = { bot, temps: T, w, here: () => ({ x: 0, y: 64, z: 1 }), exec: async (n, a) => { mined.push(`${a.x},${a.y},${a.z}`); w.set(a.x, a.y, a.z, null); return { ok: true }; } };
        tc += 20500;                                                                                                   // B is gone and its blocks are old enough: orphans
        const r = await cleanTemps(env, { radius: 20 });
        assert.deepStrictEqual(mined.sort(), ['0,64,0', '1,64,0'], JSON.stringify(mined));
        assert.deepStrictEqual([r.broken, r.forgotten, r.kept], [2, 2, 1], JSON.stringify(r));
        assert.ok(T.has('overworld', { x: 5, y: 64, z: 5 }), 'the seal that holds water back is still listed'); assert.ok(T.has('overworld', { x: 9, y: 64, z: 9 }));
        assert.ok(!T.has('overworld', { x: 0, y: 64, z: 0 }) && !T.has('overworld', { x: 7, y: 64, z: 7 }) && !T.has('overworld', { x: 3, y: 64, z: 3 }));
        // water gone: the seal can go; with a box only what lies inside it (and two cells around) is looked at
        // a rescue fill is held back like a seal: with water beside it, it stays; the pit's cleanup takes it when the water is gone
        T.add({ dim: 'overworld', x: 8, y: 64, z: 8, item: 'cobblestone', kind: 'rescue', by: 'B' }); w.set(8, 64, 8, 'cobblestone'); w.set(8, 64, 9, 'water');
        const rr = await cleanTemps(env, { radius: 30 }); assert.ok(T.has('overworld', { x: 8, y: 64, z: 8 }) && !mined.includes('8,64,8'), 'a rescue fill with water beside it is not broken: ' + JSON.stringify(rr)); w.set(8, 64, 9, null); T.remove('overworld', { x: 8, y: 64, z: 8 });
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

    await test('the end (reach): a temporary block the mine cannot get to is reached by NAV and then mined blind (mb075m/n: 7 pumpkins left, 57 levels away); without reach it stays (negative control)', async () => {
        const TM = require('../src/work/bot/temps');
        const run = async (reach) => {
            const temps = new TM.Temps(); temps.add({ x: 10, y: 12, z: 1, kind: 'pillar', by: 'P', item: 'pumpkin' });
            const solid = new Set(['10,12,1']), pos = { x: 10, y: 69, z: -1 }, calls = [];
            const env = { temps, bot: { username: 'P', game: { dimension: 'overworld' } }, here: () => ({ ...pos }),
                w: { kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'pumpkin' : 'air') },
                nav: async (t) => { calls.push('nav'); pos.x = t.x + 1; pos.y = t.y; pos.z = t.z; return { ok: true }; },
                exec: async (n, a) => { calls.push(a.blind ? 'blind' : 'mine'); if (Math.abs(pos.y - a.y) > 5) return { ok: false, reason: 'stuck', detail: { why: 'the same unmet precondition' } }; solid.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; } };
            const out = await TM.cleanTemps(env, { box: { x0: 0, x1: 15, z0: -5, z1: 15, top: 70, bottom: 0 }, ...(reach ? { reach: true } : {}) });
            return { out, calls, left: solid.size };
        };
        const yes = await run(true);
        assert.deepStrictEqual(yes.calls, ['mine', 'nav', 'blind']); assert.strictEqual(yes.left, 0); assert.strictEqual(yes.out.navBroken, 1);
        const no = await run(false);
        assert.deepStrictEqual(no.calls, ['mine']); assert.strictEqual(no.left, 1);
    });

    await test('the end (reach): after a NAV trip every other listed block within reach goes too, blind (mbc075d w3: 134 lake fills of a wet box left, one trip per block); negative control: a block out of reach of that place waits for its own trip', async () => {
        const TM = require('../src/work/bot/temps');
        const temps = new TM.Temps();
        const cells = [[10, 12, 1], [11, 12, 1], [12, 12, 1], [10, 12, 2], [30, 12, 1]];
        for (const [x, y, z] of cells) temps.add({ x, y, z, kind: 'lake', by: 'P', item: 'cobblestone' });
        const solid = new Set(cells.map((c) => c.join(','))), pos = { x: 10, y: 69, z: -1 }, calls = [];
        const env = { temps, bot: { username: 'P', game: { dimension: 'overworld' } }, here: () => ({ ...pos }),
            w: { kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'cobblestone' : 'air') },
            nav: async (t) => { calls.push(`nav ${t.x}`); pos.x = t.x; pos.y = t.y + 1; pos.z = t.z - 1; return { ok: true }; },
            exec: async (n, a) => { const d = Math.hypot(pos.x - a.x, pos.y + 1.62 - a.y, pos.z - a.z); if (d > 5) return { ok: false, reason: 'stuck' }; calls.push(a.blind ? 'blind' : 'mine'); solid.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; } };
        const out = await TM.cleanTemps(env, { box: { x0: 0, x1: 40, z0: -5, z1: 15, top: 70, bottom: 0 }, reach: true, max: 10, maxMs: 600000 });
        assert.strictEqual(solid.size, 0, JSON.stringify({ calls, out }));
        assert.strictEqual(calls.filter((c) => c.startsWith('nav')).length, 2, `two trips for five blocks: ${calls.join(',')}`);
        assert.ok(out.cluster >= 3, JSON.stringify(out));
    });

    await test('the two-per-bot measure: the pillar under the feet is one structure, water blocks are the cell\'s, more than two of a bot\'s own count each second (negative control: the same blocks with the bot off its column count three)', () => {
        let spot = { name: 'a', x: 0.5, y: 75, z: 0.5 };
        const T = new Temps().attach({ others: () => [spot] });
        for (let y = 70; y <= 74; y++) T.add({ x: 0, y, z: 0, kind: 'pillar', by: 'a' });          // five high, the bot on top
        T.add({ x: 1, y: 74, z: 0, kind: 'bridge', by: 'a' });
        for (let i = 0; i < 4; i++) T.add({ x: 5 + i, y: 60, z: 0, kind: 'lake', by: 'a' });
        T.add({ x: 9, y: 60, z: 0, kind: 'seal', by: 'a' });
        let o = T.sample();
        assert.strictEqual(o.seconds, 0, `column (1) + bridge (1) = two: ${JSON.stringify(o)}`);
        assert.strictEqual(o.cellBound, 5, 'lake and seal counted apart');
        T.add({ x: 3, y: 71, z: 0, kind: 'pillar', by: 'a' });                                     // a pillar left elsewhere: three
        o = T.sample();
        assert.strictEqual(o.seconds, 1); assert.deepStrictEqual(o.by, { a: 1 }); assert.deepStrictEqual(o.how, { 'bridge:1,column:1,pillar:1': 1 });
        spot = { name: 'a', x: 2.5, y: 70, z: 0.5 };                                                // off its column: every block counts
        o = T.sample();
        assert.strictEqual(o.by.a, 2); assert.strictEqual(o.how['bridge:1,pillar:6'], 1, JSON.stringify(o.how));
        assert.strictEqual(o.samples, 3);
    });

    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

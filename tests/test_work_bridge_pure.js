// Work over an abyss (src/work/bot/abyss.js, bridge.js workOver): planning on a fake world, and the whole routine (bridge out, the job, walk back) with a fake environment.
// The movements themselves are tested on real physics in test_work_moves_sim.js.
const assert = require('assert');
const abyss = require('../src/work/bot/abyss');
const { workOver } = require('../src/work/bot/bridge');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

/** A platform x <= 0, y <= 63 (stone); everything else is air unless `set`. `unknown(x, z)` columns are not loaded. */
function world({ unknown = () => false } = {}) {
    const m = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    const kindAt = (x, y, z) => { if (unknown(x, z)) return 'unknown'; return m.get(key(x, y, z)) ?? (x <= 0 && y <= 63 ? 'solid' : 'air'); };
    return { kindAt, nameAt: (x, y, z) => (kindAt(x, y, z) === 'air' ? 'air' : kindAt(x, y, z) === 'solid' ? 'stone' : kindAt(x, y, z)), set: (x, y, z, k) => m.set(key(x, y, z), k) };
}

/** A fake environment: `bridge` lays blocks at y-1 under the cells (up to `stock`), `sneak_walk` and `exec` move or break as asked. */
function env(w, { stock = 99, at = { x: 0, y: 64, z: 0 }, walkBackFails = false } = {}) {
    const bot = { ...at }, calls = [];
    return {
        w, bot, calls, cancel: { cancelled: false },
        here: () => ({ ...bot }),
        run: async (name, a) => {
            calls.push([name, a.cells.map((c) => `${c.x},${c.z}`).join(' ')]);
            if (name === 'sneak_walk') { if (walkBackFails) return { ok: false, reason: 'stuck' }; const c = a.cells[a.cells.length - 1]; bot.x = c.x; bot.z = c.z; return { ok: true }; }
            const placed = [];
            for (const c of a.cells) {
                if (w.kindAt(c.x, a.y - 1, c.z) === 'air') { if (placed.length >= stock) return { ok: false, reason: 'missing_item', detail: { placed, done: placed.length } }; w.set(c.x, a.y - 1, c.z, 'solid'); placed.push({ x: c.x, y: a.y - 1, z: c.z }); }
                bot.x = c.x; bot.z = c.z;
            }
            return { ok: true, detail: { placed } };
        },
        exec: async (name, a) => { calls.push([name, `${a.x},${a.y},${a.z}`]); if (name === 'mine') { w.set(a.x, a.y, a.z, 'air'); return { ok: true, detail: { got: 1 } }; } return { ok: true }; },
        goBack: async () => { bot.x = at.x; bot.z = at.z; calls.push(['goBack']); return { ok: true }; },
    };
}

(async () => {
    await test('below: floor, hazard, water, unknown and abyss are told apart', () => {
        const w = world(); w.set(5, 40, 0, 'liquid'); w.set(6, 40, 0, 'water'); w.set(7, 62, 0, 'partial');
        assert.strictEqual(abyss.below(w, 0, 64, 0, 0).kind, 'floor');
        assert.strictEqual(abyss.below(w, 5, 64, 0, 0).kind, 'hazard');
        assert.strictEqual(abyss.below(w, 6, 64, 0, 0).kind, 'water');
        assert.strictEqual(abyss.below(w, 7, 64, 0, 0).kind, 'floor', 'a slab is something to stand on');
        assert.strictEqual(abyss.below(w, 9, 64, 0, 0).kind, 'abyss');
        assert.strictEqual(abyss.over(w, { x: 9, y: 64, z: 0 }, 0), true);
        assert.strictEqual(abyss.over(w, { x: 0, y: 64, z: 0 }, 0), false);
        assert.strictEqual(abyss.below(world({ unknown: (x) => x === 9 }), 9, 64, 0, 0).kind, 'unknown', 'a chunk that is not loaded is no verdict');
    });

    await test('plan: straight, with a corner, over existing floor; every failure is named', () => {
        const w = world(); w.set(2, 63, 0, 'solid');
        const p = abyss.plan(w, { x: 0, y: 64, z: 0 }, { x: 3, z: 2 });
        assert.ok(p.ok, JSON.stringify(p)); assert.deepStrictEqual(p.segments.map((s) => [s.dir, s.cells.length]), [[[1, 0], 3], [[0, 1], 2]]);
        assert.strictEqual(p.place.length, 4, 'the cell with a floor needs no block'); assert.ok(p.place.every((c) => c.y === 63));
        assert.strictEqual(abyss.plan(w, { x: 5, y: 64, z: 0 }, { x: 8, z: 0 }).reason, 'invalid_target', 'the start must have a floor');
        assert.strictEqual(abyss.plan(w, { x: 0, y: 64, z: 0 }, { x: 3, y: 65, z: 0 }).reason, 'invalid_target', 'a bridge is level');
        assert.strictEqual(abyss.plan(world({ unknown: (x) => x >= 3 }), { x: 0, y: 64, z: 0 }, { x: 5, z: 0 }).reason, 'unreachable');
        const lava = world(); lava.set(2, 64, 0, 'danger');
        assert.strictEqual(abyss.plan(lava, { x: 0, y: 64, z: 0 }, { x: 4, z: 0 }).reason, 'invalid_target');
        const wet = world(); wet.set(2, 63, 0, 'water');
        assert.match(abyss.plan(wet, { x: 0, y: 64, z: 0 }, { x: 4, z: 0 }).detail.why, /water where the bridge must lie/);
        assert.strictEqual(abyss.plan(w, { x: 0, y: 64, z: 0 }, { x: 60, z: 0 }).reason, 'unreachable', 'longer than 40 blocks of bridge');
        assert.strictEqual(abyss.plan(w, { x: 0, y: 64, z: 0 }, { x: 60, z: 0 }, { maxLen: 80 }).ok, true);
    });

    await test('workOver: a block that floats over the void is mined from a bridge, the bot walks back, the bridge stays, nothing of it is broken', async () => {
        const w = world(); w.set(6, 64, 0, 'solid');                        // the ore: nothing under it
        const e = env(w);
        const r = await workOver(e, { x: 6, y: 64, z: 0 }, { job: 'mine', minY: 0 });
        assert.ok(r.ok, JSON.stringify(r));
        assert.strictEqual(w.kindAt(6, 64, 0), 'air', 'the block is gone');
        assert.deepStrictEqual([e.bot.x, e.bot.z], [0, 0], 'back on the safe cell');
        assert.strictEqual(r.detail.bridge.returned, true); assert.strictEqual(r.detail.bridge.placed.length, 5);
        for (let x = 1; x <= 5; x++) assert.strictEqual(w.kindAt(x, 63, 0), 'solid', 'the bridge stays');
        assert.deepStrictEqual(e.calls.filter((c) => c[0] === 'mine').map((c) => c[1]), ['6,64,0'], 'only the work block was mined');
        assert.deepStrictEqual(e.calls.map((c) => c[0]), ['bridge', 'mine', 'sneak_walk']);
        assert.strictEqual(e.calls[2][1], '4,0 3,0 2,0 1,0 0,0', 'the way back is the way out, cell by cell');
    });

    await test('workOver: the job can be a block placed, or nothing; the walk back happens in every case', async () => {
        const w = world(); const e = env(w);
        const r = await workOver(e, { x: 4, y: 64, z: 1 }, { job: 'place', item: 'obsidian', minY: 0 });
        assert.ok(r.ok, JSON.stringify(r)); assert.ok(e.calls.some((c) => c[0] === 'place' || c[0] === 'bridge')); assert.strictEqual(r.detail.bridge.returned, true);
        const e2 = env(world()); const n = await workOver(e2, { x: 3, y: 64, z: 0 }, { minY: 0 });
        assert.ok(n.ok); assert.strictEqual(e2.calls.filter((c) => c[0] === 'mine' || c[0] === 'place').length, 0);
    });

    await test('workOver: out of blocks half way is a failure that names it, and the bot is walked back over what it laid', async () => {
        const w = world(); const e = env(w, { stock: 2 });
        const r = await workOver(e, { x: 6, y: 64, z: 0 }, { job: 'mine', minY: 0 });
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'missing_item'); assert.strictEqual(r.detail.stage, 'bridge');
        assert.strictEqual(r.detail.bridge.placed.length, 2); assert.strictEqual(r.detail.bridge.returned, true);
        assert.deepStrictEqual([e.bot.x, e.bot.z], [0, 0]);
        assert.ok(!e.calls.some((c) => c[0] === 'mine'), 'the job is not tried without a bridge');
    });

    await test('workOver: a walk back that fails goes to the server (goBack); without it the work is done but the result says the bot is stuck', async () => {
        const w = world(); w.set(6, 64, 0, 'solid'); const e = env(w, { walkBackFails: true });
        const r = await workOver(e, { x: 6, y: 64, z: 0 }, { job: 'mine', minY: 0 });
        assert.ok(r.ok); assert.strictEqual(r.detail.bridge.goBack, true); assert.deepStrictEqual([e.bot.x, e.bot.z], [0, 0]);
        const w2 = world(); w2.set(6, 64, 0, 'solid'); const e2 = env(w2, { walkBackFails: true }); delete e2.goBack;
        const r2 = await workOver(e2, { x: 6, y: 64, z: 0 }, { job: 'mine', minY: 0 });
        assert.strictEqual(r2.ok, false); assert.strictEqual(r2.reason, 'stuck'); assert.match(r2.detail.why, /walk back/);
    });

    await test('workOver: refuses what cannot be done before laying anything (no start floor, no free cell beside the work, lava on the way)', async () => {
        const w = world(); const e = env(w, { at: { x: 5, y: 64, z: 0 } });          // standing in the air: no floor under the start
        const r = await workOver(e, { x: 9, y: 64, z: 0 }, { job: 'mine', minY: 0 });
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'invalid_target'); assert.strictEqual(e.calls.length, 0);
        const w2 = world(); for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) w2.set(6 + dx, 64, dz, 'solid');       // the work cell is walled in
        const r2 = await workOver(env(w2), { x: 6, y: 64, z: 0 }, { job: 'mine', minY: 0 });
        assert.strictEqual(r2.reason, 'invalid_target'); assert.match(r2.detail.why, /no free cell beside/);
        const w3 = world(); w3.set(3, 64, 0, 'danger'); w3.set(4, 64, 0, 'danger');
        const e3 = env(w3); const r3 = await workOver(e3, { x: 6, y: 64, z: 0 }, { job: 'mine', minY: 0 });
        assert.strictEqual(r3.ok, false); assert.strictEqual(e3.calls.length, 0, 'nothing laid when no way to the work is free');
    });

    console.log('\nwork bridge: all tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

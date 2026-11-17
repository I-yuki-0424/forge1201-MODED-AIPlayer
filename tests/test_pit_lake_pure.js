// The lake fill of the pit (src/work/jobs/pit_lake.js) on a fake world: an enclosed lake in the ground is replaced by blocks from the shore inwards, the bot standing only where it can stand
// (the shore, then the top of its own fill), the farthest cell in reach first; a water body larger than the supply is filled in part and says so; the control (no fill) leaves the lake.
const assert = require('assert');
const pit = require('../src/work/jobs/pit');
const { fillLake, component } = require('../src/work/jobs/pit_lake');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const key = (x, y, z) => `${x},${y},${z}`;
function lakeWorld(ground, lake) {
    const m = new Map();
    for (let x = lake.x0; x <= lake.x1; x++) for (let z = lake.z0; z <= lake.z1; z++) for (let y = lake.y0; y <= lake.y1; y++) m.set(key(x, y, z), 'water');
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => m.set(key(x, y, z), n) };
}
function fakeEnv(w, start, stock) {
    const pos = { ...start }, calls = { place: 0, move: 0 };
    const env = {
        w, here: () => ({ ...pos }), cancel: { cancelled: false },
        have: (item) => (item === 'cobblestone' ? stock.n : 0),
        exec: async (name, a) => {
            if (name !== 'place') return { ok: true };
            calls.place++;
            const d = Math.hypot(pos.x + 0.5 - (a.x + 0.5), pos.y + 1.62 - (a.y + 0.5), pos.z + 0.5 - (a.z + 0.5));
            if (d > 4.6) return { ok: false, reason: 'unreachable', detail: { why: 'reach', d } };
            if (w.kindAt(a.x, a.y, a.z) !== 'water') return { ok: false, reason: 'invalid_target', detail: {} };
            if (stock.n < 1) return { ok: false, reason: 'missing_item' };
            stock.n--; w.set(a.x, a.y, a.z, 'cobblestone'); return { ok: true };
        },
    };
    return { env, pos, calls };
}
// the bot walks to a standing place when it can stand there (the test world has no obstacles)
const station = (w, env, pos) => async (S) => { if (!(w.kindAt(S.x, S.y, S.z) === 'air' && w.kindAt(S.x, S.y + 1, S.z) === 'air' && w.kindAt(S.x, S.y - 1, S.z) === 'solid')) return { ok: false, reason: 'unreachable' }; pos.x = S.x; pos.y = S.y; pos.z = S.z; return null; };

(async () => {
    const box = { x0: 0, z0: 0, x1: 15, z1: 15, top: 60, bottom: 40 };
    const lake = { x0: 5, x1: 10, z0: 5, z1: 10, y0: 59, y1: 60 };       // 6 x 6 x 2 = 72 cells, open at the top (flush with the ground)
    const count = (w, l) => { let n = 0; for (let x = l.x0; x <= l.x1; x++) for (let z = l.z0; z <= l.z1; z++) for (let y = l.y0; y <= l.y1; y++) if (w.kindAt(x, y, z) === 'water') n++; return n; };
    // no block may lie over water that is still there (a platform over unfilled water hides it)
    const shadowed = (w, l) => { let n = 0; for (let x = l.x0; x <= l.x1; x++) for (let z = l.z0; z <= l.z1; z++) { let seenSolid = false; for (let y = l.y1; y >= l.y0; y--) { const k = w.kindAt(x, y, z); if (k === 'solid') seenSolid = true; else if (k === 'water' && seenSolid) n++; } } return n; };
    const run = (w, env, pos, seeds) => fillLake({ env, plan: { box }, isFluid: pit.isFluid, sealItem: pit.sealItem, items: pit.SEAL_ITEMS, goToStation: station(w, env, pos) }, seeds);

    await test('component: the whole body inside the box, nothing outside it', () => {
        const w = lakeWorld(60, lake);
        const c = component(w, box, [{ x: 7, y: 60, z: 7 }], pit.isFluid);
        assert.strictEqual(c.cells.length, 72); assert.strictEqual(c.truncated, false);
        const small = component(w, { ...box, x0: 8 }, [{ x: 9, y: 60, z: 7 }], pit.isFluid);        // the box cuts the lake: the ring (one cell beyond the box) is part of it
        assert(small.cells.every((f) => f.x >= 7));
    });

    await test('a shallow lake is filled from the shore inwards, column by column, from places the bot can stand', async () => {
        const w = lakeWorld(60, lake), stock = { n: 1000 }, { env, pos, calls } = fakeEnv(w, { x: 3, y: 61, z: 7 }, stock);
        const res = await run(w, env, pos, [{ x: 5, y: 60, z: 7 }]);
        assert.strictEqual(res.ok, true, JSON.stringify(res)); assert.strictEqual(count(w, lake), 0); assert.strictEqual(res.filled, 72); assert(res.stations >= 2, `stations ${res.stations}`);
        assert.strictEqual(calls.place, 72); assert.strictEqual(shadowed(w, lake), 0);
    });

    await test('the supply runs out: filled in part, says missing_item, the rest stays water, nothing shadowed', async () => {
        const wide = { x0: 5, x1: 12, z0: 3, z1: 12, y0: 59, y1: 60 };       // 8 x 10 x 2 = 160
        const w = lakeWorld(60, wide), stock = { n: 100 }, { env, pos } = fakeEnv(w, { x: 3, y: 61, z: 7 }, stock);
        const res = await run(w, env, pos, [{ x: 5, y: 60, z: 7 }]);
        assert.strictEqual(res.ok, false); assert.strictEqual(res.reason, 'missing_item'); assert.strictEqual(res.filled, 100); assert.strictEqual(count(w, wide), 60); assert.strictEqual(shadowed(w, wide), 0);
    });

    await test('a deep lake: the columns within the arm are finished, the rest is reported too_deep fast, and no platform hides water', async () => {
        const deep = { x0: 5, x1: 10, z0: 5, z1: 10, y0: 54, y1: 60 };       // 7 deep
        const w = lakeWorld(60, deep), { env, pos, calls } = fakeEnv(w, { x: 3, y: 61, z: 7 }, { n: 1000 });
        const res = await run(w, env, pos, [{ x: 5, y: 60, z: 7 }]);
        assert.strictEqual(res.ok, false); assert(['too_deep', 'unreachable'].includes(res.reason), res.reason); assert(res.detail && res.detail.columnDepth >= 7 || res.reason === 'unreachable');
        assert.strictEqual(shadowed(w, deep), 0); assert(calls.place < 20, `place calls ${calls.place}`);
    });

    await test('control: a seed with no fluid, nothing to fill', async () => {
        const w = lakeWorld(60, lake), { env, pos } = fakeEnv(w, { x: 3, y: 61, z: 7 }, { n: 1000 });
        const res = await run(w, env, pos, [{ x: 2, y: 60, z: 2 }]);
        assert.strictEqual(res.ok, true); assert.strictEqual(res.filled, 0); assert.strictEqual(count(w, lake), 72);
    });

    await test('a lake with no way to stand beside it (sealed in rock) is reported, not looped on', async () => {
        const w = lakeWorld(70, { ...lake, y0: 54, y1: 60 }), { env, pos } = fakeEnv(w, { x: 3, y: 71, z: 7 }, { n: 1000 });   // ground at 70: the lake is a closed pocket 10 below the surface
        const res = await fillLake({ env, plan: { box: { ...box, top: 70 } }, isFluid: pit.isFluid, sealItem: pit.sealItem, items: pit.SEAL_ITEMS, goToStation: station(w, env, pos) }, [{ x: 7, y: 60, z: 7 }]);
        assert.strictEqual(res.ok, false); assert(['unreachable', 'unsupported', 'too_deep'].includes(res.reason), res.reason);
    });
    await test('the end of the job takes away the lake-fill blocks that are still there (the ones a parked unit left)', async () => {
        const w = lakeWorld(60, lake), { env, pos } = fakeEnv(w, { x: 3, y: 61, z: 7 }, { n: 1000 });
        const plan = { box };
        await fillLake({ env, plan, isFluid: pit.isFluid, sealItem: pit.sealItem, items: pit.SEAL_ITEMS, goToStation: station(w, env, pos) }, [{ x: 5, y: 60, z: 7 }]).then((r) => { plan.lakeFilled = new Set(r.placed.map((q) => `${q.x},${q.y},${q.z}`)); });
        assert.strictEqual(plan.lakeFilled.size, 72);
        const mined = []; const exec0 = env.exec;
        env.exec = async (name, a) => { if (name === 'mine') { mined.push(a); w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } return exec0(name, a); };
        await pit.cleanLakeBlocks(plan, env);
        assert.strictEqual(mined.length, 72); assert.strictEqual(plan.lakeFilled.size, 0); assert.strictEqual(w.kindAt(7, 60, 7), 'air');
        await pit.cleanLakeBlocks({ box }, env);                      // nothing owned: nothing happens
    });

    await test('layered rule: a lake 9 deep is filled over its whole extent in the top two levels only, from the shore inwards (the platform grows), the rest stays water for its own layer', async () => {
        const big = { x0: 3, x1: 12, z0: 3, z1: 12, y0: 52, y1: 60 };       // 10 x 10 x 9
        const w = lakeWorld(60, big), stock = { n: 1000 }, { env, pos, calls } = fakeEnv(w, { x: 1, y: 61, z: 7 }, stock);
        const res = await fillLake({ env, plan: { box }, isFluid: pit.isFluid, sealItem: pit.sealItem, items: pit.SEAL_ITEMS, slab: { lo: 59, hi: 60 }, goToStation: station(w, env, pos) }, [{ x: 3, y: 60, z: 7 }]);
        assert.strictEqual(res.ok, true, JSON.stringify(res)); assert.strictEqual(res.filled, 200); assert.strictEqual(calls.place, 200);
        for (let x = 3; x <= 12; x++) for (let z = 3; z <= 12; z++) { assert.strictEqual(w.kindAt(x, 60, z), 'solid'); assert.strictEqual(w.kindAt(x, 59, z), 'solid'); assert.strictEqual(w.kindAt(x, 58, z), 'water'); }
        // next layer: its floor (level 58) cell by cell under cells that were opened (dug): from the shore inwards each one is placed against its neighbour
        const open = [[3, 3], [4, 3], [5, 3], [3, 4], [4, 4]];
        for (let x = 3; x <= 12; x++) for (let z = 3; z <= 12; z++) w.set(x, 60, z, 'air');          // level 60 is dug (the bot stands on level 59, feet at 60)
        for (const [x, z] of open) w.set(x, 59, z, 'air');          // the dig of level 59 opened these (the cell under each: level 58 water)
        pos.x = 6; pos.y = 60; pos.z = 6;
        const seeds = open.map(([x, z]) => ({ x, y: 58, z }));
        const r2 = await fillLake({ env, plan: { box }, isFluid: pit.isFluid, sealItem: pit.sealItem, items: pit.SEAL_ITEMS, exact: true, slab: { lo: 58, hi: 58 }, goToStation: station(w, env, pos) }, seeds);
        assert(r2.filled >= 1 && r2.filled <= 5, JSON.stringify(r2));
        for (const q of r2.placed) assert.strictEqual(q.y, 58);
        assert.strictEqual(w.kindAt(3, 57, 3), 'water');                // never deeper than the floor level
    });
    await test('exact mode: a seed that is not fluid is left alone, nothing else is touched', async () => {
        const w = lakeWorld(60, lake), { env, pos, calls } = fakeEnv(w, { x: 3, y: 61, z: 7 }, { n: 1000 });
        const res = await fillLake({ env, plan: { box }, isFluid: pit.isFluid, sealItem: pit.sealItem, items: pit.SEAL_ITEMS, exact: true, slab: { lo: 60, hi: 60 }, goToStation: station(w, env, pos) }, [{ x: 2, y: 60, z: 7 }]);
        assert.strictEqual(res.ok, true); assert.strictEqual(res.filled, 0); assert.strictEqual(calls.place, 0); assert.strictEqual(count(w, lake), 72);
    });
    await test('the pit model digs `lake` blocks (the layered rule\'s floor) and leaves other registered blocks alone', () => {
        const { buildModel } = require('../src/work/jobs/pit_expert');
        const solid = { x: 4, y: 40, z: 4 }, other = { x: 5, y: 40, z: 4 };
        const w = { kindAt: (x, y, z) => (y <= 40 ? 'solid' : 'air'), nameAt: () => 'cobblestone' };
        const reg = new Map([[`o|${solid.x},${solid.y},${solid.z}`, { kind: 'lake' }], [`o|${other.x},${other.y},${other.z}`, { kind: 'bridge' }]]);
        const bot = { __temps: { get: (dim, c) => reg.get(`o|${c.x},${c.y},${c.z}`) || null }, game: { dimension: 'overworld' } };
        const region = { meta: { x0: 0, x1: 15, z0: 0, z1: 15, top: 40, bottom: 30, band: 2 } };
        const m = buildModel({ env: { w, bot, temp: new Map() }, plan: { road: { keep: new Map() }, accepted: new Set() }, region, aerialTree: () => false, UNBREAKABLE: /^bedrock$/ }, 0, 0, 39);
        const { SOLID, ROCK } = require('../src/experts/pit/model');
        assert.strictEqual(m[4][4][1], SOLID); assert.strictEqual(m[5][4][1], ROCK);
    });
    console.log('all lake tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

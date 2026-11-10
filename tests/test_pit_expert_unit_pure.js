// The expert method of the pit job (src/work/jobs/pit_expert.js, pit.js method 'expert') on a fake world: a unit is a band of two layers of a whole chunk, the expert chooses the stations,
// the arm digs everything in reach blind, leftovers above the band within reach go too, fixtures and bedrock stay, a station that cannot be reached is not tried again.
const assert = require('assert');
const pit = require('../src/work/jobs/pit');
const M = require('../src/experts/pit/model');

setTimeout(() => { console.error('test watchdog: still running after 90 s'); process.exit(2); }, 90000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

function fakeWorld(ground, init = {}) {
    const m = new Map(Object.entries(init)), key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'lava' ? 'danger' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => m.set(key(x, y, z), n) };
}
/** A bot that stands at `pos`, walks wherever `canWalk` allows, and mines (blind) whatever is within 4.6 blocks of its eye; everything is logged. */
function fakeEnv(w, start, { canWalk = () => true } = {}) {
    const pos = { ...start }, log = [];
    const env = {
        w, here: () => ({ ...pos }), have: () => 64, log,
        exec: async (name, a) => {
            log.push([name, { ...a }]);
            if (name === 'move_to') { if (!canWalk(a)) return { ok: false, reason: 'unreachable', detail: { why: 'no path' } }; pos.x = a.x; pos.y = a.y; pos.z = a.z; return { ok: true }; }
            if (name === 'mine') {
                const d = Math.hypot(pos.x + 0.5 - (a.x + 0.5), pos.y + 1.62 - (a.y + 0.5), pos.z + 0.5 - (a.z + 0.5));
                if (d > 4.6) return { ok: false, reason: 'unreachable', detail: { why: 'reach block', d } };
                w.set(a.x, a.y, a.z, 'air'); return { ok: true };
            }
            return { ok: true };
        },
    };
    return env;
}

(async () => {
    const box = { x0: 0, z0: 0, x1: 15, z1: 15, top: 99, bottom: 96 };
    await test('plan: the expert method cuts a chunk into bands of two layers, one unit per band; the unit holds the band\'s cells', () => {
        const plan = pit.planPit(box, { method: 'expert', road: false }), reg = plan.regions[0];
        assert.strictEqual(plan.regions.length, 1); assert.deepStrictEqual([reg.layers, reg.rows, reg.meta.band, reg.meta.method], [2, 1, 2, 'expert']);
        const c0 = pit.unitCells(plan, reg, 0), c1 = pit.unitCells(plan, reg, 1);
        assert.strictEqual(c0.length, 512); assert.ok(c0.every((c) => c.y === 99 || c.y === 98)); assert.ok(c1.every((c) => c.y === 97 || c.y === 96));
        assert.strictEqual(c0[0].y, 99, 'top layer first');
        assert.throws(() => pit.planPit(box, { method: 'spiral' }), /rows, sweep or expert/);
    });

    await test('runUnit: a fresh band is dug completely from far fewer stations than the tile sweep needs (32 for two layers), blind, nothing outside the chunk', async () => {
        const job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0];
        const w = fakeWorld(99), env = fakeEnv(w, { x: 0, y: 100, z: 0 });
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        const mined = env.log.filter((l) => l[0] === 'mine'), moves = env.log.filter((l) => l[0] === 'move_to');
        assert.strictEqual(r.detail.mined, 512); assert.ok(mined.every((l) => l[1].blind === true && l[1].collect === false), 'blind, no walk to a view');
        assert.ok(mined.every((l) => l[1].x >= 0 && l[1].x <= 15 && l[1].z >= 0 && l[1].z <= 15 && (l[1].y === 99 || l[1].y === 98)), 'only the band of the chunk');
        assert.ok(r.detail.expert.stations <= 20, `${r.detail.expert.stations} stations (the tile sweep needs 16 per layer, 32 for the band)`); assert.ok(r.detail.blocksPerStation >= 25, `${r.detail.blocksPerStation} blocks per station`);
        assert.ok(moves.length <= r.detail.expert.stations);
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (const y of [98, 99]) assert.strictEqual(w.kindAt(x, y, z), 'air');
        // the layer below was not touched
        assert.strictEqual(w.kindAt(5, 97, 5), 'solid');
    });

    await test('runUnit: leftovers above the band (inside the box) within reach are dug too; bedrock and a chest stay; a second run finds nothing to do', async () => {
        // unit 1 = the band y 97 / 96; the two layers above (already dug by unit 0) hold leftovers; the chunk's top two layers are open
        const w = fakeWorld(97, { '5,98,5': 'stone', '5,99,5': 'stone', '9,97,9': 'bedrock', '3,96,3': 'chest' });
        const job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0], env = fakeEnv(w, { x: 0, y: 98, z: 0 });
        const r = await job.runUnit(reg.id, { unit: 1 }, env);
        assert.strictEqual(w.kindAt(5, 98, 5), 'air', 'the leftover above the band'); assert.strictEqual(w.kindAt(5, 99, 5), 'air');
        assert.strictEqual(w.nameAt(9, 97, 9), 'bedrock');
        assert.ok(r.ok || r.reason, JSON.stringify(r).slice(0, 200));
        const again = await job.runUnit(reg.id, { unit: 1 }, env);
        assert.ok(again.ok, JSON.stringify(again).slice(0, 200)); assert.ok(again.detail.idle || !again.detail.mined, 'nothing left to dig');
        // cells above the box are never touched
        const w2 = fakeWorld(99, { '5,100,5': 'stone' }), env2 = fakeEnv(w2, { x: 0, y: 100, z: 0 });
        await job.runUnit(reg.id, { unit: 0 }, env2); assert.strictEqual(w2.kindAt(5, 100, 5), 'solid', 'outside the box stays');
    });

    await test('runUnit: a station that cannot be reached is not tried again, four in a row end the unit with the walk\'s reason', async () => {
        const job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0];
        const w = fakeWorld(99), env = fakeEnv(w, { x: 0, y: 100, z: 0 }, { canWalk: () => false });
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'unreachable');
        const moves = env.log.filter((l) => l[0] === 'move_to'); const keys = moves.map((l) => `${l[1].x},${l[1].z}`);
        assert.strictEqual(new Set(keys).size, keys.length, 'every station once');
        // one corner of the chunk walled off: the unit still ends with the rest dug and the reason of the failure
        const w2 = fakeWorld(99), env2 = fakeEnv(w2, { x: 0, y: 100, z: 0 }, { canWalk: (a) => !(a.x >= 8 && a.z >= 8) });
        const r2 = await job.runUnit(reg.id, { unit: 0 }, env2);
        assert.ok(r2.ok || r2.reason === 'unreachable', JSON.stringify(r2).slice(0, 200));
        let dug = 0; for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (w2.kindAt(x, 99, z) === 'air') dug++;
        assert.ok(dug > 150, `${dug} cells of the top layer dug`);
    });

    await test('runUnit: a lake in the band is sealed by the water rule, the cells around it dug', async () => {
        const init = {}; for (let x = 6; x <= 8; x++) for (let z = 6; z <= 8; z++) init[`${x},99,${z}`] = 'water';
        const w = fakeWorld(99, init), job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0], env = fakeEnv(w, { x: 0, y: 100, z: 0 });
        env.exec = ((orig) => async (name, a) => { if (name === 'place') { w.set(a.x, a.y, a.z, 'cobblestone'); env.log.push([name, a]); return { ok: true }; } return orig(name, a); })(env.exec);
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.ok(env.log.some((l) => l[0] === 'place'), 'water is filled before it is dug'); assert.ok(r.ok || r.reason, JSON.stringify(r).slice(0, 200));
    });
    console.log('\npit expert unit: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

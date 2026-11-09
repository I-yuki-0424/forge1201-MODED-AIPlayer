// The layer gate (owner 2026-11-10: "fix the leftovers properly before going down a level"): a layer opens the next one only after every cell of it was read from the world; what still
// holds a block goes back to work (done and parked units alike), a few rounds at most. Pure: the ledger, the pit's check and the worker loop on a fake world.
const assert = require('assert');
const { Ledger } = require('../src/work/jobs/crew');
const pit = require('../src/work/jobs/pit');
const { runWorker } = require('../src/work/bot/worker');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const P = { x: 0, z: 0 };

(async () => {
    await test('ledger: the layer below waits for the check; one bot reads; a clear check opens it; the last layer needs its check before the job is finished', () => {
        const L = new Ledger({ gate: true }); L.addRegion({ id: 'r', anchor: P, layers: 2, rows: 2 }); L.join('A'); L.join('B');
        const a = L.claim('A', P, 0, { batch: 2 }); assert.strictEqual(a.units.length, 2);
        for (const u of a.units) L.done('A', 'r', u.unit, 1);
        assert.strictEqual(L.claim('B', P, 2), null, 'layer 0 is settled but not read: layer 1 is not claimable');
        const ck = L.needCheck('B', 3); assert.deepStrictEqual([ck.region, ck.layer], ['r', 0]); assert.strictEqual(L.needCheck('A', 4), null, 'one reader at a time'); assert.ok(L.checkBusy(5));
        assert.ok(!L.checkDone('A', 'r', 0, 6, true), 'only the reader may close it'); assert.ok(L.checkDone('B', 'r', 0, 6, true));
        const b = L.claim('B', P, 7, { batch: 2 }); assert.strictEqual(b.units[0].layer, 1, 'now layer 1');
        for (const u of b.units) L.done('B', 'r', u.unit, 8);
        assert.strictEqual(L.finished(), false, 'the last layer is read too');
        const c2 = L.needCheck('A', 9); assert.strictEqual(c2.layer, 1); L.checkDone('A', 'r', 1, 10, true); assert.strictEqual(L.finished(), true);
        assert.strictEqual(L.needCheck('A', 11), null);
    });

    await test('ledger: a unit sent back (done or parked) closes the layer again; the reader that leaves hands the reading on; a build ledger (no gate) is unchanged', () => {
        const L = new Ledger({ gate: true, maxAttempts: 1 }); L.addRegion({ id: 'r', anchor: P, layers: 2, rows: 2 }); L.join('A');
        const c = L.claim('A', P, 0, { batch: 2 }); L.done('A', 'r', c.units[0].unit, 1); L.fail('A', 'r', c.units[1].unit, 'timeout', 1, { stage: 'mine', cell: { x: 1, y: 1, z: 1 } });
        assert.strictEqual(L.stuck.length, 1); assert.strictEqual(L.claim('A', P, 2), null, 'a parked unit settles the layer, the check still stands in front of layer 1');
        const ck = L.needCheck('A', 3); assert.ok(ck);
        assert.ok(L.requeueUnit('r', c.units[1].unit, 4, { holdMs: 1000 }), 'the parked unit goes back'); assert.ok(L.requeueUnit('r', c.units[0].unit, 4), 'and the done one too');
        assert.strictEqual(L.stuck.length, 0); L.checkDone('A', 'r', 0, 4, false);
        assert.strictEqual(L.claim('A', P, 5).units.length, 1, 'the unit without a hold is claimable at once (the held one waits)');
        assert.ok(!L.requeueUnit('r', c.units[0].unit, 6), 'a leased unit is not sent back');
        L.leave('A', 6); L.join('A'); assert.strictEqual(L.needCheck('A', 7), null, 'units are pending: nothing to read yet');
        const N = new Ledger({}); N.addRegion({ id: 'r', anchor: P, layers: 2, rows: 1 }); N.join('A'); const n = N.claim('A', P, 0); N.done('A', 'r', n.units[0].unit, 1);
        assert.strictEqual(N.claim('A', P, 2).units[0].layer, 1, 'without the gate layer 1 follows at once'); assert.strictEqual(N.needCheck('A', 3), null);
        // a reader that leaves
        const G = new Ledger({ gate: true }); G.addRegion({ id: 'r', anchor: P, layers: 1, rows: 1 }); G.join('A'); G.join('B'); const g = G.claim('A', P, 0); G.done('A', 'r', g.units[0].unit, 1);
        assert.ok(G.needCheck('A', 2)); assert.strictEqual(G.needCheck('B', 3), null); G.leave('A', 4); assert.ok(G.needCheck('B', 5), 'the next bot reads it');
    });

    await test('pit check: a cell that still holds a block sends its unit back, three rounds at most, then it is accepted; a left-on-purpose cell never does', async () => {
        const box = { x0: 0, x1: 4, z0: 0, z1: 4, top: 10, bottom: 9 }, job = pit.createPitJob(box, { gate: true }, { method: 'sweep', road: false });
        const solid = new Set(), accepted = job.plan.accepted;
        const w = { kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'stone' : 'air') };
        const L = job.ledger; L.join('A'); const reg = [...L.regions.values()][0]; assert.strictEqual(reg.rows, 1);
        const c = L.claim('A', P, 0); L.done('A', reg.id, c.units[0].unit, 1);
        const env = { w, here: () => ({ x: 2, y: 10, z: 2 }) };
        solid.add('1,10,1');
        for (let round = 1; round <= 3; round++) {
            const ck = L.needCheck('A', 10 * round); assert.ok(ck, `round ${round}`);
            const r = await job.checkLayer(env, ck, 10 * round); assert.strictEqual(r.reopened, 1, JSON.stringify(r)); L.checkDone('A', reg.id, 0, 10 * round, false);
            const again = L.claim('A', P, 10 * round + 20000); assert.ok(again, 'back to work (after its hold)'); L.done('A', reg.id, again.units[0].unit, 10 * round + 1);
        }
        const last = L.needCheck('A', 100), r4 = await job.checkLayer(env, last, 100);
        assert.deepStrictEqual([r4.reopened, r4.leftover], [0, 1], 'after three rounds the leftover is accepted and reported'); L.checkDone('A', reg.id, 0, 100, !r4.reopened);
        assert.ok(L.claim('A', P, 200), 'the layer below opens');
        accepted.add('3,9,3'); solid.add('3,9,3'); // a fixture left on purpose in the lower layer
        const ck2 = (() => { const lay = L.regions.get(reg.id); const u = reg.rows * 1; L.done('A', reg.id, u, 300); return L.needCheck('A', 301); })();
        const r5 = await job.checkLayer(env, ck2, 301); assert.strictEqual(r5.reopened, 0, JSON.stringify(r5));
    });

    await test('worker: a bot that leaves one block in layer 0 is sent back to it before anybody starts layer 1 (the whole loop on a fake world)', async () => {
        const box = { x0: 0, x1: 4, z0: 0, z1: 4, top: 10, bottom: 9 }, job = pit.createPitJob(box, { gate: true, leaseMs: 60000 }, { method: 'sweep', road: false });
        const solid = new Set(), log = [], w = { kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'stone' : 'air') };
        for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) for (const y of [9, 10]) solid.add(`${x},${y},${z}`);
        let tries = 0;
        const jobRun = { ...job, runUnit: async (regionId, u, env) => {
            const layer = u.layer; log.push(layer);
            for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) solid.delete(`${x},${10 - layer},${z}`);
            if (layer === 0 && ++tries === 1) solid.add('2,10,2');                         // the first time a block is left behind
            return { ok: true };
        } };
        const env = { w, now: Date.now, pos: () => P, here: () => ({ x: 2, y: 11, z: 2 }), exec: async () => ({ ok: true }), inv: () => ({ items: [], slotsFree: 30 }) };
        const r = await runWorker(jobRun, 'A', env, { pollMs: 5, policy: null });
        assert.strictEqual(r.ended, 'finished'); assert.deepStrictEqual(log, [0, 0, 1], 'layer 0 ran twice (the block was found), then layer 1: ' + JSON.stringify(log));
        assert.strictEqual([...solid].length, 0, 'nothing is left');
    });

    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

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

    await test('pit check: a done unit that still shows a block goes back claimable at once (no hold: a lone bot idled about 8 s per reopening, wp075a); negative control: a parked unit keeps its hold', async () => {
        const box = { x0: 0, x1: 4, z0: 0, z1: 4, top: 10, bottom: 9 }, job = pit.createPitJob(box, { gate: true }, { method: 'sweep', road: false });
        const solid = new Set(['1,10,1']), w = { kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'stone' : 'air') };
        const L = job.ledger; L.join('A'); const reg = [...L.regions.values()][0], env = { w, here: () => ({ x: 2, y: 10, z: 2 }) };
        const c = L.claim('A', P, 0); L.done('A', reg.id, c.units[0].unit, 1);
        let ck = L.needCheck('A', 10); assert.strictEqual((await job.checkLayer(env, ck, 10)).reopened, 1); L.checkDone('A', reg.id, 0, 10, false);
        assert.ok(L.claim('A', P, 11), 'claimable at once');
        const job2 = pit.createPitJob(box, { gate: true }, { method: 'sweep', road: false }), L2 = job2.ledger; L2.join('A'); const reg2 = [...L2.regions.values()][0];
        const c2 = L2.claim('A', P, 0); for (let i = 0; i < 20 && reg2.state[c2.units[0].unit] !== 3; i++) { L2.fail('A', reg2.id, c2.units[0].unit, 'unreachable', i + 1); const again = L2.claim('A', P, 1e6 * (i + 1)); if (!again) break; }
        assert.strictEqual(reg2.state[c2.units[0].unit], 3, 'the unit is parked');
        {          // parked (STUCK)
            ck = L2.needCheck('A', 2e7); assert.strictEqual((await job2.checkLayer(env, ck, 2e7)).reopened, 1); L2.checkDone('A', reg2.id, 0, 2e7, false);
            assert.strictEqual(L2.claim('A', P, 2e7 + 1), null, 'negative control: a parked unit is held');
        }
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

    await test('lookahead: while one slow unit of the front layer is leased, another bot takes units below it in columns whose rows above are settled, never under or beside the slow one; a settled front waits for its check (negative control: lookahead 0 idles)', async () => {
        const mk = (lookahead) => { const L = new Ledger({ gate: true, lookahead }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 4, rows: 6 }); return L; };
        const L = mk(2);
        const a = L.claim('A', P, 0, { batch: 6 }); assert.strictEqual(a.units.length, 6);
        for (const u of a.units) if (u.row !== 2) L.done('A', 'r', u.unit, 1);           // row 2 stays leased (the slow tree unit)
        const b = L.claim('B', P, 2, { batch: 6 });
        assert.ok(b, 'B is given work below'); assert.ok(b.units.every((u) => u.layer === 1), JSON.stringify(b.units));
        assert.deepStrictEqual(b.units.map((u) => u.row).sort(), [0, 4, 5], 'not under the slow unit or beside it');
        for (const u of b.units) L.done('B', 'r', u.unit, 3);
        const c = L.claim('B', P, 4, { batch: 6 }); assert.deepStrictEqual(c && c.units.map((u) => [u.layer, u.row]), [[2, 5]], 'layer 2 only where both layers above are settled beside it: ' + JSON.stringify(c && c.units));
        for (const u of c.units) L.done('B', 'r', u.unit, 5);
        assert.strictEqual(L.claim('B', P, 6, { batch: 6 }), null, 'never a third layer below');
        L.done('A', 'r', 2, 7);
        assert.strictEqual(L.claim('B', P, 8, { batch: 6 }), null, 'the front is settled now: no unit before its check');
        const ck = L.needCheck('B', 9); assert.ok(ck && ck.layer === 0); L.checkDone('B', 'r', 0, 10, true);
        const d = L.claim('B', P, 11, { batch: 6 }); assert.ok(d && d.units.every((u) => u.layer === 1), 'then the rest of layer 1');
        // negative control
        const N = mk(0); const na = N.claim('A', P, 0, { batch: 6 }); for (const u of na.units) if (u.row !== 2) N.done('A', 'r', u.unit, 1);
        assert.strictEqual(N.claim('B', P, 2, { batch: 6 }), null, 'without lookahead the second bot idles');
    });

    await test('worker: a lease the bot holds by mistake while it waits is not renewed: it expires and the unit is run (bt075u2: 8 bots waited 10 min behind one leased unit nobody ran)', async () => {
        const L = new Ledger({ leaseMs: 3000 }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 2 });          // (renewed every 1 s while working)
        const ran = []; let leaked = false;
        // while it runs its first unit, the bot takes the other one by mistake (a lease leaked outside the loop)
        const job = { ledger: L, runUnit: async (rid, u) => { if (!leaked) { leaked = true; const lk = L.claim('B', P, Date.now()); assert.ok(lk && lk.units.length === 1); } ran.push(u.unit); return { ok: true }; } };
        const env = { pos: () => P, here: () => ({ x: 0, y: 0, z: 0 }), now: Date.now, exec: async () => ({ ok: true }) };
        const r = await Promise.race([runWorker(job, 'B', env, { pollMs: 20, policy: null }), new Promise((res) => setTimeout(() => res({ ended: 'hung' }), 9000))]);
        assert.strictEqual(r.ended, 'finished', JSON.stringify(r)); assert.deepStrictEqual(ran.sort(), [0, 1]);
    });

    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// Guard your post (owner 2026-11-10: "the mining location is vague, everyone mines as they please"): the ledger gives every bot its own range, the nearest one, keeps it for it while it is gone for
// a while, gives it back after a restart, and lets a bot help elsewhere only when its own range is finished (or nothing else is left). Pure.
const assert = require('assert');
const { Ledger } = require('../src/work/jobs/crew');

setTimeout(() => { console.error('test watchdog: still running after 20 s'); process.exit(2); }, 20000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const mk = (opt = {}) => { const L = new Ledger({ lanes: true, ...opt }); for (let i = 0; i < 6; i++) L.addRegion({ id: `r${i}`, anchor: { x: i * 100, z: 0 }, layers: 3, rows: 2 }); return L; };

(async () => {
    await test('a bot gets the NEAREST free range, not the one with most work left', () => {
        const L = mk();
        const c = L.claim('A', { x: 480, z: 0 }, 0); assert.strictEqual(c.region, 'r5');
        const d = L.claim('B', { x: 10, z: 0 }, 0); assert.strictEqual(d.region, 'r0');
        const e = L.claim('C', { x: 300, z: 0 }, 0); assert.strictEqual(e.region, 'r3');
        assert.deepStrictEqual(L.homes(), { A: 'r5', B: 'r0', C: 'r3' });
    });
    await test('a range kept by a bot that is here is not taken by another bot, even between its units; a bot that left for good loses it after three minutes', () => {
        const L = mk();
        const a = L.claim('A', { x: 0, z: 0 }, 0); assert.strictEqual(a.region, 'r0');
        for (const u of a.units) L.done('A', 'r0', u.unit, 1);                    // A holds no lease now
        const b = L.claim('B', { x: 5, z: 0 }, 2); assert.strictEqual(b.region, 'r1', 'B is next to r0 but r0 is A post');
        L.leave('A', 10);
        const c = L.claim('C', { x: 0, z: 0 }, 20000); assert.strictEqual(c.region, 'r2', 'A left 20 s ago and keeps its post');
        const d = L.claim('D', { x: 0, z: 0 }, 10 + 200000); assert.strictEqual(d.region, 'r0', 'three minutes later the post is free');
        const back = L.claim('A', { x: 0, z: 0 }, 10 + 200001);
        assert.ok(back === null || back.region === 'r0', 'A still points at its home: it waits for a unit there or takes one, it never roams');
    });
    await test('a bot whose own range is finished helps (the nearest range with work), a bot without a post helps only when nothing else is free', () => {
        const L = new Ledger({ lanes: true });
        L.addRegion({ id: 'x', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 }); L.addRegion({ id: 'y', anchor: { x: 500, z: 0 }, layers: 1, rows: 2 });
        const a = L.claim('A', { x: 0, z: 0 }, 0), b = L.claim('B', { x: 500, z: 0 }, 0);
        assert.deepStrictEqual([a.region, b.region], ['x', 'y']);
        L.done('A', 'x', a.units[0].unit, 1);
        const help = L.claim('A', { x: 0, z: 0 }, 2); assert.strictEqual(help.region, 'y'); assert.strictEqual(help.role, 'helper', 'its own post is finished: it helps B');
        const late = L.claim('Z', { x: 0, z: 0 }, 3); assert.strictEqual(late, null, 'no unit is free any more');
        const L2 = new Ledger({ lanes: true }); L2.addRegion({ id: 'only', anchor: { x: 0, z: 0 }, layers: 1, rows: 3 });
        L2.claim('P', { x: 0, z: 0 }, 0); const q = L2.claim('Q', { x: 0, z: 0 }, 1); assert.strictEqual(q.role, 'helper', 'nothing else free: the second bot helps the first one');
    });
    await test('homes survive a restart: adopt gives every bot its post back, skips finished or unknown ones and never steals a post of a bot that is here', () => {
        const L = mk();
        L.claim('A', { x: 0, z: 0 }, 0); L.claim('B', { x: 100, z: 0 }, 0);
        const saved = JSON.parse(JSON.stringify(L.homes()));
        const R = mk();
        assert.strictEqual(R.adopt({ ...saved, X: 'nope', Y: 'r0' }, 5), 2, 'the unknown region is skipped, Y finds r0 kept by A');
        assert.deepStrictEqual(R.homes(), { A: 'r0', B: 'r1' });
        const c = R.claim('C', { x: 0, z: 0 }, 6); assert.strictEqual(c.region, 'r2', 'C does not take A or B post');
        assert.strictEqual(R.claim('A', { x: 400, z: 0 }, 6).region, 'r0', 'A goes to its own post wherever it stands');
    });
})().catch((e) => { console.error(e); process.exit(1); });

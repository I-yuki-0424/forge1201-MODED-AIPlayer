// The owner's batch of 2026-11-10 (limits and gates): a gate that says where it leads (an End portal has no twin), pits of up to 100 x 100 chunks, the chest reach as a setting,
// no server move when teleportation is off, a far bot walks back to its job instead. Pure tests, no server.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sites, REACH_BLOCKS } = require('../src/work/bot/sites');
const route = require('../src/work/bot/route');
const pit = require('../src/work/jobs/pit');
const { normalizeBox, MAX_SIDE, MAX_CHUNKS } = require('../src/work/service/common');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const throws = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message, re); return true; });
function fakeWorld(ground = 0) {
    const m = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    return { nameAt, kindAt: (x, y, z) => (nameAt(x, y, z) === 'air' ? 'air' : 'solid'), set: (x, y, z, n) => m.set(key(x, y, z), n) };
}

(async () => {
    await test('gates: a portal that says where it leads (no twin) is a gate; it is the dimension it stands in that decides where the plan starts', () => {
        const s = new Sites();
        const g = s.add({ name: 'endportal', x: 1761, y: 20, z: 1757, purpose: 'portal', dim: 'overworld', leads: 'minecraft:the_end' });
        assert.strictEqual(g.leads, 'end'); assert.strictEqual(g.twin, undefined);
        const p = route.plan(s, { dim: 'overworld', x: 1700, y: 64, z: 1700 }, { dim: 'end', x: 100, y: 49, z: 0 });
        assert.deepStrictEqual(p.map((x) => (x.cross ? `cross ${x.cross}` : `walk ${x.walk.dim}${x.walk.gate ? ' gate' : ''}`)), ['walk overworld gate', 'cross endportal', 'walk end']);
        assert.strictEqual(route.plan(s, { dim: 'end', x: 0, y: 64, z: 0 }, { dim: 'overworld', x: 0, y: 64, z: 0 }), null, 'a gate is one way: nothing leads back from the End');
        assert.strictEqual(route.plan(s, { dim: 'overworld', x: 0, y: 64, z: 0 }, { dim: 'nether', x: 0, y: 64, z: 0 }), null, 'and nothing leads to the Nether');
        // the owner\'s 2026-11-10 tag: the block is in the overworld, "end" was written as its dimension: it is a gate of the End, standing in the End, and no way into it from the overworld
        const wrong = new Sites([{ name: 'endportal', x: 1761, y: 20, z: 1757, purpose: 'portal', dim: 'end' }]);
        assert.strictEqual(route.plan(wrong, { dim: 'overworld', x: 0, y: 64, z: 0 }, { dim: 'end', x: 100, y: 49, z: 0 }), null);
        const near = new Sites(); near.add({ name: 'a', x: 1, y: 1, z: 1, purpose: 'portal', dim: 'overworld', leads: 'end' }); near.add({ name: 'b', x: 900, y: 1, z: 900, purpose: 'portal', dim: 'overworld', leads: 'end' });
        assert.strictEqual(route.plan(near, { dim: 'overworld', x: 800, y: 64, z: 800 }, { dim: 'end', x: 0, y: 0, z: 0 })[0].walk.x, 900, 'the nearest gate that leads there');
        // the Nether shortcut still needs real twins
        const one = new Sites(); one.add({ name: 'n1', x: 1, y: 1, z: 1, purpose: 'portal', dim: 'overworld', leads: 'nether' }); one.add({ name: 'n2', x: 2, y: 1, z: 2, purpose: 'portal', dim: 'nether', leads: 'overworld' });
        assert.deepStrictEqual(route.plan(one, { dim: 'overworld', x: 0, y: 64, z: 0 }, { dim: 'overworld', x: 5000, y: 64, z: 5000 }, { viaNether: true }).length, 1, 'no twins: the plain walk');
    });

    await test('sites: leads belongs to a portal, names a dimension, and is never the dimension the block stands in', () => {
        const s = new Sites();
        throws(() => s.add({ name: 'q', x: 1, y: 1, z: 1, purpose: 'ore', leads: 'end' }), /belongs to a portal/);
        throws(() => s.add({ name: 'q', x: 1, y: 1, z: 1, purpose: 'portal', leads: 'mars' }), /leads:/);
        throws(() => s.add({ name: 'q', x: 1, y: 1, z: 1, purpose: 'portal', dim: 'end', leads: 'end' }), /does not lead to the dimension it stands in/);
        throws(() => s.add({ name: 'q', x: 1, y: 1, z: 1, purpose: 'portal', leads: 'overworld' }), /does not lead to the dimension it stands in/);
        assert.strictEqual(s.add({ name: 'tf', x: 4, y: 1, z: 1, purpose: 'portal', leads: 'twilightforest:twilight_forest' }).leads, 'twilightforest:twilight_forest');
        assert.strictEqual(new Sites(s.list()).get('tf').leads, 'twilightforest:twilight_forest', 'it survives a save and a load');
    });

    await test('pit size: 100 x 100 chunks (1600 blocks a side) is the limit, was 16 x 16; a wider one is refused with the chunk count', () => {
        assert.deepStrictEqual([MAX_CHUNKS, MAX_SIDE], [100, 1600]);
        assert.ok(normalizeBox({ x0: -800, z0: -800, x1: 799, z1: 799, top: 70, bottom: 60 }));
        throws(() => normalizeBox({ x0: 0, z0: 0, x1: 1600, z1: 10, top: 70, bottom: 60 }), /100 x 100 chunks/);
        throws(() => normalizeBox({ x0: 0, z0: 10, x1: 10, z1: 1700, top: 70, bottom: 60 }), /100 x 100 chunks/);
    });

    await test('pit size: a 1600 x 1600 pit is cut into chunk regions and costs what the ledger says it costs; one with too many units is refused with the reason', () => {
        const t0 = Date.now(), rss0 = process.memoryUsage().rss;
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 1599, z1: 1599, top: 70, bottom: 61 }, { gate: true, lanes: true }, { lanes: 20, method: 'sweep', road: false });
        const P = job.ledger.progress();
        assert.strictEqual(P.regions, 10000, '100 x 100 chunks');
        assert.strictEqual(P.total, 10000 * 16 * 10, 'sixteen 5 x 5 stations per chunk, ten layers');
        const ms = Date.now() - t0, mb = (process.memoryUsage().rss - rss0) / 1e6;
        console.log(`  1600 x 1600 x 10: ${P.total} units, ${ms} ms, ${Math.round(mb)} MB`);
        assert.ok(ms < 8000, `${ms} ms to plan`);
        // the claim loop over 10,000 regions stays cheap
        job.ledger.join('A'); const c0 = Date.now(); let got = 0; for (let i = 0; i < 40; i++) { const r = job.ledger.claim('A', { x: 800, z: 800 }, 1000 + i); if (r) got += r.units.length; }
        assert.ok(got > 0 && Date.now() - c0 < 1500, `claims: ${Date.now() - c0} ms`);
        const first = job.ledger.claim('B', { x: 0, z: 0 }, 5000); assert.ok(first && first.units.length, 'another bot is given a unit too');
        assert.strictEqual(job.ledger.needCheck('A', 5000), null, 'nothing to read yet'); job.ledger.progress();
        throws(() => pit.createPitJob({ x0: 0, z0: 0, x1: 1599, z1: 1599, top: 319, bottom: -59 }, {}, { lanes: 20, method: 'sweep', road: false }), /units of work/);
        assert.ok(pit.MAX_UNITS >= 10000 * 16 * 100, 'a 100 x 100 chunk pit 100 layers deep fits');
    });

    await test('settings: the chest reach is a setting in chunks (50 for now), validated, applied to the registry, kept over a restart; server moves are off by default', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));
        const svc = new WorkService({ dataDir: dir, factory: () => ({}), restore: false });
        assert.strictEqual(svc.settings.reachChunks, 50); assert.strictEqual(svc.sites.reach, 800); assert.strictEqual(REACH_BLOCKS, 800);
        assert.strictEqual(svc.settings.teleport, 'off', 'teleportation is prohibited for the time being');
        svc.setSettings({ reachChunks: 10 }); assert.strictEqual(svc.sites.reach, 160); assert.strictEqual(svc.settings.reachChunks, 10);
        for (const bad of [0, 201, 2.5, '50', null]) assert.throws(() => svc.setSettings({ reachChunks: bad }), /reachChunks: 1\.\.200/);
        assert.strictEqual(svc.sites.reach, 160, 'a refused value changes nothing');
        svc.setSettings({ reachChunks: 30 }); svc.save();
        const again = new WorkService({ dataDir: dir, factory: () => ({}), restore: false }); await again.restore();
        assert.strictEqual(again.settings.reachChunks, 30); assert.strictEqual(again.sites.reach, 480, 'the registry is made again on restore and follows the setting');
        await svc.stop(); await again.stop();
    });

    await test('pit: server moves off - a bot far from its station is not sent back by the server; it walks there in legs, then the unit runs', async () => {
        const w = fakeWorld(60); for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) w.set(x, 64, z, 'stone');
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 4, z1: 4, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }), reg = job.plan.regions[0];
        let at = { x: 1500, y: 64, z: 1500 }; const calls = [], walked = [];
        const env = { w, have: () => 9, here: () => at, rejoin: async () => ({ ok: false, reason: 'refused', detail: { why: 'server moves are off (setting teleport)' } }), lift: async () => ({ ok: false, reason: 'refused' }),
            travel: async (to) => { walked.push(to); at = { x: to.x, y: 65, z: to.z }; return { ok: true, legs: 40, walked: 2000 }; },
            exec: async (n, a) => { calls.push(n); if (n === 'mine') w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } };
        const r = await job.runUnit(reg.id, { unit: 0, layer: 0, row: 0 }, env);
        assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(walked.length, 1, 'one long walk'); assert.ok(Math.abs(walked[0].x - 2) <= 3 && Math.abs(walked[0].z - 2) <= 3, JSON.stringify(walked)); assert.ok(calls.includes('mine'));
        // the walk fails: the unit fails as the bot\'s own trouble, nothing is dug
        const j2 = pit.createPitJob({ x0: 0, z0: 0, x1: 4, z1: 4, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }), c2 = [];
        const r2 = await j2.runUnit(j2.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, { ...env, here: () => ({ x: 1500, y: 64, z: 1500 }), travel: async () => ({ ok: false, reason: 'stuck', detail: { why: 'three legs in a row brought the bot less than 2 blocks closer' } }), exec: async (n) => { c2.push(n); return { ok: true }; } });
        assert.strictEqual(r2.ok, false); assert.strictEqual(r2.detail.botSide, true); assert.strictEqual(c2.length, 0); assert.match(r2.detail.why, /walking back to the job failed/);
    });
    console.log('\nwork limits: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

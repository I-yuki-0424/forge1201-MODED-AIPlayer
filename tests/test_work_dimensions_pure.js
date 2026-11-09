// Dimensions (src/work/world/dimensions.js and its wiring, owner 2026-11-09): names, limits, designated ranges, the map folder of a modded dimension, jobs and commands in
// the Nether, the End and a dimension nobody has described. No server: fake bots and a fake action layer, as in test_work_service_pure.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
require('../src/transport/forge_bot').applyProtocolBypasses();
const D = require('../src/work/world/dimensions');
const { MapStore } = require('../src/work/world/maps');
const { Sites } = require('../src/work/bot/sites');
const { layout } = require('../src/work/jobs/layout');
const { WorkService } = require('../src/work/service');
const { catalog } = require('../src/work/operator/catalog');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } }
const throws = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message, re); return true; });
const TF = 'twilightforest:twilight_forest';

(async () => {
    await test('canon: the three vanilla dimensions in every spelling, any namespaced id, nothing else (and no path tricks)', () => {
        for (const [a, b] of [['overworld', 'overworld'], ['minecraft:overworld', 'overworld'], ['the_nether', 'nether'], ['minecraft:the_nether', 'nether'], ['nether', 'nether'], ['minecraft:the_end', 'end'], ['END', 'end'], [TF, TF], ['aether:the_aether', 'aether:the_aether']]) assert.strictEqual(D.canon(a), b, a);
        for (const bad of ['mars', '', null, undefined, 'a b:c', 'x:', ':y', 'a:../../etc', 'a:b/../c', '../x:y', 'a:b//c', 'a:b;stop', 'a:b\nstop', `a:${'x'.repeat(70)}`]) assert.strictEqual(D.canon(bad), null, String(bad));
        assert.strictEqual(D.rconId('nether'), 'minecraft:the_nether'); assert.strictEqual(D.rconId(TF), TF); assert.strictEqual(D.rconId('end'), 'minecraft:the_end');
        throws(() => D.need('mars'), /dim: overworld, nether, end/);
    });

    await test('profile: vanilla limits, the safe guess for an unknown dimension, what a bot learned, and a datapack that changes a vanilla one', () => {
        assert.deepStrictEqual([D.profile('overworld').minY, D.profile('overworld').maxY], [-64, 319]);
        assert.deepStrictEqual([D.profile('nether').minY, D.profile('nether').maxY, D.profile('nether').scale], [0, 255, 8]);
        assert.strictEqual(D.profile('end').voidBelow, true);
        const u = D.profile(TF); assert.deepStrictEqual([u.known, u.minY, u.maxY, u.voidBelow, u.learned], [false, 0, 255, null, false], 'no floor is assumed, the limits are the intersection of the vanilla ones');
        const l = D.profile(TF, { minY: -64, height: 384 }); assert.deepStrictEqual([l.minY, l.maxY, l.learned], [-64, 319, true]);
        assert.strictEqual(D.profile('nether', { minY: 0, height: 256 }).learned, undefined, 'learned limits equal to the profile change nothing');
        const dp = D.profile('overworld', { minY: -32, height: 256 }); assert.deepStrictEqual([dp.minY, dp.maxY, dp.learned], [-32, 223, true]);
        assert.strictEqual(D.profile(TF, { minY: 0, height: 5 }).maxY, 255, 'a nonsense height is ignored');
    });

    await test('designate: a range is normalised, defaults to the work band, is checked against its dimension, and carries warnings', () => {
        const r = D.designate({ dim: 'minecraft:the_nether', x0: 50, x1: 10, z0: 5, z1: 5 });
        assert.deepStrictEqual([r.dim, r.x0, r.x1, r.z0, r.z1, r.y0, r.y1], ['nether', 10, 50, 5, 5, 5, 122], 'the Nether work band lies between the bedrock layers');
        assert.deepStrictEqual(r.warnings, []);
        const b = D.designate({ dim: 'nether', x0: 0, x1: 3, z0: 0, z1: 3, y0: 0, y1: 10 });
        assert.match(b.warnings[0], /lower bedrock layer/);
        const o = D.designate({ x0: 0, x1: 3, z0: 0, z1: 3, y0: -64, y1: 0 }); assert.strictEqual(o.dim, 'overworld'); assert.match(o.warnings[0], /lower bedrock/);
        assert.match(D.designate({ dim: 'end', x0: 0, x1: 1, z0: 0, z1: 1 }).warnings.join(' '), /no floor in places/);
        assert.match(D.designate({ dim: TF, x0: 0, x1: 1, z0: 0, z1: 1 }).warnings.join(' '), /guess/);
        throws(() => D.designate({ dim: 'nether', x0: 0, x1: 1, z0: 0, z1: 1, y0: 0, y1: 300 }), /between 0 and 255 in nether/);
        throws(() => D.designate({ dim: 'overworld', x0: 0, x1: 1, z0: 0, z1: 1, y0: -65, y1: 0 }), /between -64 and 319/);
        throws(() => D.designate({ dim: TF, x0: 0, x1: 1, z0: 0, z1: 1, y0: -10, y1: 0 }), /safe limits/);
        assert.doesNotThrow(() => D.designate({ dim: TF, x0: 0, x1: 1, z0: 0, z1: 1, y0: -10, y1: 0 }, { learned: { minY: -64, height: 384 } }));
        throws(() => D.designate({ dim: 'nether', x0: 0, x1: 300, z0: 0, z1: 1 }), /at most 256/);
        throws(() => D.designate({ dim: 'nether', x0: 0.5, x1: 3, z0: 0, z1: 1 }), /x0 must be an integer/);
        throws(() => D.designate({ dim: 'mars', x0: 0, x1: 1, z0: 0, z1: 1 }), /dim:/);
        throws(() => D.designate(null), /range missing/);
        assert.deepStrictEqual(D.centre(r), { dim: 'nether', x: 30, y: 122, z: 5 });
        assert.ok(D.contains(r, { x: 20, y: 50, z: 5, dim: 'nether' })); assert.ok(!D.contains(r, { x: 20, y: 50, z: 5, dim: 'overworld' })); assert.ok(!D.contains(r, { x: 20, y: 130, z: 5 }));
    });

    await test('convert: overworld <-> nether by 1:8 (the portal rule); any other pair keeps the numbers and says it is not exact', () => {
        assert.deepStrictEqual(D.convert({ x: 800, y: 70, z: -81 }, 'overworld', 'nether'), { x: 100, y: 70, z: -11, dim: 'nether', exact: true });
        assert.deepStrictEqual(D.convert({ x: 100, y: 70, z: -11 }, 'minecraft:the_nether', 'overworld'), { x: 800, y: 70, z: -88, dim: 'overworld', exact: true });
        assert.strictEqual(D.convert({ x: 5, y: 5, z: 5 }, 'overworld', TF).exact, false);
        assert.strictEqual(D.convert({ x: 5, y: 5, z: 5 }, 'end', 'end').exact, true);
    });

    await test('checkPoint: x, z and y of a target against the limits of its dimension', () => {
        assert.strictEqual(D.checkPoint({ dim: 'nether', x: 1, y: 100, z: 1 }).name, 'nether');
        throws(() => D.checkPoint({ dim: 'nether', x: 1, y: 300, z: 1 }), /outside nether \(0..255\)/);
        throws(() => D.checkPoint({ dim: 'nether', x: 1, y: -1, z: 1 }), /outside nether/);
        throws(() => D.checkPoint({ x: 1.5, y: 1, z: 1 }), /x must be an integer/);
        assert.doesNotThrow(() => D.checkPoint({ x: 1, y: -64, z: 1 }));
    });

    await test('the map reads a modded dimension from dimensions/<ns>/<path>/region and refuses a path that leaves the world folder', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimworld-'));
        fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'dimensions', 'twilightforest', 'twilight_forest', 'region'), { recursive: true });
        const m = new MapStore(dir);
        assert.strictEqual(m._dir('end'), path.join(dir, 'DIM1/region'));
        assert.strictEqual(m._dir(TF), path.join(dir, 'dimensions', 'twilightforest', 'twilight_forest', 'region'));
        assert.deepStrictEqual(m.index(TF), []);
        for (const bad of ['../x', 'a:../../b', 'a:b/..', 'mars', '']) assert.throws(() => m._dir(bad), (e) => e.status === 400, bad);
    });

    await test('sites: a gate can stand in any dimension (a modded id is kept), a bad spelling is refused', () => {
        const s = new Sites();
        assert.strictEqual(s.add({ name: 'tf', x: 1, y: 1, z: 1, purpose: 'portal', dim: TF }).dim, TF);
        assert.strictEqual(s.add({ name: 'ne', x: 2, y: 1, z: 1, purpose: 'portal', dim: 'minecraft:the_nether' }).dim, 'nether');
        throws(() => s.add({ name: 'bad', x: 3, y: 1, z: 1, purpose: 'portal', dim: 'a:../b' }), /dim:/);
    });

    await test('layout: the allowed heights are those of the dimension', () => {
        const base = { kind: 'floor', block: 'cobblestone', x0: 0, z0: 0, x1: 3, z1: 3 };
        assert.ok(layout({ ...base, y: -64 }), 'overworld -64'); throws(() => layout({ ...base, y: -65 }), /between y -64 and y 319 in overworld/);
        assert.ok(layout({ ...base, y: 255, dim: 'nether' })); throws(() => layout({ ...base, y: 256, dim: 'nether' }), /between y 0 and y 255 in nether/);
        throws(() => layout({ ...base, y: -1, dim: 'end' }), /in end/);
        throws(() => layout({ ...base, y: -5, dim: TF }), /in twilightforest:twilight_forest/);
        assert.ok(layout({ ...base, y: -5, dim: TF, limits: { minY: -64, height: 384 } }));
        throws(() => layout({ ...base, y: 5, dim: 'mars' }), /dim:/);
    });

    // --- the service ---
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
    const given = [], made = [];
    const fakeBot = (name) => {
        const b = new EventEmitter();
        Object.assign(b, { username: name, game: { dimension: 'minecraft:overworld', minY: -64, height: 384 }, entity: { position: { x: 0, y: 70, z: 0 }, onGround: true }, health: 20, food: 20, inventory: { items: () => [], emptySlotCount: () => 20 } });
        b.quit = () => b.emit('end', 'quit');
        return b;
    };
    const factory = (name) => { const b = fakeBot(name); made.push(b); setTimeout(() => b.emit('spawn'), 5); return b; };
    const envFactory = (bot) => ({
        w: { kindAt: () => 'air', nameAt: () => 'air' }, now: Date.now, pause: () => sleep(1), dispose() {},
        dimension: () => D.canon(bot.game.dimension) || bot.game.dimension, here: () => ({ x: 0, y: 70, z: 0 }),
        exec: async () => ({ ok: true }), travel: async () => ({ ok: true, legs: 1 }), have: () => 0, inv: () => ({ items: [], slotsFree: 30 }), pos: () => ({ x: 0, z: 0 }),
    });
    // The server: `execute in <dimension> run tp <bot> ...` moves the bot into that dimension.
    const rconCommand = async (c) => {
        given.push(c);
        const m = /^execute in (\S+) run tp (\w+) /.exec(c);
        if (m) { const b = made.find((x) => x.username === m[2]); if (b) b.game.dimension = m[1]; return `Teleported ${m[2]} to 1.5, 70.0, 2.5`; }
        return 'ok';
    };
    const svc = new WorkService({ dataDir: dir, factory, envFactory, reconnectMs: 20, rcon: { command: rconCommand } });
    svc.addBot('Work1'); await until(() => svc.status().bots[0].state === 'online');
    const rejects = (p, re) => assert.rejects(Promise.resolve(p), (e) => { assert.strictEqual(e.status, 400, `${e.status}: ${e.message}`); assert.match(e.message, re); return true; });

    await test('pit jobs: limits per dimension, the dimension is kept in the spec, and boxes in different dimensions do not overlap', async () => {
        const box = { x0: 0, x1: 15, z0: 0, z1: 15, top: 120, bottom: 100 };
        const n = svc.createPit({ box, dim: 'minecraft:the_nether', lanes: 1 });
        assert.strictEqual(svc.jobs.get(n.id).spec.dim, 'nether');
        const o = svc.createPit({ box, lanes: 1 });                        // the same box in the overworld: another dimension, no clash
        assert.strictEqual(svc.jobs.get(o.id).spec.dim, 'overworld');
        assert.throws(() => svc.createPit({ box, dim: 'nether', lanes: 1 }), (e) => e.status === 409 && /overlaps job/.test(e.message));
        assert.throws(() => svc.createPit({ box: { ...box, top: 300 }, dim: 'nether', lanes: 1 }), (e) => /between 0 and 255 in nether/.test(e.message));
        assert.doesNotThrow(() => svc.createPit({ box: { ...box, top: 300, x0: 100, x1: 110 }, lanes: 1 }));
        assert.throws(() => svc.createPit({ box, dim: 'mars', lanes: 1 }), (e) => /dim:/.test(e.message));
        const t = svc.createPit({ box: { x0: 0, x1: 3, z0: 0, z1: 3, top: 60, bottom: 50 }, dim: TF, lanes: 1 });
        assert.strictEqual(svc.jobs.get(t.id).spec.limits, undefined, 'no bot is in that dimension yet: nothing learned');
        assert.throws(() => svc.createPit({ box: { x0: 9, x1: 12, z0: 9, z1: 12, top: 10, bottom: -10 }, dim: TF, lanes: 1 }), (e) => /between 0 and 255/.test(e.message));
        made[0].game.dimension = TF; made[0].game.minY = -64; made[0].game.height = 384;       // now a bot has been there and told us
        const t2 = svc.createPit({ box: { x0: 9, x1: 12, z0: 9, z1: 12, top: 10, bottom: -10 }, dim: TF, lanes: 1 });
        assert.deepStrictEqual(svc.jobs.get(t2.id).spec.limits, { minY: -64, height: 384 });
        made[0].game.dimension = 'minecraft:overworld';
    });

    await test('layout jobs and previews in another dimension', async () => {
        const spec = { kind: 'floor', block: 'cobblestone', x0: 0, z0: 0, x1: 3, z1: 3, y: 90, dim: 'end' };
        const p = svc.previewLayout(spec); assert.strictEqual(p.ok, true, JSON.stringify(p));
        const bad = svc.previewLayout({ ...spec, y: 300 }); assert.strictEqual(bad.ok, false); assert.match(bad.why, /between y 0 and y 255 in end/);
        const j = await svc.createLayout(spec); assert.strictEqual(svc.jobs.get(j.id).spec.dim, 'end');
        await rejects(svc.createLayout({ ...spec, y: 300 }), /in end/);
        const j2 = await svc.createLayout({ ...spec, dim: undefined }); assert.strictEqual(svc.jobs.get(j2.id).spec.dim, 'overworld', 'same cells in the overworld: no clash');
    });

    await test('checkRange and dimensionsList: the console answers what a range is and which dimensions it knows of', () => {
        const r = svc.checkRange({ dim: 'overworld', x0: 800, x1: 810, z0: 80, z1: 90, y0: 60, y1: 70 });
        assert.deepStrictEqual([r.range.x0, r.range.y1, r.limits.minY, r.limits.maxY], [800, 70, -64, 319]);
        assert.deepStrictEqual([r.twin.dim, r.twin.x, r.twin.z, r.twin.exact], ['nether', 100, 10, true]);
        assert.strictEqual(svc.checkRange({ dim: TF, x0: 0, x1: 1, z0: 0, z1: 1 }).twin, null);
        assert.throws(() => svc.checkRange({ dim: 'nether', x0: 0, x1: 1, z0: 0, z1: 1, y0: 0, y1: 999 }), (e) => e.status === 400 && /between 0 and 255/.test(e.message));
        assert.throws(() => svc.checkRange(null), (e) => e.status === 400);
        made[0].game.dimension = TF;
        const names = svc.dimensionsList().dimensions.map((d) => d.name);
        assert.deepStrictEqual(names.slice(0, 3), ['overworld', 'nether', 'end']); assert.ok(names.includes(TF), 'a dimension a bot is in is listed');
        assert.strictEqual(svc.dimensionsList().dimensions.find((d) => d.name === TF).known, false);
        made[0].game.dimension = 'minecraft:overworld';
    });

    await test('catalog: the new commands are there with closed argument lists', () => {
        const c = Object.fromEntries(catalog().map((x) => [x.name, x]));
        for (const n of ['bridge', 'trades', 'trade', 'break_bedrock', 'journey', 'teleport']) assert.ok(c[n], n);
        assert.ok(c.journey.args.some((a) => a.name === 'viaServer')); assert.ok(c.teleport.args.some((a) => a.name === 'dim'));
        assert.deepStrictEqual(c.bridge.args.map((a) => a.name), ['x', 'y', 'z', 'job', 'item']);
    });

    await test('journey: a modded dimension is accepted; with no gate it is refused unless the server may do it, then the server puts the bot there at the given y', async () => {
        const send = (command, args) => svc.runCommand({ bots: ['Work1'], command, args });
        const wait = async () => { await until(() => svc.bots.get('Work1').cmd.status !== 'running'); return svc.bots.get('Work1').cmd; };
        let r = await send('journey', { x: 10, z: 20, y: 70, dim: 'mars' }); assert.strictEqual(r.refused.length, 1); assert.match(r.refused[0].why, /dim:/);
        r = await send('journey', { x: 10, z: 20, y: 999, dim: 'nether' }); assert.match(r.refused[0].why, /outside nether/);
        r = await send('journey', { x: 10, z: 20, y: 70, dim: TF }); assert.strictEqual(r.started.length, 1);
        let c = await wait(); assert.strictEqual(c.status, 'failed'); assert.match(c.result.detail, /by the server/);
        assert.deepStrictEqual(given.filter((g) => /^execute/.test(g)), [], 'nothing was sent to the server without viaServer');
        r = await send('journey', { x: 10, z: 20, dim: TF, viaServer: true }); c = await wait();
        assert.strictEqual(c.status, 'failed'); assert.match(c.result.detail, /needs y/);
        r = await send('journey', { x: 10, z: 20, y: 70, dim: TF, viaServer: true }); c = await wait();
        assert.strictEqual(c.status, 'ok', JSON.stringify(c.result));
        assert.deepStrictEqual(given.filter((g) => /^execute/.test(g)), [`execute in ${TF} run tp Work1 10.5 70 20.5`]);
        assert.strictEqual(svc.bots.get('Work1').inDim, TF);
        // The dimension watch does not send it back: the operator sent it there.
        given.length = 0; svc.jobs.set('jx', { id: 'jx', state: 'running', spec: { depot: { kind: 'chest', x: 1, y: 64, z: 1 }, box: { x0: 0, x1: 1, z0: 0, z1: 1, top: 1, bottom: 0 } }, bots: new Set() });
        svc._watchDimension(); await sleep(20); assert.deepStrictEqual(given, [], 'the bot may stay');
        svc.bots.get('Work1').inDim = null; svc._watchDimension(); await sleep(20); assert.ok(given.some((g) => /execute in minecraft:overworld run tp Work1/.test(g)), 'without the operator\'s word it is sent back');
        svc.jobs.delete('jx');
        // A job in its dimension also keeps the bot there.
        made[0].game.dimension = 'minecraft:the_nether'; svc.bots.get('Work1').dimTry = 0; given.length = 0;
        svc.jobs.set('jn', { id: 'jn', state: 'running', spec: { dim: 'nether', box: { x0: 0, x1: 1, z0: 0, z1: 1, top: 1, bottom: 0 } }, bots: new Set() }); svc.bots.get('Work1').job = 'jn';
        svc._watchDimension(); await sleep(20); assert.deepStrictEqual(given, [], 'a bot of a Nether job may be in the Nether');
        svc.bots.get('Work1').job = null; svc.jobs.delete('jn'); made[0].game.dimension = 'minecraft:overworld';
    });

    await test('teleport: into another dimension with x, y, z only, checked against its limits', async () => {
        const send = (args) => svc.runCommand({ bots: ['Work1'], command: 'teleport', args });
        let r = await send({ player: 'Seia_Y', dim: 'end' }); assert.match(r.refused[0].why, /dim goes with x, y, z/);
        r = await send({ x: 1, y: 300, z: 1, dim: 'end' }); assert.match(r.refused[0].why, /outside end/);
        given.length = 0; r = await send({ x: 100, y: 50, z: 0, dim: 'end' }); assert.strictEqual(r.started.length, 1);
        await until(() => svc.bots.get('Work1').cmd.status !== 'running'); assert.strictEqual(svc.bots.get('Work1').cmd.status, 'ok');
        assert.deepStrictEqual(given, ['execute in minecraft:the_end run tp Work1 100 50 0']); assert.strictEqual(svc.bots.get('Work1').inDim, 'end');
        made[0].game.dimension = 'minecraft:overworld';
    });

    await test('a job in another dimension: the bot is taken there first, at the middle of the pit and one above its top level', async () => {
        const j = svc.createPit({ box: { x0: 200, x1: 215, z0: 200, z1: 215, top: 110, bottom: 100 }, dim: 'nether', lanes: 1 });
        given.length = 0; made[0].game.dimension = 'minecraft:overworld';
        const r = await svc._enterDim(svc.bots.get('Work1'), { cancelled: false }, svc.jobs.get(j.id), 'nether');
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(given, ['execute in minecraft:the_nether run tp Work1 207.5 111 207.5']);
        made[0].game.dimension = 'minecraft:overworld';
    });

    await svc.stop();
    console.log('\nwork dimensions: all tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

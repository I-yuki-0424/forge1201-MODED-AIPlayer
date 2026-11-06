// The work service (src/work/service.js) without a server: fake bots and a fake action layer. Roster limits and names, a pit job
// run by three bots to the end, a bot that disconnects and comes back, a build job from the structure library, the repair pass,
// persistence (jobs come back paused), overlap guard, validation, RCON helpers with injection attempts, structure editing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { WorkService, normalizeBox } = require('../src/work/service');
const bp = require('../src/work/jobs/blueprint');
const build = require('../src/work/jobs/build');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await sleep(20); } }
const rejects = (p, status, re) => assert.rejects(Promise.resolve(p), (e) => { assert.strictEqual(e.status, status, `status ${e.status}: ${e.message}`); if (re) assert.match(e.message, re); return true; });
const throwsP = (fn, status, re) => { try { fn(); } catch (e) { assert.strictEqual(e.status, status, `status ${e.status}: ${e.message}`); if (re) assert.match(e.message, re); return; } assert.fail('did not throw'); };

/** A world the fake commands act on: stone up to `ground`, air above; `mine` opens a cell, `place` fills it. */
function makeWorld(ground) {
    const m = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    return { nameAt, kindAt: (x, y, z) => (nameAt(x, y, z) === 'air' ? 'air' : 'solid'), set: (x, y, z, n) => m.set(key(x, y, z), n), m };
}
function fakeBot(name) {
    const b = new EventEmitter();
    Object.assign(b, { username: name, entity: { position: { x: 0, y: 70, z: 0 } }, health: 20, food: 20, inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }], emptySlotCount: () => 20 } });
    b.quit = () => { b.quit.called = true; b.emit('end', 'quit'); };
    return b;
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
    const world = makeWorld(100), made = [], delay = { ms: 0 };
    const factory = (name) => { const b = fakeBot(name); made.push(b); setTimeout(() => b.emit('spawn'), 5); return b; };
    const envFactory = (bot) => ({
        w: world, now: Date.now, pause: () => sleep(1),
        exec: async (cmd, a) => { if (delay.ms) await sleep(delay.ms); if (cmd === 'mine') world.set(a.x, a.y, a.z, 'air'); else if (cmd === 'place') world.set(a.x, a.y, a.z, a.item); return { ok: true }; },
        have: () => 999, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 101, z: 0 }), pos: () => ({ x: bot.entity.position.x, z: bot.entity.position.z }),
    });
    const given = [];
    const mk = (extra = {}) => new WorkService({ dataDir: dir, factory, envFactory, reconnectMs: 20, rcon: { command: async (c) => { given.push(c); return c.startsWith('list') ? 'There are 2 of a max of 20 players online: Seia_Y, Work1' : c.includes('Pos') ? 'Seia_Y has the following entity data: [12.5d, 70.0d, -30.2d]' : c.includes('Dimension') ? 'has: "minecraft:overworld"' : 'ok'; } }, ...extra });
    let svc = mk();

    await test('roster: names are validated, duplicates and the limit refused, remove frees the name', async () => {
        for (const bad of ['ab', 'has space', 'x'.repeat(17), 'a;b_c', '', 'a/b/c']) throwsP(() => svc.addBot(bad), 400);
        svc.addBot('Work1'); throwsP(() => svc.addBot('Work1'), 409);
        const small = new WorkService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), factory, envFactory, maxBots: 2 });
        small.addBot('Aaa'); small.addBot('Bbb'); throwsP(() => small.addBot('Ccc'), 409, /at most 2/);
        await small.stop();
        await until(() => svc.status().bots[0].state === 'online');
        svc.removeBot('Work1');
        assert.strictEqual(made[0].quit.called, true);
        assert.strictEqual(svc.status().bots.length, 0);
        throwsP(() => svc.removeBot('Work1'), 404);
        svc.addBot('Work1'); svc.addBot('Work2'); svc.addBot('Work3');
        await until(() => svc.status().bots.every((b) => b.state === 'online'));
    });

    await test('pit: boxes are normalised and bounded; three bots dig it to the end; bots are released', async () => {
        assert.deepStrictEqual(normalizeBox({ x0: 40, z0: 30, x1: 10, z1: 5, top: 90, bottom: 95 }), { x0: 10, z0: 5, x1: 40, z1: 30, top: 95, bottom: 90 });
        throwsP(() => svc.createPit({ box: { x0: 0, z0: 0, x1: 300, z1: 5, top: 90, bottom: 80 } }), 400, /per side/);
        throwsP(() => svc.createPit({ box: { x0: 0, z0: 0, x1: 5, z1: 5, top: 90, bottom: -100 } }), 400, /y must be/);
        throwsP(() => svc.createPit({ box: { x0: 0.5, z0: 0, x1: 5, z1: 5, top: 90, bottom: 80 } }), 400, /integer/);
        throwsP(() => svc.createPit({ method: 'rows', box: { x0: 0, z0: 0, x1: 3, z1: 3, top: 100, bottom: 60 } }), 400, /haul road/);       // deeper than the edge is long (a road is kept in the rows method)
        throwsP(() => svc.createPit({ method: 'spiral', box: { x0: 0, z0: 0, x1: 3, z1: 3, top: 100, bottom: 99 } }), 400, /method/);
        { const deep = svc.createPit({ box: { x0: 0, z0: 0, x1: 3, z1: 3, top: 100, bottom: 60 } }); assert.strictEqual(deep.spec ? deep.spec.method : 'sweep', 'sweep', 'sweep is the default and keeps no road'); svc.deleteJob(deep.id); }
        const v = svc.createPit({ name: 'test pit', box: { x0: 0, z0: 0, x1: 20, z1: 9, top: 100, bottom: 98 }, bots: ['Work1', 'Work2', 'Work3'], start: true });
        assert.strictEqual(v.state, 'running');
        throwsP(() => svc.createPit({ box: { x0: 5, z0: 5, x1: 8, z1: 8, top: 100, bottom: 99 } }), 409, /overlaps/);
        const j = svc.jobs.get(v.id);
        await until(() => j.state === 'finished');
        const p = svc.jobDetail(v.id);
        assert.strictEqual(p.progress.done, p.progress.total); assert.strictEqual(p.progress.stuck, 0);
        assert.ok(Object.values(p.report.bots).filter((b) => b.done > 0).length >= 2, 'work was shared');
        assert.ok(svc.status().bots.every((b) => !b.job && !b.working), 'bots released');
        assert.strictEqual(world.nameAt(10, 100, 5), 'air'); assert.strictEqual(world.nameAt(10, 97, 5), 'stone');
        svc.deleteJob(v.id);
    });

    await test('a bot that disconnects mid-job comes back by itself and the job still finishes', async () => {
        delay.ms = 2;
        const v = svc.createPit({ box: { x0: 100, z0: 100, x1: 131, z1: 115, top: 100, bottom: 99 }, bots: ['Work1', 'Work2'], start: true });
        await until(() => svc.jobs.get(v.id).impl.ledger.progress().done > 20);
        const first = made.filter((b) => b.username === 'Work1').pop();
        first.emit('end', 'timeout');                                                  // the server restarted under the bot
        assert.strictEqual(svc.status().bots.find((b) => b.name === 'Work1').state, 'offline');
        await until(() => svc.jobs.get(v.id).state === 'finished');
        assert.ok(made.filter((b) => b.username === 'Work1').length >= 2, 'reconnected with a new bot object');
        assert.strictEqual(svc.jobDetail(v.id).progress.stuck, 0);
        delay.ms = 0;
        svc.deleteJob(v.id);
    });

    await test('pause keeps the progress, start continues, cancel releases the bots', async () => {
        delay.ms = 5;
        const v = svc.createPit({ box: { x0: 200, z0: 200, x1: 231, z1: 215, top: 100, bottom: 99 }, bots: ['Work1'], start: true });
        await until(() => svc.jobs.get(v.id).impl.ledger.progress().done >= 3);
        svc.pauseJob(v.id);
        await until(() => !svc.bots.get('Work1').worker);
        const at = svc.jobs.get(v.id).impl.ledger.progress().done;
        await sleep(100);
        assert.strictEqual(svc.jobs.get(v.id).impl.ledger.progress().done, at, 'nothing moves while paused');
        svc.startJob(v.id);
        await until(() => svc.jobs.get(v.id).impl.ledger.progress().done > at);
        svc.cancelJob(v.id);
        await until(() => !svc.bots.get('Work1').worker);
        assert.strictEqual(svc.bots.get('Work1').job, null);
        throwsP(() => svc.startJob(v.id), 409);
        delay.ms = 0; svc.deleteJob(v.id);
    });

    await test('structures: upload (normalised), edit into a new part, merge parts, refuse bad input', async () => {
        throwsP(() => svc._file('../etc/passwd'), 400); throwsP(() => svc._file('A B'), 400);
        await rejects(svc.putStructure('junk', Buffer.from('definitely not nbt data')), 400);
        const wall = bp.fill(bp.empty(5, 3, 1), { x0: 0, y0: 0, z0: 0, x1: 4, y1: 2, z1: 0 }, 'oak_planks');
        const info = await svc.putStructure('wall', bp.write(wall));
        assert.strictEqual(info.blocks, 15);
        await rejects(svc.putStructure('wall', bp.write(wall)), 409);
        const e = await svc.editStructure('wall', [{ op: 'replace', from: 'oak_planks', to: 'stone_bricks' }, { op: 'rotate', turns: 1 }], 'wall_stone');
        assert.deepStrictEqual(e.size, [1, 3, 5]);
        const room = await svc.editStructure('wall', [{ op: 'merge', parts: [{ name: 'wall', x: 0, y: 0, z: 4 }, { name: 'wall_stone', x: 0, y: 0, z: 0 }] }], 'room');
        assert.deepStrictEqual(room.size, [5, 3, 5]);
        await rejects(svc.editStructure('wall', [{ op: 'rotate', turns: 1 }], null), 400, /new name/);
        await rejects(svc.editStructure('wall', [{ op: 'explode' }], 'x1'), 400, /unknown step/);
        await rejects(svc.editStructure('nope', [], 'x2'), 404);
        const g = await svc.generate('house', { w: 7, d: 7, h: 4 }, 'house7');
        assert.ok(g.blocks > 100);
        assert.ok((await svc.listStructures()).map((s) => s.name).includes('room'));
        const layer = await svc.structureLayer('house7', 0); assert.strictEqual(layer.grid.length, 49);
    });

    await test('build: a stored structure becomes a job on a copy, bots place it, the diff against the world is empty', async () => {
        const known = (n) => !n.startsWith('create:');
        svc.known = known;
        const rock = bp.fill(bp.empty(2, 1, 2), { x0: 0, y0: 0, z0: 0, x1: 1, y1: 0, z1: 1 }, 'create:cogwheel');
        await svc.putStructure('cogs', bp.write(rock));
        await rejects(svc.createBuild({ structure: 'cogs', origin: { x: 0, y: 101, z: 0 } }), 400, /nothing the bots can place/);      // not in this registry
        const v = await svc.createBuild({ structure: 'house7', origin: { x: 300, y: 101, z: 300 }, ops: [{ op: 'rotate', turns: 1 }], bots: ['Work1', 'Work2'], start: true });
        assert.ok(v.summary.count > 100 && v.summary.materials.oak_planks > 0);
        await until(() => svc.jobs.get(v.id).state === 'finished');
        assert.strictEqual(svc.jobs.get(v.id).diff, null, 'diff needs a real bot world: fakes have none');
        assert.strictEqual(world.nameAt(300, 101, 300), 'cobblestone');
        const miss = svc.jobs.get(v.id).impl.diff(world);
        assert.strictEqual(miss.filter((c) => !/door/.test(c.block)).length, 0, JSON.stringify(miss.slice(0, 3)));
        fs.rmSync(path.join(dir, 'structures', 'house7.nbt'));                           // the job holds its own copy
        assert.ok(fs.existsSync(path.join(dir, 'jobs', `${v.id}.nbt`)));
        svc.known = null;
    });

    await test('RCON helpers: positions parsed, names and items validated before anything reaches the console', async () => {
        const pl = await svc.players();
        assert.deepStrictEqual(pl.map((p) => [p.name, p.bot, p.pos]), [['Seia_Y', false, { x: 12, y: 70, z: -31 }], ['Work1', true, { x: 12, y: 70, z: -31 }]]);
        given.length = 0;
        const r = await svc.kitBot('Work2');                                              // the fake inventory has one pickaxe: kit gives a few
        assert.ok(r.given.some((g) => g.startsWith('iron_pickaxe')));
        assert.ok(given.every((c) => /^give Work2 minecraft:[a-z_]+ \d+$/.test(c)), given.join('|'));
        await rejects(svc.kitBot('Work2; op Evil'), 404); await rejects(svc.kitBot('Nobody'), 404);
        const bad = new WorkService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), factory, envFactory, kit: { 'stone; op Evil': { min: 5, give: 1 } }, rcon: { command: async (c) => { given.push(c); return ''; } } });
        bad.addBot('Kitty'); await until(() => bad.status().bots[0].state === 'online');
        given.length = 0; await rejects(bad.kitBot('Kitty'), 400, /kit item/); assert.deepStrictEqual(given, []);
        await bad.stop();
        const norcon = new WorkService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), factory, envFactory });
        await rejects(norcon.players(), 503); await norcon.stop();
    });

    await test('a bot that runs out of an item retires with the item named, the job says it is blocked; give + Resume continues; auto-kit restocks by itself', async () => {
        const stock = {}, cmds = [];
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
        const w2 = makeWorld(100);
        const s2 = new WorkService({
            dataDir: dir2, factory, reconnectMs: 20,
            envFactory: (bot) => ({
                w: w2, now: Date.now, pause: () => sleep(1), have: (i) => stock[i] || 0, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 101, z: 0 }), pos: () => ({ x: 0, z: 0 }),
                exec: async (cmd, a) => { if (cmd === 'place') { w2.set(a.x, a.y, a.z, a.item); } else if (cmd === 'mine') w2.set(a.x, a.y, a.z, 'air'); return { ok: true }; },
            }),
            rcon: { command: async (c) => { cmds.push(c); const m = /^give (\w+) (?:minecraft:)?([a-z_]+) (\d+)$/.exec(c); if (m) stock[m[2]] = (stock[m[2]] || 0) + Number(m[3]); return 'ok'; } },
        });
        await s2.putStructure('slab', bp.write(bp.fill(bp.empty(8, 1, 4), { x0: 0, y0: 0, z0: 0, x1: 7, y1: 0, z1: 3 }, 'oak_planks')));
        s2.addBot('Hungry'); await until(() => s2.status().bots[0].state === 'online');
        const v = await s2.createBuild({ structure: 'slab', origin: { x: 0, y: 101, z: 0 }, bots: ['Hungry'], start: true });
        await until(() => s2.bots.get('Hungry').retired);
        assert.match(s2.bots.get('Hungry').retired, /waiting for oak_planks/);
        await until(() => s2.jobDetail(v.id).blocked);
        assert.match(s2.jobDetail(v.id).blocked, /Hungry waiting for oak_planks/);
        const before = s2.jobs.get(v.id).impl.ledger.progress().done;
        await s2.rcon('give Hungry minecraft:oak_planks 64'); s2.resumeBot('Hungry');
        await until(() => s2.jobs.get(v.id).state === 'finished');
        assert.ok(s2.jobs.get(v.id).impl.ledger.progress().done > before);
        assert.strictEqual(s2.jobs.get(v.id).diff, null);
        // the same again with auto-kit: nobody retires, the restock is exactly the missing item
        for (const k of Object.keys(stock)) delete stock[k]; cmds.length = 0;
        s2.setSettings({ autoKit: true }); w2.m.clear();
        const v2 = await s2.createBuild({ structure: 'slab', origin: { x: 0, y: 101, z: 0 }, bots: ['Hungry'], start: true });
        await until(() => s2.jobs.get(v2.id).state === 'finished');
        assert.ok(cmds.some((c) => c === 'give Hungry minecraft:oak_planks 128'), cmds.join('|'));
        assert.strictEqual(s2.bots.get('Hungry').retired, null);
        throwsP(() => s2.resumeBot('Nobody'), 404);
        await s2.stop();
    });

    await test('a bot without the right tool waits (naming the tool) and goes back to work by itself when it is given one', async () => {
        const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), w3 = makeWorld(100), carried = [];
        const reg = { itemsByName: { iron_pickaxe: { id: 7, name: 'iron_pickaxe' }, wooden_pickaxe: { id: 6, name: 'wooden_pickaxe' } }, items: { 6: { name: 'wooden_pickaxe' }, 7: { name: 'iron_pickaxe' } }, blocksByName: { stone: { harvestTools: { 6: true, 7: true } } } };
        const f3 = (name) => { const b = fakeBot(name); b.registry = reg; b.inventory = { items: () => carried, emptySlotCount: () => 30 }; setTimeout(() => b.emit('spawn'), 5); return b; };
        const s3 = new WorkService({
            dataDir: dir3, factory: f3, reconnectMs: 20,
            envFactory: () => ({ w: w3, now: Date.now, pause: () => sleep(1), have: () => 99, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 101, z: 0 }), pos: () => ({ x: 0, z: 0 }),
                exec: async (cmd, a) => { if (cmd === 'mine') { if (!carried.length) return { ok: false, reason: 'missing_tool', detail: { block: 'stone' } }; w3.set(a.x, a.y, a.z, 'air'); } return { ok: true }; } }),
        });
        s3.addBot('Barehand'); await until(() => s3.status().bots[0].state === 'online');
        const v = s3.createPit({ box: { x0: 0, z0: 0, x1: 7, z1: 3, top: 100, bottom: 100 }, bots: ['Barehand'], start: true });
        await until(() => s3.bots.get('Barehand').retired);
        assert.match(s3.bots.get('Barehand').retired, /waiting for a pickaxe .*stone.*Inventory/);
        await until(() => s3.jobDetail(v.id).blocked);
        carried.push({ name: 'iron_pickaxe', count: 1 });                                  // the operator hands one over
        await until(() => s3.jobs.get(v.id).state === 'finished', 12000);
        assert.strictEqual(s3.bots.get('Barehand').retired, null);
        await s3.stop();
    });

    await test('a bot that keeps failing (after fixes and waits) cools down and comes back by itself; lanes are one X-Z range per bot', async () => {
        const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), w4 = makeWorld(100), flag = { heal: false }, fixes = [];
        const s4 = new WorkService({
            dataDir: dir4, factory, reconnectMs: 20, coolMs: 120, repairMs: 50, backoff: () => 1,
            envFactory: () => ({ w: w4, now: Date.now, pause: () => sleep(1), have: () => 99, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 101, z: 0 }), pos: () => ({ x: 0, z: 0 }),
                recover: async (lvl) => { fixes.push(lvl); }, rememberGood: () => {},
                exec: async (cmd, a) => { if (cmd === 'mine') { if (!flag.heal) return { ok: false, reason: 'unreachable', detail: { why: 'no path' } }; w4.set(a.x, a.y, a.z, 'air'); } return { ok: true }; } }),
        });
        s4.addBot('Flaky1'); s4.addBot('Flaky2'); await until(() => s4.status().bots.every((b) => b.state === 'online'));
        const v = s4.createPit({ box: { x0: 0, z0: 0, x1: 15, z1: 15, top: 100, bottom: 99 }, bots: ['Flaky1', 'Flaky2'], start: true });
        assert.strictEqual(v.lanes, 2, 'two bots, two lanes'); assert.strictEqual(s4.jobs.get(v.id).impl.plan.regions.length, 2);
        await until(() => s4.bots.get('Flaky1').retired && /cooling down/.test(s4.bots.get('Flaky1').retired), 20000);
        assert.ok(fixes.includes(2) && fixes.includes(3) && fixes.includes(4), 'the fix ladder ran: ' + [...new Set(fixes)].join(','));
        flag.heal = true;                                                                  // the world calms down
        await until(() => s4.jobs.get(v.id).state === 'finished', 30000);
        assert.strictEqual(s4.bots.get('Flaky1').retired, null); assert.strictEqual(s4.jobDetail(v.id).progress.stuck, 0, 'repair passes brought the stuck units back');
        await s4.stop();
    });

    await test('persistence: roster and jobs come back, jobs paused; a finished job stays finished', async () => {
        const v = svc.createPit({ name: 'keep me', box: { x0: 400, z0: 400, x1: 431, z1: 415, top: 100, bottom: 99 }, bots: ['Work1'] });
        svc.save(); await svc.stop();
        const again = mk(); await again.restore();
        assert.deepStrictEqual(again.status().bots.map((b) => b.name).sort(), ['Work1', 'Work2', 'Work3']);
        assert.strictEqual(again.jobs.get(v.id).state, 'paused'); assert.strictEqual(again.jobs.get(v.id).name, 'keep me');
        assert.ok([...again.jobs.values()].some((j) => j.kind === 'build'), 'build job restored from its own copy');
        const id = again.createPit({ box: { x0: 600, z0: 600, x1: 603, z1: 603, top: 100, bottom: 100 } }).id;
        assert.notStrictEqual(id, v.id, 'ids are not reused after a restart');
        await again.stop();
    });

    await test('v5: settings reach the bots, tools show their durability, sites and scripts through the service, Leave pit, durability in the inventory view', async () => {
        const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), w2 = makeWorld(100), bots2 = [];
        const f2 = (name) => { const b = fakeBot(name); b.registry = { itemsByName: { iron_pickaxe: { maxDurability: 250 } } };
            const pick = { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 4 }, fresh = { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 40 };
            b.inventory = { items: () => [pick, fresh], emptySlotCount: () => 20, slots: [null, null, null, null, null, null, null, null, null, pick] }; bots2.push(b); setTimeout(() => b.emit('spawn'), 5); return b; };
        const calls = [];
        const e2 = (bot) => ({ w: w2, now: Date.now, pause: () => sleep(1), exec: async (c, a) => { calls.push([c, a]); return { ok: true }; }, have: () => 5, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 70, z: 0 }), pos: () => ({ x: 0, z: 0 }), configure: (o) => { bot.__cfg = o; } });
        const s2 = new WorkService({ dataDir: d2, factory: f2, envFactory: e2, reconnectMs: 20 });
        s2.addBot('Work1'); await until(() => s2.status().bots[0].state === 'online');
        assert.deepStrictEqual([s2.settings.retireWorn, s2.settings.scripts], [true, true], 'worn-tool rule and recovery scripts are on by default');
        s2.setSettings({ retireWorn: false }); assert.strictEqual(bots2[0].__skillOpts.retireWorn, false, 'the switch reaches a bot that is connected');
        s2.setSettings({ retireWorn: true });
        let v = s2.status().bots[0]; assert.deepStrictEqual(v.tools.map((t) => [t.left, t.worn]), [[246, false], [210, false]], 'durability listed; the rule is configured on the bot only when its worker starts, so nothing is worn yet');
        require('../src/skills/options').configure(bots2[0], { retireWorn: true });
        v = s2.status().bots[0]; assert.deepStrictEqual(v.tools.map((t) => [t.left, t.worn]), [[246, false], [210, false]]);
        bots2[0].inventory.items()[0].durabilityUsed = 245; v = s2.status().bots[0]; assert.strictEqual(v.tools[0].worn, true, '5 uses left is worn (<= 8)');
        // sites and scripts
        throwsP(() => s2.addSite({ name: 'a', x: 1, y: 2, z: 3, tags: ['wood'] }), 400, /unknown tag/); throwsP(() => s2.addSite({ name: 'a', x: 1, y: 2, z: 3, tags: [] }), 400);
        s2.addSite({ name: 'tools1', x: 5, y: 64, z: 5, tags: ['tools'] }); assert.strictEqual(s2.listSites().sites.length, 1); assert.ok(s2.listSites().tags.ore);
        throwsP(() => s2.removeSite('nope'), 404);
        throwsP(() => s2.putScript({ name: 'bad', steps: [{ cmd: 'rm' }] }), 400, /unknown command/); throwsP(() => s2.putScript({ name: 'replace-tool', steps: [] }), 400, /built-in/);
        s2.putScript({ name: 'hello', steps: [{ log: 'hi' }, { return: 'ok' }] }); assert.ok(s2.listScripts().some((x) => x.name === 'hello' && !x.builtIn) && s2.listScripts().some((x) => x.name === 'replace-tool' && x.builtIn));
        const ran = await s2.runScript('Work1', 'hello'); assert.ok(ran.ok && ran.log.includes('hi'));
        await rejects(s2.runScript('Work1', 'nope'), 404); await rejects(s2.runScript('Nobody', 'hello'), 404);
        s2.save(); const s3 = new WorkService({ dataDir: d2, factory: f2, envFactory: e2 }); await s3.restore();
        assert.deepStrictEqual(s3.listSites().sites.map((x) => x.name), ['tools1'], 'sites persist'); assert.ok(s3.scripts.has('hello'), 'the operator\'s scripts persist'); await s3.stop();
        // Leave pit: needs a pit job and an idle bot
        await rejects(s2.leavePit('Work1'), 409, /no pit job/);
        const job = s2.createPit({ box: { x0: 0, z0: 0, x1: 9, z1: 9, top: 100, bottom: 98 }, bots: ['Work1'] });
        assert.strictEqual(s2.status().bots[0].inPit, true, 'inside the box and below its rim (y 70 < 100)');
        calls.length = 0; const left = await s2.leavePit('Work1'); assert.ok(left.ok, JSON.stringify(left)); assert.ok(calls.some((c) => c[0] === 'move_to'), 'it tried to walk out first');
        s2.startJob(job.id); await until(() => s2.status().bots[0].working || s2.jobs.get(job.id).state !== 'running', 2000).catch(() => {});
        // the 3 layers of the fake world may finish at once; leave while a worker runs is refused
        s2.jobs.get(job.id).state = 'running'; s2.bots.get('Work1').worker = { cancel: { cancelled: false }, job: job.id }; await rejects(s2.leavePit('Work1'), 409, /pause the job/); s2.bots.get('Work1').worker = null;
        // the inventory view: durability next to damage
        const inv = await s2.inventory({ type: 'entity', name: 'Work1' }); const slot = inv.slots.find((x) => x.id === 'minecraft:iron_pickaxe');
        assert.deepStrictEqual([slot.max, slot.damage, slot.left], [250, 245, 5], JSON.stringify(slot));
        // sweep jobs keep no road and say so; rows jobs keep one
        const sw = s2.createPit({ box: { x0: 200, z0: 200, x1: 203, z1: 203, top: 100, bottom: 99 } }); assert.deepStrictEqual([sw.spec.method, sw.spec.road], ['sweep', false]);
        const rw = s2.createPit({ method: 'rows', box: { x0: 300, z0: 300, x1: 305, z1: 305, top: 100, bottom: 99 } }); assert.deepStrictEqual([rw.spec.method, rw.spec.road], ['rows', true]);
        assert.ok(!JSON.stringify(s2.jobDetail(sw.id).regions).includes('"stations":['), 'the job detail does not carry the station list');
        await s2.stop();
    });
    await test('a bot found outside the overworld is sent back to the depot of a job, once per 15 s; the overworld is left alone', async () => {
        const sent = [];
        const s = new WorkService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), factory, envFactory, reconnectMs: 20, rcon: { command: async (c) => { sent.push(c); return 'ok'; } } });
        s.addBot('Lost'); await until(() => s.status().bots[0].state === 'online');
        const bot = s.bots.get('Lost').bot;
        s.jobs.set('jx', { id: 'jx', state: 'running', spec: { depot: { kind: 'chest', x: 217, y: 64, z: 417 }, box: { x0: 0, x1: 1, z0: 0, z1: 1, top: 1, bottom: 0 } }, bots: new Set() });
        bot.game = { dimension: 'overworld' }; s._watchDimension(); await sleep(10);
        assert.deepStrictEqual(sent.filter((c) => /run tp/.test(c)), [], 'nothing for a bot in the overworld');
        bot.game = { dimension: 'the_nether' }; s._watchDimension(); await sleep(10);
        assert.deepStrictEqual(sent.filter((c) => /run tp/.test(c)), ['execute in minecraft:overworld run tp Lost 217.5 66 417.5']);
        s._watchDimension(); await sleep(10); assert.strictEqual(sent.filter((c) => /run tp/.test(c)).length, 1, 'one try per 15 s');
        s.jobs.delete('jx'); await s.stop();
    });
    console.log('ALL OK');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

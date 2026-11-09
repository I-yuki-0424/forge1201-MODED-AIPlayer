// The owner's batch of 2026-11-09 (evening): failure memory (the same failure twice parks the unit, a failed unit is on hold), the rest of a tile is dug when one cell fails,
// the lift cap, several bots at a chest, the time accounting of the health row, bubble columns can be built over, bots picked by number. Pure tests, no server.
const assert = require('assert');
const { Ledger, failureSig } = require('../src/work/jobs/crew');
const pit = require('../src/work/jobs/pit');
const { Gates } = require('../src/work/bot/queue');
const { Health } = require('../src/work/service/health');
const { runWorker } = require('../src/work/bot/worker');
const block = require('../src/skills/commands/block');

setTimeout(() => { console.error('test watchdog: still running after 40 s'); process.exit(2); }, 40000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const keepAlive = setInterval(() => {}, 1000);          // the line's own timers are unref'd

function fakeWorld(ground = 0, init = {}) {
    const m = new Map(Object.entries(init)), key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'lava' ? 'danger' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => m.set(key(x, y, z), n), cells: m };
}

(async () => {
    await test('place: a bubble column and tall seagrass are replaceable (they ended 124 of 364 failed units in 30 min as invalid_target)', () => {
        for (const n of ['bubble_column', 'tall_seagrass', 'seagrass', 'air']) assert.ok(block.REPLACEABLE.test(n), n);
        for (const n of ['stone', 'kelp', 'water', 'chest']) assert.ok(!block.REPLACEABLE.test(n), `${n} stays refused (water needs fluid:true)`);
    });

    await test('ledger: the same failure twice parks the unit (the layer goes on); another failure does not; a failed unit is on hold, the bot is given another one', () => {
        const L = new Ledger({ maxAttempts: 10, sameLimit: 2, holdMs: 5000, lanes: true });
        L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 2, rows: 3 }); L.join('A');
        const d = { cell: { x: 1, y: 2, z: 3 }, stage: 'seal', why: 'reach placement face' };
        const c1 = L.claim('A', { x: 0, z: 0 }, 0), u1 = c1.units[0].unit;
        const f1 = L.fail('A', 'r', u1, 'unreachable', 1, d); assert.deepStrictEqual([f1.parked, f1.same, f1.held], [false, 1, true]);
        const c2 = L.claim('A', { x: 0, z: 0 }, 2); assert.notStrictEqual(c2.units[0].unit, u1, 'the unit on hold is not claimed again at once: the next one of the range is');
        L.done('A', 'r', c2.units[0].unit, 3);
        const c3 = L.claim('A', { x: 0, z: 0 }, 4); L.done('A', 'r', c3.units[0].unit, 5);
        assert.strictEqual(L.claim('A', { x: 0, z: 0 }, 6), null, 'only the held unit is left and 5 s have not passed: nothing to claim, no hammering');
        const again = L.claim('A', { x: 0, z: 0 }, 5001 + 1); assert.strictEqual(again.units[0].unit, u1, 'after the hold it is tried again');
        const f2 = L.fail('A', 'r', u1, 'unreachable', 5003, d); assert.deepStrictEqual([f2.parked, f2.why], [true, 'same_failure']);
        assert.strictEqual(L.stuck.length, 1); assert.strictEqual(L.claim('A', { x: 0, z: 0 }, 5004).units[0].layer, 1, 'a parked unit settles its layer: the bot digs on');
        // another failure each time: not the same try, so not parked after two
        const L2 = new Ledger({ maxAttempts: 10, sameLimit: 2, holdMs: 0 }); L2.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 }); L2.join('A');
        const u = L2.claim('A', { x: 0, z: 0 }, 0).units[0].unit;
        L2.fail('A', 'r', u, 'unreachable', 1, { stage: 'seal', cell: { x: 1, y: 1, z: 1 } }); const c = L2.claim('A', { x: 0, z: 0 }, 2);
        const f = L2.fail('A', 'r', c.units[0].unit, 'stuck', 3, { stage: 'mine', cell: { x: 1, y: 1, z: 1 } }); assert.strictEqual(f.parked, false);
        assert.strictEqual(failureSig('unreachable', {}), null, 'nothing to compare: never "the same"');
        // the repair pass starts clean
        L.requeueStuck(6000); assert.strictEqual(L.regions.get('r').same[u1], 0);
    });

    await test('ledger: without sameLimit and holdMs nothing changes (builds, old tests)', () => {
        const L = new Ledger({ maxAttempts: 3 }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 }); L.join('A'); L.join('B');
        const u = L.claim('A', { x: 0, z: 0 }, 0).units[0].unit; const f = L.fail('A', 'r', u, 'unreachable', 1, { stage: 's', cell: { x: 1, y: 1, z: 1 } });
        assert.strictEqual(f.parked, false); assert.ok(L.claim('B', { x: 0, z: 0 }, 1.5), 'free at once for another bot');
    });

    await test('worker: after a parked failure the bot does not wait out a backoff, it takes the next unit; the activity is reported', async () => {
        const L = new Ledger({ maxAttempts: 10, sameLimit: 2, holdMs: 1, lanes: true }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 2 });
        const seen = [], acts = []; let n = 0;
        const job = { ledger: L, runUnit: async (rid, u) => { seen.push(u.unit); return u.unit === 0 && n++ < 9 ? { ok: false, reason: 'unreachable', detail: { stage: 'seal', cell: { x: 1, y: 1, z: 1 } } } : { ok: true }; } };
        const env = { pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 0, z: 0 }), now: Date.now, exec: async () => ({ ok: true }) };
        const events = []; let waited = 0;
        const res = await runWorker(job, 'b', env, { pollMs: 2, backoff: () => { waited++; return 1; }, onEvent: (e, d) => events.push(e), act: (a) => acts.push(a) });
        assert.strictEqual(res.ended, 'finished'); assert.ok(events.includes('parked'), 'parked event'); assert.ok(seen.filter((u) => u === 0).length <= 3, `the failing unit was tried ${seen.filter((u) => u === 0).length} times: ${seen}`);
        assert.ok(acts.includes('claim') && acts.includes('unit') && acts[acts.length - 1] === null, `activities: ${acts}`);
    });

    await test('pit: one failed cell does not stop the rest of the tile; the unit fails afterwards with the first failure', async () => {
        const w = fakeWorld(60); for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) w.set(x, 64, z, 'stone');
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 3, z1: 3, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }), reg = job.plan.regions[0], mined = [];
        const env = { w, have: () => 9, exec: async (n, a) => { if (n !== 'mine') return { ok: true }; if (a.x === 1 && a.z === 1) return { ok: false, reason: 'unreachable', detail: { why: 'reach block' } }; mined.push(`${a.x},${a.z}`); w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } };
        const r = await job.runUnit(reg.id, { unit: 0, layer: 0, row: 0 }, env);
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'unreachable'); assert.deepStrictEqual([r.detail.cell.x, r.detail.cell.z], [1, 1]);
        assert.strictEqual(mined.length, 15, `the other 15 cells of the 4x4 tile were dug: ${mined.length}`); assert.strictEqual(r.detail.failedCells, 1);
        // fatal reasons end it at once
        const w2 = fakeWorld(60); w2.set(0, 64, 0, 'stone'); w2.set(1, 64, 0, 'stone');
        const j2 = pit.createPitJob({ x0: 0, z0: 0, x1: 1, z1: 0, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }); const calls = [];
        const r2 = await j2.runUnit(j2.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, { w: w2, have: () => 9, exec: async (n, a) => { calls.push(n); return { ok: false, reason: 'cancelled' }; } });
        assert.strictEqual(r2.reason, 'cancelled'); assert.strictEqual(calls.length, 1, 'cancelled is not about the cell: stop');
    });

    await test('pit: a placement that cannot be reached is tried once from a cell the server lifted the bot to; the walk to a station lifts at most twice', async () => {
        const w = fakeWorld(60, { '2,64,2': 'water' }); for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (!(x === 2 && z === 2)) w.set(x, 64, z, 'stone');
        const job = pit.createPitJob({ x0: 2, z0: 2, x1: 2, z1: 2, top: 64, bottom: 64 }, {}, { road: false }), reg = job.plan.regions[0], lifts = [], places = [];
        const env = { w, have: () => 9, lift: async (c, o) => { lifts.push(o.skipSame); return { ok: true }; },
            exec: async (n, a) => { if (n === 'place') { places.push(a.x); return places.length === 1 ? { ok: false, reason: 'unreachable', detail: { why: 'reach placement face' } } : (w.set(a.x, a.y, a.z, a.item), { ok: true }); } w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } };
        const r = await job.runUnit(reg.id, { unit: 0, layer: 0, row: 0 }, env);
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(lifts, [true], 'one lift, asked not to move a bot that already stands there'); assert.strictEqual(places.length >= 2, true);
        // a lift that never helps: never more than two per walk
        const w3 = fakeWorld(60); const j3 = pit.createPitJob({ x0: 0, z0: 0, x1: 4, z1: 4, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }); let n = 0; const here = { x: 100, y: 120, z: 100 };
        for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) w3.set(x, 64, z, 'stone');
        await j3.runUnit(j3.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, { w: w3, have: () => 9, here: () => here, lift: async () => { n++; return { ok: true, same: true }; }, exec: async () => ({ ok: false, reason: 'unreachable' }) });
        assert.ok(n <= 4, `${n} lifts: at most two for the walk to the station and one per failed cell (two cells end the unit)`);
    });

    await test('pit: a bot that is 1,500 blocks from its station (respawned at the world spawn) is sent back by the server, once or twice, never walks a corridor toward it', async () => {
        const w = fakeWorld(60); for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) w.set(x, 64, z, 'stone');
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 4, z1: 4, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }), reg = job.plan.regions[0];
        let at = { x: 1500, y: 64, z: 1500 }, sent = 0; const calls = [];
        const env = { w, have: () => 9, here: () => at, rejoin: async (S) => { sent++; at = { x: S.x, y: S.y + 1, z: S.z }; return { ok: true }; }, lift: async () => ({ ok: false, reason: 'unreachable' }),
            exec: async (n, a) => { calls.push(n); if (n === 'mine') w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } };
        const r = await job.runUnit(reg.id, { unit: 0, layer: 0, row: 0 }, env);
        assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(sent, 1); assert.strictEqual(r.detail.rejoined, 1); assert.ok(calls.includes('mine'));
        // the server knows no open cell: the unit fails at once as the bot's trouble, with nothing mined and no corridor
        const w2 = fakeWorld(60); for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) w2.set(x, 64, z, 'stone');
        const j2 = pit.createPitJob({ x0: 0, z0: 0, x1: 4, z1: 4, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }), calls2 = [];
        const r2 = await j2.runUnit(j2.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, { w: w2, have: () => 9, here: () => ({ x: 1500, y: 64, z: 1500 }), rejoin: async () => ({ ok: false, reason: 'unreachable', detail: { why: 'no open cell' } }), exec: async (n) => { calls2.push(n); return { ok: true }; } });
        assert.strictEqual(r2.ok, false); assert.strictEqual(r2.detail.botSide, true); assert.strictEqual(calls2.length, 0, 'nothing was dug');
        const L = new Ledger({ maxAttempts: 3, sameLimit: 2, holdMs: 1000 }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 }); L.join('A');
        const u = L.claim('A', { x: 0, z: 0 }, 0).units[0].unit; assert.strictEqual(L.fail('A', 'r', u, 'unreachable', 1, r2.detail), undefined, 'the unit is not charged: it is the bot that is far away');
        // sent back twice and still far (a lift that does nothing): no corridor of 1,500 blocks either
        const r3 = await j2.runUnit(j2.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, { w: w2, have: () => 9, here: () => ({ x: 300, y: 64, z: 300 }), lift: async () => ({ ok: false, reason: 'unreachable' }), rejoin: async () => ({ ok: true }), exec: async (n) => { calls2.push(n); return { ok: true }; } });
        assert.strictEqual(r3.ok, false); assert.ok(/still far/.test(r3.detail.why) && r3.detail.rejoined === 2, JSON.stringify(r3.detail));
    });

    await test('env.rejoin: the server moves the bot only where it says the cell and the one above are air; the next try is the last good place; no RCON, no move', async () => {
        const { EventEmitter } = require('events'), { botEnv } = require('../src/work/bot/env');
        const b = new EventEmitter(), cmds = [];
        Object.assign(b, { username: 'Bot', registry: { blocksByName: {}, itemsByName: {} }, entity: { position: { x: 270.5, y: 140, z: 458.5, floored: () => ({ x: 270, y: 140, z: 458 }) }, onGround: true }, blockAt: () => null, inventory: { items: () => [] } });
        const rcon = async (c) => { cmds.push(c); const m = /run tp Bot ([\d.-]+) ([\d.-]+) ([\d.-]+)/.exec(c); if (!m || /1753 141/.test(c)) return ''; b.entity.position.x = +m[1]; b.entity.position.y = +m[2]; b.entity.position.z = +m[3]; return `Teleported Bot to ${m[1]}, ${m[2]}, ${m[3]}`; };
        const e = botEnv(b, { cancel: { cancelled: false }, rcon });
        const bad = await e.rejoin({ x: 1753, y: 140, z: 1801 }); assert.strictEqual(bad.ok, false); assert.strictEqual(bad.detail.botSide, true); assert.ok(/execute if block 1753 141 1801 minecraft:air if block 1753 142 1801 minecraft:air run tp Bot/.test(cmds[0]), cmds[0]);
        const e2 = botEnv(b, { cancel: { cancelled: false }, rcon: async (c) => { cmds.push(c); const m = /run tp Bot ([\d.-]+) ([\d.-]+) ([\d.-]+)/.exec(c); b.entity.position.x = +m[1]; b.entity.position.y = +m[2]; b.entity.position.z = +m[3]; return 'Teleported'; } });
        const ok = await e2.rejoin({ x: 1753, y: 139, z: 1801 }); assert.deepStrictEqual([ok.ok, ok.to.x, ok.to.y, ok.to.z, ok.at], [true, 1753, 140, 1801, 'the station']);
        assert.strictEqual((await botEnv(b, { cancel: { cancelled: false } }).rejoin({ x: 1, y: 2, z: 3 })).reason, 'refused');
    });

    await test('pit: with nothing to seal water with the bot takes a block from the undug part of the pit (harvest) instead of waiting for a chest that is insert-only', async () => {
        const w = fakeWorld(60, { '2,64,2': 'water' }); for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (!(x === 2 && z === 2)) w.set(x, 64, z, 'stone');
        const job = pit.createPitJob({ x0: 2, z0: 2, x1: 2, z1: 2, top: 64, bottom: 64 }, {}, { road: false }), reg = job.plan.regions[0], inv = {}, asked = [];
        const env = { w, within: { x0: 0, x1: 4, z0: 0, z1: 4, top: 64, bottom: 60 }, have: (i) => inv[i] || 0,
            run: async (n, a) => { asked.push([n, a.items && a.items[0]]); inv.cobblestone = 1; return { ok: true, detail: { tried: 1, got: 'cobblestone' } }; },
            exec: async (n, a) => { if (n === 'place') { if (!inv[a.item]) return { ok: false, reason: 'missing_item' }; inv[a.item]--; w.set(a.x, a.y, a.z, a.item); return { ok: true }; } w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } };
        const r = await job.runUnit(reg.id, { unit: 0, layer: 0, row: 0 }, env);
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(asked[0], ['harvest', 'cobblestone']); assert.strictEqual(r.detail.harvested, 1);
        // outside a pit job (no box) nothing is harvested: the old failure, so the bot waits for the operator
        const w2 = fakeWorld(60, { '2,64,2': 'water' }); for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (!(x === 2 && z === 2)) w2.set(x, 64, z, 'stone');
        const j2 = pit.createPitJob({ x0: 2, z0: 2, x1: 2, z1: 2, top: 64, bottom: 64 }, {}, { road: false });
        const r2 = await j2.runUnit(j2.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, { w: w2, have: () => 0, exec: async () => ({ ok: true }) });
        assert.strictEqual(r2.reason, 'missing_item');
    });

    await test('queue: a container takes `slots` bots at a time (the others wait), the bed one; the time limit and eviction are per bot', async () => {
        const g = new Gates({ holdMs: 60000, waitMs: 60000, slotsFor: (k) => (k.startsWith('box:') ? 3 : 1) });
        const t = []; for (let i = 0; i < 5; i++) t.push(g.enter('box:1,2,3', `W${i}`));
        await new Promise((r) => setTimeout(r, 20));
        assert.deepStrictEqual(g.busy().map((b) => [b.serving, b.slots, b.line.length]), [[3, 3, 5]], 'three served, two waiting');
        const t0 = await t[0]; t0.leave(); const t3 = await t[3]; assert.ok(t3, 'the next one goes in as one leaves');
        const b = []; for (let i = 0; i < 2; i++) b.push(g.enter('bed:1,2,3', `S${i}`)); await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(g.gate('bed:1,2,3').holders.size, 1, 'a bed is for one');
        for (const x of t.slice(1)) { const tk = await Promise.race([x, new Promise((r) => setTimeout(() => r(null), 5))]); if (tk) tk.leave(); }
        for (const x of b) { const tk = await x; tk.leave(); }
    });

    await test('service: how many bots a container takes at once (a chest 3, the tools chest 2, a bed 1; the setting chestSlots changes the chests, closed 1..6)', () => {
        const fs = require('fs'), os = require('os'), path = require('path'), { WorkService } = require('../src/work/service');
        const svc = new WorkService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'slots-')), factory: () => ({}), restore: false });
        svc.sites.add({ name: 'store', x: 1, y: 2, z: 3, purpose: 'any' }); svc.sites.add({ name: 'tools', x: 4, y: 5, z: 6, purpose: 'tools' });
        assert.deepStrictEqual([svc._slotsFor('box:1,2,3'), svc._slotsFor('box:4,5,6'), svc._slotsFor('box:9,9,9'), svc._slotsFor('bed:1,2,3')], [3, 2, 3, 1]);
        svc.setSettings({ chestSlots: 5 }); assert.strictEqual(svc._slotsFor('box:1,2,3'), 5);
        for (const bad of [0, 7, 1.5, '3']) assert.throws(() => svc.setSettings({ chestSlots: bad }), /chestSlots/);
    });

    await test('health: bot time is added up per activity (a unit by phase, a line / lift / chest inside it), standing still is measured, parked units are counted', () => {
        let t = 1000; const h = new Health({ now: () => t });
        h.act('W1', 'unit'); h.phase('W1', 'plan'); t += 3000; h.phase('W1', 'walk'); t += 2000; h.sub('W1', 'line'); t += 7000; h.sub('W1', null); t += 1000; h.act('W1', 'backoff'); t += 4000;
        h.sample('W1', { x: 0, y: 0, z: 0 }); h.sample('W1', { x: 0.1, y: 0, z: 0 }); h.sample('W1', { x: 5, y: 0, z: 0 });
        h.park({ reason: 'unreachable', detail: { stage: 'seal' } });
        const { row, text } = h.flush({ bots: [{ name: 'W1', working: true, phase: 'backoff' }] });
        assert.deepStrictEqual(row.time, { 'unit:plan': 3, 'unit:walk': 3, line: 7, backoff: 4 }, JSON.stringify(row.time));
        assert.deepStrictEqual(row.still, { backoff: 2 }); assert.strictEqual(row.parked, 1); assert.ok(/time line 7, backoff 4/.test(text) && /parked 1/.test(text), text);
        // a span that crosses the window boundary is cut there and goes on in the next one
        t += 5000; const r2 = h.flush({ bots: [] }).row; assert.deepStrictEqual(r2.time, { backoff: 5 });
        h.act('W1', null); t += 5000; assert.deepStrictEqual(h.flush({ bots: [] }).row.time, {}, 'a bot that stopped working is not counted');
    });

    await test('service: a bot is picked by number (from..to), several jobs run side by side on their own bots', async () => {
        const fs = require('fs'), os = require('os'), path = require('path');
        const { WorkService } = require('../src/work/service');
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
        const svc = new WorkService({ dataDir: d, factory: () => ({}), restore: false, envFactory: () => ({ now: Date.now }) });
        for (let i = 1; i <= 12; i++) svc.bots.set(`Work${i}`, { name: `Work${i}`, bot: { entity: {} }, state: 'online' });
        svc.bots.set('Other', { name: 'Other', bot: { entity: {} }, state: 'online' });
        assert.deepStrictEqual(svc.botsInRange(3, 6), ['Work3', 'Work4', 'Work5', 'Work6']); assert.deepStrictEqual(svc.botsInRange(6, 3), ['Work3', 'Work4', 'Work5', 'Work6'], 'from > to is read the other way round');
        assert.throws(() => svc.botsInRange(20, 30), /no bot/); assert.throws(() => svc.botsInRange('a', 3), /whole numbers/);
        const a = svc.createPit({ name: 'A', box: { x0: 0, z0: 0, x1: 15, z1: 15, top: 64, bottom: 62 }, range: { from: 1, to: 6 } });
        const b = svc.createPit({ name: 'B', box: { x0: 100, z0: 0, x1: 115, z1: 15, top: 64, bottom: 62 }, range: { from: 7, to: 12 } });
        assert.deepStrictEqual(a.bots, ['Work1', 'Work2', 'Work3', 'Work4', 'Work5', 'Work6']); assert.deepStrictEqual(b.bots, ['Work7', 'Work8', 'Work9', 'Work10', 'Work11', 'Work12']);
        assert.strictEqual(svc.jobs.get(a.id).spec.lanes, 6, 'one lane per picked bot'); assert.strictEqual(svc.bots.get('Work3').job, a.id); assert.strictEqual(svc.bots.get('Work9').job, b.id);
        assert.throws(() => svc.createPit({ name: 'C', box: { x0: 200, z0: 0, x1: 215, z1: 15, top: 64, bottom: 62 }, range: { from: 1, to: 2 } }), /works on/, 'Work1 and Work2 belong to A: a second job cannot take them');
        const r = svc.unassignMany(a.id, svc.botsInRange(5, 6)); assert.deepStrictEqual(r.bots, ['Work1', 'Work2', 'Work3', 'Work4']); assert.strictEqual(svc.bots.get('Work5').job, null);
        const r2 = svc.assign(b.id, svc.botsInRange(5, 6)); assert.ok(r2.bots.includes('Work5') && r2.bots.includes('Work6'), 'the two freed bots go to the other job');
    }).catch((e) => { console.log('service range test:', e && e.message); throw e; });

    clearInterval(keepAlive);
    console.log('all flow tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

// The BOT-system TODO of 2026-11-06 (LLM-records/2026-11-06-forge1201-moded-aiplayer-bot-system-todo...) without a server:
//   1-1 range audit: leftovers and stray blocks in finished units send them back to work (pit.audit, Ledger.reopen, worker)
//   1-2 discarding without the trash loop (discard.js: clear, dump spot, order of options; janitor uses it)
//   2-2 problem bots: record, common factors, glow commands (problems.js)
//   2-3 climbing move_to: pillar of temporary blocks, roof dug, pair removed (moves.climbTo, cleanTemp)
//   2-4 defence: only what attacks (guard.js), interrupt in the worker loop
// The live checks (real Forge server, the play world's mod set) are scripts/work/todo_live.js.
const assert = require('assert');
const { Ledger, DONE, PENDING } = require('../src/work/jobs/crew');
const pit = require('../src/work/jobs/pit');
const discard = require('../src/work/bot/discard');
const janitor = require('../src/work/bot/janitor');
const { Problems, headingOf } = require('../src/work/bot/problems');
const moves = require('../src/work/bot/moves');
const { Guard, isHostile } = require('../src/work/bot/guard');
const { runWorker } = require('../src/work/bot/worker');
const esc = require('../src/work/escalation');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

/** Fake world like test_work_pure's: stone up to `ground`, a Map of changes; unknown cells for `unloaded(x,y,z)`. */
function fakeWorld(ground = 0, unloaded = () => false) {
    const m = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    const kindAt = (x, y, z) => { if (unloaded(x, y, z)) return 'unknown'; const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'ladder' ? 'climb' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => m.set(key(x, y, z), n), cells: m };
}

(async () => {
    await test('ledger.reopen: a done unit goes back to pending, its layer is open again, the layers below wait', () => {
        const L = new Ledger({ leaseMs: 1000 });
        L.addRegion({ id: 'a', anchor: { x: 0, z: 0 }, layers: 2, rows: 2 });
        for (const u of L.claim('b', { x: 0, z: 0 }, 0, { batch: 2 }).units) L.done('b', 'a', u.unit, 1);
        assert.strictEqual(L.regions.get('a').front, 1);
        assert.strictEqual(L.reopen('a', 1, 2), true);
        assert.strictEqual(L.reopen('a', 1, 2), false, 'not done any more');
        assert.strictEqual(L.reopen('a', 99, 2), false);
        const r = L.regions.get('a');
        assert.strictEqual(r.state[1], PENDING); assert.strictEqual(r.doneN, 1); assert.strictEqual(r.front, 0, 'the layer is open again');
        const c = L.claim('b', { x: 0, z: 0 }, 3);
        assert.deepStrictEqual(c.units.map((u) => u.unit), [1], 'only the reopened unit: layer 1 waits for layer 0');
        L.done('b', 'a', 1, 4);
        assert.strictEqual(r.front, 1, 'and the front is back where it was');
        assert.strictEqual(L.claim('b', { x: 0, z: 0 }, 5).units[0].layer, 1);
    });

    await test('pit.audit: a leftover, a stray block (water control at a dug height) and water in a finished unit send it back; unloaded cells are not judged; the road stays', () => {
        const box = { x0: 0, z0: 0, x1: 7, z1: 3, top: 10, bottom: 9 };
        const job = pit.createPitJob(box, { leaseMs: 1e6 }, { method: 'rows', road: true, lanes: 1 });
        const w = fakeWorld(100);                                       // everything is dug already ...
        for (let x = 0; x <= 7; x++) for (let z = 0; z <= 3; z++) for (let y = 9; y <= 10; y++) w.set(x, y, z, 'air');
        for (const [k, keepTo] of job.plan.road.keep) { const [x, z] = k.split(',').map(Number); for (let y = 9; y <= keepTo; y++) w.set(x, y, z, 'stone'); }      // ... but the road
        const L = job.ledger, reg = job.plan.regions[0];
        for (let u = 0; u < L.regions.get(reg.id).n; u++) { L.claim('b', { x: 0, z: 0 }, 0); L.done('b', reg.id, u, 1); }
        assert.ok(L.finished());
        const env = { w };
        const state = () => ({ cursor: new Map(), counts: new Map() });
        let a = pit.audit(job.plan, L, w, 5, state(), { full: true });
        assert.deepStrictEqual([a.reopened.length, a.gaveUp.length], [0, 0], 'a clean range: nothing to do (road cells are not leftovers)');
        w.set(5, 10, 2, 'cobblestone');                                   // a block put there for water control
        w.set(2, 9, 1, 'dirt');                                           // a plain leftover one layer down
        w.set(6, 9, 3, 'water');
        const unknownCell = { x: 4, y: 10, z: 0 };
        const w2 = fakeWorld(100, (x, y, z) => x === unknownCell.x && y === unknownCell.y && z === unknownCell.z);
        for (const [k, v] of w.cells) w2.cells.set(k, v);
        w2.set(unknownCell.x, unknownCell.y, unknownCell.z, 'stone');     // not loaded: not judged
        a = pit.audit(job.plan, L, w2, 6, state(), { full: true });
        assert.strictEqual(a.reopened.length, 3, JSON.stringify(a.reopened));
        assert.ok(a.reopened.every((r) => r.cells.length >= 1));
        assert.strictEqual(L.finished(), false, 'the job is not finished while its range is wrong');
        assert.ok(!a.reopened.some((r) => r.cells.some((c) => c.x === 4 && c.y === 10 && c.z === 0)));
        // the budgeted pass walks the units in turns and finds the same on a later call
        const L2 = pit.createPitJob(box, { leaseMs: 1e6 }, { method: 'rows', road: false, lanes: 1 });
        const w3 = fakeWorld(100); for (let x = 0; x <= 7; x++) for (let z = 0; z <= 3; z++) for (let y = 9; y <= 10; y++) w3.set(x, y, z, 'air');
        w3.set(7, 9, 3, 'stone');
        const rg = L2.plan.regions[0], n = L2.ledger.regions.get(rg.id).n;
        for (let u = 0; u < n; u++) { L2.ledger.claim('b', { x: 0, z: 0 }, 0); L2.ledger.done('b', rg.id, u, 1); }
        const st = state(); let found = 0;
        for (let i = 0; i < 4 && !found; i++) found = pit.audit(L2.plan, L2.ledger, w3, 7, st, { budget: 2 }).reopened.length;
        assert.strictEqual(found, 1, 'a slice of 2 units per call still finds it within a few calls');
    });

    await test('pit.audit: a unit that keeps coming back wrong is given up on after 3 reopenings (no endless loop) and reported once', () => {
        const box = { x0: 0, z0: 0, x1: 3, z1: 3, top: 10, bottom: 10 };
        const job = pit.createPitJob(box, { leaseMs: 1e6 }, { method: 'sweep', road: false, lanes: 1 });
        const w = fakeWorld(100); for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) w.set(x, 10, z, 'air');
        w.set(1, 10, 1, 'stone');
        const L = job.ledger, reg = job.plan.regions[0], st = { cursor: new Map(), counts: new Map() };
        let reopened = 0, gaveUp = 0;
        for (let round = 0; round < 6; round++) {
            for (let u = 0; u < L.regions.get(reg.id).n; u++) { const c = L.claim('b', { x: 0, z: 0 }, round); if (c) for (const x of c.units) L.done('b', reg.id, x.unit, round); }
            const a = pit.audit(job.plan, L, w, round, st, { full: true });
            reopened += a.reopened.length; gaveUp += a.gaveUp.length;
        }
        assert.strictEqual(reopened, 3); assert.strictEqual(gaveUp, 1);
    });

    await test('worker: a unit that was done but is wrong is fixed by the audit before the job ends; the final audit looks at everything', async () => {
        const box = { x0: 0, z0: 0, x1: 5, z1: 1, top: 10, bottom: 10 };
        const job = pit.createPitJob(box, { leaseMs: 1e6 }, { method: 'rows', road: false, lanes: 1 });
        const w = fakeWorld(100);
        let sabotaged = false, calls = 0, events = [];
        const env = {
            w, now: Date.now, pause: async () => {}, have: () => 99, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 11, z: 0 }), pos: () => ({ x: 0, z: 0 }),
            exec: async (cmd, a) => {
                calls++;
                if (cmd === 'mine') { w.set(a.x, a.y, a.z, 'air'); if (!sabotaged && a.x === 5 && a.z === 1) { sabotaged = true; w.set(2, 10, 0, 'cobblestone'); } }     // after row 1 is dug a stray block appears in row 0
                return { ok: true };
            },
        };
        const r = await runWorker(job, 'B1', env, { pollMs: 5, onEvent: (e, d) => events.push([e, d]) });
        assert.strictEqual(r.ended, 'finished');
        assert.strictEqual(w.kindAt(2, 10, 0), 'air', 'the stray block was dug again');
        assert.ok(events.some(([e, d]) => e === 'audit' && d.reopened >= 1), 'the audit event says what it did');
        assert.ok(job.ledger.finished());
    });

    await test('discard: clear is the first option (no entity), refused names fall back; dump spot avoids every job and every bot', async () => {
        const sent = []; let held = 40;
        const clear = discard.makeClear({ name: 'Work1', rcon: async (c) => { sent.push(c); if (c.includes('cobblestone')) { held -= 12; return 'Removed 12 item(s) from player Work1'; } return 'No items were found on player Work1'; }, count: () => held, sleep: async () => {} });
        assert.deepStrictEqual(await clear('cobblestone', 12), { ok: true, how: 'clear', removed: 12 });
        assert.strictEqual(sent[0], 'clear Work1 minecraft:cobblestone 12');
        const none = await clear('dirt', 3); assert.strictEqual(none.ok, false); assert.strictEqual(none.reason, 'refused');
        assert.strictEqual((await clear('create:zinc_ingot', 2)).ok, false); assert.ok(sent.includes('clear Work1 create:zinc_ingot 2'), 'namespaced ids are sent as they are');
        for (const bad of ['dirt; op x', 'DIRT', '', 'a b']) assert.strictEqual((await clear(bad, 1)).reason, 'invalid_args', bad);
        assert.strictEqual((await clear('dirt', 0)).reason, 'invalid_args');
        assert.strictEqual(discard.makeClear({ name: 'bad name', rcon: async () => '', count: () => 0 }), null, 'a name that is not a player name is never sent to the server');
        assert.strictEqual(discard.makeClear({ name: 'Work1', rcon: null, count: () => 0 }), null);

        const w = fakeWorld(64);
        const spot = discard.dumpSpot(w, { x: 10, y: 65, z: 10 }, { avoid: [{ x0: 0, x1: 20, z0: 0, z1: 20 }], others: [{ x: 40, z: 40 }], margin: 12 });
        assert.ok(spot && (spot.x < -12 || spot.x > 32 || spot.z < -12 || spot.z > 32), JSON.stringify(spot));
        assert.ok(Math.hypot(spot.x - 40, spot.z - 40) >= 8);
        assert.strictEqual(w.kindAt(spot.x, spot.y - 1, spot.z), 'solid');
        assert.strictEqual(discard.dumpSpot(fakeWorld(-100), { x: 0, y: 65, z: 0 }, {}), null, 'no floor anywhere: no spot');

        // order of the options in dispose()
        const log = [];
        const mk = (o) => ({ exec: async (n, a) => { log.push(n); return { ok: true }; }, here: () => ({ x: 1, y: 65, z: 1 }), ...o });
        assert.strictEqual((await discard.dispose(mk({ discard: async () => ({ ok: true, how: 'clear', removed: 5 }) }), 'dirt', 5)).how, 'clear'); assert.deepStrictEqual(log, [], 'nothing was thrown');
        assert.strictEqual((await discard.dispose(mk({ discard: async () => ({ ok: false }), dumpSpot: () => ({ x: 50, y: 65, z: 50 }) }), 'dirt', 5)).how, 'dump');
        assert.deepStrictEqual(log, ['move_to', 'toss', 'move_to'], 'walk to the dump spot, toss, walk back');
        log.length = 0;
        assert.strictEqual((await discard.dispose(mk({ dumpSpot: () => null }), 'dirt', 5)).how, 'toss'); assert.deepStrictEqual(log, ['toss']);
    });

    await test('janitor.maintain: surplus goes through discard, not through toss', async () => {
        const removed = [];
        const env = {
            inv: () => ({ items: [{ name: 'cobblestone', count: 200 }, { name: 'dirt', count: 100 }], slotsFree: 2 }),
            discard: async (item, count) => { removed.push([item, count]); return { ok: true, how: 'clear', removed: count }; },
            exec: async (name) => { throw new Error(`unexpected ${name}`); },
        };
        const r = await janitor.maintain(env, janitor.pitPolicy());
        assert.ok(r.ok, JSON.stringify(r)); assert.ok(removed.some(([i]) => i === 'cobblestone') && removed.some(([i]) => i === 'dirt'), JSON.stringify(removed));
    });

    await test('problems: record with where and facing, common factors (the same cell seen twice), glow and unglow commands', async () => {
        const P = new Problems({ now: () => 5 });
        assert.strictEqual(headingOf(0), 'north'); assert.strictEqual(headingOf(Math.PI), 'south'); assert.strictEqual(headingOf(Math.PI / 2), 'west'); assert.strictEqual(headingOf(-Math.PI / 2), 'east');
        for (const [bot, z] of [['A', 3], ['B', 33], ['C', 3], ['D', 50]]) P.record({ bot, kind: 'unit_failed', reason: 'stuck', stage: 'mine' }, { cell: [10, 70, z], heading: 'east', below: 'stone', ahead: 'stone' });
        P.record({ bot: 'E', kind: 'unit_failed', reason: 'not_visible' }, { cell: [11, 70, 7], heading: 'north' });
        const c = P.common();
        assert.strictEqual(c.total, 5);
        assert.deepStrictEqual(c.factors.reason[0], { value: 'stuck', count: 4 });
        assert.deepStrictEqual(c.factors.z[0], { value: '3', count: 2 }, 'two bots failing at z 3 is the thing to see');
        assert.deepStrictEqual(c.factors.z_in_chunk[0], { value: '3', count: 2 }, 'chunk-relative z is tallied as well (z 33 is offset 1, seen once: not listed)');
        assert.ok(!('bot' in c.factors));
        const cmds = []; const rc = async (cmd) => { cmds.push(cmd); return 'ok'; };
        assert.strictEqual(await P.glow(rc, 'Work1'), true); assert.strictEqual(cmds[0], 'effect give Work1 minecraft:glowing 120 0 true');
        assert.strictEqual(await P.glow(rc, 'bad name'), false, 'only player names reach the server');
        assert.strictEqual(await P.unglow(rc, 'Work1'), true); assert.strictEqual(cmds[1], 'effect clear Work1 minecraft:glowing');
        assert.strictEqual(await P.unglow(rc, 'Work1'), false, 'nothing to clear twice');
        const small = new Problems({ max: 3 }); for (let i = 0; i < 10; i++) small.record({ bot: 'A', kind: 'k' }); assert.strictEqual(small.list.length, 3);
    });

    await test('climbTo: walks when it can; climbs a wall (roof dug, pillar of the right height, last block taken away, temp cleared); never for a lower or invalid target', async () => {
        const mk = (walkOk, here, w = fakeWorld(64)) => {
            const log = []; const temp = new Map();
            const env = {
                w, temp, here: () => here,
                exec: async (name, a) => { log.push([name, a]); if (name === 'move_to') return walkOk() ? { ok: true } : { ok: false, reason: 'unreachable', detail: { why: 'no path' } }; if (name === 'mine') { w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } return { ok: true }; },
                run: async (name, a) => { log.push([`run:${name}`, a]); w.set(here.x, here.y + a.levels - 1, here.z, 'cobblestone'); return { ok: true, detail: { last: { x: here.x, y: here.y + a.levels - 1, z: here.z }, top: { x: here.x, y: here.y + a.levels, z: here.z } } }; },
            };
            return { env, log, temp };
        };
        let n = 0;
        let t = mk(() => true, { x: 0, y: 65, z: 0 });
        assert.deepStrictEqual(await moves.climbTo(t.env, { x: 5, y: 70, z: 0 }), { ok: true, how: 'walked' });
        assert.deepStrictEqual(t.log.map((l) => l[0]), ['move_to']);
        // fails on foot the first time, then works after the climb
        t = mk(() => ++n > 1, { x: 0, y: 65, z: 0 });
        t.env.w.set(0, 67, 0, 'stone');                                   // a roof in the shaft
        const r = await moves.climbTo(t.env, { x: 4, y: 69, z: 0 });
        assert.deepStrictEqual([r.ok, r.how, r.levels], [true, 'climbed', 4], JSON.stringify(r));
        assert.deepStrictEqual(t.log.map((l) => l[0]), ['move_to', 'move_to', 'mine', 'run:pillar', 'move_to', 'mine'], 'walk to the foot of the target, roof dug, pillar, walk, last block taken away');
        assert.ok(Math.hypot(t.log[1][1].x - 4, t.log[1][1].z - 0) <= 1.5, 'the approach cell is next to the target column: ' + JSON.stringify(t.log[1][1]));
        assert.deepStrictEqual(t.log[2][1], { x: 0, y: 67, z: 0, collect: false });
        assert.deepStrictEqual(t.log[3][1], { levels: 4 });
        assert.deepStrictEqual(t.log[5][1], { x: 0, y: 68, z: 0, collect: false }, 'the last pillar block, taken away from the side');
        assert.strictEqual(t.temp.size, 0, 'the pair is complete: nothing left to clean');
        // lower target / invalid / too high: no climbing
        t = mk(() => false, { x: 0, y: 65, z: 0 });
        assert.strictEqual((await moves.climbTo(t.env, { x: 3, y: 60, z: 0 })).reason, 'unreachable'); assert.deepStrictEqual(t.log.map((l) => l[0]), ['move_to']);
        t = mk(() => false, { x: 0, y: 65, z: 0 });
        assert.strictEqual((await moves.climbTo(t.env, { x: 3, y: 300, z: 0 })).reason, 'invalid_args');
        t = mk(() => false, { x: 0, y: 65, z: 0 }); t.env.w.set(0, 66, 0, 'water');
        const wet = await moves.climbTo(t.env, { x: 3, y: 70, z: 0 }); assert.strictEqual(wet.reason, 'invalid_target'); assert.ok(!t.log.some((l) => l[0] === 'run:pillar'), 'no pillar into water');
        // the walk after the climb fails: the block is still taken away and the failure is reported
        n = 0; t = mk(() => false, { x: 0, y: 65, z: 0 });
        const bad = await moves.climbTo(t.env, { x: 3, y: 67, z: 0 });
        assert.strictEqual(bad.ok, false); assert.strictEqual(bad.detail.stage, 'walk_after_climb'); assert.strictEqual(t.log[t.log.length - 1][0], 'mine');
        // a climb cut short leaves its block in env.temp; cleanTemp takes it away unless the bot stands on it
        const w = fakeWorld(64); w.set(0, 66, 0, 'cobblestone'); w.set(3, 66, 3, 'cobblestone');
        const log2 = []; const env2 = { w, temp: new Map([['0,66,0', { x: 0, y: 66, z: 0 }], ['3,66,3', { x: 3, y: 66, z: 3 }]]), here: () => ({ x: 3, y: 67, z: 3 }), exec: async (nm, a) => { log2.push(a); w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } };
        assert.strictEqual(await moves.cleanTemp(env2), 1); assert.deepStrictEqual(log2.map((a) => a.x), [0]); assert.deepStrictEqual([...env2.temp.keys()], ['3,66,3']);
    });

    await test('guard: a threat is a hostile mob near AFTER damage; calm mobs, animals, far mobs and old damage are not', () => {
        let t = 0; const g = new Guard({ now: () => t });
        const me = { x: 0, y: 70, z: 0 }, zombie = { id: 7, name: 'zombie', type: 'hostile', x: 2, y: 70, z: 0 }, skel = { id: 8, name: 'skeleton', type: 'hostile', x: 15, y: 70, z: 0 };
        g.health(20);
        assert.strictEqual(g.threat(me, [zombie]), null, 'a zombie in reach but no damage: the job goes on (defensive only)');
        g.health(17); t = 1000;
        assert.strictEqual(g.threat(me, [zombie]).id, 7);
        assert.strictEqual(g.threat(me, [{ id: 1, name: 'cow', type: 'animal', x: 1, y: 70, z: 0 }]), null);
        assert.strictEqual(g.threat(me, [{ ...zombie, x: 9 }]), null, 'a zombie 9 blocks away did not hit us');
        assert.strictEqual(g.threat(me, [skel]).id, 8, 'a skeleton shoots from afar');
        assert.strictEqual(g.threat(me, [{ ...zombie, x: 4 }, { ...zombie, id: 9, x: 1 }]).id, 9, 'the nearest');
        t = 6000; assert.strictEqual(g.threat(me, [zombie]), null, 'damage was a while ago');
        g.health(0); g.health(0); assert.strictEqual(g.threat(me, [zombie]), null, 'dead bots do not fight');
        assert.ok(isHostile({ type: 'hostile' }) && isHostile({ name: 'creeper' }) && !isHostile({ name: 'cow', type: 'animal' }) && !isHostile(null));
    });

    await test('worker: stopped by an attack the bot defends itself and claims again, without a failure or a bad streak; a threat before a unit is fought first', async () => {
        const box = { x0: 0, z0: 0, x1: 3, z1: 1, top: 10, bottom: 10 };
        const job = pit.createPitJob(box, { leaseMs: 1e6, maxAttempts: 2 }, { method: 'rows', road: false, lanes: 1 });
        const w = fakeWorld(100); let interrupted = false, defended = 0, threatOnce = true, disposed = false; const events = [];
        const env = {
            w, now: Date.now, pause: async () => {}, have: () => 99, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 11, z: 0 }), pos: () => ({ x: 0, z: 0 }),
            threat: () => { if (threatOnce) { threatOnce = false; return { id: 1 }; } return null; },
            defend: async () => { defended++; return { fought: 1, killed: 1 }; },
            dispose: () => { disposed = true; },
            exec: async (cmd, a) => {
                if (cmd === 'mine') { if (!interrupted && a.x === 2) { interrupted = true; return { ok: false, reason: 'cancelled' }; } w.set(a.x, a.y, a.z, 'air'); }
                return { ok: true };
            },
        };
        const r = await runWorker(job, 'B1', env, { pollMs: 5, onEvent: (e, d) => events.push(e) });
        assert.strictEqual(r.ended, 'finished'); assert.strictEqual(defended, 2, 'once before the first unit, once after the interrupt');
        assert.strictEqual(r.failed, 1); assert.strictEqual(job.ledger.stuck.length, 0, 'an attack never counts against a unit'); assert.ok(disposed, 'the guard is detached at the end');
        assert.ok(events.filter((e) => e === 'defend').length === 2);
    });
    await test('service: a problem is written down and the bot glows; the next finished unit clears it; settings tag bots for direct pickup; the sign-in notice', async () => {
        const fs = require('fs'), os = require('os'), path = require('path'), { EventEmitter } = require('events');
        const { WorkService } = require('../src/work/service');
        const { createConsole } = require('../src/work/console');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), cmds = [];
        const factory = (name) => { const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: { x: 3.5, y: 70, z: 33.5 }, yaw: 0, onGround: true }, health: 20, food: 20, inventory: { items: () => [], emptySlotCount: () => 30 } }); setTimeout(() => b.emit('spawn'), 5); b.quit = () => {}; return b; };
        const svc = new WorkService({ dataDir: dir, factory, envFactory: () => ({}), rcon: { command: async (c) => { cmds.push(c); return 'ok'; } }, reconnectMs: 20 });
        svc.addBot('Work1');
        while (svc.status().bots[0].state !== 'online') await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(cmds.includes('tag Work1 add aip_direct'), 'a bot that comes online is tagged for the server script: ' + cmds.join(' | '));
        const rec = svc.bots.get('Work1');
        svc._problem(rec, 'unit_failed', { reason: 'stuck', stage: 'mine', cell: [4, 70, 33], job: 'j1', region: 'c0_2', unit: 3 });
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(cmds.includes('effect give Work1 minecraft:glowing 120 0 true'));
        const pv = svc.problemsView(); assert.strictEqual(pv.recent.length, 1); assert.deepStrictEqual(pv.glowing, ['Work1']);
        assert.deepStrictEqual([pv.recent[0].reason, pv.recent[0].stage, pv.recent[0].heading, pv.recent[0].target], ['stuck', 'mine', 'north', [4, 70, 33]]);
        assert.ok(pv.recent[0].cell && pv.recent[0].cell[2] === 33, 'where the bot stood');
        assert.ok(fs.readFileSync(path.join(dir, 'problems.jsonl'), 'utf8').includes('"reason":"stuck"'), 'kept on disk for later');
        svc._clearGlow(rec); await new Promise((r) => setTimeout(r, 20));
        assert.ok(cmds.includes('effect clear Work1 minecraft:glowing')); assert.deepStrictEqual(svc.problemsView().glowing, []);
        svc.setSettings({ directPickup: false, glow: false, defend: false });
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(cmds.includes('tag Work1 remove aip_direct')); assert.deepStrictEqual([svc.settings.directPickup, svc.settings.glow, svc.settings.defend], [false, false, false]);
        // the notice on the sign-in screen: readable before login, plain text, bounded
        fs.writeFileSync(path.join(dir, 'notice.txt'), 'Demo ready\n100.77.246.23:25570\u0007');
        const http = require('http'), { server: srv } = createConsole({ service: svc, token: 'x'.repeat(24) });
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers: { host: 'localhost' } }, (m) => { let d = ''; m.on('data', (x) => (d += x)); m.on('end', () => res([m.statusCode, d])); }).on('error', rej));
        const [st, body] = await get('/api/notice');
        assert.strictEqual(st, 200); assert.strictEqual(JSON.parse(body).text, 'Demo ready\n100.77.246.23:25570');
        assert.strictEqual((await get('/api/problems'))[0], 401, 'the problem list needs the login');
        fs.rmSync(path.join(dir, 'notice.txt')); assert.strictEqual(JSON.parse((await get('/api/notice'))[1]).text, '');
        srv.close(); await svc.stop();
    });
    await test('escalation: the request is built in the closed form the router validates; decisions for other requests are refused', () => {
        const line = esc.buildRequest({ runId: 'r1', seq: 3, goalId: 'collect_iron', amount: 12, inventory: { stone_pickaxe: 1, coal: 0, 'create:zinc_ingot': 2 }, why: 'amount too large for gather' });
        assert.ok(line.endsWith('\n')); const m = JSON.parse(line);
        assert.deepStrictEqual(m, { v: 1, type: 'escalate', run_id: 'r1', seq: 3, goal_id: 'collect_iron', amount: 12, inventory: { stone_pickaxe: 1, 'create:zinc_ingot': 2 }, why: 'amount too large for gather' });
        for (const bad of [{ goalId: 'Bad' }, { amount: 0 }, { amount: 1.5 }, { amount: 5000 }, { seq: -1 }, { inventory: { 'bad name': 1 } }, { inventory: { dirt: -1 } }, { runId: '' }]) {
            assert.throws(() => esc.buildRequest({ runId: 'r1', seq: 1, goalId: 'collect_iron', amount: 1, inventory: {}, ...bad }), bad.toString());
        }
        const ok = '{"v":1,"type":"route","run_id":"r1","seq":3,"expert":"x_collect_iron","setup":[],"reason":"ok"}';
        assert.deepStrictEqual(esc.readDecision(ok, { runId: 'r1', seq: 3 }), { expert: 'x_collect_iron', setup: [], reason: 'ok' });
        assert.throws(() => esc.readDecision(ok, { runId: 'r1', seq: 4 }), /not the decision/);
        assert.throws(() => esc.readDecision(ok.replace('x_collect_iron', 'x; rm'), { runId: 'r1', seq: 3 }), /bad expert/);
        assert.deepStrictEqual(esc.readDecision('{"v":1,"type":"route","run_id":"r1","seq":3,"expert":null,"setup":["a_goal"],"reason":"missing_preconditions:x"}', { runId: 'r1', seq: 3 }).expert, null);
    });
    console.log('\nwork TODO 2026-11-06: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

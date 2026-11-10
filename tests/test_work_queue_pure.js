// The owner's work-console batch of 2026-11-09 (lines at beds and containers, the bed command, a layout job, climbing with a block taken from the undug part, being put back
// on the feet instead of waiting): pure tests, fake bots, no server.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Gates, Gate, byName } = require('../src/work/bot/queue');
const { layout } = require('../src/work/jobs/layout');
const skills = require('../src/skills');
const { WorkService } = require('../src/work/service');
const { runWorker } = require('../src/work/bot/worker');
const { Ledger } = require('../src/work/jobs/crew');
const bed = require('../src/work/bot/bed');

setTimeout(() => { console.error('test watchdog: still running after 40 s'); process.exit(2); }, 40000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000);          // the line's own timers are unref'd (they must not hold a process open)

(async () => {
    await test('queue: first come first served, one at a time, the next bot goes when the holder leaves', async () => {
        const g = new Gates({ holdMs: 5000, waitMs: 5000 }), order = [];
        let active = 0, maxActive = 0;
        const go = async (who) => { const t = await g.enter('bed:1,1,1', who); active++; maxActive = Math.max(maxActive, active); order.push(who); await sleep(15); active--; t.leave(); };
        await Promise.all(['Work1', 'Work2', 'Work3', 'Work4'].map(go));
        assert.deepStrictEqual(order, ['Work1', 'Work2', 'Work3', 'Work4']); assert.strictEqual(maxActive, 1);
        assert.strictEqual(g.gates.size, 0, 'an idle line is forgotten');
        const g2 = new Gates({ holdMs: 5000, waitMs: 5000 });
        const t1 = await g2.enter('k', 'A'); const p2 = g2.enter('k', 'B'), p3 = g2.enter('k', 'C');
        assert.deepStrictEqual(g2.gate('k').snapshot(), ['A', 'B', 'C']); assert.strictEqual(g2.gate('k').place('C'), 2); assert.strictEqual(g2.busy()[0].line.length, 3);
        t1.leave(); const t2 = await p2; assert.strictEqual(g2.gate('k').holder.who, 'B'); t2.leave(); (await p3).leave();
    });

    await test('queue: a holder that takes too long is out of the line (its ticket is cancelled) and the ones behind it go on; a waiter that waits too long gets a timeout; a cancel leaves the line', async () => {
        const g = new Gates({ holdMs: 60, waitMs: 5000 });
        const t1 = await g.enter('k', 'Slow'); const p2 = g.enter('k', 'Next');
        assert.strictEqual(t1.cancelled, false);
        const t2 = await p2; assert.strictEqual(t1.evicted, true); assert.strictEqual(t1.cancelled, true, 'the command under the ticket is told to stop'); assert.strictEqual(g.gate('k').holder.who, 'Next');
        t1.leave(); assert.strictEqual(g.gate('k').holder.who, 'Next', 'the evicted bot leaving late does not release the next one'); t2.leave();
        const g2 = new Gates({ holdMs: 5000, waitMs: 80 }); const h = await g2.enter('k', 'A');
        await assert.rejects(g2.enter('k', 'B'), (e) => e.reason === 'timeout'); h.leave();
        const g3 = new Gates({ holdMs: 5000, waitMs: 5000 }), cancel = { cancelled: false }, h3 = await g3.enter('k', 'A');
        const w = g3.enter('k', 'B', { cancel }); setTimeout(() => { cancel.cancelled = true; }, 20);
        await assert.rejects(w, (e) => e.reason === 'cancelled'); assert.deepStrictEqual(g3.gate('k').snapshot(), ['A']); h3.leave();
    });

    await test('byName: Work2 before Work10 (the order a crowd lines up in)', () => {
        assert.deepStrictEqual(['Work10', 'Work2', 'Work1', 'Work20', 'Work3'].sort(byName), ['Work1', 'Work2', 'Work3', 'Work10', 'Work20']);
    });

    // ------------------------------------------------------------------------------------------------ the line at a container, in the environment
    await test('env: bots using one chest are served one after another; one that fails there is sent away; one that never finishes is cancelled after its time limit and the rest go on', async () => {
        const { botEnv } = require('../src/work/bot/env');
        const real = skills.execute, log = [], at = { active: 0, max: 0 };
        const solid = (x, y, z) => y <= 0;
        const mkbot = (name) => { const b = new EventEmitter(); Object.assign(b, { username: name, registry: { blocksByName: {}, itemsByName: {} }, entity: { position: { x: 0.5, y: 1, z: 0.5, floored: () => ({ x: 0, y: 1, z: 0 }) }, onGround: true }, blockAt: (v) => (solid(v.x, v.y, v.z) ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty', shapes: [] }), inventory: { items: () => [] }, setControlState() {} }); return b; };
        const behave = {};
        skills.execute = async (bot, name, args, opts) => {
            if (name === 'move_to') { log.push(`${bot.username}:away`); return { ok: true }; }
            const how = behave[bot.username] || 'ok', counted = how !== 'hang';          // the one that is cut off stops within a few ticks of its turn running out: not counted as a second bot at the chest
            if (counted) { at.active++; at.max = Math.max(at.max, at.active); } log.push(`${bot.username}:${name}`);
            try {
                if (how === 'hang') { for (let i = 0; i < 400 && !opts.cancel.cancelled; i++) await sleep(5); return { ok: false, reason: 'cancelled' }; }
                await sleep(20);
                return how === 'fail' ? { ok: false, reason: 'stuck' } : { ok: true };
            } finally { if (counted) at.active--; }
        };
        try {
            const gates = new Gates({ holdMs: 250, waitMs: 5000 }), chest = { x: 3, y: 1, z: 3 };
            const env = (n) => botEnv(mkbot(n), { cancel: { cancelled: false }, gates });
            behave.B = 'fail'; behave.A = 'hang';
            const res = {};
            await Promise.all(['A', 'B', 'C', 'D'].map(async (n) => { res[n] = await env(n).exec('deposit', { item: 'dirt', x: chest.x, y: chest.y, z: chest.z }); }));
            assert.strictEqual(at.max, 1, 'one bot at the chest at any time');
            assert.deepStrictEqual(log.filter((l) => /deposit/.test(l)), ['A:deposit', 'B:deposit', 'C:deposit', 'D:deposit'], 'served in the order they came');
            assert.strictEqual(res.A.reason, 'timeout', `${JSON.stringify(res.A)}`); assert.strictEqual(res.A.detail.stage, 'queue');
            assert.strictEqual(res.B.reason, 'stuck'); assert.ok(res.C.ok && res.D.ok);
            assert.ok(log.includes('A:away') && log.includes('B:away'), `a bot that failed is sent away: ${log}`);
            assert.ok(!log.includes('C:away') && !log.includes('D:away'));
            assert.strictEqual(gates.gates.size, 0);
            // reserve (before the walk) is the same turn the command then uses: no second wait
            const e1 = env('E'), e2 = env('F'); log.length = 0; behave.E = 'ok'; behave.F = 'ok';
            assert.strictEqual(await e1.reserve(chest), null); const second = e2.exec('deposit', { item: 'dirt', x: 3, y: 1, z: 3 });
            await sleep(40); assert.ok(!log.includes('F:deposit'), 'F waits while E holds the turn');
            const r1 = await e1.exec('deposit', { item: 'dirt', x: 3, y: 1, z: 3 }); assert.ok(r1.ok); assert.ok((await second).ok);
            assert.deepStrictEqual(log.filter((l) => /deposit/.test(l)), ['E:deposit', 'F:deposit']);
            const e3 = env('G'); assert.strictEqual(await e3.reserve(chest), null); e3.release(chest); assert.strictEqual(gates.gates.size, 0, 'a turn given back frees the line');
            // a visit: all the deposits of one bot are ONE turn (before, each item kind queued again behind the others: H ran its five items interleaved with I's and J's)
            log.length = 0; behave.H = 'ok'; behave.I = 'ok'; behave.J = 'ok';
            const eh = env('H'), ei = env('I'), ej = env('J');
            const items = ['a', 'b', 'c', 'd', 'e'], dep = (e, n) => async () => { for (const it of items) { const r = await e.exec('deposit', { item: it + n, x: 3, y: 1, z: 3 }); assert.ok(r.ok); } return null; };
            await Promise.all([eh.visit(chest, dep(eh, 'H')), ei.visit(chest, dep(ei, 'I')), ej.visit(chest, dep(ej, 'J'))]);
            const who = log.filter((l) => /deposit/.test(l)).map((l) => l[0]).join('');
            assert.strictEqual(who, 'HHHHHIIIIIJJJJJ', `each bot's items together: ${who}`); assert.strictEqual(gates.gates.size, 0, 'the turn is given back at the end of the visit');
            // without a visit the same loop interleaves (the old behaviour, still what a single command does)
            log.length = 0; const ek = env('K'), el = env('L'); behave.K = 'ok'; behave.L = 'ok';
            await Promise.all([dep(ek, 'K')(), dep(el, 'L')()]);
            assert.ok(/KLKL/.test(log.filter((l) => /deposit/.test(l)).map((l) => l[0]).join('')), 'plain commands queue one by one');
            // a visit is not cut short by the per-command limit while it makes progress (renewed after each item), and a failed turn comes back as a failure
            const slow = env('M'); behave.M = 'ok';
            const long = await slow.visit(chest, async () => { for (let i = 0; i < 4; i++) { const r = await slow.exec('deposit', { item: 'x' + i, x: 3, y: 1, z: 3 }); if (!r.ok) return r; } return null; });
            assert.strictEqual(long, null, `holdMs 250 ms, four items of 20 ms: ${JSON.stringify(long)}`);
            const g3 = new Gates({ holdMs: 5000, waitMs: 60 }), blocker = await g3.enter('box:3,1,3', 'Z'), en = botEnv(mkbot('N'), { cancel: { cancelled: false }, gates: g3 });
            const nofl = await en.visit(chest, async () => null); assert.strictEqual(nofl.ok, false); assert.strictEqual(nofl.reason, 'timeout'); blocker.leave();
            // approach asks for a turn and gives it back when the walk fails
            const { approach } = require('../src/work/bot/reach'); const calls = [];
            const fake = { here: () => ({ x: 0, y: 1, z: 0 }), reserve: async (c) => { calls.push('reserve'); return null; }, release: () => calls.push('release'), travel: async () => ({ ok: false, reason: 'unreachable' }) };
            const far = await approach(fake, { x: 500, y: 1, z: 0 }); assert.ok(far && !far.ok); assert.deepStrictEqual(calls, ['reserve', 'release']);
            const q = await approach({ ...fake, reserve: async () => ({ ok: false, reason: 'timeout', detail: { why: 'waited 180 s' } }) }, { x: 5, y: 1, z: 0 }); assert.strictEqual(q.reason, 'timeout'); assert.ok(/line/.test(q.detail.why));
        } finally { skills.execute = real; }
    });

    // ------------------------------------------------------------------------------------------------ the bed
    await test('set_spawn: bots sent together touch the bed one after another in name order, wake at once, and the server\'s spawn point is checked; no bed is a named failure', async () => {
        const BEDPOS = { x: 10, y: 1, z: 10 }, rec = [], at = { active: 0, max: 0 };
        const mk = (name) => {
            const b = new EventEmitter(), spawn = {};
            Object.assign(b, { username: name, isSleeping: false, entity: { position: { x: 0.5, y: 1, z: 0.5 } },
                blockAt: (p) => { if (typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function'); const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); return (x === 10 && y === 1 && z === 10) || (x === 11 && y === 1 && z === 10) ? { name: 'red_bed', position: { x, y, z } } : { name: 'air', position: { x, y, z } }; },
                findBlock: () => ({ name: 'red_bed', position: { ...BEDPOS } }), lookAt: async (p) => { if (typeof p.minus !== 'function') throw new TypeError('point.minus is not a function'); }, wake: async () => { b.isSleeping = false; rec.push(`${name}:wake`); },
                activateBlock: async () => { at.active++; at.max = Math.max(at.max, at.active); rec.push(`${name}:touch`); await sleep(20); b.spawn = { ...BEDPOS }; b.isSleeping = true; b.emit('sleep'); at.active--; } });
            return b;
        };
        const solid = (x, y, z) => y <= 0, w = { kindAt: (x, y, z) => (solid(x, y, z) ? 'solid' : 'air') };
        const gates = new Gates({ holdMs: 6000, waitMs: 20000 });
        const run = (name, o = {}) => { const b = mk(name), pos = { x: 0, y: 1, z: 0 }; return bed.setSpawn({ env: { w, here: () => pos, sendAway: async () => { rec.push(`${name}:away`); } }, bot: b, gates, who: name, cancel: { cancelled: false }, walk: async (cell) => { Object.assign(pos, cell); return { ok: true }; },
            rcon: async (c) => { const m = /SpawnX|SpawnY|SpawnZ/.exec(c); const k = m[0].slice(5).toLowerCase(); const v = o.wrong ? 99 : b.spawn ? b.spawn[k] : null; return v === null || v === undefined ? 'No entity was found' : `${name} has the following entity data: ${v}`; }, ...o }); };
        const names = ['Work3', 'Work1', 'Work10', 'Work2'].sort(byName), out = await Promise.all(names.map((n) => run(n)));
        assert.ok(out.every((r) => r.ok && r.detail.verified), JSON.stringify(out)); assert.strictEqual(at.max, 1);
        assert.deepStrictEqual(rec.filter((l) => /touch/.test(l)).map((l) => l.split(':')[0]), ['Work1', 'Work2', 'Work3', 'Work10']);
        const bad = await run('Work4', { wrong: true }); assert.ok(!bad.ok && bad.reason === 'not_confirmed' && /respawn point/.test(bad.detail.why), JSON.stringify(bad)); assert.ok(rec.includes('Work4:away'), 'a bot that failed is sent away');
        const none = mk('Work5'); none.findBlock = () => null; const nb = await bed.setSpawn({ env: { w, here: () => ({ x: 0, y: 1, z: 0 }) }, bot: none, gates, who: 'Work5', cancel: { cancelled: false }, walk: async () => ({ ok: true }) });
        assert.ok(!nb.ok && nb.reason === 'invalid_target');
        // a key for both halves of a bed
        const V = require('vec3'), bk = mk('K'); assert.strictEqual(bed.bedKey(bk, bk.blockAt(new V(10, 1, 10))), bed.bedKey(bk, bk.blockAt(new V(11, 1, 10))));
        const viaAt = await run('Work6', { at: { x: 10, y: 1, z: 10 } }); assert.ok(viaAt.ok, `a bed given by coordinates: ${JSON.stringify(viaAt)}`);
        const noAt = await run('Work7', { at: { x: 3, y: 1, z: 3 } }); assert.ok(!noAt.ok && noAt.reason === 'invalid_target', 'no bed at those coordinates');
        // a bot that never gets done is cancelled by its time limit, the next one goes
        const g2 = new Gates({ holdMs: 80, waitMs: 5000 }), stuck = mk('Slow'); stuck.activateBlock = async () => { await sleep(400); };
        const pos2 = { x: 0, y: 1, z: 0 };
        const [rs, rn] = await Promise.all([bed.setSpawn({ env: { w, here: () => pos2, sendAway: async () => {} }, bot: stuck, gates: g2, who: 'Slow', cancel: { cancelled: false }, walk: async (c) => { await sleep(150); return { ok: true }; } }),
            bed.setSpawn({ env: { w, here: () => ({ x: 9, y: 1, z: 9 }) }, bot: mk('Fast'), gates: g2, who: 'Fast', cancel: { cancelled: false }, walk: async () => ({ ok: true }) })]);
        assert.ok(!rs.ok && rs.reason === 'timeout', JSON.stringify(rs)); assert.ok(rn.ok, JSON.stringify(rn));
    });

    // ------------------------------------------------------------------------------------------------ the layout
    await test('layout: floor, wall and room cells, the footprint boxes, and the refusals in words', () => {
        const f = layout({ kind: 'floor', block: 'cobblestone', x0: 5, z0: 2, x1: 7, z1: 3, y: 64, height: 9 });
        assert.strictEqual(f.count, 6); assert.deepStrictEqual(f.origin, { x: 5, y: 64, z: 2 }); assert.deepStrictEqual(f.size, [3, 1, 2]); assert.ok(f.cells.every((c) => c.y === 0));
        const w = layout({ kind: 'wall', block: 'minecraft:stone_bricks', x0: 12, z0: 5, x1: 8, z1: 5, y: 70, height: 4 });
        assert.strictEqual(w.count, 20); assert.deepStrictEqual(w.origin, { x: 8, y: 70, z: 5 }); assert.strictEqual(w.along, 'x'); assert.strictEqual(w.block, 'stone_bricks'); assert.ok(/5 long and 4 high/.test(w.describe), w.describe);
        const wz = layout({ kind: 'wall', block: 'oak_planks', x0: 3, z0: 0, x1: 3, z1: 9, y: 0, height: 2 }); assert.strictEqual(wz.along, 'z'); assert.strictEqual(wz.count, 20);
        const r = layout({ kind: 'room', block: 'glass', x0: 0, z0: 0, x1: 3, z1: 2, y: 10, height: 2 });
        assert.strictEqual(r.count, 20, 'ring of a 4 x 3 rectangle is 10 columns'); assert.strictEqual(r.boxes.length, 4);
        assert.ok(!r.cells.some((c) => c.x === 1 && c.z === 1), 'the inside stays open'); assert.ok(r.cells.some((c) => c.x === 3 && c.z === 2));
        const one = layout({ kind: 'wall', block: 'dirt', x0: 4, z0: 4, x1: 4, z1: 4, y: 0 }); assert.strictEqual(one.count, 3, 'a wall of one column, default height 3');
        for (const [s, re] of [[{ kind: 'wall', block: 'dirt', x0: 0, z0: 0, x1: 4, z1: 4, y: 0 }, /runs straight/], [{ kind: 'room', block: 'dirt', x0: 0, z0: 0, x1: 4, z1: 0, y: 0 }, /2 x 2/], [{ kind: 'floor', block: 'water', x0: 0, z0: 0, x1: 1, z1: 1, y: 0 }, /placeable/],
            [{ kind: 'floor', block: 'dirt', x0: 0, z0: 0, x1: 300, z1: 1, y: 0 }, /per side/], [{ kind: 'floor', block: 'dirt', x0: 0, z0: 0, x1: 255, z1: 200, y: 0 }, /too many/], [{ kind: 'wall', block: 'dirt', x0: 0, z0: 0, x1: 3, z1: 0, y: 300, height: 40 }, /between y/],
            [{ kind: 'fence', block: 'dirt', x0: 0, z0: 0, x1: 1, z1: 1, y: 0 }, /kind/], [{ kind: 'floor', block: 'Dirt;rm', x0: 0, z0: 0, x1: 1, z1: 1, y: 0 }, /placeable/], [{ kind: 'floor', block: 'dirt', x0: 0.5, z0: 0, x1: 1, z1: 1, y: 0 }, /integer/]]) assert.throws(() => layout(s), re, JSON.stringify(s));
    });

    await test('service: a layout becomes a build job (cells, materials, box for the map, a sentence); the preview says why when it cannot', async () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lay-')); const svc = new WorkService({ dataDir: d, factory: () => ({}), restore: false, known: (n) => n !== 'unobtainium' });
        try {
            const v = await svc.createLayout({ kind: 'wall', block: 'cobblestone', x0: 10, z0: 20, x1: 15, z1: 20, y: 65, height: 3 });
            assert.strictEqual(v.kind, 'build'); assert.strictEqual(v.progress.total > 0, true); assert.strictEqual(v.summary.count, 18); assert.deepStrictEqual(v.summary.materials, { cobblestone: 18 }); assert.ok(/6 long and 3 high/.test(v.summary.describe));
            assert.deepStrictEqual([v.box.x0, v.box.x1, v.box.z0, v.box.z1], [10, 15, 20, 20]); assert.strictEqual(v.spec.layout.kind, 'wall'); assert.strictEqual(v.spec.origin.y, 65);
            const again = await svc._rebuild({ id: v.id, kind: 'build', name: v.name, spec: svc.jobs.get(v.id).spec, created: 1 }); assert.strictEqual(again.impl.plan.count, 18, 'the job comes back after a restart');
            await assert.rejects(svc.createLayout({ kind: 'floor', block: 'unobtainium', x0: 0, z0: 0, x1: 1, z1: 1, y: 0 }), /block table/);
            await assert.rejects(svc.createLayout({ kind: 'wall', block: 'dirt', x0: 0, z0: 0, x1: 3, z1: 3, y: 0 }), /runs straight/);
            const p = svc.previewLayout({ kind: 'room', block: 'stone', x0: 0, z0: 0, x1: 4, z1: 4, y: 0, height: 2 }); assert.ok(p.ok && p.count === 32 && p.boxes.length === 4 && p.item === 'stone' && p.stacks === 1, JSON.stringify(p));
            const bad = svc.previewLayout({ kind: 'wall', block: 'stone', x0: 0, z0: 0, x1: 4, z1: 4, y: 0 }); assert.ok(!bad.ok && /straight/.test(bad.why));
            assert.ok(!svc.previewLayout({ kind: 'floor', block: 'unobtainium', x0: 0, z0: 0, x1: 1, z1: 1, y: 0 }).known);
            svc._checkArgs({ name: 'set_spawn', meta: true, args: [] }, {}); svc._checkArgs({ name: 'set_spawn', meta: true }, { x: 1, y: 2, z: 3 });
            assert.throws(() => svc._checkArgs({ name: 'set_spawn', meta: true }, { x: 1 }), /all of x, y, z/);
            assert.ok(svc.catalog().some((c) => c.name === 'set_spawn'));
        } finally { clearTimeout(svc._saveTimer); fs.rmSync(d, { recursive: true }); }
    });

    // ------------------------------------------------------------------------------------------------ a bot that cannot go on is put back
    await test('worker: a bot that gives up (needs an item, or fails twelve times) is put back on its feet first (env.goBack), not left where it stopped', async () => {
        const mkjob = (reason) => { const ledger = new Ledger({ leaseMs: 1e9, maxAttempts: 100 }); ledger.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 }); return { ledger, runUnit: async () => ({ ok: false, reason, detail: { item: 'cobblestone' } }) }; };
        for (const reason of ['missing_item', 'stuck']) {
            const sent = [], events = [];
            const env = { pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 0, z: 0 }), now: Date.now, exec: async () => ({ ok: true }), goBack: async (why) => { sent.push(why); return { ok: true }; } };
            const res = await runWorker(mkjob(reason), 'b', env, { pollMs: 2, backoff: () => 1, onEvent: (e, d) => events.push([e, d]) });
            assert.strictEqual(res.ended, 'unhealthy'); assert.strictEqual(sent.length, 1, `${reason}: sent back once: ${sent}`); assert.ok(events.some(([e, d]) => e === 'sent_back' && d.ok));
        }
        const res = await runWorker(mkjob('missing_item'), 'b', { pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 0, z: 0 }), now: Date.now, exec: async () => ({ ok: true }), goBack: async () => { throw new Error('rcon down'); } }, { pollMs: 2, backoff: () => 1 });
        assert.strictEqual(res.ended, 'unhealthy', 'a failed move back does not break the worker');
        // env.goBack: to the last good place by a server move (job purpose, whatever the recovery setting), else a lift where it stands; no RCON = refused
        const { botEnv } = require('../src/work/bot/env'), sentCmd = [];
        const solid = (x, y, z) => y <= 0, b = new EventEmitter();
        Object.assign(b, { username: 'Bot', registry: { blocksByName: {}, itemsByName: {} }, entity: { position: { x: 0.5, y: 1, z: 0.5, floored: () => ({ x: 0, y: 1, z: 0 }) }, onGround: true }, blockAt: (v) => (solid(v.x, v.y, v.z) ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty', shapes: [] }), inventory: { items: () => [] }, setControlState() {} });
        const e = botEnv(b, { cancel: { cancelled: false }, rcon: async (c) => { sentCmd.push(c); b.entity.position.x = 20.5; b.entity.position.z = 20.5; return 'ok'; }, teleport: () => 'near' });
        const g = await e.goBack('test'); assert.ok(g.ok || g.reason === 'not_confirmed', JSON.stringify(g)); assert.strictEqual(sentCmd.length, 1, 'allowed although recovery moves are limited (a job move)');
        const none = await botEnv(b, { cancel: { cancelled: false } }).goBack('x'); assert.strictEqual(none.reason, 'refused');
    });
    await test('env.within: the pit box reaches the pillar by itself (goToStation, leave pit, scripts all call env.run); an explicit box wins; other moves are untouched', async () => {
        const moves = require('../src/work/bot/moves'), real = moves.runMove, seen = [];
        moves.runMove = (bot, name, args) => { seen.push([name, args]); return Promise.resolve({ ok: true }); };
        try {
            const { botEnv } = require('../src/work/bot/env'), b = new EventEmitter();
            Object.assign(b, { username: 'Bot', registry: { blocksByName: {}, itemsByName: {} }, entity: { position: { x: 0.5, y: 1, z: 0.5, floored: () => ({ x: 0, y: 1, z: 0 }) }, onGround: true }, blockAt: () => null, inventory: { items: () => [] }, setControlState() {} });
            const env = botEnv(b, { cancel: { cancelled: false } }), box = { x0: 0, x1: 1, z0: 0, z1: 1, top: 5, bottom: 0 };
            await env.run('pillar', { levels: 2 }); assert.strictEqual(seen[0][1].within, undefined, 'no pit job: nothing may be dug for blocks');
            env.within = box; await env.run('pillar', { levels: 2 }); assert.deepStrictEqual(seen[1][1].within, box);
            await env.run('pillar', { levels: 2, within: { ...box, x1: 0 } }); assert.strictEqual(seen[2][1].within.x1, 0);
            await env.run('mine_hand', { x: 0, y: 0, z: 0 }); assert.strictEqual(seen[3][1].within, undefined);
        } finally { moves.runMove = real; }
    });
    console.log('all queue/bed/layout tests passed'); clearInterval(keepAlive);
})().catch((e) => { console.error(e); process.exit(1); });

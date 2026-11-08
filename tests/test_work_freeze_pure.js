// The freeze of 2026-11-09 and what keeps it from coming back: a bot short of air (drowning) cancelled every command of its unit AND of its own water
// rescue, the worker claimed the next unit at once, and the loop never waited for I/O (99,639 failures in 100 minutes, all 20 bots timed out).
// Covered: the worker loop yields and cools down, the rescue is not cancelled by the drowning flag, the supervisor puts idle bots of running jobs back
// to work (design: no permanent retirement), running jobs come back running unless the process froze repeatedly, the watchdog kills a frozen process.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { runWorker } = require('../src/work/bot/worker');
const { Ledger } = require('../src/work/jobs/crew');
const water = require('../src/work/bot/water');
const { WorkService } = require('../src/work/service');
const watchdog = require('../src/work/service/watchdog');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 10000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await sleep(20); } }

(async () => {
    await test('worker: units cancelled with nothing to fight do not starve the event loop; the bot cools down after the usual twelve', async () => {
        const ledger = new Ledger({ leaseMs: 1e9, maxAttempts: 1e9 }); ledger.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 4 });
        let runs = 0, defends = 0, ticks = 0;
        const job = { ledger, runUnit: async () => { runs++; return { ok: false, reason: 'cancelled' }; } };       // answers at once, like a command stopped by the drowning flag
        const env = { pos: () => ({ x: 0, z: 0 }), defend: async () => { defends++; return { fought: 0, killed: 0 }; }, recover: async () => {}, threat: () => false };
        const timer = setInterval(() => ticks++, 5);
        const t0 = Date.now(), res = await runWorker(job, 'b', env, { pollMs: 1, backoff: () => 2 });
        clearInterval(timer);
        assert.strictEqual(res.ended, 'unhealthy'); assert.strictEqual(res.failed, 12, 'twelve tries, each after a fix and a pause');
        assert.ok(defends >= 12 && runs === 12);
        assert.ok(ticks >= 3, `timers ran while the worker did (${ticks} ticks in ${Date.now() - t0} ms)`);
    });

    await test('worker: a real fight (something attacked) still claims again at once and is not a failure streak', async () => {
        const ledger = new Ledger({ leaseMs: 1e9, maxAttempts: 6 }); ledger.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 2 });
        let n = 0, fights = 0;
        const job = { ledger, runUnit: async () => (n++ < 20 ? { ok: false, reason: 'cancelled' } : { ok: true }) };
        const env = { pos: () => ({ x: 0, z: 0 }), defend: async () => { fights++; return { fought: 1, killed: 1 }; }, recover: async () => {}, threat: () => false, rememberGood: () => {} };
        const res = await runWorker(job, 'b', env, { pollMs: 1, backoff: () => 1 });
        assert.strictEqual(res.ended, 'finished'); assert.strictEqual(fights, 20, 'twenty attacks, none of them counted against the bot');
    });

    await test('rescue: the swim and the fills use the runner the drowning flag cannot cancel', async () => {
        const cells = new Map(), ck = (x, y, z) => `${x},${y},${z}`, nameAt = (x, y, z) => cells.get(ck(x, y, z)) ?? (y <= 64 ? 'stone' : 'air');
        cells.set(ck(0, 65, 0), 'water'); cells.set(ck(0, 66, 0), 'water');
        const w = { nameAt, kindAt: (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : 'solid'; } };
        let at = { x: 0, y: 65, z: 0 }, cancelledCalls = 0;
        const env = {
            w, here: () => at, have: () => 9, recover: async () => {},
            exec: async () => { cancelledCalls++; return { ok: false, reason: 'cancelled' }; },                    // what the drowning flag does to every command
            execFree: async (name, a) => { if (name === 'move_to') at = { x: a.x, y: a.y, z: a.z }; return { ok: true }; },
        };
        const r = await water.rescue(env, { x0: -8, x1: 8, z0: -8, z1: 8, top: 70, bottom: 60 });
        assert.ok(r.ok && r.surfaced, JSON.stringify(r)); assert.strictEqual(cancelledCalls, 0, 'nothing went through the cancelled runner');
        assert.deepStrictEqual(at, { x: 1, y: 65, z: 0 }, 'on the shore');
        // Control: without execFree the same bot is stuck (this is what happened live)
        delete env.execFree; at = { x: 0, y: 65, z: 0 }; const stuck = await water.rescue(env, { x0: -8, x1: 8, z0: -8, z1: 8, top: 70, bottom: 60 });
        assert.ok(!stuck.ok && stuck.reason === 'stuck', JSON.stringify(stuck)); assert.ok(cancelledCalls > 0);
    });

    await test('supervisor: idle bots of running jobs are put back to work with a growing pause; waiting and cooling bots are left to their own rules', async () => {
        const notes = [], resumed = [];
        const mkRec = (name, extra = {}) => ({ name, state: 'online', job: 'j1', worker: null, retired: null, removed: false, idleSince: 0, ...extra });
        const job = { id: 'j1', state: 'running', bots: new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']), impl: { ledger: { finished: () => false } } };
        const recs = [
            mkRec('A', { retired: 'error: boom' }),                                      // 'error' used to retire for good
            mkRec('B', { waitFor: { item: 'cobblestone' }, retired: 'waiting for cobblestone: give some' }),
            mkRec('C', { retired: 'cooling down after stuck (try 2), resumes by itself', coolTimer: {} }),
            mkRec('D', { autoTries: 3 }),                                                  // 48 s pause
            mkRec('E', { cmd: { status: 'running' } }),                                    // the operator is using it
            mkRec('F', { worker: { cancel: {} } }),
            mkRec('G'),
        ];
        const fake = { bots: new Map(recs.map((r) => [r.name, r])), jobs: new Map([['j1', job]]), note: (l, m) => notes.push(m), _resume: (r) => resumed.push(r.name), _dirty: () => {} };
        const run = () => WorkService.prototype._watchResume.call(fake);
        run(); assert.deepStrictEqual(resumed, [], 'first sight only starts the clock');
        const ago = (ms) => Date.now() - ms;
        recs.find((r) => r.name === 'A').idleSince = ago(7000); recs.find((r) => r.name === 'B').idleSince = ago(7000); recs.find((r) => r.name === 'C').idleSince = ago(400000);
        recs.find((r) => r.name === 'D').idleSince = ago(7000); recs.find((r) => r.name === 'G').idleSince = ago(7000);
        run(); assert.deepStrictEqual(resumed.sort(), ['A', 'G'], 'A (error) and G (nothing) resume after 6 s; B waits for the operator, C has its timer, D needs 48 s');
        assert.strictEqual(recs[0].retired, null); assert.strictEqual(recs[0].autoTries, 1);
        recs[3].idleSince = ago(49000); recs[1].idleSince = ago(301000); resumed.length = 0; run();
        assert.deepStrictEqual(resumed.sort(), ['B', 'D'], 'D after its longer pause, B looks again after five minutes'); assert.strictEqual(recs[1].waitFor, null);
        job.state = 'paused'; recs[0].idleSince = ago(1e6); resumed.length = 0; run(); assert.deepStrictEqual(resumed, [], 'a paused job is the operator\'s decision');
        assert.ok(notes.some((m) => /resumed automatically/.test(m)));
    });

    await test('restore: a running job comes back running; not after three freezes in the hour; not when the setting is off', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
        const bot = (name) => { const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: { x: 0, y: 70, z: 0 } }, inventory: { items: () => [], emptySlotCount: () => 20 } }); b.quit = () => b.emit('end', 'quit'); return b; };
        const mk = () => new WorkService({ dataDir: dir, reconnectMs: 20, factory: (n) => { const b = bot(n); setTimeout(() => b.emit('spawn'), 5); return b; },
            envFactory: () => ({ w: { kindAt: () => 'solid', nameAt: () => 'stone' }, now: Date.now, pause: () => sleep(1), exec: async () => { await sleep(50); return { ok: true }; }, have: () => 9, inv: () => ({ items: [], slotsFree: 30 }), here: () => ({ x: 0, y: 70, z: 0 }), pos: () => ({ x: 0, z: 0 }) }) });
        const a = mk(); a.addBot('Work1'); await until(() => a.status().bots[0].state === 'online');
        const v = a.createPit({ name: 'run', box: { x0: 0, z0: 0, x1: 31, z1: 15, top: 100, bottom: 99 }, bots: ['Work1'], start: true });
        await sleep(100); a.save(); await a.stop();
        const b = mk(); await b.restore(); assert.strictEqual(b.jobs.get(v.id).state, 'running', 'it was running: it runs again'); await until(() => b.bots.get('Work1').state === 'online'); await until(() => !!b.bots.get('Work1').worker); await b.stop();
        fs.writeFileSync(path.join(dir, watchdog.FILE), JSON.stringify({ at: Date.now(), n: 3, ms: 30000, stack: ['spin x.js:1'] }));
        const c = mk(); await c.restore(); assert.strictEqual(c.jobs.get(v.id).state, 'paused', 'three freezes: paused'); assert.ok(c.log.some((e) => /frozen 3 times/.test(e.msg))); await c.stop();
        watchdog.forget(dir); assert.strictEqual(watchdog.lastFreeze(dir), null);
        const s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); s.settings.resumeJobs = false; s.jobs.forEach((j) => { j.state = 'running'; }); fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s));
        const d = mk(); await d.restore(); assert.strictEqual(d.jobs.get(v.id).state, 'paused', 'setting off: paused'); await d.stop();
    });

    await test('watchdog: a process whose loop never yields is stopped, with the place where it was', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
        const code = `const w=require(${JSON.stringify(path.resolve(__dirname, '../src/work/service/watchdog.js'))});w.start({dir:${JSON.stringify(dir)},limitMs:2000,intervalMs:100});setTimeout(function spinForever(){for(;;){}},300);`;
        const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = ''; child.stderr.on('data', (d) => { err += d; });
        const t0 = Date.now(), sig = await new Promise((res) => child.on('exit', (c, s) => res(s || c)));
        assert.strictEqual(sig, 'SIGKILL'); assert.ok(Date.now() - t0 < 12000, `killed after ${Date.now() - t0} ms`);
        const f = watchdog.lastFreeze(dir); assert.ok(f && f.n === 1 && f.ms >= 2000, JSON.stringify(f)); assert.ok(f.stack.some((l) => /spinForever/.test(l)), `stack: ${f.stack.join(' < ')}`);
        assert.match(err, /event loop frozen/);
        // A healthy process is left alone
        const ok = spawn(process.execPath, ['-e', `const w=require(${JSON.stringify(path.resolve(__dirname, '../src/work/service/watchdog.js'))});w.start({dir:${JSON.stringify(dir)},limitMs:2000,intervalMs:100});setTimeout(()=>process.exit(0),4500);`]);
        assert.strictEqual(await new Promise((res) => ok.on('exit', (c, s) => res(s || c))), 0);
    });

    console.log('all freeze tests passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

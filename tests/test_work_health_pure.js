// Health of the work layer (owner 2026-11-09: stability dropped, the logs are the only evidence): the window counters, the per-minute row, the stall warning, the cause of a cancelled
// unit reaching the worker's event, and the bounded problem list. Pure: fake clocks, fake files.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Health } = require('../src/work/service/health');
const { Problems } = require('../src/work/bot/problems');
const { runWorker } = require('../src/work/bot/worker');
const { Ledger } = require('../src/work/jobs/crew');
const script = require('../src/work/bot/script');
const { Sites } = require('../src/work/bot/sites');
const janitor = require('../src/work/bot/janitor');

setTimeout(() => { console.error('test watchdog: still running after 20 s'); process.exit(2); }, 20000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));

(async () => {
    await test('a window counts finished, failed and cancelled units with the bot time each cost, names what the bot was short of, and resets', () => {
        let t = 1000000; const h = new Health({ now: () => t });
        h.unit({ ok: true, ms: 12000 }); h.unit({ ok: true, ms: 8000 }); for (let i = 0; i < 50; i++) h.unit({ ok: true, ms: 20 });
        h.unit({ ok: false, reason: 'unreachable', ms: 7000, detail: { why: 'reach block' } });
        h.unit({ ok: false, reason: 'cancelled', ms: 15000, detail: { cause: 'drowning' } }); h.unit({ ok: false, reason: 'cancelled', ms: 15000, detail: { cause: 'drowning' } }); h.unit({ ok: false, reason: 'cancelled', ms: 1000 });
        h.unit({ ok: false, reason: 'missing_tool', ms: 100, detail: { block: 'minecraft:cobweb' } });
        h.deposit({ kinds: 3, items: 120 }); h.deposit({ kinds: 1, items: 8 }); h.deposit({ failed: true });
        t += 60000;
        const { row, text, warn } = h.flush({ bots: [{ name: 'a', working: true, phase: 'dig' }, { name: 'b', working: true, phase: 'deposit', onFloor: true }, { name: 'c', working: false, retired: 'waiting for a sword' }], lines: [{ key: 'box:1,-59,2', line: ['a', 'b'] }], lagMs: 40 });
        assert.strictEqual(row.done, 2); assert.strictEqual(row.quick, 50, 'units found already done are counted apart'); assert.strictEqual(row.perMin, 2); assert.strictEqual(row.failed, 2); assert.strictEqual(row.cancelled, 3);
        assert.deepStrictEqual(row.cancel, { drowning: 2, unknown: 1 }, 'a cancel without a cause says unknown, not nothing');
        assert.deepStrictEqual(row.botSec, { ok: 20, fail: 7, cancel: 31 }, 'the cancelled units cost more than the finished ones: that is what the row exists to show');
        assert.deepStrictEqual(row.deposit, { visits: 2, kinds: 4, items: 128, failed: 1, to: {} }); assert.ok(/deposits 2 ok \(128 items, 4 kinds\), 1 failed/.test(text), text);
        assert.deepStrictEqual(row.needs, { 'missing_tool:cobweb': 1 });
        assert.deepStrictEqual(row.phases, { dig: 1, deposit: 1 }); assert.strictEqual(row.working, 2); assert.strictEqual(row.waiting, 1); assert.strictEqual(row.floor, 1);
        assert.deepStrictEqual(row.queues, [{ key: 'box:1,-59,2', n: 2 }]); assert.strictEqual(warn, null);
        assert.ok(/cancelled 3 \(drowning 2, unknown 1\)/.test(text) && /needs missing_tool:cobweb 1/.test(text) && /lines 1,-59,2=2/.test(text), text);
        const again = h.flush({ bots: [] }); assert.strictEqual(again.row.done, 0); assert.deepStrictEqual(again.row.fail, {}, 'the window was reset');
    });

    await test('no unit finished for three windows with bots working: one warning, then again every tenth; a finished unit or no working bot clears it', () => {
        let t = 0; const h = new Health({ now: () => (t += 60000) }), snap = { bots: [{ name: 'a', working: true }] }, w = [];
        for (let i = 0; i < 12; i++) w.push(h.flush(snap).warn);
        assert.deepStrictEqual(w.map((x, i) => (x ? i + 1 : 0)).filter(Boolean), [3, 10], 'windows 3 and then 10');
        h.unit({ ok: true, ms: 1 }); assert.strictEqual(h.flush(snap).warn, null);
        for (let i = 0; i < 2; i++) assert.strictEqual(h.flush(snap).warn, null); assert.ok(h.flush(snap).warn, 'three again after the reset');
        const idle = new Health({ now: () => (t += 60000) }); for (let i = 0; i < 5; i++) assert.strictEqual(idle.flush({ bots: [{ name: 'a', working: false }] }).warn, null, 'nothing was working: not a stall');
    });

    await test('the row is appended to its file and the file rotates past the limit', () => {
        const f = path.join(tmp, 'health.jsonl'); const h = new Health({ file: f, maxBytes: 300, now: () => Date.now() });
        for (let i = 0; i < 70; i++) h.flush({ bots: [{ name: 'a', working: true, phase: 'dig' }] });
        assert.ok(fs.existsSync(f + '.1'), 'rotated once'); assert.ok(fs.statSync(f).size < 4000, `the live file stays small: ${fs.statSync(f).size}`);
        for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) JSON.parse(l);
    });

    await test('the problem list is bounded too: past its limit the file moves to .1, newer rows go to a fresh one', () => {
        const f = path.join(tmp, 'problems.jsonl'); const p = new Problems({ file: f, maxBytes: 2000 });
        for (let i = 0; i < 450; i++) p.record({ bot: 'Work1', kind: 'unit_failed', reason: 'unreachable', why: 'reach block', block: 'cobweb' });
        assert.ok(fs.existsSync(f + '.1')); assert.ok(fs.statSync(f).size < 2000 + 200 * 200, 'bounded');
        assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop()).block, 'cobweb', 'the block is part of the record');
        assert.strictEqual(new Problems({ file: path.join(tmp, 'none', 'x.jsonl') }).record({ bot: 'a', kind: 'k' }).kind, 'k', 'an unwritable file never throws');
    });

    await test('a cancelled unit reaches the event with the cause the environment gives (operator, attacked, drowning, reflex), and a cause from an earlier unit is forgotten first', async () => {
        const L = new Ledger({ leaseMs: 1e9, maxAttempts: 6 }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 2 });
        const events = []; let causes = ['stale', 'drowning'], n = 0;
        const env = { pos: () => ({ x: 0, z: 0 }), takeCancelCause: () => causes.shift() || null };
        const job = { ledger: L, runUnit: async () => { n++; return n === 1 ? { ok: false, reason: 'cancelled' } : { ok: true }; } };
        const res = await runWorker(job, 'A', env, { pollMs: 1, backoff: () => 5, onEvent: (e, d) => { if (e === 'unit') events.push(d); } });
        assert.strictEqual(res.ended, 'finished');
        const c = events.find((d) => d.reason === 'cancelled');
        assert.ok(c, JSON.stringify(events)); assert.strictEqual(c.detail.cause, 'drowning', 'the stale cause was taken (and dropped) at the start of the unit');
    });

    await test('a container one bot found without a tool is not visited again by the others for the time limit (20 bots x 3 classes at one door was the standstill); a chest filled later is looked at again', async () => {
        let t = 0; const miss = new script.Misses({ ttlMs: 1000, now: () => t });
        assert.strictEqual(miss.has('sword@1,2,3'), false); miss.add('sword@1,2,3'); assert.strictEqual(miss.has('sword@1,2,3'), true); assert.strictEqual(miss.has('axe@1,2,3'), false);
        t = 1001; assert.strictEqual(miss.has('sword@1,2,3'), false, 'expired'); assert.strictEqual(miss.size, 0);
        t = 0; const visits = []; const sites = new Sites([{ name: 'tools', x: 10, y: 64, z: 0, purpose: 'tools' }]);
        const bot = () => ({ sites, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), usableTool: () => null, usableCount: () => 0, stockMiss: miss,
            run: async (name, a) => { visits.push(`${name}@${a.x}`); return { ok: false, reason: 'missing_item' }; } });
        const sc = script.validate({ name: 't', steps: [{ take_tool: { class: 'sword', from: 'tools' }, optional: true }, { return: 'ok' }] });
        await script.runScript(sc, bot()); await script.runScript(sc, bot()); await script.runScript(sc, bot());
        assert.strictEqual(visits.length, 1, `three bots, one visit: ${visits}`);
        t = 5000; await script.runScript(sc, bot()); assert.strictEqual(visits.length, 2, 'asked again after the time limit');
        const solo = []; const env = { ...bot(), stockMiss: null, run: async (n, a) => { solo.push(1); return { ok: false, reason: 'missing_item' }; } };
        await script.runScript(sc, env); await script.runScript(sc, env); assert.strictEqual(solo.length, 2, 'without the shared memory (tests, one-off commands) nothing changes');
    });

    await test('upkeep: starts below 6 free slots and then makes room down to 18 (one trip for many stacks); at 6 or more free nothing is done; an explicit freeTarget alone still means both', () => {
        const stacks = (n) => Array.from({ length: n }, (_, i) => ({ name: `create:stone${i}`, count: 64 }));
        const slots = (ops) => ops.reduce((a, o) => a + Math.ceil(o.count / 64), 0);
        const pol = janitor.pitPolicy({ depot: { kind: 'chest', x: 0, y: 0, z: 0 } });
        const low = janitor.plan(stacks(31), 5, pol);                                           // 5 free: below the trigger
        assert.ok(slots(low.filter((o) => o.op === 'deposit')) >= 13, `free 5 -> at least 18 free: ${slots(low)} slots moved`);
        assert.deepStrictEqual(janitor.plan(stacks(30), 6, pol), [], 'six free: no trip');
        const old = janitor.plan(stacks(31), 5, { ...pol, freeLow: undefined, freeTarget: 6, dumpAll: false });
        assert.strictEqual(slots(old.filter((o) => o.op === 'deposit')), 1, 'the old behaviour: one slot per trip');
    });

    await test('a deposit the server refused (not_confirmed) is not tried again at the next unit for 90 s; tossing goes on', async () => {
        const calls = []; const env = { inv: () => ({ items: Array.from({ length: 31 }, (_, i) => ({ name: `create:stone${i}`, count: 64 })), slotsFree: 5 }), pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 1, z: 0 }), w: { kindAt: () => 'air' },
            exec: async (n, a) => { calls.push(n); return { ok: false, reason: 'not_confirmed', detail: { why: 'the server did not take the items' } }; } };
        const pol = janitor.pitPolicy({ depot: { kind: 'chest', x: 1, y: 1, z: 1 } });
        const first = await janitor.maintain(env, pol); assert.strictEqual(first.ok, false); assert.strictEqual(first.reason, 'not_confirmed'); const n1 = calls.length; assert.ok(n1 >= 1);
        const second = await janitor.maintain(env, pol); assert.strictEqual(second.ok, true); assert.strictEqual(second.backoff, true); assert.strictEqual(calls.length, n1, 'no second trip');
        env.depositBackoff = Date.now() - 1; await janitor.maintain(env, pol); assert.ok(calls.length > n1, 'after the pause it tries again');
    });

    await test('a deposit visit is ONE deposit_many command with every kind (one window), results mapped back: moved kinds are done, a refused name or an empty stack is skipped, a full chest stops it', async () => {
        const calls = []; const stacks = ['aa', 'bb', 'cc', 'dd'].map((n) => ({ name: `create:${n}`, count: 64 }));
        const mk = (detail) => ({ inv: () => ({ items: [...stacks, ...Array.from({ length: 27 }, (_, i) => ({ name: `create:f${i}`, count: 64 }))], slotsFree: 5 }), pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 1, z: 0 }), w: { kindAt: () => 'air' },
            run: async (name, a) => { calls.push([name, a]); return { ok: true, detail: typeof detail === 'function' ? detail(a) : detail }; },
            exec: async () => { throw new Error('the per-item command must not be used'); } });
        const pol = janitor.pitPolicy({ depot: { kind: 'chest', x: 1, y: 1, z: 1 } });
        const e1 = mk((a) => ({ done: a.items.map((i) => ({ item: i.item, moved: i.count })), failed: [] }));
        const r1 = await janitor.maintain(e1, pol); assert.strictEqual(r1.ok, true); assert.strictEqual(calls.length, 1, 'one command, one window'); assert.strictEqual(calls[0][0], 'deposit_many');
        assert.ok(calls[0][1].items.length >= 13 && calls[0][1].items.every((i) => /^create:/.test(i.item) && i.count >= 1) && calls[0][1].x === 1, JSON.stringify(calls[0][1]).slice(0, 200));
        assert.strictEqual(r1.done.length, calls[0][1].items.length); assert.ok(r1.done.every((d) => d.to === '1,1,1'));
        const e2 = mk((a) => ({ done: a.items.slice(2).map((i) => ({ item: i.item, moved: i.count })), failed: [{ item: a.items[0].item, reason: 'invalid_args' }, { item: a.items[1].item, reason: 'missing_item' }] }));
        const r2 = await janitor.maintain(e2, pol); assert.strictEqual(r2.ok, true); assert.strictEqual(r2.skipped.length, 2); assert.strictEqual(r2.done.length, calls[1][1].items.length - 2);
        const e3 = mk(() => ({ done: [], failed: [{ item: 'create:aa', reason: 'not_confirmed' }] }));
        const r3 = await janitor.maintain(e3, pol); assert.strictEqual(r3.ok, false); assert.strictEqual(r3.reason, 'not_confirmed'); assert.ok(e3.depositBackoff > Date.now());
        const e4 = { ...mk(null), run: async () => ({ ok: false, reason: 'invalid_target', detail: { why: 'no container' } }) };
        const r4 = await janitor.maintain(e4, { ...pol, neverToss: 0 }); assert.ok(e4.badBoxes.has('1,1,1'), 'a depot that is no container is remembered');
    });

    await test('a small surplus (cobblestone above 64) makes no trip of its own; it goes along with a trip for room, or alone from three slots up; a thrown-away surplus stays', () => {
        const pol = janitor.pitPolicy({ depot: { kind: 'chest', x: 0, y: 0, z: 0 } });
        const few = [{ name: 'cobblestone', count: 100 }, { name: 'dirt', count: 10 }];
        assert.deepStrictEqual(janitor.plan(few, 20, pol), [], '36 extra cobblestone and free room: nothing to do');
        const big = janitor.plan([{ name: 'cobblestone', count: 64 + 3 * 64 }], 20, pol); assert.ok(big.some((o) => o.item === 'cobblestone' && o.why === 'surplus'), 'three slots of surplus: a trip');
        const room = janitor.plan([{ name: 'cobblestone', count: 100 }, ...Array.from({ length: 30 }, (_, i) => ({ name: `create:s${i}`, count: 64 }))], 2, pol);
        assert.ok(room.some((o) => o.why === 'surplus' && o.item === 'cobblestone') && room.some((o) => o.why === 'make_room'), 'with a trip for room the surplus goes too');
        const tossed = janitor.plan([{ name: 'dirt', count: 80 }], 20, { ...janitor.pitPolicy(), depot: null });
        assert.ok(tossed.every((o) => o.op === 'toss') && tossed.length >= 1, 'no depot: surplus is thrown away, trip-free, and kept');
    });

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('all health tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

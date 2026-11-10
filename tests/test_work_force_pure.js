// Pushing bots that do nothing (owner 2026-11-10): the decision of bot/force.js and the health counter. Pure, fake clock.
const assert = require('assert');
const { Force, isHigh } = require('../src/work/bot/force');
const { Health } = require('../src/work/service/health');

setTimeout(() => { console.error('test watchdog: still running after 20 s'); process.exit(2); }, 20000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const v = (o) => ({ working: true, act: 'unit', sub: null, stillMs: 0, high: true, now: 0, ...o });

(async () => {
    await test('a high bot that has not moved for 30 s and finished nothing falls; before that, nothing', () => {
        const f = new Force();
        assert.strictEqual(f.decide('a', v({ now: 100000, stillMs: 29000 })), null);
        const d = f.decide('a', v({ now: 100000, stillMs: 31000 }));
        assert.strictEqual(d.action, 'fall'); assert.strictEqual(d.cause, 'still');
    });
    await test('not for a bot that works, waits in a line, idles, has nothing to fall from, or finished a unit in the last 30 s', () => {
        const f = new Force();
        assert.strictEqual(f.decide('a', v({ now: 100000, stillMs: 60000, working: false })), null);
        for (const act of ['idle', 'line', 'chest', 'bed']) assert.strictEqual(f.decide('a', v({ now: 100000, stillMs: 60000, act })), null, act);
        assert.strictEqual(f.decide('a', v({ now: 100000, stillMs: 60000, act: 'unit', sub: 'line' })), null);
        assert.strictEqual(f.decide('a', v({ now: 100000, stillMs: 60000, high: false })), null, 'on the floor: only the error clock applies');
        f.unit('a', true, null, 90000);
        assert.strictEqual(f.decide('a', v({ now: 100000, stillMs: 60000 })), null, 'a unit finished 10 s ago');
        assert.strictEqual(f.decide('a', v({ now: 125000, stillMs: 60000 })).action, 'fall');
    });
    await test('after a fall the bot is left alone for 30 s; if it still has not moved it is killed (still_after_fall); one fall per bot per run', () => {
        const f = new Force();
        assert.strictEqual(f.decide('a', v({ now: 100000, stillMs: 31000 })).action, 'fall');
        f.did('a', 'fall', 100000);
        assert.strictEqual(f.decide('a', v({ now: 110000, stillMs: 40000 })), null);
        const k = f.decide('a', v({ now: 131000, stillMs: 61000 }));
        assert.strictEqual(k.action, 'kill'); assert.strictEqual(k.cause, 'still_after_fall');
        f.did('a', 'kill', 131000);
        assert.strictEqual(f.decide('a', v({ now: 200000, stillMs: 61000 })), null, 'killed: the clock starts again after the next unit');
        f.unit('a', true, null, 201000);   // it works again
        const g = new Force(); g.did('b', 'fall', 1000); g.unit('b', true, null, 5000);
        assert.strictEqual(g.decide('b', v({ now: 200000, stillMs: 40000 })).action, 'fall', 'a finished unit clears the second stage and 120 s have passed');
    });
    await test('errors: 60 s of failed units without one success kills; a success, a cancel, a need or a death does not count / resets', () => {
        const f = new Force();
        f.unit('a', false, 'unreachable', 1000); f.unit('a', false, 'cancelled', 20000); f.unit('a', false, 'missing_item', 25000); f.unit('a', false, 'wrong_dimension', 26000);
        assert.strictEqual(f.decide('a', v({ now: 50000, high: false })), null, '49 s');
        const d = f.decide('a', v({ now: 61000, high: false }));
        assert.strictEqual(d.action, 'kill'); assert.strictEqual(d.cause, 'errors:unreachable'); assert.ok(d.errorMs >= 60000);
        f.unit('a', true, null, 62000);
        assert.strictEqual(f.decide('a', v({ now: 130000, high: false })), null, 'a success stops the clock');
        f.unit('a', false, 'stuck', 131000); f.unit('a', false, 'died', 140000);
        assert.strictEqual(f.decide('a', v({ now: 200000, high: false })), null, 'a death resets');
        f.unit('a', false, 'stuck', 200000);
        assert.strictEqual(f.decide('a', v({ now: 260000, high: false })).action, 'kill');
        f.did('a', 'kill', 260000);
        assert.strictEqual(f.decide('a', v({ now: 261000, high: false })), null, 'the clock restarts at the next failure');
        // a bot cooling down (no worker, retired) counts as working for the caller; waiting activity does not shield errors
        assert.strictEqual(new Force({ errorMs: 5000 }).decide('x', v({ now: 9000, act: 'idle' })), null);
        const g = new Force({ errorMs: 5000 }); g.unit('x', false, 'stuck', 1000);
        assert.strictEqual(g.decide('x', v({ now: 10000, act: 'line' })).action, 'kill');
    });
    await test('isHigh: free air under the block the bot stands on (or under it when nothing is), at least 2; unknown chunks = no', () => {
        const col = (floor, support) => (x, y, z) => (y === support ? 'solid' : y <= floor ? 'solid' : 'air');
        const f = { x: 0, y: 50, z: 0 };
        assert.ok(isHigh(col(10, 49), f), 'a block under the feet and 38 free below');
        assert.ok(!isHigh(col(47, 49), f), 'one free cell only');
        assert.ok(isHigh(col(10, -99), f), 'nothing under the feet');
        assert.ok(!isHigh(col(48, 49), f), 'floor right below the block');
        assert.ok(!isHigh((x, y) => (y === 49 ? 'solid' : 'unknown'), f));
        assert.ok(!isHigh(() => 'solid', f));
    });
    await test('the health row counts forced pushes by kind and cause and says so in the line', () => {
        let t = 0; const h = new Health({ now: () => t });
        h.force('fall', 'still'); h.force('fall', 'still'); h.force('kill', 'errors');
        t += 60000;
        const { row, text } = h.flush({ bots: [] });
        assert.deepStrictEqual(row.forced, { 'fall:still': 2, 'kill:errors': 1 }); assert.ok(/FORCED fall:still 2, kill:errors 1/.test(text), text);
        t += 60000; assert.strictEqual(h.flush({ bots: [] }).row.forced, undefined, 'the window resets');
    });
})().catch((e) => { console.error(e); process.exit(1); });

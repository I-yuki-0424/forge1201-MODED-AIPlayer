'use strict';
// The pause table (src/build/pauses.js, TASK-20261125-081 owner list 5 Large 3.3): a gap of more than 0.5 s between two actions (a dig, a click, a moving tick) is a pause,
// classified by the labels the bot's code was under; a dig in progress is no pause; a failure turns the next pause into a retry; a long synchronous section of one bot is
// charged to the others. Negative controls: a short gap is no pause; a gap with movement is none.
const assert = require('assert');
const { EventEmitter } = require('events');
const PZ = require('../src/build/pauses');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeBot() {
    const b = new EventEmitter(); b.entity = { position: { x: 0, y: 64, z: 0 } }; b._client = { write() {} };
    return b;
}
const click = (b) => b._client.write('block_place', {});
const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms); };

(async () => {
    const a = fakeBot(), b = fakeBot();
    const stopA = PZ.attach(a, 'pzA'), stopB = PZ.attach(b, 'pzB');
    const n0 = PZ.list.length;
    await PZ.run('pzA', async () => {
        click(a);
        await PZ.sleep(650, 'wait: hand-over');             // a pause waiting for another bot
        click(a);
        await PZ.sleep(100, 'server: click');               // negative control: too short
        click(a);
        a._client.write('block_dig', { status: 0 }); await sleep(700); a._client.write('block_dig', { status: 2 });          // a dig in progress is work
        click(a);
        PZ.failed('no way'); await PZ.sleep(600, 'cpu: plan'); click(a);           // after a failure: a retry
    });
    const mine = PZ.list.slice(n0).filter((p) => p.bot === 'pzA');
    assert.strictEqual(mine.length, 2, JSON.stringify(mine));
    assert.strictEqual(mine[0].cls, 'bot'); assert.strictEqual(mine[0].top, 'wait: hand-over');
    assert.strictEqual(mine[1].cls, 'retry'); assert.strictEqual(mine[1].fail, 'no way');
    console.log('  ok a wait for another bot, a retry; a short gap and a dig are no pause');
    // a pause still open: how long, and the labels it is under (the stall report); an action closes it (negative control)
    await PZ.run('pzA', async () => {
        click(a);
        await PZ.within('walk', async () => { await sleep(120); const o = PZ.open('pzA'); assert.ok(o.ms >= 100 && o.stack.join() === 'walk', JSON.stringify(o)); });
        click(a); assert.ok(PZ.open('pzA').ms < 50, 'closed by the click');
    });
    assert.strictEqual(PZ.open('nobody'), null);
    console.log('  ok an open pause is seen live with its labels; an action closes it');
    // another bot's synchronous section: charged to this bot as cpu other
    await Promise.all([
        PZ.run('pzB', async () => { click(b); await PZ.sleep(800, 'other: idle'); click(b); }),
        PZ.run('pzA', async () => { await sleep(50); PZ.sync('claim', () => busy(600)); }),
    ]);
    const pb = PZ.list.slice(n0).filter((p) => p.bot === 'pzB' && p.top !== 'other: unlabelled');          // (its first gap, since it was attached, is unlabelled)
    assert.strictEqual(pb.length, 1, JSON.stringify(pb)); assert.strictEqual(pb[0].cls, 'cpu', JSON.stringify(pb[0])); assert(/cpu other: claim/.test(pb[0].top));
    console.log('  ok a long synchronous claim of one bot is a cpu pause of the other');
    // negative control: moving ticks are actions
    const n1 = PZ.list.length;
    await PZ.run('pzB', async () => { click(b); for (let i = 0; i < 14; i++) { b.entity.position.x += 0.2; b.emit('physicsTick'); await sleep(50); } click(b); });
    assert.strictEqual(PZ.list.slice(n1).filter((p) => p.bot === 'pzB').length, 0, 'walking is no pause');
    console.log('  ok moving ticks are actions');
    const t = PZ.table({ since: 0 });
    assert(t.byClass.bot && t.byClass.retry && t.byClass.cpu);
    stopA(); stopB();
    console.log('test_build_pauses_pure: 4 passed');
})().catch((e) => { console.error(e); process.exit(1); });

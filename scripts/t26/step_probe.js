'use strict';
// Debug: FROM=x,y,z then one action-layer move_to TO=x,y,z; prints the result with phases and the last trace rows.
const T = require('./lib');
(async () => {
    const n = 'Step' + T.WORLD, { S, svc } = await T.open([n]); const bot = svc.bots.get(n).bot;
    const [fx, fy, fz] = process.env.FROM.split(',').map(Number), [tx, ty, tz] = process.env.TO.split(',').map(Number);
    await S.must(`tp ${n} ${fx + 0.5} ${fy} ${fz + 0.5}`); await T.sleep(3000);
    const { execute } = require('../../src/skills');
    const r = await execute(bot, 'move_to', { x: tx, y: ty, z: tz }, { maxTicks: Number(process.env.TICKS || 300) });
    console.log(JSON.stringify({ ok: r.ok, reason: r.reason, detail: r.detail, phases: r.phases }).slice(0, 1500));
    console.log('trace', JSON.stringify((r.trace || []).slice(-8)));
    console.log('pos', bot.entity.position, 'onGround', bot.entity.onGround, 'preempt', bot.__preempt);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// Debug: put a bot at FROM=x,y,z (server tp), give the kit, walk it to TO=x,z[,y] with the walker (NAV_TRACE=1 for every step), print the result. A reproduction tool, not a test.
const T = require('./lib');
(async () => {
    const n = 'Walk' + T.WORLD, { S, svc } = await T.open([n]);
    const [fx, fy, fz] = process.env.FROM.split(',').map(Number), to = process.env.TO.split(',').map(Number);
    await S.must(`tp ${n} ${fx + 0.5} ${fy} ${fz + 0.5}`); await T.kit(S, n); await T.sleep(3000);
    const t = to.length === 3 ? { x: to[0], y: to[2], z: to[1] } : { x: to[0], z: to[1] };
    const r = await T.command(svc, n, 'journey', t, Number(process.env.LIMIT_MIN || 10));
    console.log('RESULT', JSON.stringify(r).slice(0, 1500), 'at', JSON.stringify(await T.posOf(S, n)));
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

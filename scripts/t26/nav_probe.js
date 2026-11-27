'use strict';
// Probe (TASK-075, 076's east-line case of move_a seed 7601): one bot's journey from X0,Z0 to X1,Z1 on Peaceful (movement only), the server-read end, the NAV result.
// scripts/t26/run.sh N nav_probe.js X0=640 Z0=7 X1=760 Z1=7 [LIMIT_MIN=15] [NAV_TRACE=1]
const T = require('./lib');
(async () => {
    const name = 'Nav' + T.WORLD, n = (k, d) => Number(process.env[k] ?? d);
    const { S, svc } = await T.open([name]);
    await T.onSurface(S, name, n('X0', 640), n('Z0', 7)); await T.kit(S, name); await T.sleep(3000);
    const t = { x: n('X1', 760), z: n('Z1', 7) };
    const r = await T.command(svc, name, 'journey', t, n('LIMIT_MIN', 15));
    const p = await T.posOf(S, name);
    console.log(`[nav_probe w${T.WORLD}] ${JSON.stringify({ from: [n('X0', 640), n('Z0', 7)], to: t, at: p && [p.x, p.y, p.z].map(Math.floor), off: p ? Math.round(Math.hypot(p.x - t.x, p.z - t.z)) : null, sec: r.sec, result: JSON.stringify(r.result || {}).slice(0, 600) })}`);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

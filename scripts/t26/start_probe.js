'use strict';
// Probe (TASK-20261125-079): move_a's start from given cells. The four bots are put at AT="x,y,z;x,y,z;..." (tp, after the kit) and sent 2000 blocks E/W/S/N
// like move_a; LIMIT_MIN game minutes each (default 1). Reports each journey's first result. Not a test: no grading.
//   scripts/t26/run.sh N start_probe.js AT="157,87,38;157,87,37;156,87,37;156,85,39" [LIMIT_MIN=1] [NAV_TRACE=1]
const T = require('./lib');
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 1);
const DIRS = [['E', 1, 0], ['W', -1, 0], ['S', 0, 1], ['N', 0, -1]], names = DIRS.map(([d]) => `Mv${d}${T.WORLD}`);
const AT = String(process.env.AT || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));

(async () => {
    const { S, svc } = await T.open(names, {}, 'normal');
    for (const n of names) await T.kit(S, n);
    for (const [i, n] of names.entries()) { const a = AT[i % AT.length]; await S.cmd(`forceload add ${a[0]} ${a[2]}`); await S.cmd(`tp ${n} ${a[0] + 0.5} ${a[1]} ${a[2] + 0.5}`); }
    await T.sleep(3000);
    await Promise.all(DIRS.map(async ([d, dx, dz], i) => {
        const n = names[i], b = svc.bots.get(n).bot, p0 = b.entity.position.clone();
        const t = { x: Math.floor(p0.x) + dx * 2000, z: Math.floor(p0.z) + dz * 2000 };
        const r = await T.command(svc, n, 'journey', t, LIMIT_MIN);
        const p = b.entity.position;
        console.log(`[probe] ${n} from ${p0.x.toFixed(1)},${p0.y.toFixed(1)},${p0.z.toFixed(1)} -> ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ${JSON.stringify(r.result).slice(0, 400)}`);
    }));
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

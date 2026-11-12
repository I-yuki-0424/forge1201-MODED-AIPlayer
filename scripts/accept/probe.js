'use strict';
// Terrain probe (debugging, test code): a spectator bot flies to X,Z and prints the surface height of the columns around it, north up. `~` = water on top, `L` = lava, `.` = not loaded.
//   ACC=1 scripts/accept/run.sh probe.js X=57 Z=-790 R=60 STEP=3
const Vec3 = require('vec3');
const L = require('../real/lib');
const X = Number(process.env.X || 0), Z = Number(process.env.Z || 0), R = Number(process.env.R || 60), STEP = Number(process.env.STEP || 3), A = process.env.BOTNAME || 'ProbeA';
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const bot = svc.bots.get(A).bot; S.name = A;
    await S.must(`gamemode spectator ${A}`); await S.must(`tp ${A} ${X} 200 ${Z}`); await L.sleep(8000);
    const top = (x, z) => { for (let y = 319; y >= -64; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) return { n: '.' }; if (b.name === 'air' || b.name === 'cave_air') continue; return { y, n: b.name }; } return { n: '.' }; };
    const rows = [];
    for (let z = Z - R; z <= Z + R; z += STEP) { let row = ''; for (let x = X - R; x <= X + R; x += STEP) { const t = top(x, z); row += t.n === '.' ? ' ..' : /water/.test(t.n) ? ' ~~' : /lava/.test(t.n) ? ' LL' : ` ${String(t.y % 100).padStart(2, '0')}`; } rows.push(row); }
    console.log(`[probe] around ${X},${Z} (north up, columns every ${STEP}, y mod 100)`); for (const r of rows) console.log(r);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

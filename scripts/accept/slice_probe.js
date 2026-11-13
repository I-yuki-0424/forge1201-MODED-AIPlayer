'use strict';
// Debugging probe (test code): a vertical slice of the world around X,Y,Z as characters (# solid, . air, ~ water, L lava, ? unknown), west to east at row Z (AXIS=x) or north to south at column X (AXIS=z).
//   ACC=1 scripts/accept/run.sh slice_probe.js X=-29 Y=40 Z=-1298 R=30 H=40 AXIS=x
const L = require('../real/lib');
const A = 'SliceA', X = Number(process.env.X), Y = Number(process.env.Y), Z = Number(process.env.Z), R = Number(process.env.R || 30), H = Number(process.env.H || 40), AXIS = process.env.AXIS || 'x';
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const bot = svc.bots.get(A).bot; S.name = A;
    await S.must(`gamemode spectator ${A}`); await S.must(`tp ${A} ${X} ${Y + 20} ${Z}`); await L.sleep(7000);
    const V = require('vec3'); const w = svc.envFactory(bot, { cancelled: false }, { worker: true }).w;
    console.log(`[slice] ${AXIS === 'x' ? 'west->east at z=' + Z : 'north->south at x=' + X}, centre ${X},${Y},${Z}`);
    for (let y = Y + H; y >= Y - H / 2; y--) {
        let row = String(y).padStart(4) + ' ';
        for (let d = -R; d <= R; d++) { const x = AXIS === 'x' ? X + d : X, z = AXIS === 'x' ? Z : Z + d; const k = w.kindAt(x, y, z); row += x === X && z === Z && y === Y ? '@' : k === 'solid' ? '#' : k === 'air' ? '.' : k === 'water' ? '~' : k === 'lava' ? 'L' : k === 'climb' ? 'H' : '?'; }
        console.log(row);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

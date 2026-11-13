'use strict';
// Debugging probe (test code): what the action layer's world model says about the columns around X,Z (kind and swimmable per level), with a bot standing next to them.
//   ACC=1 scripts/accept/run.sh column_probe.js X=-4 Z=-271 Y=62
const L = require('../real/lib');
const W = require('../../src/skills/world');
const { surface } = require('../../src/skills/intents');
const A = 'ColA', X = Number(process.env.X), Z = Number(process.env.Z), Y = Number(process.env.Y || 62);
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const bot = svc.bots.get(A).bot; S.name = A;
    await S.must(`gamemode spectator ${A}`); await S.must(`tp ${A} ${X} ${Y + 3} ${Z}`); await L.sleep(6000);
    const env = svc.envFactory(bot, { cancelled: false }, { worker: true }); const w = env.w;
    for (const [dx, dz] of [[0, 0], [10, 0], [0, 10], [-10, 0], [0, -10]]) {
        const x = X + dx, z = Z + dz, col = [];
        for (let y = Y + 3; y >= Y - 4; y--) col.push(`${y}:${w.kindAt(x, y, z)}${W.swimmable(w, x, y, z) ? '~' : ''}${W.standable(w, x, y, z) ? '_' : ''}`);
        console.log(`[col] ${x},${z} surface=${surface(w, x, z, 318)}  ${col.join(' ')}`);
    }
    if (process.env.LINE) for (let z = Z; z >= Z - Number(process.env.LINE); z -= 3) {
        const x = X, col = []; for (let y = Y + 2; y >= Y - 3; y--) col.push(`${y}:${w.kindAt(x, y, z)}${W.swimmable(w, x, y, z) ? '~' : ''}`);
        console.log(`[col] line ${x},${z}  ${col.join(' ')}`);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// Debugging probe (test code): the walk's trapped test (travel.hasExit) at a cell, with and without the open-sky condition, and what the sky test sees.   ACC=2 scripts/accept/run.sh exit_probe.js X=11 Y=112 Z=-39
const L = require('../real/lib');
const T = require('../../src/work/bot/travel');
const { reachableAsync } = require('../../src/skills/planner');
const A = 'ExitA', X = Number(process.env.X), Y = Number(process.env.Y), Z = Number(process.env.Z);
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const bot = svc.bots.get(A).bot; S.name = A;
    await S.must(`gamemode survival ${A}`); await L.tpIn(S, A, 'overworld', X + 0.5, Y, Z + 0.5); await L.sleep(9000);
    const env = svc.envFactory(bot, { cancelled: false }, { worker: true });
    const here = env.here(); console.log(`[exit] at ${JSON.stringify(here)}`);
    const r = await reachableAsync(env.w, here, { maxNodes: 3000, radius: 36 });
    console.log(`[exit] reach cells ${r.cells.length}; area-open ${await T.hasExit(env, here)}; with sky ${await T.hasExit(env, here, { sky: true })}`);
    const { surface } = require('../../src/skills/intents'); let n = 0, high = 0; const ex = [];
    for (const q of r.cells.filter((_, i) => i % 30 === 0)) { const t = surface(env.w, q[0], q[2], 318); n++; if (t !== null && t > q[1] + 2) { high++; if (ex.length < 3) ex.push([q[0], q[1], q[2], t]); } }
    console.log(`[exit] sampled ${n}, column top above the cell+2: ${high} e.g. ${JSON.stringify(ex)}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

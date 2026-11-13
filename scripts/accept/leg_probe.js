'use strict';
// Debugging probe (test code): in open water, run the journey's own leg logic one step at a time and print every candidate with the result of its move_to.
//   ACC=1 scripts/accept/run.sh leg_probe.js X=-4 Z=-271 TX=-21 TZ=-750
const L = require('../real/lib');
const T = require('../../src/work/bot/travel');
const { reachableAsync } = require('../../src/skills/planner');
const A = 'LegA', X = Number(process.env.X), Z = Number(process.env.Z), TX = Number(process.env.TX), TZ = Number(process.env.TZ);
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const bot = svc.bots.get(A).bot; S.name = A;
    await S.must(`gamemode survival ${A}`); await L.tpIn(S, A, 'overworld', X + 0.5, 64, Z + 0.5); await L.sleep(7000);
    bot.setControlState('jump', true); await L.sleep(3000); bot.setControlState('jump', false);
    const env = svc.envFactory(bot, { cancelled: false }, { worker: true });
    for (let i = 0; i < Number(process.env.STEPS || 4); i++) {
        const here = env.here(); const reach = await reachableAsync(env.w, { x: here.x, y: here.y, z: here.z }, { maxNodes: 3000, radius: 36 });
        console.log(`[leg] step ${i} at ${JSON.stringify(here)} reach cells ${reach.cells.length}`);
        let ok = false;
        for (const c of T.legCandidates(env.w, here, { x: TX, z: TZ }, { leg: 30, reach, visited: new Set() })) {
            const t0 = Date.now(), r = await env.exec('move_to', { x: c.x, y: c.y, z: c.z });
            console.log(`[leg]   ${c.why} -> ${c.x},${c.y},${c.z}: ${r.ok ? 'ok' : r.reason} ${Date.now() - t0} ms ${r.ok ? '' : JSON.stringify(r.detail).slice(0, 300)}  now ${JSON.stringify(env.here())}`);
            if (r.ok) { ok = true; break; }
        }
        if (!ok) break;
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

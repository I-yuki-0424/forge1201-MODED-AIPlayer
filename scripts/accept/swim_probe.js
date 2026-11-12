'use strict';
// Probe (debugging): a bot swims north across open water by `journey`; print its air and height every 3 s, and what cancels it. ACC=7 scripts/accept/run.sh swim_probe.js DIST=400
const L = require('../real/lib');
const A = 'SwimA', DIST = Number(process.env.DIST || 400);
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const rec = svc.bots.get(A), bot = rec.bot; S.name = A;
    await L.sleep(3000);
    const p0 = await L.posOf(S, A); console.log(`[swim] start ${Math.round(p0.x)},${Math.round(p0.y)},${Math.round(p0.z)}`);
    const r = await svc.runCommand({ bots: [A], command: 'journey', args: { x: Math.floor(p0.x), z: Math.floor(p0.z) - DIST } });
    let minAir = 20; const t0 = Date.now();
    const timer = setInterval(() => { const e = bot.entity; minAir = Math.min(minAir, bot.oxygenLevel ?? 20); console.log(`[swim] ${Math.round((Date.now() - t0) / 1000)} s y=${e.position.y.toFixed(1)} z=${Math.round(e.position.z)} air=${bot.oxygenLevel} inWater=${e.isInWater} cmd=${rec.cmd && rec.cmd.status}`); }, 3000);
    while (rec.cmd && rec.cmd.status === 'running' && Date.now() - t0 < 300000) await L.sleep(1000);
    clearInterval(timer);
    console.log(`[swim] ended ${JSON.stringify(rec.cmd && rec.cmd.result)} minAir ${minAir}`);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

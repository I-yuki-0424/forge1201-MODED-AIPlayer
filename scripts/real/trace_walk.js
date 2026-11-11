'use strict';
// Diagnostic: ONE learned walk (walk3) on the real copy with every decision traced: where the policy goes, what the action layer answers. Test code.
//   scripts/real/run.sh trace_walk.js DIM=end START=92,40,4 TARGET=92,49,7 [NEAR=0] [PACK=64]
// START must be a standable cell (the bot is put there), TARGET the cell to reach. Prints one line per decision and the verdict from the server's position.
const L = require('./lib');
const walk = require('../../src/experts/move3/walk');
const DIM = process.env.DIM || 'end', A = process.env.BOTNAME || 'RealT';
const [sx, sy, sz] = process.env.START.split(',').map(Number), [tx, ty, tz] = process.env.TARGET.split(',').map(Number);
async function main() {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A]);
    const bot = svc.bots.get(A).bot; S.name = A;
    await S.must(`execute in ${L.dimId(DIM)} run forceload add 40 -20 130 60`);
    await S.must(`clear ${A}`); await S.must(`give ${A} minecraft:cobblestone ${process.env.PACK || 64}`); await S.must(`give ${A} minecraft:iron_pickaxe 1`);
    await S.must(`gamemode survival ${A}`);
    await L.tpIn(S, A, DIM, sx + 0.5, sy, sz + 0.5); await L.sleep(3000);
    const cancel = { cancelled: false }, env = svc.envFactory(bot, cancel, { worker: true });
    env.within = { x0: 64, x1: 95, z0: 0, z1: 31, top: 70, bottom: 1 };
    const t0 = Date.now(), timer = setTimeout(() => { cancel.cancelled = true; }, 150000);
    console.log(`[trace] start ${sx},${sy},${sz} (bot at ${JSON.stringify(env.here())}) target ${tx},${ty},${tz}`);
    const r = await walk.walk3(Object.assign(Object.create(env), { cancel }), { x: tx, y: ty, z: tz }, { near: Number(process.env.NEAR || 0), nearY: Number(process.env.NEARY || 0), trace: (e) => console.log(`[trace] ${e.t} ${e.action} ${e.from.x},${e.from.y},${e.from.z} -> ${e.to.x},${e.to.y},${e.to.z} ${e.ok ? 'ok' : 'FAIL ' + e.reason + ' ' + JSON.stringify(e.detail || {}).slice(0, 150)} (${e.ms} ms) [${e.valid}]`) });
    clearTimeout(timer);
    const p = await L.posOf(S, A);
    console.log(`[trace] result ${JSON.stringify({ ok: r.ok, reason: r.reason, detail: r.detail, move3: r.move3 }).slice(0, 400)}; server position ${p && [p.x, p.y, p.z].map((v) => v.toFixed(1))}; ${Math.round((Date.now() - t0) / 1000)} s`);
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });

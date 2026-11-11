'use strict';
// REAL-WORLD pit check: the owner's pit job (the End box of console job j37/j38 by default) run through the SAME WorkService the console uses, on the play world's copy, for
// MIN minutes; the verdict comes from the console's own health rows (units done / failed by reason / forced kills) AND from the server (blocks left in the box). Test code.
//   scripts/real/run.sh real_pit.js BOTS=4 MIN=10 LIVE_OUT=/out/pit1.json
// Env: BOTS (default 4), MIN (minutes, default 10), BOX "x0,z0,x1,z1,top,bottom" (default 64,0,95,31,70,1), DIM (default end), KIT (cobblestone count in the pack, default 64).
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const BOTS = Number(process.env.BOTS || 4), MIN = Number(process.env.MIN || 10), DIM = process.env.DIM || 'end', KIT = Number(process.env.KIT || 64);
const [x0, z0, x1, z1, top, bottom] = (process.env.BOX || '64,0,95,31,70,1').split(',').map(Number);

async function main() {
    const { shared, S } = await L.connectRcon();
    const names = [...Array(BOTS).keys()].map((i) => `RealP${i + 1}`);
    const svc = await L.openService(shared, names);
    // the same arrival the console gives them: the obsidian platform of the End (100,49,0); the Overworld bots would have walked through the portal
    const dimId = L.dimId(DIM);
    await S.must(`execute in ${dimId} run forceload add ${x0 - 16} ${z0 - 16} ${x1 + 16} ${z1 + 16}`);
    for (const n of names) {
        await S.must(`gamemode survival ${n}`); await S.must(`clear ${n}`); await S.must(`effect clear ${n}`);
        await S.must(`give ${n} minecraft:diamond_pickaxe 3`); await S.must(`give ${n} minecraft:cobblestone ${KIT}`); await S.must(`give ${n} minecraft:bread 16`);
        if (DIM === 'end') await L.tpIn(S, n, 'end', 100.5, 49, 0.5);
    }
    await L.sleep(3000);
    const before = {};
    const count = async (what) => { const o = await S.cmd(`execute in ${dimId} run fill ${x0} ${bottom} ${z0} ${x1} ${top} ${z1} minecraft:air replace ${what}`); const m = /Successfully filled (\d+)/.exec(o); return m ? Number(m[1]) : 0; };
    // (the count empties the cells: it is done at the END; at the start the same numbers come from the region files, see count_box.js in the notes)
    const job = svc.createPit({ name: 'real pit', dim: DIM, box: { x0, z0, x1, z1, top, bottom }, lanes: BOTS, method: 'expert', road: false, bots: names });
    console.log(`[real-pit] job ${job.id} ${JSON.stringify({ x0, z0, x1, z1, top, bottom })} ${DIM}, ${BOTS} bots, ${MIN} min`);
    svc.startJob(job.id);
    const t0 = Date.now();
    const snap = () => { const j = svc.status().jobs.find((q) => q.id === job.id); return j && j.progress ? JSON.stringify(j.progress).slice(0, 200) : ''; };
    while (Date.now() - t0 < MIN * 60000) { await L.sleep(30000); console.log(`[real-pit] ${Math.round((Date.now() - t0) / 1000)} s ${snap()}`); }
    svc.pauseJob(job.id); await L.sleep(3000);
    // ---- verdict from the console's own health log
    const file = path.join(svc.o.dataDir, 'health.jsonl');
    const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const tot = { done: 0, failed: 0, fail: {}, forced: {}, botSecOk: 0, botSecFail: 0, died: 0 };
    for (const r of rows) { tot.done += r.done || 0; tot.failed += r.failed || 0; tot.botSecOk += (r.botSec || {}).ok || 0; tot.botSecFail += (r.botSec || {}).fail || 0; for (const [k, v] of Object.entries(r.fail || {})) tot.fail[k] = (tot.fail[k] || 0) + v; for (const [k, v] of Object.entries(r.forced || {})) tot.forced[k] = (tot.forced[k] || 0) + v; }
    const attempts = tot.done + tot.failed, stuckish = (tot.fail.unreachable || 0) + (tot.fail.stuck || 0) + (tot.fail.died || 0) + (tot.fail.not_confirmed || 0);
    const left = { end_stone: await count('minecraft:end_stone'), cobblestone: await count('minecraft:cobblestone') };
    const prog = svc.status().jobs.find((q) => q.id === job.id);
    const out = { kind: 'real-pit', dim: DIM, box: { x0, z0, x1, z1, top, bottom }, bots: BOTS, minutes: MIN, units_done: tot.done, units_failed: tot.failed, attempts, stuck_failure_rate: attempts ? stuckish / attempts : null, wilson95: L.wilson(stuckish, attempts), bot_seconds_ok: tot.botSecOk, bot_seconds_failing: tot.botSecFail, failures: tot.fail, forced: tot.forced, left_in_box_after: left, progress: prog && prog.progress, health_rows: rows.length };
    console.log(`[real-pit] units done ${tot.done}, failed ${tot.failed} ${JSON.stringify(tot.fail)}; stuck-type failures ${L.pct(stuckish, attempts)}; forced ${JSON.stringify(tot.forced)}; bot time failing ${tot.botSecFail} s vs ok ${tot.botSecOk} s; left in the box ${JSON.stringify(left)}`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(out, null, 1));
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });

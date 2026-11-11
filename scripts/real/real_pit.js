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
    }
    await L.sleep(3000);
    const before = {};
    // `fill` takes at most 32,768 blocks: slices of 8 levels (a first version counted the whole 71,680-cell box in one command, was refused, and reported 0 blocks left)
    const count = async (what) => { let n = 0; for (let y = bottom; y <= top; y += 8) { const o = await S.cmd(`execute in ${dimId} run fill ${x0} ${y} ${z0} ${x1} ${Math.min(top, y + 7)} ${z1} minecraft:air replace ${what}`); const m = /Successfully filled (\d+)/.exec(o); if (m) n += Number(m[1]); else if (!/No blocks were filled/.test(o)) throw new Error(`count refused: ${o}`); } return n; };
    // (the count empties the cells: it is done at the END; at the start the same numbers come from the region files, see count_box.js in the notes)
    // The gate: bots reach the End one at a time (production: through the portal, every arrival on the same platform spot). STAGGER seconds between two arrivals (default 12); the first is put there now.
    const STAGGER = Number(process.env.STAGGER || 12), arrive = async (n) => { if (DIM === 'end') await L.tpIn(S, n, 'end', 100.5, 49, 0.5); };
    await arrive(names[0]);
    const job = svc.createPit({ name: 'real pit', dim: DIM, box: { x0, z0, x1, z1, top, bottom }, lanes: BOTS, method: 'expert', road: false, bots: names });
    console.log(`[real-pit] job ${job.id} ${JSON.stringify({ x0, z0, x1, z1, top, bottom })} ${DIM}, ${BOTS} bots, ${MIN} min`);
    svc.startJob(job.id);
    const t0 = Date.now();
    names.slice(1).forEach((n, i) => setTimeout(() => arrive(n).catch(() => {}), (i + 1) * STAGGER * 1000));
    // Station-level accounting from the unit results themselves: stations attempted, stations that could not be stood on, per unit.
    const unitRows = [], origUnit = svc.health.unit.bind(svc.health);
    svc.health.unit = (d) => { const e = (d.detail && d.detail.expert) || {}; unitRows.push({ t: Math.round((Date.now() - t0) / 1000), ok: !!d.ok, reason: d.reason || null, stage: (d.detail && d.detail.stage) || null, ms: d.ms, stations: e.stations || 0, station_fails: e.fails || 0, hops: e.hops || 0, cells: e.cells || 0, mined: (d.detail && d.detail.mined) || 0, skipped: (d.detail && d.detail.skipped) || 0 }); origUnit(d); };
    // The gate: production bots that die respawn in the Overworld and are walked back through the tagged End portal (and restock at the tools chest). This server has no tagged portal, so the
    // harness does the same by hand: a bot that is dead or outside the job's dimension is put on the arrival platform with a fresh kit. Every such return is counted as a death.
    let deaths = 0, returns = 0; const dead = new Set();
    const trail = new Map(names.map((n) => [n, []])), deathLog = [];
    const phases = new Map(names.map((n) => [n, []]));
    const sampler = setInterval(() => { for (const n of names) { const rec = svc.bots.get(n), b = rec.bot; if (b && b.entity) { const t = trail.get(n); t.push([Date.now() - t0, +b.entity.position.x.toFixed(1), +b.entity.position.y.toFixed(1), +b.entity.position.z.toFixed(1), b.entity.onGround ? 1 : 0]); if (t.length > 12) t.shift(); const ph = rec.phase && rec.phase.name, pl = phases.get(n); if (ph && pl[pl.length - 1] !== ph) { pl.push(ph); if (pl.length > 8) pl.shift(); } } } }, 500);
    for (const n of names) svc.bots.get(n).bot.on('death', () => { deaths++; deathLog.push({ bot: n, at_s: Math.round((Date.now() - t0) / 1000), last_positions: trail.get(n).slice(-8), phases: phases.get(n).slice(-6), others: names.filter((q) => q !== n).map((q) => { const e = svc.bots.get(q).bot.entity; return e ? [q, +e.position.x.toFixed(1), +e.position.y.toFixed(1), +e.position.z.toFixed(1)] : [q]; }), act: (svc.bots.get(n).act && (svc.bots.get(n).act.sub ? svc.bots.get(n).act.sub.name : svc.bots.get(n).act.name)) || null }); });
    const gate = setInterval(async () => {
        for (const n of names) {
            const rec = svc.bots.get(n), b = rec && rec.bot; if (!b || !b.entity || dead.has(n)) continue;
            const dim = b.game && b.game.dimension;
            if (dim && !String(dim).includes(DIM === 'end' ? 'the_end' : DIM)) {
                dead.add(n);
                try { await S.must(`clear ${n}`); await S.must(`give ${n} minecraft:diamond_pickaxe 3`); await S.must(`give ${n} minecraft:cobblestone ${KIT}`); await S.must(`give ${n} minecraft:bread 16`); await L.tpIn(S, n, DIM, 100.5, 49, 0.5); returns++; }
                catch (_) { /* tried again at the next tick */ } finally { dead.delete(n); }
            }
        }
    }, 4000);
    const snap = () => { const j = svc.status().jobs.find((q) => q.id === job.id); return j && j.progress ? JSON.stringify(j.progress).slice(0, 200) : ''; };
    while (Date.now() - t0 < MIN * 60000) { await L.sleep(30000); console.log(`[real-pit] ${Math.round((Date.now() - t0) / 1000)} s ${snap()}`); }
    clearInterval(gate); clearInterval(sampler); svc.pauseJob(job.id); await L.sleep(3000);
    // ---- verdict from the console's own health log
    const file = path.join(svc.o.dataDir, 'health.jsonl');
    const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const tot = { done: 0, failed: 0, fail: {}, forced: {}, botSecOk: 0, botSecFail: 0, died: 0 };
    for (const r of rows) { tot.done += r.done || 0; tot.failed += r.failed || 0; tot.botSecOk += (r.botSec || {}).ok || 0; tot.botSecFail += (r.botSec || {}).fail || 0; for (const [k, v] of Object.entries(r.fail || {})) tot.fail[k] = (tot.fail[k] || 0) + v; for (const [k, v] of Object.entries(r.forced || {})) tot.forced[k] = (tot.forced[k] || 0) + v; }
    const attempts = tot.done + tot.failed, stuckish = (tot.fail.unreachable || 0) + (tot.fail.stuck || 0) + (tot.fail.died || 0) + (tot.fail.not_confirmed || 0);
    const left = { end_stone: await count('minecraft:end_stone'), cobblestone: await count('minecraft:cobblestone') };
    const prog = svc.status().jobs.find((q) => q.id === job.id);
    const real = unitRows.filter((u) => u.ok ? u.ms >= 300 : !['cancelled', 'wrong_dimension'].includes(u.reason));
    const stations = real.reduce((a, u) => a + u.stations, 0), stationFails = real.reduce((a, u) => a + u.station_fails, 0), minedCells = real.reduce((a, u) => a + u.mined, 0);
    const out = { stations, station_fails: stationFails, station_fail_rate: stations ? stationFails / stations : null, station_wilson95: L.wilson(stationFails, stations), cells_mined_by_units: minedCells, units: unitRows, kind: 'real-pit', dim: DIM, box: { x0, z0, x1, z1, top, bottom }, bots: BOTS, minutes: MIN, units_done: tot.done, units_failed: tot.failed, attempts, stuck_failure_rate: attempts ? stuckish / attempts : null, wilson95: L.wilson(stuckish, attempts), bot_seconds_ok: tot.botSecOk, bot_seconds_failing: tot.botSecFail, deaths, gate_returns: returns, death_log: deathLog, failures: tot.fail, forced: tot.forced, left_in_box_after: left, progress: prog && prog.progress, health_rows: rows.length };
    console.log(`[real-pit] stations ${stations}, could not stand on ${L.pct(stationFails, stations)}; cells dug by finished/failed units ${minedCells}`);
    console.log(`[real-pit] units done ${tot.done}, failed ${tot.failed} ${JSON.stringify(tot.fail)}; stuck-type failures ${L.pct(stuckish, attempts)}; forced ${JSON.stringify(tot.forced)}; deaths ${deaths} (returned through the gate ${returns}); bot time failing ${tot.botSecFail} s vs ok ${tot.botSecOk} s; left in the box ${JSON.stringify(left)}`);
    if (process.env.LIVE_OUT) {
        fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(out, null, 1));
        const dir = process.env.LIVE_OUT.replace(/\.json$/, '') + '.data'; fs.mkdirSync(dir, { recursive: true });
        for (const f of ['problems.jsonl', 'health.jsonl', 'forced.jsonl']) { try { fs.copyFileSync(path.join(svc.o.dataDir, f), path.join(dir, f)); } catch (_) { /* none written */ } }
    }
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });

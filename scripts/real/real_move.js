'use strict';
// REAL-WORLD movement check: random start cell and random target cell in the NATURAL terrain of the play world's copy (real seed, real biomes, trees, water, cliffs),
// the bot walks with the production chain (`env.travel`: learned walk, router, legs, experts), and is graded by the SERVER's position. Test code.
//   scripts/real/run.sh real_move.js N=40 SEED=1 DIM=overworld DIST=20,40,80,150 LIVE_OUT=/out/move1.json
// Env: N trials, SEED (the harness's own random numbers: starts, headings; the WORLD's seed is the play world's), DIM overworld|end, DIST distances to draw from, RANGE (starts within
//      +-RANGE of the world spawn, default 4000), TRIAL_S (wall limit = TRIAL_S + 3 s per block of distance, default 60), CONTROL=noop (the bot stands still: must score 0),
//      ARRIVE (blocks across that count as arrived, default 3.5), BOTNAME,
//      START_BOX / TARGET_BOX "x0,z0,x1,z1": draw the start / the target column from that box instead of the whole play world (the End pit: DIM=end START_BOX=100,0,100,0 TARGET_BOX=64,0,95,31,
//      the bot starts on the entry platform and walks to real standable cells of the pit's volume, which floats in the void).
const fs = require('fs');
const L = require('./lib');

const N = Number(process.env.N || 20), SEED = Number(process.env.SEED || 1), DIM = process.env.DIM || 'overworld';
const DIST = (process.env.DIST || '20,40,80,150').split(',').map(Number), RANGE = Number(process.env.RANGE || 4000), BASE_S = Number(process.env.TRIAL_S || 60);
const SBOX = process.env.START_BOX ? process.env.START_BOX.split(',').map(Number) : null, TBOX = process.env.TARGET_BOX ? process.env.TARGET_BOX.split(',').map(Number) : null;
const ARRIVE = Number(process.env.ARRIVE || 3.5), CONTROL = process.env.CONTROL || '', A = process.env.BOTNAME || 'RealA';

async function main() {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A]);
    const bot = svc.bots.get(A).bot;
    S.name = A;
    await S.must(`gamerule doImmediateRespawn true`); await S.must('time set day');
    const cancel = { cancelled: false };
    let deaths = 0; bot.on('death', () => { deaths++; });
    const env = svc.envFactory(bot, cancel, { worker: true });
        const rnd = L.rng(SEED);

    const standCell = (x, z) => L.standCell(S, bot, A, DIM, x, z);

    const rows = [], t00 = Date.now();
    let attempts = 0;
    while (rows.length < N && attempts++ < N * 12) {
        // start: a random column; the first trial of a bot also needs the dimension
        const inBox = (b) => [b[0] + Math.floor(rnd() * (b[2] - b[0] + 1)), b[1] + Math.floor(rnd() * (b[3] - b[1] + 1))];
        const [sx, sz] = SBOX ? inBox(SBOX) : [Math.round((rnd() - 0.5) * 2 * (DIM === 'end' ? 60 : RANGE)), Math.round((rnd() - 0.5) * 2 * (DIM === 'end' ? 60 : RANGE))];
        const st = await standCell(sx, sz); if (!st) continue;
        let D = DIST[Math.floor(rnd() * DIST.length)], tx, tz;
        if (TBOX) { [tx, tz] = inBox(TBOX); D = Math.round(Math.hypot(tx - sx, tz - sz)); } else { const ang = rnd() * 2 * Math.PI; tx = Math.round(sx + D * Math.cos(ang)); tz = Math.round(sz + D * Math.sin(ang)); }
        const tg = await standCell(tx, tz); if (!tg) continue;
        if (Math.abs(tg.y - st.y) > 40 && DIM !== 'end') { /* a cliff of 40+ levels is allowed but logged */ }
        // equip as the production bots are: a pack of cobblestone and a pickaxe, full health
        await S.must(`clear ${A}`); await S.must(`effect clear ${A}`);
        await S.must(`give ${A} minecraft:cobblestone 64`); await S.must(`give ${A} minecraft:iron_pickaxe 1`); await S.must(`give ${A} minecraft:bread 8`);
        await L.tpIn(S, A, DIM, st.x + 0.5, st.y, st.z + 0.5); await S.must(`gamemode survival ${A}`);
        await L.sleep(1800);
        for (let i = 0; i < 40 && !(bot.health > 0 && bot.entity); i++) await L.sleep(250);
        cancel.cancelled = false;
        const limitS = BASE_S + 3 * D, deaths0 = deaths, t0 = Date.now();
        const timer = setTimeout(() => { cancel.cancelled = true; }, limitS * 1000);
        let minD = Infinity, res;
        const sampler = setInterval(() => { const p = bot.entity && bot.entity.position; if (p) minD = Math.min(minD, Math.hypot(p.x - (tg.x + 0.5), p.z - (tg.z + 0.5))); }, 500);
        try { res = CONTROL === 'noop' ? (await L.sleep(limitS > 20 ? 20000 : limitS * 1000), { ok: false, reason: 'noop' }) : await env.travel({ x: tg.x, y: tg.y, z: tg.z }, { near: 2, nearY: 3 }); }
        catch (e) { res = { ok: false, reason: 'exception', detail: { message: String(e && e.message).slice(0, 120) } }; }
        clearTimeout(timer); clearInterval(sampler);
        const p = await L.posOf(S, A), died = deaths > deaths0;
        const dx = p ? Math.hypot(p.x - (tg.x + 0.5), p.z - (tg.z + 0.5)) : null, dy = p ? p.y - tg.y : null;
        const arrived = !!p && !died && dx <= ARRIVE && Math.abs(dy) <= 3.5;                          // THE grade: the server's position
        const row = { i: rows.length, dim: DIM, start: st, target: tg, dist: D, dy_plan: tg.y - st.y, ok: arrived, said_ok: !!res.ok, reason: res.reason || null, final_dist: dx === null ? null : Math.round(dx * 10) / 10, final_dy: dy === null ? null : Math.round(dy * 10) / 10, min_dist: Math.round(minD * 10) / 10, died, s: Math.round((Date.now() - t0) / 1000), limit_s: limitS, detail: res.detail ? JSON.stringify(res.detail).slice(0, 220) : null, floor: [st.floor, tg.floor] };
        rows.push(row);
        console.log(`[real-move] #${row.i} D=${D} dy=${row.dy_plan} ${arrived ? 'ARRIVED' : 'FAIL'} said=${row.said_ok ? 'ok' : res.reason} final=${row.final_dist} min=${row.min_dist} ${died ? 'DIED ' : ''}${row.s}s ${row.detail || ''}`);
    }
    const k = rows.filter((r) => r.ok).length, within20 = rows.filter((r) => r.final_dist !== null && r.final_dist <= 20).length, lied = rows.filter((r) => r.said_ok && !r.ok).length;
    const byD = {}; for (const r of rows) { const key = TBOX ? (r.dist < 20 ? '<20' : r.dist < 40 ? '20-40' : '40+') : r.dist; const b = (byD[key] = byD[key] || { n: 0, k: 0 }); b.n++; if (r.ok) b.k++; }
    const reasons = {}; for (const r of rows.filter((r) => !r.ok)) { const key = r.died ? 'died' : r.reason || 'timeout'; reasons[key] = (reasons[key] || 0) + 1; }
    const out = { kind: 'real-move', world: 'play-world copy (seed from level.dat)', dim: DIM, seed: SEED, control: CONTROL || null, n: rows.length, arrived: k, rate: rows.length ? k / rows.length : 0, wilson95: L.wilson(k, rows.length), within20: within20, said_ok_but_not_there: lied, by_distance: byD, failure_reasons: reasons, wall_s: Math.round((Date.now() - t00) / 1000), rows };
    console.log(`[real-move] ${DIM} ${CONTROL ? 'CONTROL ' + CONTROL : ''} movement success ${L.pct(k, rows.length)}; within 20 blocks at the end: ${L.pct(within20, rows.length)}; said ok but was not there: ${lied}; by distance ${JSON.stringify(byD)}; failures ${JSON.stringify(reasons)}`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(out, null, 1));
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });

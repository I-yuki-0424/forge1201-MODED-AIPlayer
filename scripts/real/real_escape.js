'use strict';
// REAL-WORLD escape check: the bot is put in a place where it is really stuck and must get out by itself with the production code (`env.expertEscape`, the stuck-escape expert, then the
// recovery ladder `env.recover` and `env.travel`, no server moves: setting teleport is off). Graded by the SERVER's position. Test code.
//   scripts/real/run.sh real_escape.js FAMILY=cave N=30 SEED=3 LIVE_OUT=/out/escape-cave.json
//   scripts/real/run.sh real_escape.js FAMILY=recorded N=30 LIVE_OUT=/out/escape-rec.json
// FAMILY=cave      random columns of the play world; the start is a natural cave, ravine or tunnel cell 10+ blocks under the surface (a roof over it); escaped = standing within 2 levels of the
//                  surface of that column's neighbourhood (open sky) and alive, within LIMIT_S seconds. The goal cell the expert is given is the standable surface cell above.
// FAMILY=recorded  the cells where the live bots were really recorded stuck (console problems.jsonl: still, forced_fall, forced_kill, unit_failed with a station that could not be reached)
//                  in the copy of the world (End pit region), N of them at random; escaped = within 3 blocks of the entry platform (100, 49, 0) or of the station when it can be stood on.
// Env: N, SEED, FAMILY, LIMIT_S (default 120), RANGE (cave columns within +-RANGE, default 3000), CONTROL=noop (stands still: must score 0), BOTNAME.
const fs = require('fs');
const L = require('./lib');

const N = Number(process.env.N || 20), SEED = Number(process.env.SEED || 1), FAMILY = process.env.FAMILY || 'cave', LIMIT_S = Number(process.env.LIMIT_S || 120);
const RANGE = Number(process.env.RANGE || 3000), CONTROL = process.env.CONTROL || '', A = process.env.BOTNAME || 'RealE';

async function main() {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A]);
    const bot = svc.bots.get(A).bot, Vec3 = require('vec3');
    S.name = A;
    await S.must('gamerule doImmediateRespawn true'); await S.must('time set day');
    const cancel = { cancelled: false };
    let deaths = 0; bot.on('death', () => { deaths++; });
    const env = svc.envFactory(bot, cancel, { worker: true });
    const rnd = L.rng(SEED), rows = [], t00 = Date.now();

    // ---- the places
    const places = [];
    if (FAMILY === 'recorded') {
        const seen = new Set(), recs = fs.readFileSync('/console/problems.jsonl', 'utf8').split('\n').filter(Boolean).slice(-60000).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        for (const r of recs) {
            if (!r.pos || !r.cell || !['still', 'forced_fall', 'forced_kill', 'unit_failed'].includes(r.kind)) continue;
            if (r.kind === 'unit_failed' && !(r.reason === 'unreachable' || r.reason === 'stuck')) continue;
            if (!(r.cell[0] >= 40 && r.cell[0] <= 130 && r.cell[2] >= -30 && r.cell[2] <= 60 && r.cell[1] >= 20 && r.cell[1] <= 80)) continue;      // the End pit's neighbourhood
            const k = r.cell.join(','); if (seen.has(k)) continue; seen.add(k); places.push({ cell: r.cell, kind: r.kind, below: r.below, target: r.target || null });
        }
        for (let i = places.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [places[i], places[j]] = [places[j], places[i]]; }
        console.log(`[real-escape] ${places.length} distinct recorded stuck cells in the pit's neighbourhood`);
    }

    let attempts = 0;
    while (rows.length < N && attempts++ < N * 15) {
        let start, goal, label;
        if (FAMILY === 'cave') {
            const x = Math.round((rnd() - 0.5) * 2 * RANGE), z = Math.round((rnd() - 0.5) * 2 * RANGE);
            const sc = await L.standCell(S, bot, A, 'overworld', x, z); if (!sc) continue;
            // a natural cell 10..60 blocks under that surface: air for the body, a full block under the feet, a roof of rock above, found by scanning the loaded column
            const cands = [];
            for (let y = sc.y - 10; y >= Math.max(-58, sc.y - 70); y--) {
                if (!L.standableAt(bot, x, y, z)) continue;
                let roof = false; for (let d = 2; d <= 6; d++) { const b = bot.blockAt(new Vec3(x, y + d, z)); if (b && b.boundingBox === 'block') { roof = true; break; } }
                if (roof) cands.push(y);
            }
            if (!cands.length) {                                                      // the exact column has no cave: look at the neighbouring columns of the same chunk
                for (let dx = -6; dx <= 6 && !cands.length; dx += 3) for (let dz = -6; dz <= 6 && !cands.length; dz += 3) for (let y = sc.y - 10; y >= Math.max(-58, sc.y - 70); y--) {
                    if (!L.standableAt(bot, x + dx, y, z + dz)) continue;
                    let roof = false; for (let d = 2; d <= 6; d++) { const b = bot.blockAt(new Vec3(x + dx, y + d, z + dz)); if (b && b.boundingBox === 'block') { roof = true; break; } }
                    if (roof) { cands.push(y); start = { x: x + dx, y, z: z + dz }; break; }
                }
            } else start = { x, y: cands[Math.floor(rnd() * cands.length)], z };
            if (!start) continue;
            goal = { x: sc.x, y: sc.y, z: sc.z }; label = { depth: sc.y - start.y };
        } else {
            const p = places[attempts % Math.max(1, places.length)]; if (!p) break;
            start = { x: p.cell[0], y: p.cell[1], z: p.cell[2] }; goal = { x: 100, y: 49, z: 0 }; label = { kind: p.kind, below: p.below };
            await S.must(`gamemode spectator ${A}`); await L.tpIn(S, A, 'end', start.x + 0.5, start.y + 6, start.z + 0.5); await L.sleep(1500);
            if (!L.standableAt(bot, start.x, start.y, start.z)) continue;            // the copy does not hold that cell any more (it is older than the record): skip, never invent
        }
        await S.must(`clear ${A}`); await S.must(`effect clear ${A}`);
        await S.must(`give ${A} minecraft:cobblestone 64`); await S.must(`give ${A} minecraft:iron_pickaxe 1`); await S.must(`give ${A} minecraft:bread 8`);
        await L.tpIn(S, A, FAMILY === 'cave' ? 'overworld' : 'end', start.x + 0.5, start.y, start.z + 0.5); await S.must(`gamemode survival ${A}`);
        await L.sleep(1800);
        for (let i = 0; i < 40 && !(bot.health > 0 && bot.entity); i++) await L.sleep(250);
        cancel.cancelled = false;
        const deaths0 = deaths, t0 = Date.now(), timer = setTimeout(() => { cancel.cancelled = true; }, LIMIT_S * 1000);
        let res = { ok: false, reason: 'noop' }, steps = 0;
        if (CONTROL !== 'noop') {
            // The production way out, as the worker's ladder uses it: the stuck-escape expert toward the known good place first, then the fixes of the ladder (jump, sidestep, wait ...) and the
            // walk to the good place, again and again until the time is up. No server move (teleport off).
            try {
                while (!cancel.cancelled && Date.now() - t0 < LIMIT_S * 1000) {
                    const p = bot.entity && bot.entity.position, d = p ? Math.hypot(p.x - (goal.x + 0.5), p.z - (goal.z + 0.5)) : 1e9;
                    const arrivedNow = FAMILY === 'cave' ? p && p.y >= goal.y - 2 : p && d <= 3 && Math.abs(p.y - goal.y) <= 3;
                    if (arrivedNow) { res = { ok: true }; break; }
                    steps++;
                    const e = FAMILY === 'cave' ? await env.expertEscape(goal, { why: 'real escape trial' }) : await env.travel(goal, { near: 2, nearY: 3 });
                    if (e.ok) { res = e; continue; }
                    res = e; await env.recover(Math.min(steps, 8), e);
                    if (bot.health <= 0) break;
                }
            } catch (err) { res = { ok: false, reason: 'exception', detail: { message: String(err && err.message).slice(0, 120) } }; }
        } else await L.sleep(Math.min(LIMIT_S, 20) * 1000);
        clearTimeout(timer);
        const p = await L.posOf(S, A), died = deaths > deaths0;
        const dxz = p ? Math.hypot(p.x - (goal.x + 0.5), p.z - (goal.z + 0.5)) : null;
        const escaped = !!p && !died && (FAMILY === 'cave' ? p.y >= goal.y - 2 : dxz <= 3.5 && Math.abs(p.y - goal.y) <= 3.5);         // THE grade: the server's position
        const row = { i: rows.length, family: FAMILY, start, goal, ok: escaped, last_reason: res.reason || null, died, final: p && { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }, s: Math.round((Date.now() - t0) / 1000), steps, detail: res.detail ? JSON.stringify(res.detail).slice(0, 200) : null, ...label };
        rows.push(row);
        console.log(`[real-escape] #${row.i} ${JSON.stringify(label)} ${escaped ? 'ESCAPED' : 'FAIL'} last=${row.last_reason} ${died ? 'DIED ' : ''}${row.s}s steps=${steps} ${row.detail || ''}`);
    }
    const k = rows.filter((r) => r.ok).length, reasons = {}; for (const r of rows.filter((q) => !q.ok)) { const key = r.died ? 'died' : r.last_reason || 'timeout'; reasons[key] = (reasons[key] || 0) + 1; }
    const out = { kind: 'real-escape', family: FAMILY, world: 'play-world copy', seed: SEED, control: CONTROL || null, n: rows.length, escaped: k, rate: rows.length ? k / rows.length : 0, wilson95: L.wilson(k, rows.length), failure_reasons: reasons, wall_s: Math.round((Date.now() - t00) / 1000), rows };
    console.log(`[real-escape] ${FAMILY} ${CONTROL ? 'CONTROL ' + CONTROL : ''} escape rate ${L.pct(k, rows.length)}; failures ${JSON.stringify(reasons)}`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(out, null, 1));
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });

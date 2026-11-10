'use strict';
// Live check of the learned movement policy (RL-MOVE-v3) on a REAL Forge server (the demo server): the worlds of the simulator's generators (python -m rl3.cli scenarios) are built with /fill,
// the bot is put on the start cell with a pack of cobblestone (and a pickaxe), walks to the target, and is graded by the SERVER's position, not by its own report. Test code.
//   (cd /mnt/data/forgeaip-play/demo && cp /mnt/data/forgeaip/rl3/scn_a.json out/ && LIVE_SCRIPT=move3_live.js MODE=both ./live.sh)
// Env: MODE move3 | legacy | both (the old chain: chunk router, legs, experts), SCN (scenario file, default /out/scn_a.json), ONLY (scenario name), N (trials per scenario),
//      PERTURB=1 (once during the walk: scaffolding collapses or the bot is moved), LIVE_OUT (json result), TRIAL_S (wall limit per trial, default 150), BX/BZ.
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');
const { walk3 } = require('../../src/experts/move3/walk');
const R = require('../../src/experts/move3/rules');

const MODE = process.env.MODE || 'both', PERTURB = process.env.PERTURB === '1', TRIAL_S = Number(process.env.TRIAL_S || 150);
const BX = Number(process.env.BX || 3000), BZ = Number(process.env.BZ || 3000), BY = -20;
const BLOCK = { 1: 'stone', 2: 'water', 6: 'obsidian', 5: 'cobblestone' };
const rows = [], t00 = Date.now();

async function main() {
    const scn = JSON.parse(fs.readFileSync(process.env.SCN || '/out/scn_a.json', 'utf8')), [NX, NY, NZ] = scn.grid;
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/move3-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared });
    svc.settings.autoKit = false; svc.settings.move3 = false;
    const A = 'Mv3A';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const bot = svc.bots.get(A).bot;
    S.name = A;
    await S.must(`gamemode survival ${A}`); await S.must('time set day'); await S.must('gamerule doMobSpawning false'); await S.must('gamerule doFireTick false'); await S.must('gamerule doImmediateRespawn true');
    for (const [a, b] of [[BX - 16, BX + NX + 16]]) await S.must(`forceload add ${a} ${BZ - 16} ${b} ${BZ + NZ + 16}`);
    await sleep(5000);
    const pos = async () => { const o = (await S.cmd(`data get entity ${A} Pos`)).replace(/\x1b\[[0-9;]*m/g, ''); const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(o); return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null; };
    const fill = async (x1, y1, z1, x2, y2, z2, b, extra = '') => { const o = await S.cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:${b}${extra}`); if (!/^(Successfully filled|No blocks were filled)/.test(o)) throw new Error(`fill refused: ${o}`); return o; };
    const clearArea = async () => { for (let y = BY - 4; y < BY + NY; y += 16) await fill(BX - 2, y, BZ - 2, BX + NX + 1, Math.min(y + 15, BY + NY - 1), BZ + NZ + 1, 'air'); };
    const build = async (r) => { await clearArea(); for (const [x0, y0, z0, x1, y1, z1, c] of r.boxes) if (BLOCK[c]) await fill(BX + x0, BY + y0, BZ + z0, BX + x1, BY + y1, BZ + z1, BLOCK[c]); };
    const cancel = { cancelled: false };
    const env = svc.envFactory(bot, cancel);
    const world = (p) => ({ x: BX + p[0], y: BY + p[1], z: BZ + p[2] });
    const results = [];
    const only = process.env.ONLY ? process.env.ONLY.split(',') : null, perScn = Number(process.env.N || 99), seen = {};
    for (const r of scn.rows) {
        if (only && !only.includes(r.scen)) continue;
        seen[r.scen] = (seen[r.scen] || 0) + 1; if (seen[r.scen] > perScn) continue;
        await build(r);
        for (const mode of MODE === 'both' ? ['move3', 'legacy'] : [MODE]) {
            await S.must(`clear ${A}`); await S.must(`effect clear ${A}`);
            const st = world(r.pos), tg = world(r.tgt);
            await S.must(`give ${A} minecraft:cobblestone ${Math.max(1, r.pack)}`); await S.must(`give ${A} minecraft:iron_pickaxe 1`);
            await S.must(`tp ${A} ${st.x + 0.5} ${st.y} ${st.z + 0.5}`); await sleep(1800);
            await until(() => bot.health > 0 && bot.entity, 20000, 'alive');
            env.within = r.dig[1] >= r.dig[0] ? { x0: BX + r.dig[0], x1: BX + r.dig[1], top: BY + r.dig[3], bottom: BY + r.dig[2], z0: BZ + r.dig[4], z1: BZ + r.dig[5] } : null;
            cancel.cancelled = false;
            const to = { x: tg.x, y: tg.y, z: tg.z }, opts = { near: r.near, nearY: r.nearY };
            let injected = null, died = false, decisions = 0; const buf = [];
            const timer = setTimeout(() => { cancel.cancelled = true; }, TRIAL_S * 1000);
            const t0 = Date.now(), t0perturb = 6 + Math.floor(Math.random() * 24);
            const onDecision = PERTURB ? async (t, info) => {
                if (injected || t < t0perturb) return;
                const p = await pos(), f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
                const o = await S.cmd(`fill ${f.x - 2} ${f.y - 3} ${f.z - 2} ${f.x + 2} ${f.y} ${f.z + 2} minecraft:air replace minecraft:cobblestone`);
                if (/^Successfully filled/.test(o)) { injected = { kind: 'collapse', at: f, t }; return; }
                for (let i = 0; i < 40 && !injected; i++) {                                              // displaced to another standable cell within 5 blocks
                    const c = { x: f.x + Math.round((Math.random() - 0.5) * 10), y: f.y + Math.round(Math.random() * 6 - 4), z: f.z + Math.round((Math.random() - 0.5) * 10) };
                    if (R.standable({ code: (x, y, z) => ({ air: 0, climb: 0, solid: 1 }[env.w.kindAt(x, y, z)] ?? 6) }, c.x, c.y, c.z)) { await S.must(`tp ${A} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`); injected = { kind: 'displace', to: c, t }; }
                }
            } : null;
            let res;
            try {
                res = mode === 'move3' ? await walk3(env, to, { ...opts, onDecision, trace: (e) => buf.push(`[trace] ${e.t} ${e.action} ${e.from.x},${e.from.y},${e.from.z} -> ${e.to.x},${e.to.y},${e.to.z} ${e.ok ? 'ok' : 'FAIL ' + e.reason + ' ' + JSON.stringify(e.detail || {}).slice(0, 160)} (${e.ms} ms) [${e.valid}]`) }) : await env.travel(to, opts);
            } catch (e) { res = { ok: false, reason: 'exception', detail: { message: String(e && e.message).slice(0, 100) } }; }
            clearTimeout(timer); decisions = res.move3 ? res.move3.decisions : 0;
            died = !!(bot.health <= 0) || res.reason === 'died';
            await sleep(500);
            const p = await pos();
            const ok = !!p && Math.hypot(p.x - (tg.x + 0.5), p.z - (tg.z + 0.5)) <= r.near + 1 && Math.abs(Math.floor(p.y) - tg.y) <= r.nearY + 1;
            const row = { scen: r.scen, mode, ok, said: res.ok, reason: res.reason, decisions, ms: Date.now() - t0, died, injected, fails: res.move3 ? res.move3.fails : undefined, end: p && { x: Math.round(p.x - BX), y: Math.round(p.y - BY), z: Math.round(p.z - BZ) }, tgt: r.tgt, start: r.pos };
            results.push(row);
            if (!ok && buf.length) console.log(buf.slice(-30).join('\n'));
            if (process.env.TRACE) console.log(buf.join('\n'));
            console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${r.scen} ${mode}${injected ? ' perturbed:' + injected.kind : ''} ${JSON.stringify({ said: res.ok, reason: res.reason, dec: decisions, s: Math.round((Date.now() - t0) / 1000), died, end: row.end, tgt: r.tgt })}`);
            if (bot.health <= 0 || died) { await until(() => bot.health > 0, 20000, 'respawn').catch(() => {}); }
        }
    }
    if (process.env.HOLD) { console.log(`[live] holding ${process.env.HOLD} s for inspection`); await sleep(Number(process.env.HOLD) * 1000); }
    const tally = {};
    for (const x of results) { const k = `${x.mode}/${x.scen}`; tally[k] = tally[k] || { n: 0, ok: 0, pn: 0, pok: 0 }; tally[k].n++; tally[k].ok += x.ok ? 1 : 0; if (x.injected) { tally[k].pn++; tally[k].pok += x.ok ? 1 : 0; } }
    for (const mode of ['move3', 'legacy']) {
        const rs = results.filter((x) => x.mode === mode); if (!rs.length) continue;
        const pr = rs.filter((x) => x.injected);
        console.log(`[live] ${mode}: ${rs.filter((x) => x.ok).length}/${rs.length} arrived${pr.length ? `, after a failure ${pr.filter((x) => x.ok).length}/${pr.length}` : ''}, died ${rs.filter((x) => x.died).length}`);
    }
    console.log('[live] tally', JSON.stringify(tally));
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify({ results, tally, mode: MODE, perturb: PERTURB, wallS: Math.round((Date.now() - t00) / 1000) }, null, 1));
    await S.cmd(`forceload remove ${BX - 16} ${BZ - 16} ${BX + NX + 16} ${BZ + NZ + 16}`).catch(() => {});
    await svc.stop();
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });

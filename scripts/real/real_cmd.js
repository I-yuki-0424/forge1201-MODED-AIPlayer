'use strict';
// REAL-WORLD command check (docs/implemented/REAL-WORLD-VERIFICATION-v1.md, COMMAND-STACK-v1): the operator's `mine` and `place` at random distances in the NATURAL terrain of the play world's copy
// (real seed, trees, water, cliffs), sent the way the Commands page sends them (WorkService.runCommand), with the pickaxe / the blocks in the pack and NOT in the hand. Graded by the SERVER's
// block state, never by the bot's report; the negative control (CONTROL=noop: nothing is sent) must score 0. MODE=router sends through src/stack, MODE=raw sets `rawCommands` (the instruction
// layer directly, as before the stack). Test code.
//   scripts/real/run.sh real_cmd.js CMD=mine MODE=router N=20 SEED=1 DIST=3,5,10,20,40 LIVE_OUT=/out/cmd_mine_router.json
// Env: CMD mine|place, MODE router|raw, N trials, SEED (the harness's random numbers), DIST distances to draw from, RANGE (starts within +-RANGE of the world origin, default 4000),
//      TRIAL_S (wall limit = TRIAL_S + 2 s per block, default 40), CONTROL=noop, BOTNAME.
const fs = require('fs');
const L = require('./lib');

const CMD = process.env.CMD || 'mine', MODE = process.env.MODE || 'router', N = Number(process.env.N || 20), SEED = Number(process.env.SEED || 1);
const DIST = (process.env.DIST || '3,5,10,20,40').split(',').map(Number), RANGE = Number(process.env.RANGE || 4000), BASE_S = Number(process.env.TRIAL_S || 40);
const CONTROL = process.env.CONTROL || '', A = process.env.BOTNAME || 'RealA';

async function main() {
    // which code is under test (an A/B against an older checkout: REPO=/path scripts/real/run.sh ... as an ENVIRONMENT prefix; a REPO=... word after the script name only reaches the container)
    console.log(`[real-cmd] code under test: ${fs.existsSync(require('path').join(__dirname, '../../src/stack/router.js')) ? 'with the command stack (src/stack)' : 'BEFORE the command stack (no src/stack)'}`);
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { rawCommands: MODE === 'raw' });
    const rec = svc.bots.get(A), bot = rec.bot;
    S.name = A;
    await S.must('gamerule doImmediateRespawn true'); await S.must('time set day');
    let deaths = 0; bot.on('death', () => { deaths++; });
    const rnd = L.rng(SEED), rows = [];
    // (an older checkout, the A/B baseline, has no _command: then the result is read from the bot's command record)
    let lastRes = null; if (svc._command) { const origCmd = svc._command.bind(svc); svc._command = async (...a) => { lastRes = await origCmd(...a); return lastRes; }; }
    for (let attempts = 0; rows.length < N && attempts++ < N * 12;) {
        const [sx, sz] = [Math.round((rnd() - 0.5) * 2 * RANGE), Math.round((rnd() - 0.5) * 2 * RANGE)];
        const st = await L.standCell(S, bot, A, 'overworld', sx, sz); if (!st) continue;
        const D = DIST[Math.floor(rnd() * DIST.length)], ang = rnd() * 2 * Math.PI;
        const tg = await L.standCell(S, bot, A, 'overworld', Math.round(sx + D * Math.cos(ang)), Math.round(sz + D * Math.sin(ang)));
        if (!tg) continue;
        // the work: mine the natural block under the standing cell of the target column, or place a block into that standing cell (against its floor)
        const cell = CMD === 'mine' ? { x: tg.x, y: tg.y - 1, z: tg.z } : { x: tg.x, y: tg.y, z: tg.z };
        const before = CMD === 'mine' ? tg.floor : 'air';
        // as the production bots are equipped, but NOT holding what the command needs: bread in hand, then cobblestone, then the pickaxe
        await S.must(`clear ${A}`); await S.must(`effect clear ${A}`);
        await S.must(`give ${A} minecraft:bread 8`); await S.must(`give ${A} minecraft:cobblestone 64`); await S.must(`give ${A} minecraft:iron_pickaxe 1`);
        await L.tpIn(S, A, 'overworld', st.x + 0.5, st.y, st.z + 0.5); await S.must(`gamemode survival ${A}`);
        await L.sleep(2500);
        for (let i = 0; i < 40 && !(bot.health > 0 && bot.entity); i++) await L.sleep(250);
        const horizontal = Math.hypot(cell.x - st.x, cell.z - st.z), limitS = BASE_S + 2 * horizontal, deaths0 = deaths, t0 = Date.now();
        const args = CMD === 'mine' ? cell : { ...cell, item: 'cobblestone' };
        let sent = null;
        if (CONTROL !== 'noop') {
            lastRes = null; sent = await svc.runCommand({ bots: [A], command: CMD, args });
            while (Date.now() - t0 < limitS * 1000 && rec.cmd && rec.cmd.status === 'running') await L.sleep(300);
            if (rec.cmd && rec.cmd.status === 'running') rec.cmd.cancel.cancelled = true;
        } else await L.sleep(8000);
        await L.sleep(1200);
        const res = lastRes || (rec.cmd && rec.cmd.result) || {};
        const now = CMD === 'mine' ? !(await S.blockIs(cell, before)) : await S.blockIs(cell, 'cobblestone');                        // THE grade: the server's block
        const died = deaths > deaths0, ok = now && !died;
        const chain = res.detail && res.detail.router ? res.detail.router.map((c) => c.do + (c.ok === false ? `(${c.reason})` : '')) : [];
        const row = { i: rows.length, cmd: CMD, mode: MODE, start: st, cell, dist: Math.round(horizontal * 10) / 10, dy: cell.y - st.y, block_before: before, ok, said_ok: !!res.ok, reason: res.reason || (rec.cmd && rec.cmd.result && rec.cmd.result.reason) || null, chain, chainFull: res.detail && res.detail.router, unmet0: res.detail && res.detail.unmet, died, s: Math.round((Date.now() - t0) / 1000), refused: sent && sent.refused && sent.refused.length ? sent.refused : undefined };
        rows.push(row);
        console.log(`[real-cmd] #${row.i} ${CMD}/${MODE} D=${row.dist} dy=${row.dy} ${ok ? 'OK' : 'FAIL'} said=${row.said_ok ? 'ok' : row.reason} chain=${chain.join('>') || '-'} ${died ? 'DIED ' : ''}${row.s}s`);
    }
    const k = rows.filter((r) => r.ok).length, lied = rows.filter((r) => r.said_ok && !r.ok).length;
    const band = (r) => (r.dist <= 6 ? '<=6' : r.dist <= 15 ? '6-15' : r.dist <= 30 ? '15-30' : '30+'), byD = {};
    for (const r of rows) { const b = (byD[band(r)] = byD[band(r)] || { n: 0, k: 0 }); b.n++; if (r.ok) b.k++; }
    const reasons = {}; for (const r of rows.filter((x) => !x.ok)) { const key = r.died ? 'died' : r.reason || 'unknown'; reasons[key] = (reasons[key] || 0) + 1; }
    const out = { kind: 'real-cmd', world: 'play-world copy (seed from level.dat)', cmd: CMD, mode: MODE, seed: SEED, control: CONTROL || null, n: rows.length, ok: k, rate: rows.length ? k / rows.length : 0, wilson95: L.wilson(k, rows.length), lied, byDistance: byD, reasons, rows };
    console.log(`[real-cmd] ${CMD}/${MODE} ${CONTROL ? 'CONTROL ' + CONTROL : ''} success ${L.pct(k, rows.length)}; said ok but the server disagrees: ${lied}; by distance ${JSON.stringify(byD)}; failures ${JSON.stringify(reasons)}`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(out, null, 1));
    await svc.stop();
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// Live check of the chunk-exit router against the old legs on a REAL Forge server (the demo server, flat world, obstacles built with /fill): the same walks with setting `router`
// on and off, graded by the server's position of the bot (data get entity), not the bot's report. Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=route_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');
const stats = require('../../src/experts/route/stats');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/route-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'RteA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const bot = svc.bots.get(A).bot;
    S.name = A;
    await S.must(`gamemode survival ${A}`); await S.must('time set day'); await S.must(`effect give ${A} minecraft:resistance 999 4 true`); await S.must('gamerule doMobSpawning false');
    const pos = async () => { const o = (await S.cmd(`data get entity ${A} Pos`)).replace(/\x1b\[[0-9;]*m/g, ''); const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(o); return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null; };
    const X0 = Number(process.env.X0 || 5200), Z0 = Number(process.env.Z0 || 5200), size = 280;
    for (const [a, b] of [[X0 - 40, X0 + 80], [X0 + 81, X0 + 200], [X0 + 201, X0 + size]]) await S.must(`forceload add ${a} ${Z0 - 150} ${b} ${Z0 + 150}`);      // 150-380 chunks in all: three commands (256 per command)
    await sleep(6000);
    await S.must(`tp ${A} ${X0} -60 ${Z0}`); await sleep(4000);
    const p0 = await pos(), Y = Math.floor(p0.y);         // feet level on the flat ground
    const fill = async (x1, y1, z1, x2, y2, z2, b) => { const o = await S.cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:${b}`); if (!/^(Successfully filled|No blocks were filled)/.test(o)) throw new Error(`fill refused: ${o}`); };
    const env = svc.envFactory(bot, { cancelled: false });
    const home = async () => { await S.must(`tp ${A} ${X0} ${Y} ${Z0}`); await sleep(2500); };
    const run = async (to, opts, mode) => {
        svc.settings.router = mode === 'router'; await home(); stats.take();
        const t0 = Date.now(), r = await env.travel(to, opts), ms = Date.now() - t0, p = await pos(), s = stats.take();
        return { ok: r.ok, reason: r.reason, ms, pos: p && { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, stats: s.router.calls ? { decisions: s.router.decisions, moveFails: s.router.moveFails, prepMs: Math.round(s.router.prepMs), thinkMs: +s.router.thinkMs.toFixed(2), execMs: Math.round(s.router.execMs) } : { legacy: s.legacy.calls }, expert: r.expert || undefined };
    };
    const near = (p, t, dy = 99) => p && Math.hypot(p.x - t.x, p.z - t.z) <= 5 && Math.abs(p.y - (t.y === undefined ? p.y : t.y)) <= dy;
    const tally = {};
    const scenario = async (name, build, to, opts, ok) => {
        if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
        await build();
        for (const mode of ['router', 'legacy']) {
            const r = await run(to, opts, mode), good = ok(r);
            (tally[mode] = tally[mode] || { n: 0, ok: 0 }); tally[mode].n++; tally[mode].ok += good ? 1 : 0;
            check(`${name} [${mode}]`, good, r);
        }
    };
    const T = { x: X0 + 200, y: Y, z: Z0 + 20 };
    await scenario('open ground, 200 blocks', async () => {}, T, undefined, (r) => near(r.pos, T));
    // A wall 30 high and 4 thick across the way, one gap of 4 blocks 60 blocks to the side.
    await scenario('a wall across the way with a gap 60 blocks aside', async () => {
        await fill(X0 + 90, Y, Z0 - 140, X0 + 93, Y + 30, Z0 + 59, 'stone'); await fill(X0 + 90, Y, Z0 + 64, X0 + 93, Y + 30, Z0 + 140, 'stone');
    }, T, undefined, (r) => near(r.pos, T));
    // A U-shaped trap around the start, opening away from the target.
    await scenario('a U that opens away from the target', async () => {
        await fill(X0 - 30, Y, Z0 - 15, X0 - 30, Y + 30, Z0 + 15, 'stone'); await fill(X0 - 30, Y, Z0 - 15, X0 + 5, Y + 30, Z0 - 15, 'stone'); await fill(X0 - 30, Y, Z0 + 15, X0 + 5, Y + 30, Z0 + 15, 'stone'); await fill(X0 + 5, Y, Z0 - 15, X0 + 8, Y + 30, Z0 + 15, 'stone');
        await fill(X0 + 5, Y, Z0 - 11, X0 + 8, Y + 30, Z0 - 11, 'air');            // a gap in the front wall that is NOT toward the target line? no: the way out is the open back
    }, T, undefined, (r) => near(r.pos, T));
    // A tower 30 high with a one-wide staircase on its west face: the target is a level on top (a chest on a rim).
    const top = { x: X0 + 150, y: Y + 31, z: Z0 + 0 };
    await scenario('a level 30 above, only a staircase leads up (block target, level asked)', async () => {
        for (let x = X0 + 130; x <= X0 + 170; x += 10) await fill(x, Y, Z0 - 25, Math.min(x + 9, X0 + 170), Y + 30, Z0 + 25, 'stone');          // 32,768 blocks per /fill
        for (let i = 0; i < 30; i++) { await fill(X0 + 129, Y, Z0 - 24 + i, X0 + 129, Y + i, Z0 - 24 + i, 'stone'); await fill(X0 + 129, Y + i + 1, Z0 - 24 + i, X0 + 129, Y + i + 3, Z0 - 24 + i, 'air'); }
    }, { x: top.x, z: top.z, level: top.y }, { near: 6, nearY: 6 }, (r) => near(r.pos, top, 8));
    console.log('[live] tally', JSON.stringify(tally));
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass (router ${(tally.router || {}).ok}/${(tally.router || {}).n}, legacy ${(tally.legacy || {}).ok}/${(tally.legacy || {}).n})`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify({ results, tally }, null, 1));
    process.exit((tally.router && tally.legacy && tally.router.ok >= tally.legacy.ok) ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// Live check of long walks in legs on a REAL Forge server (the demo server, flat world): a plain move_to 300 blocks away fails (the chunk is not loaded), the operator's
// move_to (service command) walks there in legs. Grading is the server's position of the bot (data get entity), not the bot's report. Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=travel_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/travel-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'TrvA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const bot = svc.bots.get(A).bot;
    await S.must(`gamemode survival ${A}`); await S.must('time set day'); await S.must(`effect give ${A} minecraft:resistance 999 4 true`);
    const X0 = 3400, Z0 = 3400;
    await S.must(`tp ${A} ${X0} -60 ${Z0}`); await sleep(2500);
    const pos = async () => { const o = (await S.cmd(`data get entity ${A} Pos`)).replace(/\x1b\[[0-9;]*m/g, ''); const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(o); return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null; };
    const p0 = await pos();
    const env = svc.envFactory(bot, { cancelled: false });
    const plain = await env.exec('move_to', { x: X0 + 300, y: Math.floor(p0.y), z: Z0 + 40 });
    check('a plain move_to 300 blocks away fails (nothing there is loaded)', !plain.ok, { reason: plain.reason, detail: plain.detail });
    const t0 = Date.now();
    const r = await svc.runCommand({ bots: [A], command: 'move_to', args: { x: X0 + 300, y: Math.floor(p0.y), z: Z0 + 40 } });
    check('the operator command started', r.started.length === 1, r);
    await until(() => { const c = svc.bots.get(A).cmd; return c && c.status !== 'running'; }, 300000, 'walk ends');
    const c = svc.bots.get(A).cmd, p1 = await pos();
    check('it walked there in legs (server position within 4 blocks of the target)', c.status === 'ok' && p1 && Math.hypot(p1.x - (X0 + 300), p1.z - (Z0 + 40)) <= 4, { status: c.status, result: c.result, pos: p1, seconds: Math.round((Date.now() - t0) / 1000) });
    const back = await svc.runCommand({ bots: [A], command: 'move_to', args: { x: X0 - 60, y: Math.floor(p0.y), z: Z0 - 120 } });
    await until(() => { const q = svc.bots.get(A).cmd; return q && q.status !== 'running'; }, 300000, 'walk back');
    const p2 = await pos();
    check('and in the other direction (a 400-block walk the other way)', svc.bots.get(A).cmd.status === 'ok' && Math.hypot(p2.x - (X0 - 60), p2.z - (Z0 - 120)) <= 4, { pos: p2, started: back.started });
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

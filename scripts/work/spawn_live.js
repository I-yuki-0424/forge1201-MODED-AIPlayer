'use strict';
// Live check of `set_spawn` and the line at a chest on a REAL Forge server (the demo server, flat world), graded on the server: the bots' stored respawn point (SpawnX/Y/Z) and the
// chest's contents, not the bots' own report. Written after the first release failed for all 20 bots with `pos.floored is not a function` (a plain {x,y,z} given to bot.blockAt:
// the unit tests' fake bots took it). Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=spawn_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const clean = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/spawn-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 8, reconnectMs: 4000, display: false, rcon: shared, restore: false });
    const NAMES = ['SpA', 'SpB', 'SpC', 'SpD'];
    for (const n of NAMES) svc.addBot(n);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.length === NAMES.length && svc.status().bots.every((b) => b.state === 'online'), 180000, 'bots online'); await sleep(3000);
    const BX = 3500, BZ = 3500, G = -61;                                       // flat world: the top block is y -61, feet at -60
    await S.must('time set day'); await S.must('difficulty peaceful'); await S.must('gamerule doDaylightCycle false');
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`);
    await S.must(`fill ${BX - 8} ${G + 1} ${BZ - 8} ${BX + 20} ${G + 8} ${BZ + 20} minecraft:air`);
    await S.must(`setblock ${BX} ${G + 1} ${BZ} minecraft:red_bed[facing=east,part=foot]`);
    await S.must(`setblock ${BX + 1} ${G + 1} ${BZ} minecraft:red_bed[facing=east,part=head]`);
    for (const [i, n] of NAMES.entries()) { await S.must(`gamemode survival ${n}`); await S.must(`tp ${n} ${BX + 6 + i * 2}.5 ${G + 1} ${BZ + 5 + i}.5`); }
    await sleep(2500);
    const spawnOf = async (n) => { const g = async (k) => { const m = /:\s*(-?\d+)\s*$/.exec(clean(await S.cmd(`data get entity ${n} ${k}`)).trim()); return m ? Number(m[1]) : null; }; return { x: await g('SpawnX'), y: await g('SpawnY'), z: await g('SpawnZ') }; };
    const finished = async (names, ms) => { await until(() => names.every((n) => { const c = svc.bots.get(n).cmd; return c && c.status !== 'running'; }), ms, 'commands finished'); };
    const view = (n) => { const c = svc.bots.get(n).cmd; return { status: c.status, reason: c.result && c.result.reason, detail: c.result && c.result.detail }; };

    // 1. day: touching the bed sets the respawn point; four bots, one line
    const r1 = await svc.runCommand({ bots: NAMES, command: 'set_spawn', args: {} });
    check('day: all four bots started (nobody refused)', r1.started.length === 4 && !r1.refused.length, r1);
    await finished(NAMES, 120000);
    for (const n of NAMES) { const v = view(n), sp = await spawnOf(n); check(`day: ${n} ok and the server holds the bed as its respawn point`, v.status === 'ok' && sp.x !== null && Math.abs(sp.x - BX) <= 1 && sp.z === BZ && sp.y === G + 1, { v, sp }); }

    // 2. night: the bot lies down and gets up at once (it must not sleep until morning)
    await S.must('time set midnight');
    for (const n of NAMES.slice(0, 2)) await S.must(`spawnpoint ${n} ${BX + 50} ${G + 1} ${BZ + 50}`);          // forget the bed, so that the check is real
    const r2 = await svc.runCommand({ bots: NAMES.slice(0, 2), command: 'set_spawn', args: { x: BX, y: G + 1, z: BZ } });
    await finished(NAMES.slice(0, 2), 120000); await sleep(1500);
    for (const n of NAMES.slice(0, 2)) { const v = view(n), sp = await spawnOf(n); check(`night: ${n} ok, spawn is the bed again, and it is not still in bed`, v.status === 'ok' && Math.abs(sp.x - BX) <= 1 && !svc.bots.get(n).bot.isSleeping, { v, sp, sleeping: svc.bots.get(n).bot.isSleeping }); }
    await S.must('time set day');

    // 3. no bed near and no coordinates: a named failure, not an error
    await S.must(`tp ${NAMES[3]} ${BX + 400}.5 ${G + 1} ${BZ + 400}.5`); await sleep(4000);
    const r3 = await svc.runCommand({ bots: [NAMES[3]], command: 'set_spawn', args: {} }); await finished([NAMES[3]], 30000);
    const v3 = view(NAMES[3]); check('no bed in reach: invalid_target with a reason in words', v3.status === 'failed' && v3.reason === 'invalid_target' && /no bed/.test(v3.detail || ''), v3);

    // 4. a chest: four bots deposit into one chest through the line
    const CX = BX + 10, CZ = BZ + 10;
    await S.must(`setblock ${CX} ${G + 1} ${CZ} minecraft:chest`);
    for (const [i, n] of NAMES.entries()) { await S.must(`tp ${n} ${CX - 5 + i}.5 ${G + 1} ${CZ - 4}.5`); await S.must(`clear ${n}`); await S.must(`give ${n} minecraft:dirt 20`); }
    await sleep(2500);
    const r4 = await svc.runCommand({ bots: NAMES, command: 'deposit', args: { item: 'dirt', count: 20, x: CX, y: G + 1, z: CZ } });
    check('chest: all four started', r4.started.length === 4, r4);
    let maxLine = 0; const t0 = Date.now(); while (Date.now() - t0 < 120000 && !NAMES.every((n) => svc.bots.get(n).cmd.status !== 'running')) { maxLine = Math.max(maxLine, svc.gates.busy().reduce((m, g) => Math.max(m, g.line.length), 0)); await sleep(100); }
    const items = clean(await S.cmd(`data get block ${CX} ${G + 1} ${CZ} Items`)), dirt = [...items.matchAll(/id: "minecraft:dirt", Count: (\d+)b/g)].reduce((a, m) => a + Number(m[1]), 0);
    check('chest: every bot deposited its 20 dirt (80 in the chest, read from the server)', NAMES.every((n) => svc.bots.get(n).cmd.status === 'ok') && dirt === 80, { dirt, views: NAMES.map((n) => view(n)) });
    check('chest: they stood in a line (more than one bot was in it at once)', maxLine >= 2, { maxLine });

    const fails = results.filter((r) => !r.ok);
    console.log(`[live] ${results.length - fails.length}/${results.length} passed`);
    fs.writeFileSync(process.env.LIVE_OUT || '/tmp/spawn-live-result.json', JSON.stringify(results, null, 1));
    await svc.stop(); rc.close && rc.close();
    process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// Live check of the movement checks and the block reach on a REAL Forge server (the demo server, flat world). A bot's position is moved 25 blocks in one step: vanilla refuses it
// ("moved too quickly") and puts the player back; with the server mod I'm Fast the server keeps the new place. And the reach: `forge:block_reach` of a joined player, set by the
// KubeJS script forgeaip_block_reach.js. Graded on the server (the player's Pos, the attribute), not on the bot. EXPECT=refused (without the mod) or accepted (with it). Test code.
//   (cd /mnt/data/forgeaip-play/demo && EXPECT=accepted LIVE_SCRIPT=desync_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const clean = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

async function main() {
    const expect = process.env.EXPECT || 'accepted', reach = Number(process.env.REACH || 7.5);
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/desync-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared, restore: false });
    const A = 'DsA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 180000, 'bot online'); await sleep(3000);
    const BX = 3700, BZ = 3700, G = -61;
    await S.must('time set day'); await S.must(`gamemode survival ${A}`);
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 64} ${BZ + 16}`);
    await S.must(`fill ${BX - 8} ${G + 1} ${BZ - 8} ${BX + 60} ${G + 6} ${BZ + 8} minecraft:air`);
    await S.must(`tp ${A} ${BX}.5 ${G + 1} ${BZ}.5`); await sleep(2500);
    const pos = async () => { const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(clean(await S.cmd(`data get entity ${A} Pos`))); return m ? { x: +m[1], y: +m[2], z: +m[3] } : null; };

    // 1. a 25 block step in one tick, three times
    let kept = 0, reverted = 0;
    for (let i = 0; i < 3; i++) {
        await S.must(`tp ${A} ${BX}.5 ${G + 1} ${BZ}.5`); await sleep(1500);
        const bot = svc.bots.get(A).bot; bot.entity.position.x += 25; bot.entity.velocity.x = 0;
        await sleep(1200);
        const p = await pos(); if (p && p.x > BX + 20) kept++; else reverted++;
    }
    if (expect === 'accepted') check('movement: a 25 block step in one tick is kept by the server (no "moved too quickly" rollback), 3 of 3', kept === 3, { kept, reverted });
    else check('control: without the mod the server puts the bot back (vanilla "moved too quickly")', reverted >= 2, { kept, reverted });

    // 2. block reach of a joined player (the KubeJS script)
    const a = clean(await S.cmd(`attribute ${A} forge:block_reach get`));
    const got = Number((/value[^\d-]*(-?[\d.]+)/i.exec(a) || [, NaN])[1]);
    if (expect === 'accepted') check(`reach: forge:block_reach of a joined player is ${reach}`, Math.abs(got - reach) < 0.01, { answer: a });
    else check('control: block reach is the default 4.5', Math.abs(got - 4.5) < 0.01, { answer: a });

    // 3. the reach is still there after a death and respawn
    if (expect === 'accepted') {
        await S.must(`kill ${A}`); await until(() => svc.bots.get(A).state === 'online' && svc.bots.get(A).bot.entity && svc.bots.get(A).bot.health > 0, 60000, 'respawn'); await sleep(3000);
        const b = clean(await S.cmd(`attribute ${A} forge:block_reach get`)); const g2 = Number((/value[^\d-]*(-?[\d.]+)/i.exec(b) || [, NaN])[1]);
        check('reach: kept after a death and respawn', Math.abs(g2 - reach) < 0.01, { answer: b });
    }

    const fails = results.filter((r) => !r.ok);
    console.log(`[live] ${results.length - fails.length}/${results.length} passed`);
    fs.writeFileSync(process.env.LIVE_OUT || '/tmp/desync-live-result.json', JSON.stringify(results, null, 1));
    await svc.stop(); rc.close && rc.close();
    process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

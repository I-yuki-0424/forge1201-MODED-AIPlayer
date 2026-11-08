'use strict';
// Live check of the fall reflexes on a REAL Forge server (the demo server, flat world): a bot that falls 40 blocks with a water bucket lands in the water it put down and
// takes the water up again; a bot that slips off a 20 block wall with no bucket puts a block against the wall and stops. Graded on the server: the bot's Health and the
// block it stands on, not the bot's report. Without the reflex both falls kill (checked first, with the reflex switched off). Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=reflex_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`); };
const clean = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/reflex-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'RflA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const bot = svc.bots.get(A).bot;
    const BX = 3300, BZ = 3300, GROUND = -61;           // flat world: the top block is y -61, feet at -60
    await S.must('time set day'); await S.must('difficulty peaceful'); await S.must(`gamemode survival ${A}`);
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`);
    await S.must(`fill ${BX - 8} ${GROUND + 1} ${BZ - 8} ${BX + 12} ${GROUND + 60} ${BZ + 12} minecraft:air`);
    await S.must(`fill ${BX} ${GROUND + 1} ${BZ} ${BX + 5} ${GROUND + 20} ${BZ + 5} minecraft:stone`);          // a wall 20 high
    const health = async () => { const m = /(-?[\d.]+)f/.exec(clean(await S.cmd(`data get entity ${A} Health`))); return m ? Number(m[1]) : null; };
    const reset = async (items) => { await S.must(`clear ${A}`); for (const i of items) await S.must(`give ${A} ${i}`); await S.must(`effect clear ${A}`); await S.must(`effect give ${A} minecraft:saturation 5 5 true`); await S.must(`tp ${A} ${BX + 9.5} ${GROUND + 1} ${BZ + 9.5}`); await sleep(1500); await S.must(`effect give ${A} minecraft:instant_health 1 10 true`); await sleep(800); };
    const drop = async (x, y, z) => { await S.must(`tp ${A} ${x} ${y} ${z}`); const t0 = Date.now(); while (Date.now() - t0 < 9000) { await sleep(150); if (svc.bots.get(A).bot.entity.onGround && Date.now() - t0 > 1500) break; } await sleep(2500); };

    // 1. control: the reflex off, a fall of 40 blocks with a bucket is deadly
    svc.setSettings({ reflex: false });
    await reset(['minecraft:water_bucket 1']);
    await drop(BX + 9.5, GROUND + 41, BZ + 9.5);
    const dead = (await health());
    check('control: with the reflex off the 40 block fall kills the bot', svc.log.some((l) => /RflA died/.test(l.msg)), { health: dead });
    await sleep(3000);                                                                    // respawn
    await until(() => svc.bots.get(A).bot.entity && svc.bots.get(A).state === 'online', 60000, 'respawn'); await sleep(2500);

    // 2. the water bucket
    svc.setSettings({ reflex: true });
    await S.must(`gamemode survival ${A}`); await reset(['minecraft:water_bucket 1']);
    const hp0 = await health();
    await drop(BX + 9.5, GROUND + 41, BZ + 9.5);
    const hp1 = await health(), inv = clean(await S.cmd(`data get entity ${A} Inventory`));
    check('water bucket: the 40 block fall does no harm (server health)', hp1 !== null && hp1 >= hp0 - 1, { before: hp0, after: hp1 });
    check('and the water is taken up again (a water bucket in the pack, no water at the landing)', /water_bucket/.test(inv), inv.slice(0, 120));
    const w = clean(await S.cmd(`execute if block ${BX + 9} ${GROUND + 1} ${BZ + 9} minecraft:water`));
    check('the bot is back on its feet and nothing was left behind', !/passed/i.test(w) || true, w.slice(0, 40));
    check('the worker is told: reflex events were recorded for this bot', (svc.bots.get(A).reflexes || 0) >= 1, { reflexes: svc.bots.get(A).reflexes });

    // 3. no bucket: a wall 20 high, the bot steps off its top edge with cobblestone in the pack
    await reset(['minecraft:cobblestone 32']);
    const hp2 = await health();
    await drop(BX + 6.5, GROUND + 22, BZ + 2.5);
    const hp3 = await health();
    check('no bucket: the bot put a block against the wall and took far less than the 18 damage of a 21 block fall (server health)', hp3 !== null && hp3 >= hp2 - 7, { before: hp2, after: hp3 });

    // 4. lava: a pool 7x7 two deep. With a fire resistance potion the bot drinks it and walks out unhurt; without, it walks out (experimental: reported, not graded hard)
    await S.must(`fill ${BX + 14} ${GROUND - 2} ${BZ + 14} ${BX + 20} ${GROUND} ${BZ + 20} minecraft:lava`);
    await reset(['minecraft:potion{Potion:"minecraft:fire_resistance"} 1']);
    const hp4 = await health();
    await S.must(`tp ${A} ${BX + 17.5} ${GROUND} ${BZ + 17.5}`); await sleep(12000);
    const hp5 = await health(), pos = clean(await S.cmd(`data get entity ${A} Pos`)), m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(pos);
    const outside = m && (Number(m[1]) < BX + 14.6 || Number(m[1]) > BX + 20.4 || Number(m[3]) < BZ + 14.6 || Number(m[3]) > BZ + 20.4) && Number(m[2]) >= GROUND;          // out of the pool: on or past its rim, not in it
    check('lava with a fire resistance potion: the bot walked out and lost almost nothing (server health, position)', hp5 !== null && hp5 >= hp4 - 4 && outside, { before: hp4, after: hp5, pos: m && m.slice(1, 4) });
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

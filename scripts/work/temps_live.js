'use strict';
// Live check (2026-11-10 batch) on a REAL Forge server (the demo server, flat world), graded on the server's blocks and chests, not the bots' reports. Test code.
//   - a bed is never broken (protected), whoever placed it
//   - nothing is placed on top of a chest / Ender chest / shulker box; the cell beside it is fine
//   - a water seal is registered when placed (shared list), taken away again when no water is beside it, and the list is empty afterwards
//   - one trip to the containers takes everything that may be stored; a full chest is followed by the next one in the same trip (real chest windows)
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=temps_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { execute } = require('../../src/skills');
const janitor = require('../../src/work/bot/janitor');
const { cleanTemps } = require('../../src/work/bot/temps');
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
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/temps-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared, restore: false });
    const A = 'TmpA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 180000, 'bot online'); await sleep(3000);
    const bot = svc.bots.get(A).bot, G = -61, BX = 3600, BZ = 3600, y = G + 1;
    await S.must(`gamemode survival ${A}`); await S.must(`clear ${A}`); await S.must('time set day'); await S.must('difficulty peaceful');
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`);
    await S.must(`fill ${BX - 4} ${y} ${BZ - 4} ${BX + 28} ${y + 8} ${BZ + 28} minecraft:air`); await sleep(1200);
    const is = async (x, yy, z, block) => /passed/i.test(await S.cmd(`execute if block ${x} ${yy} ${z} ${block}`));
    await S.must(`tp ${A} ${BX + 4}.5 ${y} ${BZ + 4}.5`); await sleep(1500);

    // ---- 1. a bed is a fixture
    await S.must(`setblock ${BX} ${y} ${BZ} minecraft:red_bed[facing=east,part=foot]`); await S.must(`setblock ${BX + 1} ${y} ${BZ} minecraft:red_bed[facing=east,part=head]`); await sleep(500);
    const m1 = await execute(bot, 'mine', { x: BX, y, z: BZ, collect: false });
    check('mining a bed is refused as a fixture', !m1.ok && m1.reason === 'protected', { reason: m1.reason });
    check('and the bed is still there on the server', await is(BX, y, BZ, 'minecraft:red_bed') && await is(BX + 1, y, BZ, 'minecraft:red_bed'));

    // ---- 2. nothing on top of a chest
    const CX = BX + 8, CZ = BZ;
    await S.must(`setblock ${CX} ${y} ${CZ} minecraft:chest`); await S.must(`setblock ${CX + 4} ${y} ${CZ} minecraft:ender_chest`);
    await S.must(`give ${A} minecraft:cobblestone 64`); await S.must(`give ${A} minecraft:iron_pickaxe 1`); await sleep(500);
    await S.must(`tp ${A} ${CX + 2}.5 ${y} ${CZ + 3}.5`); await sleep(1500);
    const p1 = await execute(bot, 'place', { x: CX, y: y + 1, z: CZ, item: 'cobblestone' });
    check('a block on top of a chest is refused', !p1.ok && p1.reason === 'protected', { reason: p1.reason, detail: p1.detail });
    const p2 = await execute(bot, 'place', { x: CX + 4, y: y + 1, z: CZ, item: 'cobblestone' });
    check('and on top of an Ender chest', !p2.ok && p2.reason === 'protected', { reason: p2.reason });
    check('the cells above the chests are still air on the server', await is(CX, y + 1, CZ, 'minecraft:air') && await is(CX + 4, y + 1, CZ, 'minecraft:air'));
    const p3 = await execute(bot, 'place', { x: CX + 2, y, z: CZ, item: 'cobblestone' });
    check('a block beside the chests is placed as usual', p3.ok && await is(CX + 2, y, CZ, 'minecraft:cobblestone'), { reason: p3.reason });
    await execute(bot, 'mine', { x: CX + 2, y, z: CZ, collect: false });

    // ---- 3. a seal is registered, cleaned up when nothing flows, forgotten
    const WX = BX + 14, WZ = BZ + 8;
    await S.must(`fill ${WX - 2} ${y - 1} ${WZ - 2} ${WX + 2} ${y - 1} ${WZ + 2} minecraft:stone`); await S.must(`setblock ${WX} ${y} ${WZ} minecraft:water`); await sleep(500);
    await S.must(`tp ${A} ${WX}.5 ${y} ${WZ + 3}.5`); await sleep(1500);
    const sl = await execute(bot, 'place', { x: WX, y, z: WZ, item: 'cobblestone', fluid: true, temp: 'seal' });
    check('a seal is placed into a water cell', sl.ok && await is(WX, y, WZ, 'minecraft:cobblestone'), { reason: sl.reason });
    check('and listed in the shared registry (once, with its kind and the bot)', svc.temps.size === 1 && svc.temps.counts().seal === 1 && svc.temps.list()[0].by === A, svc.temps.list());
    const env = svc.envFactory(bot, { cancelled: false }, { worker: true });
    await sleep(6000);                                                                                   // the flowing water the source left behind has to run out first (a seal beside water stays, by design)
    const c1 = await cleanTemps(env, { radius: 30 }); await sleep(800);
    check('cleaned up: nothing flows (the water was replaced), the block is broken', c1.broken === 1 && await is(WX, y, WZ, 'minecraft:air'), c1);
    check('and the registry is empty (placed and broken are one set)', svc.temps.size === 0, svc.temps.list());
    // a seal with water beside it stays
    await S.must(`setblock ${WX + 1} ${y} ${WZ} minecraft:water`); await S.must(`setblock ${WX} ${y} ${WZ} minecraft:water`); await sleep(400);
    const sl2 = await execute(bot, 'place', { x: WX, y, z: WZ, item: 'cobblestone', fluid: true, temp: 'seal' });
    const c2 = await cleanTemps(env, { radius: 30 });
    check('a seal that holds water back stays', sl2.ok && c2.kept === 1 && c2.broken === 0 && await is(WX, y, WZ, 'minecraft:cobblestone') && svc.temps.size === 1, { c2, sl2: sl2.reason });

    // ---- 4. one trip stores everything; a full chest is followed by the next
    const SX = BX + 20, SZ = BZ + 14;
    await S.must(`setblock ${SX} ${y} ${SZ} minecraft:chest`); await S.must(`setblock ${SX + 3} ${y} ${SZ} minecraft:chest`);
    for (let i = 0; i < 27; i++) await S.must(`item replace block ${SX} ${y} ${SZ} container.${i} with minecraft:stone_bricks 64`);
    await sleep(2000);
    svc.addSite({ name: 'full', x: SX, y, z: SZ, tags: ['any'] }); svc.addSite({ name: 'spare', x: SX + 3, y, z: SZ, tags: ['any'] });
    await S.must(`clear ${A}`);
    const kinds = ['dirt', 'gravel', 'sand', 'coal', 'raw_iron', 'raw_copper', 'redstone', 'lapis_lazuli', 'clay_ball', 'flint', 'bone', 'string', 'gunpowder', 'quartz', 'diamond', 'emerald', 'oak_log', 'birch_log'];
    for (const k of kinds) await S.must(`give ${A} minecraft:${k} 64`);
    await S.must(`give ${A} minecraft:cobblestone 640`); await S.must(`give ${A} minecraft:andesite 128`); await sleep(800);
    await S.must(`tp ${A} ${SX + 1}.5 ${y} ${SZ + 3}.5`); await sleep(1500);
    const e2 = svc.envFactory(bot, { cancelled: false }, { worker: true }), inv0 = e2.inv();
    const pol = svc._pitPolicy(null), plan = janitor.plan(inv0.items, inv0.slotsFree, pol, inv0.worn);
    check('the plan stores many kinds in one trip (not one stack)', plan.filter((o) => o.op === 'deposit').length >= 12, plan.map((o) => `${o.item}:${o.count}`));
    const m = await janitor.maintain(e2, pol); await sleep(1200);
    const left = e2.inv();
    const spare = clean(await S.cmd(`data get block ${SX + 3} ${y} ${SZ} Items`));
    check('the trip worked (ok)', m.ok, { ok: m.ok, reason: m.reason, done: (m.done || []).length });
    check('the full chest was left as it was (27 stacks of stone bricks, nothing more fits)', (clean(await S.cmd(`data get block ${SX} ${y} ${SZ} Items`)).match(/stone_bricks/g) || []).length === 27);
    check('the next chest got the rest, in the same trip', (spare.match(/id:/g) || []).length >= 10 && /coal/.test(spare) && /diamond/.test(spare), { stacks: (spare.match(/id:/g) || []).length });
    check('the bot has room again (18 or more free slots)', left.slotsFree >= 18, { free: left.slotsFree });
    const m2 = await janitor.maintain(e2, pol);
    check('and a second upkeep right after finds nothing to do', m2.ok && !(m2.done || []).length, { done: (m2.done || []).length });

    await svc.stop(); await S.must(`forceload remove ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`).catch(() => {});
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('[live] error', e); process.exit(2); });

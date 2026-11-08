'use strict';
// Live check of a routine on a REAL Forge server (the demo server): a bot repeats "nine iron nuggets from the chest -> an ingot at the table; nine ingots -> a block into
// the chest" until stopped. Graded on the server: the chest's items (data get block), the bot's pack (clear ... 0). Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=routine_live.js ./live.sh)
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
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/routine-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'RtnA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const BX = 3100, BZ = 3100, FLOOR = -61, top = FLOOR + 4, y = top + 1;
    await S.must(`gamemode survival ${A}`); await S.must(`clear ${A}`); await S.must('time set day');
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`);
    await S.must(`fill ${BX - 2} ${FLOOR + 1} ${BZ - 2} ${BX + 12} ${top} ${BZ + 12} minecraft:stone`);
    await S.must(`fill ${BX - 2} ${top + 1} ${BZ - 2} ${BX + 12} ${top + 8} ${BZ + 12} minecraft:air`); await sleep(1500);
    await S.must(`setblock ${BX + 2} ${y} ${BZ} minecraft:chest`); await S.must(`setblock ${BX + 4} ${y} ${BZ} minecraft:crafting_table`);
    // 162 nuggets in the chest: 18 ingots = two blocks
    for (let s = 0; s < 3; s++) await S.must(`item replace block ${BX + 2} ${y} ${BZ} container.${s} with minecraft:iron_nugget 54`);
    await S.must(`tp ${A} ${BX + 3} ${y} ${BZ + 2}`); await sleep(1500);
    svc.addSite({ name: 'nugget-chest', x: BX + 2, y, z: BZ, purpose: 'any' });
    svc.addSite({ name: 'nugget-table', x: BX + 4, y, z: BZ, purpose: 'other', label: 'crafting table' });
    svc.putScript({ name: 'nuggets-to-blocks', steps: [
        { if: { not: { has: { item: 'iron_nugget', min: 9 } } }, then: [{ take: { item: 'iron_nugget', count: 9, from: 'nugget-chest' }, optional: true }] },
        { if: { has: { item: 'iron_nugget', min: 9 } }, then: [{ cmd: 'craft', args: { item: 'iron_ingot', count: 1 }, at: 'nugget-table' }] },
        { if: { has: { item: 'iron_ingot', min: 9 } }, then: [{ cmd: 'craft', args: { item: 'iron_block', count: 1 }, at: 'nugget-table' }, { cmd: 'deposit', args: { item: 'iron_block', count: 1 }, at: 'nugget-chest' }] },
        { return: 'ok' },
    ] });
    const chestHas = async (id) => { const o = clean(await S.cmd(`data get block ${BX + 2} ${y} ${BZ} Items`)); const m = new RegExp(`Count: (\\d+)b, Slot: \\d+b, id: "minecraft:${id}"|id: "minecraft:${id}", Count: (\\d+)b|Count: (\\d+)b, id: "minecraft:${id}"`, 'g'); let n = 0, r; while ((r = m.exec(o))) n += Number(r[1] || r[2] || r[3]); return n; };
    const t0 = Date.now();
    svc.startRoutine(A, 'nuggets-to-blocks', { pauseMs: 1000 });
    await until(async () => (await chestHas('iron_block')) >= 2, 240000, 'two blocks in the chest');
    check('the routine made two iron blocks from 162 nuggets and put them into the chest (server: chest NBT)', (await chestHas('iron_block')) >= 2, { blocks: await chestHas('iron_block'), nuggets: await chestHas('iron_nugget'), seconds: Math.round((Date.now() - t0) / 1000), routine: svc.bots.get(A).script && svc.bots.get(A).script.routine });
    await sleep(8000);                                                    // it keeps running with an empty chest: waits, does not fail
    const rec = svc.bots.get(A);
    check('with the chest empty it keeps waiting instead of failing (still a routine, no failed rounds)', rec.script && rec.script.routine && rec.script.routine.fails === 0, rec.script && rec.script.routine);
    await svc.runCommand({ bots: [A], command: 'stop' }); await until(() => !svc.bots.get(A).script, 30000, 'routine stops');
    check('Stop ended it', !svc.bots.get(A).script);
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

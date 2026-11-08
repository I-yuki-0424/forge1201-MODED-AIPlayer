'use strict';
// Live check of Ender Storage and container fixtures on a REAL Forge server (the demo server, play mod set). Grading is the SERVER's state (clear counts,
// the block entity, the world's EnderStorage files after save-all), not the bots' reports. Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=ender_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const FLOOR = -61, BX = 2900, BZ = 2900;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/ender-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'EndA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const bot = svc.bots.get(A).bot;
    await S.must(`gamemode survival ${A}`); await S.must(`clear ${A}`); await S.must('time set day');
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`);
    const top = FLOOR + 4, y = top + 1;
    await S.must(`fill ${BX - 2} ${FLOOR + 1} ${BZ - 2} ${BX + 24} ${top} ${BZ + 24} minecraft:stone`);
    await S.must(`fill ${BX - 2} ${top + 1} ${BZ - 2} ${BX + 24} ${top + 8} ${BZ + 24} minecraft:air`); await sleep(1500);
    const held = async (spec) => { const o = await S.cmd(`clear ${A} ${spec} 0`); const m = /(\d+)/.exec(o.replace(/\x1b\[[0-9;]*m/g, '')); return /No items were found/i.test(o) ? 0 : m ? Number(m[1]) : 0; };
    const env = svc.envFactory(bot, { cancelled: false });
    const cmd = (command, args) => env.exec(command, args);

    // ---- a mod chest the owner placed: colours blue / white / white
    await S.must(`setblock ${BX + 4} ${y} ${BZ + 4} enderstorage:ender_chest`);
    await S.must(`data merge block ${BX + 4} ${y} ${BZ + 4} {Frequency:{left:11,middle:0,right:0}}`);
    console.log('[live] block entity:', (await S.cmd(`data get block ${BX + 4} ${y} ${BZ + 4}`)).slice(0, 300));
    await S.must(`tp ${A} ${BX + 4.5} ${y} ${BZ + 1.5}`); await sleep(1500);
    await S.must(`give ${A} minecraft:cobblestone 40`); await sleep(500);
    const d = await cmd('deposit', { item: 'cobblestone', count: 30, x: BX + 4, y, z: BZ + 4 });
    console.log('[live] deposit result', JSON.stringify(d).slice(0, 400));
    check('the bot put 30 cobblestone into the Ender Storage chest', d && d.ok !== false && (await held('minecraft:cobblestone')) === 10, d);
    const w = await cmd('withdraw', { item: 'cobblestone', count: 12, x: BX + 4, y, z: BZ + 4 });
    check('and took 12 back out', w && w.ok !== false && (await held('minecraft:cobblestone')) === 22, w);
    // ---- the owner's boxes are fixtures: the bots may use what is inside, never break the block
    await S.must(`setblock ${BX + 8} ${y} ${BZ + 4} minecraft:chest`); await S.must(`setblock ${BX + 10} ${y} ${BZ + 4} enderstorage:ender_chest`);
    await S.must(`setblock ${BX + 12} ${y} ${BZ + 4} minecraft:red_shulker_box`); await S.must(`setblock ${BX + 14} ${y} ${BZ + 4} minecraft:ender_chest`);
    await S.must(`give ${A} minecraft:diamond_pickaxe 1`); await S.must(`tp ${A} ${BX + 11} ${y} ${BZ + 1.5}`); await sleep(1500);
    const blockIs = async (dx, id) => /passed|Test passed/i.test(await S.cmd(`execute if block ${BX + dx} ${y} ${BZ + 4} ${id}`));
    for (const [dx, id] of [[8, 'minecraft:chest'], [10, 'enderstorage:ender_chest'], [12, 'minecraft:red_shulker_box'], [14, 'minecraft:ender_chest']]) {
        const m = await cmd('mine', { x: BX + dx, y, z: BZ + 4 });
        check(`mine refuses the owner's ${id}`, !m.ok && m.reason === 'protected' && await blockIs(dx, id), { reason: m.reason });
    }
    // a pit that has such a box inside its area leaves it standing and counts the cell as skipped
    // ---- a box the bot carries: placed, used, picked up again at once (the shulker depot of the upkeep)
    const janitor = require('../../src/work/bot/janitor');
    await S.must(`clear ${A} minecraft:cobblestone`); await S.must(`give ${A} minecraft:cobblestone 300`); await S.must(`give ${A} minecraft:red_shulker_box 1`); await sleep(500);
    await S.must(`tp ${A} ${BX + 4} ${y} ${BZ + 12}`); await sleep(1500);
    const cancel = { cancelled: false }, wenv = svc.envFactory(bot, cancel, { worker: true });
    const m1 = await janitor.maintain(wenv, janitor.pitPolicy({ depot: { kind: 'shulker', item: 'red_shulker_box', minValue: 0 }, freeTarget: 36, sites: () => svc.sites }));
    await sleep(800);
    const dropped = await S.cmd('execute if entity @e[type=minecraft:item,nbt={Item:{id:"minecraft:red_shulker_box"}}]');
    const standing = await S.cmd(`fill ${BX + 1} ${y - 1} ${BZ + 9} ${BX + 7} ${y + 2} ${BZ + 15} minecraft:air replace minecraft:red_shulker_box`);
    check('the shulker the bot placed was picked up again: it is in the pack, no box stands near, none lies on the ground, nothing was left behind',
        m1.ok && (await held('minecraft:red_shulker_box')) === 1 && /No blocks were filled|Could not/i.test(standing) && !/Test passed/i.test(dropped) && !(wenv.left && wenv.left.length), { ok: m1.ok, done: m1.done && m1.done.length, left: wenv.left, standing: standing.slice(-60) });
    check('and the cobblestone went into it (the pack lost it)', (await held('minecraft:cobblestone')) < 300, { cobblestone: await held('minecraft:cobblestone') });

    // ---- an Ender Storage chest the bot carries (colours light blue / light gray / black in the item): placed, filled, picked up
    await S.must(`clear ${A} minecraft:cobblestone`); await S.must(`give ${A} minecraft:stone 20`);
    await S.must(`give ${A} enderstorage:ender_chest{Frequency:{left:3,middle:8,right:15}} 1`); await sleep(500);
    console.log('[live] item NBT:', (await S.cmd(`data get entity ${A} Inventory`)).replace(/\x1b\[[0-9;]*m/g, '').slice(-400));
    const spot = { x: BX + 4, y, z: BZ + 14 };
    await S.must(`tp ${A} ${spot.x} ${y} ${spot.z - 2}`); await sleep(1200);
    const pl = await cmd('place', { ...spot, item: 'enderstorage:ender_chest' });
    check('the bot placed its Ender Storage chest', pl.ok, pl);
    if (pl.ok) {
        const fq = (await S.cmd(`data get block ${spot.x} ${spot.y} ${spot.z} Frequency`)).replace(/\x1b\[[0-9;]*m/g, '');
        check('the placed chest has the colours of the item (3 / 8 / 15 = light blue, light gray, black)', /left: 3/.test(fq) && /middle: 8/.test(fq) && /right: 15/.test(fq), fq.slice(-80));
        const dep = await cmd('deposit', { item: 'stone', count: 15, ...spot });
        check('and put 15 stone into it', dep.ok && (await held('minecraft:stone')) === 5, dep.ok ? dep : { reason: dep.reason, detail: dep.detail });
        const own = svc.placed.has(`${spot.x},${spot.y},${spot.z}`) || (bot.__placed && bot.__placed.has(`${spot.x},${spot.y},${spot.z}`));
        check('the placed chest is remembered as its own', own);
        const br = await cmd('mine', spot);
        await sleep(800);
        check('it broke its own chest and picked it up again, still set to the same colours', br.ok && (await held('enderstorage:ender_chest{Frequency:{left:3,middle:8,right:15}}')) === 1, br.ok ? { got: br.got } : { reason: br.reason, detail: br.detail });
        console.log('[live] item NBT after:', (await S.cmd(`data get entity ${A} Inventory`)).replace(/\x1b\[[0-9;]*m/g, '').slice(-400));
    }
    await S.must('save-all flush'); await sleep(1500);

    await svc.stop(); await S.must(`forceload remove ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`).catch(() => {});
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

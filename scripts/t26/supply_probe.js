'use strict';
// Probe (test code): one SURVIVAL bot fetches from a chest of shulker boxes with src/build/supply.js (take a box, set it down, open, take, break it, pick it up, put it back);
// the chest's content before and after read by the SERVER. scripts/t26/run.sh N supply_probe.js
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const { Mover, View, feet } = require('../../src/build/move');
const SUP = require('../../src/build/supply');
const sleep = T.sleep, strip = T.strip;
(async () => {
    const { S } = await T.connectRcon();
    await S.cmd('difficulty peaceful');
    const name = `Sp${T.WORLD}`;
    const bot = createBot({ host: 'mc', port: 25565, username: name, viewDistance: 4 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res) => bot.once('spawn', res));
    await S.cmd(`gamemode survival ${name}`); await S.cmd(`clear ${name}`);
    await sleep(2500);
    const f = feet(bot), C = { x: f.x + 3, y: f.y, z: f.z };
    await S.cmd(`fill ${C.x - 4} ${C.y - 1} ${C.z - 4} ${C.x + 4} ${C.y - 1} ${C.z + 4} minecraft:stone`);
    await S.cmd(`fill ${C.x - 4} ${C.y} ${C.z - 4} ${C.x + 4} ${C.y + 3} ${C.z + 4} minecraft:air`);
    await S.cmd(`setblock ${C.x} ${C.y} ${C.z} minecraft:chest[facing=north]`);
    const tmp = { x: C.x, y: C.y + 2, z: C.z };
    for (const [slot, list] of [[0, [['dirt', 64], ['dirt', 64], ['diamond_pickaxe', 1]]], [1, [['glass', 64], ['diamond_shovel', 1]]]]) {
        await S.cmd(`setblock ${tmp.x} ${tmp.y} ${tmp.z} minecraft:white_shulker_box`);
        for (const [j, [it, n]] of list.entries()) await S.cmd(`item replace block ${tmp.x} ${tmp.y} ${tmp.z} container.${j} with minecraft:${it} ${n}`);
        await S.cmd(`loot replace block ${C.x} ${C.y} ${C.z} container.${slot} mine ${tmp.x} ${tmp.y} ${tmp.z} minecraft:iron_pickaxe`);
        await S.cmd(`setblock ${tmp.x} ${tmp.y} ${tmp.z} minecraft:air`);
    }
    await S.cmd(`tp ${name} ${C.x - 1.5} ${C.y} ${C.z + 0.5}`);
    await sleep(2000);
    const mv = new Mover(bot, { canDig: () => false, temp: () => null, onTemp: () => {} });
    const spot = () => { const v = new View(bot, { canDig: () => false }), me = feet(bot); for (const [dx, dz] of [[-2, 0], [0, -2], [0, 2], [-2, -1], [-2, 1], [2, 0]]) { const s = { x: C.x + dx, y: C.y, z: C.z + dz }; if ((s.x !== me.x || s.z !== me.z) && v.free(s.x, s.y, s.z) && v.free(s.x, s.y + 1, s.z)) return s; } return null; };
    const depot = [];
    const r = await SUP.fetch(bot, C, { dirt: 100, diamond_pickaxe: 1, diamond_shovel: 1 }, mv, spot, { log: (m) => console.log('[log]', m), depot });
    console.log('[depot]', JSON.stringify(depot));
    const r2 = await SUP.fetch(bot, C, { glass: 64 }, mv, spot, { log: (m) => console.log('[log]', m), depot });
    console.log('[from the depot]', JSON.stringify(r2));
    const lost = await SUP.repack(bot, C, depot, mv, { log: (m) => console.log('[log]', m) });
    console.log('[repack] lost', lost);
    console.log('[fetch]', JSON.stringify(r), 'pack', JSON.stringify(SUP.carried(bot)));
    const left = strip(await S.cmd(`data get block ${C.x} ${C.y} ${C.z} Items`));
    console.log('[chest after]', left.slice(0, 600));
    bot.quit(); await sleep(300); process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });

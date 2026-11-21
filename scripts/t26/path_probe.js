'use strict';
// Probe (test code): does mineflayer-pathfinder drive a SURVIVAL bot on 26.1: a walk over natural terrain, a pillar of 8 with dirt, the way back down digging its own pillar.
// Read back by RCON (position, the pillar cells). scripts/t26/run.sh N path_probe.js
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const sleep = T.sleep;

(async () => {
    const { S } = await T.connectRcon();
    await S.cmd('difficulty peaceful');
    const name = `Pp${T.WORLD}`;
    const bot = createBot({ host: 'mc', port: 25565, username: name, viewDistance: 6 });
    attachHandshake(bot, { registry: 'vanilla' });
    bot.loadPlugin(pathfinder);
    await new Promise((res) => bot.once('spawn', res));
    await S.cmd(`gamemode survival ${name}`); await S.cmd(`clear ${name}`);
    await S.cmd(`give ${name} minecraft:dirt 64`); await S.cmd(`give ${name} minecraft:diamond_pickaxe 1`); await S.cmd(`give ${name} minecraft:diamond_shovel 1`);
    await sleep(3000);
    const mv = new Movements(bot);
    mv.scafoldingBlocks = [bot.registry.itemsByName.dirt.id];
    mv.allowParkour = false; mv.maxDropDown = 3; mv.allow1by1towers = true; mv.canDig = true;
    bot.pathfinder.setMovements(mv);
    bot.pathfinder.thinkTimeout = 5000;
    const p0 = bot.entity.position.floored();
    const t = async (label, goal, ms = 60000) => {
        const t0 = Date.now();
        try { await Promise.race([bot.pathfinder.goto(goal), sleep(ms).then(() => { throw new Error('timeout'); })]); console.log(`[${label}] ok in ${Date.now() - t0} ms at`, bot.entity.position.floored(), 'server', await T.posOf(S, name)); }
        catch (e) { console.log(`[${label}] FAILED ${e.message} after ${Date.now() - t0} ms at`, bot.entity.position.floored()); bot.pathfinder.stop(); }
    };
    await t('walk 30', new goals.GoalNear(p0.x + 30, p0.y, p0.z + 10, 1));
    const p1 = bot.entity.position.floored();
    await t('pillar 8', new goals.GoalBlock(p1.x, p1.y + 8, p1.z));
    console.log('dirt left', bot.inventory.items().filter((i) => i.name === 'dirt').reduce((a, i) => a + i.count, 0));
    await t('down', new goals.GoalBlock(p1.x, p1.y, p1.z));
    let left = 0; for (let y = p1.y; y < p1.y + 9; y++) if (/passed/.test(T.strip(await S.cmd(`execute if block ${p1.x} ${y} ${p1.z} minecraft:dirt`)))) left++;
    console.log('pillar cells still dirt', left, 'health', bot.health);
    bot.quit(); await sleep(300); process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });

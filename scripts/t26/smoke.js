'use strict';
// T26 smoke: one bot logs in on 26.1, reads its surroundings, digs the block under it and places it back. Not evidence of anything but the protocol.
const L = require('../real/lib');
const Vec3 = require('vec3');
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, ['Smoke1'], { teleport: 'off' });
    const bot = svc.bots.get('Smoke1').bot;
    console.log('version', bot.version, 'pos', bot.entity.position, 'hp', bot.health, 'food', bot.food, 'game', bot.game.gameMode, bot.game.difficulty);
    const f = bot.entity.position.floored();
    for (let dy = -2; dy <= 2; dy++) { const b = bot.blockAt(f.offset(0, dy, 0)); console.log(dy, b && b.name, b && b.boundingBox); }
    console.log(await S.cmd('give Smoke1 minecraft:netherite_pickaxe 1'), await S.cmd('give Smoke1 minecraft:cobblestone 8'));
    await L.sleep(1500);
    const env = svc._envFor ? null : null;
    const { execute } = require('../../src/skills');
    const under = f.offset(0, -1, 0);
    const m = await execute(bot, 'mine', { x: under.x + 1, y: under.y, z: under.z, collect: true });
    console.log('mine', JSON.stringify(m).slice(0, 300));
    const p = await execute(bot, 'place', { x: under.x + 1, y: under.y, z: under.z, item: 'cobblestone' });
    console.log('place', JSON.stringify(p).slice(0, 300));
    const mv = await execute(bot, 'move_to', { x: f.x + 6, y: f.y, z: f.z + 3 });
    console.log('move_to', JSON.stringify(mv).slice(0, 300));
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// Does a bot see a batch of block changes (one `fill` = one multi-block update packet)? (2026-11-18)
const T = require('./lib');
const { createBot, attachHandshake } = require('../../src/transport');
const Vec3 = require('vec3');
(async () => {
    const { S } = await require('../real/lib').connectRcon();
    const bot = createBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: `Vq${T.WORLD}`, viewDistance: 6 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
    const pk = {}; bot._client.on('packet', (d, m) => { if (/block|section|chunk/.test(m.name)) pk[m.name] = (pk[m.name] || 0) + 1; });
    bot.on('blockUpdate', () => { pk.blockUpdateEvent = (pk.blockUpdateEvent || 0) + 1; });
    const x = 900, y = 230, z = 0;
    await S.must(`forceload add ${x} ${z}`); await S.must(`tp Vq${T.WORLD} ${x + 2} ${y + 3} ${z}`); await T.sleep(4000);
    const read = (a) => a.map(([dx, dy, dz]) => { const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz)); return b ? b.name : 'unloaded'; }).join(',');
    const cells = [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 0, 3], [0, 0, 4], [1, 0, 0], [1, 1, 0]];
    await S.cmd(`fill ${x} ${y} ${z} ${x + 1} ${y + 1} ${z + 4} minecraft:air`); await T.sleep(5000);
    console.log('before', read(cells));
    await S.cmd(`fill ${x} ${y} ${z} ${x} ${y} ${z + 4} minecraft:glass`); await T.sleep(5000);   // five blocks, one tick, one section
    console.log('after a 5-block fill (bot view):', read(cells));
    for (let i = 0; i < 5; i++) await S.cmd(`setblock ${x + 1} ${y} ${z + i} minecraft:stone`);
    await T.sleep(5000);
    console.log('after 5 setblocks (bot view):', read(cells), JSON.stringify(pk));
    await S.cmd(`fill ${x} ${y} ${z} ${x + 1} ${y + 1} ${z + 4} minecraft:air`);
    bot.quit(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

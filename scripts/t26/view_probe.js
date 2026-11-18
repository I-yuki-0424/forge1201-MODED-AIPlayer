'use strict';
// Does a bot's world view match the server's? (2026-11-18: builders saw `air` in cells the server held glass in.) Connects one bot next to the box in COORDS, reads every cell of the box with blockAt and
// compares it with the server (RCON `execute if block`). COORDS=x0,y0,z0,x1,y1,z1
const T = require('./lib');
const { createBot, attachHandshake } = require('../../src/transport');
const Vec3 = require('vec3');
(async () => {
    const [x0, y0, z0, x1, y1, z1] = (process.env.COORDS || '').split(',').map(Number);
    const { S } = await T.open([], {}).catch(async () => ({ S: (await require('../real/lib').connectRcon()).S }));
    const bot = createBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: `Vp${T.WORLD}`, viewDistance: 6 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
    await S.must(`tp Vp${T.WORLD} ${x0} ${y1 + 3} ${z0}`); await T.sleep(5000);
    let diff = 0, n = 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const b = bot.blockAt(new Vec3(x, y, z)), seen = b ? b.name : 'unloaded';
        const srv = /^Test passed/.test(T.strip(await S.cmd(`execute if block ${x} ${y} ${z} minecraft:${seen === 'unloaded' ? 'air' : seen}`)));
        n++; if (!srv) { diff++; if (diff <= 12) console.log(`DIFF ${x},${y},${z} bot=${seen} server differs`); }
    }
    console.log(`view probe: ${diff} of ${n} cells differ`);
    bot.quit(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

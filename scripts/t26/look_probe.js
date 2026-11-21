'use strict';
// Probe (test code): is the look the server uses for a placement the one the hand just sent? Observers (facing = look) placed into the air with each horizontal direction,
// three ways of sending the look. scripts/t26/run.sh N look_probe.js
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const { Hand, sleep } = require('../../src/build/act');
const R = require('../../src/build/rules');
const fly = require('../../src/build/fly');
(async () => {
    const { S: srv } = await T.connectRcon();
    const name = `Lp${T.WORLD}`;
    const bot = createBot({ host: 'mc', port: 25565, username: name, viewDistance: 4 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res) => bot.once('spawn', res));
    await srv.cmd(`gamemode creative ${name}`); await sleep(800);
    const p0 = await T.posOf(srv, name), X = Math.floor(p0.x), Y = 210, Z = Math.floor(p0.z);
    fly.takeOff(bot);
    await srv.cmd(`tp ${name} ${X + 0.5} ${Y} ${Z + 0.5}`); await sleep(2000);
    const hand = new Hand(bot);
    for (const mode of ['now', 'tick', 'look']) {
        let ok = 0, n = 0; const bad = [];
        for (let rep = 0; rep < 3; rep++) for (const [j, d] of ['north', 'east', 'south', 'west', 'north', 'west', 'east', 'south'].entries()) {
            const c = { x: X + (mode === 'now' ? 2 : mode === 'tick' ? 3 : -2), y: Y - 1 + rep, z: Z - 3 + j };
            hand.hold('observer');
            const a = R.lookAngles({ h: d });
            if (mode === 'look') { bot.look(a.yaw, a.pitch, true); bot._client.write('look', { yaw: (180 - (a.yaw * 180) / Math.PI) % 360, pitch: (-a.pitch * 180) / Math.PI, flags: { onGround: false, hasHorizontalCollision: false } }); }
            else hand.look(a.yaw, a.pitch);
            if (mode === 'tick') await sleep(60);
            hand.use(c, 1);
            await sleep(120);
            const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); n++;
            if (n === 1) console.log('pos', bot.entity.position, 'cell', c, 'bot sees', b && b.name, 'server', T.strip(await srv.cmd(`execute if block ${c.x} ${c.y} ${c.z} minecraft:observer`)), 'held', bot.heldItem && bot.heldItem.name, 'slot', bot.quickBarSlot);
            if (b && b.getProperties().facing === d) ok++; else bad.push(`${d}->${b && b.getProperties().facing}`);
        }
        console.log(`[look ${mode}] ${ok}/${n} ${bad.join(' ')}`);
    }
    await srv.cmd(`fill ${X - 3} ${Y - 2} ${Z - 4} ${X + 4} ${Y + 3} ${Z + 6} air`);
    bot.quit(); await sleep(300); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

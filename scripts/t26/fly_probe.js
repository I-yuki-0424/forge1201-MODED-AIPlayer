'use strict';
// Probe (test code): can a creative bot (1) fly by position packets, (2) place a block into an AIR cell with a free choice of clicked face and look ("air place"),
// (3) get the resulting state the vanilla placement rules predict (hopper = opposite of clicked face, observer/piston = look), (4) break it instantly. Read back by RCON.
// scripts/t26/run.sh N fly_probe.js
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const sleep = T.sleep, strip = T.strip;

(async () => {
    const { S } = await T.connectRcon();
    const name = `Fp${T.WORLD}`;
    const bot = createBot({ host: process.env.MC_HOST || 'mc', port: 25565, username: name, viewDistance: 4 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', (r) => rej(new Error('kicked ' + JSON.stringify(r)))); });
    bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r)));
    await S.cmd(`gamemode creative ${name}`);
    await sleep(1500);
    const p0 = await T.posOf(S, name);
    console.log('start', p0, 'mode', bot.game.gameMode);
    // fly: physics off, the bot's own position is what mineflayer sends every tick
    bot.physicsEnabled = false;
    bot._client.write('abilities', { flags: 2 });
    const start = bot.entity.position.clone();
    const goal = start.offset(0, 12, 0);
    for (let i = 1; i <= 24; i++) { bot.entity.position = start.offset(0, (12 * i) / 24, 0); await sleep(50); }
    await sleep(1500);
    const p1 = await T.posOf(S, name);
    console.log('after climb: server', p1, 'want', goal);
    // horizontal 10 blocks east at 0.5 per tick
    const s2 = bot.entity.position.clone();
    for (let i = 1; i <= 20; i++) { bot.entity.position = s2.offset(0.5 * i, 0, 0); await sleep(50); }
    await sleep(1500);
    console.log('after east: server', await T.posOf(S, name), 'bot', bot.entity.position);
    // items into the hotbar by the creative slot packet
    const Item = require('prismarine-item')(bot.registry);
    const give = async (slot, nm) => { await bot.creative.setInventorySlot(36 + slot, new Item(bot.registry.itemsByName[nm].id, 1)); };
    await give(0, 'stone'); await give(1, 'hopper'); await give(2, 'observer'); await give(3, 'sticky_piston'); await give(4, 'repeater');
    await sleep(500);
    console.log('hotbar', bot.inventory.slots.slice(36, 41).map((s) => s && s.name));
    const me = bot.entity.position.floored();
    const placeAt = async (slot, cell, face, yaw, pitch, cursor = [0.5, 0.5, 0.5], sneak = false) => {
        bot.setQuickBarSlot(slot); await sleep(100);
        await bot.look(yaw, pitch, true);
        await sleep(150);
        bot._client.write('block_place', { location: cell, direction: face, hand: 0, cursorX: cursor[0], cursorY: cursor[1], cursorZ: cursor[2], insideBlock: false, worldBorderHit: false, sequence: 1 });
        await sleep(400);
        const o = strip(await S.cmd(`data get block ${cell.x} ${cell.y} ${cell.z}`));
        const b = bot.blockAt(cell);
        return { bot: b && b.name, props: b && b.getProperties(), rcon: o.slice(0, 80) };
    };
    // stone 3 east of the bot's feet, mid-air, clicked face 'up' (1)
    const c1 = me.offset(3, 0, 0);
    console.log('stone air place', await placeAt(0, c1, 1, 0, 0));
    console.log('server says', strip(await S.cmd(`execute if block ${c1.x} ${c1.y} ${c1.z} minecraft:stone`)));
    // hopper: clicked face east (5) -> facing west expected; face north (2) -> facing south
    const c2 = me.offset(3, 2, 0), c3 = me.offset(3, 2, 2);
    console.log('hopper face east', await placeAt(1, c2, 5, 0, 0));
    console.log('hopper face north', await placeAt(1, c3, 2, 0, 0));
    for (const c of [c2, c3]) for (const f of ['west', 'south', 'east', 'north', 'down']) { const r = strip(await S.cmd(`execute if block ${c.x} ${c.y} ${c.z} minecraft:hopper[facing=${f}]`)); if (/passed/.test(r)) console.log('  hopper at', c, 'facing', f); }
    // observer: looking east (yaw -pi/2 in mineflayer = east) -> observer facing = looking direction... check what we get
    const c4 = me.offset(3, -2, 0);
    console.log('observer look east', await placeAt(2, c4, 1, -Math.PI / 2, 0));
    const c5 = me.offset(3, -2, 2);
    console.log('sticky_piston look down', await placeAt(3, c5, 1, 0, -Math.PI / 2));
    for (const [i, yw] of [[0, 0], [1, Math.PI / 2], [2, Math.PI], [3, -Math.PI / 2]]) { const c = me.offset(-3, 0, -6 + 3 * i); const r = await placeAt(2, c, 1, yw, 0); console.log('observer yaw', yw.toFixed(2), '->', r.props && r.props.facing); await S.cmd(`setblock ${c.x} ${c.y} ${c.z} air`); }
    const c6 = me.offset(3, -4, 0);
    console.log('repeater air place (no floor) ', await placeAt(4, c6, 1, 0, 0));
    // break the stone (creative: start dig = break)
    bot._client.write('block_dig', { status: 0, location: c1, face: 1, sequence: 2 });
    await sleep(500);
    console.log('after break', strip(await S.cmd(`execute if block ${c1.x} ${c1.y} ${c1.z} minecraft:air`)));
    console.log('final server pos', await T.posOf(S, name));
    for (const c of [c2, c3, c4, c5, c6]) await S.cmd(`setblock ${c.x} ${c.y} ${c.z} air`);
    bot.quit(); await sleep(500); process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

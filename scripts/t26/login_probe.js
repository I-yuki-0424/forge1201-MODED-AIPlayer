'use strict';
// Login probe (TASK-20261125-074): one bot logs in through the production transport, reports the version it speaks, its position and its pack, and leaves. Changes nothing in the
// world (no command, no dig, no move), so it may run against a server the owner builds on, as a live check that the code still speaks that server's version.
//   scripts/t26/run.sh N login_probe.js            a test world
//   scripts/t26/f26.sh creative login_probe.js     the 26.x creative server (MC_VERSION= empty: the bot asks the server for its version)
const { createBot, attachHandshake } = require('../../src/transport');
const name = process.env.PROBE_NAME || 'Lp1';
const bot = createBot({ host: process.env.MC_HOST || 'mc', port: Number(process.env.MC_PORT) || 25565, username: name });
attachHandshake(bot, { registry: 'auto' });
const quit = (code, msg) => { console.log(msg); try { bot.quit(); } catch (_) { /* gone */ } setTimeout(() => process.exit(code), 500); };
const timer = setTimeout(() => quit(1, '[login] FAIL: no spawn within 60 s'), 60000);
bot.once('spawn', () => setTimeout(() => {
    clearTimeout(timer);
    const items = bot.inventory.items().map((i) => `${i.name}x${i.count}`);
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    quit(0, `[login] PASS ${name} speaks ${bot.version} (protocol ${bot.protocolVersion}), asked: ${process.env.MC_VERSION || 'the server (status ping)'}; at ${bot.entity.position.floored()} on ${below && below.name}; game mode ${bot.game.gameMode}; pack ${items.length} stacks ${items.slice(0, 5).join(' ')}`);
}, 2000));
bot.on('kicked', (r) => quit(1, `[login] FAIL kicked: ${JSON.stringify(r).slice(0, 300)}`));
bot.on('error', (e) => quit(1, `[login] FAIL ${e.message}`));

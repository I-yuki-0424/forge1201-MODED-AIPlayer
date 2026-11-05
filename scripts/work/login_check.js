'use strict';
// Does a bot log in to a Forge server, get the exact mod table, and stand in the world? Test code (no assertions beyond "spawned").
//   MC_HOST=forgeaip-play MC_PORT=25565 BOT_MOD_TABLE=/play/registry.json node scripts/work/login_check.js [name]
const { createForgeBot, attachForgeHandshake } = require('../../src/transport/forge_bot');
const name = process.argv[2] || 'LoginCheck';
const bot = createForgeBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: name, viewDistance: 4 });
attachForgeHandshake(bot, { registry: process.env.BOT_REGISTRY || 'auto' });
bot.on('error', (e) => console.error('[login] error:', String(e.message || e).slice(0, 300)));
bot.on('kicked', (r) => console.error('[login] kicked:', String(JSON.stringify(r)).slice(0, 400)));
bot.on('end', (r) => console.error('[login] end:', r));
const t = setTimeout(() => { console.error('[login] FAIL no spawn in 90 s'); process.exit(1); }, 90000);
bot.once('spawn', async () => {
    clearTimeout(t);
    await new Promise((r) => setTimeout(r, 6000));                        // let chunks arrive
    const p = bot.entity.position, reg = bot.registry;
    const mods = Object.keys(reg.blocksByName).filter((n) => n.includes(':') || !/^[a-z_]+$/.test(n)).length;
    const below = bot.blockAt(p.offset(0, -1, 0));
    console.log(`[login] PASS spawned at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} gm=${bot.game.gameMode} dim=${bot.game.dimension}`);
    console.log(`[login] blocks in registry: ${Object.keys(reg.blocksByName).length}, items: ${Object.keys(reg.itemsByName).length}, modlike names: ${mods}, block below: ${below && below.name}`);
    bot.quit(); setTimeout(() => process.exit(0), 500);
});

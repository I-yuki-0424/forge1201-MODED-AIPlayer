// Probe: what the server sends in the advancements packet after a grant (RL v2 debugging, 2026-11-01).
const { createForgeBot, attachForgeHandshake } = require('../../src/transport/forge_bot');
const { Rcon } = require('../../src/rl/rcon');
(async () => {
    const bot = createForgeBot({ host: process.env.MC_HOST, port: 25565, username: 'AdvProbe' });
    attachForgeHandshake(bot, { registry: 'auto' });
    let n = 0;
    bot._client.on('advancements', (p) => { require('fs').writeFileSync(`/exchange/adv-${n++}.bin`, Buffer.isBuffer(p) ? p : (p.restBuffer || Buffer.from(JSON.stringify(Object.keys(p)))));
        const pm = (p.progressMapping || []).filter((x) => /mine_stone|story\/root/.test(x.key));
        console.log('reset', p.reset, 'mapping', (p.advancementMapping || []).length, 'progress', (p.progressMapping || []).length, JSON.stringify(pm, (k, v) => (typeof v === 'bigint' ? `big:${v}` : v)).slice(0, 600));
        const m = (p.advancementMapping || []).find((x) => x.key === 'minecraft:story/mine_stone');
        if (m) console.log('requirements', JSON.stringify(m.value.requirements));
    });
    await new Promise((r) => bot.once('spawn', r));
    const rc = new Rcon({ host: process.env.RCON_HOST, port: 25575, password: process.env.RCON_PASSWORD }); await rc.connect();
    await new Promise((r) => setTimeout(r, 2000));
    console.log(await rc.command('advancement grant AdvProbe only minecraft:story/mine_stone'));
    await new Promise((r) => setTimeout(r, 2000));
    console.log(await rc.command('advancement revoke AdvProbe everything'));
    await new Promise((r) => setTimeout(r, 1500));
    rc.close(); bot.end(); setTimeout(() => process.exit(0), 300);
})();

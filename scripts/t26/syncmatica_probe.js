'use strict';
// Probe of the Syncmatica client (src/transport/syncmatica.js) against a server that runs the mod. Test code.
//   scripts/t26/f26.sh survival-op syncmatica_probe.js [SHARE=/path/file.litematic] [AT=x,y,z] [DUMP=1]
// Logs in, performs the handshake, prints the placements, downloads each file and parses it; with SHARE it first uploads that file as a placement.
const fs = require('fs');
const { createBot, attachHandshake } = require('../../src/transport');
const sm = require('../../src/transport/syncmatica');
const lit = require('../../src/work/jobs/litematic');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    const bot = createBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: process.env.BOTNAME || 'SyncProbe', viewDistance: 2 });
    attachHandshake(bot, { registry: 'vanilla' });
    const c = bot.syncmatica;
    const raw = [];
    bot._client.on('custom_payload', (p) => { if (p.channel === sm.CHANNEL) raw.push(Buffer.from(p.data).toString('hex').slice(0, 400)); });
    c.on('log', (s) => console.log('[sync]', s));
    await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', (r) => rej(new Error('kicked: ' + JSON.stringify(r)))); });
    console.log('spawned as', bot.username, 'version', bot.version);
    await Promise.race([new Promise((r) => c.once('ready', r)), sleep(15000)]);
    console.log('ready', c.ready, 'serverVersion', c.serverVersion, 'placements', c.placements.size);
    if (process.env.DUMP) console.log(raw.join('\n'));
    if (process.env.SHARE) {
        const file = fs.readFileSync(process.env.SHARE), [x, y, z] = (process.env.AT || '0,100,0').split(',').map(Number);
        const bp = lit.parse(file);
        const p = await c.share({ file, name: bp.meta.name || 'probe', pos: { x, y, z }, owner: '00000000-0000-0000-0000-000000000001', ownerName: bot.username, dataVersion: bp.meta.dataVersion || 0 });
        console.log('shared', p.id, p.hash);
        await sleep(1500);
    }
    for (const p of c.placements.values()) {
        console.log('placement', JSON.stringify(p));
        try { const f = await c.fetch(p.id); const parsed = lit.parse(f); const bp = lit.toBlueprint(parsed); console.log('  downloaded', f.length, 'bytes; blueprint', bp.size.join('x'), 'blocks', bp.blocks.length); } catch (e) { console.log('  fetch failed:', e.message); }
    }
    bot.quit(); await sleep(300); process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(2); });

'use strict';
// Display observer (TASK-20261125-077): a client that only watches. It counts, second by second, the block_display entities the server sends (spawn, remove, metadata, teleport)
// and how many stand at once, while the console's overlay draws a bot's walk. Test code. Env: SECONDS (default 90), NAME (Obs<world>), AT "x y z" where the observer stands.
const fs = require('fs');
const T = require('../t26/lib');
const { createBot, attachHandshake } = require('../../src/transport');

(async () => {
    const { S } = await T.connectRcon();
    const name = process.env.NAME || `Obs${T.WORLD}`, secs = Number(process.env.SECONDS || 90);
    const b = createBot({ host: process.env.MC_HOST || 'mc', port: 25565, username: name, viewDistance: 6 });
    attachHandshake(b, { registry: 'vanilla' });
    await new Promise((res) => b.once('spawn', res));
    await S.cmd(`gamemode spectator ${name}`);
    if (process.env.AT) await S.cmd(`tp ${name} ${process.env.AT}`);
    const live = new Set(), tl = [], tot = { spawn: 0, remove: 0, metadata: 0, teleport: 0 };
    let sec = { spawn: 0, remove: 0, metadata: 0, teleport: 0 };
    b._client.on('packet', (d, meta) => {
        if (meta.name === 'spawn_entity') { const t = b.registry.entities[d.type]; if (t && t.name === 'block_display') { live.add(d.entityId); sec.spawn++; tot.spawn++; } }
        else if (meta.name === 'entity_destroy') { for (const id of d.entityIds || []) if (live.delete(id)) { sec.remove++; tot.remove++; } }
        else if (meta.name === 'entity_metadata' && live.has(d.entityId)) { sec.metadata++; tot.metadata++; }
        else if (meta.name === 'entity_teleport' && live.has(d.entityId)) { sec.teleport++; tot.teleport++; }
    });
    console.log('ready');
    for (let i = 0; i < secs; i++) { await T.sleep(1000); tl.push({ t: i + 1, standing: live.size, ...sec }); sec = { spawn: 0, remove: 0, metadata: 0, teleport: 0 }; }
    const out = { world: T.WORLD, profile: T.PROFILE, totals: tot, timeline: tl };
    fs.writeFileSync(`/out/display-watch-${T.RUN}.json`, JSON.stringify(out));
    console.log(JSON.stringify({ totals: tot, timeline: tl.map((x) => `${x.t}:${x.standing}${x.spawn ? `+${x.spawn}` : ''}${x.remove ? `-${x.remove}` : ''}${x.metadata ? `~${x.metadata}` : ''}${x.teleport ? `>${x.teleport}` : ''}`).join(' ') }));
    b.quit(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

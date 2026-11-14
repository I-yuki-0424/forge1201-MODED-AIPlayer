'use strict';
// Debug tool: count the blocks of a box as a spectator bot sees them. BOX=x0,y0,z0,x1,y1,z1 [NAMES=oak_planks,cobblestone] [AT=x,y,z] -> counts per name and the cells of NAMES.
const T = require('./lib');
const Vec3 = require('vec3');
(async () => {
    const [x0, y0, z0, x1, y1, z1] = process.env.BOX.split(',').map(Number), names = (process.env.NAMES || '').split(',').filter(Boolean);
    const { S, svc } = await T.open(['Scan' + T.WORLD]); const bot = svc.bots.get('Scan' + T.WORLD).bot;
    await S.must(`gamemode spectator Scan${T.WORLD}`); await S.must(`tp Scan${T.WORLD} ${(x0 + x1) / 2} ${y1 + 5} ${(z0 + z1) / 2}`); await T.sleep(5000);
    const count = {}, cells = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const b = bot.blockAt(new Vec3(x, y, z)); const n = b ? b.name : 'unloaded'; count[n] = (count[n] || 0) + 1; if (names.includes(n)) cells.push([x, y, z, n]); }
    console.log(JSON.stringify(count)); console.log(JSON.stringify(cells.slice(0, 200)));
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

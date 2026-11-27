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
    // HANG=1: the blocks of the box that hang (air or a fluid right under them, not at the box bottom): what a pit's end leaves over its dug layers (TASK-075, lake fills)
    if (process.env.HANG === '1') { const hang = {}; let n = 0; const at = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b ? b.name : 'unloaded'; }; for (let x = x0; x <= x1; x++) for (let y = y0 + 1; y <= y1; y++) for (let z = z0; z <= z1; z++) { const a = at(x, y, z); if (/^(air|cave_air|water|lava|unloaded)$/.test(a)) continue; const u = at(x, y - 1, z); if (/^(air|cave_air|water|lava)$/.test(u)) { const k = `${a} over ${/air/.test(u) ? 'air' : u}`; hang[k] = (hang[k] || 0) + 1; n++; } } console.log(`[hang] ${n} hanging blocks: ${JSON.stringify(hang)}`); }
    if (process.env.GRID) for (let y = y1; y >= y0; y--) { const rows = []; for (let z = z0; z <= z1; z++) { let r = ""; for (let x = x0; x <= x1; x++) { const b = bot.blockAt(new Vec3(x, y, z)); r += b ? (b.name === "air" ? "." : b.name[0]) : "?"; } rows.push(r); } console.log(`y ${y}: ${rows.join(" | ")}`); }
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

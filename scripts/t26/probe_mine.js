'use strict';
// Debug: one bot with the BEST kit (efficiency 255, unbreakable) mines the block beside it through the instruction layer; prints the full result (an internal error's stack).
const T = require('./lib');
(async () => {
    const n = 'Probe' + T.WORLD, { S, svc } = await T.open([n]); const bot = svc.bots.get(n).bot;
    const p = await T.posOf(S, n); await T.onSurface(S, n, Math.floor(p.x) + 200, Math.floor(p.z)); await T.kit(S, n, { best: process.env.BEST !== '0' }); await T.sleep(2000);
    const f = bot.entity.position.floored();
    const { execute } = require('../../src/skills');
    console.log('held', bot.heldItem && bot.heldItem.name, JSON.stringify(bot.inventory.items().slice(0, 2).map((i) => ({ n: i.name, c: i.components && i.components.length, e: i.enchants }))));
    const Vec3 = require('vec3'); let c = null; for (let dx = -3; dx <= 3 && !c; dx++) for (let dz = -3; dz <= 3 && !c; dz++) for (let dy = -1; dy <= 1 && !c; dy++) { const b = bot.blockAt(f.offset(dx, dy, dz)); if (b && b.boundingBox === 'block' && (dx || dz)) c = f.offset(dx, dy, dz); }
    console.log('target', c, bot.blockAt(c).name);
    const r = await execute(bot, 'mine', { x: c.x, y: c.y, z: c.z, collect: false });
    console.log(JSON.stringify({ ok: r.ok, reason: r.reason, detail: r.detail }).slice(0, 2000));
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

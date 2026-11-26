'use strict';
// Probe (TASK-20261125-081, owner ruling of 2026-11-26, OWNER-LIST-5 addendum 4): does the server take a use packet on the BOTTOM face of the block under the bot's feet (a
// Tweakeroo-class placement under the floor), and does the builder's `sink` move bring a bot down a height on its own blocks with nothing left behind? A survival bot on a stone
// block H above the ground (set up by the operator's commands: the probe's scaffolding), pumpkins in its pack; the builder's planner plans its way to the ground, the mover walks
// it; the server is asked what stands in the column afterwards. Prints PASS/FAIL. H (default 12).
const T = require('./lib');
const { Vec3 } = require('vec3');
(async () => {
    const n = 'Sink' + T.WORLD, { S, svc } = await T.open([n]); const bot = svc.bots.get(n).bot;
    const H = Number(process.env.H || 12);
    await S.must(`gamemode survival ${n}`);
    const p = bot.entity.position.floored(), x = p.x + 3, z = p.z + 3;
    let gy = p.y + 40; while (gy > -60) { const b = bot.blockAt(new Vec3(x, gy, z)); if (b && b.boundingBox === 'block') break; gy--; }
    const top = gy + H;
    await S.must(`fill ${x - 1} ${top} ${z - 1} ${x + 1} ${top} ${z + 1} minecraft:stone`);
    await S.must(`fill ${x - 3} ${gy + 1} ${z - 3} ${x + 3} ${top - 1} ${z + 3} minecraft:air replace minecraft:air`);
    await S.must(`clear ${n}`); await S.must(`give ${n} minecraft:pumpkin 64`); await S.must(`give ${n} minecraft:diamond_axe 1`);
    await S.must(`tp ${n} ${x + 0.5} ${top + 1} ${z + 0.5}`); await T.sleep(3000);
    const { Mover } = require('../../src/build/move');
    const placed = new Set();
    const rules = { canDig: (cx, cy, cz, b) => b.name === 'pumpkin', temp: () => 'pumpkin', onTemp: (c) => placed.add(`${c.x},${c.y},${c.z}`) };
    const mv = new Mover(bot, rules, { log: (m) => console.log('[mover]', m) });
    const goal = { x: x + 3, y: gy + 1, z };
    const t0 = Date.now();
    const r = await mv.goto(goal, { goal: (gx, gyy, gz) => gyy === gy + 1 && Math.hypot(gx - x, gz - z) >= 2, maxNodes: 20000 });
    const f = bot.entity.position;
    console.log(`goto: ${JSON.stringify(r)} in ${Date.now() - t0} ms; bot at ${f.x.toFixed(2)},${f.y.toFixed(2)},${f.z.toFixed(2)}; trace ${mv.trace.slice(-6).join(' | ')}`);
    // the server's view: pumpkins left in the column and around it
    let left = 0; for (let y = gy + 1; y <= top + 1; y++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { const res = await S.cmd(`execute if block ${x + dx} ${y} ${z + dz} minecraft:pumpkin`); if (/passed/i.test(String(res))) left++; }
    const down = Math.floor(f.y) <= gy + 1;
    console.log(`[sink_probe] H ${H}: ${down && r.ok ? 'PASS' : 'FAIL'} down ${down}, pumpkins placed ${placed.size}, pumpkins left ${left}`);
    await svc.stop(); process.exit(down && r.ok && left === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

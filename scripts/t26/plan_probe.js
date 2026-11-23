'use strict';
// T26 probe (test code): why does the builder's planner find no way from cell FROM to cell TO on a live world? A spectator bot flies there, waits for the chunks, runs the
// builder's own plan (src/build/move.js) with TEMPS temporary blocks and the builder's dig rule (natural terrain only; BOX=x0,y0,z0,x1,y1,z1 keeps the built box), prints the
// result, the closest cell the search reached and the blocks around it. Nothing in the world is changed.
//   scripts/t26/run.sh N plan_probe.js FROM=x,y,z TO=x,y,z [DIM=nether] [TEMPS=320] [NODES=30000] [BOX=...]
const T = require('./lib');
const M = require('../../src/build/move');
const { Vec3 } = require('vec3');
const P = (s) => { const [x, y, z] = String(s).split(',').map(Number); return { x, y, z }; };
const NAME = `Pr${T.WORLD}`, NETHER = process.env.DIM === 'nether';
const TERRAIN = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|stone|deepslate|cobblestone|andesite|diorite|granite|tuff|calcite|gravel|sand|red_sand|sandstone|terracotta|[a-z_]+_terracotta|netherrack|basalt|blackstone|soul_sand|soul_soil|crimson_nylium|warped_nylium|snow_block|moss_block|[a-z_]*_ore|short_grass|tall_grass|fern|vine|bamboo|[a-z_]*_leaves|[a-z_]*_log|dripstone_block|pointed_dripstone)$/;
(async () => {
    const from = P(process.env.FROM), to = P(process.env.TO), temps = Number(process.env.TEMPS || 320), nodes = Number(process.env.NODES || 30000);
    const box = process.env.BOX ? process.env.BOX.split(',').map(Number) : null, inBox = (x, y, z) => box && x >= box[0] && y >= box[1] && z >= box[2] && x <= box[3] && y <= box[4] && z <= box[5];
    const { S, svc } = await T.open([NAME], { teleport: 'off', autoKit: false });
    const bot = svc.bots.get(NAME).bot;
    await S.must(`gamemode spectator ${NAME}`);
    await S.must(`${NETHER ? 'execute in minecraft:the_nether run ' : ''}tp ${NAME} ${from.x + 0.5} ${from.y + 3} ${from.z + 0.5}`);
    await T.sleep(9000);
    const rules = { canDig: (x, y, z, b) => !inBox(x, y, z) && TERRAIN.test(b.name), temp: () => 'dirt' };
    const v = new M.View(bot, rules), out = {}, t0 = Date.now();
    const r = await M.plan(v, from, (x, y, z) => x === to.x && y === to.y && z === to.z, to, { temps, maxNodes: nodes, budgetMs: 20000, out });
    const nm = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z), false); return b ? b.name.replace('minecraft:', '') : '?'; };
    console.log(`[probe] ${from.x},${from.y},${from.z} -> ${to.x},${to.y},${to.z}: ${r ? `PLAN ${r.length} steps ${r.map((q) => q.move[0]).join('')}` : `NO PLAN (${out.why}, ${out.nodes} cells)`} in ${Date.now() - t0} ms`);
    const c = out.closest || (r && r[r.length - 1]);
    if (c) {
        console.log(`[probe] closest ${c.x},${c.y},${c.z} (temps used ${c.t}, cost ${c.g})`);
        for (const [lbl, q] of [['closest', c], ['goal', to]]) for (let dy = 2; dy >= -2; dy--) console.log(`[probe] ${lbl} y${dy >= 0 ? '+' : ''}${dy}: ${[-1, 0, 1].map((dz) => [-1, 0, 1].map((dx) => nm(q.x + dx, q.y + dy, q.z + dz).slice(0, 12).padEnd(12)).join(' ')).join(' | ')}`);
        const col = []; for (let y = to.y - 1; y >= to.y - 40; y--) { const n = nm(to.x, y, to.z); col.push(n); if (n !== 'air' && n !== 'cave_air') break; }
        console.log(`[probe] the goal's column down: ${col.length} cells, ends on ${col[col.length - 1]}`);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

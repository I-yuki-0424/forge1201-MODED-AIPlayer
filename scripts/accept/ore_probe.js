'use strict';
// Debugging probe (test code): what gather's `find` sees for TARGET around a fresh bot (position, exposed, distance) and what the planner can reach.   ACC=4 scripts/accept/run.sh ore_probe.js TARGET=raw_iron
const L = require('../real/lib');
const G = require('../../src/work/jobs/gather');
const A = 'OreA', TARGET = process.env.TARGET || 'raw_iron';
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const bot = svc.bots.get(A).bot; S.name = A;
    await L.sleep(8000);
    const p = bot.entity.position; console.log(`[ore] bot ${[p.x, p.y, p.z].map(Math.round)}`);
    const spec = G.resolve(bot.registry, TARGET), all = G.find(bot, spec, 64);
    console.log(`[ore] ${all.length} ${TARGET} within 64: exposed ${all.filter((c) => c.exposed).length}`);
    for (const c of all.slice().sort((a, b) => a.dist - b.dist).slice(0, 12)) console.log(`[ore]  ${c.x},${c.y},${c.z} dist ${Math.round(c.dist)} exposed ${c.exposed}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

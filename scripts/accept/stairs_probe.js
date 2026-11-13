'use strict';
// Debugging probe (test code): a fresh bot digs a staircase with the console's own `tunnel` command, one step at a time, and prints every answer in full.   ACC=4 scripts/accept/run.sh stairs_probe.js N=8
const L = require('../real/lib');
const A = process.env.BOTNAME || 'StairA', N = Number(process.env.N || 8), DIRS = ['north', 'east', 'south', 'west'];
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const rec = svc.bots.get(A), bot = rec.bot; S.name = A;
    await L.sleep(Number(process.env.WAIT || 15000));
    const ENCH = '{Enchantments:[{id:"minecraft:efficiency",lvl:255},{id:"minecraft:unbreaking",lvl:255}]}';
    for (const k of ['pickaxe', 'axe', 'shovel', 'sword']) await S.must(`give ${A} minecraft:netherite_${k}${ENCH} 1`);
    let dir = 0;
    for (let i = 0; i < N; i++) {
        const p = await L.posOf(S, A);
        const r = await svc.runCommand({ bots: [A], command: 'tunnel', args: { dir: DIRS[dir], dy: -1 } });
        while (rec.cmd && rec.cmd.status === 'running') await L.sleep(300);
        const res = rec.cmd && rec.cmd.result || {};
        console.log(`[stairs] ${i} at ${[p.x, p.y, p.z].map(Math.round)} held ${bot.heldItem && bot.heldItem.name} ${DIRS[dir]}: ${res.ok ? 'ok' : res.reason} ${JSON.stringify(res.detail).slice(0, Number(process.env.DETAIL || 700))}`);
        if (!res.ok) dir = (dir + 1) % 4;
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

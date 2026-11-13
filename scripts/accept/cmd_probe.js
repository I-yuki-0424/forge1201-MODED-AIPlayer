'use strict';
// Debugging probe (test code): run ONE console command by a fresh bot from the spawn and print its result, the bot's position every 15 s and the work log (console.log of the work layer).
//   ACC=4 scripts/accept/run.sh cmd_probe.js CMD=gather ARGS='{"target":"raw_iron","count":3}' BOTNAME=ProbeC LIMIT=600 TRAVEL_TRACE=1
const L = require('../real/lib');
const A = process.env.BOTNAME || 'ProbeC', CMD = process.env.CMD, ARGS = JSON.parse(process.env.ARGS || '{}'), LIMIT = Number(process.env.LIMIT || 600);
(async () => {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' }); const rec = svc.bots.get(A), bot = rec.bot; S.name = A;
    await L.sleep(Number(process.env.WAIT || 12000));
    const ENCH = '{Enchantments:[{id:"minecraft:efficiency",lvl:255},{id:"minecraft:unbreaking",lvl:255}]}';
    for (const k of ['pickaxe', 'axe', 'shovel', 'sword']) await S.must(`give ${A} minecraft:netherite_${k}${ENCH} 1`);
    if (process.env.TP) { const [x, y, z] = process.env.TP.split(',').map(Number); await S.must(`gamemode survival ${A}`); await L.tpIn(S, A, 'overworld', x + 0.5, y, z + 0.5); await L.sleep(6000); }
    const p0 = await L.posOf(S, A); console.log(`[cmd] start ${[p0.x, p0.y, p0.z].map(Math.round)} ${CMD} ${JSON.stringify(ARGS)}`);
    const t0 = Date.now(); const r = await svc.runCommand({ bots: [A], command: CMD, args: ARGS });
    if (!r.started || !r.started.length) { console.log('[cmd] refused', JSON.stringify(r)); process.exit(1); }
    const beat = setInterval(async () => { const p = await L.posOf(S, A); console.log(`[cmd] ${Math.round((Date.now() - t0) / 1000)} s at ${p && [p.x, p.y, p.z].map(Math.round)} ${rec.cmd && rec.cmd.status} raw_iron ${await S.count('raw_iron')}`); }, 15000);
    while (Date.now() - t0 < LIMIT * 1000 && rec.cmd && rec.cmd.status === 'running') await L.sleep(1000);
    if (rec.cmd.status === 'running') rec.cmd.cancel.cancelled = true;
    clearInterval(beat); await L.sleep(1500);
    console.log(`[cmd] result ${JSON.stringify(rec.cmd && rec.cmd.result).slice(0, 4000)}`);
    console.log(`[cmd] held now ${bot.heldItem && bot.heldItem.name} slot ${bot.quickBarSlot} inventory ${bot.inventory.items().map((i) => i.name + '@' + i.slot).join(' ')}`);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

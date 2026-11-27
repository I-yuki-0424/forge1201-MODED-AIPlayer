'use strict';
// Probe (TASK-20261125-075, wet sites): does the pit's water rescue (src/work/bot/water.js) bring a bot out of DEEP water? Live mbc075h w1 (seed 4331971738747880703, 1.21.1): the pit opened
// into an aquifer 30+ deep under y 62, the bot sank after every breath reflex and drowned twice ('water rescue: to the shore, 0 filled (stuck)' each time). Here the operator's commands build a
// stone-walled pool D deep (default 20) beside the spawn with dry ground round its rim, put the bot at its bottom and call the rescue as the worker does; the server is asked where the bot
// stands and how much air it has. ROOF=1 closes the pool with a stone lid (a closed pocket); LEDGE=1 ends the water one below the rim; STEP=1 also covers it with a floor of cobblestone but for one hole over the bot. CONTROL=noop calls nothing (the bot must still be in the water: the probe can fail). Prints PASS/FAIL. A smoke probe, not evidence.
const T = require('./lib');
(async () => {
    const n = 'Wet' + T.WORLD, { S, svc } = await T.open([n]); const bot = svc.bots.get(n).bot;
    const D = Number(process.env.D || 20);
    await S.must(`gamemode survival ${n}`); await S.must(`clear ${n}`); await S.must(`give ${n} minecraft:cobblestone 64`); await S.must(`give ${n} minecraft:diamond_pickaxe 1`);
    const p = bot.entity.position.floored(), x = p.x + 8, z = p.z + 8, gy = p.y - 1;
    await S.must(`fill ${x - 6} ${gy + 1} ${z - 6} ${x + 6} ${gy + 6} ${z + 6} minecraft:air`);
    await S.must(`fill ${x - 6} ${gy - D} ${z - 6} ${x + 6} ${gy} ${z + 6} minecraft:stone`);
    await S.must(`fill ${x - 2} ${gy - D + 1} ${z - 2} ${x + 2} ${gy} ${z + 2} minecraft:water`);
    // ROOF=1: a closed pocket (mbc075e w2): the pool's top layer is stone, no shore anywhere; the bot has to dig its way up
    if (process.env.ROOF === '1') await S.must(`fill ${x - 2} ${gy} ${z - 2} ${x + 2} ${gy} ${z + 2} minecraft:stone`);
    // LEDGE=1: the water ends one below the rim (mbc075j w2): the dry ground is two up from the water's top cell, too high to climb out of the water
    if (process.env.LEDGE === '1') await S.must(`fill ${x - 2} ${gy} ${z - 2} ${x + 2} ${gy} ${z + 2} minecraft:air`);
    // STEP=1: a hole in a floor of fills over an aquifer (mbc075r w2): the water ends one below the rim, a stone floor covers it but for one cell, the bot is in the hole
    if (process.env.STEP === '1') { await S.must(`fill ${x - 2} ${gy - 1} ${z - 2} ${x + 2} ${gy - 1} ${z + 2} minecraft:water`); await S.must(`fill ${x - 2} ${gy} ${z - 2} ${x + 2} ${gy} ${z + 2} minecraft:cobblestone`); await S.must(`setblock ${x} ${gy} ${z} minecraft:air`); }
    await S.must(`tp ${n} ${x + 0.5} ${gy - D + 2} ${z + 0.5}`); await T.sleep(2500);
    const box = { x0: x - 8, x1: x + 8, z0: z - 8, z1: z + 8, top: gy + 2, bottom: gy - D };
    const t0 = Date.now();
    let r = null;
    if (process.env.CONTROL !== 'noop') {
        const env = require('../../src/work/bot/env').botEnv(bot, { worker: true });
        r = await require('../../src/work/bot/water').rescue(env, box, { why: 'probe' });
    } else await T.sleep(15000);
    await T.sleep(1500);
    const pos = String(await S.cmd(`data get entity ${n} Pos`)), air = String(await S.cmd(`data get entity ${n} Air`));
    const m = pos.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/), y = m ? Number(m[2]) : NaN;
    const wtop = process.env.LEDGE === '1' || process.env.STEP === '1' ? gy - 1 : gy, dry = Number.isFinite(y) && y >= wtop + 1 - 0.01 && !bot.entity.isInWater;
    console.log(`rescue: ${JSON.stringify(r)} in ${Date.now() - t0} ms; server pos ${pos.trim()} air ${air.trim()}; pool top y ${gy}, bottom ${gy - D + 1}`);
    console.log(`${dry ? 'PASS' : 'FAIL'} water_probe D=${D}${process.env.ROOF === '1' ? ' ROOF=1' : ''}${process.env.LEDGE === '1' ? ' LEDGE=1' : ''}${process.env.STEP === '1' ? ' STEP=1' : ''}${process.env.CONTROL ? ` CONTROL=${process.env.CONTROL}` : ''}`);
    await svc.stop(); process.exit(dry === (process.env.CONTROL !== 'noop') ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

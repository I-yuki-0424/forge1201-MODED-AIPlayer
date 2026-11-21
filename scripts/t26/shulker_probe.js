'use strict';
// Probe (test code): what does a bot see of a shulker box that lies INSIDE a chest (the owner's material chest on the creative server holds its materials in shulker boxes)?
// Prints the window items with their components, then runs `take_many` for an item that is only inside a shulker box. Run: scripts/t26/run.sh N shulker_probe.js
const T = require('./lib');
const name = `Sh${T.WORLD}`, sleep = T.sleep;
(async () => {
    const { S, svc } = await T.open([name]);
    const X = 10, Y = 200, Z = 10;
    await S.must(`forceload add ${X - 8} ${Z - 8} ${X + 8} ${Z + 8}`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y + 6} ${Z + 6} minecraft:air`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`);
    await S.must(`tp ${name} ${X + 3.5} ${Y} ${Z + 4.5}`); await T.kit(S, name); await sleep(3000);
    const box = (id, items) => `{Slot:${id}b,id:"minecraft:white_shulker_box",count:1,components:{"minecraft:container":[${items.map((it, i) => `{slot:${i},item:{id:"minecraft:${it[0]}",count:${it[1]}}}`).join(',')}]}}`;
    await S.must(`setblock ${X} ${Y} ${Z} minecraft:chest{Items:[${box(0, [['white_bed', 1], ['white_bed', 1], ['white_bed', 1]])},${box(1, [['oak_planks', 64], ['lever', 64]])},{Slot:5b,id:"minecraft:stone",count:30}]}`);
    console.log('server:', T.strip(await S.cmd(`data get block ${X} ${Y} ${Z}`)).slice(0, 300)); await sleep(2500);
    const rec = svc.bots.get(name), bot = rec.bot;
    const blk = bot.blockAt(new (require('vec3').Vec3)(X, Y, Z));
    console.log('block', blk && blk.name);
    const win = await bot.openContainer(blk); await sleep(800);
    for (const it of win.containerItems()) console.log('slot', it.slot, it.name, it.count, 'components=', JSON.stringify(it.components || null).slice(0, 600), 'nbt=', JSON.stringify(it.nbt || null).slice(0, 200));
    bot.closeWindow(win); await sleep(300);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

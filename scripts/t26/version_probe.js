'use strict';
// Version probe (TASK-20261125-074): what a new game version must give the bots before any test counts, checked on one test world and graded by the SERVER.
//   login (the protocol of the profile), inventory (a give arrives in the bot's slots, the server counts the same), dig with an enchanted tool (item components),
//   drops into the pack (owner Small 5: the server's count rises, no item entity is left; with a full pack the drop lies on the ground), place a pumpkin (owner Small 4),
//   a short walk (physics), chat. Not evidence of anything but the basics; prints PASS/FAIL per check and exits 1 on any FAIL.
//   scripts/t26/run.sh N version_probe.js
const T = require('./lib');
const { Vec3 } = require('vec3');
const { execute } = require('../../src/skills');

(async () => {
    const name = `Vp${T.WORLD}`;
    const { S, svc, seed } = await T.open([name], {}, 'peaceful');
    const bot = svc.bots.get(name).bot;
    const res = [];
    const check = (what, ok, detail) => { res.push({ what, ok: !!ok }); console.log(`[probe] ${ok ? 'PASS' : 'FAIL'} ${what} ${JSON.stringify(detail).slice(0, 300)}`); };
    console.log(`[probe] profile ${T.PROFILE} bot speaks ${bot.version} (protocol ${bot.protocolVersion}), seed ${seed}`);
    check('login', !!bot.entity && !!bot.version, { version: bot.version, pos: bot.entity.position });
    await S.must(`gamemode survival ${name}`);
    const sp = bot.entity.position.floored();
    // a flat stone pad 20 above the bot, cleared above: the same place on every seed
    const y = sp.y + 20, x0 = sp.x, z0 = sp.z;
    await S.must(`fill ${x0 - 4} ${y - 2} ${z0 - 4} ${x0 + 4} ${y - 1} ${z0 + 4} minecraft:stone`);         // two thick: a drop must not fall through the dug hole (it did, and was looked for 20 blocks too high)
    await S.must(`fill ${x0 - 4} ${y} ${z0 - 4} ${x0 + 4} ${y + 4} ${z0 + 4} minecraft:air`);
    await S.must(`tp ${name} ${x0 + 0.5} ${y} ${z0 + 0.5}`);
    await T.sleep(2500);
    await T.kit(S, name, { blocks: 16 });
    await S.must(`give ${name} minecraft:diamond_pickaxe[enchantments={levels:{efficiency:5}}] 1`);
    await T.sleep(1500);
    // inventory: what the bot sees equals what the server counts
    const inv = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
    const srvTemp = await T.holds(S, name, T.TEMP_BLOCK);
    check('inventory', inv(T.TEMP_BLOCK) === 16 && srvTemp === 16, { bot: inv(T.TEMP_BLOCK), server: srvTemp, block: T.TEMP_BLOCK });
    const pick = bot.inventory.items().find((i) => i.name === 'diamond_pickaxe' && i.enchants && JSON.stringify(i.enchants).includes('5'));
    check('item components (enchanted pickaxe read)', !!pick, { enchants: pick && pick.enchants });
    // dig a stone of the pad with the enchanted pickaxe: the cobblestone must arrive in the pack with no item entity left (auto-pickup)
    if (pick) await bot.equip(pick, 'hand');
    const target = new Vec3(x0 + 2, y - 1, z0);
    const before = await T.holds(S, name, 'cobblestone');
    const dt = bot.digTime(bot.blockAt(target));
    const m = await execute(bot, 'mine', { x: target.x, y: target.y, z: target.z });
    await T.sleep(1500);
    const after = await T.holds(S, name, 'cobblestone');
    const loose = /^Test passed/.test(T.strip(await S.cmd(`execute positioned ${target.x} ${target.y} ${target.z} if entity @e[type=item,distance=..8]`)));
    check('dig', T.strip(await S.cmd(`execute if block ${target.x} ${target.y} ${target.z} minecraft:air`)).startsWith('Test passed'), { result: m && (m.ok ? 'ok' : m.reason), digTimeMs: dt });
    check('drops into the pack (Small 5)', after === before + 1 && !loose, { before, after, itemEntityLeft: loose });
    // place a pumpkin into the hole (a temporary block of the test worlds, Small 4): the server sees it
    const p = await execute(bot, 'place', { x: target.x, y: target.y, z: target.z, item: T.TEMP_BLOCK });
    const placed = T.strip(await S.cmd(`execute if block ${target.x} ${target.y} ${target.z} minecraft:${T.TEMP_BLOCK}`)).startsWith('Test passed');
    check('place temporary block (Small 4)', placed, { result: p && (p.ok ? 'ok' : p.reason), block: T.TEMP_BLOCK });
    // a full pack: the drop of the next dig must lie on the ground (overflow drops normally)
    for (let i = 0; i < 36; i++) await S.cmd(`item replace entity ${name} container.${i} with minecraft:dirt 64`);
    await S.cmd(`item replace entity ${name} weapon.mainhand with minecraft:diamond_pickaxe`);
    await S.cmd(`item replace entity ${name} weapon.offhand with minecraft:dirt 64`);
    await T.sleep(1000);
    const t2 = new Vec3(x0 - 2, y - 1, z0);
    const m2 = await execute(bot, 'mine', { x: t2.x, y: t2.y, z: t2.z });
    await T.sleep(1500);
    const dug2 = T.strip(await S.cmd(`execute if block ${t2.x} ${t2.y} ${t2.z} minecraft:air`)).startsWith('Test passed');
    const items2 = T.strip(await S.cmd(`execute positioned ${t2.x} ${t2.y} ${t2.z} run data get entity @e[type=item,distance=..8,limit=1] Item`));
    const cob2 = await T.holds(S, name, 'cobblestone');
    const loose2 = /^Test passed/.test(T.strip(await S.cmd(`execute positioned ${t2.x} ${t2.y} ${t2.z} if entity @e[type=item,distance=..8,nbt={Item:{id:"minecraft:cobblestone"}}]`)));
    check('full pack: the drop lies on the ground', dug2 && loose2, { mine: m2 && (m2.ok ? 'ok' : m2.reason), dug: dug2, itemEntity: loose2, nearestItem: items2.slice(0, 120), cobblestoneInPack: cob2 });
    await S.cmd(`clear ${name} minecraft:dirt`); await S.cmd(`kill @e[type=item,distance=..20,x=${x0},y=${y},z=${z0}]`);
    // a short walk on the pad: physics and the server agree on the end position
    const mv = await execute(bot, 'move_to', { x: x0 + 3, y, z: z0 + 3 });
    await T.sleep(800);
    const at = await T.posOf(S, name);
    check('walk', mv && mv.ok && at && Math.abs(at.x - (x0 + 3.5)) < 1.2 && Math.abs(at.z - (z0 + 3.5)) < 1.2, { result: mv && (mv.ok ? 'ok' : mv.reason), server: at });
    // chat: a line the bot says reaches the server's chat (no signing on an offline server)
    let heard = false; bot.once('chat', (u, msg) => { if (msg === 'probe-chat') heard = true; });
    bot.chat('probe-chat'); await T.sleep(1500);
    check('chat', heard, {});
    const bad = res.filter((r) => !r.ok).length;
    console.log(`[probe] ${res.length - bad}/${res.length} checks passed on ${T.PROFILE} (${bot.version})`);
    await svc.stop(); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

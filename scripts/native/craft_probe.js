'use strict';
// Debug probe (TASK-20261125-076): one 2x2 craft with the native window clicks, every click sent and every window packet received printed in order.
//   scripts/t26/run.sh 7 ../native/craft_probe.js NATIVE_INVENTORY=1
const T = require('../t26/lib');
const skills = require('../../src/skills');
const name = `Cp${T.WORLD}`;
(async () => {
    const { S, svc } = await T.open([name]);
    await S.cmd(`clear ${name}`); await S.must(`give ${name} minecraft:oak_log 4`); await T.sleep(2000);
    const bot = svc.bots.get(name).bot, t0 = Date.now(), log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}]`, ...a);
    const w = bot._client.write.bind(bot._client);
    bot._client.write = (n, p) => { if (/window|click/.test(n)) log('SEND', n, JSON.stringify({ slot: p.slot, b: p.mouseButton, m: p.mode, st: p.stateId, ch: (p.changedSlots || []).map((c) => [c.location, c.item && c.item.itemCount]), cur: p.cursorItem && p.cursorItem.itemCount })); return w(n, p); };
    for (const n of ['set_slot', 'window_items']) bot._client.on(n, (p) => log('RECV', n, JSON.stringify(n === 'set_slot' ? { w: p.windowId, s: p.slot, st: p.stateId, c: p.item && p.item.itemCount } : { w: p.windowId, st: p.stateId, n: p.items.length })));
    log('native', JSON.stringify(bot.__native));
    const r = await skills.execute(bot, 'craft', { item: 'oak_planks', count: 4 });
    log('RESULT', r.ok, r.reason, JSON.stringify(r.detail).slice(0, 300));
    log('inventory', bot.inventory.items().map((i) => `${i.name}x${i.count}@${i.slot}`).join(' '), 'cursor', bot.inventory.selectedItem && bot.inventory.selectedItem.count);
    log('server', T.strip(await S.cmd(`data get entity ${name} Inventory`)).slice(0, 300));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

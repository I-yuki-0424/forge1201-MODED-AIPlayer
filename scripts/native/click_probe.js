'use strict';
// CLICK PROBE (TASK-20261125-076): do the bot's window clicks conflict with the server (and its mods)? One survival bot runs a fixed list of container,
// crafting, furnace, equipment and drop operations through the console (the router where it routes), with stacks that carry components (an enchanted
// and damaged pickaxe, a named sword) as well as plain ones. After every operation the bot's own view of its 46 slots (mineflayer's `bot.inventory`, which
// the native client keeps when NATIVE_INVENTORY=1) is compared with the SERVER's (`data get entity <bot> Inventory`); every differing slot is a conflict.
// The native client's corrections (server answers that differed from the prediction) are counted too. Run once per setting on the same world:
//   scripts/t26/run.sh 7 ../native/click_probe.js RUN=x [NATIVE_INVENTORY=1 ...]
const T = require('../t26/lib');

const name = `Ck${T.WORLD}`, strip = T.strip;
// server Inventory slot -> window 0 slot (hotbar 0-8 -> 36-44, main 9-35, feet..head 100-103 -> 8..5, off hand -106 -> 45)
const winSlot = (s) => (s >= 0 && s <= 8 ? s + 36 : s >= 9 && s <= 35 ? s : s >= 100 && s <= 103 ? 108 - s : s === -106 ? 45 : -1);

/** The top-level compounds of an SNBT list (any nesting depth; quoted strings skipped). */
function compounds(o) {
    const out = []; let depth = 0, start = -1, q = null;
    for (let i = o.indexOf('['); i >= 0 && i < o.length; i++) {
        const ch = o[i];
        if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'") { q = ch; continue; }
        if (ch === '{') { if (depth++ === 0) start = i + 1; } else if (ch === '}') { if (--depth === 0) out.push(o.slice(start, i)); }
    }
    return out;
}
async function serverInv(S) {
    const o = strip(await S.cmd(`data get entity ${name} Inventory`));
    const out = new Map();
    for (const s of compounds(o)) {
        const top = s.replace(/\{[\s\S]*\}/, '');                     // the item's own keys, without its components
        const slot = /Slot: ?(-?\d+)b/.exec(top), id = /id: ?"(?:minecraft:)?([^"]+)"/.exec(top), c = /count: ?(\d+)/.exec(top);
        if (slot && id) out.set(winSlot(Number(slot[1])), `${id[1]}x${c ? c[1] : 1}`);
    }
    return out;
}
function botInv(bot) {
    const out = new Map();
    for (let i = 5; i < 46; i++) { const it = bot.inventory.slots[i]; if (it) out.set(i, `${it.name}x${it.count}`); }
    return out;
}
const diff = (a, b) => { const out = []; for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.push({ slot: k, bot: a.get(k) || null, server: b.get(k) || null }); return out; };

(async () => {
    const rep = T.reporter('click_probe');
    const { S, svc, seed } = await T.open([name]);
    const p0 = await T.posOf(S, name);
    await T.onSurface(S, name, Math.floor(p0.x) - 12, Math.floor(p0.z) + 6);
    const g = await T.posOf(S, name), O = { x: Math.floor(g.x), y: Math.floor(g.y), z: Math.floor(g.z) };
    await S.must(`fill ${O.x - 3} ${O.y} ${O.z - 3} ${O.x + 3} ${O.y + 3} ${O.z + 3} minecraft:air`);
    await S.must(`fill ${O.x - 3} ${O.y - 1} ${O.z - 3} ${O.x + 3} ${O.y - 1} ${O.z + 3} minecraft:stone`);
    const chest = { x: O.x + 2, y: O.y, z: O.z }, furnace = { x: O.x - 2, y: O.y, z: O.z }, table = { x: O.x, y: O.y, z: O.z + 2 }, hopper = { x: O.x, y: O.y, z: O.z - 2 };
    await S.must(`setblock ${chest.x} ${chest.y} ${chest.z} minecraft:chest[facing=west]`);
    await S.must(`setblock ${furnace.x} ${furnace.y} ${furnace.z} minecraft:furnace[facing=east]`);
    await S.must(`setblock ${table.x} ${table.y} ${table.z} minecraft:crafting_table`);
    await S.must(`setblock ${hopper.x} ${hopper.y} ${hopper.z} minecraft:hopper[facing=down,enabled=false]`);
    await S.must(`setblock ${hopper.x} ${hopper.y} ${hopper.z - 1} minecraft:redstone_block`);
    await S.cmd(`clear ${name}`);
    for (const it of ['minecraft:diamond_pickaxe[enchantments={levels:{"minecraft:efficiency":3}},damage=50] 1', 'minecraft:iron_sword[custom_name=\'"Probe"\'] 1', 'minecraft:oak_log 12', 'minecraft:raw_iron 3',
        'minecraft:coal 4', 'minecraft:cobblestone 40', 'minecraft:dirt 20', 'minecraft:iron_helmet 1', 'minecraft:cooked_beef 8']) await S.must(`give ${name} ${it}`);
    await S.must(`tp ${name} ${O.x + 0.5} ${O.y} ${O.z + 0.5}`);
    await T.sleep(3000);
    const ops = [
        ['deposit', { item: 'diamond_pickaxe', count: 1, ...chest }], ['withdraw', { item: 'diamond_pickaxe', count: 1, ...chest }],
        ['deposit', { item: 'iron_sword', count: 1, ...chest }], ['withdraw', { item: 'iron_sword', count: 1, ...chest }],
        ['deposit', { item: 'cobblestone', count: 25, ...chest }], ['withdraw', { item: 'cobblestone', count: 10, ...chest }],
        ['craft', { item: 'oak_planks', count: 16 }], ['craft', { item: 'stick', count: 4 }], ['craft', { item: 'chest', count: 1, ...table }],
        ['smelt', { item: 'raw_iron', count: 3, ...furnace }], ['equip', { item: 'iron_helmet', dest: 'head' }], ['equip', { item: 'diamond_pickaxe' }],
        ['toss', { item: 'dirt', count: 5 }], ['set_contents', { ...hopper, contents: [{ slot: 0, item: 'cobblestone', count: 18 }, { slot: 1, item: 'stick', count: 1 }], exact: true }],
    ];
    const rows = [];
    let conflicts = 0;
    for (const [cmd, args] of ops) {
        const r = await T.command(svc, name, cmd, args, 3);
        await T.sleep(1500);
        const rec = svc.bots.get(name), bot = rec && rec.bot;
        const d = bot ? diff(botInv(bot), await serverInv(S)) : [{ slot: -1, bot: 'offline' }];
        conflicts += d.length;
        const nw = bot && bot.__nativeWindows;
        rows.push({ cmd, ok: !!(r.result && r.result.ok), reason: r.result && r.result.reason, conflicts: d, corrections: nw ? nw.stats.corrections : null, clicks: nw ? nw.stats.clicks : null });
        console.log(`[click_probe] ${cmd} ${r.result && r.result.ok ? 'ok' : `${r.result && r.result.reason} ${JSON.stringify(r.result && r.result.detail).slice(0, 200)}`} conflicts ${d.length}${d.length ? ' ' + JSON.stringify(d).slice(0, 300) : ''}`);
    }
    const native = !!(svc.bots.get(name) && svc.bots.get(name).bot && svc.bots.get(name).bot.__native && svc.bots.get(name).bot.__native.done.inventory);
    rep.trial(name, conflicts === 0, { seed, native, conflicts, ops: rows.map((x) => ({ cmd: x.cmd, ok: x.ok, reason: x.reason, conflicts: x.conflicts.length, corrections: x.corrections, clicks: x.clicks })), detail: rows.filter((x) => x.conflicts.length).map((x) => ({ cmd: x.cmd, conflicts: x.conflicts })) });
    rep.write({ seed, native });
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

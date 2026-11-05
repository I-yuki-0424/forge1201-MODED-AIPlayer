'use strict';
// Inventories through the server console: read a player's (or bot's) inventory and a container's items with `data get`, move stacks with
// `item replace ... from ...` (which keeps the stack's NBT exactly) and clear the source slot. Every value that reaches a command is a
// validated token. Slot numbers are the game's own (player: 0-8 hotbar, 9-35 main, 100-103 armour feet..head, -106 off hand).
const snbt = require('./snbt');

const NAME = /^[A-Za-z0-9_]{1,16}$/;
const ID = /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/.-]{1,64}$/;
const ARMOUR = { 100: 'armor.feet', 101: 'armor.legs', 102: 'armor.chest', 103: 'armor.head' };
const SIZE = { chest: 27, trapped_chest: 27, barrel: 27, shulker_box: 27, ender_chest: 27, hopper: 5, dropper: 9, dispenser: 9, furnace: 3, blast_furnace: 3, smoker: 3, brewing_stand: 5 };
const CONTAINER = /(^|:|_)(chest|trapped_chest|barrel|shulker_box|hopper|dropper|dispenser|furnace|blast_furnace|smoker|brewing_stand)$/;

const int = (v, what) => { if (!Number.isInteger(v)) throw new Error(`${what} must be an integer`); return v; };

/** Normalise a target: { type: 'entity', name } or { type: 'block', x, y, z }. */
function target(t) {
    if (t && t.type === 'entity' && NAME.test(String(t.name))) return { type: 'entity', name: String(t.name) };
    if (t && t.type === 'block') return { type: 'block', x: int(t.x, 'x'), y: int(t.y, 'y'), z: int(t.z, 'z') };
    throw new Error('target must be {type:"entity",name} or {type:"block",x,y,z}');
}
const ref = (t) => (t.type === 'entity' ? `entity ${t.name}` : `block ${t.x} ${t.y} ${t.z}`);

/** Slot name for `item replace`: entity -> hotbar.N / inventory.N / armor.* / weapon.offhand; block -> container.N. */
function slotName(t, n) {
    int(n, 'slot');
    if (t.type === 'block') { if (n < 0 || n > 53) throw new Error('slot outside 0-53'); return `container.${n}`; }
    if (n >= 0 && n <= 8) return `hotbar.${n}`;
    if (n >= 9 && n <= 35) return `inventory.${n - 9}`;
    if (ARMOUR[n]) return ARMOUR[n];
    if (n === -106) return 'weapon.offhand';
    throw new Error(`no such player slot ${n}`);
}

const stack = (s) => ({ slot: Number(s.Slot), id: String(s.id), count: Number(s.Count ?? s.count ?? 1), tag: s.tag && Object.keys(s.tag).length ? s.tag : undefined });
function view(s) {                              // what the page shows of a stack
    const t = s.tag || {};
    let label = null; if (t.display && typeof t.display.Name === 'string') { try { label = JSON.parse(t.display.Name).text || null; } catch (_) { label = String(t.display.Name).slice(0, 60); } }
    return { slot: s.slot, id: s.id, count: s.count, label, damage: typeof t.Damage === 'number' ? t.Damage : null, enchanted: !!(t.Enchantments && t.Enchantments.length), nbt: s.tag ? JSON.stringify(s.tag).slice(0, 400) : null };
}

/** Read a target. Returns { kind, id?, size, slots: [{slot,id,count,...}] }. `run(cmd)` sends one console command and returns its text. */
async function read(run, t) {
    t = target(t);
    if (t.type === 'entity') {
        const items = snbt.fromReply(await run(`data get entity ${t.name} Inventory`));
        return { kind: 'player', size: 36, slots: (Array.isArray(items) ? items : []).map(stack).map(view) };
    }
    let id = 'container';
    try { id = String(snbt.fromReply(await run(`data get block ${t.x} ${t.y} ${t.z} id`))); } catch (e) { throw new Error(`no block entity at ${t.x} ${t.y} ${t.z}`); }
    if (!CONTAINER.test(id) && !/chest|barrel|crate|vault|box/.test(id)) { /* modded containers also answer: try Items below */ }
    let items = [];
    try { const v = snbt.fromReply(await run(`data get block ${t.x} ${t.y} ${t.z} Items`)); items = Array.isArray(v) ? v : []; } catch (e) { if (!/no data|Found no elements/i.test(e.message)) { /* empty container: the server says it has no Items */ } }
    const base = id.replace(/^minecraft:/, ''), highest = items.reduce((m, s) => Math.max(m, Number(s.Slot) + 1), 0);
    return { kind: 'container', id, size: Math.max(SIZE[base] || 27, highest), slots: items.map(stack).map(view) };
}

const MAX_STACK_ONE = /(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots|bow|crossbow|shield|elytra|bucket|potion|shulker_box|saddle|trident|fishing_rod|shears)$/;
const STACK_16 = /(ender_pearl|snowball|egg|sign|honey_bottle|banner)$/;
const maxStack = (id) => (MAX_STACK_ONE.test(id) ? 1 : STACK_16.test(id) ? 16 : 64);

/** Slots of a target a stack may be moved into, in order of preference. */
function freeSlots(t, state) {
    const used = new Set(state.slots.map((s) => s.slot));
    const order = t.type === 'entity' ? [...Array(9).keys(), ...Array.from({ length: 27 }, (_, i) => i + 9)] : [...Array(state.size).keys()];
    return order.filter((n) => !used.has(n));
}

/**
 * Move one stack: copy it to the destination slot (refused unless that slot is empty, read fresh), then clear the source slot.
 * `dstSlot` null = first free slot. Returns { moved: {id,count}, from, to }.
 */
async function move(run, src, srcSlot, dst, dstSlot = null) {
    src = target(src); dst = target(dst); int(srcSlot, 'source slot');
    const [s, d] = [await read(run, src), await read(run, dst)];
    const item = s.slots.find((x) => x.slot === srcSlot);
    if (!item) throw new Error('the source slot is empty');
    if (dstSlot === null || dstSlot === undefined) {
        const free = freeSlots(dst, d);
        if (!free.length) throw new Error('no free slot in the destination');
        dstSlot = free[0];
    } else if (d.slots.some((x) => x.slot === dstSlot)) throw new Error('the destination slot is occupied (drop on an empty slot, or use quick move)');
    const from = slotName(src, srcSlot), to = slotName(dst, dstSlot);
    const r = String(await run(`item replace ${ref(dst)} ${to} from ${ref(src)} ${from}`)).replace(/\x1b\[[0-9;]*m/g, '');
    if (!/^Replaced/i.test(r.trim())) throw new Error(r.trim().slice(0, 160) || 'the server refused the move');
    const c = String(await run(`item replace ${ref(src)} ${from} with minecraft:air`)).replace(/\x1b\[[0-9;]*m/g, '');
    if (!/^Replaced/i.test(c.trim())) throw new Error(`copied, but the source was not cleared: ${c.trim().slice(0, 120)}`);
    return { moved: { id: item.id, count: item.count }, from: srcSlot, to: dstSlot };
}

/** Move every stack of `src` that fits into `dst` (take all). Stops at the first failure and reports what was moved. */
async function moveAll(run, src, dst) {
    const s = await read(run, src), moved = [];
    for (const item of s.slots.filter((x) => x.slot >= 0 && x.slot < 36 || target(src).type === 'block')) {
        try { moved.push((await move(run, src, item.slot, dst)).moved); } catch (e) { return { moved, stopped: e.message }; }
    }
    return { moved, stopped: null };
}

/** Put an item stack into a slot with `give`-like semantics is NOT offered here: only moves keep the exact stack. */
module.exports = { read, move, moveAll, target, slotName, maxStack, CONTAINER, SIZE, NAME, ID };

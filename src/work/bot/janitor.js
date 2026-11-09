'use strict';
// Inventory upkeep for a working bot (docs/proposed/WORKERS-v1.md, part 1.2 and 1.3). Two pure functions decide, one runner
// carries it out with existing commands (toss, deposit, withdraw, place, mine):
//   plan(items, policy)    what to throw away or store so that enough slots are free, lowest value first
//   restock(items, policy) what is missing (tools, food, seal blocks) and should be taken from the depot
// "Value" is a number: 0 = worthless (dirt), 100 = never discard. Unknown items sit in the middle and are STORED if a depot
// exists, thrown away only as a last resort and only below `neverToss`.

const DEFAULT_VALUE = 50;
const VALUES = new Map(Object.entries({
    // 0: what every pit produces in bulk
    dirt: 0, grass_block: 0, coarse_dirt: 0, gravel: 0, sand: 2, red_sand: 2, cobblestone: 5, cobbled_deepslate: 5, stone: 5, deepslate: 5,
    andesite: 3, diorite: 3, granite: 3, tuff: 3, netherrack: 1, dripstone_block: 2, calcite: 2, smooth_basalt: 2, flint: 8,
    rotten_flesh: 1, spider_eye: 4, bone: 6, string: 10, gunpowder: 12, arrow: 4, poisonous_potato: 0,
    // mid: store when possible
    coal: 40, charcoal: 35, raw_copper: 45, copper_ingot: 50, raw_iron: 70, iron_ingot: 75, raw_gold: 70, gold_ingot: 75, redstone: 55,
    lapis_lazuli: 60, quartz: 50, clay_ball: 25, oak_log: 30, spruce_log: 30, birch_log: 30, oak_planks: 25, stick: 15,
    // high: never thrown away
    diamond: 100, emerald: 100, netherite_ingot: 100, netherite_scrap: 100, ancient_debris: 100, enchanted_golden_apple: 100,
    'create:raw_zinc': 60, 'create:zinc_ingot': 65, 'create:brass_ingot': 70, 'create:andesite_alloy': 55,
}));
const TOOL = /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots|^shield$|^bow$|^crossbow$|^trident$|^shears$|^elytra$|fishing_rod|bucket|^flint_and_steel$|wrench|goggles)/;
const FOOD = /^(bread|cooked_[a-z_]+|baked_potato|apple|golden_apple|carrot|golden_carrot|pumpkin_pie|beef|porkchop|mutton|chicken|cod|salmon|dried_kelp|melon_slice|sweet_berries|cookie|mushroom_stew)$/;
const CONTAINER = /(^|_)shulker_box$|^ender_chest$|^chest$|^barrel$|^enderstorage:ender_(chest|tank)$|^enderstorage:ender_pouch$/;
const STACK_ONE = /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots|bucket|^shield$|^bow$|^crossbow$|shulker_box$|^ender_chest$|^enderstorage:ender_(chest|tank)$|^enderstorage:ender_pouch$|^elytra$|^trident$|^shears$|^fishing_rod$|^flint_and_steel$|^saddle$|_boat$|^minecart$)/;

/** The tagged sites of the policy (src/work/sites.js; the object or a function returning it, so that edits to the registry apply to running jobs). */
const sitesOf = (policy) => { const s = typeof policy.sites === 'function' ? policy.sites() : policy.sites; return s && typeof s.placeFor === 'function' ? s : null; };
const hasSites = (policy) => { const s = sitesOf(policy); return !!s && s.list().length > 0; };

const valueOf = (name, policy = {}) => (policy.value && policy.value[name] !== undefined ? policy.value[name] : VALUES.has(name) ? VALUES.get(name) : DEFAULT_VALUE);
const stackOf = (name, policy = {}) => (policy.stack && policy.stack[name]) || (STACK_ONE.test(name) ? 1 : /^(ender_pearl|snowball|egg|sign|bucket|honey_bottle)/.test(name) ? 16 : 64);
const slotsOf = (name, count, policy) => Math.ceil(count / stackOf(name, policy));

/** Default policy for a pit crew; every field can be overridden per job. */
function pitPolicy(over = {}) {
    return {
        freeTarget: 6,                     // keep at least this many empty slots while working
        neverToss: 60,                     // items valued at or above this are never thrown away, only stored
        keep: {                            // item -> {min, max}: min is protected and restocked, the rest above max is surplus
            cobblestone: { min: 16, max: 64 }, dirt: { min: 0, max: 32 }, cobbled_deepslate: { min: 0, max: 64 },
        },
        storeMin: 0,                       // with a depot or sites: items worth less than this are thrown away instead of stored (never one valued >= neverToss)
        discardWorn: true,                 // a worn-out tool is used up: thrown away (a bool, or a function so that the setting applies to running jobs)
        food: 8,                           // food items wanted (any FOOD) when a depot exists
        depot: null,                       // {kind: 'chest'|'shulker', x, y, z, item?} or null (then everything below neverToss is thrown away)
        ...over,
    };
}

/**
 * Operations that bring the inventory to `freeTarget` free slots and trim surplus. `items`: [{name, count}] (main inventory +
 * hotbar, not armour/off hand); `slotsFree`: number of empty slots. Returns [{op: 'toss'|'deposit', item, count, why}].
 */
function plan(items, slotsFree, policy = pitPolicy(), worn = []) {
    const ops = [], keepOf = (n) => policy.keep[n] || null;
    // 0. Worn-out tools are used up: each such stack goes, whatever the room (exact stack: `damage`, so that a good tool of the same name stays).
    // A tier whose policy is `keep` (diamond, netherite: stopped before they break) is stashed in a chest instead, whatever the discard switch says.
    const discard = typeof policy.discardWorn === 'function' ? policy.discardWorn() : policy.discardWorn !== false;
    for (const wn of worn.slice(0, 12)) {
        if (wn.keep) ops.push({ op: 'stash', item: wn.name, count: 1, damage: wn.damage, why: 'keep_worn' });
        else if (discard) ops.push({ op: 'toss', item: wn.name, count: 1, damage: wn.damage, why: 'worn_out' });
    }
    const stacks = new Map();
    for (const it of items) stacks.set(it.name, (stacks.get(it.name) || 0) + it.count);
    // Tools, food, containers and the materials a tool is made from in the pit (replace-tool: sticks, planks, logs) are never made room of; ores and fuel are stored only when room is needed.
    const protectedItem = (n) => TOOL.test(n) || FOOD.test(n) || CONTAINER.test(n) || /^stick$|_planks$|_log$/.test(n);
    const out = (op, item, count, why) => { if (count > 0) { ops.push({ op, item, count, why }); } };
    const dispose = (item, count, why) => {
        const v = valueOf(item, policy);
        if (policy.depot || hasSites(policy)) {
            // The depot's rank: what is worth less than `storeMin` is thrown away, unless the operator tagged a chest for exactly that kind (junk, food, ...).
            const own = sitesOf(policy) && sitesOf(policy).classSite ? sitesOf(policy).classSite(item, policy) : null;
            if (policy.storeMin > 0 && v < policy.storeMin && v < policy.neverToss && !own) out('toss', item, count, why);
            else out('deposit', item, count, why);
        } else if (v < policy.neverToss) out('toss', item, count, why);
    };
    let free = slotsFree;
    // 1. Surplus over a keep.max, always (cheap, keeps the stacks from growing back).
    for (const [n, have] of stacks) {
        const k = keepOf(n);
        if (k && have > k.max) {
            const extra = have - k.max, before = slotsOf(n, have, policy), after = slotsOf(n, k.max, policy);
            const o = ops.length; dispose(n, extra, 'surplus');
            if (ops.length > o) { free += before - after; stacks.set(n, k.max); }
        }
    }
    if (free >= policy.freeTarget) return ops;
    // 2. Not enough room: lowest value first, whole stacks beyond the protected minimum.
    const cand = [...stacks.entries()].filter(([n]) => !protectedItem(n)).map(([n, have]) => ({ n, have, v: valueOf(n, policy), min: keepOf(n)?.min || 0 }))
        .filter((c) => c.have > c.min).sort((a, b) => a.v - b.v || b.have - a.have);
    for (const c of cand) {
        if (free >= policy.freeTarget) break;
        if (!policy.depot && !hasSites(policy) && c.v >= policy.neverToss) continue;
        const take = c.have - c.min, gain = slotsOf(c.n, c.have, policy) - slotsOf(c.n, c.min, policy);
        const o = ops.length; dispose(c.n, take, 'make_room');
        if (ops.length > o) free += gain;
    }
    return ops;
}

/** Items to take out of the depot: protected minimums that the inventory lacks and food, as [{item, count}]. */
function restock(items, policy = pitPolicy()) {
    if (!policy.depot) return [];
    const have = new Map(); for (const it of items) have.set(it.name, (have.get(it.name) || 0) + it.count);
    const want = [];
    for (const [n, k] of Object.entries(policy.keep)) if ((have.get(n) || 0) < k.min) want.push({ item: n, count: k.min - (have.get(n) || 0) });
    const food = items.filter((i) => FOOD.test(i.name)).reduce((s, i) => s + i.count, 0);
    if (policy.foodItem && food < policy.food) want.push({ item: policy.foodItem, count: policy.food - food });
    return want;
}

/** Items of the bot as the planner wants them, from a Mineflayer bot. */
function inventoryOf(bot) {
    const m = new Map();
    for (const i of bot.inventory.items()) m.set(i.name, (m.get(i.name) || 0) + i.count);
    const free = 36 - bot.inventory.items().length;
    // Worn-out tools, one entry per stack with the damage that picks exactly that stack (options.isWorn; empty while retireWorn is off).
    const worn = [];
    for (const i of bot.inventory.items()) {
        if (!i.maxDurability || !TOOL.test(i.name)) continue;
        let w = false; try { w = require('../../skills/options').isWorn(bot, i); } catch (_) { /* no options */ }
        if (w) {
            // A tier whose policy is 'keep' is stopped before it breaks and kept (stashed), the others that retire are used up and thrown away.
            const o = require('../../skills/options'), pol = o.get(bot).toolPolicy;
            worn.push({ name: i.name, damage: i.durabilityUsed || 0, left: i.maxDurability - (i.durabilityUsed || 0), keep: !!(pol && pol[o.tierOf(i.name)] === 'keep') });
        }
    }
    return { items: [...m].map(([name, count]) => ({ name, count })), slotsFree: free, worn };
}

/**
 * Carry out plan() with the action layer. A `chest` depot is a fixed container; a `shulker` depot is carried: the bot places the
 * shulker box beside itself, fills it, and breaks it again (the box keeps its contents). Returns {ok, done:[...], reason?}.
 * `env`: exec(name, args), inv() -> {items, slotsFree}, here() -> feet cell {x,y,z}, w (world model).
 */
async function maintain(env, policy) {
    const { items, slotsFree, worn } = env.inv(), ops = plan(items, slotsFree, policy, worn || []), done = []; let skipped = null;
    if (!ops.length) return { ok: true, done };
    // A kept tool goes into the chest that takes things (never the tools chest: nobody wants a nearly broken pickaxe handed out); with no chest it stays in the pack.
    for (const o of ops.filter((x) => x.op === 'stash')) {
        const s = sitesOf(policy) ? sitesOf(policy).placeFor(o.item, env.pos ? env.pos() : null, policy) : null, box = s ? { x: s.x, y: s.y, z: s.z } : policy.depot && policy.depot.kind === 'chest' ? policy.depot : null;
        if (!box || !env.run) continue;
        const r = await env.run('stash_worn', { item: o.item, damage: o.damage, x: box.x, y: box.y, z: box.z });
        if (r.ok) done.push(o);
    }
    for (const o of ops.filter((x) => x.op === 'toss')) {
        if (o.damage !== undefined) {                                               // a worn-out tool: out of the game, that exact stack; never a plain toss (it would pick any stack of the name)
            if (env.discard) { const r = await env.discard(o.item, 1, { damage: o.damage }); if (r.ok) done.push(o); }
            continue;
        }
        const r = await require('./discard').dispose(env, o.item, o.count);        // out of the game, else a place where no job is active, else a plain toss
        if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail, done };
        done.push(o);
    }
    const dep = ops.filter((x) => x.op === 'deposit');
    if (dep.length) {
        // Each item goes to the site of its class (ore, junk, ...) when the operator has tagged sites, else to the job's depot.
        const sites = sitesOf(policy), groups = new Map(), from = env.pos ? env.pos() : null;
        for (const o of dep) {
            const site = sites ? sites.placeFor(o.item, from, policy) : null;
            const box = site ? { kind: 'chest', x: site.x, y: site.y, z: site.z } : policy.depot;
            if (!box) return { ok: false, reason: 'invalid_target', detail: { why: `no site or depot for ${o.item}` }, done };
            const k = box.kind === 'shulker' ? 'shulker' : `${box.x},${box.y},${box.z}`;
            if (!groups.has(k)) groups.set(k, { box, ops: [] });
            groups.get(k).ops.push(o);
        }
        const bad = env.badBoxes || (env.badBoxes = new Set());
        // A depot that is no container (the coordinates point at air, a chest that was taken away) must not stall the bot at every upkeep: what is worth
        // little is thrown away, the rest stays in the pack; the box is not tried again by this bot.
        const giveUp = async (g, why) => {
            for (const o of g.ops) if (valueOf(o.item, policy) < policy.neverToss) { const r = await require('./discard').dispose(env, o.item, o.count); if (r.ok) done.push({ ...o, op: 'toss', why: 'bad_depot' }); }
            return why;
        };
        for (const g of groups.values()) {
            const key = g.box.kind === 'shulker' ? 'shulker' : `${g.box.x},${g.box.y},${g.box.z}`;
            if (bad.has(key)) { await giveUp(g, 'bad'); continue; }
            let box = g.box, placed = null;
            if (box.kind === 'shulker') {
                const spot = shulkerSpot(env.w, env.here());
                if (!spot) return { ok: false, reason: 'invalid_target', detail: { why: 'no free cell beside the bot for the shulker box' }, done };
                const p = await env.exec('place', { ...spot, item: box.item || 'shulker_box' });
                if (!p.ok) return { ok: false, reason: p.reason, detail: p.detail, done };
                placed = spot; box = spot;
            }
            try {
                // A chest in another layer or out of a move_to's sight: bring the bot there first (the live pit's Ender chests stood on its floor and every deposit failed `unreachable`).
                if (box.kind !== 'shulker') { const a = await require('./reach').approach(env, box, { why: 'to deposit', strict: false }); if (a) return { ok: false, reason: a.reason, detail: a.detail, done }; }          // not reachable now: nothing is thrown away for that, the next upkeep tries again
                const run = async () => {
                    for (const o of g.ops) {
                        const r = await env.exec('deposit', { item: o.item, count: Math.min(o.count, 2304), x: box.x, y: box.y, z: box.z });
                        if (!r.ok && ['invalid_target', 'no_station'].includes(r.reason) && box.kind !== 'shulker') { bad.add(key); await giveUp(g, r.reason); return null; }
                        // What is wrong with ONE item (a name the action layer refuses, a stack that is gone) is no reason to leave the rest of the pack unstored: the next item is tried.
                        if (!r.ok && ['invalid_args', 'missing_item'].includes(r.reason)) { (skipped = skipped || []).push({ item: o.item, reason: r.reason, detail: r.detail }); continue; }
                        if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
                        done.push(o);
                    }
                    return null;
                };
                // One turn at the container for the whole group (env.visit), not one per item kind.
                const fail = box.kind !== 'shulker' && env.visit ? await env.visit(box, run) : await run();
                if (fail) return { ok: false, reason: fail.reason, detail: fail.detail, done };
            } finally {
                // Take the box (and what is in it) back at once (owner 2026-11-09: what the bot placed is picked up when the task is done). A failed break is
                // tried again after a small fix; a box that stays is listed in `left` so that the caller can say so instead of silently leaving it standing.
                if (placed) {
                    let r = await env.exec('mine', placed);
                    for (let i = 0; !r.ok && i < 3; i++) { if (env.recover) await env.recover(2 + i, r); r = await env.exec('mine', placed); }
                    if (!r.ok) (env.left || (env.left = [])).push({ ...placed, reason: r.reason });
                }
            }
        }
    }
    if (skipped && !done.length) return { ok: false, reason: skipped[0].reason, detail: { ...(skipped[0].detail || {}), item: skipped[0].item, skipped: skipped.length }, done };
    return { ok: true, done, ...(skipped ? { skipped } : {}) };
}

/** A cell beside the feet with air above and a solid cell below it, for the shulker box. */
function shulkerSpot(w, f) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = f.x + dx, z = f.z + dz;
        if (w.kindAt(x, f.y, z) === 'air' && w.kindAt(x, f.y + 1, z) === 'air' && w.kindAt(x, f.y - 1, z) === 'solid') return { x, y: f.y, z };
    }
    return null;
}

/**
 * Free cells for a station block near the feet, nearest first: air for the block and above it, solid below, within `radius` (the four cells beside the bot
 * are not always free: the supply chest stands among walls, a furnace and a chest, and the crafting table had nowhere to go).
 */
function freeSpots(w, f, radius = 2) {
    const out = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
        if (!dx && !dz) continue;
        for (const dy of [0, 1, -1]) {
            const x = f.x + dx, y = f.y + dy, z = f.z + dz;
            if (w.kindAt(x, y, z) === 'air' && w.kindAt(x, y + 1, z) === 'air' && w.kindAt(x, y - 1, z) === 'solid') { out.push({ x, y, z, d: Math.hypot(dx, dz) + Math.abs(dy) }); break; }
        }
    }
    return out.sort((a, b) => a.d - b.d);
}

/**
 * Air cells next to a solid block within two of the feet, not the bot's own two cells, nearest first: where a block can be hung on the side of something when no floor is
 * free (a bot on a pillar block in open air has nothing to stand beside, but a table can be attached to the pillar).
 */
function attachSpots(w, f, radius = 2) {
    const out = [], N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue;
        const x = f.x + dx, y = f.y + dy, z = f.z + dz;
        if (w.kindAt(x, y, z) !== 'air') continue;
        if (N.some(([a, b, c]) => w.kindAt(x + a, y + b, z + c) === 'solid')) out.push({ x, y, z, d: Math.hypot(dx, dz) + Math.abs(dy) });
    }
    return out.sort((a, b) => a.d - b.d);
}

module.exports = { plan, restock, maintain, pitPolicy, inventoryOf, shulkerSpot, freeSpots, attachSpots, valueOf, stackOf, sitesOf, hasSites, VALUES, TOOL, FOOD, CONTAINER };

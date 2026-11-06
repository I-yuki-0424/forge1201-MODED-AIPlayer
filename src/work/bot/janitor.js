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
const CONTAINER = /(^|_)shulker_box$|^ender_chest$|^chest$|^barrel$/;
const STACK_ONE = /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots|bucket|^shield$|^bow$|^crossbow$|shulker_box$|^ender_chest$|^elytra$|^trident$|^shears$|^fishing_rod$|^flint_and_steel$|^saddle$|_boat$|^minecart$)/;

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
        food: 8,                           // food items wanted (any FOOD) when a depot exists
        depot: null,                       // {kind: 'chest'|'shulker', x, y, z, item?} or null (then everything below neverToss is thrown away)
        ...over,
    };
}

/**
 * Operations that bring the inventory to `freeTarget` free slots and trim surplus. `items`: [{name, count}] (main inventory +
 * hotbar, not armour/off hand); `slotsFree`: number of empty slots. Returns [{op: 'toss'|'deposit', item, count, why}].
 */
function plan(items, slotsFree, policy = pitPolicy()) {
    const ops = [], keepOf = (n) => policy.keep[n] || null;
    const stacks = new Map();
    for (const it of items) stacks.set(it.name, (stacks.get(it.name) || 0) + it.count);
    const protectedItem = (n) => TOOL.test(n) || FOOD.test(n) || CONTAINER.test(n);
    const out = (op, item, count, why) => { if (count > 0) { ops.push({ op, item, count, why }); } };
    const dispose = (item, count, why) => {
        if (policy.depot || hasSites(policy)) out('deposit', item, count, why);
        else if (valueOf(item, policy) < policy.neverToss) out('toss', item, count, why);
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
    return { items: [...m].map(([name, count]) => ({ name, count })), slotsFree: free };
}

/**
 * Carry out plan() with the action layer. A `chest` depot is a fixed container; a `shulker` depot is carried: the bot places the
 * shulker box beside itself, fills it, and breaks it again (the box keeps its contents). Returns {ok, done:[...], reason?}.
 * `env`: exec(name, args), inv() -> {items, slotsFree}, here() -> feet cell {x,y,z}, w (world model).
 */
async function maintain(env, policy) {
    const { items, slotsFree } = env.inv(), ops = plan(items, slotsFree, policy), done = [];
    if (!ops.length) return { ok: true, done };
    for (const o of ops.filter((x) => x.op === 'toss')) {
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
        for (const g of groups.values()) {
            let box = g.box, placed = null;
            if (box.kind === 'shulker') {
                const spot = shulkerSpot(env.w, env.here());
                if (!spot) return { ok: false, reason: 'invalid_target', detail: { why: 'no free cell beside the bot for the shulker box' }, done };
                const p = await env.exec('place', { ...spot, item: box.item || 'shulker_box' });
                if (!p.ok) return { ok: false, reason: p.reason, detail: p.detail, done };
                placed = spot; box = spot;
            }
            try {
                for (const o of g.ops) {
                    const r = await env.exec('deposit', { item: o.item, count: Math.min(o.count, 2304), x: box.x, y: box.y, z: box.z });
                    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail, done };
                    done.push(o);
                }
            } finally {
                if (placed) await env.exec('mine', placed);          // take the box (and what is in it) back
            }
        }
    }
    return { ok: true, done };
}

/** A cell beside the feet with air above and a solid cell below it, for the shulker box. */
function shulkerSpot(w, f) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = f.x + dx, z = f.z + dz;
        if (w.kindAt(x, f.y, z) === 'air' && w.kindAt(x, f.y + 1, z) === 'air' && w.kindAt(x, f.y - 1, z) === 'solid') return { x, y: f.y, z };
    }
    return null;
}

module.exports = { plan, restock, maintain, pitPolicy, inventoryOf, shulkerSpot, valueOf, stackOf, sitesOf, hasSites, VALUES, TOOL, FOOD };

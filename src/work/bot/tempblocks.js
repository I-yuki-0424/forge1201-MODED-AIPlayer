'use strict';
// Which blocks a bot may use as TEMPORARY blocks (pillars, bridges, water seals, the block under a falling bot) and the stack it keeps back for them (owner 2026-11-10:
// "bots stop for want of cobblestone to climb with, yet countless blocks can be placed": a block that can be placed, does not fall and is of low value is a temporary block).
// Pure: the rules are names and a value; a registry (mineflayer's) only confirms that the name is a full block that can be broken again.
//   isTemp(name, registry?)      may this block be stacked / bridged / sealed with?
//   order(held, registry?, o)    the held kinds that qualify, best first (o.hand: blocks that break by hand come first)
//   choose(held, registry?, o)   the first of them with at least o.min in the pack, or null
//   reserve(stacks, n)           what a bot keeps when it stores things: one stack (64) of temporary blocks, over as few kinds as possible
const RESERVE = 64;                   // one stack: the bot never stores or throws away the last one (owner 2026-11-10, point 4)
const LOW_MAX = 8;                    // janitor value up to this = low value (dirt 0 ... cobblestone 5, flint 8)
const HARDNESS_MAX = 4;               // a block that takes longer than this to break again is no temporary block (obsidian 50, deepslate 3, end stone 3, terracotta 1.25)

/** Blocks that fall (sand, gravel, concrete powder, anvils, the dragon egg) or are no floor (scaffolding): never. */
const GRAVITY = /(^|_)(sand|gravel)$|concrete_powder|(^|_)anvil$|dragon_egg|scaffolding|^suspicious_/;
/** Not a full cube whatever the registry says (slabs and stairs are 'block' to the physics but not a floor of one block). */
const SHAPE = /(_slab|_stairs|_wall|_fence|_fence_gate|_button|_pressure_plate|_trapdoor|_door|_sign|_carpet|_pane|_bars|_layer|_head|_skull|_banner|_bed|candle|lantern|chain|torch|rail|ladder|vine|snow|sapling|flower|leaves|glass)$|^snow$|^glass$/;

// The families a pit, a cave or an End island produce in bulk (and the Create stones of the play world's mod set). Crafted forms (polished, bricks, smooth) are NOT in it: they cost work.
const LOW_NAME = new RegExp('^(?:minecraft:|create:)?(?:'
    + ['dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud', 'packed_mud',
        'cobblestone', 'mossy_cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'dripstone_block', 'smooth_basalt', 'basalt',
        'netherrack', 'blackstone', 'end_stone', 'sandstone', 'red_sandstone', 'terracotta', 'clay', 'moss_block',
        'limestone', 'scoria', 'scorchia', 'ochrum', 'crimsite', 'veridium', 'asurine', 'weathered_limestone', 'gabbro', 'dolomite'].join('|')
    + ')$');

const strip = (n) => String(n || '').replace(/^minecraft:/, '');

/** The block may be stacked, bridged or sealed with. With a registry the name must also be a full, breakable block of modest hardness (a mod's block is judged by its data, not its name). */
function isTemp(name, registry = null, valueOf = null) {
    const n = strip(name);
    if (!n || GRAVITY.test(n) || SHAPE.test(n)) return false;
    let low = LOW_NAME.test(n);
    if (!low && registry && valueOf) low = valueOf(n) <= LOW_MAX;                  // a value the operator (or the table) gave: any such name that the registry knows as a block
    if (!low) return false;
    if (!registry) return true;
    const b = registry.blocksByName && (registry.blocksByName[n] || registry.blocksByName[name]);
    if (!b) return false;
    if (b.boundingBox && b.boundingBox !== 'block') return false;
    if (b.diggable === false) return false;
    if (typeof b.hardness === 'number' && (b.hardness < 0 || b.hardness > HARDNESS_MAX)) return false;
    return true;
}

/** Preference: what a pit yields first (cobblestone, deepslate), the rest by how many the pack holds. */
const BASE = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate'];
const HAND = ['dirt', 'coarse_dirt', 'grass_block'];                                // break without a tool (and do not fall)

/** `held`: [{name, count}] (or a Map name -> count). Returns the qualifying kinds, best first. */
function order(held, registry = null, { hand = false, valueOf = null } = {}) {
    const list = held instanceof Map ? [...held].map(([name, count]) => ({ name, count })) : (held || []);
    const have = new Map();
    for (const i of list) { const n = strip(i.name); have.set(n, (have.get(n) || 0) + (i.count || 0)); }
    const ok = [...have].filter(([n, c]) => c >= 1 && isTemp(n, registry, valueOf)).map(([n, c]) => ({ n, c }));
    const rank = (n) => { const i = BASE.indexOf(n); return i < 0 ? BASE.length : i; };
    const h = (n) => (hand ? (HAND.includes(n) ? 0 : 1) : 0);
    return ok.sort((a, b) => h(a.n) - h(b.n) || rank(a.n) - rank(b.n) || b.c - a.c || (a.n < b.n ? -1 : 1)).map((x) => x.n);
}

/** The first qualifying kind with at least `min` in the pack, or null. */
function choose(held, registry = null, o = {}) {
    const min = o.min || 1, have = new Map();
    for (const i of held instanceof Map ? [...held].map(([name, count]) => ({ name, count })) : (held || [])) have.set(strip(i.name), (have.get(strip(i.name)) || 0) + (i.count || 0));
    return order(held, registry, o).find((n) => (have.get(n) || 0) >= min) || null;
}

/** What to keep back when storing: Map name -> how many, adding up to `n` blocks (or all there are) over as few kinds as possible, the biggest stacks first. `stacks`: Map name -> count. */
function reserve(stacks, n = RESERVE, registry = null, valueOf = null) {
    const out = new Map();
    let left = n;
    const kinds = order(stacks, registry, { valueOf }).map((k) => ({ k, c: stacks.get(k) || stacks.get('minecraft:' + k) || 0 }));
    kinds.sort((a, b) => b.c - a.c || BASE.indexOf(a.k) - BASE.indexOf(b.k));
    for (const { k, c } of kinds) { if (left <= 0) break; const take = Math.min(c, left); out.set(k, take); left -= take; }
    return out;
}

module.exports = { isTemp, order, choose, reserve, RESERVE, LOW_MAX, GRAVITY, SHAPE, BASE, HAND };

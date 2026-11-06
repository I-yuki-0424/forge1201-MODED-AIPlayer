'use strict';
// Sites: named places, given by coordinates, with tags that say what they are for (owner 2026-11-06). The simplest thing that works:
// the operator writes down where a chest is and what it is; the work layer decides with plain if-statements (janitor, scripts).
//   tools    a chest full of tools that bots may take from freely (nothing is stored there by the upkeep)
//   ore      ores, raw metal, ingots, gems, coal
//   storage  everything of value that is not an ore
//   junk     low-value items: stone, dirt, gravel, rotten flesh ...
//   food     food
//   blocks   low-value building blocks (stack-up and water sealing)
// A site is a container (chest, barrel, shulker box) at x, y, z. Nothing here talks to the game: `janitor.maintain` and `script.js` read it.
const janitor = require('./janitor');

const TAGS = Object.freeze({
    tools: 'a chest of tools that bots may take from freely',
    ore: 'ores, raw metal, ingots, gems and coal go here',
    storage: 'everything of value that is not an ore',
    junk: 'low-value items: stone, dirt, gravel, rotten flesh',
    food: 'food',
    blocks: 'low-value building blocks for sealing water and stacking up',
});
const NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const COORD = 30_000_000;

const ORE = /(_ore$|^raw_|_ingot$|_nugget$|^diamond$|^emerald$|^coal$|^charcoal$|^redstone$|^lapis_lazuli$|^quartz$|^ancient_debris$|^netherite_scrap$|^amethyst_shard$|^copper_ingot$|^glowstone_dust$)/;

/** Which tag an item belongs under when it is put away: tools, food, ore, junk (low value) or storage. */
function classify(name, policy = {}) {
    if (janitor.TOOL.test(name)) return 'tools';
    if (janitor.FOOD.test(name)) return 'food';
    if (ORE.test(name) || /:(raw_|.*_ingot$|.*_nugget$)/.test(name)) return 'ore';
    if (janitor.valueOf(name, policy) <= 5) return 'junk';
    return 'storage';
}

const needInt = (v, what) => { if (!Number.isInteger(v) || Math.abs(v) > COORD) throw new Error(`${what} must be an integer`); return v; };

/** The registry: name -> {name, x, y, z, tags[]}. */
class Sites {
    constructor(list = []) { this.map = new Map(); for (const s of list) { try { this.add(s); } catch (_) { /* a bad stored entry is dropped, not fatal */ } } }

    add(s) {
        if (!s || typeof s !== 'object') throw new Error('site missing');
        if (typeof s.name !== 'string' || !NAME.test(s.name)) throw new Error('site name: a-z 0-9 _ - (max 24)');
        const tags = [...new Set(Array.isArray(s.tags) ? s.tags : [])];
        if (!tags.length) throw new Error('give at least one tag');
        for (const t of tags) if (!TAGS[t]) throw new Error(`unknown tag ${String(t).slice(0, 20)}; known: ${Object.keys(TAGS).join(', ')}`);
        const site = { name: s.name, x: needInt(s.x, 'x'), y: needInt(s.y, 'y'), z: needInt(s.z, 'z'), tags };
        this.map.set(site.name, site);
        return site;
    }
    remove(name) { return this.map.delete(name); }
    get(name) { return this.map.get(name) || null; }
    list() { return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name)); }

    /** The nearest site with `tag` (to `from` {x,z}, or the first by name). */
    find(tag, from = null) {
        const c = this.list().filter((s) => s.tags.includes(tag));
        if (!from) return c[0] || null;
        return c.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))[0] || null;
    }

    /**
     * Where to put `item` away: the site of its class, else `storage`, else any site that is not a tool chest. Null when there is none.
     * Tools are never put into a `tools` chest by the upkeep (nobody wants a worn pickaxe there): they are protected in the inventory.
     */
    placeFor(item, from = null, policy = {}) {
        const tag = classify(item, policy);
        return this.find(tag === 'tools' ? 'storage' : tag, from) || this.find('storage', from)
            || this.list().filter((s) => !s.tags.includes('tools')).sort((a, b) => (from ? Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z) : 0))[0] || null;
    }
}

module.exports = { Sites, TAGS, classify, NAME };

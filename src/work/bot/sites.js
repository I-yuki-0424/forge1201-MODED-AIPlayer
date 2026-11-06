'use strict';
// Sites: named places, given by coordinates, with tags that say what they are for (owner 2026-11-06). The simplest thing that works:
// the operator writes down where a chest is and what it is; the work layer decides with plain if-statements (janitor, scripts).
//   tools    a chest full of tools that bots may take from freely (nothing is stored there by the upkeep)
//   ore      ores, raw metal, ingots, gems, coal
//   storage  everything of value that is not an ore
//   junk     low-value items: stone, dirt, gravel, rotten flesh ...
//   food     food
//   blocks   low-value building blocks (stack-up and water sealing)
//   machine  a machine (furnace, crusher, ...) with no usable inventory of its own: it is linked (`via`) to a container
// A site is a block at x, y, z with a free `label` ("auto furnace") and tags. A site can be a LINK, like a symbolic link in a file system
// (owner 2026-11-06): `via` names the container that feeds or empties a machine (a chest and hopper beside an automatic furnace). A command
// on the machine's coordinates (`deposit`, `withdraw`, the inventory page) is carried out on the container: `through` follows the link.
// Nothing here talks to the game: `janitor.maintain`, `script.js` and the service (service/links.js) read it.
const janitor = require('./janitor');

const TAGS = Object.freeze({
    tools: 'a chest of tools that bots may take from freely',
    ore: 'ores, raw metal, ingots, gems and coal go here',
    storage: 'everything of value that is not an ore',
    junk: 'low-value items: stone, dirt, gravel, rotten flesh',
    food: 'food',
    blocks: 'low-value building blocks for sealing water and stacking up',
    machine: 'a machine whose items go in and out through the container it is linked to (via)',
});
const MAX_HOPS = 4;                                      // a link to a link to a link ...; deeper is refused like ELOOP
const NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const COORD = 30_000_000;
const LABEL = /^[^\u0000-\u001f\u007f<>"`\\]{1,40}$/;

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

/** The registry: name -> {name, x, y, z, tags[], label?, via?}. */
class Sites {
    constructor(list = []) { this.map = new Map(); for (const s of list) { try { this.add(s, { loose: true }); } catch (_) { /* a bad stored entry is dropped, not fatal */ } } this._dropDangling(); }

    /** `loose`: do not require that the `via` target is already there (a stored list is read in any order). */
    add(s, { loose = false } = {}) {
        if (!s || typeof s !== 'object') throw new Error('site missing');
        if (typeof s.name !== 'string' || !NAME.test(s.name)) throw new Error('site name: a-z 0-9 _ - (max 24)');
        const tags = [...new Set(Array.isArray(s.tags) ? s.tags : [])];
        for (const t of tags) if (!TAGS[t]) throw new Error(`unknown tag ${String(t).slice(0, 20)}; known: ${Object.keys(TAGS).join(', ')}`);
        const label = s.label === undefined || s.label === null || s.label === '' ? undefined : String(s.label).trim();
        if (label !== undefined && !LABEL.test(label)) throw new Error('label: 1-40 characters, no control characters or < > " ` \\');
        const via = s.via === undefined || s.via === null || s.via === '' ? undefined : String(s.via);
        if (via !== undefined) {
            if (!NAME.test(via)) throw new Error('via: the name of another site');
            if (via === s.name) throw new Error('a site cannot be linked to itself');
            if (!loose && !this.map.has(via)) throw new Error(`via: no site ${via.slice(0, 24)} (tag the container first)`);
            if (!loose && this.map.get(via).tags.includes('machine')) throw new Error('via: link to the container, not to another machine');
        }
        if (!tags.length && label === undefined && via === undefined) throw new Error('give at least one tag or a label');
        const site = { name: s.name, x: needInt(s.x, 'x'), y: needInt(s.y, 'y'), z: needInt(s.z, 'z'), tags };
        if (label !== undefined) site.label = label;
        if (via !== undefined) site.via = via;
        const same = this.at(site.x, site.y, site.z);
        if (same && same.name !== site.name) throw new Error(`${site.x} ${site.y} ${site.z} is already tagged as ${same.name}`);
        this.map.set(site.name, site);
        if (!loose) this.through(site.x, site.y, site.z);                       // a link that loops is refused when it is made
        return site;
    }
    /** Remove a site; refused while another site is linked to it (remove the link first). */
    remove(name) {
        const users = this.list().filter((s) => s.via === name);
        if (users.length) throw new Error(`${name} is the target of ${users.map((u) => u.name).join(', ')}: remove those links first`);
        return this.map.delete(name);
    }
    get(name) { return this.map.get(name) || null; }
    list() { return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name)); }
    at(x, y, z) { for (const s of this.map.values()) if (s.x === x && s.y === y && s.z === z) return s; return null; }
    _dropDangling() { for (const s of this.map.values()) if (s.via && !this.map.has(s.via)) delete s.via; }

    /**
     * Follow the links from a block. Null when the block has none (it is its own target); else {x, y, z, via: [names walked]}, the
     * container at the end. Throws on a loop or more than MAX_HOPS links.
     */
    through(x, y, z) {
        let s = this.at(x, y, z); const walked = [];
        if (!s || !s.via) return null;
        while (s && s.via) {
            if (walked.includes(s.name) || walked.length >= MAX_HOPS) throw new Error(`link loop or deeper than ${MAX_HOPS} at ${s.name}`);
            walked.push(s.name);
            s = this.map.get(s.via);
            if (!s) throw new Error(`link target ${walked[walked.length - 1]} -> missing site`);
        }
        return { x: s.x, y: s.y, z: s.z, via: [...walked, s.name] };
    }

    /** The nearest site with `tag` (to `from` {x,z}, or the first by name). */
    find(tag, from = null) {
        const c = this.list().filter((s) => s.tags.includes(tag) && (tag === 'machine' || !s.tags.includes('machine')));
        const best = from ? c.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))[0] : c[0];
        if (!best) return null;
        let end = null; try { end = this.through(best.x, best.y, best.z); } catch (_) { /* a broken link: the site itself */ }
        return end ? { ...best, x: end.x, y: end.y, z: end.z, linked: best.name } : best;     // a link answers with the container it points to
    }

    /**
     * Where to put `item` away: the site of its class, else `storage`, else any site that is not a tool chest or a machine. Null when there is none.
     * Tools are never put into a `tools` chest by the upkeep (nobody wants a worn pickaxe there): they are protected in the inventory.
     */
    placeFor(item, from = null, policy = {}) {
        const tag = classify(item, policy);
        return this.find(tag === 'tools' ? 'storage' : tag, from) || this.find('storage', from)
            || this.list().filter((s) => !s.tags.includes('tools') && !s.tags.includes('machine')).sort((a, b) => (from ? Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z) : 0))[0] || null;
    }
}

module.exports = { Sites, TAGS, classify, NAME, MAX_HOPS };

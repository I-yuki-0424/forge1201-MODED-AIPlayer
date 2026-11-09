'use strict';
// Sites: named places, given by coordinates, each with ONE purpose that says what the block is for (owner 2026-11-06; purposes normalised 2026-11-09:
// the old free-form tags had no clear meaning, so the list is closed and chosen from a pulldown). The work layer decides with plain if-statements.
//   tools    supplies tools: bots take usable tools from it; the upkeep never stores anything there
//   ore      ores, raw metal, ingots, gems and coal are put in
//   trash    rubbish is put in: stone, dirt, gravel, rotten flesh ...                     (was `junk`)
//   food     food is put in
//   blocks   low-value building blocks for sealing water and stacking up
//   any      anything may be put in; the fallback for everything of value that has no chest of its own   (was `storage`)
//   free     the contents may be used freely: bots take what they need from it; nothing is put in by the upkeep
//   furnace  treated as a furnace (or any machine): items go in and out through the container it is linked to (`via`)   (was `machine`)
//   portal   a Nether or End portal the bots may walk through on a route (owner 2026-11-08): `dim` says which dimension it stands in, `twin` names the gate on the other side
//   other    no automatic use: only commands, links and the display work with it
// A site is a block at x, y, z with a free `label` ("auto furnace") and a purpose. A site can be a LINK, like a symbolic link in a file system
// (owner 2026-11-06): `via` names the container that feeds or empties a machine (a chest and hopper beside an automatic furnace). A command
// on the machine's coordinates (`deposit`, `withdraw`, the inventory page) is carried out on the container: `through` follows the link.
// An Ender Storage chest is a site whose `ender` field holds its three colours (+ owner when private); see world/enderstorage.js.
// Nothing here talks to the game: `janitor.maintain`, `script.js` and the service (service/links.js) read it.
const janitor = require('./janitor');
const ender = require('../world/enderstorage');

const PURPOSES = Object.freeze({
    tools: 'supplies tools: bots take usable tools from it, nothing is stored there',
    ore: 'ore, raw metal, ingots, gems and coal are put in',
    trash: 'rubbish is put in: stone, dirt, gravel, rotten flesh',
    food: 'food is put in',
    blocks: 'low-value building blocks for sealing water and stacking up',
    any: 'anything may be put in (the fallback for everything of value)',
    free: 'its contents may be used freely: bots take what they need, nothing is put in',
    furnace: 'treated as a furnace: its items go in and out through the container it is linked to (via)',
    portal: 'a Nether or End portal bots may walk through on a route: give its dimension and link it to the gate on the other side (twin)',
    other: 'no automatic use: only commands, links and the display work with it',
});
const TAGS = PURPOSES;                                      // the old name, still exported
const ALIASES = Object.freeze({ junk: 'trash', storage: 'any', machine: 'furnace' });
const canon = (t) => (ALIASES[t] || t);
// When a stored block has several old tags the most specific one is kept as its purpose.
const PRIORITY = ['furnace', 'portal', 'tools', 'free', 'ore', 'food', 'blocks', 'trash', 'any', 'other'];
const DIMS = Object.freeze(['overworld', 'nether', 'end']);
const STORES = new Set(['ore', 'trash', 'food', 'blocks', 'any']);         // purposes the upkeep puts items into
// Containers that hold items for the bots (owner 2026-11-09): a chest, barrel or Ender Storage block STANDS somewhere, so it is used only within REACH_BLOCKS (10 chunks) of the bot,
// in the bot's dimension; farther away it counts as unusable. Portals, machines and `other` blocks are not containers of this kind and are never filtered.
const REACH_BLOCKS = 160;
const CONTAINER_PURPOSES = new Set(['tools', 'ore', 'trash', 'food', 'blocks', 'any', 'free']);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const MAX_HOPS = 4;                                      // a link to a link to a link ...; deeper is refused like ELOOP
const NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const COORD = 30_000_000;
const LABEL = /^[^\u0000-\u001f\u007f<>"`\\]{1,40}$/;

const ORE = /(_ore$|^raw_|_ingot$|_nugget$|^diamond$|^emerald$|^coal$|^charcoal$|^redstone$|^lapis_lazuli$|^quartz$|^ancient_debris$|^netherite_scrap$|^amethyst_shard$|^copper_ingot$|^glowstone_dust$)/;

/** Which purpose an item belongs under when it is put away: tools, food, ore, trash (low value) or any. */
function classify(name, policy = {}) {
    if (janitor.TOOL.test(name)) return 'tools';
    if (janitor.FOOD.test(name)) return 'food';
    if (ORE.test(name) || /:(raw_|.*_ingot$|.*_nugget$)/.test(name)) return 'ore';
    if (janitor.valueOf(name, policy) <= 5) return 'trash';
    return 'any';
}

const needInt = (v, what) => { if (!Number.isInteger(v) || Math.abs(v) > COORD) throw new Error(`${what} must be an integer`); return v; };

/**
 * The purpose a record asks for: `purpose`, else the old `tags` (aliases mapped). More than one distinct old tag is refused when strict (a request) and
 * reduced to the most specific one when loose (a stored list from before 2026-11-09); the dropped ones are listed in `Sites#migrated`.
 */
function purposeOf(s, strict, name, migrated) {
    if (s.purpose !== undefined && s.purpose !== null && s.purpose !== '') {
        const p = canon(String(s.purpose));
        if (!PURPOSES[p]) throw new Error(`unknown purpose ${String(s.purpose).slice(0, 20)}; known: ${Object.keys(PURPOSES).join(', ')}`);
        return p;
    }
    const tags = [...new Set((Array.isArray(s.tags) ? s.tags : []).map((t) => canon(String(t))))];
    for (const t of tags) if (!PURPOSES[t]) throw new Error(`unknown tag ${String(t).slice(0, 20)}; known: ${Object.keys(PURPOSES).join(', ')}`);
    if (tags.length > 1) {
        if (strict) throw new Error(`choose one purpose, not ${tags.join(' + ')}`);
        const keep = PRIORITY.find((t) => tags.includes(t));
        if (migrated) migrated.push({ name, was: tags, now: keep });
        return keep;
    }
    return tags[0] || 'other';
}

/** The registry: name -> {name, x, y, z, purpose, tags: [purpose], label?, via?, ender?}. */
class Sites {
    constructor(list = []) { this.map = new Map(); this.migrated = []; this.reach = REACH_BLOCKS; for (const s of list) { try { this.add(s, { loose: true }); } catch (_) { /* a bad stored entry is dropped, not fatal */ } } this._dropDangling(); }

    /** `loose`: do not require that the `via` target is already there (a stored list is read in any order). */
    add(s, { loose = false } = {}) {
        if (!s || typeof s !== 'object') throw new Error('site missing');
        if (typeof s.name !== 'string' || !NAME.test(s.name)) throw new Error('site name: a-z 0-9 _ - (max 24)');
        const purpose = purposeOf(s, !loose, s.name, this.migrated);
        let dim; if (s.dim !== undefined && s.dim !== null && s.dim !== '') { dim = String(s.dim).replace(/^minecraft:/, '').replace('the_', ''); if (!DIMS.includes(dim)) throw new Error(`dim: one of ${DIMS.join(', ')}`); }
        const twin = s.twin === undefined || s.twin === null || s.twin === '' ? undefined : String(s.twin);
        if (twin !== undefined) {
            if (!NAME.test(twin)) throw new Error('twin: the name of the gate on the other side');
            if (twin === s.name) throw new Error('a gate cannot be its own twin');
            if (purpose !== 'portal') throw new Error('twin belongs to a portal');
        }
        if (purpose === 'portal' && !dim) dim = 'overworld';
        let freq; if (s.ender !== undefined && s.ender !== null) freq = ender.frequency(s.ender);          // throws with a message for the operator
        const label = s.label === undefined || s.label === null || s.label === '' ? undefined : String(s.label).trim();
        if (label !== undefined && !LABEL.test(label)) throw new Error('label: 1-40 characters, no control characters or < > " ` \\');
        const via = s.via === undefined || s.via === null || s.via === '' ? undefined : String(s.via);
        if (via !== undefined) {
            if (!NAME.test(via)) throw new Error('via: the name of another site');
            if (via === s.name) throw new Error('a site cannot be linked to itself');
            if (!loose && !this.map.has(via)) throw new Error(`via: no site ${via.slice(0, 24)} (tag the container first)`);
            if (!loose && this.map.get(via).purpose === 'furnace') throw new Error('via: link to the container, not to another machine');
        }
        if (purpose === 'other' && label === undefined && via === undefined && !freq) throw new Error('choose a purpose or write a label');
        const site = { name: s.name, x: needInt(s.x, 'x'), y: needInt(s.y, 'y'), z: needInt(s.z, 'z'), purpose, tags: [purpose] };
        if (label !== undefined) site.label = label;
        if (via !== undefined) site.via = via;
        if (freq) site.ender = freq;
        if (dim) site.dim = dim;
        if (twin !== undefined) site.twin = twin;
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
        for (const g of this.map.values()) if (g.twin === name) delete g.twin;                  // a gate whose twin is removed is a gate without a twin, not a refusal (twins point at each other)
        return this.map.delete(name);
    }
    get(name) { return this.map.get(name) || null; }
    list() { return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name)); }
    at(x, y, z) { for (const s of this.map.values()) if (s.x === x && s.y === y && s.z === z) return s; return null; }
    _dropDangling() { for (const s of this.map.values()) { if (s.via && !this.map.has(s.via)) delete s.via; if (s.twin && !this.map.has(s.twin)) delete s.twin; } }

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

    /** A site with its link followed: the container at the end (a broken link: the site itself). */
    _end(best) { let end = null; try { end = this.through(best.x, best.y, best.z); } catch (_) { /* a broken link: the site itself */ } return end ? { ...best, x: end.x, y: end.y, z: end.z, linked: best.name } : best; }

    /**
     * Can a bot at `from` {x, z, dim?} use this site? Containers only within `reach` blocks (10 chunks, owner 2026-11-09) and, when both dimensions are known, in the bot's own.
     * Without `from` nothing is judged (a listing, an operator command). Sites that are no container (portal, furnace, other) are always usable.
     */
    reachable(s, from) {
        if (!from || !CONTAINER_PURPOSES.has(s.purpose)) return true;
        if (from.dim && s.dim && s.dim !== from.dim) return false;
        return flat(this._end(s), from) <= this.reach;
    }

    /** The nearest site with purpose `tag` (to `from` {x,z}, or the first by name); old names (junk, storage, machine) work too. Containers out of reach of `from` are skipped. */
    find(tag, from = null) {
        const c = this.list().filter((s) => s.purpose === canon(tag) && this.reachable(s, from));
        const best = from ? c.sort((a, b) => flat(a, from) - flat(b, from))[0] : c[0];
        return best ? this._end(best) : null;     // a link answers with the container it points to
    }

    /** A tagged block by its NAME, else the nearest one with that purpose (scripts say "nugget-chest" or "tools"); links resolved like `find`; a container out of reach is none. */
    pick(nameOrTag, from = null) {
        const s = this.map.get(nameOrTag);
        if (!s) return this.find(nameOrTag, from);
        return this.reachable(s, from) ? this._end(s) : null;
    }

    /** Every site with `tag`, nearest first (links resolved like `find`): a script that cannot use the nearest chest tries the next. Out of reach: left out. */
    findAll(tag, from = null) {
        const c = this.list().filter((x) => x.purpose === canon(tag) && this.reachable(x, from));
        if (from) c.sort((a, b) => flat(a, from) - flat(b, from));
        return c.map((best) => this._end(best));
    }

    /**
     * Where to LOOK for something a bot lacks (owner 2026-11-09): every container within reach, Ender Storage first (its contents belong to its colours and are the same
     * everywhere), then the ones tagged `prefer`, then the rest, each group nearest first. A tools chest is a source like any other.
     */
    sources(from = null, prefer = null) {
        const want = prefer ? canon(prefer) : null, rank = (s) => (s.ender ? 0 : 2) + (want && s.purpose === want ? 0 : 1);
        return this.list().filter((s) => CONTAINER_PURPOSES.has(s.purpose) && (!['trash', 'food'].includes(s.purpose) || s.purpose === want) && this.reachable(s, from))      // rubbish and food chests hold nothing a missing tool or material is made of
            .sort((a, b) => rank(a) - rank(b) || (from ? flat(a, from) - flat(b, from) : 0)).map((s) => this._end(s));
    }

    /** The site tagged for exactly the class of `item` (ore, junk, food ...), not a fallback: null when the operator made none for it. */
    classSite(item, policy = {}) { return this.find(classify(item, policy)); }

    /** Every place `item` may be put away, best first: the one `placeFor` names, then every other container that takes items within reach, nearest first (a full chest is followed by the next). */
    storesFor(item, from = null, policy = {}) {
        const rest = this.list().filter((s) => STORES.has(s.purpose) && this.reachable(s, from)).sort((a, b) => (from ? flat(a, from) - flat(b, from) : 0)).map((s) => this._end(s));
        return [this.placeFor(item, from, policy), ...rest].filter((s, k, a) => s && a.findIndex((t) => t && t.x === s.x && t.y === s.y && t.z === s.z) === k);
    }

    /**
     * Where to put `item` away: the site of its class, else an `any` chest, else any site that takes items at all (ore, trash, food, blocks, any). Null when there is none.
     * Tools are never put into a `tools` chest by the upkeep (nobody wants a worn pickaxe there): they are protected in the inventory. `free`, `furnace` and `other` sites are never filled.
     */
    placeFor(item, from = null, policy = {}) {
        const tag = classify(item, policy);
        return this.find(tag === 'tools' ? 'any' : tag, from) || this.find('any', from)
            || this.list().filter((s) => STORES.has(s.purpose) && this.reachable(s, from)).sort((a, b) => (from ? flat(a, from) - flat(b, from) : 0))[0] || null;
    }
}

module.exports = { Sites, REACH_BLOCKS, CONTAINER_PURPOSES, TAGS, PURPOSES, ALIASES, DIMS, canon, classify, NAME, MAX_HOPS };

'use strict';
// The dump at the end of a job (owner 2026-11-09): when an open pit or a structure is FINISHED (not after a Move or any other small command), a bot puts everything it carries into
// the tagged storage, except tools and containers (Ender Storage, shulker boxes ...). For now the storage is the Ender chest of the colours white / white / white (setting
// `endDumpEnder`); a switch (`endDump`) turns it off.
// The most valuable stacks go first: an Ender chest has 27 slots, and a pit's cobblestone must not push the diamonds out. What does not fit there goes to the chest the upkeep
// would use for that item (sites.placeFor: ore, rubbish, any ...), and what fits nowhere stays in the pack: nothing is thrown away at the end.
// The chest must be USABLE (sites.js: within 10 chunks, same dimension); a chest in another layer or out of a move_to's sight is gone to (reach.js).
const janitor = require('./janitor');
const { approach } = require('./reach');
const es = require('../world/enderstorage');

const DEFAULT_FREQ = Object.freeze({ left: 'white', middle: 'white', right: 'white' });
const BOT_GONE = new Set(['died', 'disconnected', 'cancelled']);

/** Tools (and what wears like one: armour, buckets) and containers stay with the bot. */
const kept = (name) => janitor.TOOL.test(name) || janitor.CONTAINER.test(name);

/** The tagged Ender chest of this colour combination that a bot at `from` can use, nearest first (links resolved); null when there is none. */
function dumpSite(sites, from, freq = DEFAULT_FREQ) {
    const want = es.keyOf(es.frequency(freq));
    const c = sites.list().filter((s) => s.ender && es.keyOf(s.ender) === want && sites.reachable(s, from));
    if (from) c.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
    return c.length ? sites._end(c[0]) : null;
}

/** What goes into storage, most valuable first: [{name, count}] from the pack's items. Pure. */
function planDump(items, policy = {}) {
    const m = new Map();
    for (const i of items) if (i.count > 0 && !kept(i.name)) m.set(i.name, (m.get(i.name) || 0) + i.count);
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => janitor.valueOf(b.name, policy) - janitor.valueOf(a.name, policy) || b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Put the pack away. `env`: inv(), have(item), pos(), here(), exec(name, args), travel/lift (reach.js), leavePit (optional, with `box`).
 * Returns { ok, dumped: [{item, count, to}], left: [{item, count, reason}], reason? }; ok is false when something stayed in the pack.
 */
async function endDump(env, { sites, policy = {}, freq = DEFAULT_FREQ, box = null } = {}) {
    const dump = planDump(env.inv().items, policy);
    if (!dump.length) return { ok: true, dumped: [], left: [] };
    const left = (list, reason) => list.map((i) => ({ item: i.name, count: env.have(i.name), reason }));
    if (!sites) return { ok: false, reason: 'invalid_target', detail: { why: 'no sites' }, dumped: [], left: left(dump, 'invalid_target') };
    const from = env.pos(), primary = dumpSite(sites, from, freq);
    if (!primary && !dump.some((i) => sites.storesFor(i.name, from, policy).length)) return { ok: false, reason: 'invalid_target', detail: { why: `no tagged storage within ${Math.round(sites.reach / 16)} chunks` }, dumped: [], left: left(dump, 'no_site') };
    // A pit: out of it first (the pillar method), so that the way to the chest is a walk and not a climb of 100 layers; a lift covers what the walk cannot.
    if (box && env.leavePit) { try { if (require('./exit').inPit(env, box)) await env.leavePit(box); } catch (_) { /* the lift below changes the layer */ } }
    const dumped = [], stay = [];
    for (const it of dump) {
        const cands = [primary, ...sites.storesFor(it.name, env.pos(), policy)].filter(Boolean).filter((s, k, a) => a.findIndex((t) => t.x === s.x && t.y === s.y && t.z === s.z) === k);
        let last = null;
        for (const site of cands) {
            const n = Math.min(env.have(it.name), 2304);
            if (n < 1) break;                                                  // a partial deposit into the first chest moved all of it
            const a = await approach(env, site, { why: 'end-of-job dump' });
            if (a) { last = a; if (BOT_GONE.has(a.reason)) return { ok: false, reason: a.reason, dumped, left: left(dump.filter((d) => d !== it && !dumped.some((x) => x.item === d.name)), a.reason) }; continue; }
            const before = env.have(it.name), r = await env.exec('deposit', { item: it.name, count: n, x: site.x, y: site.y, z: site.z });
            const moved = before - env.have(it.name);
            if (moved > 0) dumped.push({ item: it.name, count: moved, to: site.name });
            if (r.ok) { last = null; break; }
            last = r;
            if (BOT_GONE.has(r.reason)) return { ok: false, reason: r.reason, dumped, left: left([it], r.reason) };
        }
        const rest = env.have(it.name);
        if (rest > 0) stay.push({ item: it.name, count: rest, reason: last ? last.reason : 'no_site' });
    }
    return { ok: !stay.length, dumped, left: stay, ...(stay.length ? { reason: stay[0].reason } : {}) };
}

module.exports = { endDump, planDump, dumpSite, kept, DEFAULT_FREQ };

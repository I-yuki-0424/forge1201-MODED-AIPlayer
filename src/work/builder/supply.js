'use strict';
// Supply for a builder (rewrite 2026-11-18): what a bot must carry for the cells it is about to place, and ONE visit per chest to fetch it (moves.js take_many). The old way was one
// `withdraw` per item kind through a recovery script, one trip each: the iron golem trap has 20 kinds and the bots spent more time walking to chests than placing.
const C = require('./cells');

const STACK_FALLBACK = 64;
const stackOf = (bot, item) => { const it = bot.registry && bot.registry.itemsByName[item]; return (it && it.stackSize) || STACK_FALLBACK; };
const emptySlots = (bot) => { let n = 0; for (let s = bot.inventory.inventoryStart; s < bot.inventory.inventoryEnd; s++) if (!bot.inventory.slots[s]) n++; return n; };

/** Items still to place, over the whole plan (what the bot must not throw away or use for a pillar): { item: n }. Cells that already hold their block are not counted. */
function remaining(plan, w) {
    const m = {};
    for (const list of plan.units) for (const c of list) {
        if (!c.waterlog && w.nameAt(c.x, c.y, c.z) === c.block) continue;
        const it = c.waterlog ? 'water_bucket' : C.itemFor(c.block);
        if (it) m[it] = (m[it] || 0) + (/_slab$/.test(c.block) && c.props.type === 'double' ? 2 : 1);
    }
    return m;
}

/**
 * What to take. `need`: what the next cells need. First every shortage is made good; then the free slots (less a few for pickups) are filled with the items the plan still needs most,
 * up to `maxStacks` stacks each: the bot comes back as rarely as the pack allows. Returns [{ item, count }].
 */
function wishes(bot, need, left, { reserve = 5, maxStacks = 3 } = {}) {
    const have = (it) => bot.inventory.items().reduce((n, i) => n + (i.name === it ? i.count : 0), 0);
    const out = new Map(); let slots = Math.max(0, emptySlots(bot) - reserve);
    const slotsFor = (it, n) => Math.ceil(n / stackOf(bot, it));
    for (const [it, n] of Object.entries(need)) {
        const lack = n - have(it); if (lack <= 0) continue;
        out.set(it, lack); slots -= slotsFor(it, lack);
    }
    // top up with what the plan still needs, the biggest demand first, stackable items only (a bucket or a bed takes a slot each)
    const more = Object.entries(left).filter(([it]) => stackOf(bot, it) > 1).sort((a, b) => b[1] - a[1]);
    for (const [it, n] of more) {
        if (slots <= 0) break;
        const want = Math.min(n, maxStacks * stackOf(bot, it)) - have(it) - (out.get(it) || 0); if (want <= 0) continue;
        const ss = Math.min(slots, slotsFor(it, want)), add = Math.min(want, ss * stackOf(bot, it));
        out.set(it, (out.get(it) || 0) + add); slots -= slotsFor(it, add);
    }
    return [...out].map(([item, count]) => ({ item, count: Math.min(2304, Math.max(1, count)) }));
}

/**
 * Fetch `need` for the cells at hand: containers nearest first, one `take_many` each, until nothing is short. `env`: have, here, pos, travel, run, sites, bot, w. Returns { ok } or
 * { ok:false, reason:'missing_item', detail:{ item, ... } }. Never gives up the job: a short bot reports what it lacks and the worker's own scripts take over.
 */
async function restock(env, plan, need, opt = {}) {
    const lacking = () => Object.entries(need).filter(([it, n]) => env.have(it) < n);
    if (!lacking().length) return { ok: true, trips: 0 };
    const sites = env.sites;
    if (!sites) return { ok: false, reason: 'missing_item', detail: { item: lacking()[0][0], why: 'this environment has no list of containers' } };
    const log = { trips: 0, took: {} };
    const tried = new Set();
    for (let round = 0; round < 6 && lacking().length; round++) {
        const chests = sites.sources(env.pos()).filter((s) => !tried.has(`${s.x},${s.y},${s.z}`));
        if (!chests.length) break;
        const c = chests[0]; tried.add(`${c.x},${c.y},${c.z}`);
        if (env.cancelled && env.cancelled()) return { ok: false, reason: 'cancelled' };
        const items = wishes(env.bot, need, remaining(plan, env.w), opt);
        const t = await env.travel({ x: c.x, y: c.y, z: c.z }, { near: 2, nearY: 2, why: 'supply' });
        if (!t.ok) { log.lastTravel = { reason: t.reason, why: t.detail && (t.detail.why || t.detail.nav) }; if (['cancelled', 'died', 'disconnected'].includes(t.reason)) return t; continue; }
        const r = await env.run('take_many', { items, x: c.x, y: c.y, z: c.z });
        log.trips++;
        if (r.ok && r.detail) for (const g of r.detail.got || []) log.took[g.item] = (log.took[g.item] || 0) + g.moved;
        if (!r.ok) { log.lastTake = { reason: r.reason, why: r.detail && r.detail.why }; if (['cancelled', 'died', 'disconnected'].includes(r.reason)) return r; }
    }
    const l = lacking();
    return l.length ? { ok: false, reason: 'missing_item', detail: { item: l[0][0], short: Object.fromEntries(l.map(([it, n]) => [it, n - env.have(it)])), ...log } } : { ok: true, ...log };
}

module.exports = { restock, wishes, remaining, emptySlots, stackOf };

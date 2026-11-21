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
        if (c.ignite) { if (it) m[it] = 1; continue; }
        if (it) m[it] = (m[it] || 0) + (/_slab$/.test(c.block) && c.props.type === 'double' ? 2 : 1);
    }
    return m;
}

/**
 * What to take. `need`: what the next cells need. First every shortage is made good; then the free slots (less a few for pickups) are filled with the items the plan still needs most,
 * up to `maxStacks` stacks each: the bot comes back as rarely as the pack allows. Returns [{ item, count }].
 */
function wishes(bot, need, left, { reserve = 10, maxStacks = 2, share = 3, topup = true } = {}) {
    const have = (it) => bot.inventory.items().reduce((n, i) => n + (i.name === it ? i.count : 0), 0);
    const out = new Map(); let slots = Math.max(0, emptySlots(bot) - reserve);
    const slotsFor = (it, n) => Math.ceil(n / stackOf(bot, it));
    for (const [it, n] of Object.entries(need)) {
        const lack = n - have(it); if (lack <= 0) continue;
        out.set(it, lack); slots -= slotsFor(it, lack);
    }
    // top up with what the plan still needs, the biggest demand first, stackable items only (a bucket or a bed takes a slot each)
    const more = topup ? Object.entries(left).filter(([it]) => stackOf(bot, it) > 1).sort((a, b) => b[1] - a[1]) : [];
    for (const [it, n] of more) {
        if (slots <= 0) break;
        // a share of what is left (the other builders need some too: three bots each took all 24 stairs and the others starved), and only for items in bulk
        if (n < 48) continue;
        const want = Math.min(Math.ceil(n / share), maxStacks * stackOf(bot, it)) - have(it) - (out.get(it) || 0); if (want <= 0) continue;
        const ss = Math.min(slots, slotsFor(it, want)), add = Math.min(want, ss * stackOf(bot, it));
        out.set(it, (out.get(it) || 0) + add); slots -= slotsFor(it, add);
    }
    return [...out].map(([item, count]) => ({ item, count: Math.min(2304, Math.max(1, count)) }));
}

/** Slots the items take (a stack each, a bucket or a bed one slot per piece). */
const slotsOf = (bot, need) => Object.entries(need).reduce((n, [it, c]) => n + Math.ceil(c / stackOf(bot, it)), 0);

/**
 * What the pack holds of the plan's materials beyond what the coming run needs (`need`), as [{ item, count }]: the leftovers of the batch of another area, or of the first fetch (run 2,
 * 2026-11-18: a bot held 145 bricks and 143 wall pieces for a unit that needed 18, had no free slot for the 3 stairs it lacked, and failed on `missing_item` for ten minutes).
 */
function surplus(bot, plan, need) {
    const mats = plan.materials || {}, have = {};
    for (let s = bot.inventory.inventoryStart; s < bot.inventory.inventoryEnd; s++) { const it = bot.inventory.slots[s]; if (it && it.name in mats) have[it.name] = (have[it.name] || 0) + it.count; }
    return Object.entries(have).map(([item, n]) => ({ item, count: n - (need[item] || 0) })).filter((o) => o.count > 0).sort((a, b) => b.count - a.count).slice(0, 40).map((o) => ({ item: o.item, count: Math.min(2304, o.count) }));
}

/**
 * What a bot takes along for its WHOLE RUN of work (owner 2026-11-18: build one small component, fetch materials, build the next: 5 s of placing, 30 s of walking): the items of unit `u` and of the
 * units that follow it in the same area, as many as fit in the pack (whole units, in order), counting the cells that do not hold their block yet. `unitNeed`: what `u` needs (always included, even
 * when it alone is more than the pack holds). Without a bot (a test environment) it is `unitNeed`.
 */
function batch(bot, plan, u, w, unitNeed) {
    if (!bot || !bot.inventory) return unitNeed;
    const P = require('./plan'), z = plan.zones.ofUnit[u], [a, b] = plan.zones.units[z], mats = plan.materials || {};
    let others = 0, total = 0;
    for (let s = bot.inventory.inventoryStart; s < bot.inventory.inventoryEnd; s++) { total++; const it = bot.inventory.slots[s]; if (it && !(it.name in mats)) others++; }
    const cap = Math.max(1, total - others - 3), need = { ...unitNeed };
    for (let i = a; i < b; i++) {
        if (i === u) continue;
        const add = P.needsOf(plan.units[i], w), next = { ...need };
        for (const [it, n] of Object.entries(add)) next[it] = (next[it] || 0) + n;
        if (Object.keys(add).length && slotsOf(bot, next) > cap) break;
        Object.assign(need, next);
    }
    // The crew shares what the chests hold (live 2026-11-21, the Nether side with 1.1 x the materials: one bot carried 35 of the 92 smooth stone for units far ahead, the others stood with missing_item
    // for ten minutes): a bot's batch holds no more of an item than its fair share of what is left, 1.3 x, unless the unit at hand itself needs more.
    const left = remaining(plan, w), n = Math.max(1, plan.zones.n);
    for (const it of Object.keys(need)) { const cap = Math.max(unitNeed[it] || 0, Math.ceil(((left[it] || 0) / n) * 1.3)); if (need[it] > cap) need[it] = cap; }
    return need;
}

/**
 * Fetch `need` for the cells at hand: containers nearest first, one `take_many` each, until nothing is short. `env`: have, here, pos, travel, run, sites, bot, w. Returns { ok } or
 * { ok:false, reason:'missing_item', detail:{ item, ... } }. Never gives up the job: a short bot reports what it lacks and the worker's own scripts take over.
 */
async function restock(env, plan, need, opt = {}) {
    // `opt.trigger`: the items that decide whether a trip is made at all (what the unit at hand needs); `need` may be more (the materials of the run of units that fit in the pack)
    const trig = opt.trigger || need, lacking = () => Object.entries(trig).filter(([it, n]) => env.have(it) < n);
    if (!lacking().length) return { ok: true, trips: 0 };
    const sites = env.sites;
    if (!sites) return { ok: false, reason: 'missing_item', detail: { item: lacking()[0][0], why: 'this environment has no list of containers' } };
    const log = { trips: 0, took: {} };
    const tried = new Set();
    // What each chest held when somebody last took from it (shared by the crew, on the plan): the next trip goes first to the chests known to hold what is lacking, the nearest of them, then the rest.
    const mem = plan.supplyMem || (plan.supplyMem = new Map()), kOf = (c) => `${c.x},${c.y},${c.z}`;
    for (let round = 0; round < 14 && lacking().length; round++) {
        const lack = lacking().map(([it]) => it), known = new Set(); for (const it of lack) for (const k of mem.get(it) || []) known.add(k);
        const all = [...sites.sources(env.pos(), 'materials'), ...(plan.boxes || [])].filter((s) => !tried.has(kOf(s))), chests = [...all.filter((s) => known.has(kOf(s))), ...all.filter((s) => !known.has(kOf(s)))];
        if (!chests.length) break;
        const c = chests[0]; tried.add(`${c.x},${c.y},${c.z}`);
        if (env.cancelled && env.cancelled()) return { ok: false, reason: 'cancelled' };
        const items = wishes(env.bot, need, remaining(plan, env.w), opt);
        let t = await env.travel({ x: c.x, y: c.y, z: c.z }, { near: 2, nearY: 2, maxSegments: 16, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, why: 'supply' });
        if (!t.ok && ['stuck', 'unreachable'].includes(t.reason)) { t = await env.travel({ x: c.x, y: c.y, z: c.z }, { near: 2, nearY: 2, maxSegments: 24, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, digStructure: true, why: 'supply (through the structure)' }); log.dug = true; }
        if (!t.ok) { log.lastTravel = { reason: t.reason, why: t.detail && (t.detail.why || t.detail.nav) }; if (['cancelled', 'died', 'disconnected'].includes(t.reason)) return t; continue; }
        // Room first: what the pack holds beyond this run goes back into the chest (it is also what the other bots lack), when the free slots do not hold what is to be taken.
        if (env.bot && opt.makeRoom !== false) {
            const extra = surplus(env.bot, plan, need), want = slotsOf(env.bot, Object.fromEntries(items.map((i) => [i.item, i.count])));
            if (extra.length && emptySlots(env.bot) < want + 3) {
                const d = await env.run('deposit_many', { items: extra, x: c.x, y: c.y, z: c.z });
                log.deposited = (log.deposited || 0) + (d.ok && d.detail && d.detail.done ? d.detail.done.reduce((n, g) => n + g.moved, 0) : 0);
                if (!d.ok && ['cancelled', 'died', 'disconnected'].includes(d.reason)) return d;
            }
        }
        const account = (r, at) => { if (r.ok && r.detail) for (const g of r.detail.got || []) { log.took[g.item] = (log.took[g.item] || 0) + g.moved; if (g.moved > 0) (mem.get(g.item) || mem.set(g.item, new Set()).get(g.item)).add(kOf(at)); } };
        const r = await env.run('take_many', { items, x: c.x, y: c.y, z: c.z });
        log.trips++; account(r, c);
        // What is still lacking may lie in shulker boxes of this container: one is lifted out and set down, then taken from like a chest, and it stays as a source for the rest of the run.
        for (let k = 0; k < 8 && r.ok && r.detail && (r.detail.shulkers || []).length && lacking().length; k++) {
            const box = await unpack(env, plan, c, lacking().map(([it]) => it), log); if (!box) break;
            const rb = await env.run('take_many', { items: wishes(env.bot, need, remaining(plan, env.w), opt), x: box.x, y: box.y, z: box.z });
            log.trips++; account(rb, box);
            if (!rb.ok && ['cancelled', 'died', 'disconnected'].includes(rb.reason)) return rb;
        }
        for (const it of lack) if (known.has(kOf(c)) && !(log.took[it] > 0)) mem.get(it) && mem.get(it).delete(kOf(c));          // it was said to hold the item and did not (emptied since): forgotten
        if (!r.ok) { log.lastTake = { reason: r.reason, why: r.detail && r.detail.why }; if (['cancelled', 'died', 'disconnected'].includes(r.reason)) return r; }
    }
    const l = lacking();
    if (l.length) { const wanted = plan.wanted || (plan.wanted = {}); for (const [it] of l) wanted[it] = Date.now(); }          // the crew is told: whoever holds more of it than its unit needs gives it back (giveBack)
    return l.length ? { ok: false, reason: 'missing_item', detail: { item: l[0][0], short: Object.fromEntries(l.map(([it, n]) => [it, n - env.have(it)])), ...log } } : { ok: true, ...log };
}

/**
 * The materials of a build may be kept in shulker boxes inside a chest (the owner's creative server, 2026-11-21). Lift ONE box that holds any of `lack` out of the container `c` into the pack
 * and set it down beside the bot; the placed box joins `plan.boxes` (a source of this run, nearest first). Returns its position, or null (no box, or no free cell: the box goes back).
 */
async function unpack(env, plan, c, lack, log) {
    if (!env.exec || !env.here || !env.w || !env.run) return null;
    const t = await env.run('take_shulker', { items: lack, x: c.x, y: c.y, z: c.z });
    if (!t.ok || !t.detail || !t.detail.took) return null;
    const J = require('../bot/janitor'), f = env.here(), spots = [J.shulkerSpot(env.w, f), ...J.freeSpots(env.w, f)].filter(Boolean).slice(0, 4);
    for (const sp of spots) {
        const p = await env.exec('place', { x: sp.x, y: sp.y, z: sp.z, item: t.detail.took });
        if (!p.ok) { if (['cancelled', 'died', 'disconnected'].includes(p.reason)) return null; continue; }
        const box = { x: sp.x, y: sp.y, z: sp.z, shulker: true }, mem = plan.supplyMem || (plan.supplyMem = new Map());
        (plan.boxes || (plan.boxes = [])).push(box);
        for (const it of Object.keys(t.detail.has || {})) (mem.get(it) || mem.set(it, new Set()).get(it)).add(`${box.x},${box.y},${box.z}`);
        log.unpacked = (log.unpacked || 0) + 1;
        return box;
    }
    await env.run('deposit_many', { items: [{ item: t.detail.took, count: 1 }], x: c.x, y: c.y, z: c.z });            // nowhere to set it down: back into the chest
    return null;
}

/**
 * Give back what other builders are waiting for (live 2026-11-21, the Nether side: one bot carried 7 of 9 iron trapdoors from a unit it had handed back, three others failed `missing_item` on the
 * same unit for 15 minutes). Items posted on `plan.wanted` in the last two minutes that the pack holds beyond what `unitNeed` needs now are put into the nearest chest. Returns the number of items given.
 */
async function giveBack(env, plan, unitNeed) {
    const wanted = plan.wanted; if (!wanted || !env.bot || !env.sites || !env.travel || !env.run) return 0;
    const now = Date.now(), give = [];
    for (const [it, t] of Object.entries(wanted)) { if (now - t > 120000) { delete wanted[it]; continue; } const extra = env.have(it) - (unitNeed[it] || 0); if (extra > 0) give.push({ item: it, count: extra }); }
    if (!give.length) return 0;
    const c = env.sites.sources(env.pos())[0]; if (!c) return 0;
    const t = await env.travel({ x: c.x, y: c.y, z: c.z }, { near: 2, nearY: 2, maxSegments: 16, stuckAfter: 3, footNodes: 3000, maxNodes: 60000, why: 'give back what the crew waits for' });
    if (!t.ok) return 0;
    const d = await env.run('deposit_many', { items: give, x: c.x, y: c.y, z: c.z });
    return d.ok && d.detail && d.detail.done ? d.detail.done.reduce((n, g) => n + g.moved, 0) : 0;
}

module.exports = { giveBack, restock, wishes, batch, surplus, slotsOf, remaining, emptySlots, stackOf };

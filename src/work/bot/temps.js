'use strict';
// The blocks the bots put down that are not part of any build (owner 2026-11-10: "blocks placed for water handling are never broken, some temporary blocks are not either;
// register a block when it is placed, and when it is broken treat both as one set; bots get mixed up, so make it global"): water seals, pillars, reflex blocks, scaffolds.
// ONE registry for the whole service (shared by every bot, kept across restarts in state.json), keyed by dimension and cell. Where it is written and read:
//   placed   skills/commands/block.js `place` with `temp: <kind>` (pit seals, water rescue, scaffolds), moves.js `pillar`, bot/reflex.js (a block under a falling bot)
//   broken   skills/commands/block.js `mine` forgets the cell whoever breaks it (so a pair place/break is one set and nothing is left in the list)
//   cleaned  `cleanTemps` below (a finished pit, a bot that passes by), `env.temp` (the per-bot view moves.js uses), `uncover` (a block over a chest)
// A block is only ever taken from this list when it is safe: a seal that still holds water back (fluid beside or above it) stays; everything else goes.
const fixtures = require('../../skills/fixtures');

const MAX = 4000, MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const LATE_MS = 5000;                                                              // a placement the server applies this late is still a placement (an entry is not forgotten before)
const KINDS = new Set(['seal', 'pillar', 'scaffold', 'reflex', 'rescue', 'lake', 'bridge', 'road']);          // lake: the pit's layered water rule (pit_lake.js): floor blocks over water that the next layer digs, the job's end takes the rest. road: the shared bridge from the End platform to the work (never taken away by a passer; the pit's own cleanup takes it at the end)
const CLEAN_NEAR = new Set(['pillar', 'scaffold', 'reflex', 'bridge']);            // movement blocks: taken away by the bot that placed them, as soon as it has passed; by another only when the placer is gone (orphans)
const ORPHAN_MS = 20000, ORPHAN_CLEAR = 3;                                         // an orphan is taken after this long, and never while another bot is within this many blocks
const HOLDS_BACK = new Set(['seal', 'rescue', 'lake']);                                    // blocks that stop water: taken away only when no fluid lies beside or above them, and only by the pit's own cleanup (a first version let every bot that passed remove the water rescue's fills: 369 listed, the pit flooded again, rescue time went from 27-108 to 273-404 bot-s a minute)
const CELL_BOUND = new Set(['seal', 'rescue', 'lake', 'road']);                    // the two-per-bot measure: blocks bound to their cell or the job, not to a bot (ruling (b) of 2026-11-26)
const dimOf = fixtures.dimOf;
const keyOf = (dim, x, y, z) => `${dim}|${x},${y},${z}`;

class Temps {
    constructor(now = Date.now) { this.map = new Map(); this.now = now; this.alive = null; this.others = null; }
    /** The service tells the registry who is playing (`alive(name)`) and where everybody stands (`others()` -> [{name, x, y, z}]), so that a bot never takes away a block another bot may be using (owner 2026-11-10: scaffolds destroyed under their placers, fall deaths). */
    attach({ alive = null, others = null } = {}) { this.alive = alive; this.others = others; return this; }
    /** May `bot` take the block `r` away? Its own: yes. Another bot's: only when that bot is gone (offline or dead), the block is older than ORPHAN_MS and no bot stands within ORPHAN_CLEAR blocks of it. */
    mayClean(bot, r) {
        if (r.by === bot.username || !r.by) return true;
        if (!this.alive || this.alive(r.by) || this.now() - r.at < ORPHAN_MS) return false;
        const list = this.others ? this.others() : null; if (!list) return false;
        return !list.some((o) => o.name !== bot.username && Math.hypot(o.x - r.x - 0.5, o.z - r.z - 0.5) <= ORPHAN_CLEAR && o.y >= r.y - ORPHAN_CLEAR && o.y <= r.y + ORPHAN_CLEAR + 1);
    }
    get size() { return this.map.size; }
    /** Register a placed block: { dim, x, y, z, item, kind, by, job? }. A cell is listed once (the newest placement wins). */
    add(e) {
        if (!e || ![e.x, e.y, e.z].every(Number.isInteger)) return null;
        const k = keyOf(e.dim || 'overworld', e.x, e.y, e.z), rec = { dim: e.dim || 'overworld', x: e.x, y: e.y, z: e.z, item: e.item || null, kind: KINDS.has(e.kind) ? e.kind : 'pillar', by: e.by || null, job: e.job || null, at: this.now() };
        this.map.delete(k); this.map.set(k, rec);
        while (this.map.size > MAX) this.map.delete(this.map.keys().next().value);
        return rec;
    }
    get(dim, c) { return this.map.get(keyOf(dim, c.x, c.y, c.z)) || null; }
    has(dim, c) { return this.map.has(keyOf(dim, c.x, c.y, c.z)); }
    /** Forget a cell (the block was broken, or is not there any more). */
    remove(dim, c) { return this.map.delete(keyOf(dim, c.x, c.y, c.z)); }
    list(pred = null) { return [...this.map.values()].filter((r) => !pred || pred(r)); }
    counts() { const o = {}; for (const r of this.map.values()) o[r.kind] = (o[r.kind] || 0) + 1; return o; }
    /** Kept in state.json: the oldest are dropped past MAX and past three days (the world is the truth, a stale entry is checked against it before anything is broken). */
    toJSON() { const t = this.now(); return this.list((r) => t - r.at < MAX_AGE_MS).slice(-MAX).map(({ dim, x, y, z, item, kind, by, job, at }) => ({ dim, x, y, z, item, kind, by, job, at })); }
    load(list) { for (const r of Array.isArray(list) ? list.slice(-MAX) : []) { if (r && [r.x, r.y, r.z].every(Number.isInteger) && typeof r.dim === 'string' && r.dim.length < 80) { const rec = this.add(r); if (rec && Number.isFinite(r.at)) rec.at = r.at; } } }

    /**
     * One second of the two-per-bot measure (owner list 5 Large 1, the orchestrator's ruling of 2026-11-26): for every bot, the movement blocks it has in place, the pillar under
     * its feet counting as one (the column it stands on while it climbs is one structure in use); blocks bound to a cell or a job (seal, rescue, lake, road) are not a bot's and are
     * counted apart. Adds `dt` seconds to `over` for each bot with more than two: { seconds, by: {bot: s}, how: {'pillar:3,bridge:1': s}, cellBound: peak count }. Returns `over`.
     */
    sample(dt = 1) {
        const o = this.over || (this.over = { seconds: 0, samples: 0, by: {}, how: {}, cellBound: 0 }), per = new Map(), spots = new Map();
        for (const q of (this.others ? this.others() : []) || []) spots.set(q.name, { x: Math.floor(q.x), y: Math.floor(q.y + 0.16), z: Math.floor(q.z) });
        let bound = 0;
        for (const r of this.map.values()) {
            if (CELL_BOUND.has(r.kind)) { bound++; continue; }
            if (!r.by) continue;
            const f = spots.get(r.by), h = per.get(r.by) || {};
            // the column under the feet: one structure (its blocks from the feet down, contiguous)
            if (f && r.kind === 'pillar' && r.x === f.x && r.z === f.z && r.y < f.y && this._column(r, f)) { h.column = 1; per.set(r.by, h); continue; }
            h[r.kind] = (h[r.kind] || 0) + 1; per.set(r.by, h);
        }
        o.samples++; if (bound > o.cellBound) o.cellBound = bound;
        for (const [by, h] of per) {
            const n = Object.values(h).reduce((a, b) => a + b, 0);
            if (n <= 2) continue;
            o.seconds += dt; o.by[by] = (o.by[by] || 0) + dt;
            const k = Object.entries(h).map(([a, b]) => `${a}:${b}`).sort().join(',');
            o.how[k] = (o.how[k] || 0) + dt;
        }
        return o;
    }
    /** Is `r` part of the unbroken column of registered blocks from just under the feet `f` down? */
    _column(r, f) { for (let y = f.y - 1; y > r.y; y--) if (!this.map.has(keyOf(r.dim, r.x, y, r.z))) return false; return true; }

    /** A claim so that two bots do not walk to the same block: true when `who` may take it (a claim ends after `ms`). */
    claim(dim, c, who, ms = 30000) {
        const r = this.get(dim, c); if (!r) return false;
        if (r.claimBy && r.claimBy !== who && r.claimUntil > this.now()) return false;
        r.claimBy = who; r.claimUntil = this.now() + ms; return true;
    }

    /**
     * What `env.temp` is for one bot: the Map-like list moves.js and the worker use (set / delete / size / iterate [key, cell]). It shows what this bot placed, and any block of a kind that
     * is cleaned by whoever passes within 10 blocks of it (a bot that was stopped half way left its pillar for the next one). Seals and the water rescue's fills are not in it.
     */
    view(bot) {
        const self = this, mine = (r) => r.dim === dimOf(bot) && CLEAN_NEAR.has(r.kind) && (r.by === bot.username || (near(bot, r, 10) && self.mayClean(bot, r)));
        const list = () => self.list(mine);
        return {
            get size() { return list().length; },
            set(key, c) { self.add({ dim: dimOf(bot), x: c.x, y: c.y, z: c.z, item: c.item, kind: 'pillar', by: bot.username }); return this; },
            delete(key) { const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(String(key)); return m ? self.remove(dimOf(bot), { x: +m[1], y: +m[2], z: +m[3] }) : false; },
            has(key) { const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(String(key)); return !!m && self.has(dimOf(bot), { x: +m[1], y: +m[2], z: +m[3] }); },
            [Symbol.iterator]() { return list().map((r) => [`${r.x},${r.y},${r.z}`, { x: r.x, y: r.y, z: r.z }])[Symbol.iterator](); },
        };
    }
}
function near(bot, r, d) { const p = bot && bot.entity && bot.entity.position; return !!p && Math.hypot(p.x - r.x - 0.5, p.z - r.z - 0.5) <= d && Math.abs(p.y - r.y) <= d; }

const FLUID = (k) => k === 'water' || k === 'liquid' || k === 'danger';
/** May this block be broken without letting something in? Not while a fluid lies beside or above it (the chunk must be loaded: unknown = not safe). */
function holdsNothingBack(w, c) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const k = w.kindAt(c.x + dx, c.y + dy, c.z + dz);
        if (k === 'unknown' || FLUID(k)) return false;
    }
    return true;
}

/**
 * Break the registered blocks that are safe to break. `env`: exec, here, w, bot, temps (the registry). `o`: { box (a pit {x0,x1,z0,z1,top,bottom}: only blocks inside it, 2 cells around), kinds,
 * radius (without a box: only blocks within this many blocks of the bot), max (blocks per call), maxMs }. A block that is gone is forgotten; a seal with a fluid beside it stays.
 * Returns { broken, forgotten, kept, tried }.
 */
async function cleanTemps(env, o = {}) {
    const temps = env.temps, out = { broken: 0, forgotten: 0, kept: 0, tried: 0 };
    if (!temps || !env.bot) return out;
    const dim = dimOf(env.bot), t0 = Date.now(), box = o.box || null, kinds = o.kinds || KINDS, max = o.max || 40, maxMs = o.maxMs || 90000;
    const inBox = (r) => !box || (r.x >= box.x0 - 2 && r.x <= box.x1 + 2 && r.z >= box.z0 - 2 && r.z <= box.z1 + 2 && r.y <= box.top + 3 && r.y >= box.bottom - 3);
    const f0 = env.here();
    const todo = temps.list((r) => r.dim === dim && kinds.has(r.kind) && inBox(r) && (box || Math.hypot(f0.x - r.x, f0.z - r.z) <= (o.radius || 12))).sort((a, b) => Math.hypot(a.x - f0.x, a.z - f0.z) - Math.hypot(b.x - f0.x, b.z - f0.z));
    for (const r of todo) {
        if (out.tried >= max || Date.now() - t0 > maxMs || (env.cancelled && env.cancelled())) break;
        if (!temps.has(dim, r)) continue;                                                        // taken already with a cluster after a trip
        const kind = env.w.kindAt(r.x, r.y, r.z);
        if (kind === 'unknown') continue;                                                      // not in view: the next bot that passes
        if (kind !== 'solid') { if (temps.now() - (r.at || 0) >= LATE_MS) { temps.remove(dim, r); out.forgotten++; } continue; }              // gone already (or replaced by water): nothing to break; (not within a placement's late window: it may still come, TASK-075)
        if (!HOLDS_BACK.has(r.kind) && (!temps.mayClean || !temps.mayClean(env.bot, r))) continue;                           // another bot's block, its placer still playing or somebody near it: not ours to break
        if (env.w.nameAt && r.item && !String(env.w.nameAt(r.x, r.y, r.z) || '').endsWith(String(r.item).replace(/^minecraft:/, ''))) { temps.remove(dim, r); out.forgotten++; continue; }       // another block now: not ours any more
        const f = env.here();
        if (f.x === r.x && f.z === r.z && f.y === r.y + 1) continue;                            // standing on it
        if (HOLDS_BACK.has(r.kind) && !holdsNothingBack(env.w, r)) { out.kept++; continue; }    // still holds water back
        if (!temps.claim(dim, r, env.bot.username)) continue;
        out.tried++;
        let m = await env.exec('mine', { x: r.x, y: r.y, z: r.z, collect: false });
        // o.reach (the pit's end): a block the mine cannot get to from here (in a dug box: high on a column, deep in a shaft or a water pocket) is reached by NAV first, with every move
        // of a walk (dig, pillar, bridge, the block two below, a block placed under the floor; owner ruling 2026-11-26), then mined, blind within reach (mb075m/n, 1.21.1: 7 pumpkins
        // left after the end, 'the same unmet precondition' from 57 levels away)
        if (!m.ok && o.reach && env.nav && env.w.kindAt(r.x, r.y, r.z) === 'solid' && !['died', 'disconnected', 'cancelled', 'protected'].includes(m.reason) && Date.now() - t0 < maxMs - 15000) {
            out.navTried = (out.navTried || 0) + 1;
            const g = await env.nav({ x: r.x, y: r.y, z: r.z }, { near: 2, nearY: 2, why: 'end: within reach of a temporary block', deadline: Date.now() + Math.min(120000, maxMs - (Date.now() - t0) - 10000) }).catch(() => null);
            if (g && ['died', 'disconnected', 'cancelled'].includes(g.reason)) { m = g; } else if (env.w.kindAt(r.x, r.y, r.z) === 'solid') {
                const h = env.here(), d = Math.hypot(h.x + 0.5 - (r.x + 0.5), h.y + 1.62 - (r.y + 0.5), h.z + 0.5 - (r.z + 0.5));
                if (!(h.x === r.x && h.z === r.z && h.y === r.y + 1)) m = await env.exec('mine', { x: r.x, y: r.y, z: r.z, collect: false, ...(d <= 4.5 ? { blind: true } : {}) });
            }
            if (m.ok || env.w.kindAt(r.x, r.y, r.z) !== 'solid') out.navBroken = (out.navBroken || 0) + 1;
            // where the trip has brought the bot, every other block of the list within the arm's reach goes too, blind (the lake fill's blocks lie together: one trip per block
            // could not finish 134 of them in the end's time, mbc075d w3, 1.21.1), never the block under the body, never one that still holds a fluid back
            if (!['died', 'disconnected', 'cancelled'].includes(m.reason)) {
                const h = env.here(), eye = { x: h.x + 0.5, y: h.y + 1.62, z: h.z + 0.5 };
                const near = todo.filter((q) => q !== r && env.w.kindAt(q.x, q.y, q.z) === 'solid' && Math.hypot(q.x + 0.5 - eye.x, q.y + 0.5 - eye.y, q.z + 0.5 - eye.z) <= 4.4 && !(q.x === h.x && q.z === h.z && q.y === h.y - 1)
                    && (!HOLDS_BACK.has(q.kind) || holdsNothingBack(env.w, q)) && (HOLDS_BACK.has(q.kind) || (temps.mayClean && temps.mayClean(env.bot, q))));
                near.sort((a, b) => b.y - a.y);
                for (const q of near) {
                    if (Date.now() - t0 > maxMs) break;
                    const mm = await env.exec('mine', { x: q.x, y: q.y, z: q.z, collect: false, blind: true });
                    if (mm && ['died', 'disconnected', 'cancelled'].includes(mm.reason)) break;
                    if (env.w.kindAt(q.x, q.y, q.z) !== 'solid') { temps.remove(dim, q); out.broken++; out.cluster = (out.cluster || 0) + 1; }
                }
            }
        }
        if (m.ok || env.w.kindAt(r.x, r.y, r.z) !== 'solid') { temps.remove(dim, r); out.broken++; continue; }
        if (m.reason) { out.fails = out.fails || {}; out.fails[m.reason] = (out.fails[m.reason] || 0) + 1; out.firstFail = out.firstFail || { cell: [r.x, r.y, r.z], reason: m.reason, at: [f.x, f.y, f.z], detail: JSON.stringify(m.detail || {}).slice(0, 240) }; }
        if (['died', 'disconnected', 'cancelled'].includes(m.reason)) break;
        if (m.reason === 'protected') temps.remove(dim, r);                                     // it became a fixture: not ours to break
    }
    return out;
}

/** A block of ours on top of the container at `box` (it cannot be opened with it there): taken away. Only registered blocks, never the world's own. Returns true when something was removed. */
async function uncover(env, box) {
    const temps = env.temps; if (!temps || !env.bot || !box) return false;
    const dim = dimOf(env.bot), above = { x: box.x, y: box.y + 1, z: box.z };
    if (!temps.has(dim, above) || env.w.kindAt(above.x, above.y, above.z) !== 'solid') return false;
    const m = await env.exec('mine', { ...above, collect: false });
    if (m.ok || env.w.kindAt(above.x, above.y, above.z) !== 'solid') { temps.remove(dim, above); return true; }
    return false;
}

module.exports = { Temps, dimOf, cleanTemps, uncover, holdsNothingBack, KINDS, CLEAN_NEAR };

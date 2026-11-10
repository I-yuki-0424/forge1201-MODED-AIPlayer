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
const KINDS = new Set(['seal', 'pillar', 'scaffold', 'reflex', 'rescue', 'bridge']);
const CLEAN_NEAR = new Set(['pillar', 'scaffold', 'reflex', 'bridge']);            // movement blocks: taken away by the bot that placed them, as soon as it has passed; by another only when the placer is gone (orphans)
const ORPHAN_MS = 20000, ORPHAN_CLEAR = 3;                                         // an orphan is taken after this long, and never while another bot is within this many blocks
const HOLDS_BACK = new Set(['seal', 'rescue']);                                    // blocks that stop water: taken away only when no fluid lies beside or above them, and only by the pit's own cleanup (a first version let every bot that passed remove the water rescue's fills: 369 listed, the pit flooded again, rescue time went from 27-108 to 273-404 bot-s a minute)
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
        const kind = env.w.kindAt(r.x, r.y, r.z);
        if (kind === 'unknown') continue;                                                      // not in view: the next bot that passes
        if (kind !== 'solid') { temps.remove(dim, r); out.forgotten++; continue; }              // gone already (or replaced by water): nothing to break
        if (!HOLDS_BACK.has(r.kind) && (!temps.mayClean || !temps.mayClean(env.bot, r))) continue;                           // another bot's block, its placer still playing or somebody near it: not ours to break
        if (env.w.nameAt && r.item && !String(env.w.nameAt(r.x, r.y, r.z) || '').endsWith(String(r.item).replace(/^minecraft:/, ''))) { temps.remove(dim, r); out.forgotten++; continue; }       // another block now: not ours any more
        const f = env.here();
        if (f.x === r.x && f.z === r.z && f.y === r.y + 1) continue;                            // standing on it
        if (HOLDS_BACK.has(r.kind) && !holdsNothingBack(env.w, r)) { out.kept++; continue; }    // still holds water back
        if (!temps.claim(dim, r, env.bot.username)) continue;
        out.tried++;
        const m = await env.exec('mine', { x: r.x, y: r.y, z: r.z, collect: false });
        if (m.ok || env.w.kindAt(r.x, r.y, r.z) !== 'solid') { temps.remove(dim, r); out.broken++; }
        else if (['died', 'disconnected', 'cancelled'].includes(m.reason)) break;
        else if (m.reason === 'protected') temps.remove(dim, r);                                // it became a fixture: not ours to break
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

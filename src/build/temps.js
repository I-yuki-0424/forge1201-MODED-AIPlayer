'use strict';
// The build's temporary blocks (TASK-20261125-075, owner list 5 Large 1): every block a builder puts down that is not a blueprint cell (pillars, bridges, scaffolds, fluid fills,
// seals, the blocks of an escape) is one entry of this ledger, from the click to its removal. The owner's rule: place it, break it as soon as it has served; no "still needed".
//   intend(c, item, how, by)   before the click: the entry exists from then on, tagged with the bot's current step (`begin`); a placement the server applies late is still ours
//   observe(c, name)           every block change a bot sees (drive.js listens to 'blockUpdate'): the server's word confirms a placement and a removal, whoever made it
//   release(by)                the step that needed the bot's blocks is over: they are to go now (the placer digs them; what it cannot reach becomes an untemp task at once)
//   orphan(by, why)            the placer died or left the crew: its blocks are everybody's untemp tasks at once
//   keep(c, rule)              the only way a block outlives its step, named and counted (a seal that holds a fluid back from the finished box)
//   classify(c) / table(cells) the cause of a block found standing at the end: a never registered, b never released, c removal failed (why), d kept (which rule)
// Pure: the caller gives names and positions; `now` is injectable for tests.
const AIR = new Set(['air', 'cave_air', 'void_air']);
const bare = (n) => String(n || '').replace(/^minecraft:/, '');
const key = (x, y, z) => `${x},${y},${z}`;
const HIST_MAX = 50000;
const LATE_MS = 5000;
const RESTORE_MS = 15000;           // a block the server puts back this soon after its removal was never removed
const LEAN_DEPTH = 4;               // move.js LEAN_DEPTH: how deep a column beside its floor the bot takes back from where it stands              // a placement not seen after this long, its cell empty, was never made

class TempLedger {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.map = new Map();          // alive entries: 'x,y,z' -> entry
        this.hist = new Map();         // the last ended entry per cell (removed, never placed, replaced): the end scan tells a block placed again unregistered from one that was never ours
        this.steps = new Map();        // bot -> its current step ('claim#12', 'trip#3' ...)
        this.seq = 0;
        this.n = { intended: 0, placed: 0, never: 0, removed: 0, replaced: 0, released: 0, orphaned: 0, kept: 0, failed: {} };
        this.byHow = {};               // placements by purpose
        this.peak = new Map();         // bot -> most blocks in place at once since the last status()
        this.peakEver = new Map();
        this.over = { events: 0, how: {} };          // times a bot came to hold more than two, and what they were
        // the owner's standard (list 5 Large 1, the orchestrator's ruling 2026-11-26): at most two per bot at any time, the column a bot stands on while it pillars counting as one
        // structure in use; sampled once a second per bot (drive.js): the most beyond that column, and the seconds over two with what they were
        this.loosePeak = new Map(); this.looseEver = new Map(); this.looseOver = { seconds: 0, how: {} };
    }

    /** Blocks of `by` that stand, beyond the column under its feet `f` (the pillar it stands on: one structure in use). */
    loose(by, f) {
        let n = 0; const hs = {}, cells = [];
        // (the crew's spawn bed or anchor is the crew's, for the whole build: not one of the bot's working blocks)
        // (and the column of its own whose top is beside the bot's floor, at its height: the stance's way up and back down, dug as the bot comes down, Mover.walkBack)
        // (or, beside the floor, the column it has just stepped off and is taking back top-down from where it stands, Mover._behind: what is left of it, at most LEAN_DEPTH deep)
        let way = null;
        if (f) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (let y = f.y - 1; y >= f.y - 1 - LEAN_DEPTH && !way; y--) { const q = this.map.get(key(f.x + dx, y, f.z + dz)); if (q) { if (q.by === by && q.how === 'pillar' && !q.released) way = q; break; } }
            if (way) break;
        }
        for (const e of this.map.values()) if (e.by === by && e.state === 'placed' && e.how !== 'fixture' && !(f && e.x === f.x && e.z === f.z && e.y < f.y) && !(way && !e.released && e.x === way.x && e.z === way.z && e.y <= way.y)) { n++; hs[e.how] = (hs[e.how] || 0) + 1; if (cells.length < 6) cells.push(`${e.how} ${e.k}${e.released ? ' released' : ''}${e.lastFail ? ` (${e.lastFail})` : ''}`); }
        return { n, hs, cells };
    }
    /** One sample of bot `by` standing at `f` (once a second). */
    sample(by, f) {
        const { n, hs, cells } = this.loose(by, f); this.lastLoose = cells;
        if (n > (this.loosePeak.get(by) || 0)) this.loosePeak.set(by, n);
        if (n > (this.looseEver.get(by) || 0)) this.looseEver.set(by, n);
        if (n > 2) { this.looseOver.seconds++; const h = Object.entries(hs).map(([k, v]) => `${k}:${v}`).sort().join(','); this.looseOver.how[h] = (this.looseOver.how[h] || 0) + 1; }
        return n;
    }

    /** A new step for bot `by` (what its blocks serve from now on). Returns its id. */
    begin(by, label) { const id = `${label}#${++this.seq}`; this.steps.set(by, id); return id; }
    stepOf(by) { return this.steps.get(by) || 'none'; }

    get(c) { return this.map.get(key(c.x, c.y, c.z)) || null; }
    has(c) { return this.map.has(key(c.x, c.y, c.z)); }
    get size() { return this.map.size; }
    /** Alive entries (optionally of one bot, or matching `pred`). */
    list(pred = null) { const out = []; for (const e of this.map.values()) if (!pred || pred(e)) out.push(e); return out; }
    of(by) { return this.list((e) => e.by === by); }
    /** Blocks of `by` the server has confirmed and that stand now. */
    inPlace(by) { let n = 0; for (const e of this.map.values()) if (e.by === by && e.state === 'placed') n++; return n; }

    /** Registered before the click: `how` pillar | bridge | scaffold | fill | seal | escape ...; the item that goes in. */
    intend(c, item, how, by) {
        const k = key(c.x, c.y, c.z), old = this.map.get(k);
        if (old && old.state === 'placed' && old.by === by) { old.step = this.stepOf(by); old.how = how; return old; }          // the same block again (a re-click)
        const e = { k, x: c.x, y: c.y, z: c.z, item: bare(item), how, by, step: this.stepOf(by), state: 'pending', at: this.now(), seenAt: 0, released: null, orphan: null, keep: null, fails: {}, lastFail: null };
        this.map.set(k, e); this.hist.delete(k);
        this.n.intended++; this.byHow[how] = (this.byHow[how] || 0) + 1;
        return e;
    }

    /** A block change the server sent (any bot's view). Confirms a pending placement, ends an entry whose cell is empty again or holds something else. */
    observe(c, name) {
        let e = this.map.get(key(c.x, c.y, c.z));
        const n = bare(name);
        // the server put back a block whose dig the bot took as done (a dig it did not accept, a rollback): the entry lives on (end scans found such blocks "placed again after
        // its entry ended (removed ...)", bt075c w1)
        if (!e) { const h = this.hist.get(key(c.x, c.y, c.z)); if (h && h.state === 'removed' && h.item === n && this.now() - h.endedAt < RESTORE_MS) { e = h; e.state = 'placed'; delete e.endedAt; this.hist.delete(e.k); this.map.set(e.k, e); this.n.removed--; this.n.restored = (this.n.restored || 0) + 1; return e; } return null; }
        if (n === e.item) { if (e.state === 'pending') { e.state = 'placed'; e.seenAt = this.now(); this.n.placed++; this._peak(e.by, e); } return e; }
        if (e.state === 'pending') { if (AIR.has(n)) e.refused = true; return e; }          // the server's answer to a refused click is the cell as it is; settled by check()
        if (AIR.has(n) || n === 'water' || n === 'lava') return this._end(e, 'removed');
        return this._end(e, 'replaced', n);
    }

    /**
     * The caller read the cell itself (before a removal, at a release). A pending placement whose cell is empty is settled as never placed only when the server answered the click with
     * the empty cell or LATE_MS have passed: settled at once, a placement the server applied after the bot's short wait was in nobody's list (NAV-v1, cause a).
     */
    check(c, name) {
        const e = this.map.get(key(c.x, c.y, c.z)); if (!e) return null;
        const n = bare(name);
        if (e.state === 'pending' && (AIR.has(n) || n === 'water' || n === 'lava')) return e.refused || this.now() - e.at > LATE_MS ? this._end(e, 'never') : e;
        return this.observe(c, name);
    }

    /** It was dug (by whoever: the placer, an untemp task, a clear task). */
    removed(c) { const e = this.map.get(key(c.x, c.y, c.z)); return e ? this._end(e, e.state === 'pending' ? 'never' : 'removed') : null; }

    /** A removal that did not work, and why (unreachable, no face in sight, a bot on it, it holds a fluid back, timed out ...). */
    fail(c, reason) {
        const e = this.map.get(key(c.x, c.y, c.z)); if (!e) return null;
        const r = String(reason || 'failed').slice(0, 60);
        e.fails[r] = (e.fails[r] || 0) + 1; e.lastFail = r; this.n.failed[r] = (this.n.failed[r] || 0) + 1;
        return e;
    }

    /** The step that needed `by`'s blocks is over: every one of them is to go now, except those `stay(e)` names for the step that follows at once (its next stance on the same column). */
    release(by, { stay = null, why = 'step done' } = {}) {
        const out = [];
        for (const e of this.map.values()) {
            if (e.by !== by || e.released || e.orphan) continue;
            if (stay && stay(e)) { e.step = this.stepOf(by); continue; }
            e.released = { at: this.now(), why }; this.n.released++; out.push(e);
        }
        return out;
    }

    /** The placer is gone (died, disconnected, left the crew): its blocks are the crew's to take away. */
    orphan(by, why) {
        const out = [];
        for (const e of this.map.values()) if (e.by === by && !e.orphan) { e.orphan = { at: this.now(), why }; this.n.orphaned++; out.push(e); }
        return out;
    }

    /** A block that outlives its step, by a named rule (the only such rule today: a seal holding a fluid back from the finished box). */
    keep(c, rule) { const e = this.map.get(key(c.x, c.y, c.z)); if (e && e.keep !== rule) { e.keep = rule; this.n.kept++; } return e; }

    /** Is this entry due to go (its step is over or its placer is gone)? */
    due(e) { return !!(e && (e.released || e.orphan) && !e.keep); }

    _end(e, how, by = null) {
        this.map.delete(e.k);
        e.state = how; e.endedAt = this.now(); if (by) e.into = by;
        this.n[how === 'removed' ? 'removed' : how === 'never' ? 'never' : 'replaced']++;
        this.hist.set(e.k, e); if (this.hist.size > HIST_MAX) this.hist.delete(this.hist.keys().next().value);
        return e;
    }

    _peak(by, e) {
        const n = this.inPlace(by);
        if (n > (this.peak.get(by) || 0)) this.peak.set(by, n);
        if (n > (this.peakEver.get(by) || 0)) this.peakEver.set(by, n);
        if (n === 3) { this.over.events++; const hs = {}; for (const q of this.map.values()) if (q.by === by && q.state === 'placed') hs[q.how] = (hs[q.how] || 0) + 1; const h = Object.entries(hs).map(([k, v]) => `${k}:${v}`).sort().join(','); this.over.how[h] = (this.over.how[h] || 0) + 1; }
        void e;
    }

    /** For the progress line: what stands, the most any bot held at once since the last reset (and ever), the counts. `reset`: start a new period for the peaks. */
    status({ reset = false } = {}) {
        let inPlace = 0, pending = 0, due = 0, kept = 0;
        for (const e of this.map.values()) { if (e.state === 'placed') inPlace++; else pending++; if (this.due(e)) due++; if (e.keep) kept++; }
        const max = (m) => { let b = null, v = 0; for (const [k, n] of m) if (n > v) { v = n; b = k; } return { bot: b, n: v }; };
        const out = { inPlace, pending, due, kept, loose: max(this.loosePeak), looseEver: max(this.looseEver), looseOver2s: this.looseOver.seconds, looseHow: { ...this.looseOver.how }, peak: max(this.peak), peakEver: max(this.peakEver), over2: this.over.events, n: { ...this.n, failed: { ...this.n.failed } }, byHow: { ...this.byHow } };
        if (reset) { this.peak.clear(); this.loosePeak.clear(); }
        return out;
    }

    /**
     * The cause of a temporary block found standing in cell c (an end scan): a never registered | b registered, its step never released it | c released (or orphaned) and the removal
     * failed (why) | d kept by a named rule. Returns { cause, why }.
     */
    classify(c) {
        const k = key(c.x, c.y, c.z), e = this.map.get(k);
        if (!e) { const h = this.hist.get(k); return { cause: 'a', why: h ? `placed again after its entry ended (${h.state}, ${h.how} by ${h.by})` : 'no entry' }; }
        if (e.keep) return { cause: 'd', why: e.keep };
        if (!e.released && !e.orphan) return { cause: 'b', why: `${e.how} of ${e.by}, step ${e.step} still open${e.state === 'pending' ? ' (never seen placed)' : ''}` };
        return { cause: 'c', why: e.lastFail || (e.orphan ? `orphaned (${e.orphan.why}), not tried yet` : 'released, not tried yet') };
    }

    /** The cause table over cells found standing: { total, a, b, c, d, why: {'c: unreachable': n ...} }. */
    table(cells) {
        const t = { total: 0, a: 0, b: 0, c: 0, d: 0, why: {} };
        for (const c of cells) { const r = this.classify(c); t.total++; t[r.cause]++; const w = `${r.cause}: ${r.why.replace(/-?\d+/g, '#').replace(/step \S+/, 'step').slice(0, 70)}`; t.why[w] = (t.why[w] || 0) + 1; }
        return t;
    }
}

module.exports = { TempLedger, key, bare, LATE_MS };

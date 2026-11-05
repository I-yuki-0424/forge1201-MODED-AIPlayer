'use strict';
// Crew ledger: who does which part of a job, for any number of bots (docs/proposed/WORKERS-v1.md).
// Pure and deterministic (the clock is an argument); no game, no I/O. Four rules carry the whole design:
//   1. A job is regions (a chunk of a pit, a floor of a house) made of ordered UNITS (layer x row). A unit is IDEMPOTENT:
//      running it twice, or after a half-finished run, ends in the same world (mining air is a no-op).
//   2. A bot holds a LEASE on a unit. A lease that is not renewed expires and the unit is free again: a dead bot needs no
//      detection, its work just comes back. A late result for an expired lease is still accepted (idempotent).
//   3. Units of a layer become claimable only when the layer above is settled (done or stuck): digging goes top-down,
//      building bottom-up (the caller orders layers accordingly; the ledger only knows "layer k before k+1").
//   4. A bot with no work of its own helps: it takes units from the TAIL of the busiest region while the owner works from
//      the head, so the two meet in the middle without talking to each other.
// A unit that fails for its own reasons (not the bot's death) is retried by ANOTHER bot, up to maxAttempts, then `stuck`
// (reported, never retried forever; the layer below does not wait for it).

const PENDING = 0, LEASED = 1, DONE = 2, STUCK = 3;
const BOT_FAULT = new Set(['died', 'disconnected', 'cancelled']);   // not the unit's fault: no attempt is counted
// A failure that says something about where the bot IS, not about the unit: a bot that respawned far away sees "chunk not loaded".
// Likewise what the bot lacks: another bot with a pickaxe or blocks can run the unit (live run p3: three iron pickaxes wore out at
// ~250 blocks each and every unit they were on was charged as an attempt).
const isBotSide = (reason, detail) => BOT_FAULT.has(reason) || reason === 'missing_tool' || reason === 'missing_item'
    || (reason === 'unreachable' && !!detail && detail.why === 'target chunk not loaded');

class Ledger {
    /**
     * @param leaseMs     how long a lease lives without heartbeat
     * @param maxAttempts failures (other than the bot's own death) before a unit is `stuck`
     * @param crowd       score penalty per other bot already in a region (huge = help only when nothing unowned is left)
     */
    constructor({ leaseMs = 60000, maxAttempts = 3, crowd = 1e6, maxLead = Infinity } = {}) {
        this.maxLead = maxLead;       // a region may start layer f only while f - (the lowest front of any open region) <= maxLead: lanes stay in step
        Object.assign(this, { leaseMs, maxAttempts, crowd });
        this.regions = new Map();
        this.bots = new Map();
        this.byIdx = [];
        this.stuck = [];                    // {region, unit, layer, row, reason, detail}
        this.leased = new Set();            // regions with at least one live lease (reap scans only these)
        this.log = [];                      // bounded event ring for reports
    }

    addRegion({ id, anchor = { x: 0, z: 0 }, layers, rows, deps = [], meta = {} }) {
        if (this.regions.has(id)) throw new Error(`region ${id} exists`);
        if (!Number.isInteger(layers) || !Number.isInteger(rows) || layers < 1 || rows < 1) throw new Error(`region ${id}: layers/rows`);
        const n = layers * rows;
        this.regions.set(id, {
            id, anchor, layers, rows, deps, meta, n,
            state: new Uint8Array(n), attempts: new Uint8Array(n), owner: new Int32Array(n).fill(-1),
            until: new Float64Array(n), avoid: new Int32Array(n).fill(-1),
            settled: new Int32Array(layers), front: 0, doneN: 0, stuckN: 0, leasedN: 0, lessees: new Map(),
        });
    }

    bot(id) {
        let b = this.bots.get(id);
        if (!b) { this.bots.set(id, b = { id, idx: this.bots.size, last: null, leases: new Set(), done: 0, failed: 0, faults: 0, alive: true }); this.byIdx.push(b); }
        b.alive = true;
        return b;
    }
    join(id) { this.bot(id); }

    complete(r) { return r.front >= r.layers; }
    ready(r) { return r.deps.every((d) => { const x = this.regions.get(d); return !x || this.complete(x); }); }
    finished() { for (const r of this.regions.values()) if (!this.complete(r)) return false; return true; }

    _ev(e) { if (this.log.length > 500) this.log.shift(); this.log.push(e); }

    _release(r, u, now) {
        if (r.state[u] !== LEASED) return;
        const b = this._botByIdx(r.owner[u]);
        if (b) b.leases.delete(`${r.id}\u0000${u}`);
        const k = r.owner[u], c = (r.lessees.get(k) || 1) - 1;
        if (c <= 0) r.lessees.delete(k); else r.lessees.set(k, c);
        r.state[u] = PENDING; r.owner[u] = -1; r.leasedN--;
        if (!r.leasedN) this.leased.delete(r.id);
        this._ev({ t: now, ev: 'release', region: r.id, unit: u });
    }
    _botByIdx(i) { return this.byIdx[i] || null; }

    _settle(r, u) {
        const l = (u / r.rows) | 0;
        r.settled[l]++;
        while (r.front < r.layers && r.settled[r.front] === r.rows) r.front++;
    }

    /** Expired leases go back to pending. */
    reap(now) {
        for (const id of [...this.leased]) {
            const r = this.regions.get(id);
            for (let u = 0; u < r.n && r.leasedN; u++) {
                if (r.state[u] === LEASED && r.until[u] <= now) {
                    const b = this._botByIdx(r.owner[u]); if (b) b.faults++;
                    this._release(r, u, now);
                }
            }
        }
    }

    /** Keep the bot's leases alive. */
    heartbeat(botId, now) {
        const b = this.bots.get(botId); if (!b) return;
        for (const key of b.leases) {
            const [rid, u] = key.split('\u0000'); const r = this.regions.get(rid);
            if (r.state[+u] === LEASED && r.owner[+u] === b.idx) r.until[+u] = now + this.leaseMs;
        }
    }

    /**
     * Give `botId` (standing at pos {x,z}) up to `batch` units, or null when nothing is claimable right now (either all done,
     * or the remaining units wait for a layer to settle: poll again). Returns {region, meta, units: [{unit, layer, row}], role}.
     */
    claim(botId, pos, now, { batch = 1 } = {}) {
        this.reap(now);
        const b = this.bot(botId);
        // A bot is steered away from a unit it just failed only if another live bot exists to take it (else it would never run).
        let alive = 0; for (const x of this.byIdx) if (x.alive) alive++;
        const shun = alive > 1 ? b.idx : -2;
        let best = null, minFront = Infinity;
        if (this.maxLead !== Infinity) for (const r of this.regions.values()) if (r.front < r.layers && r.front < minFront) minFront = r.front;
        for (const r of this.regions.values()) {
            if (r.front >= r.layers || !this.ready(r)) continue;
            if (this.maxLead !== Infinity && r.front - minFront > this.maxLead) continue;
            const base = r.front * r.rows;
            let any = false;
            for (let i = 0; i < r.rows; i++) if (r.state[base + i] === PENDING && r.avoid[base + i] !== shun) { any = true; break; }
            if (!any) continue;
            const others = r.lessees.size - (r.lessees.has(b.idx) ? 1 : 0);
            const d = Math.hypot(r.anchor.x - pos.x, r.anchor.z - pos.z);
            const score = (b.last === r.id ? -1e12 : 0) + others * this.crowd + d;
            if (!best || score < best.score) best = { r, score, others };
        }
        if (!best) return null;
        const { r } = best, base = r.front * r.rows, units = [];
        const helper = best.others > 0 && !r.lessees.has(b.idx);
        const order = [...Array(r.rows).keys()]; if (helper) order.reverse();       // helpers start at the tail
        for (const i of order) {
            if (units.length >= batch) break;
            const u = base + i;
            if (r.state[u] !== PENDING || r.avoid[u] === shun) continue;
            r.state[u] = LEASED; r.owner[u] = b.idx; r.until[u] = now + this.leaseMs; r.leasedN++;
            r.lessees.set(b.idx, (r.lessees.get(b.idx) || 0) + 1);
            b.leases.add(`${r.id}\u0000${u}`);
            units.push({ unit: u, layer: r.front, row: i });
        }
        this.leased.add(r.id);
        b.last = r.id;
        this._ev({ t: now, ev: 'claim', bot: botId, region: r.id, units: units.map((x) => x.unit), helper });
        return { region: r.id, meta: r.meta, units, role: helper ? 'helper' : 'owner' };
    }

    /** The unit is done (accepted also after the lease expired or went to another bot: units are idempotent). */
    done(botId, regionId, u, now) {
        const r = this.regions.get(regionId), b = this.bot(botId), was = r.state[u];
        if (was === DONE) return;
        if (was === LEASED) { const o = this._botByIdx(r.owner[u]); if (o) o.leases.delete(`${r.id}\u0000${u}`); this._dropLessee(r, u); }
        if (was === STUCK) { this.stuck = this.stuck.filter((s) => !(s.region === regionId && s.unit === u)); r.stuckN--; }
        r.state[u] = DONE; r.owner[u] = -1; r.doneN++;
        if (was !== STUCK) this._settle(r, u);       // a stuck unit already settled its layer
        b.done++;
        this._ev({ t: now, ev: 'done', bot: botId, region: regionId, unit: u });
    }
    _dropLessee(r, u) {
        const k = r.owner[u], c = (r.lessees.get(k) || 1) - 1;
        if (c <= 0) r.lessees.delete(k); else r.lessees.set(k, c);
        r.leasedN--; if (!r.leasedN) this.leased.delete(r.id);
    }

    /** The unit failed with `reason` (a runner reason). Bot-side reasons do not count against the unit. */
    fail(botId, regionId, u, reason, now, detail = null) {
        if (isBotSide(reason, detail)) reason = 'cancelled';           // the bot's own trouble (see isBotSide): release the unit, count nothing
        const r = this.regions.get(regionId), b = this.bot(botId);
        if (r.state[u] === DONE || r.state[u] === STUCK) return;
        if (r.state[u] === LEASED && r.owner[u] !== b.idx) return;      // a late report about a lease another bot now holds
        if (r.state[u] === LEASED) this._release(r, u, now);
        if (BOT_FAULT.has(reason)) { b.faults++; return; }
        b.failed++;
        r.attempts[u]++; r.avoid[u] = b.idx;
        this._ev({ t: now, ev: 'fail', bot: botId, region: regionId, unit: u, reason });
        if (r.attempts[u] >= this.maxAttempts) {
            r.state[u] = STUCK; r.stuckN++; this._settle(r, u);
            this.stuck.push({ region: regionId, unit: u, layer: (u / r.rows) | 0, row: u % r.rows, reason, detail });
        }
    }

    /** The bot is gone (disconnect, death handled elsewhere): its units are free at once, nothing is counted against them. */
    leave(botId, now) {
        const b = this.bots.get(botId); if (!b) return;
        for (const key of [...b.leases]) { const [rid, u] = key.split('\u0000'); this._release(this.regions.get(rid), +u, now); }
        b.alive = false; b.last = null;
    }

    /** Give every stuck unit another round of attempts (a repair pass after the job has finished). Returns how many. */
    requeueStuck(now) {
        let n = 0;
        for (const s of this.stuck.splice(0)) {
            const r = this.regions.get(s.region);
            r.state[s.unit] = PENDING; r.attempts[s.unit] = 0; r.avoid[s.unit] = -1; r.stuckN--; r.settled[s.layer]--;
            if (s.layer < r.front) r.front = s.layer;
            n++;
        }
        if (n) this._ev({ t: now, ev: 'requeue', n });
        return n;
    }

    progress() {
        let total = 0, done = 0, stuck = 0, leased = 0, regionsDone = 0;
        for (const r of this.regions.values()) { total += r.n; done += r.doneN; stuck += r.stuckN; leased += r.leasedN; if (this.complete(r)) regionsDone++; }
        return { total, done, stuck, leased, pending: total - done - stuck - leased, regions: this.regions.size, regionsDone, finished: this.finished() };
    }

    report() {
        const bots = {}; for (const b of this.bots.values()) bots[b.id] = { done: b.done, failed: b.failed, faults: b.faults, alive: b.alive };
        return { ...this.progress(), stuck: this.stuck.slice(), bots };
    }
}

module.exports = { Ledger, PENDING, LEASED, DONE, STUCK, BOT_FAULT, isBotSide };

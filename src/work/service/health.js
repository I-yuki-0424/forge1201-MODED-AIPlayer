'use strict';
// Health of the work layer in numbers (owner 2026-11-09: "the stability has dropped, the only way to find out why is the logs"). The problem list says what went wrong at one
// place; it did not say where the TIME went. Live, 17 cancelled units cost more bot time than 27 finished ones, and nothing counted it. This keeps one window of counters, writes a
// row of it every minute (`health.jsonl`, rotated, one line per minute is about 1 KB) and a one-line summary into the log, and says so (warn) when no unit finished for
// `stallMin` windows while bots were working. Pure apart from the file: the service feeds it unit results and a snapshot of the bots.
const fs = require('fs');

class Health {
    /** @param o { file (JSONL or null), maxBytes (rotate to <file>.1 above this), stallMin (windows without a finished unit before a warning), now } */
    constructor({ file = null, maxBytes = 4e6, stallMin = 3, now = Date.now } = {}) {
        Object.assign(this, { file, maxBytes, stallMin, now });
        this.zero = 0; this._reset(); this.writes = 0;
        this.cur = new Map(); this.last = new Map();            // bot -> { name, phase, at } (what it is doing now); bot -> { x, y, z } (where it stood at the last sample)
    }
    // Where the bot time goes (owner 2026-11-09: "it says Digging but stands still ... find the bottleneck first"). Every working bot is in exactly one ACTIVITY (claim, unit, janitor, line,
    // lift, chest, audit, rescue, recover, backoff, idle ...); inside `unit` the action layer's phase (plan, walk, dig ...) splits it further. Time is added up per key in bot-seconds, and
    // every 2 s a sample says whether the bot has moved: seconds without any movement per key are what "standing still" means, measured, not guessed.
    _key(c) { return c.sub || (c.name === 'unit' ? `unit:${c.phase || 'start'}` : c.name); }
    _span(c, t) { const k = this._key(c), ms = Math.max(0, t - c.at); this.time[k] = (this.time[k] || 0) + ms; c.at = t; }
    /** The bot starts doing `name` (null: it stopped working). */
    act(bot, name) { const t = this.now(), c = this.cur.get(bot); if (c) { if (c.name === name) return; this._span(c, t); } if (name) this.cur.set(bot, { name, phase: null, sub: null, at: t }); else { this.cur.delete(bot); this.last.delete(bot); } }
    /** A stretch inside the activity (a line, a lift, a chest window): counted on its own; null = back in the activity. */
    sub(bot, name) { const c = this.cur.get(bot); if (!c || c.sub === name) return; this._span(c, this.now()); c.sub = name; }
    /** The action layer began a phase (only counted inside a unit). */
    phase(bot, p) { const c = this.cur.get(bot); if (!c || c.name !== 'unit' || c.phase === p) return; this._span(c, this.now()); c.phase = p; }
    /** Called every ~2 s with the bot's position: no movement since the last call = 2 s standing still in what it is doing. */
    sample(bot, pos, ms = 2000) {
        const c = this.cur.get(bot); if (!c || !pos) return;
        const l = this.last.get(bot); this.last.set(bot, { x: pos.x, y: pos.y, z: pos.z });
        if (l && Math.abs(l.x - pos.x) < 0.25 && Math.abs(l.y - pos.y) < 0.25 && Math.abs(l.z - pos.z) < 0.25) { const k = this._key(c); this.still[k] = (this.still[k] || 0) + ms; }
    }
    _reset() { this.time = this.time || {}; this.time = {}; this.still = {}; this.since = this.now(); this.done = 0; this.quick = 0; this.dep = { visits: 0, kinds: 0, items: 0, failed: 0, to: {} }; this.fail = {}; this.cancel = {}; this.ms = { ok: 0, fail: 0, cancel: 0 }; this.needs = {}; this.parked = 0; this.parkedBy = {}; }

    /** A deposit visit: { kinds, items } moved (janitor_done) or a janitor failure (`failed`). */
    deposit(d) { if (d.failed) this.dep.failed++; else { this.dep.visits++; this.dep.kinds += d.kinds | 0; this.dep.items += d.items | 0; for (const t of d.to || []) this.dep.to[t] = (this.dep.to[t] || 0) + 1; } }

    /** A unit was parked as stuck (the same failure twice, or too many tries): counted by reason. */
    park(d) { this.parked++; const k = `${d.reason}${d.detail && d.detail.stage ? ':' + d.detail.stage : ''}`; this.parkedBy[k] = (this.parkedBy[k] || 0) + 1; }

    /** One unit result as the worker reports it: { ok, reason, ms, detail }. */
    unit(d) {
        const ms = Math.max(0, d.ms | 0);
        // A unit that finished in under 300 ms was already done in the world (a job brought back after a restart runs its finished units again as no-ops): not work, not counted in the rate.
        if (d.ok) { if (ms < 300) this.quick++; else { this.done++; this.ms.ok += ms; } return; }
        if (d.reason === 'cancelled') { const c = (d.detail && d.detail.cause) || 'unknown'; this.cancel[c] = (this.cancel[c] || 0) + 1; this.ms.cancel += ms; return; }
        const k = d.reason || 'unknown'; this.fail[k] = (this.fail[k] || 0) + 1; this.ms.fail += ms;
        if (k === 'missing_tool' || k === 'missing_item') { const w = String((d.detail && (d.detail.block || d.detail.item)) || '?').replace(/^minecraft:/, ''); const n = `${k}:${w}`; this.needs[n] = (this.needs[n] || 0) + 1; }
    }

    /**
     * Close the window. `snap`: { bots: [{ name, working, phase, retired, waitFor, onFloor }], lines: [{ key, line: [..] }], lagMs }.
     * Returns { row, text, warn } and appends the row to the file.
     */
    flush(snap = {}) {
        const t = this.now(), sec = Math.max(1, Math.round((t - this.since) / 1000)), bots = snap.bots || [];
        const phases = {}; let working = 0, waiting = 0;
        for (const b of bots) { if (b.working) { working++; const p = b.phase || '-'; phases[p] = (phases[p] || 0) + 1; } if (b.retired) waiting++; }
        for (const c of this.cur.values()) this._span(c, t);                          // spans that cross the window boundary are cut here
        const sec2 = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v >= 500).map(([k, v]) => [k, Math.round(v / 1000)]));
        const failN = Object.values(this.fail).reduce((a, n) => a + n, 0), cancelN = Object.values(this.cancel).reduce((a, n) => a + n, 0);
        const row = {
            t, sec, done: this.done, quick: this.quick, perMin: Math.round((this.done * 60 / sec) * 10) / 10, failed: failN, cancelled: cancelN,
            fail: this.fail, cancel: this.cancel, needs: this.needs, botSec: { ok: Math.round(this.ms.ok / 1000), fail: Math.round(this.ms.fail / 1000), cancel: Math.round(this.ms.cancel / 1000) },
            deposit: this.dep, bots: bots.length, working, waiting, phases, floor: bots.filter((b) => b.onFloor).length,
            queues: (snap.lines || []).map((l) => ({ key: l.key, n: l.line.length })), lagMs: snap.lagMs || 0,
            time: sec2(this.time), still: sec2(this.still), parked: this.parked, parkedBy: this.parkedBy, route: snap.route || undefined,
        };
        // A window in which nobody finished a unit although bots were working: counted, and after `stallMin` of them said once per run of them.
        let warn = null;
        if (this.done === 0 && this.quick === 0 && working > 0) { this.zero++; if (this.zero === this.stallMin || (this.zero > this.stallMin && this.zero % 10 === 0)) warn = `no unit finished for ${this.zero} min with ${working} bots working`; } else this.zero = 0;
        const top = (o, n = 3) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
        const text = `health ${sec}s: ${this.done} units (${row.perMin}/min)${this.quick ? ` + ${this.quick} already done` : ''}, failed ${failN}${failN ? ` (${top(this.fail)})` : ''}, cancelled ${cancelN}${cancelN ? ` (${top(this.cancel)})` : ''}; bot time ok ${row.botSec.ok}s fail ${row.botSec.fail}s cancel ${row.botSec.cancel}s; ${working}/${bots.length} working${waiting ? `, ${waiting} waiting` : ''} [${top(phases, 6)}]${this.dep.visits || this.dep.failed ? `; deposits ${this.dep.visits} ok (${this.dep.items} items, ${this.dep.kinds} kinds), ${this.dep.failed} failed${Object.keys(this.dep.to).length ? ` to ${top(this.dep.to)}` : ''}` : ''}${row.queues.length ? `; lines ${row.queues.map((q) => `${q.key.replace(/^box:/, '')}=${q.n}`).join(' ')}` : ''}${Object.keys(this.needs).length ? `; needs ${top(this.needs)}` : ''}${this.parked ? `; parked ${this.parked} (${top(this.parkedBy, 2)})` : ''}; time ${top(row.time, 8)}; still ${top(row.still, 6)}`;
        this._write(row);
        this._reset();
        return { row, text, warn };
    }

    _write(row) {
        if (!this.file) return;
        try {
            if (++this.writes % 30 === 1) { try { if (fs.statSync(this.file).size > this.maxBytes) fs.renameSync(this.file, this.file + '.1'); } catch (_) { /* no file yet */ } }
            fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
        } catch (_) { /* a log is never a reason to stop work */ }
    }
}

module.exports = { Health };

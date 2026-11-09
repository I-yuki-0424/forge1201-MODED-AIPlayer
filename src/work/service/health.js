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
    }
    _reset() { this.since = this.now(); this.done = 0; this.quick = 0; this.dep = { visits: 0, kinds: 0, items: 0, failed: 0, to: {} }; this.fail = {}; this.cancel = {}; this.ms = { ok: 0, fail: 0, cancel: 0 }; this.needs = {}; }

    /** A deposit visit: { kinds, items } moved (janitor_done) or a janitor failure (`failed`). */
    deposit(d) { if (d.failed) this.dep.failed++; else { this.dep.visits++; this.dep.kinds += d.kinds | 0; this.dep.items += d.items | 0; for (const t of d.to || []) this.dep.to[t] = (this.dep.to[t] || 0) + 1; } }

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
        const failN = Object.values(this.fail).reduce((a, n) => a + n, 0), cancelN = Object.values(this.cancel).reduce((a, n) => a + n, 0);
        const row = {
            t, sec, done: this.done, quick: this.quick, perMin: Math.round((this.done * 60 / sec) * 10) / 10, failed: failN, cancelled: cancelN,
            fail: this.fail, cancel: this.cancel, needs: this.needs, botSec: { ok: Math.round(this.ms.ok / 1000), fail: Math.round(this.ms.fail / 1000), cancel: Math.round(this.ms.cancel / 1000) },
            deposit: this.dep, bots: bots.length, working, waiting, phases, floor: bots.filter((b) => b.onFloor).length,
            queues: (snap.lines || []).map((l) => ({ key: l.key, n: l.line.length })), lagMs: snap.lagMs || 0,
        };
        // A window in which nobody finished a unit although bots were working: counted, and after `stallMin` of them said once per run of them.
        let warn = null;
        if (this.done === 0 && this.quick === 0 && working > 0) { this.zero++; if (this.zero === this.stallMin || (this.zero > this.stallMin && this.zero % 10 === 0)) warn = `no unit finished for ${this.zero} min with ${working} bots working`; } else this.zero = 0;
        const top = (o, n = 3) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
        const text = `health ${sec}s: ${this.done} units (${row.perMin}/min)${this.quick ? ` + ${this.quick} already done` : ''}, failed ${failN}${failN ? ` (${top(this.fail)})` : ''}, cancelled ${cancelN}${cancelN ? ` (${top(this.cancel)})` : ''}; bot time ok ${row.botSec.ok}s fail ${row.botSec.fail}s cancel ${row.botSec.cancel}s; ${working}/${bots.length} working${waiting ? `, ${waiting} waiting` : ''} [${top(phases, 6)}]${this.dep.visits || this.dep.failed ? `; deposits ${this.dep.visits} ok (${this.dep.items} items, ${this.dep.kinds} kinds), ${this.dep.failed} failed${Object.keys(this.dep.to).length ? ` to ${top(this.dep.to)}` : ''}` : ''}${row.queues.length ? `; lines ${row.queues.map((q) => `${q.key.replace(/^box:/, '')}=${q.n}`).join(' ')}` : ''}${Object.keys(this.needs).length ? `; needs ${top(this.needs)}` : ''}`;
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

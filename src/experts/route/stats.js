'use strict';
// Counters of the walks (docs/implemented/ROUTE-v1.md): how often the chunk-exit router and the old leg walk were asked, how they ended, and what the router cost in computing time.
// One window (`take()` returns it and starts a new one: the health row of every minute carries it) and totals since the process started (`totals()`). Pure bookkeeping.
const blank = () => ({
    router: { calls: 0, ok: 0, fail: {}, legs: 0, decisions: 0, moveFails: 0, prepMs: 0, thinkMs: 0, thinkMaxMs: 0, execMs: 0, wallMs: 0 },
    legacy: { calls: 0, ok: 0, fail: {}, wallMs: 0 },          // the old legs, asked directly (router off) or after the router failed
    final: { calls: 0, ok: 0, fail: {} },                      // what the caller got: the walk's outcome whichever way it was made
});
let win = blank(), tot = blank();
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

/** kind: 'router' | 'legacy'; r: the walk's result; ms: wall time of the call. */
function record(kind, r, ms) {
    for (const s of [win, tot]) {
        const x = s[kind]; x.calls++; x.wallMs += ms;
        if (r.ok) x.ok++; else bump(x.fail, r.reason || 'unknown');
        if (kind === 'router' && r.route) { const q = r.route; x.legs += r.legs || (r.detail && r.detail.legs) || 0; x.decisions += q.decisions; x.moveFails += q.fails; x.prepMs += q.prepMs; x.thinkMs += q.thinkMs; x.thinkMaxMs = Math.max(x.thinkMaxMs, q.thinkMaxMs); x.execMs += q.execMs; }
    }
}
/** The outcome the caller of env.travel saw. */
function final(r) { for (const s of [win, tot]) { s.final.calls++; if (r.ok) s.final.ok++; else bump(s.final.fail, r.reason || 'unknown'); } }
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v)));
function take() { const w = win; win = blank(); return round(w); }
const totals = () => round(tot);
const reset = () => { win = blank(); tot = blank(); };

module.exports = { record, final, take, totals, reset };

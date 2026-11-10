'use strict';
// Counters of the learned walk (RL-MOVE-v3): per window (the health row of every minute carries it, `take()` starts a new one) and since the process started (`totals()`).
// `recovered`: walks that had at least one action fail on the way and still arrived (the owner's "recovery after failure" measure: recovered / walks with a failed action).
const blank = () => ({ calls: 0, ok: 0, refused: 0, fail: {}, decisions: 0, actionFails: 0, withFail: 0, recovered: 0, wallMs: 0, planMs: 0, toolMs: 0, fellBack: 0, fellBackOk: 0 });
let win = blank(), tot = blank();
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

/** r: the result of walk3; ms: wall time. A refusal (target too far, no model) is counted apart: it is not a failed walk. */
function record(r, ms) {
    for (const s of [win, tot]) {
        if (r.reason === 'refused') { s.refused++; continue; }
        s.calls++; s.wallMs += ms;
        const m = r.move3 || {};
        s.decisions += m.decisions || 0; s.actionFails += m.fails || 0; s.planMs += m.ms || 0; s.toolMs += m.tool || 0;
        if (m.fails > 0) { s.withFail++; if (r.ok) s.recovered++; }
        if (r.ok) s.ok++; else bump(s.fail, r.reason || 'unknown');
    }
}
/** The walk failed and the old chain took over: did it get there? */
function fallback(ok) { for (const s of [win, tot]) { s.fellBack++; if (ok) s.fellBackOk++; } }
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v)));
const take = () => { const w = win; win = blank(); return round(w); };
const totals = () => round(tot);
const reset = () => { win = blank(); tot = blank(); };
module.exports = { record, fallback, take, totals, reset };

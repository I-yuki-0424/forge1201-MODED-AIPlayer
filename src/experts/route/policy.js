'use strict';
// Chunk-exit routing, part 3: the policy. A candidate's score is a linear term plus a small tanh network over [candidate row, context]:
//   score = lin . x + w2 . tanh(W1 x + b1),  x = [DK candidate features, DC context]   (474 parameters at 16 hidden units)
// The linear term starts as a hand-written heuristic (reach, progress, no tabu, no going back), so a policy that learned nothing is the heuristic, never random;
// training (tools/route/train.js, evolution strategies on the simulator's return) moves all weights. Plain JavaScript, weights in models/experts/route.json.
const { DK, DC } = require('./features');

const DIN = DK + DC, HIDDEN = 16;
const NPARAM = DIN + DIN * HIDDEN + HIDDEN + HIDDEN;
const IX = { prog: 0, rem: 1, lat: 2, dyc: 3, dyt: 4, dyt_gain: 5, reached: 6, cost: 7, in_range: 8, open: 9, water: 10, wall: 11, slope: 12, visits: 13, tabu: 14, back: 15, lateral: 16, diag_or_off: 17 };

/** The heuristic as a parameter vector (network part zero). */
function heuristicVector(hidden = HIDDEN) {
    const v = new Float64Array(DIN + DIN * hidden + hidden + hidden);
    const lin = { prog: 2, dyt_gain: 1, reached: 4, cost: -1, open: 1, water: -1, wall: -1.5, visits: -1.5, tabu: -8, back: -2, lateral: -0.5, diag_or_off: -0.2 };
    for (const [k, w] of Object.entries(lin)) v[IX[k]] = w;
    return v;
}

/** A model from a flat parameter vector: lin[DIN], W1[DIN x H] row-major, b1[H], w2[H]. */
function fromVector(v, hidden = HIDDEN) {
    if (v.length !== DIN + DIN * hidden + 2 * hidden) throw new Error(`route policy: ${v.length} parameters, expected ${DIN + DIN * hidden + 2 * hidden}`);
    let o = 0;
    const lin = Float64Array.from(v.subarray(o, o += DIN)), w1 = Float64Array.from(v.subarray(o, o += DIN * hidden)), b1 = Float64Array.from(v.subarray(o, o += hidden)), w2 = Float64Array.from(v.subarray(o, o += hidden));
    return { hidden, lin, w1, b1, w2, doc: null };
}
const toVector = (m) => Float64Array.from([...m.lin, ...m.w1, ...m.b1, ...m.w2]);

function load(doc) {
    if (doc.kind !== 'route' || doc.dk !== DK || doc.dc !== DC) throw new Error(`route policy: document is for dk ${doc.dk} dc ${doc.dc}, code has dk ${DK} dc ${DC}`);
    const m = fromVector(Float64Array.from([...doc.lin, ...doc.w1.flat(), ...doc.b1, ...doc.w2]), doc.hidden);
    m.doc = doc;
    return m;
}
function toDoc(m, meta = {}) {
    const rows = []; for (let i = 0; i < DIN; i++) rows.push(Array.from(m.w1.subarray(i * m.hidden, (i + 1) * m.hidden)).map((x) => +x.toFixed(6)));
    return { kind: 'route', version: 1, dk: DK, dc: DC, hidden: m.hidden, lin: Array.from(m.lin).map((x) => +x.toFixed(6)), w1: rows, b1: Array.from(m.b1).map((x) => +x.toFixed(6)), w2: Array.from(m.w2).map((x) => +x.toFixed(6)), meta };
}

/** Scores of K candidates: feat is K x DK row-major, ctx DC. */
function scores(m, feat, ctx, K) {
    const H = m.hidden, out = new Float64Array(K), h = new Float64Array(H);
    let base = 0;
    for (let j = 0; j < DC; j++) base += m.lin[DK + j] * ctx[j];
    // The context part of the hidden pre-activation is the same for every candidate.
    const pre0 = Float64Array.from(m.b1);
    for (let j = 0; j < DC; j++) { const x = ctx[j]; if (x === 0) continue; const r = (DK + j) * H; for (let u = 0; u < H; u++) pre0[u] += x * m.w1[r + u]; }
    for (let k = 0; k < K; k++) {
        let s = base;
        for (let u = 0; u < H; u++) h[u] = pre0[u];
        for (let i = 0; i < DK; i++) {
            const x = feat[k * DK + i];
            if (x === 0) continue;
            s += m.lin[i] * x;
            const r = i * H;
            for (let u = 0; u < H; u++) h[u] += x * m.w1[r + u];
        }
        for (let u = 0; u < H; u++) s += m.w2[u] * Math.tanh(h[u]);
        out[k] = s;
    }
    return out;
}

/** Index of the best score (first on ties), -1 for no candidates. */
function argmax(s) { let b = -1; for (let k = 0; k < s.length; k++) if (b < 0 || s[k] > s[b]) b = k; return b; }

module.exports = { heuristicVector, fromVector, toVector, load, toDoc, scores, argmax, NPARAM, HIDDEN, DIN };

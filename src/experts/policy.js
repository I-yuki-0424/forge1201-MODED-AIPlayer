'use strict';
// A trained candidate-scoring policy (moe/policy.py) run in plain JavaScript: weights from models/experts/<name>.json (moe/export.py), no dependency.
// Context vector -> two tanh layers -> h; every candidate row -> two tanh layers -> c_k; score_k = s2(tanh(s1([c_k, c_k * h]))); value = v2(tanh(v1(h))).
const NEG = -1e9;

function layer(l) {
    const w = l.w, nIn = w.length, nOut = w[0].length, flat = new Float64Array(nIn * nOut);
    for (let i = 0; i < nIn; i++) for (let j = 0; j < nOut; j++) flat[i * nOut + j] = w[i][j];
    return { nIn, nOut, w: flat, b: Float64Array.from(l.b) };
}
/** y = x W + b (x: Float64Array of length nIn at offset `off`), optionally tanh. */
function dense(l, x, off, act, out, outOff = 0) {
    const { nIn, nOut, w, b } = l;
    for (let j = 0; j < nOut; j++) out[outOff + j] = b[j];
    for (let i = 0; i < nIn; i++) {
        const xi = x[off + i];
        if (xi === 0) continue;
        const row = i * nOut;
        for (let j = 0; j < nOut; j++) out[outOff + j] += xi * w[row + j];
    }
    if (act) for (let j = 0; j < nOut; j++) out[outOff + j] = Math.tanh(out[outOff + j]);
}

/** The model of one expert from its exported JSON document. */
function load(doc) {
    const L = {}; for (const k of Object.keys(doc.params)) L[k] = layer(doc.params[k]);
    return { doc, L, hidden: doc.hidden, ctxDim: doc.ctx_dim, candDim: doc.cand_dim };
}

/**
 * ctx: Float64Array(ctxDim); cand: Float64Array(K * candDim) row-major; mask: array of K booleans.
 * Returns { logits: Float64Array(K) (NEG where masked), value }.
 */
function forward(model, ctx, cand, mask) {
    const { L, hidden: H, candDim } = model, K = mask.length;
    const t1 = new Float64Array(H), h = new Float64Array(H), v1 = new Float64Array(H), v2 = new Float64Array(1);
    dense(L.c1, ctx, 0, true, t1); dense(L.c2, t1, 0, true, h);
    dense(L.v1, h, 0, true, v1); dense(L.v2, v1, 0, false, v2);
    const a = new Float64Array(H), c = new Float64Array(H), sIn = new Float64Array(2 * H), s = new Float64Array(H), o = new Float64Array(1), logits = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        if (!mask[k]) { logits[k] = NEG; continue; }
        dense(L.k1, cand, k * candDim, true, a); dense(L.k2, a, 0, true, c);
        for (let j = 0; j < H; j++) { sIn[j] = c[j]; sIn[H + j] = c[j] * h[j]; }
        dense(L.s1, sIn, 0, true, s); dense(L.s2, s, 0, false, o);
        logits[k] = o[0];
    }
    return { logits, value: v2[0] };
}

/** Greedy index, or a draw from softmax(logits) with `rnd` in [0,1). -1 when nothing is allowed. */
function choose(logits, mask, { sample = false, rnd = Math.random } = {}) {
    let best = -1;
    for (let k = 0; k < logits.length; k++) if (mask[k] && (best < 0 || logits[k] > logits[best])) best = k;
    if (best < 0 || !sample) return best;
    let z = 0; const p = [];
    for (let k = 0; k < logits.length; k++) { const e = mask[k] ? Math.exp(logits[k] - logits[best]) : 0; p.push(e); z += e; }
    let r = rnd() * z;
    for (let k = 0; k < p.length; k++) { r -= p[k]; if (r <= 0 && p[k] > 0) return k; }
    return best;
}

module.exports = { load, forward, choose, NEG };

'use strict';
// The open-pit expert, part 2: the scoring network (models/experts/pit.json, written by `python -m rl3.cli pit-export`): the same small MLP scores every candidate station from its features
// and the chunk's context, the best allowed one is taken. Without the file the first candidate is taken (the greedy order of model.js: most cells for the least walking).
const fs = require('fs');
const path = require('path');
const { K, NF, NG } = require('./model');

const MODEL_FILE = path.join(__dirname, '..', '..', '..', 'models', 'experts', 'pit.json');
const f32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice(); };

function load(doc) {
    if (!doc || doc.kind !== 'pit' || doc.nf !== NF || doc.ng !== NG || doc.k !== K) throw new Error(`pit policy: file is for nf ${doc && doc.nf} ng ${doc && doc.ng} k ${doc && doc.k}, code has ${NF} ${NG} ${K}`);
    const H = doc.hid, m = { hid: H, w1: f32(doc.w1), b1: f32(doc.b1), w2: f32(doc.w2), b2: f32(doc.b2), ws: f32(doc.ws), bs: f32(doc.bs), meta: doc.meta || {} };
    if (m.w1.length !== (NF + NG) * H || m.w2.length !== H * H || m.ws.length !== H) throw new Error('pit policy: matrix sizes do not match');
    return m;
}

/** Scores (Float64Array K) of the candidates. */
function scores(m, feats, glob) {
    const H = m.hid, out = new Float64Array(K), g = new Float64Array(H), h1 = new Float64Array(H), h2 = new Float64Array(H);
    for (let u = 0; u < H; u++) { let a = m.b1[u]; for (let j = 0; j < NG; j++) a += glob[j] * m.w1[(NF + j) * H + u]; g[u] = a; }
    for (let k = 0; k < K; k++) {
        for (let u = 0; u < H; u++) h1[u] = g[u];
        for (let i = 0; i < NF; i++) { const v = feats[k * NF + i]; if (v === 0) continue; for (let u = 0; u < H; u++) h1[u] += v * m.w1[i * H + u]; }
        for (let u = 0; u < H; u++) h1[u] = Math.tanh(h1[u]);
        for (let u = 0; u < H; u++) h2[u] = m.b2[u];
        for (let i = 0; i < H; i++) { const v = h1[i]; for (let u = 0; u < H; u++) h2[u] += v * m.w2[i * H + u]; }
        let s = m.bs[0]; for (let u = 0; u < H; u++) s += Math.tanh(h2[u]) * m.ws[u];
        out[k] = s;
    }
    return out;
}

/** The index (0..K-1) of the best allowed candidate, or -1. `ban`: a Set of candidate indices to leave out. */
function choose(m, obs, ban = null) {
    const sc = m ? scores(m, obs.feats, obs.glob) : null;
    let best = -1;
    for (let k = 0; k < K; k++) {
        if (!obs.mask[k] || (ban && ban.has(k))) continue;
        if (!sc) return k;                                              // greedy: the list is sorted
        if (best < 0 || sc[k] > sc[best]) best = k;
    }
    return best;
}

let cached;
function defaultModel() { if (cached !== undefined) return cached; try { cached = load(JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'))); } catch (_) { cached = null; } return cached; }

module.exports = { load, scores, choose, defaultModel, MODEL_FILE };

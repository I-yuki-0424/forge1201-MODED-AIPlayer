'use strict';
// RL-MOVE-v3, the policy: an MLP 2964 -> 256 -> 256 -> 19 (tanh), weights in models/experts/move3.json (float32, base64, row-major [in, out]; written by `python -m rl3.cli export`).
// Evaluated in plain JavaScript: about 0.8 M multiply-adds, under a millisecond. Greedy over the allowed actions; no randomness at run time.
const fs = require('fs');
const path = require('path');
const { OBS_DIM, NA } = require('./spec');

const MODEL_FILE = path.join(__dirname, '..', '..', '..', 'models', 'experts', 'move3.json');
const f32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice(); };

function load(doc) {
    if (!doc || doc.kind !== 'move3' || doc.obs_dim !== OBS_DIM || doc.na !== NA) throw new Error(`move3 policy: file is for obs ${doc && doc.obs_dim} / ${doc && doc.na} actions, code has ${OBS_DIM} / ${NA}`);
    const H = doc.hid, m = { hid: H, w1: f32(doc.w1), b1: f32(doc.b1), w2: f32(doc.w2), b2: f32(doc.b2), wp: f32(doc.wp), bp: f32(doc.bp), meta: doc.meta || {}, h1: new Float32Array(H), h2: new Float32Array(H) };
    if (m.w1.length !== OBS_DIM * H || m.w2.length !== H * H || m.wp.length !== H * NA) throw new Error('move3 policy: matrix sizes do not match');
    return m;
}

/** Logits (Float64Array of NA) for an observation. The first layer skips zero inputs (the patch is mostly empty). */
function logits(m, x) {
    const H = m.hid, h1 = m.h1, h2 = m.h2, out = new Float64Array(NA);
    for (let u = 0; u < H; u++) h1[u] = m.b1[u];
    for (let i = 0; i < OBS_DIM; i++) { const v = x[i]; if (v === 0) continue; const r = i * H; for (let u = 0; u < H; u++) h1[u] += v * m.w1[r + u]; }
    for (let u = 0; u < H; u++) h1[u] = Math.tanh(h1[u]);
    for (let u = 0; u < H; u++) h2[u] = m.b2[u];
    for (let i = 0; i < H; i++) { const v = h1[i], r = i * H; for (let u = 0; u < H; u++) h2[u] += v * m.w2[r + u]; }
    for (let u = 0; u < H; u++) h2[u] = Math.tanh(h2[u]);
    for (let a = 0; a < NA; a++) out[a] = m.bp[a];
    for (let i = 0; i < H; i++) { const v = h2[i], r = i * NA; for (let a = 0; a < NA; a++) out[a] += v * m.wp[r + a]; }
    return out;
}

/** The best allowed action (first on ties), or -1 when none is allowed. `ban`: a Set of actions to leave out as well. */
function act(m, x, mask, ban = null) {
    const l = logits(m, x); let best = -1;
    for (let a = 0; a < NA; a++) if (mask[a] && !(ban && ban.has(a)) && (best < 0 || l[a] > l[best])) best = a;
    return { action: best, logits: l };
}

let cached;
/** The shipped policy, or null when the file is missing or does not fit the code (the caller then does not use move3). */
function defaultModel() {
    if (cached !== undefined) return cached;
    try { cached = load(JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'))); } catch (_) { cached = null; }
    return cached;
}

module.exports = { load, logits, act, defaultModel, MODEL_FILE };

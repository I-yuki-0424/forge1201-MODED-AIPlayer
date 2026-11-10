'use strict';
// The open-pit expert (docs/proposed/PIT-EXPERT-v1.md), part 1: the cell model of ONE chunk and the features of every possible station. A line-for-line port of rl3/pitsim.py (the simulator the
// scoring network was trained on); tests/golden_pit.json (python -m rl3.cli pit-golden) is the contract.
//   m[x][z][y]   N x N x H cells of the chunk: AIR, SOLID, ROCK, WATER; y 0..BAND-1 the band to dig (0 the lower layer), y BAND..H-1 the open space above it (leftovers stand there)
//   a station is a COLUMN (x, z) and a depth (1 or 2 layers): the bot stands on the column's top block and the arm digs what lies within reach.
const N = 16, H = 6, BAND = 2, AIR = 0, SOLID = 1, ROCK = 2, WATER = 3;
const R2 = 4.05 ** 2, K = 64, ND = 2, NF = 17, NG = 8, MAX_STATIONS = 40, INF = 1e6;

/** Feet level of every column (the cell above its top block, 0 on the floor) and whether the column can be stood on (a water top cannot). */
function columns(m) {
    const f = [], ok = [];
    for (let x = 0; x < N; x++) {
        f.push(new Int8Array(N)); ok.push(new Uint8Array(N));
        for (let z = 0; z < N; z++) {
            let top = -1;
            for (let y = H - 1; y >= 0; y--) if (m[x][z][y] !== AIR) { top = y; break; }
            f[x][z] = top + 1; ok[x][z] = top < 0 || m[x][z][top] !== WATER ? 1 : 0;
        }
    }
    return { f, ok };
}

/** Walking distance (blocks) from column `bot` over the heightfield: step up 1, drop up to 3, on standable columns. Float64Array N*N (INF when unreachable). */
function reach(f, ok, bot) {
    const d = new Float64Array(N * N).fill(INF);
    d[bot[0] * N + bot[1]] = 0;
    for (let it = 0; it < 40; it++) {
        let changed = false; const nd = d.slice();
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            if (!ok[x][z]) continue;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const px = x - dx, pz = z - dz;                       // the cell the step comes from
                if (px < 0 || px >= N || pz < 0 || pz >= N || !ok[px][pz]) continue;
                const df = f[x][z] - f[px][pz];
                if (df <= 1 && df >= -3 && d[px * N + pz] + 1 < nd[x * N + z]) { nd[x * N + z] = d[px * N + pz] + 1; changed = true; }
            }
        }
        d.set(nd);
        if (!changed) break;
    }
    return d;
}

/** The cells the arm digs from column (x, z) with feet level fz and depth `depth`: [[x, z, y], ...] (solid or water, in reach, not deeper than `depth` layers below the surface, never the block under the feet). */
function digSet(m, x, z, fz, depth) {
    const out = [];
    for (let cx = Math.max(0, x - 4); cx <= Math.min(N - 1, x + 4); cx++) for (let cz = Math.max(0, z - 4); cz <= Math.min(N - 1, z + 4); cz++) for (let y = Math.max(0, fz - depth); y < H; y++) {
        const c = m[cx][cz][y];
        if (c !== SOLID && c !== WATER) continue;
        const dy = y - fz - 1.12, d2 = (cx - x) ** 2 + (cz - z) ** 2 + dy * dy;
        if (d2 > R2 || (cx === x && cz === z && y === fz - 1)) continue;
        out.push([cx, cz, y]);
    }
    return out;
}

const bandLeft = (m) => { let n = 0; for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) for (let y = 0; y < H; y++) if (m[x][z][y] === SOLID || m[x][z][y] === WATER) n++; return n; };

/** Dig counts of every column and depth, with walking distances: {f, ok, dist, nd[x][z][d], nw[x][z][d]}. */
function table(m, bot) {
    const { f, ok } = columns(m), dist = reach(f, ok, bot), nd = [], nw = [];
    for (let x = 0; x < N; x++) { nd.push([]); nw.push([]); for (let z = 0; z < N; z++) {
        nd[x].push([0, 0]); nw[x].push([0, 0]);
        for (let d = 1; d <= ND; d++) { let a = 0, b = 0; for (const [cx, cz, y] of digSet(m, x, z, f[x][z], d)) if (m[cx][cz][y] === SOLID) a++; else b++; nd[x][z][d - 1] = a; nw[x][z][d - 1] = b; }
    } }
    return { f, ok, dist, nd, nw };
}

/**
 * The K best stations by dig count minus distance, as the network sees them. s: {m, bot: [x, z], t (stations so far), lastN}.
 * Returns {feats: Float32Array(K * NF), mask: Uint8Array(K), idx: Int32Array(K) (flat = (x * N + z) * ND + depth - 1), glob: Float32Array(NG), cand: [{x, z, depth, n}]}.
 */
function observe(s) {
    const { m, bot } = s, tb = table(m, bot), { f, dist } = tb;
    const items = [];
    let nValid = 0, maxNd = 1, rawMax = 0;
    for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) for (let d = 0; d < ND; d++) {
        const n = tb.nd[x][z][d] + tb.nw[x][z][d]; if (n > maxNd) maxNd = n; if (n > rawMax) rawMax = n;
        if (n > 0 && dist[x * N + z] < INF / 2 && tb.ok[x][z]) { nValid++; items.push({ x, z, d, n, score: n - 0.35 * dist[x * N + z], flat: (x * N + z) * ND + d }); }
    }
    items.sort((a, b) => b.score - a.score || a.flat - b.flat);                 // lax.top_k: the larger score first, the smaller index on ties
    const left = bandLeft(m), fb = f[bot[0]][bot[1]];
    const feats = new Float32Array(K * NF), mask = new Uint8Array(K), idx = new Int32Array(K), cand = [];
    for (let k = 0; k < K; k++) {
        const it = items[k]; if (!it) { idx[k] = 0; continue; }
        mask[k] = 1; idx[k] = it.flat; cand.push({ x: it.x, z: it.z, depth: it.d + 1, n: it.n });
        const nw = tb.nw[it.x][it.z][it.d], fk = f[it.x][it.z], o = k * NF;
        const prev = it.d === 1 ? tb.nd[it.x][it.z][0] : 0;
        // the walk after the dig: columns the bot could still walk to from the station, and what is left
        const m2 = m.map((col) => col.map((c) => Int8Array.from(c)));
        for (const [cx, cz, y] of digSet(m, it.x, it.z, fk, it.d + 1)) m2[cx][cz][y] = AIR;
        const c2 = columns(m2), d2 = reach(c2.f, c2.ok, [it.x, it.z]);
        let reachAfter = 0; for (let i = 0; i < N * N; i++) if (d2[i] < INF / 2 && c2.ok[(i / N) | 0][i % N]) reachAfter++;                // the simulator subtracts the solid count of depth 1 only
        const v = [it.n / 48, nw / 8, Math.min(dist[it.x * N + it.z], 40) / 40, (fk - fb) / 3, it.n / maxNd, it.d, Math.min(it.x, N - 1 - it.x, it.z, N - 1 - it.z) / 8, left / 512,
            it.x === bot[0] && it.z === bot[1] ? 1 : 0, fk / 6, (it.x - 7.5) / 8, (it.z - 7.5) / 8, it.d === 1 ? (it.n - prev) / 24 : 0, 1, reachAfter / 256, reachAfter < 12 ? 1 : 0, bandLeft(m2) / 512];
        for (let i = 0; i < NF; i++) feats[o + i] = v[i];
    }
    const glob = Float32Array.from([left / 512, s.t / MAX_STATIONS, nValid / 512, fb / 6, (bot[0] - 7.5) / 8, (bot[1] - 7.5) / 8, (s.lastN || 0) / 48, rawMax / 48]);
    return { feats, mask, idx, glob, cand };
}

module.exports = { N, H, BAND, AIR, SOLID, ROCK, WATER, K, ND, NF, NG, MAX_STATIONS, INF, columns, reach, digSet, bandLeft, table, observe };

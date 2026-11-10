// The open-pit expert (src/experts/pit): the cell model and the features equal the simulator's (golden file from `python -m rl3.cli pit-golden`); the choice follows the network or the greedy order.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../src/experts/pit/model');
const P = require('../src/experts/pit/policy');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const grid = (b64) => {
    const buf = Buffer.from(b64, 'base64'), m = [];
    for (let x = 0; x < M.N; x++) { m.push([]); for (let z = 0; z < M.N; z++) { m[x].push(new Int8Array(M.H)); for (let y = 0; y < M.H; y++) m[x][z][y] = buf.readInt8((x * M.N + z) * M.H + y); } }
    return m;
};

(async () => {
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_pit.json'), 'utf8'));
    await test('the spec matches the trainer', () => { assert.deepStrictEqual([golden.n, golden.h, golden.k, golden.nf, golden.ng], [M.N, M.H, M.K, M.NF, M.NG]); });
    await test('observation: candidates, features, mask and context equal the simulator\'s in every golden chunk', () => {
        let worst = 0;
        for (const r of golden.rows) {
            const o = M.observe({ m: grid(r.m), bot: r.bot, t: r.t, lastN: r.lastN });
            assert.deepStrictEqual(Array.from(o.mask).map(Boolean), r.mask);
            for (let k = 0; k < M.K; k++) if (r.mask[k]) assert.strictEqual(o.idx[k], r.idx[k], `candidate ${k}`);
            for (let i = 0; i < o.feats.length; i++) { const k = Math.floor(i / M.NF); if (!r.mask[k]) continue; const d = Math.abs(o.feats[i] - r.feats[k][i % M.NF]); worst = Math.max(worst, d); assert.ok(d < 2e-5, `feature ${k}/${i % M.NF}: js ${o.feats[i]} sim ${r.feats[k][i % M.NF]}`); }
            for (let i = 0; i < M.NG; i++) assert.ok(Math.abs(o.glob[i] - r.glob[i]) < 2e-5, `glob ${i}`);
        }
        assert.ok(golden.rows.some((r) => r.mask.filter(Boolean).length > 10), 'chunks with many candidates');
    });
    await test('digSet: the sphere of reach, never the block under the feet, nothing deeper than the depth', () => {
        const m = []; for (let x = 0; x < M.N; x++) { m.push([]); for (let z = 0; z < M.N; z++) { m[x].push(new Int8Array(M.H)); for (let y = 0; y < 2; y++) m[x][z][y] = M.SOLID; } }
        const f = 2, one = M.digSet(m, 8, 8, f, 1), two = M.digSet(m, 8, 8, f, 2);
        assert.ok(one.every(([x, z, y]) => y >= 1) && two.some(([x, z, y]) => y === 0) && two.length > one.length);
        assert.ok(!one.some(([x, z, y]) => x === 8 && z === 8 && y === 1), 'the floor under the bot stays');
        assert.ok(one.every(([x, z, y]) => (x - 8) ** 2 + (z - 8) ** 2 + (y - f - 1.12) ** 2 <= 4.05 ** 2 + 1e-9));
    });
    await test('reach: step up 1, drop up to 3, water and walls stop the walk', () => {
        const m = []; for (let x = 0; x < M.N; x++) { m.push([]); for (let z = 0; z < M.N; z++) { m[x].push(new Int8Array(M.H)); m[x][z][0] = M.SOLID; } }
        m[5][0][1] = M.SOLID; m[5][0][2] = M.SOLID;                  // a wall two high at x 5, z 0 (step up 2)
        for (let z = 0; z < M.N; z++) { m[6][z][0] = M.WATER; }       // a stripe of water across x 6
        const { f, ok } = M.columns(m), d = M.reach(f, ok, [0, 0]);
        assert.strictEqual(d[3 * M.N + 0], 3); assert.ok(d[5 * M.N + 0] >= M.INF / 2, 'a wall of height two cannot be climbed'); assert.ok(d[5 * M.N + 1] < 100);
        assert.ok(d[7 * M.N + 3] >= M.INF / 2, 'water is not walked');
    });
    await test('policy: the greedy order without a model; a network ranks candidates by its score and respects the ban', () => {
        const row = golden.rows.find((r) => r.mask.filter(Boolean).length > 10), o = M.observe({ m: grid(row.m), bot: row.bot, t: 0, lastN: 0 });
        assert.strictEqual(P.choose(null, o), 0); assert.strictEqual(P.choose(null, o, new Set([0, 1])), 2);
        const H = 4, z = (n) => new Float32Array(n), net = { hid: H, w1: z((M.NF + M.NG) * H), b1: z(H), w2: z(H * H), b2: Float32Array.from([1, 1, 1, 1]), ws: Float32Array.from([1, 0, 0, 0]), bs: z(1), meta: {} };
        for (let u = 0; u < H; u++) net.w1[0 * H + u] = u === 0 ? -5 : 0;     // feature 0 (cells to dig) is bad: the candidate with the fewest cells wins
        for (let u = 0; u < H; u++) net.w2[u * H + u] = 1;
        const best = P.choose(net, o), fewest = Array.from(o.mask).map((m, k) => (m ? [o.feats[k * M.NF], k] : null)).filter(Boolean).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0][1];
        assert.strictEqual(best, fewest); assert.strictEqual(P.choose(net, { ...o, mask: new Uint8Array(M.K) }), -1);
        assert.throws(() => P.load({ kind: 'pit', nf: 3, ng: 3, k: 3 }), /file is for/);
    });
    await test('policy: the shipped file (models/experts/pit.json) gives the logits the trainer computed for the same candidates', () => {
        const net = P.defaultModel(), chk = JSON.parse(fs.readFileSync(path.join(__dirname, 'pit_check.json'), 'utf8'));
        assert.ok(net, 'the shipped pit policy loads');
        const rows = golden.rows.filter((r) => r.mask.filter(Boolean).length > 10).slice(0, chk.length);
        rows.forEach((r, i) => {
            const sc = P.scores(net, Float32Array.from(r.feats.flat()), Float32Array.from(r.glob));
            for (let k = 0; k < M.K; k++) if (r.mask[k]) assert.ok(Math.abs(sc[k] - chk[i][k]) < 2e-3, `row ${i} candidate ${k}: js ${sc[k]} trainer ${chk[i][k]}`);
        });
    });
    console.log('\npit expert: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

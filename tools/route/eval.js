'use strict';
// Compare routing policies on held-out episodes: node tools/route/eval.js [--n 70] [--threads 3] [--base 1000000] [--model models/experts/route.json]
const fs = require('fs');
const Pool = require('./pool');
const { episode } = require('./episode');
const P = require('../../src/experts/route/policy');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };

function summarize(rows) {
    const n = rows.length, sum = (f) => rows.reduce((a, r) => a + f(r), 0), by = {};
    for (const r of rows) { const b = (by[r.kind] = by[r.kind] || { n: 0, ok: 0 }); b.n++; b.ok += r.ok ? 1 : 0; }
    const calls = sum((r) => r.calls), ok = rows.filter((r) => r.ok), ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    return { n, success: sum((r) => (r.ok ? 1 : 0)) / n, moveFailRate: calls ? sum((r) => r.fail) / calls : 0, failsPerEp: sum((r) => r.fail) / n, blocksOk: ok.length ? ok.reduce((a, r) => a + r.blocks, 0) / ok.length : NaN, expandedPerEp: sum((r) => r.expanded) / n, decisions: sum((r) => r.decisions) / n, msP50: ms[n >> 1], msP95: ms[Math.floor(n * 0.95)], ret: sum((r) => r.ret) / n, by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, `${v.ok}/${v.n}`])) };
}
async function evaluate(pool, spec, n, base) {
    const eps = Array.from({ length: n }, (_, i) => episode(base, i)), chunks = [];
    for (let i = 0; i < eps.length; i += 5) chunks.push({ spec, eps: eps.slice(i, i + 5) });
    return (await pool.run(chunks)).flat();
}
module.exports = { evaluate, summarize };

if (require.main === module) (async () => {
    const n = +arg('n', 70), base = +arg('base', 1000000), pool = new Pool(+arg('threads', 3)), file = arg('model', null);
    const specs = { legacy: { type: 'legacy' }, heuristic: { type: 'vec', vec: Array.from(P.heuristicVector()) } };
    if (file && fs.existsSync(file)) specs.rl = { type: 'vec', vec: Array.from(P.toVector(P.load(JSON.parse(fs.readFileSync(file, 'utf8'))))) };
    const out = {};
    for (const [k, s] of Object.entries(specs)) { const t = Date.now(); out[k] = summarize(await evaluate(pool, s, n, base)); out[k].wallS = Math.round((Date.now() - t) / 1000); }
    console.log(JSON.stringify(out, null, 1));
    await pool.close();
})();

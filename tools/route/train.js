'use strict';
// Trains the chunk-exit routing policy by evolution strategies on the simulator's return (antithetic sampling, centred ranks, Adam), starting from the heuristic.
// Reinforcement learning without gradients through the environment: the policy is run as it is run live (greedy over the scored candidates), the simulator's own return is the objective
// (arrival, walked blocks, failed moves, planner work). Usage: node tools/route/train.js --out DIR [--gens 150] [--pop 24] [--eps 28] [--sigma 0.15] [--lr 0.03] [--threads 3] [--resume]
const fs = require('fs');
const path = require('path');
const Pool = require('./pool');
const { evaluate, summarize } = require('./eval');
const { rng } = require('./sim');
const { episode } = require('./episode');
const P = require('../../src/experts/route/policy');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const gens = +arg('gens', 150), pop = +arg('pop', 24), nEps = +arg('eps', 28), sigma = +arg('sigma', 0.15), lr = +arg('lr', 0.03), threads = +arg('threads', 3), out = arg('out', '/out');
const LINEAR = process.argv.includes('--linear');          // evolve only the linear term (30 numbers): the hidden layer stays zero
const VAL_BASE = 1000000, VAL_N = 70, DECAY = 0.002;
const ranks = (xs) => { const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(xs.length); idx.forEach(([, i], k) => { r[i] = k / (xs.length - 1) - 0.5; }); return r; };
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

(async () => {
    fs.mkdirSync(out, { recursive: true });
    const ck = path.join(out, 'ckpt.json'), log = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); fs.appendFileSync(path.join(out, 'train.log'), l + '\n'); };
    let theta = P.heuristicVector(), g0 = 0, best = { ret: -Infinity, vec: null, gen: -1, summary: null }, adam = { m: new Float64Array(theta.length), v: new Float64Array(theta.length), t: 0 };
    const seed0 = rng(12345); if (!LINEAR) for (let i = 0; i < theta.length; i++) if (i >= P.DIN && i < P.DIN + P.DIN * P.HIDDEN) theta[i] = 0.05 * gauss(seed0);        // a little structure in the hidden layer
    if (process.argv.includes('--resume') && fs.existsSync(ck)) { const c = JSON.parse(fs.readFileSync(ck, 'utf8')); theta = Float64Array.from(c.theta); g0 = c.gen + 1; best = c.best; adam = { m: Float64Array.from(c.adam.m), v: Float64Array.from(c.adam.v), t: c.adam.t }; if (process.argv.includes('--reset-best')) { best = { ret: -Infinity, vec: null, gen: -1, summary: null }; adam = { m: new Float64Array(theta.length), v: new Float64Array(theta.length), t: 0 }; }
        log(`resumed at generation ${g0}${process.argv.includes('--reset-best') ? ' (best and Adam reset: the episode set changed)' : ''}`); }
    const pool = new Pool(threads), vec = (v) => ({ type: 'vec', vec: Array.from(v) });
    log(`params ${theta.length}, pop ${pop}, episodes ${nEps}, sigma ${sigma}, lr ${lr}, threads ${threads}`);
    const hb = summarize(await evaluate(pool, vec(P.heuristicVector()), VAL_N, VAL_BASE)); log(`validation, heuristic: success ${hb.success.toFixed(3)} ret ${hb.ret.toFixed(1)} failRate ${hb.moveFailRate.toFixed(3)}`);
    for (let g = g0; g < gens; g++) {
        const r = rng(1000 + g), eps = Array.from({ length: nEps }, (_, i) => episode((g * 104729) % 900000, i)), pairs = pop / 2, noise = [], jobs = [];
        for (let p = 0; p < pairs; p++) {
            const e = Float64Array.from({ length: theta.length }, (_, i) => { const x = gauss(r); return LINEAR && i >= P.DIN ? 0 : x; }); noise.push(e);
            for (const s of [1, -1]) { const th = theta.map((x, i) => x + s * sigma * e[i]); for (let i = 0; i < eps.length; i += 7) jobs.push({ spec: vec(th), eps: eps.slice(i, i + 7) }); }
        }
        const per = Math.ceil(eps.length / 7), res = await pool.run(jobs), F = [];
        for (let m = 0; m < pairs * 2; m++) { const rows = res.slice(m * per, (m + 1) * per).flat(); F.push(rows.reduce((a, x) => a + x.ret, 0) / rows.length); }
        const plus = ranks(F), grad = new Float64Array(theta.length);
        for (let p = 0; p < pairs; p++) { const d = plus[2 * p] - plus[2 * p + 1]; for (let i = 0; i < grad.length; i++) grad[i] += d * noise[p][i]; }
        adam.t++;
        for (let i = 0; i < grad.length; i++) {
            const gi = grad[i] / (pairs * sigma) - DECAY * (theta[i] - 0);
            adam.m[i] = 0.9 * adam.m[i] + 0.1 * gi; adam.v[i] = 0.999 * adam.v[i] + 0.001 * gi * gi;
            theta[i] += lr * (adam.m[i] / (1 - 0.9 ** adam.t)) / (Math.sqrt(adam.v[i] / (1 - 0.999 ** adam.t)) + 1e-8);
        }
        const mean = F.reduce((a, b) => a + b, 0) / F.length;
        if (g % 5 === 4 || g === gens - 1) {
            const sm = summarize(await evaluate(pool, vec(theta), VAL_N, VAL_BASE));
            if (sm.ret > best.ret) best = { ret: sm.ret, vec: Array.from(theta), gen: g, summary: sm };
            log(`gen ${g} pop mean ${mean.toFixed(1)} | validation: success ${sm.success.toFixed(3)} ret ${sm.ret.toFixed(1)} failRate ${sm.moveFailRate.toFixed(3)} blocks ${sm.blocksOk.toFixed(0)} | best gen ${best.gen} ret ${best.ret.toFixed(1)}`);
            fs.writeFileSync(ck + '.tmp', JSON.stringify({ theta: Array.from(theta), gen: g, best, adam: { m: Array.from(adam.m), v: Array.from(adam.v), t: adam.t } })); fs.renameSync(ck + '.tmp', ck);
            fs.writeFileSync(path.join(out, 'route.json'), JSON.stringify(P.toDoc(P.fromVector(Float64Array.from(best.vec)), { generation: best.gen, validation: best.summary, trainer: 'evolution strategies (tools/route/train.js)', trained: new Date().toISOString() })));
        } else log(`gen ${g} pop mean ${mean.toFixed(1)}`);
    }
    await pool.close();
    log('done');
})();

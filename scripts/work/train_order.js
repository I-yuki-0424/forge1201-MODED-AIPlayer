'use strict';
// Trainer of the ORDER EXPERT (TASK-20261121-071, src/work/builder/policy.js). Test / training code (not production): an evolution strategy over the weights of the linear score that picks the next cell,
// scored by the cost model (src/work/builder/costsim.js: bot time in tenths of a second + temporary blocks) on three blueprints; the fitness of a weight vector is the mean of (cost / the cost of the
// fixed rule) over them, so 1.0 is the planner as it is and lower is better. Run on spare CPU (nice, a few workers):
//   node scripts/work/train_order.js [--gens 30] [--pop 12] [--workers 3] [--out models/experts/build_order.json] [--seed 1]
// Validation on blueprints the search never saw (the whole iron farm, 6 areas): scripts/work/eval_order.js.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '../..');

const SETS = [
    { name: 'nether-side', file: 'iron-farm-34-nether-side-main.litematic' },
    { name: 'golem-trap', file: 'easy-ironfarm-fixd.litematic' },
    { name: 'farm-floor', file: 'iron-farm-34.litematic', maxY: 13 },                    // the lowest floor of the Overworld farm (y 0..13 of the blueprint)
];
const TEMP_COST = 15;                                                                    // one more temporary block counts as 1.5 s: placed, used, mined (the time model already holds most of it)

function load(set) {
    const lit = require(path.join(ROOT, 'src/work/jobs/litematic')), bpm = require(path.join(ROOT, 'src/work/jobs/blueprint'));
    const placed = lit.place(lit.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures', set.file))), { pos: { x: 22, y: 201, z: 20 } }, { keepAir: false });
    let cells = bpm.cells(placed.bp); const o = placed.origin;
    if (set.maxY !== undefined) cells = cells.filter((c) => c.y <= set.maxY);            // (cells are relative to the box; the origin is the world cell of the box's (0,0,0))
    return { cells, origin: o };
}

function cost(weights, set, zones = 1) {
    const P = require(path.join(ROOT, 'src/work/builder/plan')), CS = require(path.join(ROOT, 'src/work/builder/costsim'));
    const d = load(set), plan = P.planBuild(d.cells, d.origin, { zones, weights }), r = CS.simulate(plan);
    return { cost: r.span + TEMP_COST * r.temps, span: r.span, temps: r.temps, failed: r.failed, placed: r.placed, seeds: r.seeds, stations: r.stations };
}

if (!isMainThread) {
    parentPort.on('message', (m) => {
        const out = SETS.map((s) => { try { return cost(m.weights, s); } catch (e) { return { cost: Infinity, error: e.message }; } });
        parentPort.postMessage({ id: m.id, out });
    });
    return;
}

(async () => {
    const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
    const gens = Number(arg('gens', 30)), pop = Number(arg('pop', 12)), nw = Number(arg('workers', 3)), outFile = path.resolve(arg('out', path.join(ROOT, 'models/experts/build_order.json')));
    let seed = Number(arg('seed', 1)); const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }, gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const POLICY = require(path.join(ROOT, 'src/work/builder/policy'));
    const workers = Array.from({ length: nw }, () => new Worker(__filename)), idle = [...workers], queue = [], results = new Map();
    let ids = 0;
    const evalMany = (list) => new Promise((resolve) => {
        const want = list.length, got = new Map();
        const pump = () => {
            while (idle.length && queue.length) {
                const w = idle.pop(), job = queue.shift();
                w.once('message', (m) => { got.set(job.i, m.out); idle.push(w); if (got.size === want) resolve(list.map((_, i) => got.get(i))); else pump(); });
                w.postMessage({ id: ++ids, weights: job.w });
            }
        };
        list.forEach((w, i) => queue.push({ i, w })); pump();
    });
    const base = (await evalMany([POLICY.DEFAULT]))[0];
    console.log('baseline (the planner as it is):', base.map((b, i) => `${SETS[i].name} cost ${Math.round(b.cost)} span ${Math.round(b.span)} temps ${b.temps} seeds ${b.seeds} failed ${b.failed}`).join(' | '));
    const fit = (out) => (out.some((o) => !Number.isFinite(o.cost) || o.failed > 0) ? 10 : out.reduce((a, o, i) => a + o.cost / base[i].cost, 0) / out.length);
    let mean = POLICY.DEFAULT.slice(), sigma = [3, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.5], best = { w: mean.slice(), f: 1, out: base }, t0 = Date.now();
    for (let g = 0; g < gens; g++) {
        const cand = [];
        for (let k = 0; k < pop / 2; k++) { const z = sigma.map(() => gauss()); cand.push(mean.map((m, i) => m + sigma[i] * z[i]), mean.map((m, i) => m - sigma[i] * z[i])); }     // antithetic pairs
        const outs = await evalMany(cand), fs_ = outs.map(fit), order = fs_.map((f, i) => i).sort((a, b) => fs_[a] - fs_[b]), mu = Math.max(2, Math.floor(pop / 3));
        const top = order.slice(0, mu); mean = mean.map((_, i) => top.reduce((a, j) => a + cand[j][i], 0) / mu);
        if (fs_[order[0]] < best.f) best = { w: cand[order[0]].slice(), f: fs_[order[0]], out: outs[order[0]] };
        sigma = sigma.map((s, i) => Math.max(0.05, s * (0.93 + 0.1 * (Math.sqrt(top.reduce((a, j) => a + (cand[j][i] - mean[i]) ** 2, 0) / mu) / Math.max(s, 1e-6))))) ;
        console.log(`gen ${g + 1}/${gens} ${Math.round((Date.now() - t0) / 1000)}s: best of generation ${fs_[order[0]].toFixed(3)} median ${fs_[order[pop >> 1]].toFixed(3)} | best so far ${best.f.toFixed(3)} [${best.w.map((v) => v.toFixed(2)).join(', ')}]`);
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify({ model: 'build-order-v1', names: POLICY.NAMES, weights: best.w.map((v) => Math.round(v * 1000) / 1000), fitness: best.f, baseline: base.map((b, i) => ({ set: SETS[i].name, cost: Math.round(b.cost), temps: b.temps, span: Math.round(b.span) })), best: best.out.map((b, i) => ({ set: SETS[i].name, cost: Math.round(b.cost), temps: b.temps, span: Math.round(b.span) })), generations: g + 1, trained: new Date().toISOString() }, null, 1));
    }
    console.log('done: fitness', best.f.toFixed(3), 'weights', JSON.stringify(best.w.map((v) => Math.round(v * 1000) / 1000)), '->', outFile);
    for (const w of workers) w.terminate();
})();

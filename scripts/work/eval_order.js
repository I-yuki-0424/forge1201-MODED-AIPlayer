'use strict';
// Validation of the order expert on a blueprint the search never saw: the cost model (costsim.js) with the fixed rule and with the weights of a model file.
//   node scripts/work/eval_order.js FILE [ZONES=6] [MODEL=models/experts/build_order.json]
const fs = require('fs'), path = require('path');
const lit = require('../../src/work/jobs/litematic'), bpm = require('../../src/work/jobs/blueprint'), P = require('../../src/work/builder/plan'), CS = require('../../src/work/builder/costsim'), POLICY = require('../../src/work/builder/policy');
const file = process.argv[2], zones = Number(process.argv[3] || 6), model = JSON.parse(fs.readFileSync(path.resolve(process.argv[4] || path.join(__dirname, '../../models/experts/build_order.json')), 'utf8'));
const placed = lit.place(lit.parse(fs.readFileSync(file)), { pos: { x: 22, y: 201, z: 20 } }, { keepAir: false }), cells = bpm.cells(placed.bp);
for (const [name, w] of [['fixed rule', POLICY.DEFAULT], ['expert', model.weights]]) {
    const plan = P.planBuild(cells, placed.origin, { zones, weights: w }), r = CS.simulate(plan);
    console.log(`${name}: span ${Math.round(r.span)} (${(r.span / 600).toFixed(1)} min of the slowest bot) total ${Math.round(r.time)} temps ${r.temps} seeds ${r.seeds} stations ${r.stations} failed ${r.failed}`);
}

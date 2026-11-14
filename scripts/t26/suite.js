'use strict';
// Grade a T26 run: every /out/<RUN>/<test>-w<N>.json added up. The owner's scale (2026-11-14): 80 % or below = failure, 90 % = WIP, 100 % = success; each test has its required rate.
const fs = require('fs'), path = require('path');
const REQUIRED = { move_a: 1, move_b: 0.8, mine_a: 0.9, mine_b: 1, place_a: 1, place_b: 1 };
const [dir, test] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${test}-w`) && f.endsWith('.json') && !/-noop/.test(f));
const trials = [], worlds = [];
for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); worlds.push({ world: d.world, seed: d.seed, passed: d.passed, of: d.trials.length }); for (const t of d.trials) trials.push({ world: d.world, ...t }); }
const k = trials.filter((t) => t.ok).length, n = trials.length, rate = n ? k / n : 0, need = REQUIRED[test] ?? 1;
const scale = rate >= 1 ? 'success' : rate >= 0.9 ? 'WIP' : 'failure';
console.log(`${test}: ${k}/${n} trials on ${worlds.length} worlds = ${(100 * rate).toFixed(0)} % -> ${scale}; required ${(100 * need).toFixed(0)} %: ${n && rate >= need && worlds.length >= 3 ? 'PASSED' : 'NOT PASSED'}${worlds.length < 3 ? ' (fewer than 3 worlds: not evidence)' : ''}`);
for (const w of worlds.sort((a, b) => a.world - b.world)) console.log(`  world ${w.world} ${w.seed}: ${w.passed}/${w.of}`);
for (const t of trials.filter((x) => !x.ok)) console.log(`  FAIL w${t.world} ${t.bot}: ${JSON.stringify(t.detail).slice(0, 400)}`);

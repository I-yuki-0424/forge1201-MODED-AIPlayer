'use strict';
// The CI history (scripts/ci/history.js, TASK-20261125-080): a run's record from its files, and the change against the baseline both ways (worse AND better), on a temporary folder.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { record, change } = require('../scripts/ci/history');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-hist-')), ci = path.join(root, 'ci');
function run(id, label, tests) {
    const d = path.join(root, `ci-${id}`); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run.env'), `id=${id}\nsha=${'a'.repeat(40)}\nref=origin/main\nlabel=${label}\nprofile=fabric-1.21.1\nstarted=1\nsubject=s ${id}\nended=2\n`);
    fs.writeFileSync(path.join(d, 'tests.txt'), tests.map((t) => t.line).join('\n') + '\n');
    for (const t of tests) if (t.trials) {
        const k = path.join(root, `ci-${id}-${t.kind || 'fixed'}`); fs.mkdirSync(k, { recursive: true });
        fs.writeFileSync(path.join(k, `${t.name}-w9.json`), JSON.stringify({ test: t.name, seed: 'Seed: [5]', sec: t.sec, trials: t.trials }));
    }
    return execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts/ci/history.js'), d, ci], { encoding: 'utf8' });
}
const T = (ok) => ({ bot: 'b', ok, detail: { x: 1 } });

// 1. the first run: no baseline; a test with no JSON is no_result, a skipped one is skipped
let out = run('r1', '', [
    { line: 'ran move_a fixed 5 100 0 1', name: 'move_a', sec: 300, trials: [T(true), T(true), T(false), T(true)] },
    { line: 'ran place_a fixed 5 60 0 4', name: 'place_a', sec: 40, trials: [T(true), T(true)] },
    { line: 'ran tags fixed 5 60 124 1' },
    { line: 'skip mine_b fixed 5 reboot-window' },
]);
assert.match(out, /first run/);
let r1 = JSON.parse(fs.readFileSync(path.join(ci, 'runs', 'r1.json'), 'utf8'));
assert.deepStrictEqual(r1.tests.map((t) => t.verdict), ['fail', 'pass', 'no_result', 'skipped']);
assert.strictEqual(r1.tests[0].rate, 0.75);

// 2. the next run: move_a better (4/4), place_a slower (worse time), tags now passes (better), seen both ways
out = run('r2', '', [
    { line: 'ran move_a fixed 5 100 0 1', name: 'move_a', sec: 280, trials: [T(true), T(true), T(true), T(true)] },
    { line: 'ran place_a fixed 5 60 0 4', name: 'place_a', sec: 120, trials: [T(true), T(true)] },
    { line: 'ran tags fixed 5 60 0 1', name: 'tags', sec: 20, trials: [T(true), T(true)] },
]);
const r2 = JSON.parse(fs.readFileSync(path.join(ci, 'runs', 'r2.json'), 'utf8'));
assert.strictEqual(r2.baseline, 'r1');
assert.deepStrictEqual(r2.better.sort(), ['move_a/fixed', 'tags/fixed']);
assert.deepStrictEqual(r2.worse, ['place_a/fixed']);
assert.strictEqual(r2.tests[1].change.time, 'worse');
assert.match(out, /worse: place_a\/fixed \| better: /);

// 3. a labelled run (the negative control) is compared with main's last run but never becomes the baseline
run('neg', 'negative', [{ line: 'ran place_a fixed 5 60 0 4', name: 'place_a', sec: 40, trials: [T(false), T(false)] }]);
const neg = JSON.parse(fs.readFileSync(path.join(ci, 'runs', 'neg.json'), 'utf8'));
assert.deepStrictEqual(neg.worse, ['place_a/fixed']);
run('r3', '', [{ line: 'ran place_a fixed 5 60 0 4', name: 'place_a', sec: 118, trials: [T(true), T(true)] }]);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ci, 'runs', 'r3.json'), 'utf8')).baseline, 'r2');
assert.strictEqual(fs.readFileSync(path.join(ci, 'history.jsonl'), 'utf8').trim().split('\n').length, 4);

// 4. change(): a failing build with fewer wrong cells is better, with more worse; a random seed says so; no baseline -> null
const fb = (w) => ({ verdict: 'fail', rate: 0, kind: 'fixed', seed: '1', wrong: w, run: 'x' });
assert.strictEqual(change(fb(400), fb(571)).rate, 'better');
assert.strictEqual(change(fb(700), fb(571)).rate, 'worse');
assert.strictEqual(change(fb(575), fb(571)).rate, 'same');
assert.strictEqual(change({ verdict: 'pass', rate: 1, kind: 'fixed', seed: '1' }, null), null);
assert.strictEqual(change({ verdict: 'pass', rate: 1, kind: 'random', seed: '1', sec: 10 }, { verdict: 'pass', rate: 1, kind: 'random', seed: '2', sec: 10, run: 'x' }).sameSeed, false);
assert.ok(record);
fs.rmSync(root, { recursive: true, force: true });
console.log('test_ci_history_pure: ok');

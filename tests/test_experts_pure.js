// The JavaScript port of the trained skill experts (src/experts, docs/implemented/EXPERTS-v1.md) against the Python it was exported from: recorded simulator observations,
// the context vector, the candidate rows, the mask and the policy's scores must agree. Pure test, no server.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const features = require('../src/experts/features');
const policy = require('../src/experts/policy');

const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const model = (n) => policy.load(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'models', 'experts', `${n}.json`), 'utf8')));
const golden = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'experts', `golden-${n}.json`), 'utf8'));
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

for (const name of ['move', 'unstick']) {
    test(`${name}: context, candidates, mask and scores equal the Python ones on recorded observations`, () => {
        const g = golden(name), m = model(name);
        assert.strictEqual(m.doc.anon, g.anon); assert.deepStrictEqual(m.doc.rel, g.rel); assert.deepStrictEqual(m.doc.actions, g.actions);
        assert.ok(g.rows.length >= 10, 'enough recorded observations');
        let worst = { ctx: 0, cand: 0, logit: 0, value: 0 }, flat = 0;
        for (const r of g.rows) {
            const ctx = features.ctx(r.obs, g.vocab, g.rel, g.anon), { cand, mask } = features.cands(r.obs, g.vocab, g.rel, g.anon, g.actions);
            assert.strictEqual(ctx.length, m.ctxDim);
            assert.deepStrictEqual(mask, r.mask, 'the mask');
            worst.ctx = Math.max(worst.ctx, maxDiff(ctx, r.ctx));
            worst.cand = Math.max(worst.cand, maxDiff(cand, r.cand.flat()));
            const { logits, value } = policy.forward(m, ctx, cand, mask);
            const lg = Array.from(logits, (v, k) => (mask[k] ? v : 0));
            worst.logit = Math.max(worst.logit, maxDiff(lg, r.logits));
            worst.value = Math.max(worst.value, Math.abs(value - r.value));
            assert.strictEqual(policy.choose(logits, mask), r.action, 'the greedy action');
            if (r.obs.scan && r.obs.scan.some((x) => x !== 0)) flat++;
        }
        console.log(`   ${g.rows.length} observations, ${flat} with a scan; worst differences ctx ${worst.ctx.toExponential(1)} cand ${worst.cand.toExponential(1)} logit ${worst.logit.toExponential(1)} value ${worst.value.toExponential(1)}`);
        assert.ok(worst.ctx < 1e-4 && worst.cand < 1e-4 && worst.logit < 1e-3 && worst.value < 1e-3, JSON.stringify(worst));
        assert.ok(flat > 0, 'the recordings contain scans');
    });
}

test('masked candidates never win and sampling stays inside the mask', () => {
    const logits = Float64Array.from([0.1, 5, -2, 3]), mask = [true, false, true, true];
    assert.strictEqual(policy.choose(logits, mask), 3);
    const seen = new Set(); for (let i = 0; i < 400; i++) seen.add(policy.choose(logits, mask, { sample: true, rnd: () => (i + 0.5) / 400 }));
    assert.ok(!seen.has(1) && seen.has(3) && seen.has(0), [...seen].join());
    assert.strictEqual(policy.choose(logits, [false, false, false, false]), -1);
});

// ---- the runner: budget, cancel, stall handling, fatal reasons (a fake space and a stand-in for the network)
const runner = require('../src/experts/runner');
function fakeRun({ moveOk = () => true, decideSample = null, ...o } = {}) {
    let pos = { x: 0, y: 64, z: 0 }; const target = { x: 30, y: 64, z: 0 }, log = [];
    const space = { setTarget() {}, remember() {}, observe: () => ({}), cands: [{ cmd: 'move_to', args: { x: 1, y: 64, z: 0 } }, { cmd: 'wait', args: { ticks: 1 } }] };
    const ex = { model: { doc: { reach: 3, max_steps: 60, rel: [3], anon: true, actions: null } } };
    const exec = async (name, args) => { log.push(name); if (!moveOk(log.length)) return { ok: false, reason: 'unreachable', ticks: 1 }; pos = { x: Math.min(pos.x + 5, target.x), y: 64, z: 0 }; return { ok: true, ticks: 5 }; };
    return runner.run(ex, target, { space, exec, here: () => pos, decide: (_, s) => { if (s && decideSample) decideSample(); return 0; }, ...o });
}
test('the runner walks until the target is within reach', async () => {
    const r = await fakeRun(); assert.ok(r.ok && r.dist <= 3 && r.steps === 6, JSON.stringify(r));
});
test('a bot that makes no progress is sampled once, then given up as stuck', async () => {
    let drawn = 0;
    const r = await fakeRun({ moveOk: () => false, decideSample: () => drawn++ });
    assert.ok(!r.ok && r.reason === 'stuck' && r.sampled === runner.PATIENCE && drawn === runner.PATIENCE, JSON.stringify(r));
});
test('cancel, a fatal reason and the step budget end the run with their reason', async () => {
    assert.strictEqual((await fakeRun({ cancel: { cancelled: true } })).reason, 'cancelled');
    const dead = await fakeRun({ exec: async () => ({ ok: false, reason: 'died', ticks: 1 }) });
    assert.strictEqual(dead.reason, 'died');
    const slow = await fakeRun({ maxSteps: 3 }); assert.ok(!slow.ok && slow.reason === 'timeout' && slow.steps === 3, JSON.stringify(slow));
});

(async () => { for (const [name, fn] of queue) { console.log(`--- test: ${name} ---`); await fn(); console.log('[OK]'); } })().catch((e) => { console.error(e); process.exit(1); });

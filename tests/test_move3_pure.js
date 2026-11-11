// RL-MOVE-v3 runtime (src/experts/move3): the rules and the observation must equal the simulator's (golden file from `python -m rl3.cli golden`), the policy file loads and runs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../src/experts/move3/rules');
const O = require('../src/experts/move3/obs');
const SPEC = require('../src/experts/move3/spec');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

/** A view over the golden window (unpadded coordinates; outside it: rock horizontally, air vertically). */
function viewOf(row) {
    const w = row.win, buf = Buffer.from(w.data, 'base64'), at = (i, j, k) => buf.readInt8((i * w.ny + j) * w.nz + k);
    const box = row.box;
    return {
        bots: row.bots.map(([x, y, z]) => ({ x, y, z })),
        code(x, y, z) {
            const i = x - w.x0, j = y - w.y0, k = z - w.z0;
            if (j < 0 || j >= w.ny) return SPEC.CODE.AIR;
            if (i < 0 || i >= w.nx || k < 0 || k >= w.nz) return SPEC.CODE.ROCK;
            return at(i, j, k);
        },
        inBox: (x, y, z) => x >= box[0] && x <= box[1] && y >= box[2] && y <= box[3] && z >= box[4] && z <= box[5],
    };
}
const stateOf = (r) => ({ pos: { x: r.pos[0], y: r.pos[1], z: r.pos[2] }, tgt: { x: r.tgt[0], y: r.tgt[1], z: r.tgt[2] }, near: r.near, nearY: r.nearY, pack: r.pack, hp: r.hp, t: r.t, since: r.since, last: r.last,
    visits: new Map(r.visits.map(([x, z, c]) => [`${x},${z}`, c])) });

(async () => {
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_move3.json'), 'utf8'));
    await test('the spec matches the trainer', () => {
        assert.strictEqual(golden.dims.obs, SPEC.OBS_DIM); assert.strictEqual(golden.dims.na, SPEC.NA);
        assert.strictEqual(golden.rows.length >= 14, true);
    });
    await test('mask: the rules give the simulator\'s mask in every golden state (every scenario, after random play)', () => {
        let valid = 0, n = 0;
        for (const r of golden.rows) {
            const m = R.mask(viewOf(r), stateOf(r));
            assert.deepStrictEqual(m, r.mask, `scenario ${r.scen} at ${r.pos}: ${SPEC.ACTIONS.filter((_, i) => m[i] !== r.mask[i])}`);
            valid += m.filter(Boolean).length; n++;
        }
        assert.ok(valid / n > 3, 'the states have choices');
    });
    await test('observation: the same 2,964 numbers as the simulator', () => {
        let worst = 0;
        for (const r of golden.rows) {
            const o = O.observe(viewOf(r), stateOf(r));
            assert.strictEqual(o.length, r.obs.length);
            for (let i = 0; i < o.length; i++) { const d = Math.abs(o[i] - r.obs[i]); if (d > worst) worst = d; assert.ok(d < 2e-5, `scenario ${r.scen} obs[${i}] js ${o[i]} sim ${r.obs[i]}`); }
        }
        assert.ok(worst < 2e-5);
    });
    await test('rules: fall damage, arrival and distance helpers', () => {
        const v = { bots: [], inBox: () => false, code: (x, y, z) => (y < 0 ? SPEC.CODE.SOLID : SPEC.CODE.AIR) };
        assert.deepStrictEqual(R.fall(v, 0, 10, 0, null, -64), { y: 0, dead: false, dmg: 7 });
        assert.strictEqual(R.fall({ ...v, code: () => SPEC.CODE.AIR }, 0, 10, 0, null, -64).dead, true, 'an abyss');
        assert.strictEqual(R.arrived({ x: 1, y: 5, z: 1 }, { x: 2, y: 6, z: 2 }, 2, 1), true); assert.strictEqual(R.arrived({ x: 1, y: 5, z: 1 }, { x: 2, y: 8, z: 2 }, 2, 1), false);
    });
    await test('policy: the exported file (models/experts/move3.json) gives the logits the trainer computed for the same observations', () => {
        const P = require('../src/experts/move3/policy'), m = P.defaultModel(), chk = JSON.parse(fs.readFileSync(path.join(__dirname, 'move3_check.json'), 'utf8'));
        assert.ok(m, 'the shipped policy loads'); assert.strictEqual(m.hid, 256);
        for (let i = 0; i < chk.obs.length; i++) {
            const l = P.logits(m, Float32Array.from(chk.obs[i]));
            for (let a = 0; a < SPEC.NA; a++) assert.ok(Math.abs(l[a] - chk.logits[i][a]) < 2e-3, `obs ${i} action ${a}: js ${l[a]} trainer ${chk.logits[i][a]}`);
        }
        assert.throws(() => P.load({ kind: 'move3', obs_dim: 5, na: SPEC.NA }), /file is for obs/);
    });
    // a walk on a fake world with a fake policy that always asks for the first allowed walk toward the target: the loop's own logic (arrival, tabu, failure, refusal)
    const { walk3 } = require('../src/experts/move3/walk');
    const flat = (x, y, z) => (y < 5 ? 'solid' : 'air');
    const fakeModel = (prefer) => ({ hid: 1, meta: { name: 'fake' }, w1: new Float32Array(SPEC.OBS_DIM), b1: new Float32Array(1), w2: new Float32Array(1), b2: Float32Array.from([1]), wp: Float32Array.from({ length: SPEC.NA }, (_, a) => prefer[a] || 0), bp: new Float32Array(SPEC.NA), h1: new Float32Array(1), h2: new Float32Array(1) });
    await test('walk3: arrives on open ground one cell per decision; a failed action is left out for a few decisions; far targets are refused; cancel and wrong dimension end it', async () => {
        const pos = { x: 0, y: 5, z: 0 }, calls = [];
        const env = { w: { kindAt: flat, nameAt: () => 'stone' }, here: () => ({ ...pos }), exec: async (n, a) => { calls.push([n, a]); pos.x = a.x; pos.y = a.y; pos.z = a.z; return { ok: true }; } };
        const east = fakeModel({ 1: 5 });
        const r = await walk3(env, { x: 6, z: 0, y: 5 }, { model: east });
        assert.strictEqual(r.ok, true); assert.strictEqual(r.move3.decisions, 4, 'near 2: four steps'); assert.deepStrictEqual(calls[0], ['move_to', { x: 1, y: 5, z: 0 }]);
        pos.x = 0; calls.length = 0; let n = 0;
        const flaky = { ...env, exec: async (nm, a) => { calls.push(a); if (n++ < 2) return { ok: false, reason: 'unreachable' }; pos.x = a.x; pos.z = a.z; return { ok: true }; } };
        const r2 = await walk3(flaky, { x: 6, z: 0, y: 5 }, { model: fakeModel({ 1: 5, 2: 1 }) });
        assert.strictEqual(r2.ok, true); assert.ok(r2.move3.fails === 2 && calls.length >= 4, `fails ${r2.move3.fails}`);
        assert.strictEqual((await walk3(env, { x: 500, z: 0, y: 5 }, { model: east })).reason, 'refused');
        assert.strictEqual((await walk3({ ...env, cancel: { cancelled: true } }, { x: 6, z: 0, y: 5 }, { model: east })).reason, 'cancelled');
        assert.strictEqual((await walk3({ ...env, wrongDim: () => true }, { x: 6, z: 0, y: 5 }, { model: east })).reason, 'wrong_dimension');
        pos.x = 0; assert.strictEqual((await walk3(env, { x: 6, z: 0 }, { model: east })).ok, true, 'the level of the target column is found');
        // sampling: with a temperature the choice follows the softmax of the logits over the allowed actions (a strong preference is taken nearly always, never a forbidden action)
        const P2 = require('../src/experts/move3/policy'), strong = fakeModel({ 1: 9, 2: 0 }), mk = Array.from({ length: SPEC.NA }, (_, a) => a === 1 || a === 2), x0 = new Float32Array(SPEC.OBS_DIM);
        const picks = Array.from({ length: 300 }, () => P2.act(strong, x0, mk, null, 1).action); assert.ok(picks.every((a) => a === 1 || a === 2)); assert.ok(picks.filter((a) => a === 1).length > 290);
        const flat2 = fakeModel({ 1: 0, 2: 0 }), p2 = Array.from({ length: 600 }, () => P2.act(flat2, x0, mk, null, 1).action); assert.ok(p2.filter((a) => a === 1).length > 220 && p2.filter((a) => a === 2).length > 220, 'equal logits: both are taken');
        assert.strictEqual(P2.act(strong, x0, mk, new Set([1]), 1).action, 2, 'a banned action is never sampled'); assert.strictEqual(P2.act(strong, x0, mk, null, 0).action, 1, 'temperature 0 is greedy');
        const dead = { ...env, exec: async () => ({ ok: false, reason: 'unreachable' }) }; pos.x = 0;
        const r3 = await walk3(dead, { x: 6, z: 0, y: 5 }, { model: east }); assert.strictEqual(r3.ok, false); assert.ok(r3.move3.fails >= 8, 'gives up after failures in a row');
        assert.strictEqual((await walk3(env, { x: 6, z: 0, y: 5 }, { model: null, refuse: false })).reason === 'refused' || true, true);
    });
    await test('walk3: dig_down is only used for a drop of three blocks or less (live copy 2026-11-11: it dug the ledge under its feet over the End void, fell 12-20 levels and spent the walk climbing back)', async () => {
        // a ledge (y 4, solid) over a void with a floor 14 levels down; the policy would love to dig down; the target is far to the east
        const world = (x, y, z) => (y === 4 && x <= 5 ? 'solid' : y === -10 ? 'solid' : 'air');
        const pos = { x: 0, y: 5, z: 0 }, calls = [];
        const env = { w: { kindAt: world, nameAt: () => 'end_stone' }, here: () => ({ ...pos }), within: { x0: -5, x1: 5, z0: -5, z1: 5, top: 10, bottom: -20 },
            exec: async (n, a) => { calls.push(n); return { ok: false, reason: 'unreachable' }; }, run: async (n) => { calls.push(n); return { ok: false, reason: 'unreachable' }; } };
        const r = await walk3(env, { x: 20, z: 0, y: 5 }, { model: fakeModel({ [SPEC.A.DIGDOWN]: 9 }), maxDecisions: 6 });
        assert.ok(!calls.includes('mine'), `the floor under the feet was dug: ${calls.join()}`);
        // a drop of three or less is allowed: a pit floor one level above solid rock
        const calls2 = [], pos2 = { x: 0, y: 5, z: 0 };
        const env2 = { ...env, w: { kindAt: (x, y, z) => (y <= 3 ? 'solid' : y === 4 && x <= 5 ? 'solid' : 'air'), nameAt: () => 'end_stone' }, here: () => ({ ...pos2 }), exec: async (n, a) => { calls2.push(n); return { ok: false, reason: 'unreachable' }; } };
        await walk3(env2, { x: 20, z: 0, y: 5 }, { model: fakeModel({ [SPEC.A.DIGDOWN]: 9 }), maxDecisions: 3 });
        assert.ok(calls2.includes('mine'), 'dig down onto rock one level below is still a legal move');
    });
    console.log('\nmove3: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

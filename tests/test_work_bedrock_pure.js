// Bedrock breaking, the basic structure only (src/work/bot/bedrock.js, owner 2026-11-09: a bug exploit, "just create the basic structure"): the gates, the method registry,
// the step runner. No method exists yet, so the real answer is a refusal that says so; the runner is tested with a method put in for the test.
const assert = require('assert');
const bedrock = require('../src/work/bot/bedrock');
const D = require('../src/work/world/dimensions');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

/** cells: Map "x,y,z" -> block name; the rest is air. `calls` records what the bot was asked to do; `mine` of anything but bedrock clears the cell. */
function env(cells, { stock = {} } = {}) {
    const calls = [], key = (x, y, z) => `${x},${y},${z}`;
    return {
        calls, cells,
        w: { nameAt: (x, y, z) => cells.get(key(x, y, z)) || 'air' },
        have: (i) => stock[i] || 0, cancel: { cancelled: false }, pause: async (t) => { calls.push(['wait', t]); },
        exec: async (name, a) => {
            calls.push([name, a.x, a.y, a.z]);
            if (name === 'mine') { if (cells.get(key(a.x, a.y, a.z)) === 'bedrock') return { ok: false, reason: 'invalid_target', detail: { why: 'bedrock' } }; cells.delete(key(a.x, a.y, a.z)); }
            if (name === 'place') cells.set(key(a.x, a.y, a.z), a.item);
            return { ok: true };
        },
    };
}
const RANGE = (dim, x, y, z, r = 1) => { const P = D.profile(dim); return D.designate({ dim, x0: x - r, x1: x + r, z0: z - r, z1: z + r, y0: Math.max(P.minY, y - r), y1: Math.min(P.maxY, y + r) }); };

(async () => {
    await test('the gates: off by default, only inside a designated range, only real bedrock, only in the bedrock layers, never the End exit', () => {
        const e = env(new Map([['5,-64,5', 'bedrock'], ['5,-62,5', 'stone'], ['6,64,5', 'bedrock'], ['0,60,0', 'bedrock'], ['50,60,0', 'bedrock']]));
        const ow = RANGE('overworld', 5, -64, 5);
        assert.match(bedrock.check(e, { x: 5, y: -64, z: 5 }, { enabled: false, range: ow }).why, /off \(setting bedrockExploit\)/);
        assert.match(bedrock.check(e, { x: 5, y: -64, z: 5 }, { enabled: true }).why, /only broken inside a designated range/);
        assert.match(bedrock.check(e, { x: 9, y: -64, z: 5 }, { enabled: true, range: ow }).why, /outside the designated range/);
        assert.match(bedrock.check(e, { x: 5, y: -62, z: 5 }, { enabled: true, range: RANGE('overworld', 5, -62, 5) }).why, /there is stone/);
        assert.match(bedrock.check(e, { x: 6, y: 64, z: 5 }, { enabled: true, range: RANGE('overworld', 6, 64, 5) }).why, /somebody's build/, 'bedrock at y 64 is not the world floor');
        assert.ok(bedrock.check(e, { x: 5, y: -64, z: 5 }, { enabled: true, range: ow }).ok);
        assert.match(bedrock.check(e, { x: 0, y: 60, z: 0 }, { enabled: true, range: RANGE('end', 0, 60, 0) }).why, /exit portal is never touched/);
        assert.ok(bedrock.check(e, { x: 50, y: 60, z: 0 }, { enabled: true, range: RANGE('end', 50, 60, 0) }).ok, 'bedrock far from the fountain: allowed in the End');
        assert.match(bedrock.check(e, { x: 1.5, y: 1, z: 1 }, { enabled: true, range: ow }).why, /x must be an integer/);
    });

    await test('breakBedrock today: every gate failure is invalid_target with a sentence, and with the gates open the answer is "no method is implemented"', async () => {
        const e = env(new Map([['5,-64,5', 'bedrock']]));
        const off = await bedrock.breakBedrock(e, { x: 5, y: -64, z: 5 }, { enabled: false, range: RANGE('overworld', 5, -64, 5) });
        assert.deepStrictEqual([off.ok, off.reason, off.detail.stage], [false, 'invalid_target', 'gate']);
        const open = await bedrock.breakBedrock(e, { x: 5, y: -64, z: 5 }, { enabled: true, range: RANGE('overworld', 5, -64, 5) });
        assert.deepStrictEqual([open.ok, open.reason, open.detail.stage, open.detail.method], [false, 'invalid_target', 'method', 'sketch']);
        assert.match(open.detail.why, /no bedrock method is implemented \(WIP\)/); assert.strictEqual(e.calls.length, 0, 'the bot did nothing');
        const named = await bedrock.breakBedrock(e, { x: 5, y: -64, z: 5 }, { enabled: true, range: RANGE('overworld', 5, -64, 5), method: 'piston_magic' });
        assert.match(named.detail.why, /no method piston_magic/); assert.deepStrictEqual(named.detail.known, ['sketch']);
    });

    await test('the step runner: steps run in order with the ordinary commands and stop at the first failure; unknown steps are refused', async () => {
        const e = env(new Map());
        const ok = await bedrock.runSteps(e, [{ op: 'place', x: 1, y: 1, z: 1, item: 'piston' }, { op: 'wait', ticks: 40 }, { op: 'activate', x: 1, y: 2, z: 1, sneak: true }, { op: 'expect_block', x: 1, y: 1, z: 1, block: 'minecraft:piston' }, { op: 'mine', x: 1, y: 1, z: 1 }, { op: 'expect_air', x: 1, y: 1, z: 1 }]);
        assert.deepStrictEqual([ok.ok, ok.done], [true, 6]); assert.deepStrictEqual(e.calls.map((c) => c[0]), ['place', 'wait', 'activate', 'mine']);
        const e2 = env(new Map([['2,2,2', 'bedrock']]));
        const f = await bedrock.runSteps(e2, [{ op: 'mine', x: 2, y: 2, z: 2 }, { op: 'place', x: 3, y: 3, z: 3, item: 'tnt' }]);
        assert.deepStrictEqual([f.ok, f.reason, f.detail.index], [false, 'invalid_target', 0]); assert.strictEqual(e2.calls.length, 1, 'stopped at the first failure');
        const x = await bedrock.runSteps(env(new Map()), [{ op: 'detonate' }]); assert.strictEqual(x.reason, 'invalid_args');
        const air = await bedrock.runSteps(env(new Map([['4,4,4', 'bedrock']])), [{ op: 'expect_air', x: 4, y: 4, z: 4 }]); assert.deepStrictEqual([air.ok, air.reason], [false, 'not_confirmed']);
        const e3 = env(new Map()); e3.cancel.cancelled = true; assert.strictEqual((await bedrock.runSteps(e3, [{ op: 'wait', ticks: 1 }])).reason, 'cancelled');
        assert.ok(bedrock.STEP_OPS.has('expect_air') && !bedrock.STEP_OPS.has('rcon'), 'a step can never be a server command');
    });

    await test('a method put in for the test: needs are checked, steps run, and success means the block is really air afterwards', async () => {
        bedrock.METHODS.testrig = { doc: 'test only', status: 'sketch', needs: { piston: 2 }, where: (P) => P.name === 'overworld', steps: (t) => [{ op: 'place', x: t.x, y: t.y + 1, z: t.z, item: 'piston' }, { op: 'wait', ticks: 20 }] };
        try {
            const cells = new Map([['5,-64,5', 'bedrock']]), range = RANGE('overworld', 5, -64, 5), opt = { enabled: true, range, method: 'testrig' };
            const poor = await bedrock.breakBedrock(env(cells, { stock: { piston: 1 } }), { x: 5, y: -64, z: 5 }, opt);
            assert.deepStrictEqual([poor.reason, poor.detail.item, poor.detail.need, poor.detail.stage], ['missing_item', 'piston', 2, 'stock']);
            const still = await bedrock.breakBedrock(env(cells, { stock: { piston: 2 } }), { x: 5, y: -64, z: 5 }, opt);
            assert.deepStrictEqual([still.ok, still.reason, still.detail.stage], [false, 'not_confirmed', 'steps'], 'the bedrock is still there: no success claimed');
            const e = env(cells, { stock: { piston: 2 } }), real = e.exec;
            e.exec = async (n, a) => { const r = await real(n, a); if (n === 'place') cells.delete('5,-64,5'); return r; };           // the (pretend) machine worked
            const done = await bedrock.breakBedrock(e, { x: 5, y: -64, z: 5 }, opt);
            assert.deepStrictEqual([done.ok, done.detail.method, done.detail.steps], [true, 'testrig', 3]);
            const wrongDim = await bedrock.breakBedrock(env(new Map([['5,-64,5', 'bedrock']]), { stock: { piston: 2 } }), { x: 5, y: -64, z: 5 }, { ...opt, range: RANGE('nether', 5, 3, 5) });
            assert.strictEqual(wrongDim.ok, false, 'a range in another dimension does not contain the block');
        } finally { delete bedrock.METHODS.testrig; }
    });

    console.log('\nwork bedrock: all tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

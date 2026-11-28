// TASK 075 (mbc075z w2/w3, 1.21.1): a bot that respawned on the surface with its station 60-120 levels down gets back by a survival-legal way down (a staircase dug inside the box,
// never a drop over three), instead of failing 'too far from the station' for the rest of the run.
const assert = require('assert');
const pit = require('../src/work/jobs/pit');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

/** Stone below y 60 (feet at 61 are air), a one-cell station at S; `tunnel` steps one cell down in a heading (and refuses what `refuse` says). */
function rig({ S, box, refuse = () => null }) {
    const dug = new Set(), key = (x, y, z) => `${x},${y},${z}`, pos = { x: 3, y: 69, z: 3 }, log = { drops: [], steps: [], refused: [] };
    const kindAt = (x, y, z) => (dug.has(key(x, y, z)) || y > 60 || (x === S.x && y === S.y && z === S.z) ? 'air' : 'solid');
    const D = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
    const env = {
        w: { kindAt, nameAt: (x, y, z) => (kindAt(x, y, z) === 'air' ? 'air' : 'stone') }, within: box, here: () => ({ ...pos }), rejoin: async () => ({ ok: true }),
        exec: async (cmd, a) => {
            if (cmd === 'tunnel') {
                const bad = refuse(a, pos); if (bad) { log.refused.push(bad); return { ok: false, reason: 'invalid_target', detail: { why: bad } }; }
                const [dx, dz] = D[a.dir], x = pos.x + dx, z = pos.z + dz;
                for (const c of [[x, pos.y + 1, z], [x, pos.y, z], [x, pos.y - 1, z]]) dug.add(key(...c));
                pos.x = x; pos.z = z; pos.y -= 1; log.steps.push({ ...pos }); return { ok: true };
            }
            if (cmd === 'move_to') {                       // on foot: no drop over three, as the planner
                if (Math.abs(pos.y - a.y) > 3) { log.drops.push(pos.y - a.y); return { ok: false, reason: 'unreachable' }; }
                pos.x = a.x; pos.y = a.y; pos.z = a.z; return { ok: true };
            }
            return { ok: false, reason: 'unsupported' };
        },
    };
    return { env, pos, log, dug };
}

(async () => {
    const S = { x: 3, y: 10, z: 3 }, box = { x0: 0, x1: 7, z0: 0, z1: 7, top: 70, bottom: 0 };

    await test('goToStation: a station 59 levels below the bot is reached by a staircase inside the box, never a drop over three', async () => {
        const { env, pos, log } = rig({ S, box }), r = {};
        const res = await pit.goToStation(S, async () => null, env, () => true, r);
        assert.strictEqual(res, null, `reached: ${JSON.stringify(res)}`);
        assert.deepStrictEqual({ x: pos.x, y: pos.y, z: pos.z }, S);
        assert.ok(log.steps.length >= 56 && r.stairSteps >= 56, 'dug down step by step');
        assert.ok(log.steps.every((p, i) => p.x >= 0 && p.x <= 7 && p.z >= 0 && p.z <= 7 && p.y === 68 - i), 'one level per step, inside the box');
        assert.ok(log.drops.length <= 2, 'the planner refused the long drop, no more than twice asked');
    });

    await test('goToStation: a heading refused for a fluid behind is turned away from', async () => {
        const { env, pos, log } = rig({ S, box, refuse: (a) => (a.dir === 'east' ? 'fluid behind' : null) }), r = {};
        const res = await pit.goToStation(S, async () => null, env, () => true, r);
        assert.strictEqual(res, null);
        assert.ok(log.refused.length >= 1 && log.steps.length >= 56);
        assert.deepStrictEqual({ x: pos.x, y: pos.y, z: pos.z }, S);
    });

    await test('goToStation: every heading refused: the pit\'s cell handler is asked once per place, and the walk ends without a hang', async () => {
        const { env, pos } = rig({ S, box, refuse: () => 'fluid behind' }), handled = [], r = {};
        pos.y = 61;
        const res = await pit.goToStation(S, async (c) => { handled.push(c); return null; }, env, () => true, r);
        assert.ok(res && res.reason === 'unreachable', 'still fails plainly');
        assert.ok(handled.length >= 1 && handled.length <= 6, `handled ${handled.length}`);
        assert.ok(r.stairFail, 'the reason is recorded');
    });

    console.log('all pass');
})().catch((e) => { console.error(e); process.exit(1); });

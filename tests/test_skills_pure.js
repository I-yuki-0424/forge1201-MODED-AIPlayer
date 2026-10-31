// Pure-logic tests of the command layer (src/skills): geometry, world model, planner, argument schema, runner.
// No server. The live behaviour is measured by scripts/skills/bench.js against the Forge server.
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const G = require('../src/skills/geometry');
const { kindOf, standable } = require('../src/skills/world');
const { plan } = require('../src/skills/planner');
const { clearLine } = require('../src/skills/motion');
const { validateArgs, COMMANDS, REASONS, execute } = require('../src/skills');
const { run, SkillError } = require('../src/skills/runner');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const CUBE = [[0, 0, 0, 1, 1, 1]];
/** World of named cells; everything not set is air. 'stone' is a full cube; `ground` fills y = 0. */
function fakeWorld(cells = {}, { ground = true } = {}) {
    const name = (x, y, z) => cells[`${x},${y},${z}`] || (ground && y === 0 ? 'stone' : 'air');
    const kinds = { stone: 'solid', air: 'air', lava: 'danger', slab: 'partial' };
    return {
        blockAt: (x, y, z) => ({ name: name(x, y, z) }),
        kindAt: (x, y, z) => kinds[name(x, y, z)],
        shapesAt: (x, y, z) => (kinds[name(x, y, z)] === 'solid' ? CUBE : []),
    };
}
const wall = (cells, xs, y0, y1, zs) => { for (const x of xs) for (const z of zs) for (let y = y0; y <= y1; y++) cells[`${x},${y},${z}`] = 'stone'; return cells; };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const goalCell = (t) => ({ isGoal: (c) => c.x === t.x && c.y === t.y && c.z === t.z, h: (c) => Math.hypot(c.x - t.x, c.z - t.z) + Math.abs(c.y - t.y) * 0.5 });

(async () => {
    await test('look angles follow Mineflayer: yaw 0 looks to -z, pitch > 0 looks up; viewDir inverts lookAngles', () => {
        const eye = { x: 0, y: 0, z: 0 };
        assert.ok(Math.abs(G.lookAngles(eye, { x: 0, y: 0, z: -5 }).yaw) < 1e-12);
        assert.ok(Math.abs(G.lookAngles(eye, { x: -5, y: 0, z: 0 }).yaw - Math.PI / 2) < 1e-12);   // counter-clockwise from above
        assert.ok(G.lookAngles(eye, { x: 0, y: 3, z: -3 }).pitch > 0);
        for (const p of [{ x: 3, y: -2, z: 1 }, { x: -1, y: 4, z: -7 }, { x: 0.2, y: 0.1, z: 9 }]) {
            const { yaw, pitch } = G.lookAngles(eye, p), d = G.viewDir(yaw, pitch), n = Math.hypot(p.x, p.y, p.z);
            for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(d[k] - p[k] / n) < 1e-9, k);
        }
        assert.ok(Math.abs(G.angleDiff(0.1, 2 * Math.PI - 0.1) - 0.2) < 1e-12);
    });

    await test('raycast: first block on the ray, entry face, passes through cells it misses', () => {
        const w = fakeWorld({ '5,1,0': 'stone', '8,1,0': 'stone' }, { ground: false });
        const h = G.raycast({ x: 0.5, y: 1.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 10, w.shapesAt);
        assert.deepStrictEqual([h.x, h.y, h.z, h.face], [5, 1, 0, 4]);          // entered through the west face (-x)
        assert.ok(Math.abs(h.t - 4.5) < 1e-9);
        assert.strictEqual(G.raycast({ x: 0.5, y: 1.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 4, w.shapesAt), null);   // out of range
        const down = G.raycast({ x: 0.5, y: 3, z: 0.5 }, { x: 0, y: -1, z: 0 }, 5, fakeWorld().shapesAt);
        assert.deepStrictEqual([down.y, down.face], [0, 1]);                      // ground hit on its top face
    });

    await test('aim points: only faces the eye can see, unobstructed, within reach', () => {
        const w = fakeWorld({ '3,1,0': 'stone', '2,1,0': 'stone' });             // target (3,1,0) hidden behind (2,1,0) from the west
        assert.strictEqual(G.aimPoints({ x: 0.5, y: 1.62, z: 0.5 }, { x: 3, y: 1, z: 0 }, w.shapesAt).length, 0, 'eye level: hidden');
        const eye = { x: 0.5, y: 2.62, z: 0.5 };                                   // one block higher (standing on a block)
        const pts = G.aimPoints(eye, { x: 3, y: 1, z: 0 }, w.shapesAt);
        assert.ok(pts.length > 0, 'its top face is visible over the blocker');
        for (const p of pts) {
            assert.strictEqual(p.face, 1);
            const d = { x: p.point.x - eye.x, y: p.point.y - eye.y, z: p.point.z - eye.z }, n = Math.hypot(d.x, d.y, d.z);
            const hit = G.raycast(eye, { x: d.x / n, y: d.y / n, z: d.z / n }, n + 0.01, w.shapesAt);
            assert.deepStrictEqual([hit.x, hit.y, hit.z], [3, 1, 0]);
        }
        const low = { x: 0.5, y: 1.62, z: 0.5 };
        assert.strictEqual(G.aimPoints(low, { x: 9, y: 1, z: 0 }, fakeWorld({ '9,1,0': 'stone' }).shapesAt).length, 0, 'beyond 4.5 blocks');
        const buried = fakeWorld(wall({}, range(2, 4), 1, 3, range(-1, 1)));
        assert.strictEqual(G.aimPoints(low, { x: 3, y: 2, z: 0 }, buried.shapesAt).length, 0, 'enclosed block');
    });

    await test('world kinds: full cube solid, other shapes partial, liquids and hazards apart', () => {
        assert.strictEqual(kindOf({ name: 'stone', boundingBox: 'block', shapes: CUBE }), 'solid');
        assert.strictEqual(kindOf({ name: 'oak_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] }), 'partial');
        assert.strictEqual(kindOf({ name: 'grass', boundingBox: 'empty', shapes: [] }), 'air');
        assert.strictEqual(kindOf({ name: 'water', boundingBox: 'empty', shapes: [] }), 'liquid');
        assert.strictEqual(kindOf({ name: 'magma_block', boundingBox: 'block', shapes: CUBE }), 'danger');
        assert.strictEqual(kindOf(null), 'unknown');
    });

    await test('planner: straight line, detour around a wall, step up, bounded drop, unreachable', () => {
        const flat = plan(fakeWorld(), { x: 0, y: 1, z: 0 }, goalCell({ x: 6, y: 1, z: 0 }).isGoal, goalCell({ x: 6, y: 1, z: 0 }).h);
        assert.strictEqual(flat.partial, false);
        assert.strictEqual(flat.path.length, 7);
        const w = fakeWorld(wall({}, [3], 1, 2, range(-3, 3)));                    // 2-high wall x = 3, z -3..3
        const g = goalCell({ x: 6, y: 1, z: 0 });
        const r = plan(w, { x: 0, y: 1, z: 0 }, g.isGoal, g.h);
        assert.strictEqual(r.partial, false);
        assert.ok(r.path.every((c) => standable(w, c.x, c.y, c.z)));
        assert.ok(r.path.some((c) => Math.abs(c.z) >= 4), 'goes round the end of the wall');
        const step = fakeWorld(wall({}, range(3, 9), 1, 1, range(-9, 9)));       // a one-block terrace from x = 3
        const up = plan(step, { x: 0, y: 1, z: 0 }, goalCell({ x: 5, y: 2, z: 0 }).isGoal, goalCell({ x: 5, y: 2, z: 0 }).h);
        assert.ok(up.path.some((c) => c.move === 'up'));
        const pit = {}; for (const x of range(2, 4)) for (const z of range(-5, 5)) for (let y = -3; y <= 0; y++) pit[`${x},${y},${z}`] = 'air';
        for (const x of range(2, 4)) for (const z of range(-5, 5)) pit[`${x},-4,${z}`] = 'stone';
        const deep = fakeWorld(pit);                                              // floor 4 below: landing cell y = -3, a 4-block drop
        const gd = goalCell({ x: 3, y: -3, z: 0 });
        assert.strictEqual(plan(deep, { x: 0, y: 1, z: 0 }, gd.isGoal, gd.h, { maxNodes: 3000 }).partial, true, 'no 4-block drop');
        delete pit['3,-3,0']; for (const x of range(2, 4)) for (const z of range(-5, 5)) pit[`${x},-3,${z}`] = 'stone';
        const shallow = fakeWorld(pit);                                           // now 3 deep
        const gs = goalCell({ x: 3, y: -2, z: 0 });
        assert.strictEqual(plan(shallow, { x: 0, y: 1, z: 0 }, gs.isGoal, gs.h).partial, false, '3-block drop allowed');
        const boxed = fakeWorld(wall(wall(wall(wall({}, [5], 1, 2, range(-2, 2)), [9], 1, 2, range(-2, 2)), range(5, 9), 1, 2, [-2]), range(5, 9), 1, 2, [2]));
        const gb = goalCell({ x: 7, y: 1, z: 0 });
        const nb = plan(boxed, { x: 0, y: 1, z: 0 }, gb.isGoal, gb.h, { maxNodes: 4000 });
        assert.strictEqual(nb.partial, true);
        assert.strictEqual(plan(fakeWorld(), { x: 0, y: 5, z: 0 }, gb.isGoal, gb.h), null, 'start in mid-air');
    });

    await test('planner: no diagonal through a corner, no step into danger', () => {
        const w = fakeWorld({ '1,1,0': 'stone', '1,2,0': 'stone' });
        const g = goalCell({ x: 1, y: 1, z: 1 });
        const r = plan(w, { x: 0, y: 1, z: 0 }, g.isGoal, g.h);
        assert.strictEqual(r.path.length, 3, 'two cardinal steps, not one diagonal past the pillar');
        const lava = fakeWorld({ '1,0,0': 'lava', '1,0,1': 'lava', '1,0,-1': 'lava' });
        const gl = goalCell({ x: 2, y: 1, z: 0 });
        assert.ok(plan(lava, { x: 0, y: 1, z: 0 }, gl.isGoal, gl.h).path.every((c) => c.x !== 1 || Math.abs(c.z) > 1));
    });

    await test('clearLine: a player-wide box along the segment', () => {
        const w = fakeWorld({ '3,1,1': 'stone' });
        assert.strictEqual(clearLine(w, { x: 0.5, z: 0.5 }, { x: 6.5, z: 0.5 }, 1), true);
        assert.strictEqual(clearLine(w, { x: 0.5, z: 0.8 }, { x: 6.5, z: 0.8 }, 1), false, 'the box edge clips (3,1,1)');
    });

    await test('argument schemas are closed', () => {
        assert.strictEqual(Object.keys(COMMANDS).length, 14);
        validateArgs('move_to', { x: 1, y: -60, z: 3 });
        validateArgs('look_at', { entity: 7 });
        validateArgs('craft', { item: 'stick', count: 4 });
        const bad = [['move_to', { x: 1, y: 2 }], ['move_to', { x: 1.5, y: 2, z: 3 }], ['move_to', { x: 1, y: 2, z: 3, fast: true }],
            ['look_at', { x: 1, y: 2, z: 3, entity: 4 }], ['look_at', { x: 1 }], ['pickup', {}], ['equip', { item: 'Stone' }],
            ['equip', { item: 'shield', dest: 'back' }], ['toss', { item: 'dirt', count: 0 }], ['craft', { item: 'stick', x: 1 }],
            ['fly', {}], ['mine', null]];
        for (const [n, a] of bad) assert.throws(() => validateArgs(n, a), (e) => e instanceof SkillError && e.reason === 'invalid_args', `${n} ${JSON.stringify(a)}`);
    });

    await test('failure taxonomy is closed', () => {
        assert.ok(Object.isFrozen(REASONS));
        assert.throws(() => new SkillError('oops'), /unknown reason/);
        assert.strictEqual(new SkillError('stuck').reason, 'stuck');
    });

    // A bot that only has what the runner and the body touch: control state, look, physics ticks every 2 ms.
    function fakeBot() {
        const bot = new EventEmitter();
        const controls = {};
        Object.assign(bot, {
            entity: { position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
            entities: {}, quickBarSlot: 0, written: [],
            setControlState: (k, v) => { controls[k] = v; }, getControlState: (k) => !!controls[k],
            look: async (y, p) => { bot.entity.yaw = y; bot.entity.pitch = p; },
            setQuickBarSlot: (s) => { bot.quickBarSlot = s; },
            blockAt: (p) => ({ name: p.y <= 0 ? 'stone' : 'air', boundingBox: p.y <= 0 ? 'block' : 'empty', shapes: p.y <= 0 ? CUBE : [], position: p }),
            _client: { write: (n, d) => bot.written.push([n, d]) },
        });
        bot.timer = setInterval(() => { if (controls.forward) bot.entity.position.z -= 0.2; bot.emit('physicsTick'); }, 2);
        return bot;
    }

    await test('runner: frames reach the body, trace per tick, success and named failures', async () => {
        const bot = fakeBot();
        try {
            const walk3 = async (ctx) => { ctx.phase('go'); for (let i = 0; i < 3; i++) await ctx.tick({ forward: true, yaw: 1 }); return { z: bot.entity.position.z }; };
            const ok = await run(bot, walk3, {}, { maxTicks: 10 });
            assert.strictEqual(ok.ok, true);
            assert.strictEqual(ok.ticks, 3);
            assert.strictEqual(ok.trace.length, 3);
            assert.deepStrictEqual(ok.trace[0].slice(1, 3), ['go', 'F........']);
            assert.strictEqual(bot.entity.yaw, 1);
            assert.strictEqual(bot.getControlState('forward'), false, 'released at the end');
            const forever = async (ctx) => { for (;;) await ctx.tick({}); };
            const to = await run(bot, forever, {}, { maxTicks: 5 });
            assert.deepStrictEqual([to.ok, to.reason, to.ticks], [false, 'timeout', 5]);
            const named = await run(bot, async () => { throw new SkillError('missing_item', { item: 'x' }); }, {});
            assert.deepStrictEqual([named.reason, named.detail.item], ['missing_item', 'x']);
            const bug = await run(bot, async () => { throw new TypeError('boom'); }, {});
            assert.strictEqual(bug.reason, 'internal');
            assert.match(bug.detail.error, /boom/);
            const cancel = { cancelled: false };
            const c = run(bot, forever, {}, { maxTicks: 1000, cancel });
            setTimeout(() => { cancel.cancelled = true; }, 20);
            assert.strictEqual((await c).reason, 'cancelled');
            const dies = run(bot, forever, {}, { maxTicks: 1000 });
            setTimeout(() => bot.emit('death'), 20);
            assert.strictEqual((await dies).reason, 'died');
            assert.strictEqual((await execute(bot, 'move_to', { x: 1 })).reason, 'invalid_args');
        } finally { clearInterval(bot.timer); }
    });

    await test('pickup of an item one block up never spins without a tick (reproducer: bench hard1 trial 130 froze the bot)', async () => {
        // The item rests on a block, one block above the feet; the bot's cell already satisfies the walking goal but the item
        // is not in pickup range (here it is never picked up at all). Before the fix pickupEntity called follow() again and
        // again without the clock moving: a synchronous loop that froze the process. Now it must end with a named reason.
        const { pickup } = require('../src/skills/commands/entity');
        const bot = fakeBot();
        Object.assign(bot, { inventory: { items: () => [], slots: [] }, food: 20, heldItem: null });
        bot.entity.position = new Vec3(0.95, 1, 0.5);
        bot.entities = { 7: { id: 7, name: 'item', position: new Vec3(1.45, 2, 0.5), getDroppedItem: () => ({ name: 'apple', count: 1 }) } };
        try {
            const r = await run(bot, pickup, { entity: 7 }, { maxTicks: 200 });
            assert.strictEqual(r.ok, false);
            assert.ok(['stuck', 'timeout'].includes(r.reason), r.reason);
            assert.ok(r.ticks > 0);
        } finally { clearInterval(bot.timer); }
    });

    await test('pickup of an item in a hole below steps into the hole (reproducer: bench hard2 trial 118)', async () => {
        // The drop of a mined floor block lies in the 1-deep hole; the bot stands on the rim, horizontally almost over it,
        // but a block above it (out of pickup range). Before the fix it released forward (within 0.25 of the item) and
        // waited on the rim until `stuck`. It must walk to the centre of the item's cell so it drops in.
        const { pickup } = require('../src/skills/commands/entity');
        const bot = fakeBot();
        Object.assign(bot, { inventory: { items: () => [], slots: [] }, food: 20, heldItem: null });
        bot.entity.position = new Vec3(0.55, 1, 1.02);          // rim: cell (0,1,1), box overlapping the hole cell (0,0,0)
        bot.entities = { 9: { id: 9, name: 'item', position: new Vec3(0.6, 0, 0.85), getDroppedItem: () => ({ name: 'dirt', count: 1 }) } };
        try {
            const r = await run(bot, pickup, { entity: 9 }, { maxTicks: 3 });
            assert.strictEqual(r.trace[0][2][0], 'F', `first frame ${r.trace[0][2]}`);
        } finally { clearInterval(bot.timer); }
    });

    console.log('All skill tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });

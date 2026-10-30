// Pure-logic tests of the RL environment (src/rl): action space, goals/rewards, observation contract, RCON and JSONL codecs.
// No server, no Mineflayer connection. The live behaviour is covered by scripts/rl/verify_game_side.py.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Vec3 = require('vec3');
const { SPECS, specHash, checkSpec, validate, keySchedule, g6 } = require('../src/rl/action_spec');
const { validateGoal, encodeGoal, assess, GOAL_DIM, ITEMS, GoalError } = require('../src/rl/goal');
const { obsSpec, observe, categoryOf, CAT, GRID_N } = require('../src/rl/observation');
const { encode, decode } = require('../src/rl/rcon');
const { LineWriter, LineReader, dumps } = require('../src/rl/jsonl_channel');
const { parseArgs, goalFor, mulberry32 } = require('../src/rl/run_env');

function test(name, fn) { console.log(`--- test: ${name} ---`); fn(); console.log('[OK]'); }

test('spec hashes equal DPOD integrations/botsystem (cross-language vectors, python3 spec_hash())', () => {
    assert.strictEqual(specHash(SPECS.full(4)), 'f085fbadb8ed23177e47c3fa326a975f92b6137fb0c23bbba34ed61d9501be50');
    assert.strictEqual(specHash(SPECS.min(4)), 'a2f361b997c9f85cd3e33e7591e2c9a6119c7fd7945446ecade12f9ce68cd6e3');
    assert.strictEqual(specHash(SPECS.min_pitch(4)), 'cd36d198ee6accff8732129686184d68d873d5b3d6625cb7ed2359c6ae341a2c');
    assert.strictEqual(g6(15), '15'); assert.strictEqual(g6(-45), '-45'); assert.strictEqual(g6(0.5), '0.5');
});

test('action validation: closed domains, exact keys, rules', () => {
    const spec = checkSpec(SPECS.min(4));
    const noop = { forward: 'off', jump: 'off', sprint: 'off', attack: 'off', yaw_delta_deg: 0 };
    validate(spec, noop);
    assert.throws(() => validate(spec, { ...noop, forward: 'tap2' }), /domain/);
    assert.throws(() => validate(spec, { ...noop, sprint: 'hold' }), /rule requires/);   // sprint without forward
    assert.throws(() => validate(spec, { ...noop, yaw_delta_deg: 7 }), /domain/);
    assert.throws(() => validate(spec, { forward: 'off' }), /keys/);
    assert.throws(() => checkSpec({ ...SPECS.min(1), components: SPECS.full(1).components }), /tap == hold/);
    assert.throws(() => checkSpec({ ...SPECS.min(4), components: [{ kind: 'key', name: 'fly', modes: ['off'] }] }), /unknown action component/);
});

test('key schedule: off / tap (tick 0 only) / hold (every tick)', () => {
    const spec = SPECS.full(4);
    const a = Object.fromEntries(spec.components.map((c) => [c.name, c.kind === 'key' ? 'off' : c.kind === 'axis' ? 0 : 0]));
    const sch = keySchedule(spec, { ...a, forward: 'hold', jump: 'tap' });
    assert.strictEqual(sch.length, 4);
    assert.deepStrictEqual(sch.map((t) => t.forward), [true, true, true, true]);
    assert.deepStrictEqual(sch.map((t) => t.jump), [true, false, false, false]);
    assert.deepStrictEqual(sch.map((t) => t.attack), [false, false, false, false]);
});

test('goal validation: closed types and items, unknown fields refused, defaults filled', () => {
    assert.deepStrictEqual(validateGoal({ v: 1, type: 'reach', offset: [3, -2] }), { v: 1, type: 'reach', offset: [3, -2], tolerance: 1, max_steps: 150 });
    assert.strictEqual(validateGoal({ v: 1, type: 'collect', item: 'oak_log', count: 2 }).count, 2);
    for (const bad of [null, [], { v: 2, type: 'reach', offset: [1, 1] }, { v: 1, type: 'fly' }, { v: 1, type: 'reach', offset: [1] },
        { v: 1, type: 'reach', offset: [100, 0] }, { v: 1, type: 'reach', offset: [1, 1], extra: 1 }, { v: 1, type: 'reach', offset: [1, 1], max_steps: 0 },
        { v: 1, type: 'collect', item: 'netherite_block', count: 1 }, { v: 1, type: 'collect', item: 'oak_log', count: 9 }, { v: 1, type: 'collect', item: 'oak_log', count: 1.5 },
        { v: 1, type: 'reach', offset: [NaN, 0] }]) {
        assert.throws(() => validateGoal(bad), GoalError, JSON.stringify(bad));
    }
});

test('goal encoding: fixed length, relative, clipped', () => {
    const reach = validateGoal({ v: 1, type: 'reach', offset: [8, -4] });
    const v = encodeGoal(reach, { x: 0.5, y: -60, z: 0.5 }, { x: 0.5, y: -60, z: 0.5 });
    assert.strictEqual(v.length, GOAL_DIM);
    assert.deepStrictEqual([v[0], v[1], v[2], v[4]], [1, 0, 0.5, -0.25]);
    const far = encodeGoal(validateGoal({ v: 1, type: 'reach', offset: [60, 0] }), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    assert.strictEqual(far[2], 1);                                    // clipped at 16 blocks
    const col = encodeGoal(validateGoal({ v: 1, type: 'collect', item: 'stick', count: 4 }), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    assert.strictEqual(col[5 + ITEMS.indexOf('stick')], 1);
    assert.strictEqual(col[GOAL_DIM - 1], 0.25);
});

test('reward: reach success, potential-based shaping telescopes, death and collect', () => {
    const goal = validateGoal({ v: 1, type: 'reach', offset: [4, 0] });
    const origin = { x: 0, y: -60, z: 0 };
    const at = (x, y = -60) => ({ pos: { x, y: y, z: 0 }, origin, inv: {}, dead: false });
    let prev = at(0), total = 0;
    for (const x of [1, 0.5, 2, 2.5]) { const r = assess(goal, at(x), prev); total += r.shaping; assert.strictEqual(r.task, 0); prev = at(x); }
    assert.ok(Math.abs(total - (4 - 1.5) / 10) < 1e-9, `telescoping sum ${total}`);   // (d0 - dN)/10 with d0 = 4, dN = 1.5
    const win = assess(goal, at(3.5), prev);
    assert.deepStrictEqual([win.task, win.terminated, win.outcome], [1, true, 'success']);
    assert.strictEqual(assess(goal, at(4, -57), prev).terminated, false);   // right place, 3 blocks too high
    assert.deepStrictEqual(assess(goal, { ...at(0), dead: true }, prev), { task: -1, shaping: 0, terminated: true, outcome: 'dead' });
    const c = validateGoal({ v: 1, type: 'collect', item: 'oak_log', count: 2 });
    assert.strictEqual(assess(c, { ...at(0), inv: { oak_log: 1 } }, null).terminated, false);
    assert.strictEqual(assess(c, { ...at(0), inv: { oak_log: 2 } }, null).task, 1);
});

test('block categories: names, shapes, unknowns', () => {
    const b = (name, boundingBox = 'block') => ({ name, boundingBox });
    assert.strictEqual(categoryOf(null), CAT.unloaded);
    assert.strictEqual(categoryOf(b('air', 'empty')), CAT.air);
    assert.strictEqual(categoryOf(b('grass_block')), CAT.soil);
    assert.strictEqual(categoryOf(b('cobblestone')), CAT.stone);
    assert.strictEqual(categoryOf(b('oak_log')), CAT.log);
    assert.strictEqual(categoryOf(b('stripped_birch_wood')), CAT.log);
    assert.strictEqual(categoryOf(b('water', 'empty')), CAT.liquid);
    assert.strictEqual(categoryOf(b('iron_ore')), CAT.ore);
    assert.strictEqual(categoryOf(b('create:cogwheel')), CAT.other_solid);   // modded block: by shape
    assert.strictEqual(categoryOf(b('short_grass', 'empty')), CAT.air);       // walk-through plant
});

test('observation: exactly the declared fields, shapes and dtypes', () => {
    const spec = obsSpec();
    const world = (v) => (v.y < -61 ? { name: 'dirt', boundingBox: 'block' } : v.y === -61 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
    const pos = new Vec3(0.5, -60, 0.5);
    const bot = {
        entity: { position: pos, velocity: new Vec3(0, -0.0784, 0), yaw: 1, pitch: 0.2, onGround: true, eyeHeight: 1.62 },
        health: 20, food: 20, quickBarSlot: 3,
        inventory: { items: () => [{ name: 'oak_log', count: 3 }, { name: 'oak_log', count: 2 }, { name: 'bedrock', count: 1 }] },
        entities: { 1: { position: new Vec3(2.5, -60, 0.5), name: 'item', type: 'other' }, 2: { position: new Vec3(50, -60, 0), name: 'zombie', type: 'hostile' } },
        blockAt: world, blockAtCursor: () => null,
    };
    bot.entities[0] = bot.entity;
    const goal = validateGoal({ v: 1, type: 'reach', offset: [5, 0] });
    const o = observe(bot, { goal, origin: { x: 0.5, y: -60, z: 0.5 }, step: 30 });
    assert.deepStrictEqual(Object.keys(o).sort(), spec.fields.map((f) => f.name).sort());
    for (const f of spec.fields) {
        const v = o[f.name];
        const check = (x, shape) => {
            if (!shape.length) { f.dtype === 'bool' ? assert.strictEqual(typeof x, 'boolean') : assert.ok(Number.isFinite(x) && (f.dtype !== 'int' || Number.isInteger(x)), f.name); return; }
            assert.ok(Array.isArray(x) && x.length === shape[0], `${f.name} length`); x.forEach((e) => check(e, shape.slice(1)));
        };
        check(v, f.shape);
    }
    assert.strictEqual(o.grid.length, GRID_N);
    assert.strictEqual(o.inventory[ITEMS.indexOf('oak_log')], 5);      // stacks summed, unlisted items ignored
    assert.strictEqual(o.held_slot, 3);
    assert.deepStrictEqual(o.entities.slice(0, 8), [1, 2, 0, 0, 0, 0, 0, 0]);   // the item 2 blocks away; the zombie is out of range
    assert.strictEqual(o.cursor_dist, -1);
    assert.strictEqual(o.step_frac, 0.2);
});

test('rcon packets round-trip and split a byte stream', () => {
    const a = encode(7, 2, 'list'), b = encode(8, 0, 'There are 0 players');
    const [pk, rest] = decode(Buffer.concat([a, b, b.subarray(0, 5)]));
    assert.deepStrictEqual(pk.map((p) => [p.id, p.type, p.body]), [[7, 2, 'list'], [8, 0, 'There are 0 players']]);
    assert.strictEqual(rest.length, 5);
    assert.throws(() => decode(Buffer.from([255, 255, 255, 127, 0, 0, 0, 0])), /bad packet length/);
});

test('jsonl channel: one message per line, partial lines wait, invalid lines are counted, NaN refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlch-'));
    const file = path.join(dir, 'x.jsonl');
    const w = new LineWriter(file), r = new LineReader(file, { runId: 'r', allowed: ['obs', 'act'] });
    assert.deepStrictEqual(r.poll(), []);
    w.send({ v: 1, type: 'obs', run_id: 'r', seq: 0 });
    fs.appendFileSync(file, '{"v":1,"type":"obs","run_id":"r","se');            // half-written
    assert.strictEqual(r.poll().length, 1);
    fs.appendFileSync(file, 'q":1}\nnot json\n{"v":1,"type":"bye","run_id":"r"}\n{"v":1,"type":"act","run_id":"other"}\n');
    assert.deepStrictEqual(r.poll().map((m) => m.seq), [1]);
    assert.strictEqual(r.rejected, 3);
    assert.throws(() => dumps({ reward: NaN }), /non-finite/);
    assert.throws(() => dumps({ reward: Infinity }), /non-finite/);
    w.close(); fs.rmSync(dir, { recursive: true });
});

test('run_env arguments and goal sampling are deterministic per seed', () => {
    const o = parseArgs(['--run-id', 'r', '--sample', 'reach', '--seed', '5']);
    const g = () => goalFor(o, mulberry32(5 * 1000003), 0);
    assert.deepStrictEqual(g(), g());
    assert.throws(() => parseArgs(['--run-id', 'r']), /exactly one/);
    assert.throws(() => parseArgs(['--run-id', 'r', '--spec', 'nope', '--sample', 'reach']), /--spec must be/);
    const list = parseArgs(['--run-id', 'r', '--goal', '[{"v":1,"type":"reach","offset":[1,1]},{"v":1,"type":"collect","item":"oak_log","count":1}]']);
    assert.deepStrictEqual([goalFor(list, null, 0).type, goalFor(list, null, 1).type, goalFor(list, null, 2).type], ['reach', 'collect', 'reach']);
});

console.log('=== All RL environment pure tests passed ===');

'use strict';
// The builder's fall guard (src/build/fallguard.js) on prismarine-physics without a server, and the shared pool's choice of a colleague (src/build/pool.js) on a fake crew.
// The guard: a body on a pillar top or a floor edge 20 up never walks, sprints or jumps off it, whatever the controls; a planned drop is let through; a block beside the body at
// lava under a one-block drop is not a landing; each case is checked to fall without the guard where that is the point.
const assert = require('assert');
const Vec3 = require('vec3');
const registry = require('prismarine-registry')('1.20.1');
const Block = require(require.resolve('prismarine-block', { paths: [require.resolve('mineflayer')] }))(registry);
const { Physics, PlayerState } = require('prismarine-physics');
const FG = require('../src/build/fallguard');
const { Pool } = require('../src/build/pool');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const sid = (name) => registry.blocksByName[name].defaultState;
/** A world of state ids: air everywhere except `cells` ('x,y,z' -> name). */
function scene(cells) {
    const m = new Map(Object.entries(cells).map(([k, v]) => [k, sid(v)]));
    return { getBlock: (p) => { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); const b = Block.fromStateId(m.get(`${x},${y},${z}`) ?? sid('air'), 0); b.position = new Vec3(x, y, z); return b; } };
}
const column = (x, z, y0, y1, name = 'stone', o = {}) => { for (let y = y0; y <= y1; y++) o[`${x},${y},${z}`] = name; return o; };

function simBot(world, pos) {
    const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
    const bot = {
        version: '1.20.1', registry, jumpTicks: 0, jumpQueued: false, game: { gameMode: 'survival' },
        entity: { position: pos.clone(), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, isInWater: false, attributes: {}, effects: {} },
        inventory: { slots: [] }, physics: Physics(registry, world),
    };
    bot.tick = (n = 1) => { for (let i = 0; i < n; i++) bot.physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot); };
    bot.set = (o) => Object.assign(controls, o);
    return bot;
}
// yaw toward +x (mineflayer: yaw 0 looks to -z, yaw -PI/2 to +x)
const EAST = -Math.PI / 2;

test('walking off a 20-high pillar top: held on it', () => {
    const w = scene(column(0, 0, 0, 20)), bot = simBot(w, new Vec3(0.5, 21, 0.5));
    FG.install(bot); bot.entity.yaw = EAST; bot.set({ forward: true, sprint: true });
    bot.tick(60);
    assert.ok(bot.entity.position.y > 20.9, `fell to ${bot.entity.position.y}`);
    assert.ok(bot.entity.position.x < 1.3 + 1e-6, `x ${bot.entity.position.x}`);
    assert.ok(bot.__fallGuard.stops > 0);
});

test('the same without the guard falls (the test sees a fall)', () => {
    const w = scene(column(0, 0, 0, 20)), bot = simBot(w, new Vec3(0.5, 21, 0.5));
    bot.entity.yaw = EAST; bot.set({ forward: true, sprint: true });
    bot.tick(60);
    assert.ok(bot.entity.position.y < 20, `stayed at ${bot.entity.position.y}`);
});

test('a jump from a pillar top with forward held: lands back on it', () => {
    const w = scene(column(0, 0, 0, 20)), bot = simBot(w, new Vec3(0.5, 21, 0.5));
    FG.install(bot); bot.entity.yaw = EAST; bot.set({ forward: true, jump: true, sprint: true });
    bot.tick(40); bot.set({ jump: false, forward: false }); bot.tick(20);
    assert.ok(bot.entity.position.y > 20.9 && bot.entity.onGround, `y ${bot.entity.position.y}`);
});

test('a jump onto a one-higher pillar beside it: allowed (both columns hold the body)', () => {
    const w = scene({ ...column(0, 0, 0, 20), ...column(1, 0, 0, 21) }), bot = simBot(w, new Vec3(0.5, 21, 0.5));
    FG.install(bot); bot.entity.yaw = EAST; bot.set({ forward: true, jump: true });
    bot.tick(30); bot.set({ forward: false, jump: false }); bot.tick(20);
    assert.ok(bot.entity.position.y > 21.9, `y ${bot.entity.position.y}`);
    assert.ok(bot.entity.position.x > 1, `x ${bot.entity.position.x}`);
});

test('a jump that hits its head onto a higher pillar: comes down on its own column, not beside it', () => {
    // the block over the take-off cell at y 23 (two over the head room): the jump is cut short
    const cells = { ...column(0, 0, 0, 20), ...column(1, 0, 0, 21), '0,23,0': 'stone' };
    const w = scene(cells), bot = simBot(w, new Vec3(0.5, 21, 0.5));
    FG.install(bot); bot.entity.yaw = Math.PI / 4 - Math.PI / 2 - 0.4; bot.set({ forward: true, jump: true, sprint: true });
    bot.tick(40); bot.set({ forward: false, jump: false }); bot.tick(20);
    assert.ok(bot.entity.position.y > 20.9, `fell to ${bot.entity.position.y}`);
});

test('a diagonal sprint off the corner of a floor 20 up, upright: held (and without the guard it falls)', () => {
    const cells = {}; for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) column(x, z, 0, 20, 'stone', cells);
    for (const guarded of [true, false]) {
        const bot = simBot(scene(cells), new Vec3(1.5, 21, 1.5));
        if (guarded) FG.install(bot);
        bot.entity.yaw = -Math.PI * 3 / 4; bot.set({ forward: true, sprint: true });
        bot.tick(80);
        if (guarded) assert.ok(bot.entity.position.y > 20.9, `fell to ${bot.entity.position.y}`); else assert.ok(bot.entity.position.y < 20, 'the control did not fall');
    }
});

test('a planned drop: the open column lets the body fall', async () => {
    const cells = column(0, 0, 0, 20); column(1, 0, 0, 15, 'stone', cells);
    const w = scene(cells), bot = simBot(w, new Vec3(0.5, 21, 0.5));
    FG.install(bot); bot.entity.yaw = EAST;
    await FG.allowing(bot, [{ x: 1, z: 0, depth: 5.5 }], async () => { bot.set({ forward: true }); bot.tick(15); bot.set({ forward: false }); bot.tick(40); });
    assert.ok(bot.entity.position.y < 17 && bot.entity.position.x > 1, `at ${bot.entity.position}`);
    assert.strictEqual(bot.__fallGuard.allow, null);
});

test('a planned drop whose landing is gone: held at the edge', async () => {
    const cells = column(0, 0, 0, 20); column(1, 0, 0, 5, 'stone', cells);          // planned onto 15, the column now ends at 5
    const w = scene(cells), bot = simBot(w, new Vec3(0.5, 21, 0.5));
    FG.install(bot); bot.entity.yaw = EAST;
    await FG.allowing(bot, [{ x: 1, z: 0, depth: 5.5 }], async () => { bot.set({ forward: true }); bot.tick(30); bot.set({ forward: false }); bot.tick(20); });
    assert.ok(bot.entity.position.y > 20.9, `fell to ${bot.entity.position.y}`);
});

test('a step down of three is walked; lava one down is not', () => {
    const w1 = scene({ ...column(0, 0, 0, 20), ...column(1, 0, 0, 17) }), b1 = simBot(w1, new Vec3(0.5, 21, 0.5));
    FG.install(b1); b1.entity.yaw = EAST; b1.set({ forward: true }); b1.tick(40);
    assert.ok(b1.entity.position.x > 1.2 && b1.entity.position.y < 19, `at ${b1.entity.position}`);
    const w2 = scene({ ...column(0, 0, 0, 20), ...column(1, 0, 0, 18), '1,19,0': 'lava' }), b2 = simBot(w2, new Vec3(0.5, 21, 0.5));
    FG.install(b2); b2.entity.yaw = EAST; b2.set({ forward: true }); b2.tick(40);
    assert.ok(b2.entity.position.x < 1.31 && b2.entity.position.y > 20.9, `at ${b2.entity.position}`);
});

test('an open trapdoor (a plate along one side of its cell) is no floor: held at the edge; the planner does not stand on it either', () => {
    const tdState = Block.fromProperties(registry.blocksByName.spruce_trapdoor.id, { facing: 'west', half: 'top', open: true, powered: false, waterlogged: false }, 0).stateId;
    const cells = column(0, 0, 0, 20);
    const base = scene(cells), w = { getBlock: (p) => { if (Math.floor(p.x) === 1 && Math.floor(p.y) === 20 && Math.floor(p.z) === 0) { const b = Block.fromStateId(tdState, 0); b.position = new Vec3(1, 20, 0); return b; } return base.getBlock(p); } };
    for (const guarded of [true, false]) {
        const bot = simBot(w, new Vec3(0.5, 21, 0.5));
        if (guarded) FG.install(bot);
        bot.entity.yaw = EAST; bot.set({ forward: true }); bot.tick(60);
        if (guarded) assert.ok(bot.entity.position.y > 20.9, `fell to ${bot.entity.position.y}`); else assert.ok(bot.entity.position.y < 20, 'the control did not fall through');
    }
    const M = require('../src/build/move');
    const v = new M.View({ blockAt: (p) => w.getBlock(p) }, {});
    assert.strictEqual(v.stands(1, 20, 0), false);
    assert.strictEqual(v.stands(0, 20, 0), true);
});

test('perched on the rim of a block, a step that also leaves the rim slides along it to the next floor', () => {
    // a floor block at (0, 20, 1) and the target floor at (1, 20, 0); the body over (0, 0) with 0.01 of its box on (0, 1)'s rim, heading east and a little north
    const cells = { ...column(0, 1, 0, 20), ...column(1, 0, 0, 20) };
    const bot = simBot(scene(cells), new Vec3(0.5, 21, 0.71));
    FG.install(bot); bot.entity.yaw = EAST + 0.3; bot.set({ forward: true });
    bot.tick(40);
    assert.ok(bot.entity.position.x > 1 && bot.entity.position.y > 20.9, `at ${bot.entity.position}`);
});

test('held(): an unloaded column counts as held', () => {
    assert.strictEqual(FG.held({ getBlock: () => null }, 0.5, 70, 0.5, 3), true);
});

// ---- the pool ----
function crew(packs, posOf, tasks = []) {
    const job = { tasks: new Map(tasks.map((t) => [t.k, t])), claims: new Map(), t: { items: new Map() }, log: () => {}, _itemOf: (tk) => tk.item, _addNeeds: (need, tk) => { if (tk.item) need[tk.item] = (need[tk.item] || 0) + 1; return need; } };
    const pool = new Pool(job);
    for (const [name, inv] of Object.entries(packs)) {
        const [x, y, z] = posOf[name];
        pool.join(name, { username: name, entity: { position: new Vec3(x + 0.5, y, z + 0.5), isInWater: false }, inventory: { items: () => Object.entries(inv).map(([n, c]) => ({ name: n, count: c })) } });
    }
    return pool;
}

test('pool: the colleague that spares the item and is nearest is asked; what it needs near itself is kept', () => {
    const tasks = [{ k: '30,70,0', x: 30, y: 70, z: 0, kind: 'place', item: 'hopper' }, { k: '31,70,0', x: 31, y: 70, z: 0, kind: 'place', item: 'hopper' }];
    const pool = crew({ a: {}, b: { hopper: 3 }, c: { hopper: 10 }, d: { hopper: 5, dirt: 64 } }, { a: [0, 70, 0], b: [30, 70, 0], c: [40, 70, 0], d: [4, 70, 0] }, tasks);
    assert.strictEqual(pool.spare('b', 'hopper'), 1);           // two of its three are for the cells beside it
    assert.strictEqual(pool.spare('d', 'dirt'), 0);             // temporary blocks are the chest's and the quarry's
    const o = pool.offers('a', { hopper: 4 });
    assert.strictEqual(o[0].to, 'd');
    assert.deepStrictEqual(o[0].items, { hopper: 4 });
    assert.ok(pool.canSpare('a', 'hopper'));
    assert.ok(!pool.canSpare('a', 'comparator'));
});

test('pool: a giver serving a request is not asked again; an expired request is dropped', () => {
    const pool = crew({ a: {}, b: { hopper: 9 }, e: {} }, { a: [0, 70, 0], b: [3, 70, 0], e: [6, 70, 0] });
    const r = pool.open('a', 'b', { hopper: 2 });
    assert.strictEqual(pool.offers('e', { hopper: 1 }).length, 0);
    r.at = Date.now() - 130000;
    assert.strictEqual(pool.forGiver('b'), null);
    assert.strictEqual(pool.offers('e', { hopper: 1 })[0].to, 'b');
    assert.strictEqual(pool.status().failed, 1);
});

test('pool: a toss the asker does not get is taken back by the giver (walks onto each stack), nothing left lying (b081q4: 6 tosses left on the ground); negative control: the asker gets it, the giver stays', async () => {
    const { EventEmitter } = require('events');
    for (const askerGets of [false, true]) {
        const job = { tasks: new Map(), claims: new Map(), t: { items: new Map() }, log: () => {}, _itemOf: () => null, _addNeeds: (need) => need };
        const pool = new Pool(job);
        const packs = { a: { glass: 0 }, b: { glass: 64 } }, ents = {};
        const mk = (name, x) => { const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: new Vec3(x + 0.5, 70, 0.5), eyeHeight: 1.62, isInWater: false }, entities: ents, setControlState() {}, look: async () => {}, blockAt: (v) => ({ boundingBox: v.y === 69 ? 'block' : 'empty' }), inventory: { items: () => Object.entries(packs[name]).filter(([, c]) => c > 0).map(([n, c]) => ({ name: n, count: c })) } }); return b; };
        const a = mk('a', 0), b = mk('b', 2.5);
        let id = 0;
        b.tossStack = async (st) => { packs.b[st.name] -= st.count; const e = { id: ++id, name: 'item', position: new Vec3(1.5, 70, 0.5), stack: { ...st } }; ents[e.id] = e; b.emit('entitySpawn', e); if (askerGets) { packs.a[st.name] += st.count; delete ents[e.id]; } };
        b.toss = async () => {};
        const walked = [];
        const mvB = { goto: async (q) => { walked.push(q); for (const [k, e] of Object.entries(ents)) if (Math.floor(e.position.x) === q.x) { packs.b[e.stack.name] += e.stack.count; delete ents[k]; } return { ok: true }; } };
        pool.join('a', a); pool.join('b', b, mvB);
        pool.spare = () => 64;
        const r = pool.open('a', 'b', { glass: 64 });
        await pool.serve('b');
        if (!askerGets) { assert.strictEqual(packs.b.glass, 64, 'taken back'); assert.strictEqual(Object.keys(ents).length, 0, 'nothing lying'); assert.strictEqual(pool.stats.takenBack, 64); }
        else { assert.strictEqual(walked.length, 0, 'negative control: the asker has it, the giver stays'); assert.strictEqual(packs.a.glass, 64); }
        assert.ok(r);
    }
});

test('pool: the asker\'s cell has the giver\'s floor rule, under it and the cell beyond (b081z4: Bd4d waited on a pumpkin 2.8 from its giver with air beyond, 172 refusals in 96 s); negative control: with a floor beyond, the cell is good', () => {
    const { near } = require('../src/build/pool');
    for (const beyondFloor of [false, true]) {
        const solid = new Set(['3,69,0', '0,69,0']); if (beyondFloor) solid.add('4,69,0');
        const view = { free: () => true, stands: (x, y, z) => solid.has(`${x},${y},${z}`) };
        const ok = near({ x: 0, y: 70, z: 0 }, view)(3, 70, 0);
        assert.strictEqual(ok, beyondFloor, beyondFloor ? 'negative control: floor beyond' : 'no floor beyond: not a cell for the asker');
    }
    const view = { free: () => true, stands: () => false };
    assert.strictEqual(near({ x: 0, y: 70, z: 0 }, view)(3, 70, 0), false, 'no floor under the asker');
});

test('pool: no toss to an asker whose floor ends at its feet (a stance in the air: b081w4, 43 glass fell 38 cells and despawned); negative control: on ground the toss goes', async () => {
    for (const ground of [false, true]) {
        const job = { tasks: new Map(), claims: new Map(), t: { items: new Map() }, log: () => {}, _itemOf: () => null, _addNeeds: (need) => need };
        const pool = new Pool(job), packs = { a: { glass: 0 }, b: { glass: 64 } };
        let thrown = 0;
        const mk = (name, x) => ({ username: name, entity: { position: new Vec3(x + 0.5, 70, 0.5), eyeHeight: 1.62, isInWater: false }, entities: {}, on() {}, removeListener() {}, setControlState() {}, look: async () => {},
            blockAt: (v) => ({ boundingBox: v.y === 69 && (ground || v.x >= 0) ? 'block' : 'empty' }), inventory: { items: () => Object.entries(packs[name]).filter(([, c]) => c > 0).map(([n, c]) => ({ name: n, count: c })) } });
        const a = mk('a', 0), b = mk('b', 2.5);
        b.tossStack = async (st) => { thrown += st.count; packs.b[st.name] -= st.count; packs.a[st.name] += st.count; }; b.toss = async () => {};
        pool.join('a', a); pool.join('b', b, { goto: async () => ({ ok: true }) }); pool.spare = () => 64;
        const r = pool.open('a', 'b', { glass: 64 });
        await pool.serve('b');
        if (ground) assert.strictEqual(thrown, 64, 'negative control: on ground the toss goes'); else { assert.strictEqual(thrown, 0, 'nothing thrown over the edge'); assert.strictEqual(r.noFloor, 1);
            // why the giver held back is in the request's end (b081y4: 46 of 92 requests 'did not meet' after about 100 s)
            let line = ''; job.log = (m) => { line = m; }; pool.close(r, 'failed', 'did not meet');
            assert.deepStrictEqual(pool.stats.declined, { 'no floor': 1 }); assert.ok(/held back: \{"no floor":1\}/.test(line), line); }
    }
});

// ---- NAV and the work layer (TASK-075: the guard on every work bot; pit bots walked off 21- and 40-block edges of their own pit) ----
test('a pit bot at the 21-block edge of its dug pit: held (the guard every work bot now has); without it the body falls (negative control)', () => {
    const cells = {}; for (let x = -3; x <= 0; x++) column(x, 0, 0, 20, 'stone', cells); column(1, 0, 0, 0, 'stone', cells);          // the pit floor 20 below, east of the rim
    for (const guard of [true, false]) {
        const bot = simBot(scene(cells), new Vec3(0.5, 21, 0.5));
        if (guard) FG.install(bot);
        bot.entity.yaw = EAST; bot.set({ forward: true, sprint: true }); bot.tick(30); bot.set({ forward: false, sprint: false }); bot.tick(40);
        if (guard) assert.ok(bot.entity.position.y > 20.9, `held: at ${bot.entity.position}`); else assert.ok(bot.entity.position.y < 5, `fell: at ${bot.entity.position}`);
    }
});
test('a walk\'s planned drop of seven into water (motion.openDrops, what NAV walks and the action layer follow): let through; the same drop not opened is held (negative control)', () => {
    const { openDrops } = require('../src/skills/motion');
    const cells = column(0, 0, 0, 20); column(1, 0, 0, 11, 'stone', cells); cells['1,12,0'] = 'water'; cells['1,13,0'] = 'water';         // water at 12-13: 7 below the feet
    for (const open of [true, false]) {
        const bot = simBot(scene(cells), new Vec3(0.5, 21, 0.5));
        FG.install(bot);
        if (open) assert.strictEqual(openDrops(bot, [{ x: 0, y: 21, z: 0 }, { x: 1, y: 14, z: 0, move: 'drop' }]), 1);
        bot.entity.yaw = EAST; bot.set({ forward: true }); bot.tick(15); bot.set({ forward: false }); bot.tick(40);
        if (open) assert.ok(bot.entity.position.y < 16 && bot.entity.position.x > 1, `dropped: at ${bot.entity.position}`); else assert.ok(bot.entity.position.y > 20.9, `held: at ${bot.entity.position}`);
    }
});
test('openDrops leaves drops within the guard\'s three alone and adds to what is already open', () => {
    const { openDrops } = require('../src/skills/motion');
    const bot = { __fallGuard: { maxFall: 3, allow: new Map([['5,5', 4]]) } };
    assert.strictEqual(openDrops(bot, [{ x: 0, y: 10, z: 0 }, { x: 1, y: 7, z: 0, move: 'drop' }]), 0);
    assert.strictEqual(openDrops(bot, [{ x: 0, y: 10, z: 0 }, { x: 1, y: 4, z: 0, move: 'drop' }]), 1);
    assert.deepStrictEqual([...bot.__fallGuard.allow.entries()].sort(), [['1,0', 6.5], ['5,5', 4]]);
});

test('a ladder or vine within the reach of a fall holds the body (the walk plans climb nodes); negative control: the same cell without it holds nothing', () => {
    const held = (cells) => FG.held(scene(cells), 1.5, 21, 0.5, 3);
    assert.strictEqual(held(column(1, 0, 0, 20, 'vine')), true);                   // a vine column from the ground up to the feet
    assert.strictEqual(held({ '1,19,0': 'ladder' }), true);                          // a ladder two below the feet, nothing under it: caught
    assert.strictEqual(held({}), false);                                             // air down to the ground: held by nothing
    assert.strictEqual(held({ '1,10,0': 'ladder' }), false);                         // a ladder eleven below: beyond the reach of a fall of three
});

test('a body on the edge of the next column (its centre over a hole) starts its walk from the cell that holds it (fg075d: 2 092 guard stops on a nudge to the centre); negative control: over the hole alone there is none', () => {
    const { supportCell } = require('../src/skills/motion');
    const planner = require('../src/skills/planner');
    // ground y 65 at x <= -3, a hole 12 deep at x -2..0, z 16
    const kindAt = (x, y, z) => (y <= 65 && x <= -3 ? 'solid' : y <= 53 ? 'solid' : 'air');
    const w = { kindAt };
    const pos = { x: -1.74, y: 66, z: 16.5 };
    assert.strictEqual(planner.nodeKind(w, -2, 66, 16), null, 'the centre cell is no node (the old walk nudged toward its centre)');
    assert.deepStrictEqual(supportCell(w, pos), { x: -3, y: 66, z: 16 });
    const r = planner.plan(w, supportCell(w, pos), (c) => c.x === -8 && c.z === 16, (c) => Math.abs(c.x + 8));
    assert.ok(r && !r.partial, 'a plan from the support cell');
    assert.strictEqual(supportCell(w, { x: -1.5, y: 66, z: 16.5 }), null, 'negative control: a body wholly over the hole has no support cell');
});

(async () => {
    let n = 0;
    for (const [name, fn] of queue) { await fn(); n++; console.log(`ok - ${name}`); }
    console.log(`fallguard + pool: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });

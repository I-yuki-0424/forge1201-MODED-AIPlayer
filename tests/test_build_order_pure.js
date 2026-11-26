'use strict';
// Build order rules of src/build (TASK-20261125-081, owner list 5 Large 3.1): cells no order can place without a temporary block (support cycles), and how the job breaks them.
// Each rule has a negative control.
const assert = require('assert');
const { Target } = require('../src/build/target');
const { BuildJob } = require('../src/build/job');

let n = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

/** A 4 x 3 x 4 box: a stone floor at y 0, the given blocks at y 1 (x, z, name, props). */
function box(cells) {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }], blocks = [];
    const idOf = (name, props) => { let i = palette.findIndex((p) => p.name === name && JSON.stringify(p.props) === JSON.stringify(props)); if (i < 0) { i = palette.length; palette.push({ name, props }); } return i; };
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) { blocks.push({ x, y: 0, z, s: 1 }); blocks.push({ x, y: 1, z, s: 0 }); blocks.push({ x, y: 2, z, s: 0 }); }
    for (const [x, z, name, props] of cells) { const b = blocks.find((q) => q.x === x && q.y === 1 && q.z === z); b.s = idOf(name, props); }
    return new Target({ size: [4, 3, 4], palette, blocks }, { x: 0, y: 64, z: 0 });
}
const hopper = (facing) => ['minecraft:hopper', { enabled: 'true', facing }];

test('two hoppers facing each other: a support cycle (each needs the other as the clicked block); the first goes against a temporary block in the other', () => {
    const t = box([[1, 1, ...hopper('south')], [1, 2, ...hopper('north')]]);
    const c = t.cycles();
    assert.strictEqual(c.length, 1, JSON.stringify(c));
    const a = t.cell(c[0].cell), v = t.cell(c[0].via);
    assert.deepStrictEqual([a, v].map((q) => q.z).sort(), [1, 2], 'the pair');
});

test('negative controls: hoppers in a row into a chest, hoppers facing down: no cycle', () => {
    assert.strictEqual(box([[1, 1, ...hopper('south')], [1, 2, ...hopper('south')], [1, 3, 'minecraft:chest', { facing: 'north', type: 'single', waterlogged: 'false' }]]).cycles().length, 0);
    assert.strictEqual(box([[1, 1, ...hopper('down')], [1, 2, ...hopper('down')]]).cycles().length, 0);
    assert.strictEqual(box([[1, 1, ...hopper('east')], [1, 2, ...hopper('west')]]).cycles().length, 0, 'their supports are cells that stay empty (a scaffold or a pillar there)');
});

test('the job breaks the cycle: a scaffold task in the second cell, the first waits for it, the second gets its own place task back once the first stands', () => {
    const t = box([[1, 1, ...hopper('south')], [1, 2, ...hopper('north')]]);
    const job = new BuildJob(t, { log: () => {} });
    const { cell, via } = t.cycles()[0], A = t.cell(cell), B = t.cell(via), ka = `${A.x},${A.y},${A.z}`, kb = `${B.x},${B.y},${B.z}`;
    job.tasks = new Map([[ka, { k: ka, i: cell, ...A, kind: 'place' }], [kb, { k: kb, i: via, ...B, kind: 'place' }]]);
    job.buckets = new Map();
    const bot = { blockAt: () => ({ name: 'air', getProperties: () => ({}), shapes: [] }) };
    job._breakCycles(bot);
    assert.strictEqual(job.tasks.get(kb).kind, 'scaffold');
    assert.strictEqual(job.tasks.get(kb).for, ka);
    assert.strictEqual(job.tasks.get(ka).waitFor, kb, 'the first block waits for the scaffold');
    // the scaffold stands (its task is done), the first block is placed: the second cell's own block is work again
    job.tasks.delete(kb);
    job._scaffoldServed(ka, 'its block stands');
    assert.strictEqual(job.tasks.get(kb).kind, 'place');
    assert.strictEqual(job.tasks.get(kb).i, via);
    // negative control: without the cycle rule both stay place tasks, and neither has a support to click
    const job2 = new BuildJob(t, { log: () => {} });
    job2.tasks = new Map([[ka, { k: ka, i: cell, ...A, kind: 'place' }], [kb, { k: kb, i: via, ...B, kind: 'place' }]]);
    assert(['place'].includes(job2.tasks.get(kb).kind) && !job2.tasks.get(ka).waitFor);
});

test('the terrain is the pit\'s: the box columns from the highest cell to clear down to the lowest become an open-pit job (negative control: nothing to dig, no pit)', () => {
    const t = box([]);
    const job = new BuildJob(t, { log: () => {} });
    job.tasks = new Map([['1,65,1', { k: '1,65,1', i: t.idx(1, 65, 1), x: 1, y: 65, z: 1, kind: 'clear' }], ['2,66,2', { k: '2,66,2', i: t.idx(2, 66, 2), x: 2, y: 66, z: 2, kind: 'clear' }], ['0,64,0', { k: '0,64,0', i: t.idx(0, 64, 0), x: 0, y: 64, z: 0, kind: 'place' }]]);
    const P = job.planPit();
    assert(P && P.impl && P.impl.ledger, 'a pit job');
    assert.deepStrictEqual(P.box, { x0: 0, x1: 3, z0: 0, z1: 3, top: 66, bottom: 65 });
    assert.strictEqual(job.planPit(), P, 'the same while it runs');
    job.pitDone('test'); assert(P.done && job.stage === 'survey');
    assert.strictEqual(job.planPit(), null, 'not again for the same survey');
    job.tasks = new Map(job.tasks); const P2 = job.planPit(); assert(P2 && P2 !== P, 'a new survey with cells left: round two');
    const j2 = new BuildJob(t, { log: () => {} }); j2.tasks = new Map([['0,64,0', { k: '0,64,0', i: 0, x: 0, y: 64, z: 0, kind: 'place' }]]);
    assert.strictEqual(j2.planPit(), null);
});

test('a run: after a batch along a row the bot steps on along the row and takes the next cells, without a full claim (negative control: at the end of the row, nothing)', () => {
    const { Vec3 } = require('vec3');
    const registry = require('prismarine-registry')('1.21.1'), Chunk = require('prismarine-chunk')(registry), World = require('prismarine-world')(registry);
    const world = new World(null).sync, chunk = new Chunk({ minY: -64, worldHeight: 384 }), stone = registry.blocksByName.stone.defaultState;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), stone);
    for (let x = 0; x < 4; x++) chunk.setBlockStateId(new Vec3(x, 64, 0), stone);                    // placed already
    world.setColumn(0, 0, chunk);
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }], blocks = [];
    for (let x = 0; x < 16; x++) for (let z = 0; z < 3; z++) blocks.push({ x, y: 0, z, s: z === 0 ? 1 : 0 });
    const t = new Target({ size: [16, 1, 3], palette, blocks }, { x: 0, y: 64, z: 0 });
    const job = new BuildJob(t, { log: () => {} }); job.stage = 'place';
    job.tasks = new Map(); for (let x = 4; x < 16; x++) job.tasks.set(`${x},64,0`, { k: `${x},64,0`, i: t.idx(x, 64, 0), x, y: 64, z: 0, kind: 'place' });
    const bot = { registry, world, username: 'a', entity: { position: new Vec3(2.5, 64, 1.5) }, blockAt: (p) => world.getBlock(p) };
    const placed = [0, 1, 2, 3].map((x) => ({ x, y: 64, z: 0 }));
    const nx = job.claimNext(bot, 'a', { station: { x: 2, y: 64, z: 1 }, placed });
    assert(nx && nx.station, 'a next stance');
    assert.strictEqual(nx.station.z, 1); assert(nx.station.x > 2, `on along the row (+x), got ${JSON.stringify(nx.station)}`);
    assert(nx.tasks.some((tk) => tk.x >= 6), 'cells the last stance did not reach');
    assert(nx.tasks.every((tk) => job.claims.get(tk.k) === 'a'));
    // negative control: the row is done beyond the stance
    const job2 = new BuildJob(t, { log: () => {} }); job2.stage = 'place'; job2.tasks = new Map();
    assert.strictEqual(job2.claimNext(bot, 'a', { station: { x: 2, y: 64, z: 1 }, placed }), null);
});

test('a bed is clicked only while its head cell is empty: not from a pillar in that cell (159 beds "got air" in hc1/hd1; negative control: the head cell empty, a way)', () => {
    const { Vec3 } = require('vec3');
    const registry = require('prismarine-registry')('1.21.1'), Chunk = require('prismarine-chunk')(registry), World = require('prismarine-world')(registry);
    const world = new World(null).sync, chunk = new Chunk({ minY: -64, worldHeight: 384 }), stone = registry.blocksByName.stone.defaultState;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), stone);
    world.setColumn(0, 0, chunk);
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:white_bed', props: { facing: 'west', part: 'foot', occupied: 'false' } }, { name: 'minecraft:white_bed', props: { facing: 'west', part: 'head', occupied: 'false' } }];
    const blocks = []; for (let x = 0; x < 6; x++) for (let z = 0; z < 3; z++) blocks.push({ x, y: 0, z, s: x === 3 && z === 1 ? 1 : x === 2 && z === 1 ? 2 : 0 });
    const t = new Target({ size: [6, 1, 3], palette, blocks }, { x: 0, y: 64, z: 0 });
    const job = new BuildJob(t, { log: () => {} });
    const bot = { registry, world, blockAt: (p) => world.getBlock(p) };
    const tk = { k: '3,64,1', i: t.idx(3, 64, 1), x: 3, y: 64, z: 1, kind: 'place' };
    assert(t.recipeOf(tk).room, 'the recipe names the head cell');
    const free = job._way(job._world(bot, null), tk, { x: 5, y: 64, z: 1 });
    assert(free, 'negative control: head cell empty, a way from the floor east of the foot');
    // the stance on a pillar in the head cell (its block in the stance's world)
    assert.strictEqual(job._way(job._world(bot, { x: 2, y: 65, z: 1 }), tk, { x: 2, y: 65, z: 1 }), null, 'no click from a pillar in the head cell');
    chunk.setBlockStateId(new Vec3(2, 64, 1), registry.blocksByName.pumpkin.defaultState);
    assert.strictEqual(job._way(job._world(bot, null), tk, { x: 5, y: 64, z: 1 }), null, 'a temporary block in the head cell: no click');
});

test('a floating trapdoor (facing west, top half) gets its scaffold where a click gives that state: beside it to the east, not below (negative control: a stone block takes the cell below)', () => {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:spruce_trapdoor', props: { facing: 'west', half: 'top', open: 'true', waterlogged: 'false', powered: 'false' } }, { name: 'minecraft:stone', props: {} }];
    const mk = (s) => { const blocks = []; for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) blocks.push({ x, y, z, s: x === 1 && y === 1 && z === 1 ? s : 0 }); return new Target({ size: [3, 3, 3], palette, blocks }, { x: 0, y: 64, z: 0 }); };
    for (const [s, want] of [[1, '2,65,1'], [2, '1,64,1']]) {
        const t = mk(s), job = new BuildJob(t, { log: () => {} }); job.tasks = new Map(); job.buckets = new Map();
        const tk = { k: '1,65,1', i: t.idx(1, 65, 1), x: 1, y: 65, z: 1, kind: 'place' };
        assert(job._scaffoldFor(tk)); const sc = [...job.tasks.values()].find((q) => q.kind === 'scaffold');
        assert.strictEqual(sc.k, want, `${t.stateOf(tk.i).name}: scaffold at ${sc.k}`);
    }
});

test('the way down from a height whose way up is gone: sinking on its own blocks (place one under the floor, dig the floor; negative control: without temporary blocks, no way)', async () => {
    const { Vec3 } = require('vec3');
    const M = require('../src/build/move');
    const registry = require('prismarine-registry')('1.21.1'), Chunk = require('prismarine-chunk')(registry), World = require('prismarine-world')(registry);
    const world = new World(null).sync, chunk = new Chunk({ minY: -64, worldHeight: 384 }), stone = registry.blocksByName.stone.defaultState;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), stone);
    for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) chunk.setBlockStateId(new Vec3(x, 79, z), stone);          // a platform 16 over the ground, nothing under it
    world.setColumn(0, 0, chunk);
    const bot = { registry, world, blockAt: (p) => world.getBlock(p), entity: { position: new Vec3(5.5, 80, 5.5) } };
    const rules = { canDig: (x, y, z, b) => b.name === 'pumpkin', temp: () => 'pumpkin' };
    const goal = (x, y, z) => y === 64 && x === 9 && z === 5;
    const r = await M.plan(new M.View(bot, rules), { x: 5, y: 80, z: 5 }, goal, { x: 9, y: 64, z: 5 }, { temps: 64, maxNodes: 20000, maxDrop: 4 });
    assert(r, 'a way down');
    const sinks = r.filter((s0) => s0.move === 'sink');
    assert(sinks.length >= 8, `sinks ${sinks.length}: ${r.map((s0) => s0.move).join(' ')}`);
    assert(sinks.every((s0) => s0.place && s0.sink && s0.place.y === s0.sink.y - 1 && s0.y === s0.sink.y), 'each places under the floor and stands where the floor was');
    const none = await M.plan(new M.View(bot, rules), { x: 5, y: 80, z: 5 }, goal, { x: 9, y: 64, z: 5 }, { temps: 0, maxNodes: 20000, maxDrop: 4 });
    assert.strictEqual(none, null, 'negative control: no temporary blocks, no way down');
});

test('the pit hands its movement blocks over: what the work layer lists as the bot\'s and still stands becomes a released entry of the build ledger (negative control: a block gone, another bot\'s)', () => {
    const { Temps } = require('../src/work/bot/temps');
    const D = require('../src/build/drive');
    const t = box([]);
    const job = new BuildJob(t, { log: () => {} }); job.tasks = new Map(); job.buckets = new Map();
    const world = new Map([['2,65,2', 'pumpkin'], ['3,65,3', 'pumpkin']]);
    const reg = new Temps();
    reg.add({ dim: 'overworld', x: 2, y: 65, z: 2, item: 'pumpkin', kind: 'pillar', by: 'a' });
    reg.add({ dim: 'overworld', x: 1, y: 66, z: 1, item: 'pumpkin', kind: 'pillar', by: 'a' });          // dug already
    reg.add({ dim: 'overworld', x: 3, y: 65, z: 3, item: 'pumpkin', kind: 'pillar', by: 'b' });          // another bot's
    const bot = { username: 'a', __temps: reg, game: { dimension: 'minecraft:overworld' }, blockAt: (p) => { const n = world.get(`${p.x},${p.y},${p.z}`) || 'air'; return { name: n, getProperties: () => ({}), boundingBox: n === 'air' ? 'empty' : 'block', shapes: n === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] }; } };
    const n = D.adoptWorkTemps(job, 'a', bot, { x0: 0, x1: 3, z0: 0, z1: 3, top: 66, bottom: 64 });
    assert.strictEqual(n, 1);
    const e = job.ledger.get({ x: 2, y: 65, z: 2 }); assert(e && e.released && e.by === 'a' && e.state === 'placed');
    assert(!job.ledger.get({ x: 1, y: 66, z: 1 }) && !job.ledger.get({ x: 3, y: 65, z: 3 }));
    assert(!reg.has('overworld', { x: 2, y: 65, z: 2 }) && reg.has('overworld', { x: 3, y: 65, z: 3 }), 'out of the work list, the other bot\'s stays');
    assert(job.tasks.get('2,65,2') && job.tasks.get('2,65,2').kind === 'untemp', 'an untemp task at once');
});

test('no placement closes the last way out of the space a crew member is in (a room of the build with one opening; negative controls: another cell, nobody inside)', () => {
    const { Vec3 } = require('vec3');
    const D = require('../src/build/drive');
    const registry = require('prismarine-registry')('1.21.1'), Chunk = require('prismarine-chunk')(registry), World = require('prismarine-world')(registry);
    const world = new World(null).sync, chunk = new Chunk({ minY: -64, worldHeight: 384 }), stone = registry.blocksByName.stone.defaultState;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), stone);
    // a 5 x 5 room (inside 1..3) of walls 64..66 and a ceiling at 67, its opening two high at 4,64..65,2; a block in its lower cell leaves a one-high gap, no way out
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) for (let y = 64; y <= 67; y++) { const wall = x === 0 || x === 4 || z === 0 || z === 4 || y === 67; if (wall) chunk.setBlockStateId(new Vec3(x, y, z), stone); }
    chunk.setBlockStateId(new Vec3(4, 64, 2), 0); chunk.setBlockStateId(new Vec3(4, 65, 2), 0);
    world.setColumn(0, 0, chunk);
    const palette = [{ name: 'minecraft:air', props: {} }], blocks = []; for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) for (let y = 0; y < 8; y++) blocks.push({ x, y, z, s: 0 });
    const t = new Target({ size: [12, 8, 12], palette, blocks }, { x: -2, y: 63, z: -2 });
    const job = new BuildJob(t, { log: () => {} });
    const mk = (x, y, z) => ({ username: 'a', players: {}, registry, world, entity: { position: new Vec3(x + 0.5, y, z + 0.5) }, blockAt: (p) => world.getBlock(p) });
    assert.strictEqual(D.closesIn(job, mk(2, 64, 2), { x: 4, y: 64, z: 2 }), true, 'the opening closes the bot in');
    assert.strictEqual(D.closesIn(job, mk(2, 64, 2), { x: 2, y: 64, z: 3 }), false, 'negative control: a cell inside');
    assert.strictEqual(D.closesIn(job, mk(8, 64, 8), { x: 4, y: 64, z: 2 }), false, 'negative control: nobody inside');
});

(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log(`  ok ${name}`); } console.log(`test_build_order_pure: ${n} passed`); })().catch((e) => { console.error(e); process.exit(1); });

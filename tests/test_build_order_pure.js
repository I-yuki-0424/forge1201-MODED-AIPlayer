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

test('the terrain is the pit\'s: the box columns from the highest cell to clear down to the lowest become an open-pit job (negative control: nothing to dig, no pit; BUILD_PIT=0)', () => {
    const t = box([]);
    const job = new BuildJob(t, { log: () => {} });
    job.tasks = new Map([['1,65,1', { k: '1,65,1', i: t.idx(1, 65, 1), x: 1, y: 65, z: 1, kind: 'clear' }], ['2,66,2', { k: '2,66,2', i: t.idx(2, 66, 2), x: 2, y: 66, z: 2, kind: 'clear' }], ['0,64,0', { k: '0,64,0', i: t.idx(0, 64, 0), x: 0, y: 64, z: 0, kind: 'place' }]]);
    const P = job.planPit();
    assert(P && P.impl && P.impl.ledger, 'a pit job');
    assert.deepStrictEqual(P.box, { x0: 0, x1: 3, z0: 0, z1: 3, top: 66, bottom: 65 });
    assert.strictEqual(job.planPit(), P, 'planned once');
    job.pitDone('test'); assert(P.done && job.stage === 'survey');
    const j2 = new BuildJob(t, { log: () => {} }); j2.tasks = new Map([['0,64,0', { k: '0,64,0', i: 0, x: 0, y: 64, z: 0, kind: 'place' }]]);
    assert.strictEqual(j2.planPit(), null);
    process.env.BUILD_PIT = '0'; const j3 = new BuildJob(t, { log: () => {} }); j3.tasks = job.tasks; assert.strictEqual(j3.planPit(), null); delete process.env.BUILD_PIT;
});

(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log(`  ok ${name}`); } console.log(`test_build_order_pure: ${n} passed`); })().catch((e) => { console.error(e); process.exit(1); });

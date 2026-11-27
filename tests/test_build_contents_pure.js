'use strict';
// The blueprint's container contents in the builder (TASK-20261125-081, owner addendum 3: the Nether blueprint's sorter filters): the Target carries one goal per container
// and item (its items in the bill), the job offers it in the late stage once its container stands as the blueprint has it, not again once done; the item need is the goal's
// count. Negative controls: a container not yet placed gives no task; a done goal comes back no more.
const assert = require('assert');
const { Target } = require('../src/build/target');
const { BuildJob } = require('../src/build/job');

let n = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

function fakeBot(world, pos = { x: 0.5, y: 70, z: 0.5 }) {
    return {
        username: 'a', players: {},
        entity: { position: { ...pos, floored() { return this; } } },
        blockAt(p) {
            const s = world.get(`${p.x},${p.y},${p.z}`) || { name: 'air', props: {} };
            const empty = s.empty || /^(air|water|lava)$/.test(s.name);
            return { name: s.name, getProperties: () => s.props || {}, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]] };
        },
    };
}

function bp() {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:hopper', props: { facing: 'down', enabled: 'true' } }];
    const blocks = [];
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { blocks.push({ x, y: 0, z, s: 1 }); blocks.push({ x, y: 2, z, s: 0 }); if (!(x === 1 && z === 1)) blocks.push({ x, y: 1, z, s: 0 }); }
    blocks.push({ x: 1, y: 1, z: 1, s: 2, nbt: { Items: [{ Slot: 0, id: 'minecraft:iron_ingot', count: 18 }, { Slot: 1, id: 'minecraft:stick', count: 1 }, { Slot: 2, id: 'minecraft:stick', count: 1 }] } });
    return { size: [3, 3, 3], palette, blocks };
}

test('a container\'s contents: a goal per item with its slots, in the bill; a late task once the container stands, not before, not again once done', async () => {
    const t = new Target(bp(), { x: 10, y: 64, z: 10 });
    assert.deepStrictEqual(t.contents.map((g) => [g.k, g.count, g.slots.length]), [['contents@11,65,11:iron_ingot', 18, 1], ['contents@11,65,11:stick', 2, 2]]);
    assert.strictEqual(t.items.get('iron_ingot'), 18); assert.strictEqual(t.items.get('stick'), 2); assert.strictEqual(t.items.get('hopper'), 1);
    const w = new Map(); for (let x = 10; x < 13; x++) for (let z = 10; z < 13; z++) w.set(`${x},64,${z}`, { name: 'stone' });
    const job = new BuildJob(t, {});
    await job.resurvey(fakeBot(w), 'test');
    assert(![...job.tasks.values()].some((tk) => tk.kind === 'contents'), 'negative control: no hopper yet, no contents task');
    w.set('11,65,11', { name: 'hopper', props: { facing: 'down', enabled: 'true' } });
    await job.resurvey(fakeBot(w), 'test');
    const ct = [...job.tasks.values()].filter((tk) => tk.kind === 'contents');
    assert.strictEqual(ct.length, 2); assert.strictEqual(job.stage, 'late');
    const iron = ct.find((tk) => tk.item === 'iron_ingot');
    assert.strictEqual(job._itemOf(iron), 'iron_ingot'); assert.strictEqual(job._countOf(iron), 18);
    (job.contentsDone = new Set()).add(iron.k);
    await job.resurvey(fakeBot(w), 'test');
    assert.deepStrictEqual([...job.tasks.values()].filter((tk) => tk.kind === 'contents').map((tk) => tk.item), ['stick'], 'a done goal comes back no more');
});

test('a closed container (no face open in the finished build): its goal is place-stage work as soon as it is placed, and the block that would close its last open face waits for it; negative controls: two faces open, or the goal done', async () => {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:dropper', props: { facing: 'up', triggered: 'false' } }];
    const blocks = []; for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) blocks.push({ x, y, z, s: x === 1 && y === 1 && z === 1 ? 2 : 1 });
    blocks.find((b) => b.s === 2).nbt = { Items: [{ Slot: 4, id: 'minecraft:iron_ingot', count: 64 }] };
    const t = new Target({ size: [3, 3, 3], palette, blocks }, { x: 0, y: 64, z: 0 });
    assert.strictEqual(t.contents.length, 1); assert.strictEqual(t.contents[0].closed, true);
    const w = new Map(); for (let x = 0; x < 3; x++) for (let y = 64; y < 67; y++) for (let z = 0; z < 3; z++) w.set(`${x},${y},${z}`, { name: 'stone' });
    w.set('1,65,1', { name: 'dropper', props: { facing: 'up', triggered: 'false' } }); w.delete('1,66,1'); w.delete('1,65,0');
    const job = new BuildJob(t, {}), bot = fakeBot(w);
    const top = { k: '1,66,1', x: 1, y: 66, z: 1, kind: 'place' };
    assert.strictEqual(job._closesUnfilled(top, bot), false, 'negative control: two faces open, this one is not the last');
    w.set('1,65,0', { name: 'stone' });
    assert.strictEqual(job._closesUnfilled(top, bot), true, 'the last open face waits');
    job.buckets = new Map(); job._contentsAfter({ k: '1,65,1' });
    const ct = job.tasks.get('contents@1,65,1:iron_ingot'); assert(ct && ct.stageAs === 'place', 'place-stage work at its placement');
    (job.contentsDone = new Set()).add(ct.k);
    assert.strictEqual(job._closesUnfilled(top, bot), false, 'negative control: the goal done, the face may close');
});

(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log(`  ok ${name}`); } console.log(`test_build_contents_pure: ${n} passed`); })().catch((e) => { console.error(e); process.exit(1); });

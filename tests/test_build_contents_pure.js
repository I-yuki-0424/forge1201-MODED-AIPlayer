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

test('a closed container is placed by a bot carrying its contents too (b081y5: the goal made a task after the placement needed a second walk into the Nether box, \'no plan\'); negative controls: an open container needs its block only, a done or out-of-stock goal is not carried', () => {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:dropper', props: { facing: 'up', triggered: 'false' } }];
    const mk = (open) => { const blocks = []; for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) blocks.push({ x, y, z, s: x === 1 && y === 1 && z === 1 ? 2 : (open && x === 1 && y === 2 && z === 1 ? 0 : 1) });
        blocks.find((b) => b.s === 2).nbt = { Items: [{ Slot: 4, id: 'minecraft:iron_ingot', count: 64 }] }; return new Target({ size: [3, 3, 3], palette, blocks }, { x: 0, y: 64, z: 0 }); };
    const place = { k: '1,65,1', x: 1, y: 65, z: 1, i: 0, kind: 'place' };
    const job = new BuildJob(mk(false), {}); place.i = job.t.idx(1, 65, 1);
    assert.deepStrictEqual(job._needs(place), [['dropper', 1], ['iron_ingot', 64]]);
    const has = (m) => (it) => m[it] || 0;
    assert.strictEqual(job._carries(place, has({ dropper: 1 })), false, 'the block alone is not enough');
    assert.strictEqual(job._carries(place, has({ dropper: 1, iron_ingot: 64 })), true);
    assert.deepStrictEqual(job._addNeeds({}, place), { dropper: 1, iron_ingot: 64 });
    assert.deepStrictEqual(job._addNeeds({}, place, (it) => it === 'iron_ingot'), { dropper: 1 }, 'skip leaves an item out');
    const open = new BuildJob(mk(true), {});
    assert.deepStrictEqual(open._needs({ ...place, i: open.t.idx(1, 65, 1) }), [['dropper', 1]], 'negative control: an open container is filled late');
    (job.contentsDone = new Set()).add('contents@1,65,1:iron_ingot');
    assert.deepStrictEqual(job._needs(place), [['dropper', 1]], 'negative control: the goal done');
    job.contentsDone.clear(); job.available = new Set(['dropper']);
    assert.deepStrictEqual(job._needs(place), [['dropper', 1]], 'negative control: out of stock, the block is not held for it');
});

test('the walk to a stance: 1.5 s and 30 000 cells while the build is large, 6 s and 80 000 in the tail (b081w4: the last 53 cells parked after searches ran out of time); negative control: a large task list keeps the short budget', async () => {
    const D = require('../src/build/drive');
    for (const [size, want, kind] of [[10, [80000, 6000]], [5000, [30000, 1500]], [5000, [80000, 6000], 'contents']]) {
        const job = { tasks: new Map(Array.from({ length: size }, (_, i) => [String(i), {}])), noPath: new Map(), time: { walk: 0 }, log: () => {}, avoid: () => {} };
        let got = null; const mv = { goto: async (_, o) => { got = [o.maxNodes, o.budgetMs]; return { ok: false, why: 'test', nodes: 500 }; } };
        await D.work(job, 'a', {}, mv, { station: { x: 0, y: 70, z: 0 }, tasks: kind ? [{ kind, k: 'c', x: 0, y: 70, z: 1 }] : [] }, { cancelled: false });
        assert.deepStrictEqual(got, want);
    }
});

test('the respawn anchor is charged again below two charges (b081x5: four respawns used its charges, the fifth woke in the Overworld); negative controls: full, not loaded, none set', () => {
    const D = require('../src/build/drive');
    const bot = (c) => ({ blockAt: () => (c === null ? null : { name: 'respawn_anchor', getProperties: () => ({ charges: String(c) }) }) });
    const job = { anchorAt: { x: 1, y: 2, z: 3 } };
    assert.strictEqual(D.lowAnchor(job, bot(1)), true); assert.strictEqual(D.lowAnchor(job, bot(0)), true);
    assert.strictEqual(D.lowAnchor(job, bot(4)), false, 'full'); assert.strictEqual(D.lowAnchor(job, bot(null)), false, 'not loaded'); assert.strictEqual(D.lowAnchor({}, bot(0)), false, 'none set');
});

test('a block under a corner of the body is not dug (b081y4: a bot at its cell edge stood on the neighbour and fell 48 when it was dug); negative control: a cell beside the body', () => {
    const D = require('../src/build/drive');
    const bot = { entity: { position: { x: 253.5, y: 120, z: -25.2 } } };          // feet in -26, the box reaches into -25
    assert.strictEqual(D.underBody(bot, { x: 253, y: 119, z: -25 }), true);
    assert.strictEqual(D.underBody(bot, { x: 253, y: 119, z: -26 }), true, 'the feet cell itself');
    assert.strictEqual(D.underBody(bot, { x: 254, y: 119, z: -25 }), false, 'negative control: a cell beside the body');
    assert.strictEqual(D.underBody(bot, { x: 253, y: 118, z: -25 }), false, 'negative control: lower');
});

test('a sector counts as busy only by bots that hold a claim now (b081y4: two stale stations closed the sector of the last 332 ready cells); negative control: a bot with a claim counts', () => {
    const t = new Target(bp(), { x: 10, y: 64, z: 10 }), job = new BuildJob(t, {});
    const st = (x, z) => ({ station: [{ x, y: 65, z }, { x, y: 66, z }] });
    job.bots.set('b', st(11, 11)); job.bots.set('c', st(11, 11));
    job.sectorOf('a'); const si = job.sectorAt(11, 11); assert(si >= 0, 'the sectors are planned');
    assert.strictEqual(job._busySectors('a').get(si), undefined, 'stale stations: nobody at work there');
    job.claims.set('11,65,11', 'b');
    assert.strictEqual(job._busySectors('a').get(si), 1, 'negative control: the bot with a claim counts');
    assert.strictEqual(job._busySectors('b').get(si), undefined, 'the asking bot itself is left out');
});

(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log(`  ok ${name}`); } console.log(`test_build_contents_pure: ${n} passed`); })().catch((e) => { console.error(e); process.exit(1); });

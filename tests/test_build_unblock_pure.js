'use strict';
// Closed-in cells (src/build/job.js `_unblock`) and getting a block back by breaking it (src/build/recover.js), without a server: vanilla loot tables of the 1.20.1 registry.
// A cell the build closed in on every side gets a dig-out of the one neighbour that opens a click, only when the crew gets that block back (a tool that returns it, or a spare in
// the supply), and the block goes back only after the closed cell is placed.
const assert = require('assert');
const registry = require('prismarine-registry')('1.20.1');
const RC = require('../src/build/recover');
const { Target } = require('../src/build/target');
const { BuildJob } = require('../src/build/job');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const item = (name, enchants = []) => ({ name, type: registry.itemsByName[name].id, count: 1, components: enchants.length ? [{ type: 'enchantments', data: { enchantments: enchants.map((e) => ({ id: `minecraft:${e}`, level: 1 })) } }] : [] });
function fakeBot(world, items = []) {
    return {
        username: 'b1', registry,
        entity: { position: { x: 1.5, y: 68, z: 1.5 } },
        inventory: { items: () => items },
        blockAt(p) {
            const s = world.get(`${p.x},${p.y},${p.z}`) || { name: 'air', props: {} }, empty = /^(air|water|lava)$/.test(s.name);
            return { name: s.name, getProperties: () => s.props || {}, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]] };
        },
    };
}

test('recover: glass comes back only with Silk Touch; smooth stone with a pickaxe; obsidian not with an iron one; stone gives cobblestone', () => {
    const plain = fakeBot(new Map(), [item('diamond_pickaxe')]), silky = fakeBot(new Map(), [item('diamond_pickaxe'), item('iron_pickaxe', ['silk_touch'])]);
    assert.strictEqual(RC.getBack(plain, 'glass', 'glass').ok, false);
    assert.match(RC.getBack(plain, 'glass', 'glass').why, /Silk Touch/);
    const g = RC.getBack(silky, 'glass', 'glass'); assert.ok(g.ok); assert.strictEqual(g.tool.name, 'iron_pickaxe');
    assert.strictEqual(RC.getBack(silky, 'smooth_stone', 'smooth_stone').tool.name, 'diamond_pickaxe', 'Silk Touch is kept for where it is needed');
    assert.strictEqual(RC.getBack(fakeBot(new Map(), [item('iron_pickaxe')]), 'obsidian', 'obsidian').ok, false);
    assert.ok(RC.getBack(plain, 'obsidian', 'obsidian').ok);
    assert.strictEqual(RC.getBack(plain, 'stone', 'stone').ok, false);
    assert.ok(RC.getBack(plain, 'hopper', 'hopper').ok);
    assert.ok(RC.getBack(plain, 'redstone_wall_torch', 'redstone_torch').ok, 'no loot table of its own: its drop list (hd1)');
    assert.strictEqual(RC.getBack(fakeBot(new Map(), []), 'smooth_stone', 'smooth_stone').ok, false, 'by hand smooth stone drops nothing');
});

test('recover: a registered rule decides first (a mod tool that gives glass back)', () => {
    RC.register(({ block, tool }) => (block === 'glass' && tool && tool.name === 'golden_pickaxe' ? true : undefined));
    assert.ok(RC.getBack(fakeBot(new Map(), [item('golden_pickaxe')]), 'glass', 'glass').ok);
});

/** 3 x 3 x 3: a smooth stone floor, the closed cell (stone) in the middle with glass on its four sides, `top` over it; the world has everything built but the middle. */
function scene(top) {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:smooth_stone', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:glass', props: {} }, { name: `minecraft:${top}`, props: {} }];
    const blocks = [], w = new Map();
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
        blocks.push({ x, y: 0, z, s: 1 }); w.set(`${x},64,${z}`, { name: 'smooth_stone' });
        const side = (x === 1) !== (z === 1);
        blocks.push({ x, y: 1, z, s: x === 1 && z === 1 ? 2 : side ? 3 : 0 }); if (side) w.set(`${x},65,${z}`, { name: 'glass' });
        blocks.push({ x, y: 2, z, s: x === 1 && z === 1 ? 4 : 0 }); if (x === 1 && z === 1) w.set(`${x},66,${z}`, { name: top });
    }
    return { t: new Target({ size: [3, 3, 3], palette, blocks }, { x: 0, y: 64, z: 0 }), w };
}
async function closed(top, items, totals = {}) {
    const { t, w } = scene(top), bot = fakeBot(w, items), job = new BuildJob(t, { available: new Set(['smooth_stone', 'stone', 'glass', top]) });
    job.log = () => {}; job.supply = { totals };
    await job.resurvey(bot, 'test');
    const seed = job.tasks.get('1,65,1');
    assert.ok(seed && seed.kind === 'place', 'the closed cell is to place');
    const cands = [{ f: { x: 1, y: 67, z: 1 }, standing: true }];
    const sees = !!job._way(job._world(bot, null), seed, cands[0].f);
    return { job, bot, seed, cands, sees };
}

test('unblock: a smooth stone over the closed cell is dug out (a pickaxe gives it back) and goes back after the cell', async () => {
    const { job, bot, seed, cands, sees } = await closed('smooth_stone', [item('diamond_pickaxe')]);
    // (since the under-the-feet placement, owner ruling 2026-11-26, the closed cell has a click from on top of the block over it: no dig-out is needed there; the dig-out
    // itself, for a cell no stance reaches, is still what this test checks)
    assert.strictEqual(sees, true, 'a click from on top, under the feet');
    assert.ok(job._unblock(bot, 'b1', seed, cands));
    const d = job.tasks.get('1,66,1');
    assert.strictEqual(d.kind, 'clear'); assert.strictEqual(d.after, 'place'); assert.strictEqual(d.waitFor, '1,65,1'); assert.ok(d.digBy.has('b1'));
    assert.strictEqual(job._unblock(bot, 'b1', seed, cands), false, 'once per closed cell');
    // dug: the task turns into its placing, which waits for the closed cell
    job.report('b1', [{ tk: d, ok: true }]);
    assert.strictEqual(job.tasks.get('1,66,1').kind, 'place');
    const now = Date.now() + 1000;
    assert.strictEqual(job.ready(job.tasks.get('1,66,1'), bot, now), false, 'not before the closed cell');
    job.tasks.delete('1,65,1');
    assert.strictEqual(job.ready(job.tasks.get('1,66,1'), bot, now), true, 'after it');
});

test('unblock: glass over it is not dug out without Silk Touch and no spare; with a spare it is (and counted), with Silk Touch it comes back', async () => {
    const a = await closed('glass', [item('diamond_pickaxe')]);
    assert.strictEqual(a.job._unblock(a.bot, 'b1', a.seed, a.cands), false);
    assert.ok(!a.job.tasks.has('1,66,1'));
    const b = await closed('glass', [item('diamond_pickaxe')], { glass: 10 });          // the blueprint needs 5 glass
    assert.ok(b.job._unblock(b.bot, 'b1', b.seed, b.cands));
    assert.strictEqual(b.job.tasks.get('1,66,1').loses, 'glass'); assert.strictEqual(b.job.tasks.get('1,66,1').digBy, null);
    assert.strictEqual(b.job.spareOf('glass'), 4, 'the spare is taken when the dig-out is made');
    const c = await closed('glass', [item('diamond_pickaxe'), item('iron_pickaxe', ['silk_touch'])]);
    assert.ok(c.job._unblock(c.bot, 'b1', c.seed, c.cands));
    assert.ok(c.job.tasks.get('1,66,1').digBy.has('b1'));
});

test('a clear task with a placing after it is not dropped when its cell is empty', async () => {
    const { job, bot, seed, cands } = await closed('smooth_stone', [item('diamond_pickaxe')]);
    job._unblock(bot, 'b1', seed, cands);
    const d = job.tasks.get('1,66,1');
    assert.strictEqual(job._already(d, fakeBot(new Map(), [])), false);
});

test('after the pit\'s rounds a block of the build in a cell that is to be empty stays the crew\'s to dig (a piston moved it); terrain there is parked as left by the pit (negative control)', async () => {
    const { t, w } = scene('smooth_stone');
    w.set('0,66,0', { name: 'glass' }); w.set('2,66,2', { name: 'dirt' });          // corners of the top layer are air in the blueprint
    const job = new BuildJob(t, { available: new Set(['smooth_stone', 'stone', 'glass']) });
    job.log = () => {}; job.supply = { totals: {} }; job.pitRounds = 3;
    await job.resurvey(fakeBot(w, []), 'test');
    assert.strictEqual((job.tasks.get('0,66,0') || {}).kind, 'clear', 'glass: the crew digs it');
    assert.ok(!job.tasks.has('2,66,2') && job.parked.get('2,66,2') === 'left by the pit', 'dirt: the pit\'s');
});

(async () => {
    let n = 0;
    for (const [name, fn] of queue) { await fn(); n++; console.log(`ok - ${name}`); }
    console.log(`unblock + recover: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });

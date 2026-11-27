'use strict';
// Out of stock (src/build/job.js stock, drive.js outOfStock; TASK-20261125-081): cells whose item nobody has any more (no container, no pack, nothing on the ground) are parked,
// so the place stage ends and the late stage lights the portals (b081q5, Fabric 1.21.1: the stock ran out with 276 cells left, the place stage never ended, 36 portals unlit).
// An item that comes back brings its cells back. Negative controls: with the item still in stock the stage stays 'place'; an item held in a pack or lying on the site is not out.
const assert = require('assert');
const { Target } = require('../src/build/target');
const { BuildJob } = require('../src/build/job');
const D = require('../src/build/drive');

/** x 0: an obsidian frame along z (z 0..3, y 0..4) round a 2 x 3 portal; x 1: a stone floor with a repeater on it at z 1. Origin 0,64,0. */
function portal() {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:obsidian', props: {} }, { name: 'minecraft:nether_portal', props: { axis: 'z' } },
        { name: 'minecraft:stone', props: {} }, { name: 'minecraft:repeater', props: { facing: 'north', delay: '1' } }];
    const blocks = [];
    for (let x = 0; x < 2; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 4; z++) {
        let s = 0;
        if (x === 0) s = (y === 0 || y === 4 || z === 0 || z === 3) ? 1 : 2;
        else if (y === 0) s = 3;
        else if (y === 1 && z === 1) s = 4;
        blocks.push({ x, y, z, s });
    }
    return new Target({ size: [2, 5, 4], palette, blocks }, { x: 0, y: 64, z: 0 });
}
function fakeBot(world) {
    return {
        username: 'fake', entity: { position: { x: 3.5, y: 65, z: 0.5, floored() { return this; } } },
        blockAt(p) {
            if (Math.abs(p.x) > 50 || Math.abs(p.z) > 50) return null;
            const s = world.get(`${p.x},${p.y},${p.z}`) || { name: p.y < 64 ? 'dirt' : 'air', props: {} };
            const empty = /^(air|nether_portal|repeater)$/.test(s.name);
            return { name: s.name, getProperties: () => s.props || {}, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]] };
        },
    };
}
/** The world with the frame up but its top middle (0,68,1), the floor, and the repeater if `rep`. */
function world(rep) {
    const w = new Map();
    for (let y = 0; y < 5; y++) for (let z = 0; z < 4; z++) if ((y === 0 || y === 4 || z === 0 || z === 3) && !(y === 4 && z === 1)) w.set(`0,${64 + y},${z}`, { name: 'obsidian', props: {} });
    for (let z = 0; z < 4; z++) w.set(`1,64,${z}`, { name: 'stone', props: {} });
    if (rep) w.set('1,65,1', { name: 'repeater', props: { facing: 'north', delay: '1', powered: 'false', locked: 'false' } });
    return w;
}

(async () => {
    const t = portal();
    const supply = () => new Set(['obsidian', 'stone', 'repeater', 'flint_and_steel']);
    // negative control: the obsidian still in stock, the repeater placed: the obsidian cell holds the place stage, no lighting
    {
        const job = new BuildJob(t, { available: supply() }); job.log = () => {};
        await job.resurvey(fakeBot(world(true)), 'test');
        assert.strictEqual(job.stage, 'place', 'negative control: an item in stock keeps its cell in the stage');
        assert.ok(job.tasks.has('0,68,1'));
    }
    // out of obsidian: its cell parked, the repeater still to place keeps the stage; once it stands the stage is the late one (the lighting)
    {
        const job = new BuildJob(t, { available: supply() }); const logs = []; job.log = (m) => logs.push(m);
        await job.resurvey(fakeBot(world(false)), 'test');
        assert.strictEqual(job.stage, 'place');
        let r = job.stock(new Set(['obsidian']));
        assert.deepStrictEqual(r, { parked: 1, back: 0 });
        assert.ok(/^out of stock: obsidian/.test(job.parked.get('0,68,1')));
        assert.ok(job.tasks.has('1,65,1') && !job.exhausted(), 'the repeater is still placing work');
        await job.resurvey(fakeBot(world(true)), 'test');
        assert.strictEqual(job.stage, 'late', 'only out-of-stock cells left: the late stage');
        assert.ok([...job.tasks.values()].some((tk) => tk.kind === 'ignite'));
        assert.ok(!job.tasks.has('0,68,1'), 'the survey parks it again (out of stock)');
        // the item is back (a stack picked up, put into the chest): its cell is placing work again
        r = job.stock(new Set());
        assert.deepStrictEqual(r, { parked: 0, back: 1 });
        assert.ok(job.tasks.has('0,68,1') && job.available.has('obsidian'));
        // the revive of parked cells does not bring an out-of-stock cell back
        job.stock(new Set(['obsidian']));
        job._revive(Date.now() + 3600000);
        assert.ok(!job.tasks.has('0,68,1'), 'not revived while out of stock');
    }
    console.log('  ok cells of an item nobody has are parked, the stage ends and the portals are next; the item back brings them back');
    // drive.outOfStock: out only when every container was seen without it AND no pack holds it AND none lies on the site
    {
        const job = { t, outOf: new Map([['obsidian', Date.now() - 1], ['repeater', Date.now() + 1000]]), packs: new Map([['A', { repeater: 2 }]]), itemWatch: { ground: () => ({}) }, sites: [{ holdsAll: {} }], depot: [] };
        assert.deepStrictEqual([...D.outOfStock(job)], ['obsidian'], 'repeater in a pack: not out (negative control)');
        job.sites[0].holdsAll = { obsidian: 5 };
        assert.deepStrictEqual([...D.outOfStock(job)], [], 'obsidian in the chest as last read (a box the trip did not get to): not out (negative control)');
        job.sites[0].holdsAll = {}; job.depot = [{ holds: { obsidian: 2 } }];
        assert.deepStrictEqual([...D.outOfStock(job)], [], 'obsidian in a depot box: not out');
        job.depot = [];
        job.itemWatch = { ground: () => ({ obsidian: 3 }) };
        assert.deepStrictEqual([...D.outOfStock(job)], [], 'obsidian lying on the site: not out (negative control)');
        job.outOf = new Map();
        assert.deepStrictEqual([...D.outOfStock(job)], [], 'no trip saw the containers without it');
    }
    console.log('  ok an item is out only when no container, no pack and no stack on the site has it');
    // supply boxes in the pack told by name too (supply.supplyBoxes): a box whose contents the client does not show is the supply's unless the blueprint builds with it
    {
        const SUP = require('../src/build/supply');
        const box = (slot, contents) => ({ name: 'white_shulker_box', slot, count: 1, components: contents ? [{ type: 'container', data: { contents: contents.map(([id, n]) => ({ itemId: id, itemCount: n })) } }] : [] });
        const bot = { registry: { items: { 1: { name: 'smooth_stone' } } }, inventory: { items: () => [box(10, null), box(11, [[1, 64]]), { name: 'glass', slot: 12, count: 64 }] } };
        assert.deepStrictEqual(SUP.supplyBoxes(bot, new Set(['glass'])).map((i) => i.slot), [10, 11], 'a box with no contents shown is the supply\'s (not a blueprint item)');
        assert.deepStrictEqual(SUP.supplyBoxes(bot, new Set(['white_shulker_box'])).map((i) => i.slot), [11], 'negative control: the blueprint builds with that box: only the one with contents');
    }
    console.log('  ok a supply box in the pack is told by name when its contents are not shown');
    console.log('test_build_stock_pure: 3 passed');
})().catch((e) => { console.error(e); process.exit(1); });

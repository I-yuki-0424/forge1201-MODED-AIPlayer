'use strict';
// A body on a partial block and the second cell of a two-cell block (TASK-20261125-081; owner 2026-11-27, b081r4 world 4, Fabric 1.21.1, native physics): (1) feet() puts a
// body standing on a slab or a bed into the cell over it, so the planner has a start (Bd4a on a floating slab had feet in the slab's cell, 'no more cells, 1 cells' 49 times,
// and only jumped); (2) from such a start a bridge clicks the partial block's side, no pillar and no jump one higher (the jump's peak from 0.5 stays under the cell over the feet);
// (3) a bed whose head cell covers a body is not placed (a bot's feet embedded in its own bed). Negative controls: a body on a full block keeps its cell; in the air the old
// rule; a full floor still pillars; a bed whose head cell is free is placeable; a body beside the head cell does not hold it.
const assert = require('assert');
const { Vec3 } = require('vec3');
const M = require('../src/build/move');
const D = require('../src/build/drive');

const SLAB = [[0, 0, 0, 1, 0.5, 1]], BED = [[0, 0, 0, 1, 0.5625, 1]], FULL = [[0, 0, 0, 1, 1, 1]];
function fakeBot(world, pos, onGround = true) {
    return {
        username: 'b1', players: {},
        entity: { position: new Vec3(pos.x, pos.y, pos.z), onGround },
        inventory: { items: () => [{ name: 'pumpkin', count: 32 }] },
        blockAt(p) {
            const s = world.get(`${p.x},${p.y},${p.z}`);
            if (!s) return { name: 'air', getProperties: () => ({}), boundingBox: 'empty', shapes: [] };
            return { name: s.name, getProperties: () => s.props || {}, boundingBox: 'block', shapes: s.shapes || FULL };
        },
    };
}

(async () => {
    // 1. feet()
    {
        const w = new Map([['0,76,0', { name: 'smooth_stone_slab', shapes: SLAB }], ['5,76,0', { name: 'white_bed', shapes: BED }], ['9,75,0', { name: 'stone' }]]);
        assert.deepStrictEqual(M.feet(fakeBot(w, { x: 0.5, y: 76.5, z: 0.5 })), { x: 0, y: 77, z: 0 }, 'on a slab: the cell over it');
        assert.deepStrictEqual(M.feet(fakeBot(w, { x: 5.5, y: 76.5625, z: 0.5 })), { x: 5, y: 77, z: 0 }, 'on a bed: the cell over it');
        assert.deepStrictEqual(M.feet(fakeBot(w, { x: 9.5, y: 76, z: 0.5 })), { x: 9, y: 76, z: 0 }, 'negative control: on a full block, its own cell');
        assert.deepStrictEqual(M.feet(fakeBot(w, { x: 0.5, y: 76.5, z: 0.5 }, false)), { x: 0, y: 76, z: 0 }, 'negative control: in the air, the plain rule');
        // on the edge of a block beside its cell (the centre over air): that block's column
        assert.deepStrictEqual(M.feet(fakeBot(w, { x: 10.2, y: 76, z: 0.5 })), { x: 9, y: 76, z: 0 }, 'on the edge of the block beside');
    }
    console.log('  ok feet(): over a slab or a bed, on the edge of the block beside; a full block and the air unchanged');

    // 2. the planner from a floating slab (air under it, nothing to drop onto): a bridge off its side, no pillar; from a full floor it pillars
    {
        const w = new Map([['0,76,0', { name: 'smooth_stone_slab', shapes: SLAB }]]);
        const bot = fakeBot(w, { x: 0.5, y: 76.5, z: 0.5 }), view = new M.View(bot, { canDig: () => false, temp: () => 'pumpkin' });
        const start = M.feet(bot);
        const r = await M.plan(view, start, (x, y, z) => !(x === 0 && z === 0), { x: 3, y: 77, z: 0 }, { temps: 8 });
        assert.ok(r, 'a way off the slab');
        assert.strictEqual(r[1].move, 'bridge', r.map((q) => q.move).join(' '));
        assert.strictEqual(r[1].place.y, 76, 'the bridge block beside the slab, clicked on its side');
        const up = await M.plan(view, start, (x, y, z) => y >= 78, { x: 0, y: 78, z: 0 }, { temps: 8 });
        assert.ok(!up || up[1].move !== 'pillar', 'no pillar from the slab: the jump does not clear the cell over the feet');
        const old = await M.plan(view, { x: 0, y: 76, z: 0 }, (x, y, z) => !(x === 0 && z === 0), { x: 3, y: 77, z: 0 }, { temps: 8 });
        assert.ok(!old, 'negative control: from the slab\'s own cell (the old feet) there is no way at all');
        const wf = new Map([['0,76,0', { name: 'stone' }]]), vf = new M.View(fakeBot(wf, { x: 0.5, y: 77, z: 0.5 }), { canDig: () => false, temp: () => 'pumpkin' });
        const pf = await M.plan(vf, { x: 0, y: 77, z: 0 }, (x, y, z) => y >= 78, { x: 0, y: 78, z: 0 }, { temps: 8 });
        assert.ok(pf && pf[1].move === 'pillar', 'negative control: from a full block it pillars');
    }
    console.log('  ok from a slab: a bridge off its side, no pillar; the old start had none; a full floor pillars');

    // 3. a body in a bed's head cell (drive.bodyIn: the click is not sent); beside it, it is
    {
        const bot = fakeBot(new Map(), { x: 3.5, y: 64, z: 0.5 });
        assert.ok(D.bodyIn(bot, { x: 3, y: 64, z: 0 }), 'its own body in the head cell');
        assert.ok(D.bodyIn(bot, { x: 3, y: 65, z: 0 }), 'the head cell at its head');
        assert.ok(!D.bodyIn(bot, { x: 4, y: 64, z: 0 }), 'negative control: the cell beside');
        assert.ok(!D.bodyIn(bot, { x: 3, y: 66, z: 0 }), 'negative control: over the head');
        bot.players.b2 = { username: 'b2', entity: { position: new Vec3(7.9, 64, 0.5) } };
        assert.ok(D.bodyIn(bot, { x: 8, y: 64, z: 0 }), 'another body reaching 0.3 into the cell');
    }
    // the claim's way: a bed whose head cell covers the stance's body or a crew member's stance is no way
    {
        const { Target } = require('../src/build/target');
        const { BuildJob } = require('../src/build/job');
        const P = require('../src/build/place');
        const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:white_bed', props: { facing: 'east', part: 'foot', occupied: 'false' } }, { name: 'minecraft:white_bed', props: { facing: 'east', part: 'head', occupied: 'false' } }];
        const blocks = []; for (let x = 0; x < 6; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) blocks.push({ x, y, z, s: y === 0 ? 1 : (y === 1 && z === 1 && x === 2 ? 2 : (y === 1 && z === 1 && x === 3 ? 3 : 0)) });
        const t = new Target({ size: [6, 3, 3], palette, blocks }, { x: 0, y: 64, z: 0 });
        const job = new BuildJob(t, { available: new Set(['stone', 'white_bed']) }); job.log = () => {};
        const w = new Map(); for (let x = -2; x < 8; x++) for (let z = -2; z < 5; z++) w.set(`${x},64,${z}`, { name: 'stone' });
        const bot = fakeBot(w, { x: 1.5, y: 65, z: 1.5 });
        bot.inventory = { items: () => [{ name: 'white_bed', count: 1 }] };
        const world = P.botWorld(bot);
        const tk = { k: '2,65,1', kind: 'place', i: t.idx(2, 65, 1), x: 2, y: 65, z: 1 };
        assert.ok(job._way(world, tk, { x: 1, y: 65, z: 1 }), 'negative control: from beside the foot, the head cell free: a way');
        assert.strictEqual(job._way(world, tk, { x: 3, y: 65, z: 1 }), null, 'the stance\'s body in the head cell: no way');
        job.bots.set('b2', { station: [{ x: 3, y: 65, z: 1 }] });
        assert.strictEqual(job._way(world, tk, { x: 1, y: 65, z: 1 }), null, 'a crew member\'s stance in the head cell: no way');
    }
    console.log('  ok a bed whose head cell covers a body is not placed (its own, a crew member\'s); a free head cell is');
    // 4. a column of its own read by the way down: a block another bot claimed to take away is 'doomed' to routes, not to the bot coming down its own column (unpillar)
    {
        const w = new Map([['0,64,0', { name: 'pumpkin' }], ['0,65,0', { name: 'pumpkin' }]]);
        const v = new M.View(fakeBot(w, { x: 0.5, y: 66, z: 0.5 }), { canDig: () => true, doomed: (x, y, z) => x === 0 && y === 64 && z === 0 });
        assert.strictEqual(v.stands(0, 64, 0), false, 'doomed to a route');
        assert.strictEqual(v.stands(0, 64, 0, { doomedToo: false }), true, 'it stands for the way down');
        assert.strictEqual(v.stands(0, 63, 0, { doomedToo: false }), false, 'negative control: air does not stand either way');
    }
    console.log('  ok a claimed block of its own column still stands for the way down');
    console.log('test_build_partial_pure: 4 passed');
})().catch((e) => { console.error(e); process.exit(1); });

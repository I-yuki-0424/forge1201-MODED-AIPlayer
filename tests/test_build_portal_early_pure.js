'use strict';
// Early lighting (src/build/job.js _lightsEarly; TASK-20261125-081): a portal whose frame stands is lit in the place stage, even while unrelated cells are still open.
// b081ac5 w5 (Fabric 1.21.1): ~40 cells no stance reached (a smooth stone, glass, a trapdoor, scaffolds) were parked and tried again every 90 s, so the place stage never ended and
// the 36 portals of the late stage were never lit (1 512 wrong cells). Negative control: with a frame block missing the lighting waits for the late stage as before.
const assert = require('assert');
const { Target } = require('../src/build/target');
const { BuildJob } = require('../src/build/job');

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
    const t = portal(), now = Date.now();
    const supply = () => new Set(['obsidian', 'stone', 'repeater', 'flint_and_steel']);
    // the frame stands, the repeater (nothing to do with the portal) is still to place: the place stage stays, the lighting is ready and claimed
    {
        const job = new BuildJob(t, { available: supply() }); job.log = () => {}; const w = world(false); w.set('0,68,1', { name: 'obsidian', props: {} }); const bot = fakeBot(w);
        await job.resurvey(bot, 'test');
        assert.strictEqual(job.stage, 'place');
        const ig = [...job.tasks.values()].find((tk) => tk.kind === 'ignite');
        assert.ok(ig && job.tasks.has('1,65,1'));
        assert.ok(job.ready(ig, bot, now), 'frame complete: lit although the place stage is open');
        assert.strictEqual(job.whyNot(ig, bot, now).startsWith('stage'), false);
        const c = job.claim(bot, 'b1', now, () => 64);
        assert.ok(c && c.tasks && c.tasks.some((q) => q.kind === 'ignite'), 'the claim offers the lighting');
    }
    // negative control: the top frame block (0,68,1) is missing (as world() has it): not ready, not claimed, the stage is the place stage
    {
        const w = world(false);
        const job = new BuildJob(t, { available: supply() }); job.log = () => {}; const bot = fakeBot(w);
        await job.resurvey(bot, 'test');
        const ig = [...job.tasks.values()].find((tk) => tk.kind === 'ignite');
        assert.ok(ig && !job.ready(ig, bot, now), 'a frame block missing: no lighting in the place stage');
        assert.ok(/^stage late/.test(job.whyNot(ig, bot, now)));
        const c = job.claim(bot, 'b1', now, () => 64);
        assert.ok(!(c && c.tasks && c.tasks.some((q) => q.kind === 'ignite')));
    }
    console.log('  ok a portal with its frame standing is lit in the place stage; with a frame block missing it waits');
})().catch((e) => { console.error(e); process.exit(1); });

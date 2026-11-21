'use strict';
// The new builder (src/build/, TASK-20261121-073) without a server: block-state rules, recipes, the flight path, the survey and the job's order on a fake world.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/build/state');
const R = require('../src/build/rules');
const fly = require('../src/build/fly');
const { survey, clicksFor } = require('../src/build/survey');
const { Target } = require('../src/build/target');
const { BuildJob } = require('../src/build/job');
const lit = require('../src/work/jobs/litematic');

let n = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

// ---- a fake bot: a world as a Map of 'x,y,z' -> {name, props}, air elsewhere inside the loaded box ----
function fakeBot(world, loaded = { x0: -100, x1: 100, y0: -64, y1: 320, z0: -100, z1: 100 }) {
    return {
        username: 'fake',
        entity: { position: { x: 0.5, y: 70, z: 0.5, floored() { return this; } } },
        blockAt(p) {
            if (p.x < loaded.x0 || p.x > loaded.x1 || p.z < loaded.z0 || p.z > loaded.z1) return null;
            const s = world.get(`${p.x},${p.y},${p.z}`) || { name: 'air', props: {} };
            const empty = /^(air|water|lava|nether_portal|short_grass)$/.test(s.name);
            return { name: s.name, getProperties: () => s.props || {}, boundingBox: empty ? 'empty' : 'block' };
        },
    };
}

console.log('state');
test('decided and derived properties', () => {
    assert.strictEqual(S.decided('redstone_wire', 'power'), false);
    assert.strictEqual(S.decided('redstone_wire', 'north'), false);
    assert.strictEqual(S.decided('repeater', 'delay'), true);
    assert.strictEqual(S.decided('repeater', 'powered'), false);
    assert.strictEqual(S.decided('oak_fence', 'east'), false);
    assert.strictEqual(S.decided('vine', 'east'), true);
    assert.strictEqual(S.decided('note_block', 'instrument'), false);
    assert.strictEqual(S.decided('note_block', 'note'), true);
    assert.strictEqual(S.decided('oak_stairs', 'shape'), false);
    assert.strictEqual(S.decided('chest', 'type'), true);
});
test('matches: decided properties only; a lone right chest half is fine; flows', () => {
    assert(S.matches({ name: 'repeater', props: { facing: 'north', delay: '2', powered: 'true' } }, { name: 'repeater', props: { facing: 'north', delay: '2', powered: 'false' } }));
    assert(!S.matches({ name: 'repeater', props: { facing: 'north', delay: '2' } }, { name: 'repeater', props: { facing: 'north', delay: '1' } }));
    assert(S.matches({ name: 'chest', props: { facing: 'east', type: 'right' } }, { name: 'chest', props: { facing: 'east', type: 'single' } }));
    assert(!S.matches({ name: 'chest', props: { facing: 'east', type: 'left' } }, { name: 'chest', props: { facing: 'east', type: 'single' } }));
    assert(S.matches({ name: 'lava', props: { level: '2' } }, { name: 'lava', props: { level: '3' } }));
    assert(!S.matches({ name: 'lava', props: { level: '0' } }, { name: 'lava', props: { level: '3' } }));
    assert(S.matches({ name: 'air', props: {} }, { name: 'cave_air', props: {} }));
    assert(S.dynamicPair({ name: 'air', props: {} }, { name: 'piston_head', props: {} }));
    assert(S.dynamicPair({ name: 'piston_head', props: {} }, { name: 'air', props: {} }));
});
test('normalise: a block in motion becomes what it carries; beds unoccupied', () => {
    assert.deepStrictEqual(S.normalise('minecraft:moving_piston', { facing: 'up' }, { blockState: { Name: 'minecraft:smooth_stone' } }), { name: 'smooth_stone', props: {} });
    assert.deepStrictEqual(S.normalise('minecraft:moving_piston', {}, { blockState: 'minecraft:glass' }), { name: 'glass', props: {} });
    assert.strictEqual(S.normalise('white_bed', { occupied: 'true', part: 'foot' }).props.occupied, 'false');
});
test('items', () => {
    assert.strictEqual(S.itemOf('redstone_wire'), 'redstone');
    assert.strictEqual(S.itemOf('redstone_wall_torch', { facing: 'north' }), 'redstone_torch');
    assert.strictEqual(S.itemOf('white_bed', { part: 'head' }), null);
    assert.strictEqual(S.itemOf('lava', { level: '2' }), null);
    assert.strictEqual(S.itemOf('lava', { level: '0' }), 'lava_bucket');
    assert.strictEqual(S.itemOf('oak_wall_sign', {}), 'oak_sign');
});

console.log('rules');
test('recipes aim where vanilla reads them (verified live by rules_probe.js)', () => {
    const r = (name, props, at) => R.recipe({ name, props }, at);
    assert.strictEqual(r('hopper', { facing: 'down' }).face, R.FACE.up);
    assert.strictEqual(r('hopper', { facing: 'north' }).face, R.FACE.south);
    assert.deepStrictEqual(r('observer', { facing: 'south' }).look, { h: 'south', v: null });
    assert.deepStrictEqual(r('sticky_piston', { facing: 'up' }).look, { h: 'north', v: 'down' });
    assert.deepStrictEqual(r('repeater', { facing: 'north', delay: '3' }).look, { h: 'south' });
    assert.strictEqual(r('repeater', { facing: 'north', delay: '3' }).clicks, 2);
    assert.strictEqual(r('comparator', { facing: 'north', mode: 'subtract' }).clicks, 1);
    assert.strictEqual(r('note_block', { note: '7' }).clicks, 7);
    assert.strictEqual(r('spruce_trapdoor', { facing: 'west', half: 'top', open: 'true' }).face, R.FACE.down);
    assert.strictEqual(r('spruce_trapdoor', { facing: 'west', half: 'top', open: 'true' }).clicks, 1);
    assert.strictEqual(r('iron_trapdoor', { facing: 'west', half: 'bottom', open: 'false' }).clicks, 0);
    assert.strictEqual(r('smooth_stone_slab', { type: 'top' }).face, R.FACE.down);
    assert.strictEqual(r('white_shulker_box', { facing: 'up' }).face, R.FACE.up);
    assert.strictEqual(r('nether_portal', { axis: 'z' }).op, 'ignite');
    assert.strictEqual(r('lava', { level: '0' }).op, 'pour');
    assert.strictEqual(r('lava', { level: '1' }), null);
    assert.strictEqual(r('piston_head', { facing: 'up' }), null);
    assert.strictEqual(r('air', {}), null);
});
test('dependencies: support below, the wall a torch hangs on, the chest partner, the watched cell', () => {
    const stone = { name: 'stone', props: {} }, at = () => stone;
    assert.deepStrictEqual(R.recipe({ name: 'redstone_wire', props: {} }, at).deps, [[0, -1, 0]]);
    assert.deepStrictEqual(R.recipe({ name: 'redstone_wall_torch', props: { facing: 'north' } }, at).deps, [[0, 0, 1]]);
    assert.deepStrictEqual(R.recipe({ name: 'lever', props: { face: 'wall', facing: 'west' } }, at).deps, [[1, 0, 0]]);
    const left = R.recipe({ name: 'chest', props: { facing: 'east', type: 'left' } }, at), right = R.recipe({ name: 'chest', props: { facing: 'east', type: 'right' } }, at);
    assert.deepStrictEqual(left.deps, [[0, 0, 1]]); assert.strictEqual(left.sneak, false); assert.strictEqual(right.sneak, true);
    assert.deepStrictEqual(R.recipe({ name: 'observer', props: { facing: 'east' } }, at).deps, [[1, 0, 0]]);
    assert.deepStrictEqual(R.recipe({ name: 'observer', props: { facing: 'east' } }, () => ({ name: 'air', props: {} })).deps, []);
    assert.deepStrictEqual(R.recipe({ name: 'redstone_wire', props: {} }, () => null).deps, []);
});

console.log('fly');
test('a path around a wall, never through a portal, no corner cutting', () => {
    const w = new Map();
    for (let y = 60; y < 80; y++) for (let z = -3; z <= 3; z++) w.set(`5,${y},${z}`, { name: 'stone' });
    w.set('5,70,4', { name: 'nether_portal' }); w.set('5,71,4', { name: 'nether_portal' });
    const bot = fakeBot(w), p = fly.path(bot, { x: 0, y: 70, z: 0 }, { x: 10, y: 70, z: 0 });
    assert(p, 'a path');
    for (const c of p) { assert(!(c.x === 5 && c.z >= -3 && c.z <= 3 && c.y >= 59 && c.y < 80), `through the wall at ${JSON.stringify(c)}`); assert(!(c.x === 5 && c.z === 4 && (c.y === 70 || c.y === 71 || c.y === 69)), 'through the portal'); }
    for (let i = 1; i < p.length; i++) assert(Math.abs(p[i].x - p[i - 1].x) <= 1 && Math.abs(p[i].y - p[i - 1].y) <= 1 && Math.abs(p[i].z - p[i - 1].z) <= 1);
    const blocked = fly.path(bot, { x: 0, y: 70, z: 0 }, { x: 10, y: 70, z: 0 }, { blocked: () => true });
    assert.strictEqual(blocked, null);
});
test('simplify keeps the turns only', () => {
    const s = fly.simplify([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 1 }, { x: 2, y: 0, z: 2 }]);
    assert.deepStrictEqual(s, [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 2 }]);
});

console.log('survey and job');
/** A tiny blueprint: a 3x3x3 box, stone floor, a repeater on it, a lever on the wall, glass on top, a lava source in a corner of the second layer. */
function tiny() {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:repeater', props: { facing: 'north', delay: '2', powered: 'false', locked: 'false' } }, { name: 'minecraft:glass', props: {} }];
    const blocks = [];
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { blocks.push({ x, y: 0, z, s: 1 }); blocks.push({ x, y: 2, z, s: 3 }); for (const y of [1]) blocks.push({ x, y, z, s: x === 1 && z === 1 ? 2 : 0 }); }
    return { size: [3, 3, 3], palette, blocks };
}
test('survey: what to clear, place, fix, seal', () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const w = new Map();
    w.set('10,64,10', { name: 'dirt' });                                                   // a wrong block on a stone cell: place (the dirt goes first)
    w.set('11,65,10', { name: 'stone' });                                                  // terrain in an air cell: clear
    w.set('11,64,11', { name: 'stone' }); w.set('11,65,11', { name: 'repeater', props: { facing: 'north', delay: '1', powered: 'false' } });   // right block, wrong delay: fix with one click
    w.set('9,65,10', { name: 'water', props: { level: '0' } });                            // water outside next to the box: seal
    const sv = survey(t, fakeBot(w));
    const at = (k) => sv.tasks.find((q) => q.k === k);
    assert.strictEqual(at('10,64,10').kind, 'place'); assert.strictEqual(at('10,64,10').wrong, true);
    assert.strictEqual(at('11,65,10').kind, 'clear');
    assert.strictEqual(at('11,65,11').kind, 'fix'); assert.strictEqual(at('11,65,11').clicks, 1);
    assert.strictEqual(at('9,65,10').kind, 'seal');
    assert.strictEqual(sv.unknown, 0);
});
test('clicksFor', () => {
    assert.deepStrictEqual(clicksFor({ name: 'note_block', props: { note: '3' } }, { name: 'note_block', props: { note: '20' } }), { clicks: 8, look: null });
    assert.strictEqual(clicksFor({ name: 'hopper', props: { facing: 'north' } }, { name: 'hopper', props: { facing: 'south' } }), null);
    assert.deepStrictEqual(clicksFor({ name: 'birch_fence_gate', props: { facing: 'west', open: 'true' } }, { name: 'birch_fence_gate', props: { facing: 'west', open: 'false' } }), { clicks: 1, look: { h: 'west' } });
});
test('job: stages in order, clearing top-down and never next to a fluid, placing bottom-up with the window and the support first', async () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const w = new Map();
    w.set('10,65,10', { name: 'stone' }); w.set('11,65,10', { name: 'stone' }); w.set('11,66,10', { name: 'dirt' });     // terrain in air cells; a wrong block where glass belongs (placed over later)
    w.set('12,65,12', { name: 'stone' }); w.set('13,65,12', { name: 'lava', props: { level: '0' } });     // next to lava outside: sealed first
    const bot = fakeBot(w), job = new BuildJob(t, { available: new Set(['stone', 'repeater', 'glass', 'smooth_stone']) });
    await job.resurvey(bot, 'test');
    assert.strictEqual(job.stage, 'prepare');
    const now = Date.now(), tk = (k) => job.tasks.get(k);
    assert(job.ready(tk('10,65,10'), bot, now)); assert.strictEqual(tk('11,66,10').kind, 'place', 'a wrong block where a block belongs is placed over (dug first)');
    assert(!job.ready(tk('12,65,12'), bot, now), 'next to lava'); assert(job.ready(tk('13,65,12'), bot, now), 'the seal');
    assert(!job.tasks.has('11,64,11') || !job.ready(tk('11,64,11'), bot, now), 'no placing while clearing');
    // the world after the prepare stage: then the place stage
    w.delete('10,65,10'); w.delete('11,65,10'); w.delete('12,65,12'); w.set('13,65,12', { name: 'smooth_stone' });
    await job.resurvey(bot, 'test');
    assert.strictEqual(job.stage, 'place');
    assert.strictEqual(job.frontier, 64);
    assert(job.ready(tk('10,64,10'), bot, now));
    assert(!job.ready(tk('11,65,11'), bot, now), 'the repeater waits for the stone under it');
    assert(job.ready(tk('11,65,11'), bot, now, new Set(['11,64,11'])), 'unless that stone was just sent');
    assert(job.ready(tk('10,66,10'), bot, now), 'inside the window (3 layers)');
    // a claim: a station whose body covers none of the cells it reaches, the tasks bottom-up
    const cl = job.claim(bot, 'b1', now);
    assert(cl && cl.tasks.length);
    for (const q of cl.tasks) assert(!(q.x === cl.station.x && q.z === cl.station.z && (q.y === cl.station.y || q.y === cl.station.y + 1)));
    for (let i = 1; i < cl.tasks.length; i++) assert(cl.tasks[i].y >= cl.tasks[i - 1].y);
    // a failure parks after MAX_FAILS tries, done tasks leave the list
    job.report('b1', cl.tasks.map((q, i) => ({ tk: q, ok: i > 0, why: 'got stone' })));
    assert.strictEqual(job.claims.size, 0);
    assert.strictEqual(job.fails.get(cl.tasks[0].k), 1);
});
test('the owner\'s blueprints: every cell has a recipe or is the world\'s (air, heads, flows, bed heads, portal cells)', () => {
    for (const f of ['iron-farm-34', 'iron-farm-34-nether-side-main']) {
        const p = lit.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${f}.litematic`)));
        const t = new Target(lit.place(p, { pos: { x: 0, y: 0, z: 0 } }, { keepAir: true }).bp, { x: 0, y: 64, z: 0 });
        const bad = [];
        for (let i = 0; i < t.n; i++) {
            if (t.isAir(i) || t.recipe[i]) continue;
            const s = t.stateOf(i), nm = s.name;
            if (nm === 'piston_head' || nm === 'nether_portal' || (/_bed$/.test(nm) && s.props.part === 'head') || (nm === 'lava' && s.props.level !== '0')) continue;
            bad.push(S.str(nm, s.props));
        }
        assert.deepStrictEqual(bad, [], f);
        assert(t.portals.length >= 1);
        for (const pt of t.portals) assert.strictEqual(S.bare(t.at(pt.light.x, pt.light.y, pt.light.z).name), 'obsidian', `${f}: a portal is lit on obsidian`);
        assert(![...t.palette].some((q) => q.name === 'moving_piston'), 'blocks in motion are resolved');
    }
});



(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log(`  ok ${name}`); } console.log(`test_build2_pure: ${n} passed`); })().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// The survival builder (src/build/, TASK-20261121-073) without a server: block-state rules, vanilla's placement model, the click search with a client's line of sight,
// the survival movement plan, the survey and the job's order on a fake world.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/build/state');
const R = require('../src/build/rules');
const V = require('../src/build/vanilla');
const P = require('../src/build/place');
const M = require('../src/build/move');
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
        digTime: () => 300,
        blockAt(p) {
            if (p.x < loaded.x0 || p.x > loaded.x1 || p.z < loaded.z0 || p.z > loaded.z1) return null;
            const s = world.get(`${p.x},${p.y},${p.z}`) || { name: 'air', props: {} };
            const empty = s.empty || /^(air|water|lava|nether_portal|short_grass|redstone_wire)$/.test(s.name);
            return { name: s.name, getProperties: () => s.props || {}, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : (s.shapes || [[0, 0, 0, 1, 1, 1]]) };
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
console.log('vanilla placement');
test('orderedByNearest is vanilla\'s: the dominant axis first', () => {
    assert.deepStrictEqual(V.orderedByNearest(0, -1, 0.1).slice(0, 2), ['down', 'south']);
    assert.strictEqual(V.orderedByNearest(1, 0.2, 0.1)[0], 'east');
    assert.strictEqual(V.orderedByNearest(0.1, 0.3, -1)[0], 'north');
    assert.strictEqual(V.horizontalOf(-0.2, 1), 'south');
});
test('predict: what a click makes of an item (the probe checked every state live: scripts/t26/place_probe.js)', () => {
    const none = () => null, sol = () => true;
    const ctx = (face, look, extra = {}) => ({ face, look, hitY: 0.5, sneak: false, at: none, solid: sol, ...extra });
    assert.deepStrictEqual(V.predict('hopper', ctx('north', [0, 0, 1])).props, { facing: 'south' });
    assert.deepStrictEqual(V.predict('hopper', ctx('up', [0, -1, 0])).props, { facing: 'down' });
    assert.strictEqual(V.predict('observer', ctx('up', [0, -1, 0.2])).props.facing, 'down');
    assert.strictEqual(V.predict('sticky_piston', ctx('up', [0, -1, 0.2])).props.facing, 'up');
    assert.strictEqual(V.predict('repeater', ctx('up', [0, -1, 0.3])).props.facing, 'north');
    assert.deepStrictEqual(V.predict('spruce_trapdoor', ctx('west', [-1, 0, 0], { hitY: 0.8 })).props, { facing: 'west', half: 'top', open: 'false' });
    assert.deepStrictEqual(V.predict('smooth_stone_slab', ctx('down', [0, 1, 0])).props, { type: 'top' });
    assert.deepStrictEqual(V.predict('redstone_torch', ctx('south', [0, 0, 1])), { name: 'redstone_wall_torch', props: { facing: 'south' } });
    assert.deepStrictEqual(V.predict('lever', ctx('up', [0.2, -1, 0])).props, { face: 'floor', facing: 'east' });
    assert.strictEqual(V.predict('white_bed', ctx('up', [-1, -1, 0])).props.facing, 'west');
    // a chest clicked on the side of a lone chest that faces east joins it
    const lone = (dx, dy, dz) => (dx === 0 && dy === 0 && dz === 1 ? { name: 'chest', props: { facing: 'east', type: 'single' } } : null);
    assert.deepStrictEqual(V.predict('chest', ctx('north', [0, -0.3, -1], { at: lone })).props, { facing: 'east', type: 'left', waterlogged: 'false' });
});
test('the click search: a face the eye sees first, the state vanilla gives, within reach', () => {
    const stone = { name: 'stone', props: {}, shapes: [[0, 0, 0, 1, 1, 1]] };
    const m = new Map(); for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) m.set(`${x},-1,${z}`, stone);
    const world = { block: (x, y, z) => m.get(`${x},${y},${z}`) || P.AIR };
    const st = []; for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) st.push({ x, y: 0, z });
    st.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    const w = P.ways(world, { x: 0, y: 0, z: 0 }, { name: 'repeater', props: { facing: 'north', delay: '3' } }, 'repeater', st)[0];
    assert(w && w.face === 'up' && (w.station.z < 0 || w.aim), 'a repeater facing north: looking south from the north, or with the exact look (flexible placement)');
    if (w.aim) assert(Math.abs(Math.cos(w.aim.yaw) + 1) < 1e-6 || Math.abs(Math.cos(w.aim.yaw) - 1) < 1e-6, 'the exact look is a cardinal');
    assert(!P.ways(world, { x: 0, y: 2, z: 0 }, { name: 'stone', props: {} }, 'stone', st).length, 'nothing to click on in the air');
    // a wall between the eye and the face: not that station
    m.set('0,0,-1', stone); m.set('0,1,-1', stone);
    const w2 = P.ways(world, { x: 0, y: 0, z: 0 }, { name: 'repeater', props: { facing: 'north' } }, 'repeater', [{ x: 0, y: 0, z: -2 }]);
    assert.strictEqual(w2.length, 0, 'the face is hidden behind the wall');
});

console.log('survival movement');
test('a plan walks, steps up, drops, and pillars only with temporary blocks', async () => {
    const w = new Map(); for (let x = -10; x <= 30; x++) for (let z = -5; z <= 5; z++) w.set(`${x},-1,${z}`, { name: 'stone' });
    for (let z = -5; z <= 5; z++) { w.set(`5,0,${z}`, { name: 'stone' }); w.set(`10,-1,${z}`, { name: 'air' }); w.set(`10,-2,${z}`, { name: 'stone' }); }
    const bot = fakeBot(w), view = new M.View(bot, { canDig: () => false });
    const r = await M.plan(view, { x: 0, y: 0, z: 0 }, (x, y, z) => x === 20 && z === 0, { x: 20, y: 0, z: 0 }, { temps: 0 });
    assert(r, 'a plan'); const moves = r.map((q) => q.move);
    assert(moves.includes('up') && moves.includes('drop'), moves.join(' '));
    assert(!(await M.plan(view, { x: 0, y: 0, z: 0 }, (x, y, z) => y >= 4, { x: 0, y: 4, z: 0 }, { temps: 0 })), 'no climbing without blocks');
    const up = await M.plan(view, { x: 0, y: 0, z: 0 }, (x, y, z) => y >= 4, { x: 0, y: 4, z: 0 }, { temps: 8 });
    assert(up && up.filter((q) => q.move === 'pillar').length === 4, 'four pillar steps');
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

console.log('survey and job');
/** A tiny blueprint: a 3x3x3 box, stone floor, a repeater on it, a lever on the wall, glass on top, a lava source in a corner of the second layer. */
function tiny() {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:repeater', props: { facing: 'north', delay: '2', powered: 'false', locked: 'false' } }, { name: 'minecraft:glass', props: {} }];
    const blocks = [];
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { blocks.push({ x, y: 0, z, s: 1 }); blocks.push({ x, y: 2, z, s: 3 }); for (const y of [1]) blocks.push({ x, y, z, s: x === 1 && z === 1 ? 2 : 0 }); }
    return { size: [3, 3, 3], palette, blocks };
}
test('survey: what to clear, place, fix, seal', async () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const w = new Map();
    w.set('10,64,10', { name: 'dirt' });                                                   // a wrong block on a stone cell: place (the dirt goes first)
    w.set('11,65,10', { name: 'stone' });                                                  // terrain in an air cell: clear
    w.set('11,64,11', { name: 'stone' }); w.set('11,65,11', { name: 'repeater', props: { facing: 'north', delay: '1', powered: 'false' } });   // right block, wrong delay: fix with one click
    w.set('9,65,10', { name: 'water', props: { level: '0' } });                            // water outside next to the box: seal
    const sv = await survey(t, fakeBot(w));
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
    for (let x = 4; x <= 18; x++) for (let z = 4; z <= 18; z++) w.set(`${x},63,${z}`, { name: 'dirt' });          // the ground under the box
    w.set('10,65,10', { name: 'stone' }); w.set('11,65,10', { name: 'stone' }); w.set('11,66,10', { name: 'dirt' });     // terrain in air cells; a wrong block where glass belongs (placed over later)
    w.set('12,65,12', { name: 'stone' }); w.set('13,65,12', { name: 'lava', props: { level: '0' } });     // next to lava outside: sealed first
    const bot = fakeBot(w), job = new BuildJob(t, { available: new Set(['stone', 'repeater', 'glass', 'smooth_stone']) });
    job.tempsOf = new Map([['b1', 64]]);          // the bot carries temporary blocks (a bot without any gets no stance in the air)
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
    assert(job.ready(tk('10,66,10'), bot, now), 'inside the window (two layers over the lowest open one)');
    // a claim: a station whose body covers none of the cells it reaches, the tasks bottom-up
    // without the items: the wrong block where glass belongs is dug out (place-stage work since 2026-11-23), then the claim asks for the items
    const c0 = job.claim(bot, 'b1', now, () => 0);
    assert(c0.need || (c0.tasks && c0.tasks.every((q) => q.kind === 'clear' && q.after === 'place')), 'without the items: the wrong block first, or the items asked for');
    if (c0.tasks) { job.release('b1', c0.tasks); job.bots.set('b1', { station: null }); }
    const cl = job.claim(bot, 'b1', now, () => 64);
    assert(cl && cl.tasks && cl.tasks.length, 'a claim with the items');
    for (const q of cl.tasks) { assert(!(q.x === cl.station.x && q.z === cl.station.z && (q.y === cl.station.y || q.y === cl.station.y + 1))); assert(q.way, 'every claimed task has its click or dig'); }
    for (let i = 1; i < cl.tasks.length; i++) assert(cl.tasks[i].y >= cl.tasks[i - 1].y);
    // a failure parks after MAX_FAILS tries, done tasks leave the list
    job.report('b1', cl.tasks.map((q, i) => ({ tk: q, ok: i > 0, why: 'got stone' })));
    assert.strictEqual(job.claims.size, 0);
    assert.strictEqual(job.fails.get(cl.tasks[0].k), 1);
});
test('pistons: the other phase of a retracted piston pushes the row, of an extended sticky one pulls the block back', async () => {
    const P = require('../src/build/pistons');
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:sticky_piston', props: { facing: 'up', extended: 'false' } }, { name: 'minecraft:smooth_stone', props: {} }, { name: 'minecraft:sticky_piston', props: { facing: 'up', extended: 'true' } }, { name: 'minecraft:piston_head', props: { facing: 'up', type: 'sticky', short: 'false' } }];
    const blocks = [{ x: 0, y: 0, z: 0, s: 1 }, { x: 0, y: 1, z: 0, s: 2 }, { x: 2, y: 0, z: 0, s: 3 }, { x: 2, y: 1, z: 0, s: 4 }, { x: 2, y: 2, z: 0, s: 2 }];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 4; y++) if (!blocks.some((b) => b.x === x && b.y === y)) blocks.push({ x, y, z: 0, s: 0 });
    const t = new Target({ size: [3, 4, 1], palette, blocks }, { x: 0, y: 64, z: 0 });
    assert.strictEqual(t.pistons.length, 2);
    const ret = t.pistons.find((p) => !p.extended), ext = t.pistons.find((p) => p.extended);
    const o1 = P.otherPhase(t, ret);
    assert.deepStrictEqual(o1.map((c) => [c.y, c.state && c.state.name]), [[65, 'piston_head'], [66, 'smooth_stone']]);
    const o2 = P.otherPhase(t, ext);
    assert.deepStrictEqual(o2.map((c) => [c.y, c.state && c.state.name]), [[65, 'smooth_stone'], [66, null]]);
    // the survey builds the other phase when the world holds the piston that way, and leaves the head alone
    const w = new Map([['0,64,0', { name: 'sticky_piston', props: { facing: 'up', extended: 'true' } }], ['0,65,0', { name: 'piston_head', props: { facing: 'up', type: 'sticky', short: 'false' } }]]);
    const sv = await survey(t, fakeBot(w));
    assert.strictEqual(sv.phased, 1);
    const tk = sv.tasks.find((q) => q.k === '0,66,0');
    assert(tk && tk.kind === 'place' && tk.want && tk.want.name === 'smooth_stone', 'the stone goes where the push leaves it');
    assert(!sv.tasks.some((q) => q.k === '0,65,0'), 'the head is not touched');
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


console.log('owner 2026-11-23 problems');
test('no pillar or bridge into a cell that holds redstone wire (problem 1); powder snow is dug, never walked into (problem 6)', async () => {
    const w = new Map(); for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) w.set(`${x},-1,${z}`, { name: 'stone' });
    w.set('0,0,0', { name: 'redstone_wire' });
    const bot = fakeBot(w), view = new M.View(bot, { canDig: () => true });
    assert(!view.placeable(0, 0, 0) && view.placeable(1, 0, 0), 'wire is no place for a block, air is');
    const up = await M.plan(view, { x: 0, y: 0, z: 0 }, (x, y, z) => y >= 2, { x: 0, y: 2, z: 0 }, { temps: 8 });
    assert(up, 'a plan'); assert.notStrictEqual(up[1].move, 'pillar', 'it steps off the wire before it pillars');
    for (const q of up) if (q.move === 'pillar') assert(!(q.x === 0 && q.z === 0 && q.y === 1), 'no pillar block into the wire cell');
    const w2 = new Map(); for (let x = -5; x <= 10; x++) for (let z = -1; z <= 1; z++) w2.set(`${x},-1,${z}`, { name: 'stone' });
    for (let z = -1; z <= 1; z++) { w2.set(`3,0,${z}`, { name: 'powder_snow', empty: true }); w2.set(`3,1,${z}`, { name: 'powder_snow', empty: true }); }
    const v2 = new M.View(fakeBot(w2), { canDig: () => true });
    assert.strictEqual(v2.kind(3, 0, 0), 'solid');
    const r = await M.plan(v2, { x: 0, y: 0, z: 0 }, (x, y, z) => x === 6 && z === 0, { x: 6, y: 0, z: 0 }, { temps: 0 });
    assert(r && r.some((q) => q.dig && q.dig.some((d) => d.x === 3)), 'the snow is dug through');
});
test('sectors: one piece of the ground plan per bot, kept; the pieces cover the box without overlap (problems 3, 9)', () => {
    const t = new Target(tiny(), { x: 0, y: 64, z: 0 });
    t.box = { x: 0, y: 64, z: 0, sx: 48, sy: 30, sz: 48 };
    const job = new BuildJob(t, {});
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']; for (const nm of names) job.bots.set(nm, { station: null });
    const cells = new Map();
    for (const nm of names) { const r = job.sectorOf(nm); for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) { assert(!cells.has(`${x},${z}`), 'no overlap'); cells.set(`${x},${z}`, nm); } }
    assert.strictEqual(cells.size, 48 * 48, 'the whole plan');
    assert.deepStrictEqual(job.sectorOf('c'), job.sectorOf('c'), 'kept');
});
test('areas: cut where the work is sparse, about equal work each; the layer window is local (list 4 problem 4)', () => {
    const t = new Target(tiny(), { x: 0, y: 64, z: 0 });
    t.box = { x: 0, y: 64, z: 0, sx: 40, sy: 30, sz: 8 };
    t.inside = (x, y, z) => x >= 0 && x < 40 && z >= 0 && z < 8 && y >= 64 && y < 94;
    const job = new BuildJob(t, {});
    // two dense units (x 0..11 and x 28..39), nothing between them: the cut falls into the gap, not through a unit
    for (const x0 of [0, 28]) for (let x = x0; x < x0 + 12; x++) for (let z = 0; z < 8; z++) for (let y = 64; y < 70; y++) job.tasks.set(`${x},${y},${z}`, { k: `${x},${y},${z}`, kind: 'place', x, y, z, i: -1 });
    job.bots.set('a', { station: null }); job.bots.set('b', { station: null });
    const a = job.sectorOf('a'), b = job.sectorOf('b');
    assert(a.x1 >= 11 && a.x1 < 28 && b.x0 > 11 && b.x0 <= 28, `cut in the gap: ${JSON.stringify([a, b])}`);
    // the window: a column of the second unit may go up to its own lowest open layer + 4, whatever the first unit's lowest layer is
    for (let x = 28; x < 40; x++) for (let z = 0; z < 8; z++) for (let y = 64; y < 68; y++) job.tasks.delete(`${x},${y},${z}`);
    job._frontier();
    assert.strictEqual(job.frontier, 64, 'the global frontier is the first unit\'s');
    assert.strictEqual(job.topAt(34, 4), 68 + job.win(), 'the second unit: its own low layer');
    assert.strictEqual(job.topAt(2, 4), 64 + job.win(), 'the first unit: its own');
    assert.strictEqual(job.topAt(20, 4), Infinity, 'nothing to place around the gap');
});
test('parked cells come back while the build runs once the crew has nothing ready (gh1 w1)', () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const job = new BuildJob(t, {});
    const tk = { k: '1,70,1', kind: 'place', x: 1, y: 70, z: 1, i: -1 };
    job.tasks.set(tk.k, tk); job._park(tk, 'no stance'); job.tasks.delete(tk.k);
    assert.strictEqual(job._revive(Date.now()), 0, 'not at once');
    job.parkedTk.get(tk.k).at -= 200000; job._reviveAt = 0;
    assert.strictEqual(job._revive(Date.now()), 1); assert(job.tasks.has(tk.k) && !job.parked.has(tk.k));
});
test('merit: tasks that held count up, failures and empty supply turns down (list 4 problem 6)', () => {
    const job = new BuildJob(new Target(tiny(), { x: 0, y: 64, z: 0 }), {});
    job.report('good', [{ tk: { k: 'a', kind: 'clear' }, ok: true }, { tk: { k: 'b', kind: 'clear' }, ok: true }]);
    job.report('bad', [{ tk: { k: 'c', kind: 'clear' }, ok: false, why: 'x' }]); job.record('bad').empty.push(Date.now());
    assert(job.merit('good') > job.merit('bad'));
});
test('temporary blocks for walking become untemp tasks once nobody is on them, in any stage (problem 2)', () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const job = new BuildJob(t, {}); job.stage = 'prepare';
    job.addTemp({ x: 0, y: 70, z: 0 }, 'pillar', 'a', 'dirt'); job.addTemp({ x: 0, y: 71, z: 0 }, 'pillar', 'a', 'dirt'); job.addTemp({ x: 5, y: 70, z: 5 }, 'bridge', 'a', 'dirt');
    job.bots.set('a', { station: [{ x: 5, y: 71, z: 5 }], pos: { x: 5, y: 71, z: 5 } });
    for (const m of job.temps.values()) m.t -= 100000;
    job._offerTemps(Date.now());
    assert(job.tasks.has('0,70,0') && job.tasks.has('0,71,0'), 'the pillar nobody stands on');
    assert(!job.tasks.has('5,70,5'), 'not the block a bot stands on');
    const bot = fakeBot(new Map([['0,70,0', { name: 'dirt' }], ['0,71,0', { name: 'dirt' }]]));
    assert(job.ready(job.tasks.get('0,71,0'), bot, Date.now()), 'the top, in the prepare stage');
    assert(!job.ready(job.tasks.get('0,70,0'), bot, Date.now()), 'not under another one');
    job.dropTemp({ x: 0, y: 71, z: 0 }); assert(!job.tasks.has('0,71,0') && !job.temps.has('0,71,0'));
});
test('the display gives every walking bot its share of the path pieces (problem 4)', () => {
    const { framePieces } = require('../src/work/display/overlay');
    const bots = [];
    for (let i = 0; i < 8; i++) { const cells = []; for (let k = 0; k < 400; k++) cells.push([i * 3 + (k % 2), 70 + (k % 3), k]); bots.push({ name: `b${i}`, color: i, dim: 'overworld', pos: { x: i * 3, y: 70, z: 0 }, path: { cells, at: Date.now() } }); }
    const out = framePieces({ bots, lanes: [], tags: [], viewers: [{ dim: 'overworld', x: 10, z: 10 }] }, { on: true, paths: true, lanes: true, tags: true });
    const by = new Map(); for (const k of out.keys()) { const v = out.get(k); by.set(v.piece.c, (by.get(v.piece.c) || 0) + 1); }
    assert.strictEqual(by.size, 8, `all eight bots drawn (${[...by.entries()].join(' ')})`);
});

test('flexible placement: a comparator facing east from a stance whose own look gives north (list 3 problem 1)', () => {
    const w = new Map(); for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) w.set(`${x},0,${z}`, { name: 'stone' });
    const bot = fakeBot(w), world = P.botWorld(bot);
    const want = { name: 'comparator', props: { facing: 'east', mode: 'compare', powered: 'false' } };
    const st = [{ x: 0, y: 1, z: -2 }];
    const plain = P.ways(world, { x: 0, y: 1, z: 0 }, want, 'comparator', st, { max: 1 })[0];
    assert(plain, 'a way');
    const lk = plain.aim ? [-Math.sin(plain.aim.yaw), 0, -Math.cos(plain.aim.yaw)] : plain.look;
    assert.strictEqual(V.predict('comparator', { face: plain.face, hitY: plain.hit[1] - 1, look: lk, sneak: false, at: () => null, solid: () => true }).props.facing, 'east');
    assert(plain.aim, 'the exact look is sent');
    assert(Math.abs(Math.atan2(-lk[0], -lk[2]) - plain.aim.yaw) < 1e-9);
});

test('bridges chain over a gap of three; a drop of five for a healthy bot (ga4 w1)', async () => {
    const w = new Map(); for (let x = -3; x <= 12; x++) for (let z = -2; z <= 2; z++) if (x <= 0 || x >= 4) w.set(`${x},-1,${z}`, { name: 'stone' });
    for (let x = 1; x <= 3; x++) for (let z = -2; z <= 2; z++) w.set(`${x},-6,${z}`, { name: 'stone' });          // the gap has ground five down (a bridge over the void is refused)
    const v = new M.View(fakeBot(w), { canDig: () => false });
    const r = await M.plan(v, { x: 0, y: 0, z: 0 }, (x, y, z) => x === 6 && z === 0 && y === 0, { x: 6, y: 0, z: 0 }, { temps: 8 });
    assert(r, 'a plan over the gap'); assert.strictEqual(r.filter((q) => q.move === 'bridge').length, 3, r.map((q) => q.move).join(' '));
    const wv = new Map([...w].filter(([k]) => !k.endsWith(',-6,0') && !/,-6,/.test(k)));
    const vv = new M.View(fakeBot(wv), { canDig: () => false });
    const rv = await M.plan(vv, { x: 0, y: 0, z: 0 }, (x, y, z) => x === 6 && z === 0 && y === 0, { x: 6, y: 0, z: 0 }, { temps: 8 });
    assert(rv && rv.filter((q) => q.move === 'bridge').length === 3, 'a bridge over the void too, at a higher cost (walked sneaking)');
    const w2 = new Map(); for (let x = -3; x <= 0; x++) for (let z = -2; z <= 2; z++) w2.set(`${x},4,${z}`, { name: 'stone' }); for (let x = -3; x <= 6; x++) for (let z = -2; z <= 2; z++) w2.set(`${x},-1,${z}`, { name: 'stone' });
    const v2 = new M.View(fakeBot(w2), { canDig: () => false });
    assert(!(await M.plan(v2, { x: 0, y: 5, z: 0 }, (x, y, z) => y === 0, { x: 3, y: 0, z: 0 }, { temps: 0, maxDrop: 4 })), 'no fall of five by default');
    assert(await M.plan(v2, { x: 0, y: 5, z: 0 }, (x, y, z) => y === 0, { x: 3, y: 0, z: 0 }, { temps: 0, maxDrop: 6 }), 'a fall of five when healthy');
});

test('a wall on a wall: the click goes to the outline\'s top at 1.0, not the collision box at 1.5 (gb1 w1)', () => {
    const stone = { name: 'stone', props: {}, shapes: [[0, 0, 0, 1, 1, 1]] }, wall = { name: 'stone_brick_wall', props: {}, shapes: [[0.25, 0, 0.25, 0.75, 1.5, 0.75]] };
    const m = new Map(); for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) m.set(`${x},-1,${z}`, stone); m.set('0,0,0', wall);
    const world = { block: (x, y, z) => m.get(`${x},${y},${z}`) || P.AIR };
    const w = P.ways(world, { x: 0, y: 1, z: 0 }, { name: 'stone_brick_wall', props: {} }, 'stone_brick_wall', [{ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 0 }], { max: 1 })[0];
    assert(w && w.face === 'up' && Math.abs(w.hit[1] - 1) < 1e-3, JSON.stringify(w));
});

test('a bot with no blocks digs steps out of a hole two deep (gd1 w6)', async () => {
    const w = new Map(); for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = -3; y <= 1; y++) w.set(`${x},${y},${z}`, { name: 'netherrack' });
    w.delete('0,0,0'); w.delete('0,1,0');                       // the hole: the bot stands at 0,0,0 on netherrack at y -1, ground level is y 2
    const v = new M.View(fakeBot(w), { canDig: () => true });
    const r = await M.plan(v, { x: 0, y: 0, z: 0 }, (x, y, z) => y >= 2, { x: 3, y: 2, z: 0 }, { temps: 0 });
    assert(r && r.some((q) => q.move === 'up' && q.dig && q.dig.length), r ? r.map((q) => q.move).join(' ') : 'no plan');
});

(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log(`  ok ${name}`); } console.log(`test_build2_pure: ${n} passed`); })().catch((e) => { console.error(e); process.exit(1); });

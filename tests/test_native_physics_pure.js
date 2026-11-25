'use strict';
// Native player physics (src/native/physics, TASK-20261125-076): (A) agreement with prismarine-physics where it is known right, (B) vanilla behaviour where
// prismarine is wrong or silent (axis order, crouch height, soul sand on 1.21, honey jump, powder snow, scaffolding, cave vines, trapdoor ladders, slime,
// bubble columns, cobwebs), with the figures the game is known for (walk 4.317 m/s, sprint 5.612 m/s, sneak 1.295 m/s, jump peak 1.2522, ladder 2.35 m/s),
// (C) the fall guard on top of it, (D) the golden traces in tests/golden_native/ replayed tick by tick.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const { world } = require('./native_world');
const { Physics, install } = require('../src/native/physics');
const { Tick, fresh, speedValue } = require('../src/native/physics/player');
const S = require('../src/native/physics/shapes');
const M = require('../src/native/physics/mth');
const { featuresOf, DV } = require('../src/native/physics/versions');
const trace = require('../src/native/trace');
const PP = require('prismarine-physics');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
const keys = (o = {}) => ({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, ...o });
function pstate(pos, control, extra = {}) {
    return { pos: new Vec3(...pos), vel: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
        elytraFlying: false, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, attributes: {}, yaw: 0, pitch: 0, control, jumpBoost: 0, speed: 0, slowness: 0,
        dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false, ...extra };
}
/** Run `ticks` of native and prismarine side by side from the same state; returns the largest position difference and both final states. */
function both(w, pos, control, ticks, extra = {}) {
    const a = pstate(pos, control, extra), b = pstate(pos, control, extra), na = Physics(w.registry), pp = PP.Physics(w.registry, w);
    let worst = 0;
    for (let i = 0; i < ticks; i++) { na.simulatePlayer(a, w); pp.simulatePlayer(b, w); worst = Math.max(worst, a.pos.distanceTo(b.pos)); }
    return { worst, a, b };
}
/** Native ticks in vanilla units (yaw degrees: 180 = north, the direction of -z). */
function sim(w, o, ticks, each) {
    const tk = new Tick(w.registry.version.dataVersion, new Map()), s = fresh({ yaw: 180, onGround: true, ...o });
    const rows = [];
    for (let i = 0; i < ticks; i++) { if (each) each(s, i); tk.step(s, w); rows.push({ x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, onGround: s.onGround, pose: s.pose }); }
    return { s, rows, tk };
}

console.log('native physics');

// ---- the parts ------------------------------------------------------------------------------------------------------------
t('Mth.sin / cos: the 65536-entry float table, float and double index', () => {
    near(M.sin(0), 0, 0, 'sin 0'); near(M.cos(0), 1, 0, 'cos 0');
    near(M.sin(Math.PI / 2), 1, 1e-6, 'sin 90'); near(M.cos(Math.PI), -1, 1e-6, 'cos 180');
    assert.strictEqual(M.sin(1.234), Math.fround(Math.sin(Math.trunc(Math.fround(Math.fround(1.234) * Math.fround(10430.378))) * Math.PI * 2 / 65536)));
    near(M.sin(-1, true), Math.sin(-1), 1e-4, 'double index, negative');
});
t('collideWithShapes: Y first, then the smaller of X / Z before the larger (vanilla), not always X then Z', () => {
    // a box at x,z 0.2..0.8 moving (0.3, 0, 0.5) next to a block at cell (1, 0, 1): Z first (|x| < |z|) -> z free 0.5, then x stops at 1.0
    const b = [0.2, 0, 0.2, 0.8, 1.8, 0.8], blk = [[1, 0, 1, 2, 1, 2]];
    assert.deepStrictEqual(S.collideWithShapes([0.3, 0, 0.5], b, blk).map((v) => +v.toFixed(9)), [0.2, 0, 0.5]);
    // |x| > |z|: X first -> x free 0.5, then z stops at 1.0
    assert.deepStrictEqual(S.collideWithShapes([0.5, 0, 0.3], b, blk).map((v) => +v.toFixed(9)), [0.5, 0, 0.2]);
});
t('collideAxis keeps the game\'s 1e-7 tolerance (a box touching a face does not collide sideways)', () => {
    assert.strictEqual(S.collideAxis(0, [0, 1, 0, 0.6, 2.8, 0.6], [[1, 0, 0, 2, 1, 1]], 0.5), 0.5);       // the block is below the box: no X collision
    near(S.collideAxis(1, [0, 1, 0, 0.6, 2.8, 0.6], [[0, 0, 0, 1, 1, 1]], -0.5), 0, 0, 'standing on it');
});
t('version features are data: 1.20.1 old edge probe and step, 1.21.1 new edge probe, 1.21.2 step candidates', () => {
    const a = featuresOf(DV['1.20.1']), b = featuresOf(DV['1.21.1']), c = featuresOf(DV['1.21.2']);
    assert.deepStrictEqual([a.edgeProbeBelowFeet, a.stepCandidates, a.jumpKeepsUpwardSpeed], [false, false, false]);
    assert.deepStrictEqual([b.edgeProbeBelowFeet, b.stepCandidates, b.jumpKeepsUpwardSpeed, b.mthDouble], [true, false, true, false]);
    assert.deepStrictEqual([c.stepCandidates, c.mthDouble], [true, true]);
});
t('movement speed attribute: sprint +30 % (multiply total) on top of the server\'s modifiers, the server\'s own sprint modifier ignored', () => {
    const s = fresh(); assert.strictEqual(speedValue(s), Math.fround(0.1));
    s.sprinting = true; assert.strictEqual(speedValue(s), Math.fround(0.13));
    s.speedModifiers = [{ id: 'minecraft:sprinting', amount: 0.3, operation: 2 }, { id: 'minecraft:effect.speed', amount: 0.2, operation: 2 }];
    near(speedValue(s), 0.1 * 1.3 * 1.2, 1e-7, 'speed I while sprinting');
});

// ---- (A) the same as prismarine-physics where it is right -----------------------------------------------------------------------
for (const v of ['1.20.1', '1.21.1']) {
    const flat = world(v).floor(0);
    for (const [label, ctl, ticks] of [['walk', keys({ forward: true }), 80], ['sprint', keys({ forward: true, sprint: true }), 80], ['sneak', keys({ forward: true, sneak: true }), 60], ['jump', keys({ jump: true }), 40], ['strafe+back', keys({ back: true, left: true }), 60]]) {
        t(`${v} flat ground, ${label}: within 2e-5 of prismarine-physics every tick facing west; at any yaw within the sine table's step (vanilla's own table)`, () => {
            const r = both(flat, [0.5, 1, 0.5], ctl, ticks, { yaw: Math.PI / 2 });
            assert.ok(r.worst < 2e-5, `worst ${r.worst}`);
            // vanilla's Mth.sin is a 65536-step table: a heading differs from the exact one by up to 2*pi/65536 rad, so positions part by that times the distance
            const o = both(flat, [0.5, 1, 0.5], ctl, ticks, { yaw: 0.7 }), dist = o.b.pos.distanceTo(new Vec3(0.5, 1, 0.5));
            assert.ok(o.worst <= 1e-4 * Math.max(1, dist) + 2e-5, `yaw 0.7: worst ${o.worst} over ${dist}`);
        });
    }
    t(`${v} free fall from 30 blocks: same as prismarine to landing`, () => {
        const r = both(flat, [0.5, 31, 0.5], keys(), 60, { onGround: false });
        assert.ok(r.worst < 1e-9, `worst ${r.worst}`); assert.strictEqual(r.a.pos.y, 1); assert.ok(r.a.onGround);
    });
    t(`${v} walking straight into a wall along one axis stops at the wall`, () => {
        const w = world(v).floor(0).fill(-3, 1, -5, 3, 3, -5, 'stone');
        const r = both(w, [0.5, 1, 0.5], keys({ forward: true }), 60);
        near(r.a.pos.z, -3.7, 1e-9, 'native at the wall'); near(r.b.pos.z, -3.7, 1e-9, 'prismarine at the wall');
    });
    t(`${v} deep still water, holding jump: rises like prismarine`, () => {
        const w = world(v).floor(0).fill(-4, 1, -4, 4, 12, 4, 'water');
        const r = both(w, [0.5, 3, 0.5], keys({ jump: true }), 20, { onGround: false, isInWater: true });
        assert.ok(r.worst < 1e-6, `worst ${r.worst}`); assert.ok(r.a.pos.y > 4, 'rose');
    });
}

// ---- (B) vanilla figures and behaviour --------------------------------------------------------------------------------------------
const flat = world('1.21.1').floor(0);
const steady = (o, ticks = 80) => { const r = sim(flat, { x: 0.5, y: 1, z: 0.5, ...o }, ticks).rows; return Math.abs(r[ticks - 1].z - r[ticks - 2].z); };
t('walking 4.317 m/s, sprinting 5.612 m/s, sneaking 1.295 m/s (blocks per tick x 20)', () => {
    near(steady({ keys: keys({ forward: true }) }) * 20, 4.317, 0.002, 'walk');
    near(steady({ keys: keys({ forward: true, sprint: true }) }) * 20, 5.612, 0.002, 'sprint');
    near(steady({ keys: keys({ forward: true, sneak: true }) }) * 20, 1.295, 0.002, 'sneak');
});
t('a standing jump peaks at 1.2522 blocks and lands after 12 ticks', () => {
    const r = sim(flat, { x: 0.5, y: 1, z: 0.5, keys: keys({ jump: true }) }, 12, (s, i) => { if (i === 1) s.keys.jump = false; }).rows;
    near(Math.max(...r.map((q) => q.y)) - 1, 1.2522, 1e-4, 'peak'); assert.ok(r[11].onGround && r[11].y === 1, 'landed on tick 12');
});
t('ladder: walking into it climbs at 2.35 m/s; sneaking holds the body on it', () => {
    const w = world('1.21.1').floor(0).fill(0, 1, -1, 0, 12, -1, 'stone').fill(0, 1, 0, 0, 12, 0, 'ladder', { facing: 'south' });
    const r = sim(w, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true }) }, 30).rows;
    near((r[29].y - r[19].y) / 10 * 20, 2.352, 0.01, 'climb speed');
    const h = sim(w, { x: 0.5, y: 5, z: 0.5, onGround: false, keys: keys({ sneak: true }) }, 20).rows;
    near(h[19].y, 5, 1e-9, 'sneaking on a ladder does not slide');
});
t('cave vines are climbable (BlockTags.CLIMBABLE; prismarine knows only ladder, vine, scaffolding)', () => {
    const w = world('1.21.1').floor(0).fill(0, 1, -1, 0, 12, -1, 'stone').fill(0, 1, 0, 0, 12, 0, 'cave_vines_plant');
    const r = sim(w, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true }) }, 30).rows;
    assert.ok(r[29].y > 3, `climbed to ${r[29].y}`);
});
t('an open trapdoor over a ladder facing the same way is climbable on 1.21.1 (prismarine dropped it for 1.21)', () => {
    const w = world('1.21.1').floor(0).fill(0, 1, -1, 0, 12, -1, 'stone').set(0, 1, 0, 'ladder', { facing: 'south' }).set(0, 2, 0, 'oak_trapdoor', { open: true, facing: 'south', half: 'bottom' });
    const tk = new Tick(DV['1.21.1'], new Map()); tk.view.reset(w);
    assert.ok(tk.onClimbable(fresh({ x: 0.5, y: 2.1, z: 0.5 })), 'trapdoor cell climbable');
    w.set(0, 2, 0, 'oak_trapdoor', { open: true, facing: 'north', half: 'bottom' }); tk.view.reset(w);
    assert.ok(!tk.onClimbable(fresh({ x: 0.5, y: 2.1, z: 0.5 })), 'facing the other way: not');
});
t('step-up: a slab is walked onto, a full block and a fence are not', () => {
    const w = world('1.21.1').floor(0).set(0, 1, -2, 'oak_slab', { type: 'bottom' });
    near(Math.max(...sim(w, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true }) }, 12).rows.map((q) => q.y)), 1.5, 1e-9, 'on the slab');
    const w2 = world('1.21.1').floor(0).set(0, 1, -2, 'stone');
    near(sim(w2, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true }) }, 20).s.y, 1, 1e-9, 'stopped by the block');
    const w3 = world('1.21.1').floor(0).set(0, 1, -2, 'oak_fence');
    near(sim(w3, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true }) }, 20).s.y, 1, 1e-9, 'stopped by the fence');
});
t('crouching: the body is 1.5 high and passes under a 1.5 gap that stops a standing one', () => {
    const w = world('1.21.1').floor(0).fill(-2, 2, -6, 2, 2, -3, 'oak_slab', { type: 'top' });      // the slab's underside at 2.5: a gap of 1.5 above the floor
    const up = sim(w, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true }) }, 40).s;
    assert.ok(up.z > -2.71, `standing stopped at ${up.z}`);
    const low = sim(w, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true, sneak: true }) }, 120).s;
    assert.ok(low.z < -5, `crouching passed: ${low.z}`); assert.strictEqual(low.pose, 'crouching');
});
t('sneaking at an edge: the body never leaves the block (any direction), walking upright does', () => {
    const w = world('1.21.1').set(0, 10, 0, 'stone');
    for (const yaw of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const r = sim(w, { x: 0.5, y: 11, z: 0.5, yaw, keys: keys({ forward: true, sneak: true }) }, 60).s;
        assert.ok(r.y === 11 && r.onGround, `yaw ${yaw}: fell to ${r.y}`);
        assert.ok(Math.abs(r.x - 0.5) <= 0.8 + 1e-9 && Math.abs(r.z - 0.5) <= 0.8 + 1e-9, `yaw ${yaw}: held within the block's reach (${r.x}, ${r.z})`);
    }
    assert.ok(sim(w, { x: 0.5, y: 11, z: 0.5, keys: keys({ forward: true }) }, 40).s.y < 11, 'upright: falls');
});
t('soul sand slows walking (speed factor 0.4 on the velocity carried to the next tick: about 0.58 of stone) on 1.21.1; prismarine applies it only up to 1.20', () => {
    const w = world('1.21.1').floor(0, 'soul_sand');
    const sv = Math.abs(sim(w, { x: 0.5, y: 0.875, z: 0.5, keys: keys({ forward: true }) }, 80).rows.slice(-2).reduce((a, b) => b.z - a.z));
    const st = steady({ keys: keys({ forward: true }) });
    near(sv, 0.098 / (1 - 0.4 * Math.fround(0.6 * Math.fround(0.91))), 1e-5, 'steady speed on soul sand: impulse 0.1 x 0.98 per tick, carried over x 0.4 x 0.546');
    assert.ok(sv < st * 0.65, `soul sand ${sv} vs stone ${st}`);
    const pp = both(w, [0.5, 0.875, 0.5], keys({ forward: true }), 80);
    assert.ok(Math.abs(pp.b.pos.z - 0.5) > Math.abs(pp.a.pos.z - 0.5) * 1.5, 'prismarine 1.21 is not slowed (the reason it is replaced)');
});
t('ice: a body keeps sliding after the key is let go, far longer than on stone', () => {
    // the slide after release: speed v decays by friction x 0.91 per tick (ice 0.98 -> 0.8918, stone 0.6 -> 0.546)
    const go = (name) => { const w = world('1.21.1').floor(0, name); const r = sim(w, { x: 0.5, y: 1, z: 0.5, keys: keys({ forward: true }) }, 90, (s, i) => { if (i === 60) s.keys.forward = false; }).rows; return r[59].z - r[89].z; };
    const ice = go('ice'), stone = go('stone');
    assert.ok(stone < 0.5 && ice > 1.5, `slide after release: ice ${ice}, stone ${stone}`);
});
t('honey: the jump is half as high in speed (jump factor 0.5; prismarine uses 0.4) and walking is slowed', () => {
    const w = world('1.21.1').floor(0, 'honey_block');
    const r = sim(w, { x: 0.5, y: 0.9375, z: 0.5, keys: keys({ jump: true }) }, 1).s;
    near(r.vy, (Math.fround(Math.fround(0.42) * 0.5) - 0.08) * Math.fround(0.98), 1e-9, 'first tick of a jump on honey');
});
t('slime: a fall bounces back up; sneaking lands without a bounce', () => {
    const w = world('1.21.1').floor(0, 'slime_block');
    const up = sim(w, { x: 0.5, y: 6, z: 0.5, onGround: false }, 25).rows;
    assert.ok(up.some((q, i) => i > 0 && q.vy > 0.3), 'bounced');
    const sn = sim(w, { x: 0.5, y: 6, z: 0.5, onGround: false, keys: keys({ sneak: true }) }, 25).rows;
    assert.ok(sn.every((q) => q.vy <= 0 || q.vy < 0.01), 'no bounce when sneaking');
});
t('cobweb: a fall into a web is slowed to a crawl (stuck multiplier 0.25 / 0.05 / 0.25)', () => {
    const w = world('1.21.1').floor(0).fill(0, 1, 0, 0, 5, 0, 'cobweb');
    const r = sim(w, { x: 0.5, y: 8, z: 0.5, onGround: false }, 30).rows;
    const inWeb = r.filter((q) => q.y < 6 && q.y > 1.5);
    assert.ok(inWeb.length >= 5, `spent ${inWeb.length} ticks in the web`);
    assert.ok(r[29].y > 1, `still in the web after 30 ticks (y ${r[29].y})`);
});
t('powder snow: a body without leather boots sinks in; with them it stands on top', () => {
    const w = world('1.21.1').floor(-1).fill(-2, 0, -2, 2, 1, 2, 'powder_snow');
    const sink = sim(w, { x: 0.5, y: 2, z: 0.5 }, 80).s;
    near(sink.y, 0, 1e-6, 'sank to the floor under the snow');
    const boots = sim(w, { x: 0.5, y: 2, z: 0.5, walksOnPowderSnow: true }, 40).s;
    near(boots.y, 2, 1e-9, 'stood on top');
});
t('scaffolding: stand on top, sneak to go down through it, jump to climb inside it', () => {
    const w = world('1.21.1').floor(0).fill(0, 1, 0, 0, 4, 0, 'scaffolding', { distance: 0, bottom: false });
    near(sim(w, { x: 0.5, y: 5, z: 0.5 }, 20).s.y, 5, 1e-9, 'stands on top');
    assert.ok(sim(w, { x: 0.5, y: 5, z: 0.5, keys: keys({ sneak: true }) }, 60).s.y < 3, 'sneaking goes down');
    const climb = sim(w, { x: 0.5, y: 1, z: 0.5, keys: keys({ jump: true }) }, 30).s;
    assert.ok(climb.y > 3, `jump climbs inside (${climb.y})`);
});
t('bubble column (soul sand below): carries a body up; magma (drag) pulls it down', () => {
    const w = world('1.21.1').floor(0).fill(0, 1, 0, 0, 10, 0, 'bubble_column', { drag: false });
    assert.ok(sim(w, { x: 0.5, y: 2, z: 0.5, onGround: false }, 30).s.y > 6, 'carried up');
    const d = world('1.21.1').floor(0).fill(0, 1, 0, 0, 10, 0, 'bubble_column', { drag: true });
    const r = sim(d, { x: 0.5, y: 8, z: 0.5, onGround: false }, 10).rows;
    assert.ok(r[9].y < 8 - 1.2, `pulled down to ${r[9].y}`);
});
t('lava: slower than water, still sinks; flowing water pushes a standing body', () => {
    const lv = world('1.21.1').floor(0).fill(-3, 1, -3, 3, 6, 3, 'lava');
    const r = sim(lv, { x: 0.5, y: 5, z: 0.5, onGround: false }, 30).s;
    assert.ok(r.y < 5 && r.y >= 1, `sank in lava to ${r.y}`);
    const fw = world('1.21.1').floor(0);
    for (let x = 0; x < 8; x++) fw.set(x, 1, 0, 'water', { level: Math.min(7, x) });
    const p = sim(fw, { x: 2.5, y: 1, z: 0.5 }, 40).s;
    assert.ok(p.x > 3, `pushed down the flow to x ${p.x}`);
});

// ---- (C) the fall guard on top of the native physics ---------------------------------------------------------------------------------
t('fall guard wraps the native simulatePlayer: a bot walking off a pillar top is held', () => {
    const w = world('1.21.1').set(0, 20, 0, 'stone');
    const controls = keys({ forward: true });
    const bot = { registry: w.registry, version: '1.21.1', entity: { position: new Vec3(0.5, 21, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {} },
        inventory: { slots: [] }, game: { gameMode: 'survival', dimension: 'overworld' }, food: 20, physics: { simulatePlayer: PP.Physics(w.registry, w).simulatePlayer } };
    const h = install(bot); assert.ok(h && bot.physics.simulatePlayer === h.physics.simulatePlayer, 'native installed');
    const g = require('../src/build/fallguard').install(bot);
    assert.ok(g, 'guard installed on the native hook');
    for (let i = 0; i < 60; i++) {
        const st = new PP.PlayerState({ ...bot, version: '1.21.1' }, controls);
        bot.physics.simulatePlayer(st, w).apply(bot);
    }
    assert.strictEqual(bot.entity.position.y, 21, 'still on the pillar'); assert.ok(g.stops > 0, 'the guard held it');
    h.restore();
});

// ---- (D) golden traces -------------------------------------------------------------------------------------------------------------
const dir = path.join(__dirname, 'golden_native');
for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort() : []) {
    t(`golden trace ${file}`, () => {
        const tr = trace.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        // generated traces come from prismarine's double maths: 2e-5 (the float constants); traces of the game itself: 1e-5
        const tol = /^generated:prismarine/.test(tr.hello.recorder) ? 2e-5 : 1e-5;
        const r = trace.replay(tr, { tol });
        assert.ok(r.ticks > 0, 'no ticks');
        assert.strictEqual(r.firstOff, null, `${file}: off by ${r.worst.dpos} at tick ${r.worst.tick} (tolerance ${tol}, recorder ${tr.hello.recorder})`);
    });
}

console.log(`native physics: ${n} passed`);

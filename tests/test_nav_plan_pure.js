// NAV planner (src/nav/plan.js) and the walker's step list (src/nav/go.js steps) on fake worlds: the cheapest way is taken, a block is placed only where nothing else works,
// a climb is one pillar run, nothing is dug beside a fluid, the surface goal finds the sky. docs/implemented/NAV-v1.md.
const assert = require('assert');
const P = require('../src/nav/plan');
const { steps } = require('../src/nav/go');

function test(name, fn) { console.log(`--- test: ${name} ---`); fn(); console.log('[OK]'); }

/** Ground: stone up to y 63 everywhere unless `set`; air above. */
function world(base = (x, y) => (y <= 63 ? 'solid' : 'air')) {
    const m = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    const kindAt = (x, y, z) => m.get(key(x, y, z)) ?? base(x, y, z);
    return { kindAt, nameAt: (x, y, z) => { const k = kindAt(x, y, z); return k === 'solid' ? 'stone' : k === 'water' ? 'water' : k === 'danger' ? 'lava' : 'air'; }, set: (x, y, z, k) => m.set(key(x, y, z), k), fill(x0, y0, z0, x1, y1, z1, k) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) m.set(key(x, y, z), k); } };
}
const dig = () => 0.75;                                       // stone with a pickaxe
const moveSet = (r) => new Set(r.path.slice(1).map((n) => n.move));

test('flat ground: only walking, nothing placed or dug', () => {
    const w = world(), r = P.search(w, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 12, y: 64, z: 5 }), { dig });
    assert.ok(!r.partial); for (const m of moveSet(r)) assert.ok(m === 'walk', m);
});

test('a wall that can be walked round is walked round, not dug or climbed', () => {
    const w = world(); w.fill(5, 64, -3, 5, 70, 3, 'solid');
    const r = P.plan(w, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 10, y: 64, z: 0 }), { dig });
    assert.ok(!r.partial); for (const m of moveSet(r)) assert.ok(m === 'walk', m);
});

test('a closed wall is dug through (cheaper than a pillar)', () => {
    const w = world(); w.fill(5, 64, -40, 5, 70, 40, 'solid');
    const r = P.search(w, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 10, y: 64, z: 0 }), { dig, radius: 30 });
    assert.ok(!r.partial); assert.ok(moveSet(r).has('dig')); assert.ok(!moveSet(r).has('pillar') && !moveSet(r).has('bridge'));
    const r2 = P.search(w, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 10, y: 64, z: 0 }), { dig: () => null, radius: 30, maxNodes: 4000 });
    assert.ok(r2.partial, 'without a tool the far side is out of reach (no drop deeper than 3)');
});

test('a climb of five levels is ONE pillar step in the walker (one block left, under the feet)', () => {
    const w = world(); w.fill(1, 64, -40, 40, 68, 40, 'solid');           // a cliff five high next to the start, no way round within the radius
    const r = P.search(w, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 4, y: 69, z: 0 }), { dig: () => null, radius: 20 });
    assert.ok(!r.partial);
    const st = steps(r.path), pil = st.filter((s) => s.kind === 'pillar');
    assert.strictEqual(pil.length, 1, JSON.stringify(st.map((s) => s.kind)));
    assert.ok(pil[0].cells.length >= 4);
});

test('no ground within three below: a bridge; ground two below: a drop, no block', () => {
    const w = world((x, y) => (x <= 0 && y <= 63) || (x >= 6 && y <= 63) ? 'solid' : 'air');
    const r = P.search(w, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 8, y: 64, z: 0 }), { dig: () => null, radius: 20 });
    assert.ok(!r.partial); assert.ok(moveSet(r).has('bridge'));
    const w2 = world((x, y) => (x <= 0 && y <= 63) || (x >= 6 && y <= 63) || y <= 61 ? 'solid' : 'air');
    const r2 = P.search(w2, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 8, y: 64, z: 0 }), { dig, radius: 20 });
    assert.ok(!r2.partial); assert.ok(!moveSet(r2).has('bridge') && !moveSet(r2).has('pillar'), [...moveSet(r2)].join());
});

test('noPlace (the cleanup walk): never a pillar or a bridge', () => {
    const w = world(); w.fill(1, 64, -40, 40, 68, 40, 'solid');
    const r = P.search(w, { x: 0, y: 64, z: 0 }, P.cellGoal({ x: 4, y: 69, z: 0 }), { dig: () => null, noPlace: true, radius: 20, maxNodes: 3000 });
    assert.ok(r.partial); assert.ok(!moveSet(r).has('pillar') && !moveSet(r).has('bridge'));
});

test('a block beside water or lava is never dug (the way would flood)', () => {
    const w = world(); w.fill(5, 64, -40, 5, 70, 40, 'solid'); w.fill(6, 64, -40, 6, 70, 40, 'water');
    const V = P.view(w, { dig });
    assert.strictEqual(V.digCost(5, 64, 0), null);
    assert.ok(V.digCost(5, 64, 0) === null && V.digCost(4, 63, 0) !== null);
    w.set(4, 63, 1, 'danger');
    assert.strictEqual(V.digCost(4, 63, 0), null);
});

test('surface goal from a cave: a standing cell that sees the sky', () => {
    const w = world((x, y) => (y <= 80 ? 'solid' : 'air'));
    w.fill(-3, 40, -3, 3, 42, 3, 'air');                                                  // a closed cave, 38 under the surface
    const r = P.search(w, { x: 0, y: 40, z: 0 }, P.surfaceGoal(w, { x: 0, y: 40, z: 0, surfaceY: 81 }), { dig, maxNodes: 30000 });
    assert.ok(r && !r.partial);
    const end = r.path[r.path.length - 1];
    assert.ok(P.seesSky(w, end.x, end.y, end.z) && end.y >= 80, JSON.stringify(end));
    assert.ok(!moveSet(r).has('bridge'));
});

test('a cave with a way out on foot: walked, nothing dug or placed', () => {
    const w = world((x, y) => (y <= 70 ? 'solid' : 'air'));
    w.fill(-3, 60, -3, 3, 61, 3, 'air');
    w.fill(-3, 62, -3, 3, 62, 3, 'air');
    for (let i = 0; i < 10; i++) w.fill(4 + i, 61 + i, 0, 4 + i, 63 + i, 0, 'air');          // a staircase tunnel up to the surface, three high (head room for the jump)
    const r = P.plan(w, { x: 0, y: 60, z: 0 }, P.surfaceGoal(w, { x: 0, y: 60, z: 0, surfaceY: 71 }), { dig, maxNodes: 30000 });
    assert.ok(r && !r.partial); for (const m of moveSet(r)) assert.ok(['walk', 'up', 'drop'].includes(m), m);
});

test('descend (2026-11-18): from a bridge block high above the ground the way down is placed, and from the bot\'s own pillar block too; never from natural ground', () => {
    // a platform 12 high with nothing below it; the goal is the ground beside it
    const w = world((x, y) => (y <= 63 ? 'solid' : x >= 0 && x <= 5 && z0(y) ? 'solid' : 'air'));
    function z0(y) { return y === 75; }
    const start = { x: 2, y: 76, z: 0 }, goal = P.cellGoal({ x: 9, y: 64, z: 0 }, { near: 1, nearY: 1 });
    // standing on the platform edge (natural, not a block of the bot's): a bridge first, then the descent from that block
    const r = P.plan(w, { ...start, ground: true }, goal, { dig: () => null, radius: 30, maxNodes: 20000 });
    assert.ok(r && !r.partial, 'a way down exists: ' + JSON.stringify(r && r.path.slice(-3)));
    const mv = r.path.map((n) => n.move);
    assert.ok(mv.includes('bridge') && mv.includes('descend'), mv.join(','));
    assert.ok(mv.lastIndexOf('bridge') < mv.indexOf('descend'), 'the descent starts from the block the bridge placed');
    const st = steps(r.path), ds = st.filter((s) => s.kind === 'descend');
    assert.strictEqual(ds.length, 1, 'a run of descents in one column is one step: ' + JSON.stringify(st.map((s) => s.kind)));
    assert.ok(ds[0].cells.length >= 8, 'the descent runs down to the last three levels, which are a safe drop');
    // standing on the bot\'s own temporary block over air (a pillar block left under the feet): descend at once
    const r2 = P.plan(w, { x: 20, y: 70, z: 0, placed: true }, P.cellGoal({ x: 20, y: 64, z: 0 }, { near: 0, nearY: 0 }), { dig: () => null, radius: 30, maxNodes: 20000, isTemp: (x, y, z) => x === 20 && y === 69 });
    assert.ok(r2 && !r2.partial); assert.ok(r2.path[1].move === 'descend' && !r2.path.some((n) => n.move === 'pillar' || n.move === 'bridge'), r2.path.map((n) => n.move).join(','));
    // not from a natural block: nothing is placed under a bot that stands on the platform with the way down only through the air
    const r3 = P.plan(w, { ...start, ground: true }, P.cellGoal({ x: 2, y: 64, z: 0 }, { near: 0, nearY: 0 }), { dig: () => null, radius: 30, maxNodes: 20000, noPlace: true });
    assert.ok(!r3 || r3.partial, 'noPlace: no descent');
    // the structure's own cells are never filled by a temporary block (keep)
    const r4 = P.plan(w, { x: 20, y: 70, z: 0, placed: true }, P.cellGoal({ x: 20, y: 64, z: 0 }, { near: 0, nearY: 0 }), { dig: () => null, radius: 30, maxNodes: 20000, isTemp: (x, y, z) => x === 20 && y === 69, keep: (x, y, z) => y === 67 });
    assert.ok(!r4 || r4.partial || !r4.path.some((n) => n.place && n.place.y === 67), 'a cell of the structure is not used for a temporary block');
});

console.log('nav plan tests passed');

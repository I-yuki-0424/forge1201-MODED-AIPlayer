'use strict';
// The builder's temporary blocks (src/build/temps.js, job.js, drive.js release; TASK-20261125-075, owner list 5 Large 1): registered before the click and confirmed by the server's
// block update, released when the step that needed them is over, taken over when the placer dies, classified when found standing. Each rule has a negative control: the old rule
// (registered only within the short wait, kept while work is near, a scaffold kept while any block beside it waits, a fill left to the next survey) leaves the block.
const assert = require('assert');
const { TempLedger } = require('../src/build/temps');
const { Target } = require('../src/build/target');
const { BuildJob } = require('../src/build/job');
const D = require('../src/build/drive');

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
function tiny() {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }];
    const blocks = []; for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { blocks.push({ x, y: 0, z, s: 1 }); blocks.push({ x, y: 1, z, s: 0 }); blocks.push({ x, y: 2, z, s: 0 }); }
    return { size: [3, 3, 3], palette, blocks };
}

test('a placement the server applies late is still registered (cause a; negative control: the old short wait)', () => {
    let t = 0; const L = new TempLedger({ now: () => t });
    const c = { x: 1, y: 2, z: 3 };
    L.intend(c, 'minecraft:pumpkin', 'pillar', 'a');
    t = 1000; L.check(c, 'air');                                           // the bot looks after its short wait: nothing yet
    assert(L.has(c) && L.get(c).state === 'pending', 'not settled as never placed before LATE_MS');
    t = 1500; L.observe(c, 'pumpkin');                                     // the server's block update comes
    assert.strictEqual(L.get(c).state, 'placed');
    assert.strictEqual(L.inPlace('a'), 1);
    // the old rule: registered only when the block showed within the wait (move.js before 075): this block would be in no list
    const oldRegistered = false;                                           // the wait (500 ms) saw air
    const fresh = new TempLedger(); if (oldRegistered) fresh.intend(c, 'pumpkin', 'pillar', 'a');
    assert.strictEqual(fresh.classify(c).cause, 'a', 'negative control: unregistered -> cause a');
    assert.strictEqual(L.classify(c).cause, 'b', 'with the ledger it is a known block of a step that is still open');
});

test('a refused click is settled at once; an old pending one after LATE_MS', () => {
    let t = 0; const L = new TempLedger({ now: () => t });
    const a = { x: 0, y: 0, z: 0 }, b = { x: 1, y: 0, z: 0 };
    L.intend(a, 'dirt', 'bridge', 'x'); L.intend(b, 'dirt', 'bridge', 'x');
    L.observe(a, 'air');                                                   // the server answered the click with the cell as it is
    t = 100; L.check(a, 'air'); assert(!L.has(a), 'refused: never placed');
    L.check(b, 'air'); assert(L.has(b), 'young: still pending');
    t = 6000; L.check(b, 'air'); assert(!L.has(b), 'old: never placed');
    assert.strictEqual(L.n.never, 2);
});

test('removal by anybody ends the entry; another block in the cell ends it as replaced', () => {
    const L = new TempLedger();
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 1, z: 0 };
    L.intend(a, 'dirt', 'pillar', 'x'); L.observe(a, 'dirt'); L.observe(a, 'air');
    L.intend(b, 'dirt', 'pillar', 'x'); L.observe(b, 'dirt'); L.observe(b, 'smooth_stone');
    assert(!L.has(a) && !L.has(b)); assert.strictEqual(L.n.removed, 1); assert.strictEqual(L.n.replaced, 1);
    L.observe(b, 'dirt'); assert(!L.has(b), 'a block of the same name later is not ours again');
    assert.strictEqual(L.classify(b).cause, 'a', 'found standing later: placed again unregistered');
});

test('release by step, the next step keeps only what it names; orphans; the named keep rule; the cause table', () => {
    const L = new TempLedger();
    L.begin('a', 'claim');
    const col = [{ x: 0, y: 70, z: 0 }, { x: 0, y: 71, z: 0 }], far = { x: 9, y: 70, z: 9 };
    for (const c of [...col, far]) { L.intend(c, 'dirt', 'pillar', 'a'); L.observe(c, 'dirt'); }
    assert.strictEqual(L.inPlace('a'), 3);
    L.begin('a', 'claim');
    const rel = L.release('a', { stay: (e) => e.x === 0 && e.z === 0 });
    assert.deepStrictEqual(rel.map((e) => e.k), ['9,70,9'], 'the column stays for the next stance on it');
    assert(!L.due(L.get(col[0])) && L.due(L.get(far)));
    L.fail(far, 'no face in sight');
    L.intend({ x: 5, y: 5, z: 5 }, 'dirt', 'pillar', 'b'); L.observe({ x: 5, y: 5, z: 5 }, 'dirt'); L.orphan('b', 'died');
    L.intend({ x: 6, y: 5, z: 5 }, 'dirt', 'seal', 'b'); L.observe({ x: 6, y: 5, z: 5 }, 'dirt'); L.keep({ x: 6, y: 5, z: 5 }, 'seal: holds a fluid back');
    const T = L.table([col[0], far, { x: 5, y: 5, z: 5 }, { x: 6, y: 5, z: 5 }, { x: 7, y: 7, z: 7 }]);
    assert.strictEqual(T.total, 5); assert.strictEqual(T.a, 1); assert.strictEqual(T.b, 1); assert.strictEqual(T.c, 2); assert.strictEqual(T.d, 1);
    assert(Object.keys(T.why).some((k) => /^c: no face in sight/.test(k)), JSON.stringify(T.why));
    assert(Object.keys(T.why).some((k) => /^c: orphaned \(died\)/.test(k)), JSON.stringify(T.why));
});

test('peaks: the most blocks a bot held at once, and when it came to hold a third', () => {
    const L = new TempLedger();
    for (let y = 0; y < 4; y++) { L.intend({ x: 0, y, z: 0 }, 'dirt', 'pillar', 'a'); L.observe({ x: 0, y, z: 0 }, 'dirt'); }
    L.intend({ x: 3, y: 0, z: 0 }, 'dirt', 'bridge', 'b'); L.observe({ x: 3, y: 0, z: 0 }, 'dirt');
    const s = L.status({ reset: true });
    assert.deepStrictEqual(s.peak, { bot: 'a', n: 4 }); assert.strictEqual(s.over2, 1); assert.strictEqual(L.over.how['pillar:3'], 1);
    assert.strictEqual(L.status().peak.n, 0, 'reset: a new period');
    assert.strictEqual(L.status().peakEver.n, 4);
});

test('the two-per-bot standard: the column under the bot is one structure in use; anything else beyond two is counted with what it was', () => {
    const L = new TempLedger();
    for (let y = 70; y < 76; y++) { L.intend({ x: 0, y, z: 0 }, 'pumpkin', 'pillar', 'a'); L.observe({ x: 0, y, z: 0 }, 'pumpkin'); }
    assert.strictEqual(L.sample('a', { x: 0, y: 76, z: 0 }), 0, 'standing on its column of six');
    for (const x of [1, 2, 3]) { L.intend({ x, y: 75, z: 0 }, 'pumpkin', 'bridge', 'a'); L.observe({ x, y: 75, z: 0 }, 'pumpkin'); }
    assert.strictEqual(L.sample('a', { x: 3, y: 76, z: 0 }), 8, 'walked off it over a bridge: the old column and the bridge behind are loose (the block under its feet is its support)');
    const s = L.status();
    assert.deepStrictEqual(s.loose, { bot: 'a', n: 8 }); assert.strictEqual(s.looseOver2s, 1); assert.strictEqual(s.looseHow['bridge:2,pillar:6'], 1);
});

test('job: a block of a step that goes on is no task; released it is one at once, with placing and bots beside it (negative control: the old keep rules)', () => {
    const job = new BuildJob(new Target(tiny(), { x: 10, y: 64, z: 10 }), {}); job.stage = 'place';
    const c = { x: 0, y: 70, z: 0 };
    job.addTemp(c, 'pillar', 'a', 'dirt'); job.ledger.observe(c, 'dirt');
    job.tasks.set('1,70,1', { k: '1,70,1', kind: 'place', i: -1, x: 1, y: 70, z: 1 });
    job.bots.set('b', { station: [{ x: 1, y: 71, z: 1 }], pos: { x: 1, y: 71, z: 1 } });
    job._offerTemps(Date.now(), true);
    assert(!job.tasks.has('0,70,0'));
    job.ledger.release('a');
    job._offerTemps(Date.now(), true);
    assert(job.tasks.has('0,70,0') && job.tasks.get('0,70,0').kind === 'untemp', 'an untemp task at once');
    // the rule before 075 (job._offerTemps: placing within the 4-cell buckets around, a bot within four cells, ten seconds since the last use) would have kept it
    const keptByOld = [...job.tasks.values()].some((t) => t.kind === 'place' && Math.abs(t.x - c.x) <= 4 && Math.abs(t.z - c.z) <= 4);
    assert(keptByOld, 'negative control: the old rule finds placing near and keeps the block');
});

test('job: the placer dies: its blocks are the crew\'s untemp tasks at once (takeover)', () => {
    const job = new BuildJob(new Target(tiny(), { x: 10, y: 64, z: 10 }), {}); job.stage = 'place';
    for (let y = 70; y < 73; y++) { job.addTemp({ x: 0, y, z: 0 }, 'pillar', 'a', 'dirt'); job.ledger.observe({ x: 0, y, z: 0 }, 'dirt'); }
    assert.strictEqual(job.orphanOf('a', 'died'), 3);
    assert.strictEqual([...job.tasks.values()].filter((t) => t.kind === 'untemp').length, 3);
    assert(job.ready(job.tasks.get('0,72,0'), fakeBot(new Map([['0,72,0', { name: 'dirt' }]])), Date.now()), 'the top first');
});

test('job: a scaffold lives as long as its block: released when that block stands, not kept for other blocks beside it (negative control)', () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 }), job = new BuildJob(t, {}); job.stage = 'place';
    const seed = { k: '11,64,11', kind: 'place', i: t.idx(11, 64, 11), x: 11, y: 64, z: 11 };
    job.tasks.set(seed.k, seed); job.buckets = new Map();
    assert(job._scaffoldFor(seed));
    const s = [...job.tasks.values()].find((t) => t.kind === 'scaffold');
    assert.strictEqual(s.for, seed.k);
    job.report('a', [{ tk: s, ok: true }]); job.addTemp(s, 'scaffold', 'a', 'dirt'); job.ledger.observe(s, 'dirt');
    job.ledger.release('a', { stay: (e) => e.how === 'scaffold' });
    assert(!job.ledger.due(job.ledger.get(s)), 'the bot\'s step ends, the scaffold serves on');
    const other = { k: `${s.x + 1},${s.y},${s.z}`, kind: 'place', i: -1, x: s.x + 1, y: s.y, z: s.z }; job.tasks.set(other.k, other);          // another block beside the scaffold still waits
    job.report('a', [{ tk: seed, ok: true }]);
    assert(job.ledger.due(job.ledger.get(s)), 'its block stands: released');
    job._offerTemps(Date.now(), true);
    assert(job.tasks.has(s.k) && job.tasks.get(s.k).kind === 'untemp');
    const keptByOld = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => { const o = job.tasks.get(`${s.x + dx},${s.y + dy},${s.z + dz}`); return o && o.kind === 'place'; });
    assert(keptByOld, 'negative control: the old rule (a place task beside it) kept the scaffold');
});

test('job: a fill in a box cell gets the cell\'s own work back at once (clear for air, place for a block; negative control: none before)', () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const job = new BuildJob(t, {}); job.stage = 'prepare';
    const air = { k: '11,65,11', kind: 'fill', i: t.idx(11, 65, 11), x: 11, y: 65, z: 11 }, stone = { k: '11,64,11', kind: 'fill', i: t.idx(11, 64, 11), x: 11, y: 64, z: 11 };
    job.tasks.set(air.k, air); job.tasks.set(stone.k, stone);
    job.report('a', [{ tk: air, ok: true }, { tk: stone, ok: true }]);
    assert.strictEqual(job.tasks.get(air.k).kind, 'clear');
    assert.strictEqual(job.tasks.get(stone.k).kind, 'place');
    // negative control: the report without the planned removal (as before 075) leaves the cell with no task until the next survey (one survey in 210 min on hc1's crews)
    const job2 = new BuildJob(t, {}); job2.stage = 'prepare'; job2._afterFill = () => {};
    const air2 = { ...air }; job2.tasks.set(air2.k, air2); job2.report('a', [{ tk: air2, ok: true }]);
    assert(!job2.tasks.has(air2.k), 'negative control');
});

test('job: nothing but temporary blocks left: every step is over, every block is due (the end of the build)', async () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const w = new Map(); for (let x = 10; x < 13; x++) for (let z = 10; z < 13; z++) w.set(`${x},64,${z}`, { name: 'stone' });
    w.set('0,70,0', { name: 'dirt' });
    const job = new BuildJob(t, {});
    job.addTemp({ x: 0, y: 70, z: 0 }, 'pillar', 'a', 'dirt'); job.ledger.observe({ x: 0, y: 70, z: 0 }, 'dirt');
    await job.resurvey(fakeBot(w), 'test');
    assert(job.tasks.has('0,70,0') && job.stage === 'cleanup', `${job.stage} ${[...job.tasks.keys()]}`);
});

test('the end of the build: a seal goes unless the fluid behind it would run into an open cell of the box (shown with the cell); negative control: the old rule kept every wet seal', async () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const w = new Map(); for (let x = 10; x < 13; x++) for (let z = 10; z < 13; z++) w.set(`${x},64,${z}`, { name: 'stone' });
    w.set('8,64,10', { name: 'water' }); w.set('8,65,10', { name: 'water' });
    const job = new BuildJob(t, {});
    for (const c of [{ x: 9, y: 64, z: 10 }, { x: 9, y: 65, z: 10 }]) { w.set(`${c.x},${c.y},${c.z}`, { name: 'pumpkin' }); job.addTemp(c, 'seal', 'a', 'pumpkin'); job.ledger.observe(c, 'pumpkin'); }
    const bot = fakeBot(w);
    await job.resurvey(bot, 'test');
    const low = job.ledger.get({ x: 9, y: 64, z: 10 }), high = job.ledger.get({ x: 9, y: 65, z: 10 });
    assert(low.released && !low.keep && job.tasks.has('9,64,10'), 'beside stone only: it goes');
    assert(job.ready(job.tasks.get('9,64,10'), bot, Date.now()), 'ready though water is beside it');
    assert(/run into the finished box at 10,65,10/.test(high.keep || ''), `kept with the case: ${high.keep}`);
    const oldRule = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => /water/.test((w.get(`${9 + dx},${64 + dy},${10 + dz}`) || {}).name || ''));
    assert(oldRule, 'negative control: the seal beside stone holds water and the old rule kept it');
});

test('wrap-up at the end of the run\'s time: only the temporary blocks are work, every one of them (a clean site at the end of every run)', async () => {
    const t = new Target(tiny(), { x: 10, y: 64, z: 10 });
    const w = new Map(); w.set('0,70,0', { name: 'pumpkin' });                                   // the box is not built: its stone layer is missing (place work left)
    const job = new BuildJob(t, {});
    job.addTemp({ x: 0, y: 70, z: 0 }, 'pillar', 'a', 'pumpkin'); job.ledger.observe({ x: 0, y: 70, z: 0 }, 'pumpkin');
    await job.resurvey(fakeBot(w), 'test');
    assert([...job.tasks.values()].some((tk) => tk.kind === 'place') && !job.tasks.has('0,70,0'), 'before: the build, the column still the bot\'s');
    job.wrapUp(); assert(job.exhausted());
    await job.resurvey(fakeBot(w), 'wrap');
    assert.deepStrictEqual([...job.tasks.values()].map((tk) => tk.kind), ['untemp']);
    assert.strictEqual(job.stage, 'cleanup');
});

test('release: the step is over: own blocks in reach and sight are dug, the rest are untemp tasks with the reason; the next stance on the same column keeps the column', async () => {
    const t = new Target(tiny(), { x: 100, y: 64, z: 100 });
    const job = new BuildJob(t, {}); job.stage = 'place';
    const w = new Map(); for (let x = -3; x <= 30; x++) for (let z = -3; z <= 3; z++) w.set(`${x},68,${z}`, { name: 'stone' });
    const mine = [{ x: 0, y: 69, z: 0 }, { x: 2, y: 69, z: 0 }, { x: 25, y: 69, z: 0 }];          // under the feet (its column), beside it, far away
    for (const c of mine) { w.set(`${c.x},${c.y},${c.z}`, { name: 'dirt' }); job.addTemp(c, 'pillar', 'a', 'dirt'); job.ledger.observe(c, 'dirt'); }
    const bot = fakeBot(w, { x: 0.5, y: 70, z: 0.5 });
    const dug = [];
    const mv = { walkBack: async () => 0, unpillar: async () => 0, dig: async (c) => { w.delete(`${c.x},${c.y},${c.z}`); dug.push(`${c.x},${c.y},${c.z}`); return true; }, mine: new Map() };
    // the next stance is on this same column: the column stays, the rest goes
    let r = await D.release(job, 'a', bot, mv, { cancelled: false }, { x: 0, y: 72, z: 0 }, 'claim');
    assert.deepStrictEqual(dug, ['2,69,0'], `dug ${dug}`);
    assert(job.ledger.has({ x: 0, y: 69, z: 0 }) && !job.ledger.due(job.ledger.get({ x: 0, y: 69, z: 0 })), 'the column serves the next step');
    assert(job.ledger.due(job.ledger.get({ x: 25, y: 69, z: 0 })) && job.tasks.get('25,69,0').kind === 'untemp', 'out of reach: the crew\'s at once');
    assert.strictEqual(r, 1);
    // the next stance is elsewhere: the column is dug as the bot comes down (unpillar); one it cannot come down from is the crew's, with the reason
    r = await D.release(job, 'a', bot, mv, { cancelled: false }, { x: 5, y: 70, z: 0 }, 'claim');
    assert.strictEqual(job.ledger.get({ x: 0, y: 69, z: 0 }).lastFail, 'under its placer (no way down)');
    assert(job.tasks.has('0,69,0'));
});

test('the flood tells a cell reached on foot from one reached by placing blocks (untemp stances and column tops only on foot)', async () => {
    const M = require('../src/build/move');
    const w = new Map(); for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) w.set(`${x},69,${z}`, { name: 'stone' });
    for (let y = 70; y <= 73; y++) w.set(`4,${y},0`, { name: 'dirt' });            // a column of four: its top cell 4,74,0 has nothing beside it
    const v = new M.View(fakeBot(w), { canDig: () => false });
    const out = {};
    await M.plan(v, { x: 0, y: 70, z: 0 }, () => false, { x: 0, y: 70, z: 0 }, { temps: 64, flood: true, maxNodes: 4000, out });
    assert.strictEqual(out.placed.get('2,70,2'), 0, 'ground: on foot');
    assert(out.best.has('4,74,0') && out.placed.get('4,74,0') > 0, `the column top only by a pillar beside it (${out.placed.get('4,74,0')})`);
});

test('a pillar left sideways is dug from beside it, top-down, as far as its faces are in sight (negative control: the old _behind only took bridge blocks over air)', async () => {
    const M = require('../src/build/move');
    const w = new Map(); for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) w.set(`${x},69,${z}`, { name: 'stone' });
    for (let y = 70; y <= 72; y++) w.set(`2,${y},0`, { name: 'stone' });                     // a floor three high beside the column
    for (let y = 70; y <= 72; y++) w.set(`1,${y},0`, { name: 'pumpkin' });                   // its own pillar, left by stepping east onto the floor
    const bot = fakeBot(w, { x: 2.5, y: 73, z: 0.5 }); bot.entity.onGround = true;
    const mv = Object.create(M.Mover.prototype);
    Object.assign(mv, { bot, mine: new Map([['1,70,0', 'pumpkin'], ['1,71,0', 'pumpkin'], ['1,72,0', 'pumpkin']]), mineHow: new Map([['1,70,0', 'pillar'], ['1,71,0', 'pillar'], ['1,72,0', 'pillar']]), rules: { canDig: () => true }, trace: [] });
    const dug = []; mv.dig = async (c) => { w.delete(`${c.x},${c.y},${c.z}`); dug.push(c.y); return true; };
    let leans = 0; mv.lean = async (dx) => { leans++; bot.entity.position.x += dx * 0.6; }; mv.unlean = async () => { bot.entity.position.x = 2.5; };
    const route = [{ x: 1, y: 73, z: 0 }, { x: 2, y: 73, z: 0 }, { x: 3, y: 73, z: 0 }];
    const n = await mv._behind(route[0], route, 2);
    assert.deepStrictEqual(dug, [72, 71, 70], 'top-down, the lowest one leaning out over the shaft');
    assert.strictEqual(leans, 1); assert.strictEqual(bot.entity.position.x, 2.5, 'back from the edge'); assert.strictEqual(n, 3);
    const old = (mv.mineHow.get('1,72,0') === 'bridge');                                     // the rule before: only a block placed as a bridge
    assert(!old, 'negative control: a pillar block was never taken back by the old rule');
    const keep = Object.create(M.Mover.prototype); Object.assign(keep, { bot, mine: new Map([['2,72,0', 'pumpkin']]), mineHow: new Map(), rules: {}, trace: [] }); keep.dig = mv.dig;
    assert.strictEqual(await keep._behind({ x: 2, y: 73, z: 0 }, route, 2), 0, 'still on that column: nothing');
});

test('a temporary block beside a pane or over/beside redstone wire is known as one that changes a built shape (the flicker, owner list 5 Small 2)', async () => {
    const w = new Map([['1,70,0', 'glass_pane'], ['5,69,0', 'redstone_wire'], ['9,70,1', 'redstone_wire']]), at = (x, y, z) => w.get(`${x},${y},${z}`) || 'air';
    assert.strictEqual(D.touchesShape(at, 0, 70, 0), 'pane');
    assert.strictEqual(D.touchesShape(at, 5, 70, 0), 'wire', 'over a wire');
    assert.strictEqual(D.touchesShape(at, 9, 70, 0), 'wire', 'beside a wire');
    assert.strictEqual(D.touchesShape(at, 20, 70, 0), null);
    // the planner pays for it: a bridge of one cell over a gap, beside a pane on one side only
    const M = require('../src/build/move');
    const g = new Map(); for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (x !== 0) g.set(`${x},69,${z}`, { name: 'stone' });
    for (let z = -4; z <= 4; z++) for (let y = 60; y < 69; y++) g.delete(`0,${y},${z}`);
    g.set('0,69,2', { name: 'glass_pane', empty: true });                                     // a built pane in the gap, beside the straight bridge cell 0,69,1
    const cost = (x, y, z, v) => (D.touchesShape((a, b, c) => { const q = v.raw(a, b, c); return q && q.name; }, x, y, z) ? 60 : 0);
    const way = async (rules) => { const r = await M.plan(new M.View(fakeBot(g), rules), { x: -1, y: 70, z: 1 }, (x, y, z) => x === 1 && y === 70 && z === 1, { x: 1, y: 70, z: 1 }, { temps: 64 }); return r.filter((q) => q.place).map((q) => `${q.place.x},${q.place.y},${q.place.z}`); };
    const without = await way({ canDig: () => false }), withCost = await way({ canDig: () => false, tempCost: cost });
    assert(without.includes('0,69,1'), `negative control: without the cost the bridge goes beside the pane (${without})`);
    assert(withCost.length && !withCost.includes('0,69,1'), `with it the bridge goes a cell away (${withCost})`);
});

test('a stance on a bridge block off its own pillar: the way back is that pillar (the bridge block dug from it, then the pillar as the bot comes down); not a loose block meanwhile', async () => {
    const M = require('../src/build/move');
    const w = new Map(); for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) w.set(`${x},69,${z}`, { name: 'stone' });
    for (let y = 70; y <= 72; y++) w.set(`0,${y},0`, { name: 'pumpkin' }); w.set('1,72,0', { name: 'pumpkin' });
    const bot = fakeBot(w, { x: 1.5, y: 73, z: 0.5 });
    const mine = new Map([['0,70,0', 'pumpkin'], ['0,71,0', 'pumpkin'], ['0,72,0', 'pumpkin'], ['1,72,0', 'pumpkin']]);
    const mv = Object.create(M.Mover.prototype); const order = [];
    Object.assign(mv, { bot, mine, mineHow: new Map([['0,70,0', 'pillar'], ['0,71,0', 'pillar'], ['0,72,0', 'pillar'], ['1,72,0', 'bridge']]), rules: { canDig: () => true }, trace: [] });
    mv.walkTo = async (c) => { bot.entity.position.x = c.x + 0.5; bot.entity.position.z = c.z + 0.5; return true; };
    mv.dig = async (c) => { w.delete(`${c.x},${c.y},${c.z}`); order.push(`${c.x},${c.y}`); return true; };
    mv.unpillar = async () => { for (const y of [72, 71, 70]) await mv.dig({ x: 0, y, z: 0 }); return 3; };
    assert.strictEqual(await mv.walkBack({ cancelled: false }), 4);
    assert.deepStrictEqual(order, ['1,72', '0,72', '0,71', '0,70'], 'the bridge block first, from the pillar, then the pillar top-down');
    const L = new TempLedger();
    for (const [k, how] of [['0,70,0', 'pillar'], ['0,71,0', 'pillar'], ['0,72,0', 'pillar'], ['1,72,0', 'bridge']]) { const [x, y, z] = k.split(',').map(Number); L.intend({ x, y, z }, 'pumpkin', how, 'a'); L.observe({ x, y, z }, 'pumpkin'); }
    assert.strictEqual(L.sample('a', { x: 1, y: 73, z: 0 }), 0, 'on the bridge block, the pillar beside it is its way down');
    assert.strictEqual(L.sample('a', { x: 3, y: 73, z: 0 }), 4, 'negative control: walked away, all four are loose');
});

(async () => { for (const [name, fn] of queue) { await fn(); n++; console.log(`  ok ${name}`); } console.log(`test_build_temps_pure: ${n} passed`); })().catch((e) => { console.error(e); process.exit(1); });

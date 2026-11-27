// The tree pass of the pit (src/work/jobs/pit_trees.js) on a fake world: a tree (trunk and a leaf crown) and a canopy hanging 15 blocks over the ground are taken down from the ground and from a
// pillar beside them; the pillar's blocks are gone at the end; a block that has no standing place is reported and does not loop the pass; the cancel token ends it.
const assert = require('assert');
const { clearTrees, scan, isTree } = require('../src/work/jobs/pit_trees');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const key = (x, y, z) => `${x},${y},${z}`;
const GROUND = 60;
function world(blocks) {
    const m = new Map(blocks.map(([x, y, z, n]) => [key(x, y, z), n]));
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= GROUND ? 'stone' : 'air');
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => (n === 'air' ? m.delete(key(x, y, z)) : m.set(key(x, y, z), n)), map: m };
}
const tree = (x, z, h, crown) => {
    const b = []; for (let y = GROUND + 1; y <= GROUND + h; y++) b.push([x, y, z, 'oak_log']);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = h - 2; dy <= h + 1; dy++) if (!(dx === 0 && dz === 0 && dy <= h) && Math.abs(dx) + Math.abs(dz) <= 3) b.push([x + dx, GROUND + dy, z + dz, 'oak_leaves']);
    return crown ? b : b.filter((q) => q[3] === 'oak_log');
};
const cobble = (w) => [...w.map].filter(([, n]) => n === 'cobblestone').length;

// A bot that obeys the rules the real commands obey: `mine` reaches 4.6 blocks from the eyes (walking to a spot beside a low block first), `pillar` rises and leaves one block under the feet (and
// mines what is overhead), `descend` takes the pillar away, `move_to` stands on a cell with air for body and head over a solid block.
function fakeEnv(w, start) {
    const pos = { ...start }, calls = { mine: 0, pillar: 0, descend: 0, move: 0, blind: 0 }, env = { w, cancel: { cancelled: false }, here: () => ({ ...pos }) };
    const dist = (a) => Math.hypot(pos.x + 0.5 - (a.x + 0.5), pos.y + 1.62 - (a.y + 0.5), pos.z + 0.5 - (a.z + 0.5));
    env.exec = async (name, a) => {
        if (name === 'move_to') {
            calls.move++;
            if (!(w.kindAt(a.x, a.y, a.z) === 'air' && w.kindAt(a.x, a.y + 1, a.z) === 'air' && w.kindAt(a.x, a.y - 1, a.z) === 'solid') ) return { ok: false, reason: 'unreachable' };
            pos.x = a.x; pos.y = a.y; pos.z = a.z; return { ok: true };
        }
        if (name !== 'mine') return { ok: true };
        calls.mine++; if (a.blind) calls.blind++;
        if (w.kindAt(a.x, a.y, a.z) === 'air') return { ok: true };
        if (dist(a) > 4.6) {
            if (a.blind || a.y - GROUND > 3) return { ok: false, reason: 'unreachable' };          // the real planner gives up on an aerial block (30-85 s); a blind mine out of reach fails at once
            pos.x = a.x - 1; pos.z = a.z; pos.y = GROUND + 1;                                         // walks to a place beside a low block
        }
        w.set(a.x, a.y, a.z, 'air'); return { ok: true };
    };
    env.run = async (name, a) => {
        if (name === 'pillar') {
            calls.pillar++;
            for (let i = 0; i < a.levels; i++) {
                for (const dy of [2, 1]) if (w.kindAt(pos.x, pos.y + dy, pos.z) !== 'air') w.set(pos.x, pos.y + dy, pos.z, 'air');       // the overhead is mined first
                w.set(pos.x, pos.y, pos.z, 'cobblestone'); pos.y++;
            }
            return { ok: true, detail: { levels: a.levels } };
        }
        if (name === 'descend') {
            calls.descend++;
            for (let i = 0; i < a.levels; i++) { w.set(pos.x, pos.y - 1, pos.z, 'air'); pos.y--; }
            return { ok: true, detail: { levels: a.levels } };
        }
        return { ok: true };
    };
    return { env, pos, calls };
}
const BOX = { x0: 0, z0: 0, x1: 15, z1: 15, top: 80 };
const left = (w, box = BOX) => scan(w, box).length;

(async () => {
    await test('isTree: leaves, logs, vines; not stone', () => { assert(isTree('minecraft:oak_leaves') && isTree('birch_log') && isTree('vine') && !isTree('stone') && !isTree('grass_block')); });

    await test('a tree: trunk and crown are taken down, the pillar is gone, the bot is back on the ground', async () => {
        const w = world(tree(7, 7, 7, true)), n0 = left(w); assert(n0 > 50, `blocks ${n0}`);
        const { env, pos, calls } = fakeEnv(w, { x: 2, y: GROUND + 1, z: 2 });
        const res = await clearTrees(env, BOX);
        assert.strictEqual(res.ok, true, JSON.stringify(res)); assert.strictEqual(left(w), 0); assert.strictEqual(cobble(w), 0, 'pillar blocks left'); assert.strictEqual(res.failed.length, 0);
        assert(res.risen > 0 && calls.descend > 0, 'the crown is above the ground reach, the bot has to rise'); assert.strictEqual(pos.y, GROUND + 1, 'back on the ground');
        assert(res.mined >= n0, `mined ${res.mined} of ${n0}`);
    });

    await test('a canopy 15 blocks over the ground (no trunk under it): taken from a pillar, nothing left', async () => {
        const b = []; for (let x = 5; x <= 9; x++) for (let z = 5; z <= 8; z++) b.push([x, GROUND + 15, z, 'oak_leaves'], [x, GROUND + 16, z, 'oak_leaves']);
        const w = world(b), { env, calls } = fakeEnv(w, { x: 2, y: GROUND + 1, z: 2 });
        const res = await clearTrees(env, BOX);
        assert.strictEqual(res.ok, true, JSON.stringify(res)); assert.strictEqual(left(w), 0); assert.strictEqual(cobble(w), 0); assert(calls.pillar >= 5, `pillar calls ${calls.pillar}`); assert(res.columns >= 1);
    });

    await test('leaves over a pit: the ground under them is dug away, they hang 25 blocks over the new floor', async () => {
        const b = []; for (let x = 4; x <= 8; x++) for (let z = 4; z <= 8; z++) b.push([x, GROUND + 1, z, 'oak_leaves']);
        const w = world(b);
        for (let x = 3; x <= 9; x++) for (let z = 3; z <= 9; z++) for (let y = GROUND - 24; y <= GROUND; y++) w.set(x, y, z, 'air');        // a pit under the leaves; its floor is stone at GROUND - 25
        const { env, pos } = fakeEnv(w, { x: 1, y: GROUND + 1, z: 1 });
        const res = await clearTrees(env, BOX);
        assert.strictEqual(res.ok, true, JSON.stringify(res)); assert.strictEqual(left(w), 0); assert.strictEqual(cobble(w), 0); assert.strictEqual(pos.y, GROUND + 1);
    });

    await test('no standing place (a leaf over water): reported, not looped on, the others are done', async () => {
        const b = [[12, GROUND + 10, 12, 'oak_leaves'], [4, GROUND + 9, 4, 'oak_leaves']];
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) b.push([12 + dx, GROUND, 12 + dz, 'water']);
        const w = world(b), { env } = fakeEnv(w, { x: 1, y: GROUND + 1, z: 1 });
        const res = await clearTrees(env, BOX);
        assert.strictEqual(res.ok, false); assert.strictEqual(res.left, 1); assert.strictEqual(res.failed.length, 1); assert.deepStrictEqual([res.failed[0].x, res.failed[0].z], [12, 12]); assert.strictEqual(w.nameAt(4, GROUND + 9, 4), 'air');
    });

    await test('the cancel token ends the pass at once', async () => {
        const w = world(tree(7, 7, 7, true)), { env } = fakeEnv(w, { x: 2, y: GROUND + 1, z: 2 });
        env.cancel.cancelled = true;
        const res = await clearTrees(env, BOX);
        assert(left(w) > 0 && res.mined === 0);
    });

    await test('blocks above the box top are not the pit\'s: untouched', async () => {
        const w = world([[5, 85, 5, 'oak_leaves'], [6, 75, 5, 'oak_leaves']]), { env } = fakeEnv(w, { x: 2, y: GROUND + 1, z: 2 });
        const res = await clearTrees(env, BOX);
        assert.strictEqual(w.nameAt(5, 85, 5), 'oak_leaves'); assert.strictEqual(w.nameAt(6, 75, 5), 'air'); assert.strictEqual(res.ok, true);
    });

    await test('find mode: seal blocks hanging 8 over the pit floor (the registered leftovers) are taken the same way', async () => {
        const w = world([[5, GROUND + 8, 5, 'cobblestone'], [6, GROUND + 9, 5, 'cobblestone'], [5, GROUND + 3, 8, 'cobblestone']]), { env, pos } = fakeEnv(w, { x: 2, y: GROUND + 1, z: 2 });
        const cells = () => ['5,68,5', '6,69,5', '5,63,8'].map((k) => k.split(',').map(Number)).filter(([x, y, z]) => w.kindAt(x, y, z) === 'solid').map(([x, y, z]) => ({ x, y, z, gy: GROUND }));
        const res = await clearTrees(env, BOX, { find: () => cells(), done: (c) => w.kindAt(c.x, c.y, c.z) !== 'solid' });
        assert.strictEqual(res.ok, true, JSON.stringify(res)); assert.strictEqual(cells().length, 0); assert.strictEqual(cobble(w), 0); assert.strictEqual(pos.y, GROUND + 1);
    });

    await test('a unit leaves tree blocks over LOW above the ground (the tree pass\'s), and every tree block while another bot\'s tree pass of the region runs (b081d: units under a canopy failed "stuck at mine", "inside rock", "nothing solid under the feet")', async () => {
        const pit = require('../src/work/jobs/pit');
        const world = () => { const m = new Map(), k = (x, y, z) => `${x},${y},${z}`; const nameAt = (x, y, z) => m.get(k(x, y, z)) ?? (y <= 99 ? 'stone' : 'air'); return { nameAt, kindAt: (x, y, z) => (nameAt(x, y, z) === 'air' ? 'air' : 'solid'), set: (x, y, z, n) => m.set(k(x, y, z), n) }; };
        const w0 = world(); w0.set(3, 103, 3, 'oak_leaves'); w0.set(4, 102, 4, 'oak_leaves');
        assert.strictEqual(pit.aerialTree(w0, { x: 3, y: 103, z: 3 }), true, 'four over the ground: the tree pass\'s (was six: units tried and failed)');
        assert.strictEqual(pit.aerialTree(w0, { x: 4, y: 102, z: 4 }), false, 'three over the ground: a unit mines it from the ground');
        const box = { x0: 0, z0: 0, x1: 15, z1: 15, top: 101, bottom: 96 };
        const run = async (pass) => {
            const w = world(); w.set(5, 100, 5, 'oak_leaves'); w.set(5, 101, 5, 'oak_log'); w.set(9, 100, 9, 'stone');
            const job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0];
            job.plan.trees = new Map([[reg.id, pass]]);
            const log = [], pos = { x: 0, y: 100, z: 0 };
            const env = { w, bot: { username: 'Me' }, here: () => ({ ...pos }), have: () => 64, exec: async (n, a) => { log.push([n, a]); if (n === 'move_to') { Object.assign(pos, { x: a.x, y: a.y, z: a.z }); return { ok: true }; } if (n === 'mine') { w.set(a.x, a.y, a.z, 'air'); return { ok: true }; } return { ok: true }; } };
            const r = await job.runUnit(reg.id, { unit: 0 }, env);
            return { r, mined: log.filter((l) => l[0] === 'mine').map((l) => `${l[1].x},${l[1].y},${l[1].z}`) };
        };
        const busy = await run({ busy: true, by: 'Other' });
        assert(busy.r.ok, JSON.stringify(busy.r).slice(0, 300));
        assert(!busy.mined.includes('5,100,5') && !busy.mined.includes('5,101,5') && busy.mined.includes('9,100,9'), `another bot's tree pass: the unit leaves the tree, digs the rest (${busy.mined})`);
        const done = await run({ done: true });
        assert(done.mined.includes('5,100,5') && done.mined.includes('5,101,5'), `negative control: the pass is over, the unit digs the low tree (${done.mined})`);
    });

    await test('a build site\'s pit (plants: true) digs grass, flowers and snow layers, which have no collision box; a plain pit walks through them as air (negative control; b081f: 96 left)', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (plants) => {
            const cells = new Map([['2,64,2', 'short_grass'], ['3,64,3', 'poppy'], ['4,64,4', 'stone']]);
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air'), kindAt: (x, y, z) => { const n = cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air'); return n === 'stone' ? 'solid' : 'air'; } };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method: 'rows', road: false, plants }), region = job.plan.regions[0], mined = [], blind = [];
            const env = { w, have: () => 9, pause: async () => {}, here: () => ({ x: 0, y: 64, z: 0 }), exec: async (n, a) => { if (n === 'mine') { mined.push(`${a.x},${a.y},${a.z}`); if (a.blind) blind.push(`${a.x},${a.y},${a.z}`); cells.delete(`${a.x},${a.y},${a.z}`); } return { ok: true }; } };
            for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env);
            const left = []; for (let u = 0; u < region.layers * region.rows; u++) left.push(...pit.wrongCells(job.plan, region, u, w));
            return { mined, left: left.length, blind };
        };
        const site = await run(true), plain = await run(false);
        assert(site.mined.includes('2,64,2') && site.mined.includes('3,64,3') && site.mined.includes('4,64,4') && site.left === 0, `site: plants dug (${site.mined})`);
        assert(site.blind.includes('2,64,2') && site.blind.includes('3,64,3') && !site.blind.includes('4,64,4'), `plants mined blind (no collision shape for the crosshair), stone with sight (${site.blind})`);
        assert(!plain.mined.includes('2,64,2') && !plain.mined.includes('3,64,3') && plain.mined.includes('4,64,4'), `negative control: a plain pit leaves them (${plain.mined})`);
    });

    await test('a plant (no collision box) is aimed at by its outline: aim points exist beside it, through air, none without the outline (negative control; bt075h: "inside rock" for short_grass)', () => {
        const { aimPoints } = require('../src/skills/geometry');
        const shapes = (x, y, z) => (y <= 63 ? [[0, 0, 0, 1, 1, 1]] : []);
        const withOutline = Object.assign((x, y, z) => shapes(x, y, z), { outline: (x, y, z) => (x === 2 && y === 64 && z === 0 ? [[0.125, 0, 0.125, 0.875, 0.8125, 0.875]] : []) });
        const eye = { x: 0.5, y: 65.62, z: 0.5 }, cell = { x: 2, y: 64, z: 0 };
        assert(aimPoints(eye, cell, withOutline).length > 0, 'grass two cells away: in sight by its outline');
        assert.strictEqual(aimPoints(eye, cell, shapes).length, 0, 'negative control: collision shapes only, nothing to aim at');
    });

    await test('a cell the unit cannot take from its station (a trunk in a canopy, its own pumpkin out of reach, a snow layer) goes to NAV, which takes the bot within reach; then it is dug (081 b081d/h/i); without NAV it fails visibly, never left aside (negative control)', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (name, withNav) => {
            const cells = new Map([['3,64,3', name]]);
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            const pos = { x: 0, y: 64, z: 0 }; let navs = 0;
            const env = { w, have: () => 9, pause: async () => {}, here: () => ({ ...pos }),
                exec: async (n, a) => { if (n !== 'mine') return { ok: true }; if (a.x === 3 && a.z === 3 && Math.hypot(pos.x - 3, pos.z - 3) > 2) return { ok: false, reason: 'stuck', detail: { why: 'the same unmet precondition', unmet: [{ need: 'in_reach' }] } }; cells.set(`${a.x},${a.y},${a.z}`, 'air'); return { ok: true }; },
                ...(withNav ? { nav: async (t, o) => { navs++; pos.x = t.x - 1; pos.z = t.z; return { ok: true }; } } : {}) };
            let ok = true; for (let u = 0; u < region.layers * region.rows; u++) { const r = await job.runUnit(region.id, { unit: u }, env); ok = ok && r.ok; }
            let wrong = 0; for (let u = 0; u < region.layers * region.rows; u++) wrong += pit.wrongCells(job.plan, region, u, w).length;
            return { ok, wrong, navs };
        };
        for (const name of ['spruce_log', 'spruce_leaves', 'pumpkin', 'stone']) {
            const r = await run(name, true);
            assert(r.ok && r.wrong === 0 && r.navs === 1, `${name}: taken after one NAV reach (${JSON.stringify(r)})`);
        }
        const none = await run('spruce_leaves', false);
        assert(!none.ok && none.wrong === 1, `negative control: no NAV, the unit fails it visibly and the layer holds (${JSON.stringify(none)})`);
    });

    await test('the work layer\'s registry does not forget a fresh entry whose block is not seen yet (a late placement), but does after the late window (negative control); b081h\'s orphan pumpkins', async () => {
        const { Temps, cleanTemps } = require('../src/work/bot/temps');
        let t = 0; const T = new Temps(() => t);
        T.add({ dim: 'overworld', x: 1, y: 70, z: 1, item: 'pumpkin', kind: 'pillar', by: 'p' });
        const env = { temps: T, bot: { username: 'p', game: { dimension: 'overworld' } }, here: () => ({ x: 0, y: 70, z: 0 }), w: { kindAt: () => 'air', nameAt: () => 'air' }, exec: async () => ({ ok: true }) };
        t = 1000; await cleanTemps(env, { radius: 12 });
        assert.strictEqual(T.size, 1, 'one second after the click, its cell still empty: kept (the server may apply it late)');
        t = 9000; await cleanTemps(env, { radius: 12 });
        assert.strictEqual(T.size, 0, 'nine seconds later, still empty: never placed, forgotten');
    });

    await test('the job\'s end survives a death: the respawned bot does the cleanup again (mb075g w2: died during it, two pumpkins left); without a death once (negative control)', async () => {
        const { runWorker } = require('../src/work/bot/worker');
        const { Ledger } = require('../src/work/jobs/crew');
        const { EventEmitter } = require('events');
        const run = async (dieFirst) => {
            const L = new Ledger({ maxAttempts: 3 }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 });
            const bot = new EventEmitter(); let calls = 0;
            const job = { ledger: L, runUnit: async () => ({ ok: true }), cleanup: async () => { calls++; if (dieFirst && calls === 1) { bot.emit('death'); setTimeout(() => bot.emit('spawn'), 20); } } };
            const env = { bot, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 0, z: 0 }), now: Date.now, exec: async () => ({ ok: true }) };
            const res = await runWorker(job, 'b', env, { pollMs: 2, backoff: () => 1 });
            return { res, calls };
        };
        const died = await run(true), plain = await run(false);
        assert.strictEqual(died.res.ended, 'finished'); assert.strictEqual(died.calls, 2, `the cleanup ran again after the respawn (${died.calls})`);
        assert.strictEqual(plain.calls, 1);
    });

    await test('the job\'s end runs again when its own round put down a movement block of the bot (mbc075b w2: the fall reflex\'s two blocks came after the cleanup and stayed); a round that put down none ends it (negative control)', async () => {
        const { runWorker } = require('../src/work/bot/worker');
        const { Ledger } = require('../src/work/jobs/crew');
        const { EventEmitter } = require('events');
        const { Temps } = require('../src/work/bot/temps');
        const run = async (place) => {
            const L = new Ledger({ maxAttempts: 3 }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 });
            const bot = new EventEmitter(); bot.username = 'b'; bot.__temps = new Temps(); let calls = 0;
            const job = { ledger: L, runUnit: async () => ({ ok: true }), cleanup: async () => { calls++; if (calls === 1 && place) bot.__temps.add({ x: 1, y: 60, z: 1, kind: 'reflex', by: 'b' }); else bot.__temps.remove('overworld', { x: 1, y: 60, z: 1 }); } };
            const env = { bot, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 0, z: 0 }), now: Date.now, exec: async () => ({ ok: true }) };
            const res = await runWorker(job, 'b', env, { pollMs: 2, backoff: () => 1 });
            return { res, calls, left: bot.__temps.size };
        };
        const a = await run(true), b = await run(false);
        assert.strictEqual(a.res.ended, 'finished'); assert.strictEqual(a.calls, 2, `ran again (${a.calls})`); assert.strictEqual(a.left, 0);
        assert.strictEqual(b.calls, 1);
    });

    await test('a seal whose fluid cell has no face in sight from any stand cell is placed by a blind click on a support within reach (the watery-chunk stall of mine_b)', async () => {
        const pit = require('../src/work/jobs/pit');
        const cells = new Map([['2,64,5', 'water']]);
        const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 64 && !(x === 1 && y === 64 && z === 5 && cells.get('1,64,5') === 'air') ? 'stone' : 'air'), kindAt(x, y, z) { const n = this.nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : 'solid'; } };
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
        const calls = [];
        const env = { w, have: (x) => (x === 'cobblestone' ? 64 : 0), pause: async () => {}, here: () => ({ x: 0, y: 65, z: 5 }), exec: async (n, a) => {
            calls.push([n, a.blind ? 'blind' : 'sighted', `${a.x},${a.y},${a.z}`]);
            if (n === 'place') { if (!a.blind) return { ok: false, reason: 'unreachable', detail: { why: 'no standing cell within reach of the target exists (it is inside rock)' } }; cells.set(`${a.x},${a.y},${a.z}`, 'cobblestone'); return { ok: true }; }
            if (n === 'mine') { cells.set(`${a.x},${a.y},${a.z}`, 'air'); return { ok: true }; }
            return { ok: true };
        } };
        let ok = true; for (let u = 0; u < region.layers * region.rows; u++) { const r = await job.runUnit(region.id, { unit: u }, env); ok = ok && r.ok; }
        assert(calls.some((c) => c[0] === 'place' && c[1] === 'blind' && c[2] === '2,64,5'), `the water cell sealed blind (${JSON.stringify(calls.filter((c) => c[0] === 'place'))})`);
    });

    await test('a fill block over a cell is dug before the cell, so it never hangs over the dug layer (mbc075a w3: 512 rubble fills over air); a fill that cannot be dug keeps the cell closed; negative control: a plain block over the cell is left to its own unit', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (fillRegistered, fillBreaks = true) => {
            const cells = new Map([['3,64,3', 'cobblestone']]);          // the fill, on the box's top layer 64; the box is the one layer 63 (its unit digs 63 only)
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air'), kindAt(x, y, z) { const n = this.nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : 'solid'; } };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 63 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            if (fillRegistered) job.plan.lakeFilled = new Set(['3,64,3']);
            const env = { w, have: () => 9, pause: async () => {}, recover: async () => {}, here: () => ({ x: 3, y: 65, z: 0 }), exec: async (n, a) => {
                if (n === 'mine') { if (a.y === 64 && !fillBreaks) return { ok: false, reason: 'unreachable' }; cells.set(`${a.x},${a.y},${a.z}`, 'air'); return { ok: true }; } return { ok: true }; } };
            for (let u = 0; u < region.layers * region.rows; u++) { const lay = Math.floor(u / region.rows); if (lay === 0) continue; await job.runUnit(region.id, { unit: u }, env); }          // only the layer under the fill
            return { fill: w.kindAt(3, 64, 3), under: w.kindAt(3, 63, 3) };
        };
        const a = await run(true); assert.deepStrictEqual(a, { fill: 'air', under: 'air' }, 'the fill went first, then the cell');
        const b = await run(true, false); assert.deepStrictEqual(b, { fill: 'solid', under: 'solid' }, 'an undiggable fill keeps the cell under it closed');
        const c = await run(false); assert.deepStrictEqual(c, { fill: 'solid', under: 'air' }, 'negative control: a block that is no fill is its own unit\'s');
    });

    await test('a unit whose cells are not loaded is not done: it walks back near the box once, else it goes back as the bot\'s failure (mbc075e w2: the whole box went done unloaded); negative control: once loaded it is dug', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (travelLoads) => {
            let loaded = false; const cells = new Map(); for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) cells.set(`${x},64,${z}`, 'stone');
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air'), kindAt: (x, y, z) => (!loaded ? 'unknown' : (cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
            for (const method of ['expert', 'rows']) {
                const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method, road: false }), region = job.plan.regions[0];
                const env = { w, have: () => 9, pause: async () => {}, here: () => ({ x: 3, y: 65, z: 3 }), travel: async () => { if (travelLoads) loaded = true; return { ok: true }; },
                    exec: async (n, a) => { if (n === 'mine') cells.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; } };
                const r = await job.runUnit(region.id, { unit: 0 }, env);
                if (!travelLoads) { assert.ok(!r.ok && r.detail && r.detail.botSide && r.detail.stage === 'unloaded', `${method}: ${JSON.stringify(r).slice(0, 160)}`); }
                else assert.ok(!(r.detail && r.detail.stage === 'unloaded'), `${method}: loaded after the walk, the unit works its cells: ${JSON.stringify(r).slice(0, 160)}`);
            }
        };
        await run(false); await run(true);
    });

    await test('after a unit the bot takes its own movement blocks within reach, stepping off the one it stands on first (mbc075f w3: three pillar pumpkins left in the box for 8-25 min); negative control: another bot\'s block stays', async () => {
        const pit = require('../src/work/jobs/pit'); const { Temps } = require('../src/work/bot/temps');
        const solid = new Set(['5,63,5', '7,63,5']); for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) solid.add(`${x},62,${z}`);
        const T = new Temps(); T.add({ x: 5, y: 63, z: 5, kind: 'pillar', by: 'P', item: 'pumpkin' }); T.add({ x: 7, y: 63, z: 5, kind: 'pillar', by: 'Q', item: 'pumpkin' });
        const pos = { x: 5.5, y: 64, z: 5.5 }, moves = [];
        const w = { kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? (y === 63 ? 'pumpkin' : 'stone') : 'air') };
        const env = { w, bot: { username: 'P', game: { dimension: 'overworld' }, __temps: T, entity: { position: pos } }, here: () => ({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }),
            exec: async (n, a) => { if (n === 'move_to') { moves.push(a); pos.x = a.x + 0.5; pos.y = a.y; pos.z = a.z + 0.5; return { ok: true }; } if (n === 'mine') { solid.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; } return { ok: true }; } };
        await pit.unitTidy(env);
        assert.ok(moves.length === 1, `stepped off its own block: ${JSON.stringify(moves)}`);
        assert.ok(!solid.has('5,63,5') && !T.has('overworld', { x: 5, y: 63, z: 5 }), 'its pillar block is gone');
        assert.ok(solid.has('7,63,5'), 'negative control: the other bot\'s block stays');
    });

    await test('pace: a reach failure skips the retry ladder, NAV goes at most three times per unit and a unit with more such cells hands them back (081 b081k: six tree units ran six minutes)', async () => {
        const pit = require('../src/work/jobs/pit');
        const cells = new Map(); for (let x = 1; x <= 6; x++) cells.set(`${x},64,3`, 'oak_leaves');
        const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
        let navs = 0, mines = 0;
        const env = { w, have: () => 9, pause: async () => {}, recover: async () => {}, here: () => ({ x: 0, y: 64, z: 20 }), nav: async (t, o) => { navs++; assert(o.deadline && o.deadline - Date.now() <= 60000 && o.deadline > Date.now(), 'each trip has its deadline'); return { ok: false, reason: 'timeout' }; },
            exec: async (n, a) => { if (n !== 'mine') return { ok: true }; if (cells.has(`${a.x},${a.y},${a.z}`)) { mines++; return { ok: false, reason: 'stuck', detail: { why: 'the same unmet precondition', unmet: [{ need: 'in_reach', dist: 9, max: 4.2 }] } }; } return { ok: true }; } };
        let fails = 0; for (let u = 0; u < region.layers * region.rows; u++) { const r = await job.runUnit(region.id, { unit: u }, env); if (!r.ok) fails++; }
        assert(fails >= 1, 'the unit fails visibly (handed back)');
        assert(navs <= 3 * fails, `NAV trips capped per unit (${navs} for ${fails} failed units)`);
        assert(mines <= 6 * 3, `no six-try ladder per cell (${mines} mines for 6 cells)`);
    });

    await test('canopy: after a NAV trip the bot takes every tree block of the box within reach, from the top, never one under a bot or in its own column below the feet, never one out of reach', async () => {
        const pit = require('../src/work/jobs/pit');
        const cells = new Map([['3,70,3', 'oak_leaves'], ['4,71,3', 'oak_leaves'], ['2,69,4', 'oak_leaves'], ['2,67,3', 'oak_leaves'], ['5,68,3', 'oak_leaves'], ['7,70,7', 'oak_leaves'], ['3,66,6', 'stone']]);
        const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 72, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
        const pos = { x: 0, y: 64, z: 0 }, mined = [];
        const env = { w, have: () => 9, pause: async () => {}, here: () => ({ ...pos }), others: () => [{ name: 'B', x: 5.5, y: 69, z: 3.5 }],
            nav: async () => { pos.x = 2; pos.y = 68; pos.z = 3; return { ok: true }; },
            exec: async (n, a) => { if (n !== 'mine') return { ok: true }; const k = `${a.x},${a.y},${a.z}`; if (k === '3,70,3' && pos.x === 0) return { ok: false, reason: 'unreachable', detail: { unmet: [{ need: 'in_reach' }] } }; mined.push(k); cells.delete(k); return { ok: true }; } };
        const u = [...Array(region.layers * region.rows).keys()].find((i) => pit.unitCells(job.plan, region, i).some((c) => c.x === 3 && c.y === 70 && c.z === 3));
        await job.runUnit(region.id, { unit: u }, env);
        assert(mined.includes('3,70,3') && mined.includes('4,71,3') && mined.includes('2,69,4'), `the trip's cell and the leaves in reach (${mined})`);
        assert(mined.indexOf('4,71,3') < mined.indexOf('2,69,4'), 'from the top');
        assert(!mined.includes('2,67,3'), 'not in its own column below the feet'); assert(!mined.includes('5,68,3'), 'not the block under another bot');
        assert(!mined.includes('7,70,7'), 'not out of reach'); assert(!mined.includes('3,66,6'), 'not rock');
    });

    await test('the end: a bot standing on the top of its own pillar in the dug box goes down its column first (descend), and the block is gone (mb075k w3: the one pumpkin left, under the bot); a pillar it does not stand on is not descended (negative control)', async () => {
        const pit = require('../src/work/jobs/pit'), { Temps } = require('../src/work/bot/temps');
        const run = async (standOn) => {
            const solid = new Set(['5,10,5']); for (let x = 0; x <= 9; x++) for (let z = 0; z <= 9; z++) solid.add(`${x},5,${z}`);       // a pillar block at y 10 over the dug box, the floor at y 5
            const w = { kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'pumpkin' : 'air') };
            const temps = new Temps(); temps.add({ x: 5, y: 10, z: 5, kind: 'pillar', by: 'P', item: 'pumpkin' });
            const pos = standOn ? { x: 5, y: 11, z: 5 } : { x: 1, y: 6, z: 1 }; const runs = [];
            const env = { w, temps, bot: { username: 'P', game: { dimension: 'overworld' } }, here: () => ({ ...pos }), exec: async () => ({ ok: false, reason: 'unreachable' }), pause: async () => {},
                run: async (n, a) => { runs.push([n, a.levels]); if (n === 'descend') { solid.delete('5,10,5'); pos.y = 6; return { ok: true, detail: { levels: a.levels } }; } return { ok: false, reason: 'unreachable' }; } };
            const res = await pit.cleanHanging({ box: { x0: 0, x1: 9, z0: 0, z1: 9, top: 12, bottom: 6 }, regions: [] }, env);
            return { res, runs, left: solid.has('5,10,5'), reg: temps.size };
        };
        const on = await run(true);
        assert.deepStrictEqual(on.runs[0], ['descend', 5], JSON.stringify(on.runs)); assert(!on.left && on.reg === 0 && on.res.left === 0, JSON.stringify(on));
        const off = await run(false);
        assert(!off.runs.some((r) => r[0] === 'descend'), 'no descent for a pillar the bot does not stand on');
    });

    await test('a tree block within the server\'s reach is mined blind at once (no aimed mine and its retries first: b081m, a leaf 627 s, a vine 373 s); rock within reach still gets the aimed mine (negative control)', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (name) => {
            const cells = new Map([['2,65,1', name]]);
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y <= 63 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 65, bottom: 65 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            const calls = [];
            const env = { w, have: () => 9, pause: async () => {}, here: () => ({ x: 1, y: 64, z: 1 }), exec: async (n, a) => { if (n === 'mine') { calls.push(a.blind ? 'blind' : 'aimed'); cells.delete(`${a.x},${a.y},${a.z}`); } return { ok: true }; } };
            for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env);
            return calls;
        };
        assert.deepStrictEqual(await run('vine'), ['blind']); assert.deepStrictEqual(await run('oak_leaves'), ['blind']);
        assert.deepStrictEqual(await run('stone'), ['aimed']);
    });

    await test('bamboo is broken at its root, below the box too, so it cannot grow back into the dug pit (bt075v3 jungle: 95 bamboo left); a log column below the box is left alone (negative control)', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (name) => {
            const cells = new Map(); for (let y = 61; y <= 68; y++) cells.set(`3,${y},3`, name);
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 60 ? 'dirt' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y <= 60 ? 'dirt' : 'air')) === 'air' ? 'air' : 'solid') };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 68, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            const env = { w, have: () => 9, pause: async () => {}, here: () => ({ x: 2, y: 63, z: 3 }),
                exec: async (n, a) => { if (n !== 'mine') return { ok: true }; const k = `${a.x},${a.y},${a.z}`; if (!cells.has(k)) return { ok: true };
                    if (/^bamboo/.test(cells.get(k))) { for (let y = a.y; cells.has(`${a.x},${y},${a.z}`); y++) cells.delete(`${a.x},${y},${a.z}`); } else cells.delete(k); return { ok: true }; } };
            for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env);
            return [...cells.keys()];
        };
        assert.deepStrictEqual(await run('bamboo'), [], 'the whole stalk is gone, root included');
        assert.deepStrictEqual((await run('jungle_log')).sort(), ['3,61,3', '3,62,3', '3,63,3'], 'a log below the box stays');
    });

    await test('a cell\'s late steps (lift, bridge, descend) are skipped once its time is over, and their mines carry the deadline (bt075w3 jungle: cells of 547-698 s with no NAV trip); within its time the bridge is tried (negative control)', async () => {
        const pit = require('../src/work/jobs/pit');
        const real = Date.now;
        const run = async (msPerMine) => {
            let t = real(); Date.now = () => t;
            try {
                const cells = new Map([['10,64,3', 'stone']]);
                const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
                const job = pit.createPitJob({ x0: 0, z0: 0, x1: 15, z1: 15, top: 64, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
                const calls = [];
                const env = { w, have: () => 9, pause: async () => {}, recover: async () => {}, here: () => ({ x: 3, y: 65, z: 3 }),
                    lift: async () => { calls.push('lift'); return { ok: false, reason: 'refused' }; },
                    bridgeToward: async () => { calls.push('bridge'); return { ok: false, reason: 'unreachable' }; },
                    exec: async (n, a, o = {}) => { if (n === 'mine') { calls.push(o.deadline ? 'mine+deadline' : 'mine'); t += msPerMine; return { ok: false, reason: 'unreachable' }; } return { ok: true }; } };
                for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env);
                return calls;
            } finally { Date.now = real; }
        };
        const slow = await run(70000);
        assert.ok(!slow.includes('bridge') && !slow.includes('lift'), `no late steps after the cell's time: ${slow.join(',')}`);
        const quick = await run(1000);
        assert.ok(quick.includes('bridge'), `within its time the bridge is tried: ${quick.join(',')}`);
    });

    await test('a pit unit ends after 6 min whatever its method (bt075w4: one sweep unit ran 15 min, the stall cap ended the pit); a fast unit is not cut (negative control)', async () => {
        const pit = require('../src/work/jobs/pit');
        const real = Date.now;
        const run = async (msPerMine) => {
            let t = real(); Date.now = () => t;
            try {
                const cells = new Map(); for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) cells.set(`${x},64,${z}`, 'stone');
                const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
                const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method: 'sweep', road: false }), region = job.plan.regions[0];
                let mines = 0;
                const env = { w, have: () => 9, pause: async () => {}, here: () => ({ x: 3, y: 65, z: 3 }), exec: async (n, a) => { if (n === 'mine') { mines++; t += msPerMine; cells.delete(`${a.x},${a.y},${a.z}`); } return { ok: true }; } };
                const r = await job.runUnit(region.id, { unit: 0 }, env);
                return { r, mines };
            } finally { Date.now = real; }
        };
        const slow = await run(60000);
        assert.ok(!slow.r.ok && slow.r.reason === 'timeout', JSON.stringify(slow.r).slice(0, 160)); assert.ok(slow.mines <= 8, `${slow.mines} mines`);
        const fast = await run(100);
        assert.ok(fast.r.ok, JSON.stringify(fast.r).slice(0, 160));
    });

    await test('the tree pass takes a low tree block within reach blind, without a walk (forest pace: aimed mines walked to every low leaf); negative control: one out of reach gets the aimed mine', async () => {
        const near = world([[1, GROUND + 1, 0, 'oak_leaves']]), a = fakeEnv(near, { x: 0, y: GROUND + 1, z: 0 });
        await clearTrees(a.env, { x0: -4, x1: 4, z0: -4, z1: 4, top: GROUND + 6 });
        assert.strictEqual(near.kindAt(1, GROUND + 1, 0), 'air'); assert.strictEqual(a.calls.blind, 1); assert.strictEqual(a.calls.mine, 1, 'one blind mine, no aimed one');
        const far = world([[4, GROUND + 1, 4, 'oak_leaves']]), b = fakeEnv(far, { x: -4, y: GROUND + 1, z: -4 });
        await clearTrees(b.env, { x0: -4, x1: 4, z0: -4, z1: 4, top: GROUND + 6 });
        assert.strictEqual(far.kindAt(4, GROUND + 1, 4), 'air'); assert.strictEqual(b.calls.blind, 0, 'negative control: out of reach, the aimed mine walks to it');
    });

    await test('a column the walk on foot cannot reach is reached by one NAV trip and the aerial block goes (mb075r w2: 249 hanging fills "no progress from the columns"); negative control: without NAV the block is given up', async () => {
        const mk = () => { const w = world([[5, GROUND + 9, 5, 'oak_leaves']]); const f = fakeEnv(w, { x: 0, y: GROUND + 1, z: 0 }); const mv = f.env.exec; f.env.exec = async (n, a) => (n === 'move_to' ? { ok: false, reason: 'unreachable' } : mv(n, a)); return { w, ...f }; };
        const a = mk(); let trips = 0;
        a.env.nav = async (t) => { trips++; a.pos.x = t.x; a.pos.y = t.y; a.pos.z = t.z; return { ok: true }; };
        const ra = await clearTrees(a.env, { x0: 0, x1: 15, z0: 0, z1: 15, top: GROUND + 12 });
        assert.strictEqual(a.w.kindAt(5, GROUND + 9, 5), 'air', JSON.stringify(ra).slice(0, 200)); assert.ok(trips >= 1); assert.strictEqual(cobble(a.w), 0, 'the pillar is gone');
        const b = mk(); const rb = await clearTrees(b.env, { x0: 0, x1: 15, z0: 0, z1: 15, top: GROUND + 12 });
        assert.strictEqual(b.w.kindAt(5, GROUND + 9, 5), 'solid', 'negative control: the leaf stays'); assert.ok(rb.failed.length >= 1);
    });

    await test('huge mushroom blocks are tree blocks (fr075c dark forest, 1.21.1: 5 cap blocks left in the dug pit); negative control: the small mushroom plant and stone are not', () => {
        assert(isTree('minecraft:red_mushroom_block') && isTree('brown_mushroom_block') && isTree('mushroom_stem'));
        assert(!isTree('red_mushroom') && !isTree('brown_mushroom') && !isTree('stone'));
        const b = []; for (let x = 5; x <= 9; x++) for (let z = 5; z <= 9; z++) b.push([x, GROUND + 7, z, 'red_mushroom_block']);
        assert.strictEqual(scan(world(b), BOX).length, 25, 'a cap hanging in the box is the tree pass\'s');
    });

    await test('a bamboo stalk is one target, its lowest block: one mine takes it all, no pillar (fr075c: 20 bamboo left); negative control: a log column is every block', async () => {
        const stalk = (n) => { const b = []; for (let y = GROUND + 1; y <= GROUND + 12; y++) b.push([6, y, 6, n]); return world(b); };
        const w = stalk('bamboo'), found = scan(w, BOX);
        assert.deepStrictEqual(found.map((c) => c.y), [GROUND + 1], 'only the root is listed');
        assert.deepStrictEqual(scan(w, BOX, { skip: new Set([`6,${GROUND + 1},6`]) }).map((c) => c.y), [GROUND + 2], 'a root given up: the next block up is the target');
        const { env, calls } = fakeEnv(w, { x: 4, y: GROUND + 1, z: 6 }), mine = env.exec;
        env.exec = async (n, a) => { if (n === 'mine' && /^bamboo/.test(w.nameAt(a.x, a.y, a.z))) for (let y = a.y + 1; /^bamboo/.test(w.nameAt(a.x, y, a.z)); y++) w.set(a.x, y, a.z, 'air'); return mine(n, a); };
        const res = await clearTrees(env, BOX);
        assert.strictEqual(res.ok, true, JSON.stringify(res)); assert.strictEqual(left(w), 0); assert.strictEqual(calls.mine, 1, 'one mine'); assert.strictEqual(calls.pillar, 0, 'no pillar');
        assert.strictEqual(scan(stalk('jungle_log'), BOX).length, 12, 'negative control: logs do not fall, each is a target');
    });

    await test('the pit takes a bamboo root under the box bottom by one NAV trip when it is out of reach (fr075c); negative control: without NAV the root stays and the stalk grows back', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (withNav) => {
            const cells = new Map(); for (let y = 61; y <= 68; y++) cells.set(`3,${y},3`, 'bamboo');
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y <= 60 ? 'dirt' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y <= 60 ? 'dirt' : 'air')) === 'air' ? 'air' : 'solid') };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 68, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            const pos = { x: 7, y: 63, z: 7 }; let trips = 0;
            const env = { w, have: () => 9, pause: async () => {}, here: () => ({ ...pos }),
                exec: async (n, a) => { if (n !== 'mine') return { ok: true }; const k = `${a.x},${a.y},${a.z}`; if (!cells.has(k)) return { ok: true };
                    for (let y = a.y; cells.has(`${a.x},${y},${a.z}`); y++) cells.delete(`${a.x},${y},${a.z}`); return { ok: true }; } };
            if (withNav) env.nav = async (t) => { trips++; pos.x = t.x - 1; pos.y = t.y + 2; pos.z = t.z; return { ok: true }; };
            process.env.PIT_TREES = '0';
            try { for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env); } finally { delete process.env.PIT_TREES; }
            return { left: [...cells.keys()], trips };
        };
        const a = await run(true); assert.deepStrictEqual(a.left, [], 'root taken'); assert.ok(a.trips >= 1);
        const b = await run(false); assert.deepStrictEqual(b.left.sort(), ['3,61,3', '3,62,3', '3,63,3'], 'negative control: the root under the box stays');
    });

    await test('a leaf 4.98 from the eye goes by one blind mine (the action layer allows 5.0; b081u4: site pits sat 10-15 min behind one leased unit for it); negative control: at 5.08 no blind mine is sent', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (lx) => {
            const leaf = { x: lx, y: 6, z: 3 }; let present = true; const calls = [];
            const here = { x: 3, y: 0, z: 2 };
            const eye = (a) => Math.hypot(here.x + 0.5 - (a.x + 0.5), here.y + 1.62 - (a.y + 0.5), here.z + 0.5 - (a.z + 0.5));
            const w = { nameAt: (x, y, z) => (present && x === leaf.x && y === leaf.y && z === leaf.z ? 'oak_leaves' : y < 0 ? 'stone' : 'air'), kindAt: (x, y, z) => (w.nameAt(x, y, z) === 'air' ? 'air' : 'solid') };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: leaf.y, bottom: leaf.y }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            const env = { w, have: () => 9, pause: async () => {}, recover: async () => {}, here: () => ({ ...here }),
                exec: async (n, a) => { if (n !== 'mine') return { ok: true }; calls.push(a.blind ? `blind ${eye(a).toFixed(2)}` : 'aimed');
                    if (a.blind && eye(a) <= 5.0) { present = false; return { ok: true }; }
                    return { ok: false, reason: 'precondition_failed', detail: { unmet: [{ need: 'in_reach', dist: eye(a), max: 4.2 }] } }; } };
            process.env.PIT_TREES = '0';
            try { for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env); } finally { delete process.env.PIT_TREES; }
            return { present, calls, d: eye(leaf) };
        };
        const a = await run(3);
        assert.ok(a.d > 4.6 && a.d <= 5.0, `distance ${a.d}`); assert.strictEqual(a.present, false, JSON.stringify(a.calls)); assert.ok(a.calls[0].startsWith('blind'), JSON.stringify(a.calls));
        const b = await run(4);
        assert.ok(b.d > 5.0, `distance ${b.d}`); assert.strictEqual(b.present, true); assert.ok(!b.calls.some((c) => c.startsWith('blind')), `negative control: ${JSON.stringify(b.calls)}`);
    });

    await test('a budding amethyst just outside the box beside a dug cell is broken too, so no bud grows back into the box (mbc075p w1); negative control: an amethyst block there stays', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (outside) => {
            const cells = new Map([['3,64,3', 'stone'], ['8,64,3', outside]]);
            const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air'), kindAt: (x, y, z) => ((cells.get(`${x},${y},${z}`) || (y < 64 ? 'stone' : 'air')) === 'air' ? 'air' : 'solid') };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            for (let z = 0; z <= 7; z++) for (let x = 0; x <= 7; x++) if (!cells.has(`${x},64,${z}`)) cells.set(`${x},64,${z}`, 'stone');
            const env = { w, have: () => 9, pause: async () => {}, here: () => ({ x: 6, y: 65, z: 3 }), exec: async (n, a) => { if (n === 'mine') cells.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; } };
            process.env.PIT_TREES = '0';
            try { for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env); } finally { delete process.env.PIT_TREES; }
            return cells.get('8,64,3') || 'air';
        };
        assert.strictEqual(await run('budding_amethyst'), 'air', 'the budding amethyst is gone');
        assert.strictEqual(await run('amethyst_block'), 'amethyst_block', 'negative control: an amethyst block outside the box stays');
    });

    await test('the floor before the dig: water under a cell that is still solid is closed against its bottom face first, so no dug cell is left over water (mbc075r w2: an aquifer under the floor, the bot fell in); negative control: with PIT_FLOOR_FIRST=0 the holes stay open', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (first) => {
            const cells = new Map(); const at = (x, y, z) => cells.get(`${x},${y},${z}`) || (y >= 65 ? 'air' : y <= 58 ? 'stone' : y === 64 ? 'stone' : (x >= 0 && x <= 7 && z >= 0 && z <= 7 ? 'water' : 'stone'));
            const kindAt = (x, y, z) => { const n = at(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : 'solid'; };
            const w = { nameAt: at, kindAt };
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 63 }, {}, { method: 'rows', road: false }), region = job.plan.regions[0];
            const holes = [], blindFloors = [];
            const env = { w, have: (i) => (i === 'cobblestone' ? 64 : 0), pause: async () => {}, recover: async () => {}, here: () => ({ x: 3, y: 65, z: -2 }),
                exec: async (n, a) => {
                    if (n === 'mine') { cells.set(`${a.x},${a.y},${a.z}`, 'air'); if (a.y === 64 && kindAt(a.x, 63, a.z) === 'water') holes.push([a.x, a.z]); return { ok: true }; }
                    if (n === 'place') {
                        // a click needs a solid face beside, under or over the target (the server's rule; placeBlind picks one within reach)
                        const face = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => kindAt(a.x + dx, a.y + dy, a.z + dz) === 'solid');
                        if (!face) return { ok: false, reason: 'invalid_target' };
                        cells.set(`${a.x},${a.y},${a.z}`, a.item); if (a.blind && a.y === 63) blindFloors.push([a.x, a.z]); return { ok: true };
                    }
                    if (n === 'move_to') return { ok: false, reason: 'unreachable' };
                    return { ok: true };
                } };
            process.env.PIT_TREES = '0'; if (!first) process.env.PIT_FLOOR_FIRST = '0';
            try { for (let u = 0; u < region.rows; u++) await job.runUnit(region.id, { unit: u }, env); } finally { delete process.env.PIT_TREES; delete process.env.PIT_FLOOR_FIRST; }
            return { holes, blindFloors };
        };
        const a = await run(true);
        assert.strictEqual(a.holes.length, 0, `no cell of the layer was opened over water: ${JSON.stringify(a.holes.slice(0, 5))}`); assert.strictEqual(a.blindFloors.length, 64, 'each floor cell closed by a blind click');
        const b = await run(false);
        assert.ok(b.holes.length > 0, `negative control: ${b.holes.length} holes over water`);
    });

    await test('the rule for a lake fill in the box (one sentence): it is work, so the water it holds back is filled one cell further out, outside the box, and then it is broken; only the fill outside the box stays (mbc075s w3: 4 fills at the box edge kept a layer dirty); negative control: while the water cannot be filled further out, the fill holds it back and stays', async () => {
        const pit = require('../src/work/jobs/pit');
        const run = async (canPlace) => {
            // the dug box x 0..9 (floor y 60); the fill at the box edge (0,61,5) holds back water at (-1,61,5), in the ring outside the box; rock outside at y 61
            const w = world([[0, 61, 5, 'cobblestone']]);
            for (let x = -4; x <= -1; x++) for (let z = 0; z <= 9; z++) w.set(x, 61, z, x === -1 && z === 5 ? 'water' : 'stone');
            const f = fakeEnv(w, { x: 2, y: 61, z: 5 }), mv = f.env.exec, placed = [];
            f.env.exec = async (n, a) => { if (n === 'place') { if (!canPlace) return { ok: false, reason: 'unreachable' }; w.set(a.x, a.y, a.z, a.item); placed.push([a.x, a.y, a.z]); return { ok: true }; } return mv(n, a); };
            Object.assign(f.env, { have: (i) => (i === 'cobblestone' ? 9 : 0), pause: async () => {} });
            const plan = { box: { x0: 0, x1: 9, z0: 0, z1: 9, top: 70, bottom: 61 }, regions: [], lakeFilled: new Set(['0,61,5']) };
            const res = await pit.cleanHanging(plan, f.env);
            return { res, fill: w.nameAt(0, 61, 5), ring: w.nameAt(-1, 61, 5), placed };
        };
        const a = await run(true);
        assert.strictEqual(a.ring, 'cobblestone', `the water outside is filled: ${JSON.stringify(a)}`); assert.strictEqual(a.fill, 'air', `the fill in the box is broken: ${JSON.stringify(a.res)}`);
        const b = await run(false);
        assert.strictEqual(b.fill, 'cobblestone', 'negative control: the fill still holds the water back and stays'); assert.strictEqual(b.ring, 'water');
    });

    await test('the hanging pass never mines the block the bot stands on (mbc075t w1: it mined a hanging block under its feet 40 over the dug floor and fell to its death); negative control: the same block with the bot beside it is mined', async () => {
        const run = async (onIt) => {
            const w = world([[5, 80, 5, 'cobblestone'], [6, 80, 5, 'cobblestone']]);
            const f = fakeEnv(w, onIt ? { x: 5, y: 81, z: 5 } : { x: 6, y: 81, z: 5 }), under = [];
            const mv = f.env.exec; f.env.exec = async (n, a) => { if (n === 'mine') { const h = f.env.here(); if (a.x === h.x && a.z === h.z && a.y === h.y - 1) under.push([a.x, a.y, a.z]); } return mv(n, a); };
            const find = (ww) => (ww.kindAt(5, 80, 5) === 'solid' ? [{ x: 5, y: 80, z: 5, gy: GROUND }] : []);
            await clearTrees(f.env, { x0: 0, x1: 15, z0: 0, z1: 15, top: 90 }, { find, maxMs: 3000, done: (c) => w.kindAt(c.x, c.y, c.z) !== 'solid' });
            return { under, left: w.nameAt(5, 80, 5) };
        };
        const a = await run(true);
        assert.deepStrictEqual(a.under, [], `never the block under the feet: ${JSON.stringify(a)}`);
        const b = await run(false);
        assert.strictEqual(b.left, 'air', 'negative control: from beside it the block is mined');
    });

    await test('the tree pass ends after three NAV trips in a row that got nowhere (mbc075q w3: the respawned bot spent 30 min of the job\'s end on futile trips); negative control: trips that arrive go on', async () => {
        const mk = () => { const b = []; for (let i = 0; i < 8; i++) b.push([2 + i, GROUND + 9, 5, 'oak_leaves']); const w = world(b); const f = fakeEnv(w, { x: 0, y: GROUND + 1, z: 0 }); const mv = f.env.exec; f.env.exec = async (n, a) => (n === 'move_to' ? { ok: false, reason: 'unreachable' } : mv(n, a)); return { ...f, w }; };
        const a = mk(); let trips = 0; a.env.nav = async () => { trips++; return { ok: false, reason: 'stuck' }; };
        const ra = await clearTrees(a.env, { x0: 0, x1: 15, z0: 0, z1: 15, top: GROUND + 12 });
        assert.strictEqual(trips, 3, `three trips, then it ends: ${trips}`); assert.strictEqual(ra.navGaveUp, true);
        const b = mk(); let tb = 0; b.env.nav = async (t) => { tb++; b.pos.x = t.x; b.pos.y = t.y; b.pos.z = t.z; return { ok: true }; };
        const rb = await clearTrees(b.env, { x0: 0, x1: 15, z0: 0, z1: 15, top: GROUND + 12 });
        assert.ok(!rb.navGaveUp && tb >= 1 && left(b.w, { x0: 0, x1: 15, z0: 0, z1: 15, top: GROUND + 12 }) === 0, `negative control: ${JSON.stringify(rb).slice(0, 200)}`);
    });

    console.log('\npit trees: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

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
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 7, z1: 7, top: 64, bottom: 64 }, {}, { method: 'rows', road: false, plants }), region = job.plan.regions[0], mined = [];
            const env = { w, have: () => 9, pause: async () => {}, here: () => ({ x: 0, y: 64, z: 0 }), exec: async (n, a) => { if (n === 'mine') { mined.push(`${a.x},${a.y},${a.z}`); cells.delete(`${a.x},${a.y},${a.z}`); } return { ok: true }; } };
            for (let u = 0; u < region.layers * region.rows; u++) await job.runUnit(region.id, { unit: u }, env);
            const left = []; for (let u = 0; u < region.layers * region.rows; u++) left.push(...pit.wrongCells(job.plan, region, u, w));
            return { mined, left: left.length };
        };
        const site = await run(true), plain = await run(false);
        assert(site.mined.includes('2,64,2') && site.mined.includes('3,64,3') && site.mined.includes('4,64,4') && site.left === 0, `site: plants dug (${site.mined})`);
        assert(!plain.mined.includes('2,64,2') && !plain.mined.includes('3,64,3') && plain.mined.includes('4,64,4'), `negative control: a plain pit leaves them (${plain.mined})`);
    });

    console.log('\npit trees: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

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

    console.log('\npit trees: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

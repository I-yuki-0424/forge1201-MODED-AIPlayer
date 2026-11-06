// Structure files as editable data (src/work/blueprint.js): write/read round trip, rotation and mirror of positions and block
// states, replace/remove/crop/fill/merge, and a rotated structure built by the real build planner. No server.
const assert = require('assert');
const bp = require('../src/work/jobs/blueprint');
const build = require('../src/work/jobs/build');
// The bots' transport patches prismarine-nbt process-wide; every test below runs under that patch (a live console broke on it).
require('../src/transport/forge_bot').applyProtocolBypasses();

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const at = (b, x, y, z) => { const e = b.blocks.find((q) => q.x === x && q.y === y && q.z === z); return e ? b.palette[e.s] : null; };

// 3 wide (x), 2 high, 4 deep (z): a stair facing north at the origin, a log along x, a fence-like block with sides, a chest.
function sample() {
    return bp.fromCells([
        { x: 0, y: 0, z: 0, block: 'oak_stairs[facing=north,half=bottom,shape=inner_left]' },
        { x: 1, y: 0, z: 0, block: 'oak_log[axis=x]' },
        { x: 2, y: 0, z: 3, block: 'oak_fence[north=true,east=false,south=false,west=true]' },
        { x: 0, y: 1, z: 3, block: 'create:cogwheel[axis=z]' },
        { x: 2, y: 1, z: 1, block: 'chest[facing=east,type=left]' },
        { x: 1, y: 1, z: 2, block: 'rail[shape=north_east]' },
    ]);
}
const SZ = [3, 2, 4];

(async () => {
    await test('file: write then read gives the same structure; block entity tags survive', async () => {
        const a = sample(); a.size = SZ;
        a.blocks[0].nbt = { type: 'compound', value: { id: { type: 'string', value: 'minecraft:chest' }, Items: { type: 'list', value: { type: 'end', value: [] } } } };
        const b = await bp.read(bp.write(a));
        assert.deepStrictEqual(b.size, SZ);
        assert.strictEqual(b.blocks.length, a.blocks.length);
        assert.strictEqual(at(b, 0, 0, 0).props.facing, 'north');
        assert.strictEqual(at(b, 0, 1, 3).name, 'create:cogwheel');
        assert.ok(b.blocks.find((q) => q.x === 0 && q.y === 0 && q.z === 0).nbt, 'nbt kept');
        await assert.rejects(() => bp.read(Buffer.from('this is not nbt at all')), /NBT|structure/);
    });

    await test('rotate: four turns are the identity; one turn moves positions and turns facings clockwise', () => {
        const a = sample(); a.size = SZ;
        let r = a; for (let i = 0; i < 4; i++) r = bp.rotate(r, 1);
        assert.deepStrictEqual(r.size, SZ);
        for (const q of a.blocks) assert.strictEqual(bp.keyOf(at(r, q.x, q.y, q.z).name, at(r, q.x, q.y, q.z).props), bp.keyOf(a.palette[q.s].name, a.palette[q.s].props));
        const one = bp.rotate(a, 1);
        assert.deepStrictEqual(one.size, [4, 2, 3]);                           // x and z swap
        assert.strictEqual(at(one, 3, 0, 0).props.facing, 'east');              // (0,0,0) -> (D-1-0, 0) ; north -> east
        assert.strictEqual(at(one, 3, 0, 1).props.axis, 'z');                   // log along x now runs along z
        const fence = at(one, 0, 0, 2);                                         // (2,0,3) -> (D-1-3=0, 2)
        assert.deepStrictEqual([fence.props.north, fence.props.east, fence.props.south, fence.props.west], ['true', 'true', 'false', 'false']);   // n,w -> e,n
        assert.strictEqual(at(one, 0, 1, 0).props.axis, 'x');                   // cogwheel axis z -> x
        assert.strictEqual(at(one, 1, 1, 1).props.shape, 'south_east');         // rail north_east -> east_south -> game spelling south_east
        assert.strictEqual(bp.rotate(a, 2).size[0], 3);
        assert.strictEqual(at(bp.rotate(a, 2), 2, 0, 3).props.facing, 'south');
    });

    await test('mirror: positions flip, facing and handedness swap; twice is the identity', () => {
        const a = sample(); a.size = SZ;
        const m = bp.mirror(a, 'x');
        assert.strictEqual(at(m, 2, 0, 0).name, 'minecraft:oak_stairs');
        assert.strictEqual(at(m, 2, 0, 0).props.shape, 'inner_right');
        assert.strictEqual(at(m, 0, 1, 1).props.facing, 'west');
        assert.strictEqual(at(m, 0, 1, 1).props.type, 'right');
        const mm = bp.mirror(m, 'x');
        for (const q of a.blocks) assert.strictEqual(bp.keyOf(at(mm, q.x, q.y, q.z).name, at(mm, q.x, q.y, q.z).props), bp.keyOf(a.palette[q.s].name, a.palette[q.s].props));
        assert.throws(() => bp.mirror(a, 'y'), /axis/);
    });

    await test('replace / remove / crop / fill / empty', () => {
        const a = sample(); a.size = SZ;
        const r = bp.replace(a, { oak_stairs: 'stone_stairs', 'oak_fence': 'minecraft:spruce_fence' });
        assert.strictEqual(at(r, 0, 0, 0).name, 'minecraft:stone_stairs');
        assert.strictEqual(at(r, 0, 0, 0).props.facing, 'north', 'a rename keeps the state');
        const exact = bp.replace(a, { 'oak_log[axis=x]': 'birch_log[axis=y]' });
        assert.strictEqual(at(exact, 1, 0, 0).props.axis, 'y');
        assert.strictEqual(bp.remove(a, ['chest']).blocks.length, a.blocks.length - 1);
        const c = bp.crop(a, { x0: 1, y0: 0, z0: 0, x1: 2, y1: 0, z1: 3 });
        assert.deepStrictEqual(c.size, [2, 1, 4]);
        assert.strictEqual(at(c, 0, 0, 0).props.axis, 'x');
        const f = bp.fill(bp.empty(4, 3, 4), { x0: 0, y0: 0, z0: 0, x1: 3, y1: 0, z1: 3 }, 'cobblestone');
        assert.strictEqual(f.blocks.length, 16);
        assert.throws(() => bp.fill(bp.empty(2, 2, 2), { x0: 0, y0: 0, z0: 0, x1: 5, y1: 0, z1: 0 }, 'stone'), /outside/);
        assert.throws(() => bp.replace(a, { stone: 'stone[x=1;rm -rf]' }), /bad/);
        assert.throws(() => bp.parseState('Evil Name'), /bad/);
    });

    await test('merge: parts at offsets (negative ones shift the result), air never overwrites, later parts win', () => {
        const floor = bp.fill(bp.empty(4, 1, 4), { x0: 0, y0: 0, z0: 0, x1: 3, y1: 0, z1: 3 }, 'stone');
        const wall = bp.fill(bp.empty(4, 3, 1), { x0: 0, y0: 0, z0: 0, x1: 3, y1: 2, z1: 0 }, 'oak_planks');
        const m = bp.merge([{ bp: floor, at: { x: 0, y: 0, z: 0 } }, { bp: wall, at: { x: 0, y: 0, z: -1 } }]);
        assert.deepStrictEqual(m.size, [4, 3, 5]);
        assert.strictEqual(at(m, 0, 0, 0).name, 'minecraft:oak_planks');       // the wall stands at the (shifted) z=0
        assert.strictEqual(at(m, 0, 0, 1).name, 'minecraft:stone');
        assert.strictEqual(m.blocks.length, 16 + 12);
        assert.throws(() => bp.merge([{ bp: floor, at: { x: 0, y: 0, z: 0 } }, { bp: floor, at: { x: 1000, y: 0, z: 0 } }]), /limit/);
    });

    await test('applyOps: a list of steps, merge by name, unknown steps refused', async () => {
        const wall = bp.fill(bp.empty(4, 3, 1), { x0: 0, y0: 0, z0: 0, x1: 3, y1: 2, z1: 0 }, 'oak_planks');
        const lib = { wall };
        const out = await bp.applyOps(wall, [{ op: 'merge', parts: [{ name: 'wall', rotate: 1, x: 0, y: 0, z: 0 }] }, { op: 'replace', from: 'oak_planks', to: 'spruce_planks' }, { op: 'rotate', turns: 1 }], async (n) => lib[n]);
        assert.ok(out.blocks.length > 12 && out.palette.every((p) => p.name === 'minecraft:spruce_planks'));
        await assert.rejects(() => bp.applyOps(wall, [{ op: 'explode' }], async () => null), /unknown step/);
        await assert.rejects(() => bp.applyOps(wall, new Array(65).fill({ op: 'rotate', turns: 1 }), async () => null), /at most 64/);
    });

    await test('stats / layer / cells: counts, mods, unplaceable blocks, a layer grid, build cells', () => {
        const a = sample(); a.size = SZ;
        const st = bp.stats(a, (n) => !n.startsWith('create:'));
        assert.deepStrictEqual(st.mods, ['create']);
        assert.deepStrictEqual(st.unknown, ['create:cogwheel']);
        assert.strictEqual(st.blocks, 6);
        const l = bp.layer(a, 0);
        assert.strictEqual(l.grid.length, 12);
        assert.notStrictEqual(l.grid[0], -1);
        assert.throws(() => bp.layer(a, 5), /outside/);
        const c = bp.cells(a);
        assert.ok(c.find((q) => q.block === 'oak_stairs' && q.props.facing === 'north'));
        assert.ok(c.find((q) => q.block === 'create:cogwheel'));
    });

    await test('the build planner takes a rotated, edited blueprint (cells keep position and namespace)', () => {
        const house = bp.fromCells(build.house({ w: 5, d: 5, h: 3 }));
        const turned = bp.rotate(bp.replace(house, { oak_planks: 'spruce_planks' }), 1);
        const plan = build.planBuild(bp.cells(turned), { x: 100, y: 64, z: 100 });
        assert.strictEqual(plan.count, house.blocks.length);
        assert.ok(plan.regions.length >= 1);
        assert.deepStrictEqual(plan.unsupported, []);
    });
    console.log('ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });

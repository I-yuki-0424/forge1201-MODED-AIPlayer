'use strict';
// Block reads by state id (src/build/fastblock.js, TASK-20261125-081 pauses / SPEED-v1 section 7): the same name, properties, collision boxes and dig time as mineflayer's
// blockAt, for every state of a column of real 1.21.1 chunk data; null where no chunk is loaded. Negative control: a wrong state id gives another answer.
const assert = require('assert');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const FB = require('../src/build/fastblock');
const { seen } = require('../src/build/world');
const P = require('../src/build/place');

const world = new World(null).sync;
const chunk = new Chunk({ minY: -64, worldHeight: 384 });
const names = ['stone', 'hopper', 'smooth_stone_slab', 'oak_stairs', 'redstone_wire', 'water', 'glass', 'white_bed', 'air', 'spruce_trapdoor', 'comparator', 'sticky_piston'];
let i = 0;
for (const n of names) { const b = registry.blocksByName[n]; for (let s = b.minStateId; s <= Math.min(b.maxStateId, b.minStateId + 40); s += 7) { chunk.setBlockStateId(new Vec3(i % 16, 64 + Math.floor(i / 256), Math.floor(i / 16) % 16), s); i++; } }
world.setColumn(0, 0, chunk);
const bot = { registry, world, blockAt: (p) => world.getBlock(p) };

let n = 0;
for (let k = 0; k < i; k++) {
    const x = k % 16, y = 64 + Math.floor(k / 256), z = Math.floor(k / 16) % 16;
    const a = world.getBlock(new Vec3(x, y, z)), b = FB.blockAt(bot, x, y, z);
    assert.strictEqual(b.name, a.name); assert.deepStrictEqual(b.getProperties(), a.getProperties()); assert.strictEqual(b.boundingBox, a.boundingBox); assert.deepStrictEqual(b.shapes, a.shapes);
    assert.strictEqual(b.digTime(null, false, false, false, [], {}), a.digTime(null, false, false, false, [], {}));
    const sOld = { name: a.name, props: Object.fromEntries(Object.entries(a.getProperties()).map(([kk, v]) => [kk, String(v)])), shape: a.boundingBox };
    assert.deepStrictEqual({ ...seen(bot, { x, y, z }), props: { ...seen(bot, { x, y, z }).props } }, sOld);
    const pb = P.botWorld(bot).block(x, y, z);
    if (a.name === 'air') assert.strictEqual(pb.name, 'air'); else assert.deepStrictEqual({ ...pb, props: { ...pb.props } }, { name: a.name, props: sOld.props, shapes: a.shapes || [] });
    n++;
}
assert.strictEqual(FB.blockAt(bot, 40, 64, 40), null, 'no chunk: null like blockAt');
assert.strictEqual(seen(bot, { x: 40, y: 64, z: 40 }), null);
// negative control: the next state id is another block state
const st = registry.blocksByName.hopper.minStateId;
assert.notDeepStrictEqual(FB.entry(bot, st).block.getProperties(), FB.entry(bot, st + 1).block.getProperties());
assert.strictEqual(Block.fromStateId(st, 0).name, 'hopper');
console.log(`  ok ${n} cells read alike (name, properties, boxes, dig time, seen, the click world)`);
console.log('test_build_fastblock_pure: 1 passed');

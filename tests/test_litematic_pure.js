'use strict';
// The .litematic reader (src/work/jobs/litematic.js): bit-packed block states, negative region sizes, material list, placement (origin, rotation, mirror).
const assert = require('assert');
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const nbt = require('prismarine-nbt');
const L = require('../src/work/jobs/litematic'), bp = require('../src/work/jobs/blueprint');

/** A .litematic made here: one region, `cells(x,y,z) -> palette index`, packed the way Litematica does (no padding across longs). */
function make({ pos = [0, 0, 0], size = [2, 2, 2], palette, cells, negative = false }) {
    const [ax, ay, az] = size, vol = ax * ay * az, bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const longs = new BigUint64Array(Math.ceil(vol * bits / 64) || 1);
    for (let y = 0, i = 0; y < ay; y++) for (let z = 0; z < az; z++) for (let x = 0; x < ax; x++, i++) {
        const v = BigInt(cells(x, y, z)), bit = i * bits, w = Math.floor(bit / 64), off = BigInt(bit % 64);
        longs[w] |= (v << off) & 0xffffffffffffffffn;
        if (off + BigInt(bits) > 64n) longs[w + 1] |= v >> (64n - off);
    }
    const arr = [...longs].map((v) => [Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v & 0xffffffffn))]);
    const sz = negative ? size.map((v) => -v) : size;
    const root = nbt.comp({
        Version: nbt.int(7), MinecraftDataVersion: nbt.int(5023),
        Metadata: nbt.comp({ Name: nbt.string('t'), Author: nbt.string('a'), TotalBlocks: nbt.int(0), TotalVolume: nbt.int(vol), EnclosingSize: nbt.comp({ x: nbt.int(ax), y: nbt.int(ay), z: nbt.int(az) }) }),
        Regions: nbt.comp({ r: nbt.comp({
            Position: nbt.comp({ x: nbt.int(pos[0]), y: nbt.int(pos[1]), z: nbt.int(pos[2]) }), Size: nbt.comp({ x: nbt.int(sz[0]), y: nbt.int(sz[1]), z: nbt.int(sz[2]) }),
            BlockStatePalette: nbt.list(nbt.comp(palette.map((p) => { const o = { Name: nbt.string(p.name) }; if (p.props) o.Properties = nbt.comp(Object.fromEntries(Object.entries(p.props).map(([k, v]) => [k, nbt.string(v)]))); return o; }))),
            BlockStates: { type: 'longArray', value: arr }, TileEntities: nbt.list(nbt.comp([])), Entities: nbt.list(nbt.comp([])),
        }) }),
    });
    return zlib.gzipSync(nbt.writeUncompressed(root, 'big'));
}
const P = (name, props) => ({ name: `minecraft:${name}`, props });

{   // bit packing across long boundaries: 5 bits per entry (17..32 palette entries), 4x4x4 cells, every cell its own pattern
    const palette = Array.from({ length: 20 }, (_, i) => P(i === 0 ? 'air' : `block_${i}`));
    const f = (x, y, z) => (x * 7 + y * 3 + z * 5 + 1) % 20;
    const parsed = L.parse(make({ size: [4, 4, 4], palette, cells: f }));
    const r = parsed.regions[0];
    for (let y = 0, i = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++, i++) assert.strictEqual(r.idx[i], f(x, y, z), `cell ${x},${y},${z}`);
    const b = L.toBlueprint(parsed);
    assert.strictEqual(b.blocks.length, 64 - [...r.idx].filter((v) => v === 0).length, 'air cells dropped, the rest kept');
    const at = (x, y, z) => { const q = b.blocks.find((c) => c.x === x && c.y === y && c.z === z); return q ? b.palette[q.s].name : 'minecraft:air'; };
    for (const [x, y, z] of [[0, 0, 0], [3, 3, 3], [2, 1, 3], [1, 2, 0]]) assert.strictEqual(at(x, y, z), f(x, y, z) === 0 ? 'minecraft:air' : `minecraft:block_${f(x, y, z)}`);
}
{   // a corrupt file is refused with a reason, never a crash
    const good = make({ size: [2, 2, 2], palette: [P('air'), P('stone')], cells: () => 1 });
    assert.throws(() => L.parse(Buffer.from('not a litematic at all, just some text of enough length')), /not an NBT|not a litematic/);
    assert.throws(() => L.parse(good.subarray(0, 20)), /./);
    const bad = make({ size: [4, 4, 4], palette: [P('air'), P('stone')], cells: () => 1 });
    const parsed = L.parse(bad); assert.strictEqual(parsed.regions[0].idx.length, 64);
}
{   // negative region size: the region extends towards smaller coordinates from its Position
    const parsed = L.parse(make({ pos: [10, 5, 20], size: [3, 2, 4], negative: true, palette: [P('air'), P('stone')], cells: () => 1 }));
    assert.deepStrictEqual(parsed.regions[0].min, { x: 8, y: 4, z: 17 });
    assert.deepStrictEqual(L.toBlueprint(parsed).offset, { x: 8, y: 4, z: 17 });
}
{   // the real iron farm (the owner's easy-ironfarm-fixd.litematic): size, block count, material list
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures/easy-ironfarm-fixd.litematic'));
    assert.ok(L.isLitematic(buf)); assert.ok(!L.isLitematic(bp.write(bp.empty(1, 1, 1))));
    const parsed = L.parse(buf);
    assert.strictEqual(parsed.meta.totalBlocks, 1514); assert.deepStrictEqual(parsed.meta.enclosing, { x: 45, y: 23, z: 46 });
    const b = L.toBlueprint(parsed);
    assert.deepStrictEqual(b.size, [45, 23, 46]); assert.strictEqual(b.blocks.length, 1514, 'the file says 1514 non-air blocks');
    const mat = Object.fromEntries(L.materials(b).map((m) => [m.item, m.n]));
    assert.strictEqual(mat.stone_bricks, 364); assert.strictEqual(mat.stone_brick_wall, 348); assert.strictEqual(mat.glass, 222); assert.strictEqual(mat.birch_trapdoor, 48);
    assert.strictEqual(mat.white_bed, 12, 'a bed is one item for its two cells'); assert.strictEqual(mat.redstone, 8);
    assert.ok(!('water' in mat) && !('lava' in mat) && !('piston_head' in mat));
    const k = L.toBlueprint(parsed, { keepAir: true }); assert.ok(k.blocks.length > 20000, 'with keepAir the box is complete');
}
{   // placement: origin, mirror (first), rotation, with a blockstate that must turn
    const parsed = L.parse(make({ pos: [0, 0, 0], size: [3, 1, 2], palette: [P('air'), P('stone'), P('oak_stairs', { facing: 'north', half: 'bottom' })], cells: (x, y, z) => (x === 0 && z === 0 ? 2 : x === 2 && z === 1 ? 1 : 0) }));
    const at = (r, x, y, z) => { const q = r.bp.blocks.find((c) => c.x === x && c.y === y && c.z === z); return q ? r.bp.palette[q.s] : null; };
    const w = (r, x, y, z) => at(r, x - r.origin.x, y - r.origin.y, z - r.origin.z);
    let r = L.place(parsed, { pos: { x: 100, y: 64, z: 200 } });
    assert.deepStrictEqual(r.origin, { x: 100, y: 64, z: 200 }); assert.strictEqual(w(r, 100, 64, 200).name, 'minecraft:oak_stairs'); assert.strictEqual(w(r, 102, 64, 201).name, 'minecraft:stone');
    r = L.place(parsed, { pos: { x: 100, y: 64, z: 200 }, rotation: 'CLOCKWISE_90' });       // (x, z) -> (-z, x): the stairs at (0,0) stay, the stone at (2,1) goes to (-1, 2)
    assert.strictEqual(w(r, 100, 64, 200).props.facing, 'east'); assert.strictEqual(w(r, 99, 64, 202).name, 'minecraft:stone');
    r = L.place(parsed, { pos: { x: 100, y: 64, z: 200 }, mirror: 'LEFT_RIGHT' });             // z -> -z
    assert.strictEqual(w(r, 100, 64, 200).props.facing, 'south'); assert.strictEqual(w(r, 102, 64, 199).name, 'minecraft:stone');
    r = L.place(parsed, { pos: { x: 100, y: 64, z: 200 }, mirror: 'FRONT_BACK', rotation: 'CLOCKWISE_180' });   // x -> -x, then (x, z) -> (-x, -z): net z -> -z for x, and the stairs...
    assert.strictEqual(w(r, 100, 64, 200).name, 'minecraft:oak_stairs'); assert.strictEqual(w(r, 102, 64, 199).name, 'minecraft:stone');
    r = L.place(parsed, { pos: { x: 100, y: 64, z: 200 }, rotation: 'COUNTERCLOCKWISE_90' });  // (x, z) -> (z, -x): stone (2,1) -> (1, -2)
    assert.strictEqual(w(r, 101, 64, 198).name, 'minecraft:stone'); assert.strictEqual(w(r, 100, 64, 200).props.facing, 'west');
}
console.log('litematic: ok');

// A job keeps an immutable copy of its blueprint (service/jobs.js _buildFrom: bp.write) and reads it again at every restart: a blueprint made of a litematic with block entities (chests,
// signs, hoppers ...) must survive the round trip (live 2026-11-21: the tile entities were bare maps, bp.read refused the file, the running job was lost at the first restart).
(async () => {
    const fs = require('fs'), path = require('path'), bp = require('../src/work/jobs/blueprint');
    for (const f of ['iron-farm-34.litematic', 'easy-ironfarm-fixd.litematic']) {
        const file = fs.readFileSync(path.join(__dirname, 'fixtures', f)), p = L.place(L.parse(file), { pos: { x: 0, y: 0, z: 0 }, rotation: 'NONE', mirror: 'NONE', subRegions: [] }, { keepAir: false });
        const tiles = p.bp.blocks.filter((b) => b.nbt).length;
        const back = await bp.read(bp.write(p.bp));
        assert.deepStrictEqual(back.size, p.bp.size, f); assert.strictEqual(back.blocks.length, p.bp.blocks.length, f); assert.strictEqual(back.blocks.filter((b) => b.nbt).length, tiles, `${f}: block entities kept (${tiles})`);
        assert.deepStrictEqual(back.blocks.map((b) => [b.x, b.y, b.z, back.palette[b.s].name]).sort().slice(0, 200), p.bp.blocks.map((b) => [b.x, b.y, b.z, p.bp.palette[b.s].name]).sort().slice(0, 200), f);
    }
    console.log('litematic round trip through the job file: ok');
})().catch((e) => { console.error(e); process.exit(1); });

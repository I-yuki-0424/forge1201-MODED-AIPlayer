'use strict';
// Writes tests/fixtures/sorter-cell.litematic (TASK-20261125-076, owner Large 3.4): the smallest blueprint with container contents that matter.
//   - a sorter's filter part: hopper (locked by a redstone block beside it, as a sorter's filter hopper is locked until its signal rises) over the item
//     chest; the hopper holds the filter stacks (18 cobblestone + 1 stick in each of the other four slots); a comparator reads it (strength 1) into a wire;
//   - a barrel a comparator reads at a set strength: 247 cobblestone in 27 slots = strength 3, into a wire.
// Litematica's format (version 6, data version of 1.21.1), one region, block entities with `Items` (1.20.5+ layout: count as int).
//   docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node scripts/native/make_sorter_cell.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nbt = require('prismarine-nbt');

const DATA_VERSION = 3955;                // 1.21.1
const SIZE = { x: 3, y: 2, z: 4 };
const S = (name, props = {}) => ({ name: `minecraft:${name}`, props });
const cells = new Map();
const put = (x, y, z, st) => cells.set(`${x},${y},${z}`, st);
// y = 0: the floor the redstone sits on, the filtered-item chest under the hopper
put(0, 0, 0, S('chest', { facing: 'south', type: 'single', waterlogged: 'false' }));
put(1, 0, 0, S('stone')); put(2, 0, 0, S('stone'));
put(0, 0, 3, S('stone')); put(1, 0, 3, S('stone')); put(2, 0, 3, S('stone'));
put(0, 0, 1, S('stone'));
// y = 1: filter hopper (down into the chest, locked), the redstone block that locks it, comparators facing west (their input is the block to the west), wires
put(0, 1, 0, S('hopper', { facing: 'down', enabled: 'false' }));
put(0, 1, 1, S('redstone_block'));
put(1, 1, 0, S('comparator', { facing: 'west', mode: 'compare', powered: 'true' }));
put(2, 1, 0, S('redstone_wire', { east: 'none', north: 'none', south: 'none', west: 'side', power: '1' }));
put(0, 1, 3, S('barrel', { facing: 'up', open: 'false' }));
put(1, 1, 3, S('comparator', { facing: 'west', mode: 'compare', powered: 'true' }));
put(2, 1, 3, S('redstone_wire', { east: 'none', north: 'none', south: 'none', west: 'side', power: '3' }));

const item = (slot, id, count) => ({ Slot: nbt.byte(slot), id: nbt.string(`minecraft:${id}`), count: nbt.int(count) });
const tiles = [
    { x: 0, y: 0, z: 0, id: 'minecraft:chest', Items: [] },
    { x: 0, y: 1, z: 0, id: 'minecraft:hopper', Items: [item(0, 'cobblestone', 18), ...[1, 2, 3, 4].map((s) => item(s, 'stick', 1))], TransferCooldown: nbt.int(0) },
    { x: 0, y: 1, z: 3, id: 'minecraft:barrel', Items: [item(0, 'cobblestone', 64), item(1, 'cobblestone', 64), item(2, 'cobblestone', 64), item(3, 'cobblestone', 55)] },
    { x: 1, y: 1, z: 0, id: 'minecraft:comparator', OutputSignal: nbt.int(1) },
    { x: 1, y: 1, z: 3, id: 'minecraft:comparator', OutputSignal: nbt.int(3) },
];

// palette (air first, as Litematica writes it) and the packed block states: index = y * sx * sz + z * sx + x, bits = max(2, ceil(log2(n))), no padding
const key = (s) => `${s.name}${JSON.stringify(s.props)}`;
const palette = [S('air')], pidx = new Map([[key(palette[0]), 0]]);
const idx = [];
for (let y = 0; y < SIZE.y; y++) for (let z = 0; z < SIZE.z; z++) for (let x = 0; x < SIZE.x; x++) {
    const st = cells.get(`${x},${y},${z}`) || palette[0], k = key(st);
    if (!pidx.has(k)) { pidx.set(k, palette.length); palette.push(st); }
    idx.push(pidx.get(k));
}
const bits = Math.max(2, Math.ceil(Math.log2(palette.length))), volume = idx.length, longs = new BigUint64Array(Math.ceil((volume * bits) / 64));
idx.forEach((v, i) => {
    const bit = i * bits, w = Math.floor(bit / 64), off = BigInt(bit % 64);
    longs[w] |= (BigInt(v) << off) & 0xFFFFFFFFFFFFFFFFn;
    if (off + BigInt(bits) > 64n) longs[w + 1] |= BigInt(v) >> (64n - off);
});
const longArr = [...longs].map((l) => [Number(BigInt.asIntN(32, l >> 32n)), Number(BigInt.asIntN(32, l & 0xFFFFFFFFn))]);

const vec = (o) => nbt.comp({ x: nbt.int(o.x), y: nbt.int(o.y), z: nbt.int(o.z) });
const now = [0, 0];
const tileTag = (t) => {
    const o = { x: nbt.int(t.x), y: nbt.int(t.y), z: nbt.int(t.z), id: nbt.string(t.id) };
    if (t.Items) o.Items = nbt.list(nbt.comp(t.Items));
    for (const [k, v] of Object.entries(t)) if (!['x', 'y', 'z', 'id', 'Items'].includes(k)) o[k] = v;
    return o;
};
const total = [...cells.values()].length;
const root = nbt.comp({
    Version: nbt.int(6), SubVersion: nbt.int(1), MinecraftDataVersion: nbt.int(DATA_VERSION),
    Metadata: nbt.comp({ Name: nbt.string('sorter-cell'), Author: nbt.string('forgeaip TASK-20261125-076'), Description: nbt.string('filter hopper (18 + 4 x 1) with comparator 1; barrel at comparator 3'),
        EnclosingSize: vec(SIZE), TotalBlocks: nbt.int(total), TotalVolume: nbt.int(volume), RegionCount: nbt.int(1), TimeCreated: nbt.long(now), TimeModified: nbt.long(now) }),
    Regions: nbt.comp({ cell: nbt.comp({
        Position: vec({ x: 0, y: 0, z: 0 }), Size: vec(SIZE),
        BlockStatePalette: nbt.list(nbt.comp(palette.map((p) => (Object.keys(p.props).length ? { Name: nbt.string(p.name), Properties: nbt.comp(Object.fromEntries(Object.entries(p.props).map(([k, v]) => [k, nbt.string(v)]))) } : { Name: nbt.string(p.name) })))),
        BlockStates: { type: 'longArray', value: longArr },
        TileEntities: nbt.list(nbt.comp(tiles.map(tileTag))),
        Entities: nbt.list(nbt.comp([])), PendingBlockTicks: nbt.list(nbt.comp([])), PendingFluidTicks: nbt.list(nbt.comp([])),
    }) }),
});
const file = path.join(__dirname, '../../tests/fixtures/sorter-cell.litematic');
fs.writeFileSync(file, zlib.gzipSync(nbt.writeUncompressed(root, 'big')));
console.log(file, fs.statSync(file).size, 'bytes', palette.length, 'states', total, 'blocks');

'use strict';
// Litematica's `.litematic` file (and what Syncmatica transfers: the same bytes) read into a Blueprint (src/work/jobs/blueprint.js).
// The file is gzip NBT: { Version, MinecraftDataVersion, Metadata { Name, Author, EnclosingSize, TotalBlocks, TotalVolume, RegionCount },
// Regions { <name>: { Position, Size, BlockStatePalette, BlockStates (packed long array), TileEntities, Entities } } }.
// Block indexes are packed WITHOUT padding across longs (a value may straddle two longs), `bits = max(2, ceil(log2(palette size)))`,
// index = y * |sx| * |sz| + z * |sx| + x. A region's Size may be negative on an axis: the region then extends
// from Position towards smaller coordinates, its minimum corner is Position + size + 1.
// Everything is validated (sizes, palette indexes, long-array length): the file may come from any player of a server.
const zlib = require('zlib');
const nbt = require('prismarine-nbt');
const blueprint = require('./blueprint');

const MAX_VOLUME = 64 * 1024 * 1024;        // cells of one region (a 512 x 512 x 256 box)
const AIR = /^(minecraft:)?(air|cave_air|void_air)$/;

const intOf = (c, k) => Number(c.value[k].value);
const vec = (c) => ({ x: intOf(c, 'x'), y: intOf(c, 'y'), z: intOf(c, 'z') });

/** Long array of prismarine-nbt ([hi, lo] int pairs) -> BigUint64Array. */
function longs(arr) {
    const out = new BigUint64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = (BigInt(arr[i][0] >>> 0) << 32n) | BigInt(arr[i][1] >>> 0);
    return out;
}

/** The palette index of every cell of a region (x fastest, then z, then y), as a Uint32Array. */
function unpack(states, paletteLen, volume) {
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(paletteLen, 1))));
    const need = Math.ceil((volume * bits) / 64);
    if (states.length < need) throw new Error(`block state array too short (${states.length} longs for ${volume} cells of ${bits} bits)`);
    const mask = (1n << BigInt(bits)) - 1n, out = new Uint32Array(volume);
    for (let i = 0; i < volume; i++) {
        const bit = i * bits, w = Math.floor(bit / 64), off = BigInt(bit % 64);
        let v = states[w] >> off;
        if (off + BigInt(bits) > 64n) v |= states[w + 1] << (64n - off);
        const s = Number(v & mask);
        if (s >= paletteLen) throw new Error(`block state index ${s} outside the palette of ${paletteLen}`);
        out[i] = s;
    }
    return out;
}

/** Parse the bytes of a `.litematic` into { meta, regions: [{name, pos, size, ...}] } without merging (placements need regions). */
function parse(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 32 || buf.length > 64 * 1024 * 1024) throw new Error('not a litematic file (size)');
    let root;
    try {
        const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf, { maxOutputLength: 512 * 1024 * 1024 }) : buf;
        root = nbt.parseUncompressed(raw, 'big').value;
    } catch (e) { throw new Error(`not an NBT file: ${String(e.message).slice(0, 120)}`); }
    if (!root.Regions || !root.Metadata || !root.Version) throw new Error('not a litematic file (Regions/Metadata/Version missing)');
    const version = Number(root.Version.value);
    if (version < 4 || version > 7) throw new Error(`litematic version ${version} is not supported (4..7)`);
    const md = root.Metadata.value;
    const meta = {
        name: md.Name ? String(md.Name.value) : '', author: md.Author ? String(md.Author.value) : '', version,
        dataVersion: root.MinecraftDataVersion ? Number(root.MinecraftDataVersion.value) : null,
        totalBlocks: md.TotalBlocks ? Number(md.TotalBlocks.value) : null, totalVolume: md.TotalVolume ? Number(md.TotalVolume.value) : null,
        enclosing: md.EnclosingSize ? vec(md.EnclosingSize) : null,
    };
    const regions = [];
    for (const [name, r] of Object.entries(root.Regions.value)) {
        const v = r.value, pos = vec(v.Position), size = vec(v.Size);
        const ax = Math.abs(size.x), ay = Math.abs(size.y), az = Math.abs(size.z), volume = ax * ay * az;
        if (!ax || !ay || !az || volume > MAX_VOLUME || Math.max(ax, ay, az) > blueprint.MAX_SIDE) throw new Error(`region ${JSON.stringify(name)}: bad size ${size.x}x${size.y}x${size.z}`);
        const palette = v.BlockStatePalette.value.value.map((p) => {
            const props = {};
            if (p.Properties) for (const [k, pv] of Object.entries(p.Properties.value)) props[k] = String(pv.value);
            return { name: String(p.Name.value), props };
        });
        if (!palette.length) throw new Error(`region ${JSON.stringify(name)}: empty palette`);
        const idx = unpack(longs(v.BlockStates.value), palette.length, volume);
        const tiles = new Map();
        for (const t of (v.TileEntities ? v.TileEntities.value.value : [])) {
            const x = intOf({ value: t }, 'x'), y = intOf({ value: t }, 'y'), z = intOf({ value: t }, 'z');
            tiles.set(`${x},${y},${z}`, { type: 'compound', value: t });          // a tagged compound, as a structure file's block `nbt` is read (a bare map made bp.write produce a file bp.read refused: a job of a litematic was lost at the first restart)
        }
        regions.push({
            name, pos, size: { x: ax, y: ay, z: az },
            min: { x: pos.x + (size.x < 0 ? size.x + 1 : 0), y: pos.y + (size.y < 0 ? size.y + 1 : 0), z: pos.z + (size.z < 0 ? size.z + 1 : 0) },
            palette, idx, tiles, entities: v.Entities ? v.Entities.value.value.length : 0,
        });
    }
    if (!regions.length) throw new Error('litematic without regions');
    return { meta, regions };
}

/**
 * A Blueprint of the whole file: every region at its offset from the common minimum corner (so the blueprint's 0,0,0 is the corner
 * of the enclosing box), air blocks INCLUDED (`keepAir`) when the exact box content matters (the completion check), otherwise skipped.
 * Later regions overwrite earlier ones except where they hold air (Litematica's own order).
 */
function toBlueprint(parsed, { keepAir = false } = {}) {
    const { regions } = parsed;
    const o = { x: Math.min(...regions.map((r) => r.min.x)), y: Math.min(...regions.map((r) => r.min.y)), z: Math.min(...regions.map((r) => r.min.z)) };
    const hi = { x: Math.max(...regions.map((r) => r.min.x + r.size.x)), y: Math.max(...regions.map((r) => r.min.y + r.size.y)), z: Math.max(...regions.map((r) => r.min.z + r.size.z)) };
    const size = [hi.x - o.x, hi.y - o.y, hi.z - o.z];
    if (size.some((s) => s > blueprint.MAX_SIDE)) throw new Error(`the enclosing box ${size.join('x')} is larger than ${blueprint.MAX_SIDE}`);
    const palette = [], pidx = new Map(), cells = new Map();
    for (const r of regions) {
        const map = r.palette.map((p) => {
            const k = blueprint.keyOf(p.name, p.props);
            if (!pidx.has(k)) { pidx.set(k, palette.length); palette.push({ name: p.name, props: { ...p.props } }); }
            return pidx.get(k);
        });
        const air = r.palette.map((p) => AIR.test(p.name));
        for (let y = 0, i = 0; y < r.size.y; y++) for (let z = 0; z < r.size.z; z++) for (let x = 0; x < r.size.x; x++, i++) {
            const s = r.idx[i];
            if (air[s] && (!keepAir || cells.has(`${x + r.min.x - o.x},${y + r.min.y - o.y},${z + r.min.z - o.z}`))) continue;
            const cx = x + r.min.x - o.x, cy = y + r.min.y - o.y, cz = z + r.min.z - o.z;
            const t = r.tiles.get(`${x},${y},${z}`);
            cells.set(`${cx},${cy},${cz}`, t ? { x: cx, y: cy, z: cz, s: map[s], nbt: t } : { x: cx, y: cy, z: cz, s: map[s] });
        }
    }
    // `offset`: where the blueprint's 0,0,0 lies relative to the placement origin (Litematica's regions hang off the origin, often with negative offsets)
    return blueprint.compact({ size, palette, blocks: [...cells.values()], entities: [], dataVersion: parsed.meta.dataVersion || 0, offset: o });
}

/**
 * A placement of the file as Syncmatica shares it: { pos (the origin block), rotation, mirror }. Litematica mirrors first and then rotates, both about
 * the origin. Returns { bp, origin } where `origin` is the WORLD cell of the blueprint's 0,0,0 (its minimum corner), so planBuild(cells, origin) builds it
 * where Litematica shows it. Sub-region changes are not applied (`subRegions` of the placement are reported back in `ignored`).
 */
function place(parsed, placement, opts) {
    const rot = { NONE: 0, CLOCKWISE_90: 1, CLOCKWISE_180: 2, COUNTERCLOCKWISE_90: 3 }[placement.rotation || 'NONE'];
    if (rot === undefined) throw new Error(`unknown rotation ${placement.rotation}`);
    if (!['NONE', 'LEFT_RIGHT', 'FRONT_BACK'].includes(placement.mirror || 'NONE')) throw new Error(`unknown mirror ${placement.mirror}`);
    let bp = toBlueprint(parsed, opts), off = { ...bp.offset };
    if (placement.mirror === 'LEFT_RIGHT') { bp = blueprint.mirror(bp, 'z'); off.z = -(off.z + bp.size[2] - 1); }           // z -> -z
    else if (placement.mirror === 'FRONT_BACK') { bp = blueprint.mirror(bp, 'x'); off.x = -(off.x + bp.size[0] - 1); }       // x -> -x
    for (let q = 0; q < rot; q++) {                                                                                         // clockwise quarter turn: (x, z) -> (-z, x)
        const [sx, , sz] = bp.size;
        off = { x: -(off.z + sz - 1), y: off.y, z: off.x };
        bp = blueprint.rotate(bp, 1);
    }
    const pos = placement.pos;
    return { bp, origin: { x: pos.x + off.x, y: pos.y + off.y, z: pos.z + off.z }, ignored: (placement.subRegions || []).length };
}

/** Read a `.litematic` straight into a Blueprint (async like blueprint.read, so callers treat both formats alike). */
async function read(buf, opts) { return toBlueprint(parse(buf), opts); }

/** True for the bytes of a litematic (gzip NBT with Regions) as against a structure `.nbt` (size/palette/blocks). */
function isLitematic(buf) {
    try {
        const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf.subarray(0, Math.min(buf.length, 1 << 20)), { finishFlush: zlib.constants.Z_SYNC_FLUSH }) : buf;
        return raw.includes(Buffer.from('Regions')) && raw.includes(Buffer.from('MinecraftDataVersion'));
    } catch (_) { return false; }
}

/**
 * The material list: { name, n } per block name (all states of one block summed), plus per item the number of items a bot must hold.
 * Litematica's own list counts blocks by their item: a slab the double-slab state counts twice, a bed or a door once (one item
 * per two cells), a waterlogged block no water. `itemCount` follows that.
 */
function materials(bp) {
    const per = new Map();
    for (const b of bp.blocks) {
        const p = bp.palette[b.s];
        if (AIR.test(p.name)) continue;
        const { item, n } = itemCount(p.name, p.props);
        if (!item) continue;
        per.set(item, (per.get(item) || 0) + n);
    }
    return [...per.entries()].map(([item, n]) => ({ item, n })).sort((a, b) => b.n - a.n || (a.item < b.item ? -1 : 1));
}

const NO_ITEM = /^(minecraft:)?(water|lava|bubble_column|fire|soul_fire|piston_head|moving_piston|nether_portal|end_portal|end_gateway|frosted_ice|kelp_plant|tall_seagrass|cave_vines_plant|weeping_vines_plant|twisting_vines_plant)$/;
const ITEM_RENAME = { redstone_wire: 'redstone', wall_torch: 'torch', redstone_wall_torch: 'redstone_torch', soul_wall_torch: 'soul_torch', tripwire: 'string', bamboo_sapling: 'bamboo' };
function itemCount(name, props) {
    const nm = name.replace(/^minecraft:/, '');
    if (NO_ITEM.test(name)) return { item: null, n: 0 };
    if (/_bed$/.test(nm) || /_door$/.test(nm) || /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|tall_seagrass)$/.test(nm)) {
        const second = props.part === 'head' || props.half === 'upper';
        return second ? { item: null, n: 0 } : { item: itemName(name, nm), n: 1 };
    }
    if (/_slab$/.test(nm)) return { item: itemName(name, nm), n: props.type === 'double' ? 2 : 1 };
    if (nm === 'sea_pickle') return { item: itemName(name, nm), n: Number(props.pickles || 1) };
    if (nm === 'snow') return { item: itemName(name, nm), n: Number(props.layers || 1) };
    if (/^(candle|.*_candle)$/.test(nm)) return { item: itemName(name, nm), n: Number(props.candles || 1) };
    return { item: itemName(name, nm), n: 1 };
}
function itemName(name, nm) {
    const ns = name.includes(':') ? name.split(':')[0] : 'minecraft';
    const base = ITEM_RENAME[nm] || nm.replace(/^(.*)_wall_(sign|banner|head|hanging_sign)$/, '$1_$2');
    return ns === 'minecraft' ? base : `${ns}:${base}`;
}

module.exports = { parse, toBlueprint, place, read, isLitematic, materials, unpack, itemCount };

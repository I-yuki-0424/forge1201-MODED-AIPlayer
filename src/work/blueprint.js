'use strict';
// Structure files as data you can edit: the game's own `.nbt` (structure block; Create schematics are the same format) is read
// into a Blueprint, changed by pure operations (rotate, mirror, replace, remove, crop, merge, shift) and written back as a valid
// structure file, so "structural parts" (a wall, a floor, a tower) can be kept, combined into new structures and built by the
// crew (build.js). Nothing here touches a server. Block states (stairs facing, log axis, door hinge...) and block-entity NBT
// survive every operation; block-entity NBT that names world positions (Create kinetic sources, linked controllers) is passed
// through UNCHANGED, so rotating or moving a contraption that stores positions needs a check in the game.
//
// Blueprint = { size: [x, y, z], palette: [{ name, props }], blocks: [{ x, y, z, s, nbt? }], entities: [raw], dataVersion }
// `s` indexes the palette; `nbt` is the raw typed tag of the block entity (prismarine-nbt form), kept as is.
const zlib = require('zlib');
const nbt = require('prismarine-nbt');

const MAX_BLOCKS = 2_000_000;
const MAX_SIDE = 512;
const DATA_VERSION = 3465;          // Minecraft 1.20.1
const AIR = /^(minecraft:)?(air|cave_air|void_air)$/;
const NAME_OK = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const PROP_OK = /^[a-z0-9_]{1,32}$/;
const VAL_OK = /^[a-zA-Z0-9_.-]{1,32}$/;

const ns = (n) => (String(n).includes(':') ? String(n) : `minecraft:${n}`);
const bare = (n) => String(n).replace(/^minecraft:/, '');
const keyOf = (name, props) => name + (props && Object.keys(props).length ? '[' + Object.keys(props).sort().map((k) => `${k}=${props[k]}`).join(',') + ']' : '');

/** "minecraft:oak_stairs[facing=north,half=bottom]" or "oak_planks" -> { name, props }. Throws on anything else. */
function parseState(text) {
    const m = /^([a-z0-9_.:/-]+?)(?:\[([^\]]*)\])?$/.exec(String(text).trim());
    if (!m) throw new Error(`bad block state ${JSON.stringify(String(text).slice(0, 80))}`);
    const name = ns(m[1]);
    if (!NAME_OK.test(name)) throw new Error(`bad block name ${JSON.stringify(name.slice(0, 80))}`);
    const props = {};
    if (m[2]) for (const kv of m[2].split(',')) {
        const [k, v, extra] = kv.split('=');
        if (extra !== undefined || !PROP_OK.test(k || '') || !VAL_OK.test(v || '')) throw new Error(`bad property ${JSON.stringify(kv.slice(0, 40))}`);
        props[k] = v;
    }
    return { name, props };
}

// ---------------------------------------------------------------------------------------------------------------- read / write

/** Read a structure file (gzip or plain NBT). Validates sizes, palette indexes and positions; unknown tags are dropped. */
async function read(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length > 64 * 1024 * 1024) throw new Error('not a structure file (size)');
    // Explicit format, not nbt.parse(): the bot transport (forge_bot.applyProtocolBypasses) patches prismarine-nbt's reader to
    // swallow errors, and nbt.parse's format detection relies on those errors (found live: every file read as an empty tag).
    let parsed;
    try {
        const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf, { maxOutputLength: 256 * 1024 * 1024 }) : buf;
        parsed = nbt.parseUncompressed(raw, 'big');
    } catch (e) { throw new Error(`not an NBT file: ${String(e.message).slice(0, 120)}`); }
    const root = parsed.value;
    if (!root.size || !root.palette || !root.blocks) throw new Error('not a structure file (size/palette/blocks missing)');
    const size = root.size.value.value.map(Number);
    if (size.length !== 3 || size.some((v) => !Number.isInteger(v) || v < 1 || v > MAX_SIDE)) throw new Error(`bad size ${size}`);
    const palette = root.palette.value.value.map((p) => {
        const props = {};
        if (p.Properties) for (const [k, v] of Object.entries(p.Properties.value)) props[k] = String(v.value);
        return { name: ns(p.Name.value), props };
    });
    if (root.blocks.value.value.length > MAX_BLOCKS) throw new Error('too many blocks');
    const blocks = root.blocks.value.value.map((b) => {
        const [x, y, z] = b.pos.value.value, s = b.state.value;
        if (!(s >= 0 && s < palette.length)) throw new Error('block state index outside the palette');
        if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) throw new Error(`block at ${x},${y},${z} outside the size`);
        return b.nbt ? { x, y, z, s, nbt: b.nbt } : { x, y, z, s };
    });
    const entities = root.entities ? root.entities.value.value : [];
    return { size, palette, blocks, entities, dataVersion: root.DataVersion ? root.DataVersion.value : DATA_VERSION };
}

/** Write a Blueprint as a gzip structure file the game (and Create) can load. */
function write(bp) {
    const palette = nbt.list(nbt.comp(bp.palette.map((p) => {
        const o = { Name: nbt.string(p.name) };
        if (p.props && Object.keys(p.props).length) o.Properties = nbt.comp(Object.fromEntries(Object.entries(p.props).map(([k, v]) => [k, nbt.string(String(v))])));
        return o;
    })));
    const blocks = nbt.list(nbt.comp(bp.blocks.map((b) => {
        const o = { pos: nbt.list(nbt.int([b.x, b.y, b.z])), state: nbt.int(b.s) };
        if (b.nbt) o.nbt = b.nbt;
        return o;
    })));
    const entities = bp.entities && bp.entities.length ? { type: 'list', value: { type: 'compound', value: bp.entities } } : nbt.list(nbt.comp([]));
    const tree = nbt.comp({ size: nbt.list(nbt.int(bp.size)), palette, blocks, entities, DataVersion: nbt.int(bp.dataVersion || DATA_VERSION) });
    return zlib.gzipSync(nbt.writeUncompressed(tree, 'big'));
}

// ---------------------------------------------------------------------------------------------------------------- states

const DIRS4 = ['north', 'east', 'south', 'west'];
const ROT_TOKEN = { north: 'east', east: 'south', south: 'west', west: 'north' };       // one quarter turn clockwise seen from above
const MIR_X = { east: 'west', west: 'east' }, MIR_Z = { north: 'south', south: 'north' };
const SWAP_LR = { left: 'right', right: 'left', inner_left: 'inner_right', inner_right: 'inner_left', outer_left: 'outer_right', outer_right: 'outer_left' };
const tokens = (v, map) => String(v).split('_').map((t) => map[t] || t).join('_');

// Rail shapes are spelled north_south, east_west, south_east, ...: after the tokens move, put them back in the game's order.
function railShape(v) {
    const t = v.split('_');
    if (t.length !== 2 || !t.every((x) => DIRS4.includes(x))) return v;
    const rank = { north: 0, south: 1, east: 2, west: 3 };
    return t.sort((a, b) => rank[a] - rank[b]).join('_');
}

function rotateProps(name, props, q) {
    let p = { ...props };
    for (let i = 0; i < q; i++) {
        const n = {};
        for (const [k, v] of Object.entries(p)) {
            if (k === 'facing' || k === 'horizontal_facing') n[k] = ROT_TOKEN[v] || v;
            else if (k === 'axis' || k === 'horizontal_axis') n[k] = v === 'x' ? 'z' : v === 'z' ? 'x' : v;
            else if (k === 'rotation') n[k] = String((Number(v) + 4) % 16);
            else if (k === 'shape' && /rail/.test(name)) n[k] = railShape(tokens(v, ROT_TOKEN));
            else if (DIRS4.includes(k) && DIRS4.every((d) => d in p)) n[ROT_TOKEN[k]] = v;       // fence/wall/pane/vine sides move with the turn
            else n[k] = v;
        }
        p = n;
    }
    return p;
}

function mirrorProps(name, props, axis) {
    const M = axis === 'x' ? MIR_X : MIR_Z, p = {};
    for (const [k, v] of Object.entries(props)) {
        if (k === 'facing' || k === 'horizontal_facing') p[k] = M[v] || v;
        else if (k === 'rotation') p[k] = String(axis === 'x' ? (16 - Number(v)) % 16 : (8 - Number(v) + 16) % 16);
        else if (k === 'hinge' || (k === 'type' && /chest/.test(name))) p[k] = SWAP_LR[v] || v;
        else if (k === 'shape' && /stairs/.test(name)) p[k] = SWAP_LR[v] || v;
        else if (k === 'shape' && /rail/.test(name)) p[k] = railShape(tokens(v, M));
        else if (DIRS4.includes(k) && DIRS4.every((d) => d in props)) p[M[k] || k] = v;
        else p[k] = v;
    }
    return p;
}

// ---------------------------------------------------------------------------------------------------------------- operations (pure)

const clone = (bp) => ({ size: [...bp.size], palette: bp.palette.map((p) => ({ name: p.name, props: { ...p.props } })), blocks: bp.blocks.map((b) => ({ ...b })), entities: bp.entities || [], dataVersion: bp.dataVersion });

/** Drop unused palette entries and merge duplicates (same name and props). */
function compact(bp) {
    const index = new Map(), palette = [], map = new Array(bp.palette.length).fill(-1);
    const used = new Set(bp.blocks.map((b) => b.s));
    bp.palette.forEach((p, i) => {
        if (!used.has(i)) return;
        const k = keyOf(p.name, p.props);
        if (!index.has(k)) { index.set(k, palette.length); palette.push({ name: p.name, props: { ...p.props } }); }
        map[i] = index.get(k);
    });
    return { ...bp, palette, blocks: bp.blocks.map((b) => ({ ...b, s: map[b.s] })) };
}

/** Turn the structure `turns` quarter turns clockwise (seen from above); states are turned with it. */
function rotate(bp, turns) {
    const q = ((Math.round(turns) % 4) + 4) % 4;
    if (!q) return clone(bp);
    const [W, H, D] = bp.size, out = clone(bp);
    out.palette = bp.palette.map((p) => ({ name: p.name, props: rotateProps(p.name, p.props, q) }));
    for (const b of out.blocks) {
        let x = b.x, z = b.z, w = W, d = D;
        for (let i = 0; i < q; i++) { [x, z] = [d - 1 - z, x]; [w, d] = [d, w]; }
        b.x = x; b.z = z;
    }
    out.size = q % 2 ? [D, H, W] : [W, H, D];
    return out;
}

/** Flip the structure along an axis: 'x' swaps east and west, 'z' swaps north and south. */
function mirror(bp, axis) {
    if (axis !== 'x' && axis !== 'z') throw new Error("mirror axis must be 'x' or 'z'");
    const out = clone(bp);
    out.palette = bp.palette.map((p) => ({ name: p.name, props: mirrorProps(p.name, p.props, axis) }));
    for (const b of out.blocks) { if (axis === 'x') b.x = bp.size[0] - 1 - b.x; else b.z = bp.size[2] - 1 - b.z; }
    return out;
}

/**
 * Replace blocks. `map`: { "from": "to" } where `from` is a block name (every state of it) or a full state
 * "name[prop=v]"; `to` is a block name (properties that the new block also has are kept) or a full state (properties replaced).
 */
function replace(bp, map) {
    const rules = Object.entries(map).map(([from, to]) => ({ from: parseState(from), to: parseState(to), exact: String(to).includes('[') }));
    if (!rules.length) throw new Error('nothing to replace');
    const out = clone(bp);
    out.palette = out.palette.map((p) => {
        for (const r of rules) {
            if (r.from.name !== p.name) continue;
            if (!Object.entries(r.from.props).every(([k, v]) => p.props[k] === v)) continue;
            return { name: r.to.name, props: r.exact ? { ...r.to.props } : keepShared(p.props, r.to) };
        }
        return p;
    });
    return compact(out);
}
// A rename keeps the properties the old state had; the target's explicit ones win. Unknown properties are not invented.
const keepShared = (old, to) => ({ ...old, ...to.props });

/** Remove every block whose name is in `names` (bare or namespaced). */
function remove(bp, names) {
    const set = new Set(names.map(ns));
    const drop = new Set(bp.palette.map((p, i) => (set.has(p.name) ? i : -1)).filter((i) => i >= 0));
    return compact({ ...bp, blocks: bp.blocks.filter((b) => !drop.has(b.s)).map((b) => ({ ...b })) });
}

/** Keep only the blocks inside the box {x0,y0,z0,x1,y1,z1} (inclusive, structure coordinates); the result starts at 0,0,0. */
function crop(bp, box) {
    const { x0, y0, z0, x1, y1, z1 } = box;
    for (const v of [x0, y0, z0, x1, y1, z1]) if (!Number.isInteger(v)) throw new Error('crop box needs integers');
    if (x1 < x0 || y1 < y0 || z1 < z0) throw new Error('crop box is empty');
    const blocks = bp.blocks.filter((b) => b.x >= x0 && b.x <= x1 && b.y >= y0 && b.y <= y1 && b.z >= z0 && b.z <= z1)
        .map((b) => ({ ...b, x: b.x - x0, y: b.y - y0, z: b.z - z0 }));
    return compact({ ...bp, size: [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1], blocks, entities: [] });
}

/** Fill the whole box with a block (a quick way to make a floor, a wall or a pillar part from nothing). */
function fill(bp, box, state) {
    const st = parseState(state), { x0, y0, z0, x1, y1, z1 } = box;
    for (const v of [x0, y0, z0, x1, y1, z1]) if (!Number.isInteger(v)) throw new Error('fill box needs integers');
    if (x0 < 0 || y0 < 0 || z0 < 0 || x1 >= bp.size[0] || y1 >= bp.size[1] || z1 >= bp.size[2] || x1 < x0 || y1 < y0 || z1 < z0) throw new Error('fill box outside the structure');
    const out = clone(bp), at = new Map(out.blocks.map((b, i) => [`${b.x},${b.y},${b.z}`, i]));
    out.palette.push({ name: st.name, props: st.props });
    const s = out.palette.length - 1;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const i = at.get(`${x},${y},${z}`);
        if (i === undefined) out.blocks.push({ x, y, z, s }); else { out.blocks[i] = { x, y, z, s }; }
    }
    return compact(out);
}

/** An empty structure of the given size (the canvas for fill / merge). */
const empty = (w, h, d) => {
    if (![w, h, d].every((v) => Number.isInteger(v) && v >= 1 && v <= MAX_SIDE)) throw new Error('size must be 1..512 per side');
    return { size: [w, h, d], palette: [], blocks: [], entities: [], dataVersion: DATA_VERSION };
};

/**
 * Combine parts into one structure. `parts`: [{ bp, at: {x,y,z} }] (offsets of each part's minimum corner; negative offsets
 * allowed: the result is shifted so that everything fits). Later parts win where blocks overlap, except that air never
 * overwrites. This is how a library of parts (wall, floor, tower) becomes a building.
 */
function merge(parts) {
    if (!parts.length) throw new Error('nothing to merge');
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const { bp, at } of parts) {
        for (const v of [at.x, at.y, at.z]) if (!Number.isInteger(v)) throw new Error('offsets must be integers');
        minX = Math.min(minX, at.x); minY = Math.min(minY, at.y); minZ = Math.min(minZ, at.z);
        maxX = Math.max(maxX, at.x + bp.size[0] - 1); maxY = Math.max(maxY, at.y + bp.size[1] - 1); maxZ = Math.max(maxZ, at.z + bp.size[2] - 1);
    }
    const size = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
    if (size.some((v) => v > MAX_SIDE)) throw new Error(`the combined structure would be ${size.join('x')} (limit ${MAX_SIDE} per side)`);
    const palette = [], index = new Map(), cells = new Map();
    for (const { bp, at } of parts) {
        for (const b of bp.blocks) {
            const p = bp.palette[b.s];
            if (AIR.test(p.name)) continue;
            const k = keyOf(p.name, p.props);
            if (!index.has(k)) { index.set(k, palette.length); palette.push({ name: p.name, props: { ...p.props } }); }
            const x = b.x + at.x - minX, y = b.y + at.y - minY, z = b.z + at.z - minZ;
            cells.set(`${x},${y},${z}`, b.nbt ? { x, y, z, s: index.get(k), nbt: b.nbt } : { x, y, z, s: index.get(k) });
        }
    }
    if (cells.size > MAX_BLOCKS) throw new Error('too many blocks');
    return { size, palette, blocks: [...cells.values()], entities: [], dataVersion: DATA_VERSION };
}

/** Apply a list of edit steps (the shape the console sends). `lookup(name)` gives another stored blueprint for 'merge'. */
async function applyOps(bp, ops, lookup) {
    if (!Array.isArray(ops) || ops.length > 64) throw new Error('ops must be a list of at most 64 steps');
    let cur = bp;
    for (const o of ops) {
        switch (o && o.op) {
            case 'rotate': cur = rotate(cur, Number(o.turns)); break;
            case 'mirror': cur = mirror(cur, o.axis); break;
            case 'replace': cur = replace(cur, o.map || { [o.from]: o.to }); break;
            case 'remove': cur = remove(cur, [].concat(o.names || o.name || [])); break;
            case 'crop': cur = crop(cur, o.box); break;
            case 'fill': cur = fill(cur, o.box, o.state); break;
            case 'merge': {
                const parts = [{ bp: cur, at: { x: 0, y: 0, z: 0 } }];
                for (const p of o.parts || []) {
                    const other = await lookup(String(p.name));
                    const t = p.rotate ? rotate(other, p.rotate) : other;
                    parts.push({ bp: p.mirror ? mirror(t, p.mirror) : t, at: { x: p.x | 0, y: p.y | 0, z: p.z | 0 } });
                }
                cur = merge(parts); break;
            }
            default: throw new Error(`unknown step ${JSON.stringify(o && o.op)}`);
        }
    }
    return cur;
}

// ---------------------------------------------------------------------------------------------------------------- views

/** Counts per state, size, non-air total, mods, and (given a registry) the blocks a bot cannot place. */
function stats(bp, known = null) {
    const count = new Array(bp.palette.length).fill(0);
    for (const b of bp.blocks) count[b.s]++;
    const byName = {}, mods = new Set(); let total = 0, entities = 0;
    bp.palette.forEach((p, i) => {
        if (AIR.test(p.name)) return;
        byName[p.name] = (byName[p.name] || 0) + count[i]; total += count[i];
        if (!p.name.startsWith('minecraft:')) mods.add(p.name.split(':')[0]);
    });
    for (const b of bp.blocks) if (b.nbt && !AIR.test(bp.palette[b.s].name)) entities++;
    const names = Object.entries(byName).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
    const unknown = known ? names.filter((e) => !known(e.name)).map((e) => e.name) : [];
    return { size: bp.size, blocks: total, names, mods: [...mods].sort(), blockEntities: entities, unknown };
}

/** One horizontal layer for the preview: a w x d grid of palette indexes (-1 = empty), plus the palette names. */
function layer(bp, y) {
    if (!Number.isInteger(y) || y < 0 || y >= bp.size[1]) throw new Error('layer outside the structure');
    const grid = new Array(bp.size[0] * bp.size[2]).fill(-1);
    for (const b of bp.blocks) if (b.y === y && !AIR.test(bp.palette[b.s].name)) grid[b.z * bp.size[0] + b.x] = b.s;
    return { w: bp.size[0], d: bp.size[2], grid, palette: bp.palette.map((p) => keyOf(p.name, p.props)) };
}

/** The cells the build job needs: { x, y, z, block, props } (air skipped). Block names keep their namespace except minecraft:. */
function cells(bp) {
    const out = [];
    for (const b of bp.blocks) {
        const p = bp.palette[b.s];
        if (!AIR.test(p.name)) out.push({ x: b.x, y: b.y, z: b.z, block: bare(p.name), props: p.props });
    }
    return out;
}

/** The inverse of `cells` for the generators (house): { x, y, z, block } -> Blueprint. */
function fromCells(list) {
    if (!list.length) throw new Error('no cells');
    const palette = [], index = new Map();
    const blocks = list.map((c) => {
        const st = c.block.includes('[') ? parseState(c.block) : { name: ns(c.block), props: c.props || {} }, k = keyOf(st.name, st.props);
        if (!index.has(k)) { index.set(k, palette.length); palette.push(st); }
        return { x: c.x, y: c.y, z: c.z, s: index.get(k) };
    });
    const size = [Math.max(...blocks.map((b) => b.x)) + 1, Math.max(...blocks.map((b) => b.y)) + 1, Math.max(...blocks.map((b) => b.z)) + 1];
    return { size, palette, blocks, entities: [], dataVersion: DATA_VERSION };
}

module.exports = { read, write, parseState, keyOf, rotate, mirror, replace, remove, crop, fill, empty, merge, applyOps, compact, stats, layer, cells, fromCells, rotateProps, mirrorProps, MAX_SIDE, MAX_BLOCKS };

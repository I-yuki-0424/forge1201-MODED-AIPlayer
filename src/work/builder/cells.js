'use strict';
// What a blueprint cell IS for the builder (rewrite 2026-11-18, TASK-20261117-070): its item, its kind (block / attached / fluid / flow / derived), what it hangs on, the material list, and
// whether a world block matches it. Pure; no bot, no server. The order, the units and the walking are in order.js, stations.js, run.js.
const O = require('../jobs/orient');
const D = O.DIR;

const SKIP = /^(air|cave_air|void_air|structure_void|jigsaw|structure_block|barrier)$/;
const NEEDS_SUPPORT = /(torch|ladder|button|lever|sign|pressure_plate|carpet|banner|rail|lantern|vine|redstone_wire|repeater|comparator|(^|_)door)$/;       // fall off when their support goes
const ITEM_OF = { wall_torch: 'torch', redstone_wall_torch: 'redstone_torch', soul_wall_torch: 'soul_torch', wall_sign: 'oak_sign', water: 'water_bucket', lava: 'lava_bucket', redstone_wire: 'redstone', nether_portal: 'flint_and_steel', soul_fire: 'flint_and_steel' };
const IGNITE = /^(nether_portal|soul_fire)$/;                                                       // made by a click of flint and steel on the top face of the block under the cell (owner 2026-11-21: iron-farm-34 has 36 portals)
const FLUID = /^(water|lava)$/;
const REPLACEABLE = /^(air|cave_air|void_air|grass|tall_grass|short_grass|fern|snow|dead_bush)$/;
const bare = (n) => String(n).replace(/^minecraft:/, '');
const ckey = (c) => `${c.x},${c.y},${c.z}`;

/** The item that places `block` (null when none: fluids are poured). Mod blocks keep their namespace (`create:cogwheel`). */
function itemFor(block) {
    const n = bare(block);
    if (n.includes(':')) return n;
    if (n in ITEM_OF) return ITEM_OF[n];
    return n.replace(/^(.*)_wall_(sign|banner|head)$/, '$1_$2');
}

/** What the planner does with a cell: 'block' | 'attached' (needs a support) | 'fluid' (a source: bucket) | 'flow' (made by the game) | 'derived' (the other half of a bed or door, a piston arm) | 'ignite' (a portal or soul fire: flint and steel). */
function kindOf(c) {
    const n = bare(c.block), p = c.props || {};
    if (c.ignite) return 'ignite';
    if (FLUID.test(n)) return p.level && p.level !== '0' ? 'flow' : 'fluid';
    if (O.derivedCell(n, p)) return 'derived';
    return NEEDS_SUPPORT.test(n) ? 'attached' : 'block';
}

/** The cell a block needs to stand or hang on (null for a block that needs none): a wall sign / wall torch hangs on the block behind it, a standing torch, sign, wire, repeater on the one below. */
function supportKey(c) {
    const n = bare(c.block), f = (c.props || {}).facing;
    if (/(wall_sign|wall_torch|wall_hanging_sign)$/.test(n) && f && O.OPP[f]) { const d = D[O.OPP[f]]; return `${c.x + d[0]},${c.y + d[1]},${c.z + d[2]}`; }
    if (/(^|_)(sign|torch|redstone_wire|repeater|comparator|pressure_plate|carpet)$/.test(n)) return `${c.x},${c.y - 1},${c.z}`;
    return null;
}

/**
 * Cells that cannot exist in the survival game: a block that needs a support whose support cell is empty in the blueprint or cannot carry it (a torch on wire). A wall sign on a wall sign
 * is fine (a SNEAKED click hangs it, owner 2026-11-18). Returns Map key -> reason.
 */
function unbuildable(abs) {
    const at = new Map(abs.map((c) => [ckey(c), c])), out = new Map();
    const needs = (n) => /(wall_sign|wall_torch|wall_hanging_sign)$/.test(n) ? 'wall' : /(^|_)(sign|torch|redstone_wire|repeater|comparator|pressure_plate|carpet)$/.test(n) ? 'floor' : null;
    const weak = (n) => /(torch|redstone_wire|repeater|comparator|pressure_plate|carpet|button|lever|rail|ladder|banner)$/.test(n);
    for (const c of abs) {
        const n = bare(c.block), kind = needs(n);
        if (!kind) continue;
        const key = supportKey(c), sup = at.get(key);
        if (!sup || SKIP.test(bare(sup.block))) { out.set(ckey(c), `${n}: its support cell is empty in the blueprint`); continue; }
        if (weak(bare(sup.block)) || FLUID.test(bare(sup.block))) out.set(ckey(c), `${n}: its support is ${bare(sup.block)}, which cannot carry it`);
    }
    for (let again = true; again;) { again = false; for (const c of abs) { const kind = needs(bare(c.block)); if (!kind || out.has(ckey(c))) continue; if (out.has(supportKey(c))) { out.set(ckey(c), `${bare(c.block)}: its support is unbuildable`); again = true; } } }
    return out;
}

/** Items a bot must hold for the plan, as Litematica counts them: a bed or door once per pair, a slab twice when double, snow and candles per layer / piece, a bucket per fluid source and waterlogged block. */
function materialsOf(cells) {
    const m = {}, add = (it, n = 1) => { if (it) m[it] = (m[it] || 0) + n; };
    let lights = 0;
    for (const c of cells) {
        const k = kindOf(c), n = bare(c.block), p = c.props || {};
        if (k === 'flow' || k === 'derived') continue;
        if (k === 'ignite') { lights++; continue; }
        if (k === 'fluid') { add(itemFor(n)); continue; }
        add(itemFor(n), /_slab$/.test(n) && p.type === 'double' ? 2 : n === 'snow' ? Number(p.layers || 1) : /candle$/.test(n) ? Number(p.candles || 1) : n === 'sea_pickle' ? Number(p.pickles || 1) : 1);
        if (p.waterlogged === 'true') add('water_bucket');
    }
    if (lights) m.flint_and_steel = Math.ceil(lights / 20) + 1;                              // one use each, 64 uses a piece: a few spare
    return m;
}

/**
 * Portals and soul fire (owner 2026-11-21): a nether_portal cell is not placed, the game fills a frame when fire is lit in it. Every connected body of portal cells becomes ONE cell of the plan
 * (`ignite`): the lowest row's cell nearest the middle of the body, clicked from the top face of the obsidian under it; it waits for every obsidian cell around the body (`frame`). Soul fire is a cell
 * of its own (on soul sand). Returns { cells: the ignite cells, drop: Set of keys of the portal cells that are not placed (the others of each body) }.
 */
function ignitions(abs) {
    const at = new Map(abs.map((c) => [ckey(c), c])), por = abs.filter((c) => bare(c.block) === 'nether_portal'), seen = new Set(), cells = [], drop = new Set();
    for (const c of abs) if (bare(c.block) === 'soul_fire') cells.push({ x: c.x, y: c.y, z: c.z, block: 'soul_fire', props: c.props || {}, ignite: true, frame: [] });
    const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const s of por) {
        if (seen.has(ckey(s))) continue;
        const body = [], st = [s]; seen.add(ckey(s));
        while (st.length) { const a = st.pop(); body.push(a); for (const d of NB) { const q = at.get(`${a.x + d[0]},${a.y + d[1]},${a.z + d[2]}`); if (q && bare(q.block) === 'nether_portal' && !seen.has(ckey(q))) { seen.add(ckey(q)); st.push(q); } } }
        const y0 = Math.min(...body.map((b) => b.y)), low = body.filter((b) => b.y === y0), cx = body.reduce((a, b) => a + b.x, 0) / body.length, cz = body.reduce((a, b) => a + b.z, 0) / body.length;
        low.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
        const pick = low[0], inBody = new Set(body.map(ckey)), axis = (pick.props || {}).axis || 'x', plane = axis === 'x' ? [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] : [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]], frame = new Set();
        for (const b of body) for (const d of plane) { const k = `${b.x + d[0]},${b.y + d[1]},${b.z + d[2]}`; if (!inBody.has(k) && at.has(k) && bare(at.get(k).block) === 'obsidian') frame.add(k); }
        for (const b of body) if (b !== pick) drop.add(ckey(b));
        cells.push({ x: pick.x, y: pick.y, z: pick.z, block: 'nether_portal', props: { axis }, ignite: true, frame: [...frame], body: body.length, bodyCells: body.map((b) => ({ x: b.x, y: b.y, z: b.z })) });
    }
    return { cells, drop };
}

/** A plain house: floor, four walls with a door and windows, flat roof. Cells are relative to the corner. */
function house({ w = 7, d = 7, h = 4, wall = 'oak_planks', floor = 'cobblestone', roof = null, glass = 'glass', door = 'oak_door' } = {}) {
    const cells = [], dx = Math.floor(w / 2);
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x, y: 0, z, block: floor });
    for (let y = 1; y <= h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
        if (x !== 0 && z !== 0 && x !== w - 1 && z !== d - 1) continue;
        if (z === 0 && x === dx && y <= 2) { cells.push({ x, y, z, block: door }); continue; }
        const window = y === 2 && ((z === 0 || z === d - 1) ? x % 3 === 1 && x !== dx : z % 3 === 1);
        cells.push({ x, y, z, block: window ? glass : wall });
    }
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x, y: h + 1, z, block: roof || wall });
    return cells;
}

/** Cells of a vanilla structure `.nbt` (gzip or plain), with block states: { x, y, z, block, props }. */
async function fromStructureNbt(buf) { const bp = require('../jobs/blueprint'); return bp.cells(await bp.read(buf)); }

/** Does the block in the world have the wanted name and the properties placement decides? */
function stateMatches(b, c) {
    if (!b || b.name !== c.block) return false;
    const want = O.staticProps(c.block, c.props), have = b.getProperties ? b.getProperties() : {};
    return Object.entries(want).every(([k, v]) => String(have[k]) === v);
}
/** The first property that right-clicking has to fix (open, delay), or null. */
function useMismatch(b, c) {
    const have = b && b.getProperties ? b.getProperties() : {};
    for (const [k, v] of Object.entries(O.useProps(c.block, c.props))) if (String(have[k]) !== v) return [k, v];
    return null;
}

module.exports = { SKIP, NEEDS_SUPPORT, FLUID, REPLACEABLE, IGNITE, ignitions, bare, ckey, itemFor, kindOf, supportKey, unbuildable, materialsOf, house, fromStructureNbt, stateMatches, useMismatch };

'use strict';
// Structures as a crew job (docs/proposed/WORKERS-v1.md, part 2). A blueprint is a list of cells {x, y, z, block} relative to
// its minimum corner. Sources: the game's own structure format (`.nbt` of the structure block; Create schematics are the same
// file) or a generator (`house`). The job places the cells bottom-up with the existing `place` command, one row per unit.
// A cell that cannot be reached from the ground gets a temporary staircase of cheap blocks (scaffold), removed afterwards.
// Block states ARE reproduced (2026-11-17, litematic builds): facing, half, axis, rotation ... are a function of the clicked face, the click height and the look, so orient.js searches the
// recipe that gives the wanted state and `place {recipe}` clicks it; a state that came out wrong is mined and tried with the next recipe; open / delay are set by right-clicking afterwards.
// Order: bottom-up by layer; inside a layer solid blocks first, then the ones that need a support (torches, signs, redstone, repeaters, doors); FLUIDS LAST (a source placed before its walls
// stand flows out), flows and the second half of a bed or door are not placed (the game makes them). A block that may float (stairs, trapdoors, hoppers, chests ...) with no neighbour yet is
// placed against a temporary block (chain from the nearest solid block) that is taken away at the layer change; blocks that need a support never use one.
// Mod blocks are placed by their namespaced name; whether a bot can place one is the registry's question (the console asks it).
const { Ledger } = require('./crew');
const { SEAL_ITEMS, sealItem } = require('./pit');
const O = require('./orient');

const TILE = 16;
const D = O.DIR, ckey = (c) => `${c.x},${c.y},${c.z}`;
const SKIP = /^(air|cave_air|void_air|structure_void|jigsaw|structure_block|barrier)$/;
const ATTACHED = /(torch|ladder|button|lever|sign|door|trapdoor|pressure_plate|carpet|banner|rail|lantern|vine|redstone_wire|repeater|comparator)$/;   // placed after the solids of their layer
// blocks that fall off when their support goes: never placed against a temporary block
const NEEDS_SUPPORT = /(torch|ladder|button|lever|sign|pressure_plate|carpet|banner|rail|lantern|vine|redstone_wire|repeater|comparator|(^|_)door)$/;
const ITEM_OF = { wall_torch: 'torch', redstone_wall_torch: 'redstone_torch', soul_wall_torch: 'soul_torch', wall_sign: 'oak_sign', water: 'water_bucket', lava: 'lava_bucket', redstone_wire: 'redstone' };
const FLUID = /^(water|lava)$/;

const bare = (n) => String(n).replace(/^minecraft:/, '');
/** The item that places `block`, or null when `place` cannot (fluids). Mod blocks keep their namespace (`create:cogwheel`). */
function itemFor(block) {
    const n = bare(block);
    if (n.includes(':')) return n;
    if (n in ITEM_OF) return ITEM_OF[n];
    return n.replace(/^(.*)_wall_(sign|banner|head)$/, '$1_$2');
}

/** What the planner does with a cell: 'block' | 'attached' (needs a support) | 'fluid' (a source: bucket, last) | 'flow' (made by the game) | 'derived' (the other half of a bed or door, a piston arm). */
function kindOf(c) {
    const n = bare(c.block), p = c.props || {};
    if (FLUID.test(n)) return p.level && p.level !== '0' ? 'flow' : 'fluid';
    if (O.derivedCell(n, p)) return 'derived';
    return NEEDS_SUPPORT.test(n) ? 'attached' : 'block';
}

/**
 * Cells that cannot exist in the survival game: a block that needs a support whose support cell is empty or is itself such a block (a wall sign hung on another wall sign,
 * as in a blueprint that was pasted with commands). A placement is refused by the game and removing a support pops the block, so no order of placements gets there. `props`/`block`
 * of the cells; returns Map key -> reason. Only the clear cases: a missing or attached-kind support (torches on walls and fences are fine).
 */
function unbuildable(abs) {
    const at = new Map(abs.map((c) => [ckey(c), c])), out = new Map();
    const needs = (n) => /(wall_sign|wall_torch|wall_hanging_sign)$/.test(n) ? 'wall' : /(^|_)(sign|torch|redstone_wire|repeater|comparator|pressure_plate|carpet)$/.test(n) ? 'floor' : null;
    const weak = (n) => /(torch|redstone_wire|repeater|comparator|pressure_plate|carpet|button|lever|rail|ladder|banner)$/.test(n);
    for (const c of abs) {
        const n = bare(c.block), kind = needs(n);
        if (!kind) continue;
        const p = kind === 'wall' ? { x: c.x + D[O.OPP[(c.props || {}).facing] || 'north'][0], y: c.y, z: c.z + D[O.OPP[(c.props || {}).facing] || 'north'][2] } : { x: c.x, y: c.y - 1, z: c.z };
        const sup = at.get(ckey(p));
        if (!sup || SKIP.test(bare(sup.block))) { out.set(ckey(c), `${n}: its support cell is empty in the blueprint`); continue; }
        if (weak(bare(sup.block)) || FLUID.test(bare(sup.block))) out.set(ckey(c), `${n}: its support is ${bare(sup.block)}, which cannot carry it`);
    }
    // a block hung on an unbuildable one cannot be built either
    for (let again = true; again;) { again = false; for (const c of abs) { const n = bare(c.block), kind = needs(n); if (!kind || out.has(ckey(c))) continue; const p = kind === 'wall' ? { x: c.x + D[O.OPP[(c.props || {}).facing] || 'north'][0], y: c.y, z: c.z + D[O.OPP[(c.props || {}).facing] || 'north'][2] } : { x: c.x, y: c.y - 1, z: c.z }; if (out.has(ckey(p))) { out.set(ckey(c), `${n}: its support is unbuildable`); again = true; } } }
    return out;
}

/** Items a bot must hold for the plan, as Litematica counts them: a bed or door once per pair, a slab twice when double, snow and candles per layer / piece, a bucket per fluid source and waterlogged block. */
function materialsOf(cells) {
    const m = {}, add = (it, n = 1) => { if (it) m[it] = (m[it] || 0) + n; };
    for (const c of cells) {
        const k = kindOf(c), n = bare(c.block), p = c.props || {};
        if (k === 'flow' || k === 'derived') continue;
        if (k === 'fluid') { add(itemFor(n)); continue; }
        add(itemFor(n), /_slab$/.test(n) && p.type === 'double' ? 2 : n === 'snow' ? Number(p.layers || 1) : /candle$/.test(n) ? Number(p.candles || 1) : n === 'sea_pickle' ? Number(p.pickles || 1) : 1);
        if (p.waterlogged === 'true') add('water_bucket');
    }
    return m;
}

/** A plain house: floor, four walls with a door and windows, flat roof. Cells are relative to the corner. */
function house({ w = 7, d = 7, h = 4, wall = 'oak_planks', floor = 'cobblestone', roof = null, glass = 'glass', door = 'oak_door' } = {}) {
    const cells = [];
    const dx = Math.floor(w / 2);
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x, y: 0, z, block: floor });
    for (let y = 1; y <= h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
        if (x !== 0 && z !== 0 && x !== w - 1 && z !== d - 1) continue;
        if (z === 0 && x === dx && y <= 2) { cells.push({ x, y, z, block: door }); continue; }       // the doorway (door is two cells high)
        const window = y === 2 && ((z === 0 || z === d - 1) ? x % 3 === 1 && x !== dx : z % 3 === 1);
        cells.push({ x, y, z, block: window ? glass : wall });
    }
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x, y: h + 1, z, block: roof || wall });
    return cells;
}

/** Cells of a vanilla structure `.nbt` (gzip or plain), with block states: { x, y, z, block, props }. */
async function fromStructureNbt(buf) {
    const bp = require('./blueprint');
    return bp.cells(await bp.read(buf));
}

/** Cut a blueprint into tiles and add them to a ledger: layer = height above the origin (bottom-up), rows = z lines of a tile; the fluid pass is one layer more, last. */
function planBuild(cells, origin, { tile = TILE, known = null } = {}) {
    if (!cells.length) throw new Error('blueprint is empty');
    const abs = cells.map((c) => ({ x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z, block: bare(c.block), props: c.props || {} }));
    // `known(name)`: does the bot's registry have this block (a mod block of another mod set does not)? Unplaceable ones are listed, not tried.
    const cannot = (b) => itemFor(b) === null || (known && !known(b));
    const unsupported = [...new Set(abs.map((c) => c.block).filter((b) => !SKIP.test(b) && cannot(b)))];
    const real = abs.filter((c) => !SKIP.test(c.block));
    const never = unbuildable(real);                                                                 // cells the survival game cannot hold: reported, not tried
    const skipped = { flow: real.filter((c) => kindOf(c) === 'flow').length, derived: real.filter((c) => kindOf(c) === 'derived').length, unbuildable: never.size };
    const placeable = real.filter((c) => !cannot(c.block) && kindOf(c) !== 'flow' && kindOf(c) !== 'derived' && !never.has(ckey(c)));
    if (!placeable.length) throw new Error('nothing the bots can place (every block is unsupported)');
    // a waterlogged block is placed dry in its layer and filled with water in the fluid pass (a bucket used on the block itself: no flow, no race)
    const waterlog = placeable.filter((c) => c.props.waterlogged === 'true' && kindOf(c) !== 'fluid').map((c) => ({ x: c.x, y: c.y, z: c.z, block: 'water', props: { level: '0' }, waterlog: true, of: c.block }));
    const all = [...placeable, ...waterlog], fluidCell = (c) => c.waterlog || kindOf(c) === 'fluid';
    // phases: per height one for the blocks that stand alone and one for the ones that need a support (a torch hangs on a block of the next row, which a row-wise order would not have yet), then the fluids
    const minY = Math.min(...all.map((c) => c.y)), maxY = Math.max(...all.map((c) => c.y)), layers = maxY - minY + 1, phases = 2 * layers + (all.some(fluidCell) ? 1 : 0);
    const phaseOf = (c) => (fluidCell(c) ? 2 * layers : 2 * (c.y - minY) + (ATTACHED.test(c.block) ? 1 : 0));
    // ORDER (2026-11-17): within a phase a cell is placed next to something that already stands, growing outwards like a flood from what is built (earlier phases, then the cells placed
    // before it in this phase); a row-by-row order put the far end of a floating arm first and needed a chain of temporary blocks to reach it. Only a component that touches nothing
    // gets a seed (its lowest cell), and that one cell is the only one that may need a temporary support.
    const order = growthOrder(all, phaseOf, fluidCell, 2 * layers, tile, supportKey);
    const tiles = new Map();
    for (const c of all) {
        const tx = Math.floor(c.x / tile), tz = Math.floor(c.z / tile), id = `b${tx}_${tz}`;
        let t = tiles.get(id);
        if (!t) tiles.set(id, t = { id, z0: tz * tile, z1: tz * tile + tile - 1, x0: Infinity, x1: -Infinity, cells: new Map() });
        t.x0 = Math.min(t.x0, c.x); t.x1 = Math.max(t.x1, c.x);
        const o = order.get(ckeyOf(c)), key = phaseOf(c) * tile + o.unit;                         // unit index inside the tile = phase * rows + a chunk of the growth order
        c.seq = o.seq;
        (t.cells.get(key) || t.cells.set(key, []).get(key)).push(c);
    }
    const regions = [...tiles.values()].map((t) => ({
        id: t.id, anchor: { x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2 }, layers: phases, rows: tile, meta: { tile: t.id, minY },
    }));
    const footprint = new Set(placeable.map((c) => `${c.x},${c.z}`));
    const want = new Map(placeable.filter((c) => !c.waterlog).map((c) => [`${c.x},${c.y},${c.z}`, c.block]));
    const cellSet = new Set(real.map((c) => `${c.x},${c.y},${c.z}`));                                 // every cell the structure owns (flows and bed heads too): no temporary block goes there
    return { origin, minY, layers, phases, tiles, regions, unsupported, unbuildable: [...never].map(([k, why]) => ({ at: k, why })), footprint, cellSet, want, count: placeable.length + waterlog.length, skipped, materials: materialsOf(placeable) };
}

/** Cells of one unit in placement order (the growth order of planBuild; a waterlog pass cell after its block). */
function unitCells(plan, regionId, u) {
    const t = plan.tiles.get(regionId), list = (t.cells.get(u) || []).slice();
    list.sort((a, b) => (!!a.waterlog - !!b.waterlog) || (a.seq - b.seq));
    return list;
}

const ckeyOf = (c) => `${c.x},${c.y},${c.z}`;
/** The cell a block needs to stand or hang on (null for a block that needs none): a wall sign / wall torch hangs on the block behind it, a standing torch, sign, wire, repeater on the one below. */
function supportKey(c) {
    const n = bare(c.block), f = (c.props || {}).facing;
    if (/(wall_sign|wall_torch|wall_hanging_sign)$/.test(n) && f && O.OPP[f]) { const d = D[O.OPP[f]]; return `${c.x + d[0]},${c.y + d[1]},${c.z + d[2]}`; }
    if (/(^|_)(sign|torch|redstone_wire|repeater|comparator|pressure_plate|carpet)$/.test(n)) return `${c.x},${c.y - 1},${c.z}`;
    return null;
}
/**
 * seq / unit of every cell. Per phase, in phase order: a cell is READY when a 6-neighbour is already ordered (an earlier phase, or earlier in this phase); ready cells are taken in a
 * breadth-first wave (lowest first), and when nothing is ready the lowest remaining cell seeds a new component. Units are chunks of the order (at least 4 cells, at most 63 per phase).
 * The fluid phase keeps height, then x, then z. Returns Map key -> { seq, unit }.
 */
function growthOrder(cells, phaseOf, fluidCell, fluidPhase, tile = TILE, supportKey = () => null) {
    const byPhase = new Map(), out = new Map(), done = new Set(), owned = new Set(cells.map(ckeyOf));
    for (const c of cells) { const p = phaseOf(c); (byPhase.get(p) || byPhase.set(p, []).get(p)).push(c); }
    const NB = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
    for (const p of [...byPhase.keys()].sort((a, b) => a - b)) {
        const list = byPhase.get(p).slice().sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z), seqd = [];
        if (p === fluidPhase) { for (const c of list) seqd.push(c); }
        else {
            const rest = new Map(list.map((c) => [ckeyOf(c), c])), touches = (c) => supported(c) && NB.some(([dx, dy, dz]) => done.has(`${c.x + dx},${c.y + dy},${c.z + dz}`));
            const supported = (c) => { const k = supportKey(c); return !k || done.has(k) || !owned.has(k); };        // a sign hangs on the block behind it, a torch stands on the one below: that one first
            const take = (c) => { rest.delete(ckeyOf(c)); done.add(ckeyOf(c)); seqd.push(c); };
            let frontier = list.filter(touches);
            while (rest.size) {
                if (!frontier.length) { const all = [...rest.values()]; frontier = [all.find(supported) || all[0]]; }            // nothing ready: the lowest remaining cell starts a component
                const next = [];
                const later = [];
                for (const c of frontier) { if (!rest.has(ckeyOf(c))) continue; if (!supported(c)) { later.push(c); continue; } take(c); for (const [dx, dy, dz] of NB) { const q = rest.get(`${c.x + dx},${c.y + dy},${c.z + dz}`); if (q) next.push(q); } }
                next.push(...later.filter((c) => rest.has(ckeyOf(c))));
                frontier = next.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
            }
        }
        const chunk = Math.max(4, Math.ceil(seqd.length / (tile - 1)));
        seqd.forEach((c, i) => out.set(ckeyOf(c), { seq: i, unit: Math.min(tile - 1, Math.floor(i / chunk)) }));
        if (p !== fluidPhase) for (const c of seqd) done.add(ckeyOf(c));
    }
    return out;
}

const at = (c, d) => ({ x: c.x + D[d][0], y: c.y + D[d][1], z: c.z + D[d][2] });
const REPLACEABLE = /^(air|cave_air|void_air|grass|tall_grass|short_grass|fern|snow|dead_bush)$/;

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

/** What differs between the blueprint and the world: cells whose block (or state) is not the wanted one (a repair job's input). Fluids and waterlogging are checked by name / property. */
function diffBuild(plan, w) {
    const missing = [];
    for (const t of plan.tiles.values()) for (const list of t.cells.values()) for (const c of list) {
        const b = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
        if (c.waterlog) { if (!b || !b.getProperties || b.getProperties().waterlogged !== 'true') missing.push(c); continue; }
        if (b) { if (!stateMatches(b, c) || useMismatch(b, c)) missing.push(c); continue; }
        if (w.nameAt(c.x, c.y, c.z) !== c.block) missing.push(c);
    }
    return missing;
}

/**
 * Staircase of temporary blocks that lets a bot stand level with the layer below `target` (so it can place against the
 * neighbour and then walk onto what it placed). The top step is the free cell just outside the structure's footprint, the
 * stair descends away from the structure: column j (j = 0 at the top) is K - j blocks high, K = wanted feet height - ground
 * feet height. `groundY` = feet y on the ground beside the site (the blueprint origin's y: the first layer sits on the ground). Directions are tried nearest-top first; a stair that would
 * run into the blueprint or into solid ground is skipped. Returns {top, cells} (cells in placement order, outer column
 * first, each column bottom up; every cell has support below or beside when it is placed), {cells: []} when the ground is
 * high enough, or null when no direction is free or the structure is higher than `maxK` steps.
 */
function scaffoldFor(plan, w, target, groundY, { maxK = 10, reuse = new Set() } = {}) {
    const K = target.y - 1 - groundY;
    if (K <= 0) return { top: null, cells: [] };
    if (K > maxK) return null;
    const foot = plan.footprint, inFoot = (x, z) => foot.has(`${x},${z}`);
    const opts = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        // Walk from the target column outwards (opposite of the stair's direction of descent) to the first free column.
        let x = target.x, z = target.z, n = 0;
        while (inFoot(x, z) && n++ < 64) { x -= dx; z -= dz; }
        opts.push({ dx, dz, top: { x, z }, n });
    }
    opts.sort((a, b) => a.n - b.n);
    for (const o of opts) {
        const cells = [];
        let free = true;
        for (let j = 0; j < K && free; j++) {
            const x = o.top.x - o.dx * j, z = o.top.z - o.dz * j;      // the stair runs back the way we walked out
            if (inFoot(x, z)) { free = false; break; }
            for (let y = groundY; y < groundY + (K - j); y++) {
                if (w.kindAt(x, y, z) !== 'air' && !reuse.has(`${x},${y},${z}`)) { free = false; break; }
                cells.push({ x, y, z, temp: true, j });
            }
        }
        if (!free) continue;
        cells.sort((a, b) => b.j - a.j || a.y - b.y);
        return { top: { x: o.top.x, y: groundY + K, z: o.top.z }, cells };
    }
    return null;
}

/**
 * A chain of temporary blocks that ends in a support next to the cell `c`: the shortest path of free cells (air, not owned by the structure, not `c`) from a cell
 * that touches a solid block to a cell beside `c` in one of `dirs`. Returned in placement order (the one touching solid ground first, the support last), or null.
 */
function tempChain(plan, w, c, dirs, maxLen = 16) {
    const solid = (p) => clickable(w, p), isC = (p) => p.x === c.x && p.y === c.y && p.z === c.z;
    const touches = (p) => Object.keys(D).some((d) => { const q = at(p, d); return !isC(q) && solid(q); });
    // first only cells the structure does not own; if that finds nothing (the cell is walled in by cells still to be placed) also those: they are dug again before their own block goes in
    for (const own of [false, true]) {
        const free = (p) => w.kindAt(p.x, p.y, p.z) === 'air' && (own || !plan.cellSet.has(ckey(p))) && !isC(p);
        let best = null;
        for (const d of dirs) {
            const s = at(c, d);
            if (!free(s)) continue;
            const seen = new Set([ckey(s)]), queue = [[s]];
            while (queue.length && seen.size < 4000) {
                const path = queue.shift(), last = path[path.length - 1];
                if (touches(last)) { if (!best || path.length < best.length) best = path.slice().reverse(); break; }
                if (path.length >= maxLen) continue;
                for (const dd of Object.keys(D)) { const q = at(last, dd); if (!seen.has(ckey(q)) && free(q)) { seen.add(ckey(q)); queue.push([...path, q]); } }
            }
        }
        if (best) return best;
    }
    // a lone block high above everything (a corner marker): a pillar straight down to the first block under it
    const col = [];
    for (let k = 1; k <= 40; k++) {
        const p = { x: c.x, y: c.y - k, z: c.z };
        if (clickable(w, p)) return col.length ? col.reverse() : null;
        if (w.kindAt(p.x, p.y, p.z) !== 'air') return null;
        col.push(p);
    }
    return null;
}

/**
 * Run one unit. `env`: exec, w, have, here. Idempotent: a cell that already holds its block is skipped, one that holds
 * something else is dug out first. Temporary scaffold blocks are recorded in env.scaffold (kept while the bot works on the same
 * layer) and removed by cleanup().
 */
async function runUnit(plan, regionId, u, env) {
    const bot = env.bot || null;
    if (bot) bot.__maxDrop = 8;          // a build in the sky: the walker may step off an edge up to 8 down (4 hearts) instead of stranding on its own floating blocks (it was 3)
    // the structure's materials are held back from temporary use (scaffolds, pillars, seals) while the bot works on it (owner 2026-11-14: the planks went into scaffolds)
    // only what is still to be placed (a cell that already holds its block needs nothing): an over-reserve starved the walker's pillar of the blocks the kit had for it
    let res = null;
    if (bot) { res = new Map(); for (const t of plan.tiles.values()) for (const list of t.cells.values()) for (const c of list) { if (c.waterlog ? false : env.w.nameAt(c.x, c.y, c.z) === c.block) continue; const it = c.waterlog ? 'water_bucket' : itemFor(c.block); if (it) res.set(it, (res.get(it) || 0) + 1); } bot.__reserve = res; }
    // the structure's cells are never dug by the walker on its way (it dug through the cottage's walls to reach the inside: two wrong cells at the end)
    if (bot) { if (!plan.__cellSet) { plan.__cellSet = new Set(); for (const t of plan.tiles.values()) for (const list of t.cells.values()) for (const c of list) plan.__cellSet.add(`${c.x},${c.y},${c.z}`); } bot.__keep = (x, y, z) => plan.__cellSet.has(`${x},${y},${z}`); }
    try { return await runUnitBody(plan, regionId, u, env); } finally { if (bot && bot.__reserve === res) bot.__reserve = null; }          // __keep stays: between units (the night shelter) the structure is still not to be dug
}
async function runUnitBody(plan, regionId, u, env) {
    const cells = unitCells(plan, regionId, u.unit), r = { placed: 0, skipped: 0, scaffold: 0, fixed: 0, poured: 0 };
    env.scaffold = env.scaffold || { layer: null, cells: [] };
    env.scaffold.plan = plan;
    if (env.scaffold.layer !== null && env.scaffold.layer !== u.layer) await cleanup(env);
    env.scaffold.layer = u.layer;
    for (const c of cells) {
        const res = await buildCell(plan, c, env, r);
        if (!res.ok) return { ok: false, reason: res.reason, detail: { ...(res.detail || {}), cell: c, stage: res.stage || 'place', ...r } };
    }
    return { ok: true, reason: null, detail: r };
}

const ok = { ok: true };
const bad = (reason, detail, stage) => ({ ok: false, reason, detail, stage });

/** One cell: skip it when it is right, dig out what is wrong, place it with the recipe that gives its state, check the state, right-click what needs it. */
async function buildCell(plan, c, env, r) {
    const w = env.w;
    if (c.waterlog || kindOf(c) === 'fluid') return pourCell(c, env, r);
    const item = itemFor(c.block), here = () => (w.blockAt ? w.blockAt(c.x, c.y, c.z) : null);
    let cur = here();
    if (cur ? stateMatches(cur, c) : w.nameAt(c.x, c.y, c.z) === c.block) { const um = useMismatch(cur, c); if (!um) { r.skipped++; return ok; } return fixUse(c, env, r); }
    const curName = cur ? cur.name : w.nameAt(c.x, c.y, c.z);
    if (curName && !REPLACEABLE.test(curName)) {
        if (/^(water|lava)$/.test(curName) && w.kindAt(c.x, c.y, c.z) !== 'solid') { /* a fluid is replaced by the block */ } else {
            const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z });
            if (!m.ok) return { ...m, stage: 'clear' };
        }
    }
    if (env.have(item) < 1) { await cleanup(env); return bad('missing_item', { item }, 'stock'); }       // the bot is about to walk to a supply chest: it must not be perched on its own temporary pillar (the walk fails from there)
    return placeOriented(plan, c, item, env, r);
}

async function placeOriented(plan, c, item, env, r) {
    const w = env.w, clickAt = (p) => clickable(w, p);
    // what a torch, sign or repeater can stand on / hang on: a full block; a wall or fence carries a block on top (center support)
    const solidAt = (p, d) => w.kindAt(p.x, p.y, p.z) === 'solid' || (d === 'down' && /(_wall|_fence)$/.test(w.nameAt(p.x, p.y, p.z) || '')) || (/_sign$/.test(c.block) && /_sign$/.test(w.nameAt(p.x, p.y, p.z) || ''));      // a sign hangs on a sign when the click is sneaked (the owner built it so in survival)
    const recs = O.recipes(c.block, c.props, (d) => solidAt(at(c, d), d));
    if (!recs.length) return bad('invalid_target', { why: 'no placement recipe for this state', block: c.block, props: c.props }, 'recipe');
    const blockArg = c.block !== item ? { block: c.block } : {};
    const tried = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
        let q = null, args;
        {
            const cand = recs.filter((x) => !tried.has(x) && clickAt(at(c, x.support))).sort((a, b) => (isInteractiveBlock(w, at(c, a.support)) - isInteractiveBlock(w, at(c, b.support))));
            q = cand[0] || null;
            if (!q) {
                if (NEEDS_SUPPORT.test(c.block)) return bad('unreachable', { why: 'no solid support for a block that needs one (it is placed after its support)', block: c.block }, 'support');
                const ch = tempChain(plan, w, c, [...new Set(recs.filter((x) => !tried.has(x)).map((x) => x.support))]);
                if (!ch) return bad('invalid_target', { why: 'no way to support this block (no solid block near, no free cell for a temporary one)', block: c.block }, 'support');
                const sc = await putTemps(ch, env, r); if (!sc.ok) return sc;
                continue;
            }
            args = { x: c.x, y: c.y, z: c.z, item, ...blockArg, recipe: { support: q.support, face: q.face, hy: q.hy, yRot: q.yRot, pitch: q.pitch } };
        }
        let p = await env.exec('place', args);
        // A temporary block helps when the cell cannot be reached or seen. With NAV (env.navOn) the router's walk reaches the cell itself (pillar beside a wall, then the wall top; its blocks are taken away).
        if (!p.ok && env.navOn && env.navOn() && ['unreachable', 'not_visible', 'stuck', 'precondition_failed'].includes(p.reason)) {
            const t = await env.travel({ x: c.x, y: c.y, z: c.z }, { near: 3, nearY: 3 });
            if (t.ok) p = await env.exec('place', args);
        } else if (!p.ok && (p.reason === 'unreachable' || p.reason === 'not_visible' || (p.reason === 'stuck' && p.detail && p.detail.goal === 'reach placement face'))) {
            // no NAV (legacy walker): a staircase of temporary blocks outside the footprint, climbed, then the same placement again
            const sc = scaffoldFor(plan, w, c, plan.origin.y, { reuse: new Set(env.scaffold.cells.map((z) => `${z.x},${z.y},${z.z}`)) }), mat = sealItem(env, 2);
            if (sc && sc.cells.length && mat) {
                for (const s of sc.cells) {
                    if (w.nameAt(s.x, s.y, s.z) === mat) continue;
                    const z = await env.exec('place', { x: s.x, y: s.y, z: s.z, item: mat, temp: 'scaffold' });
                    if (!z.ok) return { ...z, stage: 'scaffold' };
                    env.scaffold.cells.push(s); r.scaffold++;
                }
                const mv = await env.exec('move_to', sc.top);
                if (!mv.ok) return { ...mv, stage: 'climb' };
                p = await env.exec('place', args);
            }
        }
        if (!p.ok) { if (q && p.reason === 'not_confirmed') { tried.add(q); continue; } return { ...p, stage: 'place' }; }
        // what the server made of it
        const now = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
        if (now && !stateMatches(now, c)) {
            r.fixed++;
            if (q) tried.add(q);
            const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z });
            if (!m.ok) return { ...m, stage: 'redo' };
            continue;
        }
        r.placed++;
        const um = now && useMismatch(now, c);
        return um ? fixUse(c, env, r) : ok;
    }
    return bad('not_confirmed', { why: 'no placement recipe gave the wanted state', block: c.block, props: c.props, tried: tried.size }, 'state');
}

/** A block a placement can be clicked against: not air, a fluid or a replaceable plant, and with a shape. */
function clickable(w, p) {
    const k = w.kindAt(p.x, p.y, p.z), n = w.nameAt(p.x, p.y, p.z);
    return !!n && k !== 'air' ? !REPLACEABLE.test(n) : !!n && !REPLACEABLE.test(n) && !/^(air|cave_air|void_air|water|lava)$/.test(n);      // a torch or a sign has no collision (kind 'air') but the server accepts a click on it
}
const isInteractiveBlock = (w, p) => (require('../../skills/world').isInteractive((w.nameAt(p.x, p.y, p.z) || '')) ? 1 : 0);

async function putTemps(chain, env, r) {
    const mat = sealItem(env, 2), w = env.w;
    if (!mat) return bad('missing_item', { why: 'no low-value block for a temporary support', tried: SEAL_ITEMS }, 'support');
    for (const s of chain) {
        if (w.nameAt(s.x, s.y, s.z) === mat) continue;
        // click against a block next to it (the one below first, then the sides): a recipe, so that a stair or a trapdoor can be the support too
        const dir = ['down', 'north', 'south', 'east', 'west', 'up'].find((d) => clickable(w, at(s, d)));
        if (!dir) return bad('invalid_target', { why: 'a temporary block has nothing to be placed against', cell: s }, 'scaffold');
        const q0 = O.recipes(mat, {}, () => true).find((x) => x.support === dir);
        const a = { x: s.x, y: s.y, z: s.z, item: mat, temp: 'scaffold', recipe: { support: q0.support, face: q0.face, hy: q0.hy, yRot: q0.yRot, pitch: q0.pitch } };
        let q = await env.exec('place', a);
        if (!q.ok && env.navOn && env.navOn() && ['unreachable', 'not_visible', 'stuck', 'precondition_failed'].includes(q.reason)) {
            const t = await env.travel({ x: s.x, y: s.y, z: s.z }, { near: 3, nearY: 3 });
            if (t.ok) q = await env.exec('place', a);
        }
        if (!q.ok) return { ...q, stage: 'scaffold' };
        env.scaffold.cells.push({ ...s, mat }); r.scaffold++;
    }
    return ok;
}

/** open / delay: right-click until the state is the wanted one (a trapdoor toggles once, a repeater steps its delay 1..4). */
async function fixUse(c, env, r) {
    for (let k = 0; k < 5; k++) {
        const b = env.w.blockAt(c.x, c.y, c.z), um = useMismatch(b, c);
        if (!um) { r.fixed++; return ok; }
        const a = await env.exec('activate', { x: c.x, y: c.y, z: c.z });
        if (!a.ok) return { ...a, stage: 'use' };
    }
    return bad('not_confirmed', { why: 'the block would not take the wanted state by right-clicking', block: c.block, props: c.props }, 'use');
}

/** A water or lava source (a bucket on the cell) or the water of a waterlogged block (a bucket on the block itself). */
async function pourCell(c, env, r) {
    const w = env.w, b = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null, item = c.waterlog ? 'water_bucket' : itemFor(c.block);
    if (c.waterlog) {
        if (b && b.getProperties && b.getProperties().waterlogged === 'true') { r.skipped++; return ok; }
        if (!b || b.name !== c.of) return bad('precondition_failed', { why: 'the block to waterlog is not there', block: c.of }, 'pour');
    } else if (b && b.name === c.block && (!b.getProperties || (b.getProperties().level || '0') === '0')) { r.skipped++; return ok; }
    if (env.have(item) < 1) { await cleanup(env); return bad('missing_item', { item }, 'stock'); }
    const p = await env.exec('pour', { x: c.x, y: c.y, z: c.z, item, ...(c.waterlog ? { waterlog: true } : {}) });
    if (!p.ok) return { ...p, stage: 'pour' };
    r.poured++;
    return ok;
}

/** Remove the temporary blocks, highest first, so the bot always has something to stand on. */
async function cleanup(env) {
    const t = env.scaffold; if (!t || !t.cells.length) { if (t) t.layer = null; return { ok: true, removed: 0 }; }
    const cells = t.cells.sort((a, b) => b.y - a.y || b.x - a.x); let removed = 0;
    for (const c of cells) {
        const here = env.w.nameAt(c.x, c.y, c.z);
        if (!here || /^(air|cave_air)$/.test(here)) continue;
        // only what is still the temporary block: the structure's own block may have been built into the cell since (a chain passes through cells that are built later)
        if (t.plan && t.plan.want && t.plan.want.get(ckey(c)) === here) continue;
        if (c.mat && here !== c.mat) continue;
        const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z });
        if (m.ok) removed++;
    }
    t.cells = []; t.layer = null;
    return { ok: true, removed };
}

function createBuildJob(cells, origin, ledgerOpts = {}, planOpts = {}) {
    const plan = planBuild(cells, origin, planOpts), ledger = new Ledger(ledgerOpts);
    for (const r of plan.regions) ledger.addRegion(r);
    return { kind: 'build', ledger, plan, runUnit: (regionId, unit, env) => runUnit(plan, regionId, unit, env), cleanup, diff: (w) => diffBuild(plan, w) };
}

module.exports = { house, fromStructureNbt, planBuild, unbuildable, unitCells, scaffoldFor, tempChain, diffBuild, runUnit, cleanup, createBuildJob, itemFor, kindOf, materialsOf, stateMatches, useMismatch };

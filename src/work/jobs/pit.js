'use strict';
// Open-pit excavation as a crew job (docs/proposed/WORKERS-v1.md, part 1): a box is cut into chunk-aligned regions; a
// region is dug layer by layer from the top, one ROW (a line of cells along x) per unit; every unit is the existing `mine`
// command repeated, plus `place` for the water rule. Nothing here touches the game directly: `exec(name, args)` runs a
// command of the action layer, `w` is its world model (kindAt/nameAt), so the whole job is testable without a server.
const { Ledger, DONE, STUCK } = require('./crew');
const { makeSweeper } = require('./pit_sweep');
const janitor = require('../bot/janitor');
const abyss = require('../bot/abyss');

const CHUNK = 16;
const TILE = 5;                      // a standing place covers a tile of this many cells per side: the farthest cell is 2.83 blocks away, well inside the 4.2 reach
const SWEEP_R = 3.9;                 // horizontal reach of a standing place: with the eyes 1.1 above the cell, 3.9 is 4.05 in 3D (reach 4.5, aim margin 0.3)
const STATION_TICKS = 600;           // a walk to a station gets 30 s (the command's own limit is 60 s): from there the lift, the pillar and the corridor are the way on
// The ledger keeps about 35 bytes per unit (a unit = one standing place of one layer; a row of one layer for method rows). 100 x 100 chunks, 5 x 5 tiles, 60 layers = 9.6 M units = 340 MB;
// 16 M units = about 560 MB; the cap is what the console container can hold beside everything else (owner 2026-11-10: pits of 100 x 100 chunks).
const MAX_UNITS = 16_000_000;
const EXPERT_BAND = 2;               // layers per unit of the expert method (the arm reaches two layers below the feet from a station)
const PASSABLE = new Set(['air', 'climb']);
// A pit for a build site (`plants`, createPitJob): the job wants its cells empty, so a cell with no collision box that is not air (grass, flowers, ferns, vines, snow layers, torches)
// is still to dig; a plain pit walks through them as air (081's site b081f: 96 such cells at the ground layer stood after the pit, its rounds 2 and 3 saw nothing to do in 0 s and
// the builder broke them with clicks)
const NOT_AIR = (w, c) => !/^(air|cave_air|void_air)$/.test(String((w.nameAt && w.nameAt(c.x, c.y, c.z)) || 'air').replace(/^minecraft:/, ''));
const openCell = (plan, w, c) => PASSABLE.has(w.kindAt(c.x, c.y, c.z)) && !(plan.clearPlants && NOT_AIR(w, c));
// Natural tree blocks. One that hangs high above the ground below it cannot be reached on foot: the planner expands 20,000 cells and gives up
// (30-85 s per try, six tries per unit, bots end up standing on the canopy) - the live pit of 2026-11-07 with top y 90 over ground at y 64 and a tree.
// The pit leaves such blocks alone (they are not ground; the audit does not count them) and says how many it left.
const { TREE } = require('./pit_trees');          // the tree pass (pit_trees.js) clears these before the digging and again at the end; what it could not reach is still left alone here
// blocks above the ground below: from there on a tree block is the tree pass's (pit_trees.js, which takes everything over LOW from a pillar beside it), not a unit's: a unit
// cannot pillar for it, and leaves and logs 4-6 over the ground made every unit under a canopy fail ("stuck at mine: the same unmet precondition", "unreachable: inside rock",
// "invalid_target at rise: nothing solid under the feet / no head room": 081's site b081d, 1.21.1 world 4, the pit at 2 239 of 2 304 units with the crew waiting on the layer gate)
const AERIAL_UP = require('./pit_trees').LOW;
const FATAL_MINE = new Set(['died', 'disconnected', 'cancelled']);
const TREE_PASSES = 3;              // runs of a region's tree pass at most (the first, and again after units left tree blocks to it)
const isBamboo = (w, c) => /^bamboo(_sapling)?$/.test(String((w.nameAt && w.nameAt(c.x, c.y, c.z)) || '').replace(/^minecraft:/, ''));
/** The lowest bamboo block of the stalk through c (down to 24 below), when it lies below c: breaking it takes the whole stalk. */
const bambooRoot = (w, c) => { let y = c.y; while (y > c.y - 24 && isBamboo(w, { x: c.x, y: y - 1, z: c.z })) y--; return y < c.y ? { x: c.x, y, z: c.z } : null; };
const isTreeAt = (w, c) => TREE.test(String((w.nameAt && w.nameAt(c.x, c.y, c.z)) || '').replace(/^minecraft:/, ''));
function aerialTree(w, c) {
    const bare = (n) => String(n || '').replace(/^minecraft:/, '');
    if (!TREE.test(bare(w.nameAt && w.nameAt(c.x, c.y, c.z)))) return false;
    let y = c.y - 1;
    for (let n = 0; n < 200 && y >= -64; n++, y--) {
        const k = w.kindAt(c.x, y, c.z);
        if (k === 'unknown') return false;                                   // not loaded: no verdict
        if (k === 'solid' && !TREE.test(bare(w.nameAt && w.nameAt(c.x, y, c.z)))) break;         // the ground: air and tree blocks below do not count
    }
    return c.y - y > AERIAL_UP;
}
const UNBREAKABLE = /^(bedrock|barrier|end_portal_frame|end_portal|nether_portal|command_block|structure_block|jigsaw)$/;
// What the bot fills fluids with, in order of preference: cheap, common in a pit, does not fall (no sand or gravel).
const { isHigh } = require('../bot/force');
const SEAL_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate'];
/** The block to seal with: the usual ones first, else any placeable, non-falling, low-value block in the pack (env.tempItem; owner 2026-11-10), `n` of it at least. */
// Every caller fills a FLUID cell of the box or its one-cell ring (a seal before a dig, the lake fill, the water rescue's footing, water.js floodPlan: box cells only): the block
// replaces the water as ground, a box cell's is dug with its layer (the test's server check sees any block left in the box) and the ring's keeps the lake out of the finished pit
// (the job's result, contract TASK-20261125-075 point 5). So the dug rubble first, as a player fills with what it digs; the operator's temporary block (pumpkins on the test worlds)
// only when there is none. Pumpkins first (c288de5e) spent the whole kit of 128 on water in all three 1.21.1 mine_b worlds (lake 446 / 129 / 942 fluid cells in the box) and left
// nothing to climb with ("no low-value block to stack", w3): 128 pumpkins standing in each box at the time limit, mine_b-w121-a.
// (on the test worlds, where the operator's block is the only temporary block, never that block: a fill is ground, not a temporary block; out of rubble, the caller digs some,
// `harvest`. With pumpkins as the fallback, 44 of them stood as lake fill at the end of mb075e once 798 fills had used up the rubble)
const sealItem = (env, n = 1) => SEAL_ITEMS.find((x) => env.have(x) - (env.reserved ? env.reserved(x) : 0) >= n) || (require('../bot/tempblocks').only().length ? null : (env.tempItem ? env.tempItem(n) : null));

/**
 * Box {x0, z0, x1, z1, top, bottom} (inclusive columns; `top` = y of the first block layer to dig, `bottom` = y of the last).
 * Returns the chunk-aligned regions and the haul road. Layer l is y = top - l.
 */
function planPit(box, { chunk = CHUNK, lanes = 0, method = 'rows', tile = TILE, road: withRoad = true } = {}) {
    const { x0, z0, x1, z1, top, bottom } = box;
    for (const k of ['x0', 'z0', 'x1', 'z1', 'top', 'bottom']) if (!Number.isInteger(box[k])) throw new Error(`box.${k} must be an integer`);
    if (x1 < x0 || z1 < z0 || top < bottom) throw new Error('box is empty (x1<x0, z1<z0 or top<bottom)');
    const layers = top - bottom + 1;
    const road = withRoad ? planRoad(box, layers) : { keep: new Map(), cells: [] };       // no road: bots leave by pillar (exit.js) and enter from the surface with the digging
    if (!['rows', 'sweep', 'expert'].includes(method)) throw new Error('method is rows, sweep or expert');
    if (!Number.isInteger(tile) || tile < 1 || tile > 7) throw new Error('tile 1..7');
    // rows: a unit is one row of a layer, dug cell by cell while walking along it. sweep: a unit is one standing place of a layer
    // ("station"): the bot goes to the middle of a tile, digs everything within reach in one go and only then moves on.
    const mk = (id, r) => {
        const base = { ...r, top, bottom };
        // expert: a unit is one BAND of two layers of the whole chunk; the learned station planner (pit_expert.js) decides where to stand and what to dig from there. One unit per band: the ledger's layers are bands.
        if (method === 'expert') return { id, anchor: { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }, layers: Math.ceil(layers / EXPERT_BAND), rows: 1, meta: { ...base, method, band: EXPERT_BAND } };
        if (method !== 'sweep') return { id, anchor: { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }, layers, rows: r.z1 - r.z0 + 1, meta: base };
        const stations = stationsOf(r, tile);
        return { id, anchor: { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }, layers, rows: stations.length, meta: { ...base, method, tile, stations } };
    };
    const regions = [];
    for (let cx = Math.floor(x0 / chunk); cx <= Math.floor(x1 / chunk); cx++) {
        for (let cz = Math.floor(z0 / chunk); cz <= Math.floor(z1 / chunk); cz++) {
            regions.push(mk(`c${cx}_${cz}`, { x0: Math.max(x0, cx * chunk), x1: Math.min(x1, cx * chunk + chunk - 1), z0: Math.max(z0, cz * chunk), z1: Math.min(z1, cz * chunk + chunk - 1) }));
        }
    }
    // Fewer chunks than bots: cut the box into lanes instead, one X-Z range per bot that it digs down to the bottom, so that bots do
    // not work on the same layer side by side (owner 2026-11-06). With enough chunks the chunks are the lanes.
    const out = lanes > regions.length ? ((l) => (l.length > regions.length ? { box, layers, regions: l.map((r, i) => mk(`l${i}`, r)), road, lanes: l.length, method } : null))(laneBoxes(box, lanes)) : null;
    const plan = out || { box, layers, regions, road, lanes: regions.length, method };
    const units = plan.regions.reduce((n, r) => n + r.layers * r.rows, 0);
    if (units > MAX_UNITS) throw new Error(`this pit is ${units.toLocaleString('en')} units of work (the ledger holds at most ${MAX_UNITS.toLocaleString('en')}): dig it in two steps (a shallower range first), or make it smaller`);
    return plan;
}

/** Cut a box into about `n` rectangles of near-square shape (a grid cx x cz with cx*cz <= n, as close to n as the box allows, none thinner than MIN_LANE). */
const MIN_LANE = 3;
function laneBoxes(box, n) {
    const W = box.x1 - box.x0 + 1, D = box.z1 - box.z0 + 1;
    let best = null;
    for (let cx = 1; cx <= n; cx++) for (let cz = 1; cx * cz <= n; cz++) {
        if (W / cx < MIN_LANE && cx > 1 || D / cz < MIN_LANE && cz > 1) continue;
        const count = cx * cz, shape = Math.abs(Math.log((W / cx) / (D / cz)));           // 0 = square lanes
        const score = (n - count) * 10 + shape;
        if (!best || score < best.score) best = { cx, cz, score };
    }
    if (!best) return [{ x0: box.x0, x1: box.x1, z0: box.z0, z1: box.z1 }];
    const cut = (lo, len, k) => Array.from({ length: k }, (_, i) => [lo + Math.floor(len * i / k), lo + Math.floor(len * (i + 1) / k) - 1]);
    const out = [];
    for (const [xa, xb] of cut(box.x0, W, best.cx)) for (const [za, zb] of cut(box.z0, D, best.cz)) out.push({ x0: xa, x1: xb, z0: za, z1: zb });
    return out;
}

/**
 * The haul road: a one-block-wide staircase left standing, so a bot (or a replacement bot) can always walk down into the pit and out
 * again. Cell i keeps every block at y <= top - i; the dig volume above it is dug. The road runs once around the edge of the box
 * (east along the north edge, south along the east edge, west along the south edge, north along the west edge) and, when the pit is
 * deeper than that ring is long, on into the next ring one block further in, and so on: a spiral. A 16 x 16 box has room for 60 + 52 + 44
 * + ... = 256 cells, so it can go from y 62 down to bedrock (126 layers) without leaving the box; a ring ends one step from where the
 * next begins, so the descent is still one block at a time.
 */
function ringPath(x0, z0, x1, z1) {
    const path = [], w = x1 - x0 + 1, h = z1 - z0 + 1;
    for (let x = x0; x <= x1; x++) path.push([x, z0]);
    for (let z = z0 + 1; z <= z1; z++) path.push([x1, z]);
    if (h > 1) for (let x = x1 - 1; x >= x0; x--) path.push([x, z1]);
    if (w > 1) for (let z = z1 - 1; z > z0; z--) path.push([x0, z]);
    return path;
}
function planRoad(box, layers) {
    const { x0, z0, x1, z1, top } = box, path = [];
    for (let k = 0; x0 + k <= x1 - k && z0 + k <= z1 - k && path.length < layers; k++) path.push(...ringPath(x0 + k, z0 + k, x1 - k, z1 - k));
    if (layers > path.length) throw new Error(`pit ${layers} deep needs a haul road of ${layers} cells; the box has room for only ${path.length} (make the box wider, or dig less deep)`);
    const keep = new Map(), cells = [];
    for (let i = 0; i < layers; i++) { keep.set(`${path[i][0]},${path[i][1]}`, top - i); cells.push({ x: path[i][0], z: path[i][1], keepTo: top - i }); }
    return { keep, cells };
}

/**
 * The standing places of a region, middle first (the pioneers' method: start in the middle of the assigned range and dig everything
 * in reach, then move out in a fan; helpers start at the far end of this list). The range is cut into tiles of at most `tile` cells
 * per side; a place is the middle cell of its tile.
 */
function stationsOf(r, tile = TILE) {
    const cut = (lo, hi) => { const n = Math.ceil((hi - lo + 1) / tile), len = hi - lo + 1; return Array.from({ length: n }, (_, i) => [lo + Math.floor(len * i / n), lo + Math.floor(len * (i + 1) / n) - 1]); };
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, out = [];
    for (const [xa, xb] of cut(r.x0, r.x1)) for (const [za, zb] of cut(r.z0, r.z1)) out.push({ x: (xa + xb) >> 1, z: (za + zb) >> 1, x0: xa, x1: xb, z0: za, z1: zb });
    return out.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz) || a.x - b.x || a.z - b.z);
}

/** The cells of one unit (layer, row) in walking order (rows alternate direction), without the road's kept blocks. A sweep unit: the station's tile, the station cell first, then nearest first; `.station` is the cell to stand in. */
function unitCells(plan, region, u) {
    const { rows, meta } = region, layer = (u / rows) | 0, row = u % rows, y = meta.top - layer;
    if (meta.method === 'expert') {                                          // a band: the chunk's columns over `band` layers, top layer first
        const top = meta.top - meta.band * layer, out = [];
        for (let yy = top; yy > top - meta.band && yy >= meta.bottom; yy--) for (let x = meta.x0; x <= meta.x1; x++) for (let z = meta.z0; z <= meta.z1; z++) {
            const k = plan.road.keep.get(`${x},${z}`); if (k !== undefined && yy <= k) continue;
            out.push({ x, y: yy, z });
        }
        return out;
    }
    if (meta.method === 'sweep') {
        const st = meta.stations[row], kept = (x, z) => { const k = plan.road.keep.get(`${x},${z}`); return k !== undefined && y <= k; };
        const cells = [];
        for (let x = st.x0; x <= st.x1; x++) for (let z = st.z0; z <= st.z1; z++) if (!kept(x, z)) cells.push({ x, y, z, d: Math.hypot(x - st.x, z - st.z) });
        cells.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);
        const out = cells.map(({ x, y: yy, z }) => ({ x, y: yy, z }));
        out.station = out[0] ? { ...out[0] } : null;                      // a kept road cell as the middle: the nearest dug cell is the place to stand
        return out;
    }
    const z = meta.z0 + row, out = [];
    for (let x = meta.x0; x <= meta.x1; x++) {
        const keepTo = plan.road.keep.get(`${x},${z}`);
        if (keepTo !== undefined && y <= keepTo) continue;
        out.push({ x, y, z });
    }
    if (row % 2) out.reverse();
    return out;
}

const NAV_TRIPS = 3, NAV_TRIP_MS = 60000, NAV_UNIT_MS = 120000, CELL_MS = 60000, CANOPY_MS = 30000, UNIT_MS = 6 * 60000;          // NAV per unit at most (b081m: navS 363 s in one unit); a cell's retries end after CELL_MS          // per unit; one trip (bt075t5-7, units over 30 s: 39 trips, median 33 s, p90 81 s, max 221 s)
const reachFail = (m) => m && (m.reason === 'unreachable' || !!(m.detail && Array.isArray(m.detail.unmet) && m.detail.unmet.some((u) => u && u.need === 'in_reach')));
const RETRY = new Set(['not_visible', 'not_confirmed', 'stuck', 'unreachable', 'target_lost', 'timeout']);
const CELL_FAILS = new Set([...RETRY, 'invalid_target']);       // failures that belong to one cell: the rest of the tile can still be dug
const NEIGH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const isFluid = (w, x, y, z) => { const k = w.kindAt(x, y, z); return k === 'water' || k === 'liquid' || (k === 'danger' && /lava/.test(w.nameAt(x, y, z) || '')); };
const isSolid = (w, x, y, z) => w.kindAt(x, y, z) === 'solid';
/** A fluid cell with an open (air) neighbour other than `c`: its face can be seen and clicked from the pit. */
const exposed = (w, f, c) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, d]) => {
    const x = f.x + a, y = f.y + b, z = f.z + d;
    return !(x === c.x && y === c.y && z === c.z) && PASSABLE.has(w.kindAt(x, y, z));
});

/**
 * Fluid cells to fill before digging `cells` (one layer): the cell itself and its four horizontal neighbours when they hold
 * water or lava. This is the owner's water rule: fill the fluid that would flow into the cell the moment it opens (also water
 * from a neighbouring chunk), and fill fluid inside the volume so that it can be mined. Each fill needs a solid neighbour to be
 * placed against, so fills are ordered from the solid side outwards; `unsupported` are fluid cells with no way to start (an
 * open lake: the caller reports it). Pure; `w` is only read.
 */
function sealPlan(w, cells) {
    // Sources first, the cell itself last: with the neighbour filled the water in the cell drains by itself, and a block placed
    // into the cell first would hide the neighbour from the crosshair.
    const want = new Map();
    for (const c of cells) {
        for (const [dx, dz] of NEIGH4) if (isFluid(w, c.x + dx, c.y, c.z + dz)) want.set(`${c.x + dx},${c.y},${c.z + dz}`, { x: c.x + dx, y: c.y, z: c.z + dz });
    }
    for (const c of cells) if (isFluid(w, c.x, c.y, c.z)) { want.delete(`${c.x},${c.y},${c.z}`); want.set(`${c.x},${c.y},${c.z}`, { x: c.x, y: c.y, z: c.z }); }
    return orderFill(w, [...want.values()]);
}

/** Order fluid cells so that each is filled against something solid: below first, starting from the solid side; the rest cannot be started (an open lake). */
function orderFill(w, cells) {
    const todo = cells.slice(), order = [], filled = new Set();
    const solidNow = (x, y, z) => filled.has(`${x},${y},${z}`) || isSolid(w, x, y, z);
    for (let progress = true; todo.length && progress;) {
        progress = false;
        for (let i = 0; i < todo.length; i++) {
            const t = todo[i];
            // Below first: the block underneath is the most reliable face to click (the owner's lesson: build up from below).
            if ([[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([a, b, d]) => solidNow(t.x + a, t.y + b, t.z + d))) {
                order.push(t); filled.add(`${t.x},${t.y},${t.z}`); todo.splice(i--, 1); progress = true;
            }
        }
    }
    return { fill: order, unsupported: todo };
}

/**
 * Run one unit. `env`: exec(name, args) -> {ok, reason, detail}; w (world model); have(item) -> count in the inventory.
 * Idempotent: cells that are already open are skipped, so a unit abandoned half way (death, takeover) is simply run again.
 */
async function runUnit(plan, region, u, env) {
    const cells = unitCells(plan, region, u.unit), r = { mined: 0, sealed: 0, skipped: 0 }, expert = region.meta.method === 'expert', sweep = region.meta.method === 'sweep' || expert;
    // A sweep leaves the drops where they fall and picks everything up once at the end (a walk per block would cost more than the digging).
    // The expert method mines BLIND: its stations put every cell within the arm's reach, and the server checks only the distance (no walk to a place with a view, no step into a hole).
    // (a plant of a build site's pit is mined blind: mineflayer's crosshair takes only collision shapes, so a cell of grass was never "under the cursor" and the aim failed for good,
    // 'line_of_sight' after two fixes, bt075i w2; the server checks only the distance)
    const plantAt = (c) => plan.clearPlants && PASSABLE.has(env.w.kindAt(c.x, c.y, c.z)) && NOT_AIR(env.w, c);
    const mineArgs = (c) => (expert || plantAt(c) ? { x: c.x, y: c.y, z: c.z, collect: false, blind: true } : sweep ? { x: c.x, y: c.y, z: c.z, collect: false } : c);
    // the region's tree pass is running in another bot (it claimed the region's first unit, the others go on with theirs: several bots in one region, a build site's crew)
    const me = env.bot && env.bot.username, treeBusy = () => { const t = plan.trees && plan.trees.get(region.id); return !!(t && t.busy && t.by !== me); };
    const fail = (res, cell, stage) => ({ ok: false, reason: res.reason, detail: { ...(res.detail || {}), cell, block: env.w.nameAt ? env.w.nameAt(cell.x, cell.y, cell.z) : undefined, stage, ...r } });
    const open = (c) => openCell(plan, env.w, c);
    const leave = (c) => { if (plan.accepted) plan.accepted.add(`${c.x},${c.y},${c.z}`); };          // a block left on purpose (a fixture, a floating block): the layer check does not send the unit back for it
    // Fill what sealPlan lists. `before`: only fluid that can be seen now (a pocket sealed inside stone cannot be clicked, and it
    // cannot flow until the cell next to it opens: live run p4, a water cell in the wall next to the last stone); after the dig
    // the opened cell is the window onto it, so everything is filled then, the pocket first and the opened cell last.
    const liftedFor = new Set(), bridgedFor = new Set(), droppedFor = new Set(), navFor = new Set(), unitT0 = Date.now();
    // A cell the station cannot reach, whatever it holds (rock, any tree block, a snow layer, a block of the crew's own pillar): blind from where the bot stands when the eye is within
    // the server's reach (4.6), else NAV takes the bot within reach (walk, dig, pillar, bridge, descend, the block two below; owner ruling 2026-11-26) and the mine is tried again.
    // One trip per cell and NAV_TRIPS per unit: a unit with more such cells hands them back failed (the ledger gives the unit to the next round or bot) instead of working a whole
    // tree for minutes (081's b081k: six units ran six minutes). One root fix instead of a rule per tree shape (b081d oak canopy, b081h birch crown, b081i spruce to the snow).
    const eyeDist = (c) => { const h = env.here ? env.here() : null; return h ? Math.hypot(h.x + 0.5 - (c.x + 0.5), h.y + 1.62 - (c.y + 0.5), h.z + 0.5 - (c.z + 0.5)) : Infinity; };
    const navReach = async (c, m) => {
        if (open(c)) return m;
        if (eyeDist(c) <= 4.6) { r.blindReach = (r.blindReach || 0) + 1; const b = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false, blind: true }); if (b.ok || open(c)) return b; }
        const k = `${c.x},${c.y},${c.z}`;
        if (!env.nav || navFor.has(k) || (r.navReach || 0) >= NAV_TRIPS || (r.navMs || 0) >= NAV_UNIT_MS) return m;
        navFor.add(k); r.navReach = (r.navReach || 0) + 1;
        const t0 = Date.now();
        const g = await env.nav({ x: c.x, y: c.y, z: c.z }, { near: 2, nearY: 2, why: 'pit: within reach of a cell', deadline: Date.now() + NAV_TRIP_MS }).catch((e) => ({ ok: false, reason: 'internal', detail: { error: String(e && e.message || e) } }));
        r.navMs = (r.navMs || 0) + (Date.now() - t0);
        const ni = g && g.detail && g.detail.nav; if (ni) { r.navPlanCpu = (r.navPlanCpu || 0) + (ni.planCpuMs || 0); r.navPlan = (r.navPlan || 0) + (ni.planMs || 0); r.navMove = (r.navMove || 0) + (ni.moveMs || 0); r.navSweep = (r.navSweep || 0) + (ni.sweepMs || 0); r.navWait = (r.navWait || 0) + (ni.waitMs || 0); }
        if (g && FATAL_MINE.has(g.reason)) return g;
        const got = open(c) ? { ok: true } : await env.exec('mine', eyeDist(c) <= 4.6 ? { x: c.x, y: c.y, z: c.z, collect: false, blind: true } : mineArgs(c));
        if (got.ok || open(c)) await canopy();
        return got;
    };
    // Where a trip has brought the bot (in a canopy, on a pillar beside a crown), every tree block of the box within reach goes too, blind, whichever unit it belongs to: one trip
    // serves a cluster of leaves instead of one trip per unit (bt075t8-10: 140 trips, nearly all for one cell). Never a block under a bot (its own column below the feet, or the cell
    // under another bot), at most 48 per trip; the units find those cells open and go on.
    const canopy = async () => {
        const h = env.here ? env.here() : null, b = plan.box; if (!h || !b) return;
        const oth = (env.others ? env.others() : []).map((o) => ({ x: Math.floor(o.x), y: Math.floor(o.y), z: Math.floor(o.z) }));
        const cand = [];
        for (let dx = -4; dx <= 4; dx++) for (let dy = -3; dy <= 5; dy++) for (let dz = -4; dz <= 4; dz++) {
            const t = { x: h.x + dx, y: h.y + dy, z: h.z + dz };
            if (t.x < b.x0 || t.x > b.x1 || t.z < b.z0 || t.z > b.z1 || t.y > b.top || t.y < b.bottom) continue;
            if (!isTreeAt(env.w, t) || eyeDist(t) > 4.4) continue;
            if (dx === 0 && dz === 0 && dy < 0) continue;
            if (oth.some((o) => o.x === t.x && o.z === t.z && o.y - 1 === t.y)) continue;
            cand.push(t);
        }
        cand.sort((p, q) => q.y - p.y);              // from the top: nothing is cut from under a block still to come
        // CANOPY_MS at most, each mine with that deadline: the sweep counted into its cell's time and some jungle cells took 560-700 s (bt075w3, 1.21.1)
        const end = Date.now() + CANOPY_MS;
        for (const t of cand.slice(0, 48)) {
            if (Date.now() > end) { r.canopyCut = (r.canopyCut || 0) + 1; break; }
            if (!isTreeAt(env.w, t)) continue;
            const m = await env.exec('mine', { x: t.x, y: t.y, z: t.z, collect: false, blind: true }, { deadline: end });
            if (m && FATAL_MINE.has(m.reason)) return;
            if (m && m.ok) r.canopy = (r.canopy || 0) + 1;
        }
    };
    // time in cells (the rest of a unit is its walks to stations) and the slowest cell with what it held and how it ended, for the log of slow units (construct.js)
    const takeRoot = async (c) => { const root = bambooRoot(env.w, c); if (root && root.y < plan.box.bottom && eyeDist(root) <= 4.4) { const b = await env.exec('mine', { ...root, collect: false, blind: true }); if (b.ok) r.bambooRoots = (r.bambooRoots || 0) + 1; } };
    const noteCell = (c, t0, block, res) => { const ms = Date.now() - t0; r.cellMs = (r.cellMs || 0) + ms; if (!r.slowCell || ms > r.slowCell.ms) r.slowCell = { x: c.x, y: c.y, z: c.z, block, ms, end: res === null ? 'ok' : res === 'defer' ? 'defer' : (res && res.reason) || null, steps: Object.fromEntries(Object.entries(steps).filter(([, v]) => v >= 500).map(([k, v]) => [k, Math.round(v / 1000)])) }; };
    // A placement the bot cannot reach a face for (unreachable) or that ends in a swim it cannot get out of (stuck): the same walk is not tried again. The server puts the bot on a standable
    // cell beside the fluid cell, once per cell, and the placement is tried from there (a different approach); if that fails too, the failure goes up and the unit is parked.
    const placeAt = async (f, item) => {
        let p = await env.exec('place', { x: f.x, y: f.y, z: f.z, item, fluid: true, temp: 'seal' });
        // no face of it in sight from any stand cell (a water cell whose supports are behind the block the bot is about to dig, or under its own floor): a blind click on a support
        // face within reach from here; the server checks the reach, not the line (owner ruling 2026-11-26, under_probe 3/3). The stall of mine_b's watery chunks: 'seal: no standing
        // cell within reach of the target exists (inside rock)' parked unit after unit (mb075g w3, mb075f w2, mine_b-w121-a)
        if (!p.ok && ['unreachable', 'not_visible', 'stuck', 'precondition_failed'].includes(p.reason)) { const b = await env.exec('place', { x: f.x, y: f.y, z: f.z, item, fluid: true, temp: 'seal', blind: true }); if (b.ok) { r.sealBlind = (r.sealBlind || 0) + 1; p = b; } }
        const key = `p${f.x},${f.y},${f.z}`;
        if (!p.ok && (p.reason === 'unreachable' || p.reason === 'stuck') && env.lift && !liftedFor.has(key)) {
            liftedFor.add(key);
            const l = await env.lift(f, { radius: 4, up: 2, down: 1, skipSame: true });
            if (l.ok) { r.lifted = (r.lifted || 0) + 1; p = await env.exec('place', { x: f.x, y: f.y, z: f.z, item, fluid: true, temp: 'seal' }); }
        }
        return p;
    };
    const seal = async (c, before) => {
        const sp = sealPlan(env.w, [c]);
        const list = before ? sp.fill.filter((f) => (f.x === c.x && f.y === c.y && f.z === c.z) || exposed(env.w, f, c)) : sp.fill;
        const hidden = before ? sp.unsupported.filter((f) => exposed(env.w, f, c)) : sp.unsupported;
        if (hidden.length) return { ok: false, reason: 'invalid_target', detail: { why: 'fluid with nothing to seal it against', cells: hidden.slice(0, 4) } };
        for (const f of list) {
            let item = sealItem(env);
            // Nothing to seal with and nowhere to fetch it (`any` is insert-only): a block from the undug part of the pit beside the bot, as the pillar takes one (moves.js harvest).
            if (!item && env.run && env.within) { const hv = await env.run('harvest', { items: SEAL_ITEMS }); if (hv.ok && hv.detail && hv.detail.got) { r.harvested = (r.harvested || 0) + 1; item = sealItem(env); } }
            if (!item) return { ok: false, reason: 'missing_item', detail: { why: 'no block to seal water with', tried: SEAL_ITEMS } };
            const p = await placeAt(f, item);
            if (!p.ok) return p;
            r.sealed++;
        }
        return { ok: true, n: list.length };
    };
    // One cell. Returns null when it is open afterwards, or the failure. A cell whose water rule needs a block the bot does not have yet
    // (a bot with an empty inventory next to a shore) is not a failure of the unit: it is left for after the row, when digging has
    // brought dirt or cobblestone.
    // A body of water met by the dig is filled as a whole before the cell is dug (pit_lake.js: the coffer-dam; the per-cell rule below cannot reach into a lake). Once per fluid cell and unit;
    // when it cannot finish (no standing place, no blocks) the per-cell rule goes on as before. PIT_LAKE=0 turns it off (A/B runs).
    const lakeSeen = new Set(), layered = process.env.PIT_LAKE_MODE !== 'body';
    const lakeStats = () => r.lake || (r.lake = { calls: 0, filled: 0, stations: 0, ms: 0, left: 0, floors: 0 });
    const lakeOwn = (res) => { const owned = plan.lakeFilled || (plan.lakeFilled = new Set()); for (const q of res.placed || []) owned.add(`${q.x},${q.y},${q.z}`); };          // the job's end takes away what is still ours (cleanup)
    const lakeFill = async (c) => {
        if (process.env.PIT_LAKE === '0' || !env.here || !env.exec) return;
        const sp = sealPlan(env.w, [c]), seeds = [...sp.fill, ...sp.unsupported].filter((f) => !lakeSeen.has(`${f.x},${f.y},${f.z}`));
        if (!seeds.length) return;
        for (const f of seeds) lakeSeen.add(`${f.x},${f.y},${f.z}`);
        // Layered rule (owner 2026-11-17): only the level being dug and the floor under it are replaced, over the whole extent of the water (the platform grows from the shore), however deep the water goes;
        // what lies deeper is met when its layer is the floor (floorFill). PIT_LAKE_MODE=body: the old whole-body fill (A/B).
        const t0 = Date.now(), res = await require('./pit_lake').fillLake({ env, plan, isFluid, sealItem, items: SEAL_ITEMS, slab: layered ? { lo: c.y - 1, hi: c.y } : null, goToStation: (S) => goToStation(S, handle, env, open, r) }, seeds);
        const L = lakeStats();
        L.calls++; L.filled += res.filled; L.stations += res.stations; L.ms += Date.now() - t0; L.left = res.left; if (!res.ok) L.reason = res.reason;
        lakeOwn(res);
    };
    // The floor rule (owner 2026-11-17): the block under a cell that was just opened is what the bot will stand on when this layer is the one it digs. Water there is replaced by a temporary block (`lake`)
    // against a neighbour (the shore, or a block placed before it), seen through the hole the dig has just made. A floor cell that cannot be done yet (no neighbour to place against, no line to it)
    // is kept in plan.floorPending and tried again after each next opened cell nearby; the next layer digs the blocks together with the rest.
    let floorBusy = false;                                   // a fill's own walk can dig a corridor cell, which would start a fill inside the fill
    const floorFill = async (c) => {
        if (floorBusy || process.env.PIT_LAKE === '0' || !layered || !env.here || !env.exec || process.env.PIT_FLOOR === '0') return;
        const y = c.y - 1; if (y < plan.box.bottom) return;
        const pend = plan.floorPending || (plan.floorPending = new Map()), seeds = [];
        if (isFluid(env.w, c.x, y, c.z)) seeds.push({ x: c.x, y, z: c.z }); else pend.delete(`${c.x},${y},${c.z}`);
        for (const [k, q] of pend) {
            if (seeds.length >= 12) break;
            if (!isFluid(env.w, q.x, q.y, q.z)) { if (env.w.kindAt(q.x, q.y, q.z) !== 'unknown') pend.delete(k); continue; }
            if (q.y === y && Math.hypot(q.x - c.x, q.z - c.z) <= 6 && !seeds.some((s) => s.x === q.x && s.z === q.z)) seeds.push(q);
        }
        if (!seeds.length) return;
        floorBusy = true;
        try {
        const t0 = Date.now(), res = await require('./pit_lake').fillLake({ env, plan, isFluid, sealItem, items: SEAL_ITEMS, exact: true, slab: { lo: y, hi: y }, rounds: 10, goToStation: (S) => goToStation(S, handle, env, open, r) }, seeds);
        const L = lakeStats();
        L.floors += res.filled; L.filled += res.filled; L.stations += res.stations; L.ms += Date.now() - t0; if (!res.ok && res.reason) L.floorReason = res.reason;
        lakeOwn(res);
        for (const q of seeds) { const k = `${q.x},${q.y},${q.z}`; if (isFluid(env.w, q.x, q.y, q.z)) { if (pend.size < 600) pend.set(k, q); } else pend.delete(k); }
        r.floorLeft = seeds.filter((q) => isFluid(env.w, q.x, q.y, q.z)).length;
        } finally { floorBusy = false; }
    };
    // where a cell's time goes (the slow-unit log): each step of handleCell by name, in ms (bt075w3 jungle: cells of 547-698 s with no NAV trip at all, cause not visible)
    let steps = {};
    const timed = async (k, p) => { const t = Date.now(); try { return await p; } finally { steps[k] = (steps[k] || 0) + Date.now() - t; } };
    const handleCell = async (c, last) => {
        // the region's tree pass is running (another bot): its tree blocks are its, the unit leaves them (the layer check sends the unit back if one is still there afterwards)
        if (treeBusy() && isTreeAt(env.w, c)) { r.skipped++; r.treeWait = (r.treeWait || 0) + 1; return null; }
        await timed('lake', lakeFill(c));
        let s = await timed('seal', seal(c, true));
        if (!s.ok) return s.reason === 'missing_item' && !last ? 'defer' : fail(s, c, 'seal');
        if (open(c)) { r.skipped++; return null; }
        // The block the bot stands on, with nothing solid within three cells under it: breaking it drops the bot into the open pit (86 blocks, dead; live pit 2026-11-07, a lone
        // cobblestone pillar at layer 30 killed a bot four times). Left in place: nothing can be done about it from the side, and a floating block hurts nobody.
        if (standsOnFloater(env, c)) { r.skipped++; r.floating = (r.floating || 0) + 1; leave(c); return null; }
        // Success is what the world shows: a `mine` that ended in the drop pickup (target_lost: the item was picked up by another
        // bot or despawned) has still opened the cell. Transient reasons (another bot in the crosshair, a slipped aim) get retries.
        const c0 = Date.now();
        // Bamboo: the stalk is broken at its lowest block, below the box too (bamboo grows back from its root: 95 bamboo blocks stood in the dug jungle pit bt075v3, 1.21.1;
        // breaking the lowest block takes the whole stalk and leaves nothing to grow), blind when in reach; otherwise the cell as usual and the root at the bottom layer
        if (isBamboo(env.w, c)) { const root = bambooRoot(env.w, c); if (root && eyeDist(root) <= 4.4) { const b = await env.exec('mine', { ...root, collect: false, blind: true }); if (b.ok) r.bambooRoots = (r.bambooRoots || 0) + 1; if (open(c)) { r.mined++; return null; } } }
        // A tree block (leaf, vine, log) within the server's reach: blind at once. The aimed mine wants a face in sight, which a leaf in a crown or a vine (no collision box) often has not;
        // its retries took minutes per cell (b081m, 1.21.1: oak_leaves 627 s, a vine 373 s in one cell, no NAV trip)
        let m = isTreeAt(env.w, c) && eyeDist(c) <= 4.4 ? await timed('blindTree', env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false, blind: true })) : { ok: false, reason: 'not_tried' };
        if (m.ok || open(c)) { r.blindTree = (r.blindTree || 0) + 1; } else m = await timed('mine', env.exec('mine', mineArgs(c), { deadline: c0 + CELL_MS }));
        // Out of reach from the station (unmet in_reach, 'unreachable'): no retry ladder (six tries with recoveries changed nothing and cost minutes per cell in a tree, 081's b081k);
        // blind when the eye is within the server's reach, else one NAV trip within reach (navReach below)
        if (!m.ok && !open(c) && reachFail(m)) m = await timed('navReach', navReach(c, m));
        // A few seconds between attempts (something in the way moves on, the server catches up), and a small fix before each one:
        // jump, sidestep, go back to where the bot last worked (env.recover; the worker's ladder).
        // Retrying a cell nobody can reach changes nothing: one more look for 'unreachable', then the unit fails and is tried again later (repair passes).
        for (let tries = 0; !m.ok && !open(c) && tries < (m.reason === 'unreachable' || reachFail(m) ? 1 : 6) && RETRY.has(m.reason) && Date.now() - c0 < CELL_MS; tries++) { if (env.recover) await timed('recover', env.recover(Math.min(tries + 2, 4), m)); await timed('pause', env.pause ? env.pause(10 + 10 * tries) : null); m = await timed('retry', env.exec('mine', mineArgs(c), { deadline: Math.max(c0 + CELL_MS, Date.now() + 15000) })); }
        // The bot stands on the block (the `mine` command never stands above its target; on a one-block pillar there is no other cell): dig it from where it stands, blind. It drops one
        // block onto the pillar below (the floor check above guarantees there is one within three cells). Live pit 2026-11-07: bots walked between the rim and such pillars for an hour.
        // The same when the block is anywhere within the server's reach (about 5 blocks from the eye; the server checks the distance, not the line of sight): a cell in a one-wide shaft
        // whose neighbours are not dug (parked units above it) has no standing place with a view of it, but the pick reaches. 76 of 148 failures in 5 min were `reach block`
        // at a distance of 0.5 to 3 blocks (live pit 2026-11-09).
        if (!m.ok && !open(c) && m.reason === 'unreachable' && env.here) { const h = env.here(), d = Math.hypot(h.x - c.x, h.y + 1.62 - (c.y + 0.5), h.z - c.z); if (d <= 4.6) { r.blind = (r.blind || 0) + 1; m = await env.exec('mine', { ...mineArgs(c), blind: true }); } }
        // Nothing to walk on from where the bot stands (a one-block pillar over a void: the search expands a single node) and the block is out of reach: the server puts
        // the bot on a standable cell next to the block (env.lift), once per cell. Live pit 2026-11-07: two bots stood on leftover pillars and failed 'unreachable' for good.
        if (!m.ok && !open(c) && m.reason === 'unreachable' && env.lift && !liftedFor.has(`${c.x},${c.y},${c.z}`)) {
            liftedFor.add(`${c.x},${c.y},${c.z}`);
            const l = await env.lift(c, { skipSame: true });
            if (l.ok) { r.lifted = (r.lifted || 0) + 1; m = await env.exec('mine', mineArgs(c)); }
        }
        // A block out of reach across a gap in the bot's own layer (a ledge or a column that the dig around it left: the floor between the bot and it is dug away, or the bot stands on a lone
        // column): no walk, lift or pillar gets there, a level bridge does (bot/bridge.js, one block under each next cell, up to the block). Not decided by `gapOn`: that only sees a void down to the
        // world's floor, and a dug pit has rock far below. Within 14 blocks and two levels, once per cell. Live 2026-11-10: 383 of 854 problems in 15 min were `mine: reach block` 6-9 blocks over such a gap.
        if (!m.ok && !open(c) && m.reason === 'unreachable' && env.bridgeToward && env.here && !bridgedFor.has(`${c.x},${c.y},${c.z}`)) {
            const h = env.here(), dist = Math.hypot(h.x - c.x, h.z - c.z), dy = c.y - h.y;
            if (dist > 3 && dist <= 14 && dy >= -2 && dy <= 2) {
                bridgedFor.add(`${c.x},${c.y},${c.z}`);
                const br = await env.bridgeToward({ x: c.x, z: c.z });
                if (br.ok) { r.bridged = (r.bridged || 0) + br.placed; m = await env.exec('mine', mineArgs(c)); }
            }
        }
        // The block lies 3 or more levels below the bot, within a few blocks across, and nothing can be walked to it: the bot stands high on a leftover block or column ("no way down, no place to bridge to",
        // and then it was killed). It goes down the way it came up, reversed (moves.js `descend`: a block put blind under the block it stands on, that one broken, one level at a time, no fall longer
        // than a block, no block lost), to the block's level, then the mine is tried again. Never with fluid or an unloaded cell below (descendStep); once per cell. Natural ground is not dug through:
        // only when there are two cells of air under the block it stands on (isHigh).
        if (!m.ok && !open(c) && m.reason === 'unreachable' && env.run && env.here && !droppedFor.has(`${c.x},${c.y},${c.z}`)) {
            const h = env.here(), dy = c.y - h.y;
            if (dy <= -3 && Math.hypot(h.x - c.x, h.z - c.z) <= 6 && isHigh((x, y, z) => env.w.kindAt(x, y, z), h)) {
                droppedFor.add(`${c.x},${c.y},${c.z}`);
                const d = await env.run('descend', { levels: Math.min(80, h.y - c.y) });
                const got = (d.detail && d.detail.levels) || 0;
                if (got) { r.descended = (r.descended || 0) + got; m = await env.exec('mine', mineArgs(c)); }
            }
        }
        if (!m.ok && !open(c) && !FATAL_MINE.has(m.reason) && m.reason !== 'protected') m = await timed('navLast', navReach(c, m));
        if (!m.ok && m.reason === 'protected') { r.skipped++; r.protected = (r.protected || 0) + 1; leave(c); return null; }       // the owner's chest or a tagged block inside the box: left standing (src/skills/fixtures.js)
        if (!m.ok && !open(c)) return fail(m, c, 'mine');
        r.mined++;
        // Water that was behind the block is now flowing in. Fill its source, then the cell; if the cell was plugged, dig it again.
        for (let round = 0; round < 3; round++) {
            s = await seal(c, false);
            if (!s.ok) return s.reason === 'missing_item' && !last ? 'defer' : fail(s, c, 'seal_after');
            if (!s.n && open(c)) break;
            if (!open(c) && env.w.kindAt(c.x, c.y, c.z) === 'solid') {          // a plug; water still running in is filled by the next round
                const m2 = await env.exec('mine', mineArgs(c));
                if (!m2.ok && !open(c)) return fail(m2, c, 'unplug');
            }
        }
        if (!open(c)) return fail({ reason: 'not_confirmed', detail: { why: 'cell keeps filling' } }, c, 'seal_after');
        return null;
    };
    // One cell: the dig with the water rule, then the floor under it (a cell that is open now and has water under it gets its floor block).
    const handle = async (c, last) => {
        // a unit's cells end after UNIT_MS, whatever the method (the expert's stations have the same bound): the rest goes back with the unit (bt075w4, bamboo jungle, 1.21.1: one sweep
        // unit ran 15 min, 081's stall cap ended the pit with 109 units pending)
        if (Date.now() - unitT0 > UNIT_MS && !open(c)) return { ok: false, reason: 'timeout', detail: { why: `the unit's cells took more than ${UNIT_MS / 60000} min`, stage: 'unit', cell: c, ...r } };
        const t0 = Date.now(), b0 = env.w.nameAt ? env.w.nameAt(c.x, c.y, c.z) : null;
        steps = {};
        const res = await handleCell(c, last);
        if (res === null && /^bamboo/.test(String(b0 || '').replace(/^minecraft:/, '')) && c.y === plan.box.bottom) await takeRoot(c).catch(() => { /* the end's sweep looks again */ });          // (the root under the box's bottom)
        if (res === null && open(c)) await timed('floor', floorFill(c).catch(() => { /* a floor that cannot be laid now is tried again at the next cell */ }));
        noteCell(c, t0, b0, res); return res;
    };
    const deferred = [];
    // Tree pass (pit_trees.js, owner 2026-11-16): once per region, before its first unit digs, the tree blocks of the box are taken down (low ones from the ground, aerial ones from a pillar
    // beside them). One bot does it; the others do not wait (a unit never depends on it). PIT_TREES=0 turns it off (A/B runs).
    if (process.env.PIT_TREES !== '0' && env.run && env.here && env.exec) {
        const reg = plan.trees || (plan.trees = new Map()), prev = reg.get(region.id);
        // (again when units have left tree blocks to it since its last run: up to TREE_PASSES per region)
        if (!prev || (prev.done && prev.again && (prev.n || 1) < TREE_PASSES)) {
            reg.set(region.id, { busy: true, by: me, n: (prev && prev.n || 0) + 1 });
            try {
                const m = region.meta, tr = await require('./pit_trees').clearTrees(env, { x0: m.x0, x1: m.x1, z0: m.z0, z1: m.z1, top: m.top });
                // a block the pass could not take is no longer the pass's: a unit takes it, or fails visibly (never left between the two: 081's b081h)
                const tf = plan.treeFailed || (plan.treeFailed = new Set()); for (const f of tr.failed || []) tf.add(`${f.x},${f.y},${f.z}`);
                reg.set(region.id, { done: true, n: reg.get(region.id).n }); r.trees = { mined: tr.mined, risen: tr.risen, columns: tr.columns, left: tr.left, failed: tr.failed.length, ms: tr.ms };
                if (!tr.ok && tr.reason && ['died', 'disconnected', 'cancelled'].includes(tr.reason)) { reg.delete(region.id); return { ok: false, reason: tr.reason, detail: { stage: 'trees', ...r } }; }
            } catch (e) { reg.set(region.id, { done: true, error: String(e && e.message || e) }); }
        }
    }
    // Nothing to dig here (only open air, unbreakable blocks and tree blocks out of reach): done, and the bot does not walk anywhere. Walking to the station
    // of such a tile sent bots up the canopy of a tree (the planner takes the nearest reachable cell to a station in mid-air: live pit of 2026-11-07).
    if (cells.every((c) => open(c) || UNBREAKABLE.test(env.w.nameAt(c.x, c.y, c.z) || '') || (isSolid(env.w, c.x, c.y, c.z) && treeBusy() && isTreeAt(env.w, c)))) {
        r.skipped += cells.length; r.idle = true;
        return { ok: true, reason: null, detail: r };
    }
    if (expert) return require('./pit_expert').runExpert({ plan, region, unit: u.unit, env, r, cells, handle, open, goToStation: (S) => goToStation(S, handle, env, open, r), sweepDrops, UNBREAKABLE, aerialTree: (c) => treeBusy() && isTreeAt(env.w, c), CELL_FAILS, EXPERT_BAND });
    if (sweep && cells.station && env.here) {
        const g = await goToStation(cells.station, handle, env, open, r);
        if (g) return g;
    }
    // A cell that cannot be done (unreachable, a fluid with nothing to seal it against ...) does not stop the others: the rest of the tile is dug, and only then the unit fails with the first
    // failure. Retried later, the unit finds everything else open and spends its time on the one cell that is wrong, not on all of them again. Two failed cells end the unit at once
    // (the bot is probably somewhere it cannot work), and so does anything that is not about the cell (died, cancelled, a missing tool or item).
    const failures = [];
    for (const c of cells) {
        if (UNBREAKABLE.test(env.w.nameAt(c.x, c.y, c.z) || '')) { r.skipped++; continue; }         // bedrock at the bottom of the world
        const res = await handle(c, false);
        if (res === 'defer') { deferred.push(c); r.deferred = (r.deferred || 0) + 1; continue; }
        if (res) { if (!CELL_FAILS.has(res.reason) || failures.length >= 1) return failures[0] || res; failures.push(res); r.failedCells = failures.length; continue; }
        // The middle cell is open: step down into it, so that the whole tile is within an arm's length (a failed step only costs reach).
        if (sweep && env.here && cells.station && c.x === cells.station.x && c.z === cells.station.z && open(c)) {
            // Never step into a hole with nothing under it (the bottom layer of an End island, a gap: owner 2026-11-09). The tile is dug from where the bot stands; work that cannot be
            // reached from there is the business of `bridge` (bot/bridge.js), not of a step into the void.
            if (abyss.over(env.w, c, env.profile ? env.profile().minY : -64)) { r.abyss = (r.abyss || 0) + 1; continue; }
            const h = env.here(); if (h.x !== c.x || h.y !== c.y || h.z !== c.z) { await env.exec('move_to', c); r.stepped = (r.stepped || 0) + 1; }
        }
    }
    for (const c of deferred) { const res = await handle(c, true); if (res) { if (failures.length) return failures[0]; return res; } }
    if (failures.length) return { ...failures[0], detail: { ...failures[0].detail, failedCells: failures.length, mined: r.mined } };
    if (sweep && env.items && r.mined) { const sd = await sweepDrops(env, cells.station || cells[0]); r.picked = sd.picked; r.seen = sd.seen; if (sd.fail) r.pickFail = sd.fail; }
    return { ok: true, reason: null, detail: r };
}

/** The cells from `from` toward `to` on one layer, along x first, then z (the way a person would dig a corridor), `to` last. */
function lineCells(from, to, y) {
    const out = []; let x = from.x, z = from.z;
    while (x !== to.x) { x += Math.sign(to.x - x); out.push({ x, y, z }); }
    while (z !== to.z) { z += Math.sign(to.z - z); out.push({ x, y, z }); }
    return out;
}

/**
 * Stand in the middle of the tile. The station cell is open when the layer above was dug and this one is entered from above; when
 * the bot comes from another station the cells in between may still be solid: dig the first closed cell on the way and try again.
 * Returns null when the bot stands there (or cannot be brought closer: the sweep then works from where it is), or a failure.
 */
async function goToStation(S, handle, env, open, r) {
    let rejoins = 0, routed = 0;                     // a bot far from the station (it respawned at the world spawn) is sent back first, at most twice
    let launches = 0;                    // one search for a better place to bridge from (a platform above the bot's base)
    let edges = 0;                       // walks to the edge of a gap (a base beside the void), at most two
    let bridges = 0;                     // at most three bridges per walk to a station (a gap of void between the End's platform and the island is crossed by a level bridge, bot/bridge.js)
    let descents = 0;                    // at most two descents per walk to a station (moves.js `descend`)
    let lifts = 0;                       // at most two server lifts per walk to a station: a lift that lands in the same cell again changes nothing (live: Work17 lifted 0 blocks every 20 s)
    let walks = 0;                       // learned walks to the exact station cell (void dimensions), at most two
    let navs = 0;                        // NAV trips to the station when the walk on foot cannot get there, at most one
    for (let t = 0; t < 10; t++) {
        // What a rise left behind (the last pillar block) is taken away as soon as the bot has stepped off it, not at the next unit (owner 2026-11-11: "prevent forgetting to destroy scaffolding").
        if (r.rose && env.temp && env.temp.size) { try { await require('../bot/moves').cleanTemp(env); } catch (_) { /* tried again at the next unit */ } }
        const here = env.here();
        if (here.x === S.x && here.y === S.y && here.z === S.z) return null;
        // In another dimension than the job's (it respawned): the station's coordinates are not this dimension's. No walk, no corridor, nothing is charged to the unit (worker.js ends the worker).
        if (env.wrongDim && env.wrongDim()) return { ok: false, reason: 'wrong_dimension', detail: { why: 'the bot is not in the dimension of the job', botSide: true, stage: 'dimension', cell: S, ...r } };
        // Far away, or the station's chunk is not in the bot's world: no lift, walk or corridor can work from here. The server puts the bot beside the job (env.rejoin); where that is not
        // possible the unit fails at once as the bot's own trouble (never a corridor of 180 blocks toward a station nobody can see).
        const far = Math.hypot(here.x - S.x, here.z - S.z) > 64 || env.w.kindAt(S.x, S.y, S.z) === 'unknown';
        if (far && env.rejoin) {
            if (rejoins >= 2) return { ok: false, reason: 'unreachable', detail: { why: 'still far from the station after being sent back', botSide: true, stage: 'rejoin', cell: S, ...r } };
            rejoins++;
            let j = await env.rejoin(S);
            // Server moves are off (setting teleport): the bot walks to the station's surroundings in legs instead (bot/travel.js), then the usual walk / pillar / corridor takes over.
            if (!j.ok && j.reason === 'refused' && env.travel) { const t = await env.travel({ x: S.x, z: S.z }, { near: 12 }); j = t.ok ? { ok: true } : { ok: false, reason: t.reason, detail: { ...(t.detail || {}), why: `walking back to the job failed: ${(t.detail && t.detail.why) || t.reason}` } }; }
            if (!j.ok) return { ok: false, reason: j.reason || 'unreachable', detail: { ...(j.detail || {}), botSide: true, stage: 'rejoin', cell: S, ...r } };
            r.rejoined = (r.rejoined || 0) + 1; continue;
        }
        // Over a void (the End) the learned walk (env.travel -> move3: bridge, pillar, descend and dig, one cell at a time) takes the bot to the exact station cell. The ladder below bridges only on the
        // bot's own level, only from more than 3 blocks away and in one x-then-z line; measured on the copy of the play world (scripts/real) the learned walk reached 13 of 16 random pit cells from
        // the platform while the ladder reached none ("could not stand at the station", 1-3 blocks short of it on its own bridge). The ladder stays as the fallback.
        if (env.travel && walks < 2 && env.profile && env.profile().voidBelow && Math.hypot(here.x - S.x, here.z - S.z) + Math.abs(here.y - S.y) > 0) {
            walks++;
            const q = await env.travel({ x: S.x, y: S.y, z: S.z }, { near: 0, nearY: 0 });
            if (q.ok) { r.walked3 = (r.walked3 || 0) + 1; continue; }
            if (['died', 'disconnected', 'cancelled', 'wrong_dimension'].includes(q.reason)) return { ok: false, reason: q.reason, detail: { ...(q.detail || {}), botSide: true, stage: 'walk', cell: S, ...r } };
            r.walkFail = q.reason;
            (r.walkFails = r.walkFails || []).length < 6 && r.walkFails.push({ reason: q.reason, from: here, to: { x: S.x, y: S.y, z: S.z }, at: env.here(), pack: env.have ? ['cobblestone', 'end_stone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone'].reduce((n, b) => n + (env.have(b) || 0), 0) : undefined, why: String((q.detail && (q.detail.why || q.detail.goal)) || '').slice(0, 80), m3: q.detail && q.detail.move3 ? q.detail.move3 : (q.move3 ? { decisions: q.move3.decisions, fails: q.move3.fails } : undefined), vn: q.detail && q.detail.voidnav ? q.detail.voidnav : (q.voidnav ? { reason: q.reason, ...q.voidnav } : undefined) });
        }
        // A gap of void toward the station (the End: the obsidian platform and the island are 20-40 blocks apart): no walk, lift or pillar crosses it, a level bridge does. Rising by pillar beside the
        // platform only put the bot on a tower over the void, out of reach of the station and of its own temporary blocks (live 2026-11-10).
        const gap = env.bridgeToward && env.gapOn && bridges + edges < 4 && Math.hypot(here.x - S.x, here.z - S.z) > 3 ? env.gapOn(S) : null;
        if (!gap && env.bridgeToward && env.launchCells && launches < 1 && env.profile && env.profile().voidBelow && Math.hypot(here.x - S.x, here.z - S.z) > 24) {         // blocked at the bot's own level (a base under the platform): the platform is the place to bridge from
            launches++;
            const lcs = env.launchCells(S); r.launchTried = lcs.length ? lcs.map((c) => `${c.x} ${c.y} ${c.z}`).join(', ') : 'none';
            let went = false;
            for (const lc of lcs) { const m = await env.exec('move_to', lc, { maxTicks: STATION_TICKS }); if (m.ok) { went = true; r.launched = (r.launched || 0) + 1; break; } }
            if (went) continue;
        }
        if (gap && !gap.atEdge && edges < 2) {            // standing on a base beside the void: walk to its edge first
            edges++;
            const m = await env.exec('move_to', { x: gap.edge.x, y: here.y, z: gap.edge.z }, { maxTicks: STATION_TICKS });
            if (m.ok) continue;
            return { ok: false, reason: m.reason || 'unreachable', detail: { ...(m.detail || {}), botSide: true, stage: 'gap_edge', cell: S, ...r } };
        }
        if (gap && gap.atEdge && bridges < 3) {
            bridges++;
            const b = await env.bridgeToward(S, { road: true });          // the way from the platform to the work is shared: it stays (a road), the in-layer bridges of `handle` do not
            if (b.ok) { r.bridged = (r.bridged || 0) + b.placed; continue; }
            return { ok: false, reason: b.reason || 'unreachable', detail: { ...(b.detail || {}), botSide: true, stage: 'gap', cell: S, ...r } };
        }
        const above = S.y - here.y, floor = [1, 2, 3].some((d) => isSolid(env.w, S.x, S.y - d, S.z));
        // No floor within three cells below an open station, and not far above the bot: nobody can stand there (a tile above the ground); work from where the bot is.
        if (open(S) && !floor && above < 3) return null;
        // Far above or below the bot (three levels or more) and no walk there: the server puts the bot on a standable cell at the station's layer (env.lift). A floating
        // pillar block cannot be climbed down and a shaft not walked up; live pit 2026-11-07, three bots stood on their own pillars 20 levels above their units.
        // Also when the station is far to the side (more than 24 blocks: a bot that respawned at the world spawn): a long walk through jungle, with vines the planner climbs, killed bots.
        if (env.lift && lifts < 2 && (Math.abs(above) >= 3 || Math.hypot(here.x - S.x, here.z - S.z) > 24)) {
            lifts++;
            const l = await env.lift(S, { skipSame: true });
            if (l.ok) { r.lifted = (r.lifted || 0) + 1; continue; }
            r.liftFail = l.reason;
        }
        // A walk to the station comes after the lift, never before: from the surface the planner walked 30 levels down the pit wall (vines, drops) and bots died of the fall
        // (live pit 2026-11-07, after a restart brought the bots up to the surface first).
        if (open(S) && floor) {
            const m = await env.exec('move_to', S, { maxTicks: STATION_TICKS });
            if (m.ok) return null;
            r.moveFail = `${m.reason}${m.detail && (m.detail.why || m.detail.goal) ? ` (${String(m.detail.why || m.detail.goal).slice(0, 60)})` : ''}`;
            // The walk goes on foot only (no dig, no block placed). NAV, the one mover that digs, pillars, descends and bridges, takes the bot there when it cannot: once per walk to a
            // station, bounded like the pit's other trips. Without it a bot boxed in by the leaves of a tree it had half taken down (fg075h, seed 474407178230372896, 1.21.1: 'unreachable
            // (cell 13,67,7)' from 11,67,9, two cells away) failed every station of the unit and the layer ('could not stand at the station', 13-14 per run with the guard on or off).
            if (env.nav && navs < 1 && !FATAL_MINE.has(m.reason)) {
                navs++;
                const t0 = Date.now(), g = await env.nav({ x: S.x, y: S.y, z: S.z }, { near: 0, nearY: 0, why: 'pit: to the station', deadline: Date.now() + NAV_TRIP_MS }).catch((e) => ({ ok: false, reason: 'internal', detail: { error: String(e && e.message || e) } }));
                r.navMs = (r.navMs || 0) + (Date.now() - t0); r.navStation = (r.navStation || 0) + 1;
                if (g && FATAL_MINE.has(g.reason)) return { ok: false, reason: g.reason, detail: { ...(g.detail || {}), botSide: true, stage: 'station_nav', cell: S, ...r } };
                if (g && g.ok) continue;
                r.navFail = `${g && g.reason}${g && g.detail && g.detail.why ? ` (${String(g.detail.why).slice(0, 60)})` : ''}`;
            }
        }
        // The station is three or more levels above the bot and there is no way up on foot (a shaft, a cave under a layer that is still closed): rise by pillar,
        // breaking what is overhead (by hand if no tool fits), and dig the corridor to the station from that layer. Live pit 2026-11-07: four bots stood under an
        // undug slab, 5-26 levels below their units, and failed 'unreachable' for ten minutes. Another bot in the same cell blocks the first block: sidestep, again.
        if (env.run && above >= 3 && Math.hypot(here.x - S.x, here.z - S.z) <= 24) {          // a station above the bot's own column (an undug slab), not one across 24 blocks or more of anything
            if (env.crowded && env.crowded()) { if (env.stepAside) await env.stepAside(); else if (env.recover) await env.recover(3); }
            let p = await env.run('pillar', { levels: S.y - env.here().y });
            if (!p.ok && (p.reason === 'not_confirmed' || (p.detail && p.detail.crowded)) && (env.stepAside || env.recover)) { if (env.stepAside) await env.stepAside(); else await env.recover(3); p = await env.run('pillar', { levels: Math.max(1, S.y - env.here().y) }); }
            const last = p.detail && p.detail.last; if (last && env.temp) env.temp.set(`${last.x},${last.y},${last.z}`, last);
            r.rose = (r.rose || 0) + ((p.detail && p.detail.levels) || 0);
            if (!p.ok) return { ok: false, reason: p.reason, detail: { ...(p.detail || {}), cell: S, stage: 'rise', ...r } };
            continue;
        }
        // The station is three or more levels BELOW the bot, which stands high (air under its block): down the column the way the pillar goes up (moves.js `descend`), then the walk or the corridor on
        // the station's own level. Twice per walk.
        if (env.run && above <= -3 && descents < 2 && Math.hypot(here.x - S.x, here.z - S.z) <= 24 && isHigh((x, y, z) => env.w.kindAt(x, y, z), here)) {
            descents++;
            const d = await env.run('descend', { levels: Math.min(80, here.y - S.y) });
            const got = (d.detail && d.detail.levels) || 0;
            r.descended = (r.descended || 0) + got;
            if (got) continue;
            r.descendFail = d.reason;
        }
        if (env.rejoin && (Math.hypot(here.x - S.x, here.z - S.z) > 24 || Math.abs(above) > 24)) {
            // Last resort before giving up (the commonest pit failure of 2026-11-09/10, 1,800 records): the chunk-exit router walks toward the station's column and level (the haul road, round what the
            // planner's own search cannot cross); once, and only on foot.
            if (env.travel && routed < 2) {
                // The exact cell first (a bot that fell out of the pit through a cave: from (29,-16) at y 68 the exact cell was walked in 14 s on 2026-11-16, 3 tries of the level form failed), then the column near its level.
                routed++; const t = routed === 1 ? await env.travel({ x: S.x, y: S.y, z: S.z }, { near: 2 }) : await env.travel({ x: S.x, z: S.z, level: S.y }, { near: 8, nearY: 6 });
                if (t.ok) { r.routed = (r.routed || 0) + 1; continue; } r.routeFail = `${r.routeFail ? r.routeFail + ',' : ''}${t.reason}${t.detail && t.detail.why ? ` (${String(t.detail.why).slice(0, 70)})` : ''}`;          // (the why: bt075t10's 'stuck' beside the bed, unexplained)
            }
            return { ok: false, reason: 'unreachable', detail: { why: `too far from the station to dig a corridor toward it${r.launchTried ? ` (launch cell: ${r.launchTried})` : ''}`, botSide: true, stage: 'station', cell: S, at: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, ...r } };
        }
        const next = lineCells(here, S, S.y).find((c) => !open(c) && !UNBREAKABLE.test(env.w.nameAt(c.x, c.y, c.z) || ''));
        if (!next) return null;
        // A corridor is dug inside the pit only (owner 2026-11-11: a bot mined the obsidian platform at the End entrance, and blocks outside the pit "where it is in nobody's way").
        const bx = env.within; if (bx && !(next.x >= bx.x0 && next.x <= bx.x1 && next.z >= bx.z0 && next.z <= bx.z1 && next.y <= bx.top && next.y >= bx.bottom)) { r.outside = (r.outside || 0) + 1; return null; }
        const res = await handle(next, true);
        if (res && res !== 'defer') return res;
        r.corridor = (r.corridor || 0) + 1;
    }
    return null;
}

/** The bot stands on block `c` and nothing solid lies within three cells below it: breaking `c` would drop the bot into the open pit. Pure. */
function standsOnFloater(env, c) {
    if (!env.here) return false;
    const h = env.here();
    return h.x === c.x && h.z === c.z && h.y === c.y + 1 && ![1, 2, 3].some((d) => isSolid(env.w, c.x, c.y - d, c.z));
}

/**
 * Pick up what the sweep dropped: item entities near the station, nearest first. Cheap stone and dirt are left once the bot carries what
 * the pit needs of them (the janitor's keep.max: stone for sealing water and for stacking up), everything else is taken.
 */
async function sweepDrops(env, S) {
    const keep = janitor.pitPolicy().keep, enough = (n) => janitor.valueOf(n) <= 5 && env.have(n) >= (keep[n] ? keep[n].max : 16);
    const list = env.items({ x: S.x + 0.5, y: S.y, z: S.z + 0.5 }, 7).slice(0, 40);
    let n = 0;
    const seen = list.length; let fail = null;
    for (const it of list) { if (enough(it.name)) continue; const p = await env.exec('pickup', { entity: it.id }); if (p.ok) n++; else { fail = fail || p.reason; if (p.reason === 'died' || p.reason === 'disconnected' || p.reason === 'cancelled') break; } }
    return { picked: n, seen, ...(fail ? { fail } : {}) };
}

/**
 * What is still in the box when the plain cleanups are done (owner 2026-11-16): the bot's registered seal blocks and the lake-fill blocks that hang above the pit floor (a seal laid at the
 * water line of a pit that was dug 16 layers deeper; `mine` cannot reach it from the floor and the router says "enclosed"). The tree pass's walk serves them: stand on the floor beside the
 * block, rise on a pillar, mine it, come down. A seal that still holds water back (fluid beside or above) stays, as in cleanTemps.
 */
async function cleanHanging(plan, env) {
    if (!env.run || !env.here || !env.exec || !env.w) return null;
    const temps = env.temps, box = plan.box, w = env.w, owned = plan.lakeFilled || new Set();
    const { holdsNothingBack, dimOf } = require('../bot/temps'), dim = temps && env.bot ? dimOf(env.bot) : null;
    const inBox = (x, y, z) => x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1 && y <= box.top && y >= box.bottom;
    const cellsNow = () => {
        const map = new Map();
        // (and the movement blocks that hang in the box once the layers under them are dug: a pillar block at y -40 of a finished pit was the one pumpkin left, mine_b mb075f w3;
        // the plain cleanup's `mine` cannot reach it from the floor, and nav's sweep places nothing to get to it)
        if (temps && dim) for (const r of temps.list((q) => q.dim === dim && ['seal', 'rescue', 'lake', 'pillar', 'bridge', 'scaffold', 'reflex'].includes(q.kind) && inBox(q.x, q.y, q.z))) map.set(`${r.x},${r.y},${r.z}`, { x: r.x, y: r.y, z: r.z, reg: true });
        for (const k of owned) { const [x, y, z] = k.split(',').map(Number); if (inBox(x, y, z)) map.set(k, { x, y, z, reg: false }); }
        return map;
    };
    const find = (ww, skip) => {
        const all = cellsNow(), out = [];
        for (const [k, c] of all) {
            const kd = ww.kindAt(c.x, c.y, c.z);
            if (kd === 'unknown') continue;
            if (kd !== 'solid') { if (c.reg) temps.remove(dim, c); owned.delete(k); continue; }                 // gone already
            if (skip && skip.has(k) || !holdsNothingBack(ww, c)) continue;
            let gy = c.y - 1; while (gy >= box.bottom - 2 && (ww.kindAt(c.x, gy, c.z) === 'air' || all.has(`${c.x},${gy},${c.z}`))) gy--;
            out.push({ x: c.x, y: c.y, z: c.z, gy });
        }
        return out;
    };
    // A seal that stands at the box edge with the lake beside it keeps the lake out of the box: the water cells next to it are filled first (the fill covers the ring one cell beyond the box,
    // pit_lake.js), then the seal holds nothing back and goes. Seed 4461664185924705895, 2026-11-16: one seal at the lake's edge kept a layer dirty.
    const sealed = [];
    for (const c of cellsNow().values()) {
        if (w.kindAt(c.x, c.y, c.z) !== 'solid' || holdsNothingBack(w, c)) continue;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) if (isFluid(w, c.x + dx, c.y + dy, c.z + dz)) sealed.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz });
    }
    let lakeRes = null;
    if (sealed.length) {
        lakeRes = await require('./pit_lake').fillLake({ env, plan, isFluid, sealItem, items: SEAL_ITEMS, goToStation: async (S) => { const m = await env.exec('move_to', S, { maxTicks: STATION_TICKS }); return m.ok ? null : m; } }, sealed).catch((e) => ({ error: String(e && e.message || e) }));
        if (lakeRes && lakeRes.placed) for (const q of lakeRes.placed) owned.add(`${q.x},${q.y},${q.z}`);
    }
    if (!find(w, null).length) return { left: 0, ...(lakeRes ? { lake: { filled: lakeRes.filled, left: lakeRes.left, reason: lakeRes.reason || lakeRes.error } } : {}) };
    // The bot stands on one of them (the top of its own pillar in the dug box): down its column first, the way the pillar went up (moves.js `descend`: a block under the one it stands on,
    // that one broken, a level at a time, the last one onto the floor, no block lost); from the top no column beside it makes progress (mb075k w3, 1.21.1: the one pumpkin left, under the bot)
    let descended = 0;
    { const h = env.here(), under = find(w, null).find((c) => c.x === h.x && c.z === h.z && c.y === h.y - 1);
      if (under && h.y - (under.gy + 1) > 0) { const d = await env.run('descend', { levels: Math.min(80, h.y - (under.gy + 1)) }); descended = (d && d.detail && d.detail.levels) || 0; }
      if (descended && !find(w, null).length) { for (const c of cellsNow().values()) if (w.kindAt(c.x, c.y, c.z) !== 'solid') { if (c.reg) temps.remove(dim, c); owned.delete(`${c.x},${c.y},${c.z}`); } return { left: 0, descended }; } }
    const res = await require('./pit_trees').clearTrees(env, { x0: box.x0, x1: box.x1, z0: box.z0, z1: box.z1, top: box.top }, { find, maxMs: 240000, done: (c) => w.kindAt(c.x, c.y, c.z) !== 'solid' });
    for (const c of cellsNow().values()) if (w.kindAt(c.x, c.y, c.z) !== 'solid') { if (c.reg) temps.remove(dim, c); owned.delete(`${c.x},${c.y},${c.z}`); }
    return { mined: res.mined, risen: res.risen, left: res.left, failed: res.failed.slice(0, 4), ms: res.ms, ...(descended ? { descended } : {}), ...(lakeRes ? { lake: { filled: lakeRes.filled, left: lakeRes.left, reason: lakeRes.reason || lakeRes.error } } : {}) };
}

/** The last look at the trees (owner 2026-11-16): what hangs in the box when everything else is dug (leaves whose ground was dug away, a canopy the first pass could not reach), taken down region by region, nearest first, five minutes at most. */
async function cleanTrees(plan, env) {
    if (process.env.PIT_TREES === '0' || !env.run || !env.here || !env.exec) return null;
    const t0 = Date.now(), sum = { regions: 0, mined: 0, risen: 0, left: 0, failed: 0 };
    try {
        const here = env.here();
        for (const region of [...plan.regions].sort((a, b) => Math.hypot(a.anchor.x - here.x, a.anchor.z - here.z) - Math.hypot(b.anchor.x - here.x, b.anchor.z - here.z))) {
            if (Date.now() - t0 > 300000 || (env.cancel && env.cancel.cancelled)) return sum;
            const m = region.meta, box = { x0: m.x0, x1: m.x1, z0: m.z0, z1: m.z1, top: m.top };
            if (!require('./pit_trees').scan(env.w, box).length) continue;
            const tr = await require('./pit_trees').clearTrees(env, box, { maxMs: Math.max(30000, 300000 - (Date.now() - t0)) });
            sum.regions++; sum.mined += tr.mined; sum.risen += tr.risen; sum.left += tr.left; sum.failed += tr.failed.length;
        }
    } catch (e) { sum.error = String(e && e.message || e); /* the end of a job must not fail for a leftover leaf */ }
    return sum;
}

/** The lake-fill blocks (pit_lake.js) that are still there when the job is over: mined one by one, nearest first, at most 300 cells and five minutes. A unit that owned them may have been parked; the audit tolerates that, the end of the job does not leave the block. */
async function cleanLakeBlocks(plan, env) {
    const owned = plan.lakeFilled; if (!owned || !owned.size || !env.exec || !env.here) return;
    const t0 = Date.now(); let n = 0;
    try {
        for (;;) {
            const h = env.here(), left = [];
            for (const k of [...owned]) {
                const [x, y, z] = k.split(',').map(Number), kd = env.w.kindAt(x, y, z);
                const b = plan.box; if (b && !(x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1)) { owned.delete(k); continue; }          // the ring beyond the box keeps the lake out of it: never taken away
                if (kd === 'solid' || kd === 'partial') left.push({ x, y, z }); else if (kd !== 'unknown') owned.delete(k);
            }
            if (!left.length || n >= 300 || Date.now() - t0 > 300000 || (env.cancel && env.cancel.cancelled)) return;
            left.sort((a, b) => Math.hypot(a.x - h.x, a.y - h.y, a.z - h.z) - Math.hypot(b.x - h.x, b.y - h.y, b.z - h.z));
            const c = left[0]; n++;
            const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false });
            if (!m.ok) owned.delete(`${c.x},${c.y},${c.z}`);                      // not reachable: the audit reports it, it is not retried here
        }
    } catch (_) { /* the end of a job must not fail for a leftover block */ }
}

/**
 * Cells of a finished unit that are not open: leftover blocks, blocks placed by mistake (a water-control block at a height that was
 * dug already), water that ran in. Unloaded cells are not judged, but counted (`unknown`: the sweep walks to the chunk and looks again). Pure; `w` is only read.
 */
function cellState(plan, region, u, w) {
    const wrong = []; let unknown = 0;
    for (const c of unitCells(plan, region, u)) {
        const k = w.kindAt(c.x, c.y, c.z);
        if (k === 'unknown') { unknown++; continue; }
        // (a tree block is a cell like any other: the layer is not done while one stands, whoever takes it, the unit or the tree pass)
        if ((PASSABLE.has(k) && !(plan.clearPlants && NOT_AIR(w, c))) || UNBREAKABLE.test((w.nameAt && w.nameAt(c.x, c.y, c.z)) || '')) continue;
        if (plan.accepted && plan.accepted.has(`${c.x},${c.y},${c.z}`)) continue;                      // left on purpose: a fixture, a block the bot stood on
        wrong.push(c);
    }
    return { wrong, unknown };
}
const wrongCells = (plan, region, u, w) => cellState(plan, region, u, w).wrong;

/**
 * The layer gate (crew.js): before the layer below is opened, every cell of this layer is read from the world. A unit that still holds a block (done, or parked after a failure) goes back
 * to work, held a few seconds so that it is not tried again at once by the bot that just failed; a unit that has been sent back `LAYER_ROUNDS` times is accepted as it is (reported as
 * `leftover`: the end-of-job sweep and the automatic retry still look at it). Cells the bot cannot see (the chunk is not loaded even after a walk toward it) do not hold the layer.
 * @returns { region, layer, checked, reopened, leftover, unknown, first? }
 */
const LAYER_ROUNDS = 3, LAYER_HOLD_MS = 4000;
async function checkLayer(plan, ledger, byId, state, env, ck, now) {
    const region = byId.get(ck.region), reg = ledger.regions.get(ck.region), w = env.w, m = region.meta, res = { region: ck.region, layer: ck.layer, y: m.top - ck.layer, checked: 0, reopened: 0, leftover: 0, unknown: 0 };
    const cx = (m.x0 + m.x1) >> 1, cz = (m.z0 + m.z1) >> 1;
    if (w.kindAt(cx, res.y, cz) === 'unknown' && env.travel) { const t = await env.travel({ x: cx, z: cz }, { near: 20 }); res.travelled = t.ok ? t.legs : t.reason; }
    for (let i = 0; i < reg.rows; i++) {
        const u = ck.layer * reg.rows + i, st = reg.state[u];
        if (st !== DONE && st !== STUCK) continue;
        res.checked++;
        const c = cellState(plan, region, u, w); res.unknown += c.unknown;
        if (!c.wrong.length) continue;
        const key = `${ck.region}:${u}`, n = state.layer.get(key) || 0;
        if (n >= LAYER_ROUNDS) { res.leftover++; res.first = res.first || { unit: u, cells: c.wrong.slice(0, 4), leftover: true }; continue; }
        if (ledger.requeueUnit(ck.region, u, now, { holdMs: LAYER_HOLD_MS * (n + 1) })) { state.layer.set(key, n + 1); res.reopened++; res.first = res.first || { unit: u, cells: c.wrong.slice(0, 4), round: n + 1 }; }
    }
    return res;
}

const AUDIT_BUDGET = 48, AUDIT_REOPEN_MAX = 3;
/**
 * Does the range the crew was given still match what it is meant to be (owner 2026-11-06, 1-1)? Looks at finished units, a rotating
 * slice per call (`budget` units; `full` = all), and sends every unit with a wrong cell back to pending so that a bot goes and
 * fixes it. A unit sent back `maxReopen` times is left alone and reported (`gaveUp`): something keeps refilling it, and a loop would
 * be worse than the leftover. `state` = { cursor: Map(region -> next unit), counts: Map("region:unit" -> times reopened) }.
 */
function audit(plan, ledger, w, now, state, { budget = AUDIT_BUDGET, full = false, maxReopen = AUDIT_REOPEN_MAX } = {}) {
    const res = { checked: 0, reopened: [], gaveUp: [] };
    for (const region of plan.regions) {
        const reg = ledger.regions.get(region.id);
        if (!reg || !reg.doneN) continue;
        let i = full ? 0 : state.cursor.get(region.id) || 0, scanned = 0;
        for (; scanned < reg.n && (full || res.checked < budget); scanned++, i = (i + 1) % reg.n) {
            if (reg.state[i] !== 2) continue;                   // DONE
            res.checked++;
            const bad = wrongCells(plan, region, i, w);
            if (!bad.length) continue;
            const key = `${region.id}:${i}`, n = state.counts.get(key) || 0;
            if (n >= maxReopen) { if (n === maxReopen) { state.counts.set(key, n + 1); res.gaveUp.push({ region: region.id, unit: i, cells: bad.slice(0, 4) }); } continue; }
            if (ledger.reopen(region.id, i, now)) { state.counts.set(key, n + 1); res.reopened.push({ region: region.id, unit: i, cells: bad.slice(0, 4), n: bad.length }); }
        }
        if (!full) state.cursor.set(region.id, i);
    }
    return res;
}

/** A pit as a crew job: { ledger, plan, runUnit(regionId, unit, env) }. */
function createPitJob(box, ledgerOpts = {}, { lanes = 0, method = 'rows', tile = TILE, road = true, plants = false } = {}) {
    const plan = planPit(box, { lanes, method, tile, road }); plan.accepted = new Set(); plan.clearPlants = !!plants;
    const ledger = new Ledger({ lookahead: 2, ...ledgerOpts }), byId = new Map(), auditState = { cursor: new Map(), counts: new Map() };
    for (const r of plan.regions) { ledger.addRegion(r); byId.set(r.id, r); }
    // sweep: the check at the end (pit_sweep.js): every chunk is walked to, read from the top layer down, and what still holds a block goes back to work.
    const sweep = makeSweeper({ plan, ledger, state: auditState, cellState });
    auditState.layer = new Map();
    // The run's time is over before the pit (wrapUp, the test harness's time limit; owner list 5 Large 1: a clean site at the end of every run): no unit is claimed any more, the
    // crew's worker takes the end of the job (cleanup: the movement blocks, nav's sweep) as for a finished pit, without the end's tree, hanging-block and lake-fill passes (the box
    // is not dug, those blocks are its ground until it is)
    const fin = ledger.finished.bind(ledger), claim0 = ledger.claim.bind(ledger);
    ledger.finished = () => !!plan.wrapping || fin();
    ledger.claim = (...a) => (plan.wrapping ? null : claim0(...a));
    const wrapUp = () => { plan.wrapping = true; };
    const wrapClean = async (env) => { const TM = require('../bot/temps'), rep = plan.endReport || (plan.endReport = {}); rep.wrap = await TM.cleanTemps(env, { box: plan.box, reach: true, max: 120, maxMs: 240000, kinds: new Set([...TM.KINDS].filter((k) => k !== 'seal' && k !== 'rescue' && k !== 'lake')) }); return rep.wrap; };
    return { kind: 'pit', ledger, plan, wrapUp, checkLayer: (env, ck, now) => checkLayer(plan, ledger, byId, auditState, env, ck, now), cleanup: async (env) => { if (plan.wrapping) return wrapClean(env); if (!ledger.finished()) return null; const rep = plan.endReport || (plan.endReport = {}); rep.trees = await cleanTrees(plan, env); const TM = require('../bot/temps'), t = await TM.cleanTemps(env, { box: plan.box, reach: true, max: 60, maxMs: 300000, kinds: new Set([...TM.KINDS].filter((k) => k !== 'seal' && k !== 'rescue' && k !== 'lake')) }); rep.temps = t;
            // seals and lake-fill blocks hang over the floor of a deep pit: the pillar walk takes them (a plain mine of one cost the whole time budget: "enclosed", 120 s, and left a pillar block behind)
            rep.hanging = await cleanHanging(plan, env).catch((e) => ({ error: String(e && e.message || e) }));
            await cleanLakeBlocks(plan, env); rep.seals = await TM.cleanTemps(env, { box: plan.box, reach: true, max: 20, maxMs: 120000, kinds: new Set(['seal', 'rescue', 'lake']) }); return t; }, runUnit: (regionId, unit, env) => runUnit(plan, byId.get(regionId), unit, env), audit: (env, now, opts) => (plan.wrapping ? { checked: 0, reopened: [], gaveUp: [] } : audit(plan, ledger, env.w, now, auditState, opts)), sweep: (env, now) => (plan.wrapping ? {} : sweep(env, now)), rescue: (env, why) => require('../bot/water').rescue(env, plan.box, { why }) };
}

module.exports = { cleanTrees, cleanHanging, cleanLakeBlocks, sealItem, MAX_UNITS, goToStation, checkLayer, LAYER_ROUNDS, standsOnFloater, aerialTree, planPit, laneBoxes, planRoad, stationsOf, lineCells, unitCells, sealPlan, orderFill, isFluid, exposed, runUnit, wrongCells, cellState, audit, createPitJob, SEAL_ITEMS, CHUNK, TILE, SWEEP_R };

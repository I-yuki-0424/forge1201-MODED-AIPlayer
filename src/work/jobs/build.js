'use strict';
// Structures as a crew job (docs/proposed/WORKERS-v1.md, part 2). A blueprint is a list of cells {x, y, z, block} relative to
// its minimum corner. Sources: the game's own structure format (`.nbt` of the structure block; Create schematics are the same
// file) or a generator (`house`). The job places the cells bottom-up with the existing `place` command, one row per unit.
// A cell that cannot be reached from the ground gets a temporary staircase of cheap blocks (scaffold), removed afterwards.
// Block properties (stairs/slab/log orientation) are NOT reproduced: `place` puts a block down the way a click does.
// Mod blocks are placed by their namespaced name; whether a bot can place one is the registry's question (the console asks it).
const { Ledger } = require('./crew');
const { SEAL_ITEMS } = require('./pit');

const TILE = 16;
const SKIP = /^(air|cave_air|void_air|structure_void|jigsaw|structure_block|barrier)$/;
const ATTACHED = /(torch|ladder|button|lever|sign|door|trapdoor|pressure_plate|carpet|banner|rail|lantern|vine)$/;   // placed after the solids of their layer
const ITEM_OF = { wall_torch: 'torch', redstone_wall_torch: 'redstone_torch', soul_wall_torch: 'soul_torch', wall_sign: 'oak_sign', water: null, lava: null };

const bare = (n) => String(n).replace(/^minecraft:/, '');
/** The item that places `block`, or null when `place` cannot (fluids). Mod blocks keep their namespace (`create:cogwheel`). */
function itemFor(block) {
    const n = bare(block);
    if (n.includes(':')) return n;
    if (n in ITEM_OF) return ITEM_OF[n];
    return n.replace(/^(.*)_wall_(sign|banner|head)$/, '$1_$2');
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

/** Cut a blueprint into tiles and add them to a ledger: layer = height above the origin (bottom-up), rows = z lines of a tile. */
function planBuild(cells, origin, { tile = TILE, known = null } = {}) {
    if (!cells.length) throw new Error('blueprint is empty');
    const abs = cells.map((c) => ({ x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z, block: bare(c.block), props: c.props }));
    // `known(name)`: does the bot's registry have this block (a mod block of another mod set does not)? Unplaceable ones are listed, not tried.
    const cannot = (b) => itemFor(b) === null || (known && !known(b));
    const unsupported = [...new Set(abs.map((c) => c.block).filter((b) => !SKIP.test(b) && cannot(b)))];
    const placeable = abs.filter((c) => !cannot(c.block) && !SKIP.test(c.block));
    if (!placeable.length) throw new Error('nothing the bots can place (every block is unsupported)');
    const minY = Math.min(...placeable.map((c) => c.y)), maxY = Math.max(...placeable.map((c) => c.y)), layers = maxY - minY + 1;
    const tiles = new Map();
    for (const c of placeable) {
        const tx = Math.floor(c.x / tile), tz = Math.floor(c.z / tile), id = `b${tx}_${tz}`;
        let t = tiles.get(id);
        if (!t) tiles.set(id, t = { id, z0: tz * tile, z1: tz * tile + tile - 1, x0: Infinity, x1: -Infinity, cells: new Map() });
        t.x0 = Math.min(t.x0, c.x); t.x1 = Math.max(t.x1, c.x);
        const key = (c.y - minY) * tile + (c.z - t.z0);                       // unit index inside the tile = layer * rows + row
        (t.cells.get(key) || t.cells.set(key, []).get(key)).push(c);
    }
    const regions = [...tiles.values()].map((t) => ({
        id: t.id, anchor: { x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2 }, layers, rows: tile, meta: { tile: t.id, minY },
    }));
    const footprint = new Set(placeable.map((c) => `${c.x},${c.z}`));
    return { origin, minY, layers, tiles, regions, unsupported, footprint, count: placeable.length };
}

/** Cells of one unit in placement order: structural blocks first, then attached ones; x serpentine by row. */
function unitCells(plan, regionId, u) {
    const t = plan.tiles.get(regionId), list = (t.cells.get(u) || []).slice();
    list.sort((a, b) => (ATTACHED.test(a.block) - ATTACHED.test(b.block)) || ((u % 2) ? b.x - a.x : a.x - b.x));
    return list;
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

/** What differs between the blueprint and the world: cells whose block is not the wanted one (a repair job's input). */
function diffBuild(plan, w) {
    const missing = [];
    for (const t of plan.tiles.values()) for (const list of t.cells.values()) for (const c of list) {
        const n = w.nameAt(c.x, c.y, c.z);
        if (n !== c.block) missing.push(c);
    }
    return missing;
}

/**
 * Run one unit. `env`: exec, w, have, here. Idempotent: a cell that already holds its block is skipped, one that holds
 * something else is dug out first. Temporary scaffold blocks are recorded in env.scaffold (kept while the bot works on the same
 * layer) and removed by cleanup().
 */
async function runUnit(plan, regionId, u, env) {
    const cells = unitCells(plan, regionId, u.unit), r = { placed: 0, skipped: 0, scaffold: 0 };
    env.scaffold = env.scaffold || { layer: null, cells: [] };
    if (env.scaffold.layer !== null && env.scaffold.layer !== u.layer) await cleanup(env);
    env.scaffold.layer = u.layer;
    const fail = (res, cell, stage) => ({ ok: false, reason: res.reason, detail: { ...(res.detail || {}), cell, stage, ...r } });
    const anyItem = () => SEAL_ITEMS.find((n) => env.have(n) >= 2);
    for (const c of cells) {
        const item = itemFor(c.block), cur = env.w.nameAt(c.x, c.y, c.z);
        if (cur === c.block) { r.skipped++; continue; }
        if (cur && !/^(air|cave_air|void_air|grass|tall_grass|short_grass|fern|snow|dead_bush)$/.test(cur)) {
            const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z });
            if (!m.ok) return fail(m, c, 'clear');
        }
        if (env.have(item) < 1) return fail({ reason: 'missing_item', detail: { item } }, c, 'stock');
        let p = await env.exec('place', { x: c.x, y: c.y, z: c.z, item });
        // A scaffold helps when the cell cannot be reached or seen, and also when the walk to the placement face ends in the open
        // (a roof cell inside the walls: live run, reason 'stuck', goal 'reach placement face'). Other 'stuck' reasons are the bot's body.
        if (!p.ok && (p.reason === 'unreachable' || p.reason === 'not_visible' || (p.reason === 'stuck' && p.detail && p.detail.goal === 'reach placement face'))) {
            const sc = scaffoldFor(plan, env.w, c, plan.origin.y, { reuse: new Set(env.scaffold.cells.map((q) => `${q.x},${q.y},${q.z}`)) }), mat = anyItem();
            if (sc && sc.cells.length && mat) {
                for (const s of sc.cells) {
                    if (env.w.nameAt(s.x, s.y, s.z) === mat) continue;
                    const q = await env.exec('place', { x: s.x, y: s.y, z: s.z, item: mat, temp: 'scaffold' });
                    if (!q.ok) return fail(q, s, 'scaffold');
                    env.scaffold.cells.push(s); r.scaffold++;
                }
                const mv = await env.exec('move_to', sc.top);
                if (!mv.ok) return fail(mv, sc.top, 'climb');
                p = await env.exec('place', { x: c.x, y: c.y, z: c.z, item });
            }
        }
        if (!p.ok) return fail(p, c, 'place');
        r.placed++;
    }
    return { ok: true, reason: null, detail: r };
}

/** Remove the temporary blocks, highest first, so the bot always has something to stand on. */
async function cleanup(env) {
    const t = env.scaffold; if (!t || !t.cells.length) { if (t) t.layer = null; return { ok: true, removed: 0 }; }
    const cells = t.cells.sort((a, b) => b.y - a.y || b.x - a.x); let removed = 0;
    for (const c of cells) {
        if (!env.w.nameAt(c.x, c.y, c.z) || /^(air|cave_air)$/.test(env.w.nameAt(c.x, c.y, c.z))) continue;
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

module.exports = { house, fromStructureNbt, planBuild, unitCells, scaffoldFor, diffBuild, runUnit, cleanup, createBuildJob, itemFor };

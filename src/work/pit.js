'use strict';
// Open-pit excavation as a crew job (docs/proposed/WORKERS-v1.md, part 1): a box is cut into chunk-aligned regions; a
// region is dug layer by layer from the top, one ROW (a line of cells along x) per unit; every unit is the existing `mine`
// command repeated, plus `place` for the water rule. Nothing here touches the game directly: `exec(name, args)` runs a
// command of the action layer, `w` is its world model (kindAt/nameAt), so the whole job is testable without a server.
const { Ledger } = require('./crew');

const CHUNK = 16;
const MAX_CELLS = 4_000_000;         // a job this large is a mistake in the arguments, not a request
const PASSABLE = new Set(['air', 'climb']);
// What the bot fills fluids with, in order of preference: cheap, common in a pit, does not fall (no sand or gravel).
const SEAL_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate'];

/**
 * Box {x0, z0, x1, z1, top, bottom} (inclusive columns; `top` = y of the first block layer to dig, `bottom` = y of the last).
 * Returns the chunk-aligned regions and the haul road. Layer l is y = top - l.
 */
function planPit(box, { chunk = CHUNK } = {}) {
    const { x0, z0, x1, z1, top, bottom } = box;
    for (const k of ['x0', 'z0', 'x1', 'z1', 'top', 'bottom']) if (!Number.isInteger(box[k])) throw new Error(`box.${k} must be an integer`);
    if (x1 < x0 || z1 < z0 || top < bottom) throw new Error('box is empty (x1<x0, z1<z0 or top<bottom)');
    const layers = top - bottom + 1;
    if ((x1 - x0 + 1) * (z1 - z0 + 1) * layers > MAX_CELLS) throw new Error('box too large for one job');
    const road = planRoad(box, layers);
    const regions = [];
    for (let cx = Math.floor(x0 / chunk); cx <= Math.floor(x1 / chunk); cx++) {
        for (let cz = Math.floor(z0 / chunk); cz <= Math.floor(z1 / chunk); cz++) {
            const r = { x0: Math.max(x0, cx * chunk), x1: Math.min(x1, cx * chunk + chunk - 1), z0: Math.max(z0, cz * chunk), z1: Math.min(z1, cz * chunk + chunk - 1) };
            regions.push({ id: `c${cx}_${cz}`, anchor: { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }, layers, rows: r.z1 - r.z0 + 1, meta: { ...r, top, bottom } });
        }
    }
    return { box, layers, regions, road };
}

/**
 * The haul road: a one-block-wide staircase left standing along the edge of the box, so a bot (or a replacement bot) can
 * always walk down into the pit and out again. Cell i keeps every block at y <= top - i; the dig volume above it is dug.
 * Runs east along the north edge, then south along the east edge, west along the south edge, north along the west edge.
 */
function planRoad(box, layers) {
    const { x0, z0, x1, z1, top } = box, path = [];
    const w = x1 - x0 + 1, h = z1 - z0 + 1;
    for (let x = x0; x <= x1; x++) path.push([x, z0]);
    for (let z = z0 + 1; z <= z1; z++) path.push([x1, z]);
    if (h > 1) for (let x = x1 - 1; x >= x0; x--) path.push([x, z1]);
    if (w > 1) for (let z = z1 - 1; z > z0; z--) path.push([x0, z]);
    if (layers > path.length) throw new Error(`pit ${layers} deep needs a haul road of ${layers} cells; the box edge has only ${path.length}`);
    const keep = new Map(), cells = [];
    for (let i = 0; i < layers; i++) { keep.set(`${path[i][0]},${path[i][1]}`, top - i); cells.push({ x: path[i][0], z: path[i][1], keepTo: top - i }); }
    return { keep, cells };
}

/** The cells of one unit (layer, row) in walking order (rows alternate direction), without the road's kept blocks. */
function unitCells(plan, region, u) {
    const { rows, meta } = region, layer = (u / rows) | 0, row = u % rows, y = meta.top - layer, z = meta.z0 + row;
    const out = [];
    for (let x = meta.x0; x <= meta.x1; x++) {
        const keepTo = plan.road.keep.get(`${x},${z}`);
        if (keepTo !== undefined && y <= keepTo) continue;
        out.push({ x, y, z });
    }
    if (row % 2) out.reverse();
    return out;
}

const RETRY = new Set(['not_visible', 'not_confirmed', 'stuck', 'unreachable', 'target_lost']);
const NEIGH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const isFluid = (w, x, y, z) => { const k = w.kindAt(x, y, z); return k === 'water' || k === 'liquid' || (k === 'danger' && /lava/.test(w.nameAt(x, y, z) || '')); };
const isSolid = (w, x, y, z) => w.kindAt(x, y, z) === 'solid';

/**
 * Fluid cells to fill before digging `cells` (one layer): the cell itself and its four horizontal neighbours when they hold
 * water or lava. This is the owner's water rule: fill the fluid that would flow into the cell the moment it opens (also water
 * from a neighbouring chunk), and fill fluid inside the volume so that it can be mined. Each fill needs a solid neighbour to be
 * placed against, so fills are ordered from the solid side outwards; `unsupported` are fluid cells with no way to start (an
 * open lake: the caller reports it). Pure; `w` is only read.
 */
function sealPlan(w, cells) {
    const want = new Map();
    for (const c of cells) {
        if (isFluid(w, c.x, c.y, c.z)) want.set(`${c.x},${c.y},${c.z}`, { x: c.x, y: c.y, z: c.z });
        for (const [dx, dz] of NEIGH4) if (isFluid(w, c.x + dx, c.y, c.z + dz)) want.set(`${c.x + dx},${c.y},${c.z + dz}`, { x: c.x + dx, y: c.y, z: c.z + dz });
    }
    const todo = [...want.values()], order = [], filled = new Set();
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
    const cells = unitCells(plan, region, u.unit), r = { mined: 0, sealed: 0, skipped: 0 };
    const fail = (res, cell, stage) => ({ ok: false, reason: res.reason, detail: { ...(res.detail || {}), cell, stage, ...r } });
    const seal = async (c) => {
        const sp = sealPlan(env.w, [c]);
        if (sp.unsupported.length) return { ok: false, reason: 'invalid_target', detail: { why: 'fluid with nothing to seal it against', cells: sp.unsupported.slice(0, 4) } };
        for (const f of sp.fill) {
            const item = SEAL_ITEMS.find((n) => env.have(n) >= 1);
            if (!item) return { ok: false, reason: 'missing_item', detail: { why: 'no block to seal water with', tried: SEAL_ITEMS } };
            const p = await env.exec('place', { x: f.x, y: f.y, z: f.z, item, fluid: true });
            if (!p.ok) return p;
            r.sealed++;
        }
        return { ok: true };
    };
    for (const c of cells) {
        let s = await seal(c);
        if (!s.ok) return fail(s, c, 'seal');
        if (PASSABLE.has(env.w.kindAt(c.x, c.y, c.z))) { r.skipped++; continue; }
        // Success is what the world shows: a `mine` that ended in the drop pickup (target_lost: the item was picked up by another
        // bot or despawned) has still opened the cell. Transient reasons (another bot in the crosshair, a slipped aim) get retries.
        const open = () => PASSABLE.has(env.w.kindAt(c.x, c.y, c.z));
        let m = await env.exec('mine', c);
        for (let tries = 0; !m.ok && !open() && tries < 2 && RETRY.has(m.reason); tries++) { await (env.pause ? env.pause(20 + 20 * tries) : null); m = await env.exec('mine', c); }
        if (!m.ok && !open()) return fail(m, c, 'mine');
        r.mined++;
        s = await seal(c);                                  // water that was behind the block and is now flowing in
        if (!s.ok) return fail(s, c, 'seal_after');
    }
    return { ok: true, reason: null, detail: r };
}

/** A pit as a crew job: { ledger, plan, runUnit(regionId, unit, env) }. */
function createPitJob(box, ledgerOpts = {}) {
    const plan = planPit(box), ledger = new Ledger(ledgerOpts), byId = new Map();
    for (const r of plan.regions) { ledger.addRegion(r); byId.set(r.id, r); }
    return { kind: 'pit', ledger, plan, runUnit: (regionId, unit, env) => runUnit(plan, byId.get(regionId), unit, env) };
}

module.exports = { planPit, planRoad, unitCells, sealPlan, runUnit, createPitJob, SEAL_ITEMS, CHUNK };

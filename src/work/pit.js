'use strict';
// Open-pit excavation as a crew job (docs/proposed/WORKERS-v1.md, part 1): a box is cut into chunk-aligned regions; a
// region is dug layer by layer from the top, one ROW (a line of cells along x) per unit; every unit is the existing `mine`
// command repeated, plus `place` for the water rule. Nothing here touches the game directly: `exec(name, args)` runs a
// command of the action layer, `w` is its world model (kindAt/nameAt), so the whole job is testable without a server.
const { Ledger } = require('./crew');

const CHUNK = 16;
const MAX_CELLS = 4_000_000;         // a job this large is a mistake in the arguments, not a request
const PASSABLE = new Set(['air', 'climb']);
const UNBREAKABLE = /^(bedrock|barrier|end_portal_frame|end_portal|nether_portal|command_block|structure_block|jigsaw)$/;
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
    const open = (c) => PASSABLE.has(env.w.kindAt(c.x, c.y, c.z));
    // Fill what sealPlan lists. `before`: only fluid that can be seen now (a pocket sealed inside stone cannot be clicked, and it
    // cannot flow until the cell next to it opens: live run p4, a water cell in the wall next to the last stone); after the dig
    // the opened cell is the window onto it, so everything is filled then, the pocket first and the opened cell last.
    const seal = async (c, before) => {
        const sp = sealPlan(env.w, [c]);
        const list = before ? sp.fill.filter((f) => (f.x === c.x && f.y === c.y && f.z === c.z) || exposed(env.w, f, c)) : sp.fill;
        const hidden = before ? sp.unsupported.filter((f) => exposed(env.w, f, c)) : sp.unsupported;
        if (hidden.length) return { ok: false, reason: 'invalid_target', detail: { why: 'fluid with nothing to seal it against', cells: hidden.slice(0, 4) } };
        for (const f of list) {
            const item = SEAL_ITEMS.find((n) => env.have(n) >= 1);
            if (!item) return { ok: false, reason: 'missing_item', detail: { why: 'no block to seal water with', tried: SEAL_ITEMS } };
            const p = await env.exec('place', { x: f.x, y: f.y, z: f.z, item, fluid: true });
            if (!p.ok) return p;
            r.sealed++;
        }
        return { ok: true, n: list.length };
    };
    // One cell. Returns null when it is open afterwards, or the failure. A cell whose water rule needs a block the bot does not have yet
    // (a bot with an empty inventory next to a shore) is not a failure of the unit: it is left for after the row, when digging has
    // brought dirt or cobblestone.
    const handle = async (c, last) => {
        let s = await seal(c, true);
        if (!s.ok) return s.reason === 'missing_item' && !last ? 'defer' : fail(s, c, 'seal');
        if (open(c)) { r.skipped++; return null; }
        // Success is what the world shows: a `mine` that ended in the drop pickup (target_lost: the item was picked up by another
        // bot or despawned) has still opened the cell. Transient reasons (another bot in the crosshair, a slipped aim) get retries.
        let m = await env.exec('mine', c);
        for (let tries = 0; !m.ok && !open(c) && tries < 2 && RETRY.has(m.reason); tries++) { await (env.pause ? env.pause(20 + 20 * tries) : null); m = await env.exec('mine', c); }
        if (!m.ok && !open(c)) return fail(m, c, 'mine');
        r.mined++;
        // Water that was behind the block is now flowing in. Fill its source, then the cell; if the cell was plugged, dig it again.
        for (let round = 0; round < 3; round++) {
            s = await seal(c, false);
            if (!s.ok) return s.reason === 'missing_item' && !last ? 'defer' : fail(s, c, 'seal_after');
            if (!s.n && open(c)) break;
            if (!open(c) && env.w.kindAt(c.x, c.y, c.z) === 'solid') {          // a plug; water still running in is filled by the next round
                const m2 = await env.exec('mine', c);
                if (!m2.ok && !open(c)) return fail(m2, c, 'unplug');
            }
        }
        if (!open(c)) return fail({ reason: 'not_confirmed', detail: { why: 'cell keeps filling' } }, c, 'seal_after');
        return null;
    };
    const deferred = [];
    for (const c of cells) {
        if (UNBREAKABLE.test(env.w.nameAt(c.x, c.y, c.z) || '')) { r.skipped++; continue; }         // bedrock at the bottom of the world
        const res = await handle(c, false);
        if (res === 'defer') { deferred.push(c); r.deferred = (r.deferred || 0) + 1; continue; }
        if (res) return res;
    }
    for (const c of deferred) { const res = await handle(c, true); if (res) return res; }
    return { ok: true, reason: null, detail: r };
}

/** A pit as a crew job: { ledger, plan, runUnit(regionId, unit, env) }. */
function createPitJob(box, ledgerOpts = {}) {
    const plan = planPit(box), ledger = new Ledger(ledgerOpts), byId = new Map();
    for (const r of plan.regions) { ledger.addRegion(r); byId.set(r.id, r); }
    return { kind: 'pit', ledger, plan, runUnit: (regionId, unit, env) => runUnit(plan, byId.get(regionId), unit, env) };
}

module.exports = { planPit, planRoad, unitCells, sealPlan, exposed, runUnit, createPitJob, SEAL_ITEMS, CHUNK };

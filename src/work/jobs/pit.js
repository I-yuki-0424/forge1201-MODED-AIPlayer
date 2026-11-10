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
const PASSABLE = new Set(['air', 'climb']);
// Natural tree blocks. One that hangs high above the ground below it cannot be reached on foot: the planner expands 20,000 cells and gives up
// (30-85 s per try, six tries per unit, bots end up standing on the canopy) - the live pit of 2026-11-07 with top y 90 over ground at y 64 and a tree.
// The pit leaves such blocks alone (they are not ground; the audit does not count them) and says how many it left.
const TREE = /(_leaves|_log|_wood|_vines?|^vine|^bamboo|^mangrove_roots)$/;
const AERIAL_UP = 6;                        // blocks above the ground below: from there on a tree block is out of reach for a bot standing on the ground
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
const SEAL_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate'];

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
    if (!['rows', 'sweep'].includes(method)) throw new Error('method is rows or sweep');
    if (!Number.isInteger(tile) || tile < 1 || tile > 7) throw new Error('tile 1..7');
    // rows: a unit is one row of a layer, dug cell by cell while walking along it. sweep: a unit is one standing place of a layer
    // ("station"): the bot goes to the middle of a tile, digs everything within reach in one go and only then moves on.
    const mk = (id, r) => {
        const base = { ...r, top, bottom };
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
    const cells = unitCells(plan, region, u.unit), r = { mined: 0, sealed: 0, skipped: 0 }, sweep = region.meta.method === 'sweep';
    // A sweep leaves the drops where they fall and picks everything up once at the end (a walk per block would cost more than the digging).
    const mineArgs = (c) => (sweep ? { x: c.x, y: c.y, z: c.z, collect: false } : c);
    const fail = (res, cell, stage) => ({ ok: false, reason: res.reason, detail: { ...(res.detail || {}), cell, block: env.w.nameAt ? env.w.nameAt(cell.x, cell.y, cell.z) : undefined, stage, ...r } });
    const open = (c) => PASSABLE.has(env.w.kindAt(c.x, c.y, c.z));
    const leave = (c) => { if (plan.accepted) plan.accepted.add(`${c.x},${c.y},${c.z}`); };          // a block left on purpose (a fixture, a floating block): the layer check does not send the unit back for it
    // Fill what sealPlan lists. `before`: only fluid that can be seen now (a pocket sealed inside stone cannot be clicked, and it
    // cannot flow until the cell next to it opens: live run p4, a water cell in the wall next to the last stone); after the dig
    // the opened cell is the window onto it, so everything is filled then, the pocket first and the opened cell last.
    const liftedFor = new Set();
    // A placement the bot cannot reach a face for (unreachable) or that ends in a swim it cannot get out of (stuck): the same walk is not tried again. The server puts the bot on a standable
    // cell beside the fluid cell, once per cell, and the placement is tried from there (a different approach); if that fails too, the failure goes up and the unit is parked.
    const placeAt = async (f, item) => {
        let p = await env.exec('place', { x: f.x, y: f.y, z: f.z, item, fluid: true, temp: 'seal' });
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
            let item = SEAL_ITEMS.find((n) => env.have(n) >= 1);
            // Nothing to seal with and nowhere to fetch it (`any` is insert-only): a block from the undug part of the pit beside the bot, as the pillar takes one (moves.js harvest).
            if (!item && env.run && env.within) { const hv = await env.run('harvest', { items: SEAL_ITEMS }); if (hv.ok && hv.detail && hv.detail.got) { r.harvested = (r.harvested || 0) + 1; item = SEAL_ITEMS.find((n) => env.have(n) >= 1); } }
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
    const handle = async (c, last) => {
        if (isSolid(env.w, c.x, c.y, c.z) && aerialTree(env.w, c)) { r.skipped++; r.aerial = (r.aerial || 0) + 1; return null; }       // out of reach by design, see aerialTree
        let s = await seal(c, true);
        if (!s.ok) return s.reason === 'missing_item' && !last ? 'defer' : fail(s, c, 'seal');
        if (open(c)) { r.skipped++; return null; }
        // The block the bot stands on, with nothing solid within three cells under it: breaking it drops the bot into the open pit (86 blocks, dead; live pit 2026-11-07, a lone
        // cobblestone pillar at layer 30 killed a bot four times). Left in place: nothing can be done about it from the side, and a floating block hurts nobody.
        if (standsOnFloater(env, c)) { r.skipped++; r.floating = (r.floating || 0) + 1; leave(c); return null; }
        // Success is what the world shows: a `mine` that ended in the drop pickup (target_lost: the item was picked up by another
        // bot or despawned) has still opened the cell. Transient reasons (another bot in the crosshair, a slipped aim) get retries.
        let m = await env.exec('mine', mineArgs(c));
        // A few seconds between attempts (something in the way moves on, the server catches up), and a small fix before each one:
        // jump, sidestep, go back to where the bot last worked (env.recover; the worker's ladder).
        // Retrying a cell nobody can reach changes nothing: one more look for 'unreachable', then the unit fails and is tried again later (repair passes).
        for (let tries = 0; !m.ok && !open(c) && tries < (m.reason === 'unreachable' ? 1 : 6) && RETRY.has(m.reason); tries++) { if (env.recover) await env.recover(Math.min(tries + 2, 4), m); await (env.pause ? env.pause(10 + 10 * tries) : null); m = await env.exec('mine', mineArgs(c)); }
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
    const deferred = [];
    // Nothing to dig here (only open air, unbreakable blocks and tree blocks out of reach): done, and the bot does not walk anywhere. Walking to the station
    // of such a tile sent bots up the canopy of a tree (the planner takes the nearest reachable cell to a station in mid-air: live pit of 2026-11-07).
    if (cells.every((c) => open(c) || UNBREAKABLE.test(env.w.nameAt(c.x, c.y, c.z) || '') || (isSolid(env.w, c.x, c.y, c.z) && aerialTree(env.w, c)))) {
        r.skipped += cells.length; r.idle = true;
        return { ok: true, reason: null, detail: r };
    }
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
    let rejoins = 0;                     // a bot far from the station (it respawned at the world spawn) is sent back first, at most twice
    let lifts = 0;                       // at most two server lifts per walk to a station: a lift that lands in the same cell again changes nothing (live: Work17 lifted 0 blocks every 20 s)
    for (let t = 0; t < 10; t++) {
        const here = env.here();
        if (here.x === S.x && here.y === S.y && here.z === S.z) return null;
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
        }
        // The station is three or more levels above the bot and there is no way up on foot (a shaft, a cave under a layer that is still closed): rise by pillar,
        // breaking what is overhead (by hand if no tool fits), and dig the corridor to the station from that layer. Live pit 2026-11-07: four bots stood under an
        // undug slab, 5-26 levels below their units, and failed 'unreachable' for ten minutes. Another bot in the same cell blocks the first block: sidestep, again.
        if (env.run && above >= 3) {
            if (env.crowded && env.crowded()) { if (env.stepAside) await env.stepAside(); else if (env.recover) await env.recover(3); }
            let p = await env.run('pillar', { levels: S.y - env.here().y });
            if (!p.ok && p.reason === 'not_confirmed' && (env.stepAside || env.recover)) { if (env.stepAside) await env.stepAside(); else await env.recover(3); p = await env.run('pillar', { levels: Math.max(1, S.y - env.here().y) }); }
            const last = p.detail && p.detail.last; if (last && env.temp) env.temp.set(`${last.x},${last.y},${last.z}`, last);
            r.rose = (r.rose || 0) + ((p.detail && p.detail.levels) || 0);
            if (!p.ok) return { ok: false, reason: p.reason, detail: { ...(p.detail || {}), cell: S, stage: 'rise', ...r } };
            continue;
        }
        if (env.rejoin && (Math.hypot(here.x - S.x, here.z - S.z) > 24 || Math.abs(above) > 24)) return { ok: false, reason: 'unreachable', detail: { why: 'too far from the station to dig a corridor toward it', botSide: true, stage: 'station', cell: S, ...r } };
        const next = lineCells(here, S, S.y).find((c) => !open(c) && !UNBREAKABLE.test(env.w.nameAt(c.x, c.y, c.z) || ''));
        if (!next) return null;
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
 * Cells of a finished unit that are not open: leftover blocks, blocks placed by mistake (a water-control block at a height that was
 * dug already), water that ran in. Unloaded cells are not judged, but counted (`unknown`: the sweep walks to the chunk and looks again). Pure; `w` is only read.
 */
function cellState(plan, region, u, w) {
    const wrong = []; let unknown = 0;
    for (const c of unitCells(plan, region, u)) {
        const k = w.kindAt(c.x, c.y, c.z);
        if (k === 'unknown') { unknown++; continue; }
        if (PASSABLE.has(k) || UNBREAKABLE.test((w.nameAt && w.nameAt(c.x, c.y, c.z)) || '') || aerialTree(w, c)) continue;
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
function createPitJob(box, ledgerOpts = {}, { lanes = 0, method = 'rows', tile = TILE, road = true } = {}) {
    const plan = planPit(box, { lanes, method, tile, road }); plan.accepted = new Set();
    const ledger = new Ledger(ledgerOpts), byId = new Map(), auditState = { cursor: new Map(), counts: new Map() };
    for (const r of plan.regions) { ledger.addRegion(r); byId.set(r.id, r); }
    // sweep: the check at the end (pit_sweep.js): every chunk is walked to, read from the top layer down, and what still holds a block goes back to work.
    const sweep = makeSweeper({ plan, ledger, state: auditState, cellState });
    auditState.layer = new Map();
    return { kind: 'pit', ledger, plan, checkLayer: (env, ck, now) => checkLayer(plan, ledger, byId, auditState, env, ck, now), cleanup: (env) => (ledger.finished() ? require('../bot/temps').cleanTemps(env, { box: plan.box, max: 60, maxMs: 120000 }) : null), runUnit: (regionId, unit, env) => runUnit(plan, byId.get(regionId), unit, env), audit: (env, now, opts) => audit(plan, ledger, env.w, now, auditState, opts), sweep, rescue: (env, why) => require('../bot/water').rescue(env, plan.box, { why }) };
}

module.exports = { MAX_UNITS, checkLayer, LAYER_ROUNDS, standsOnFloater, aerialTree, planPit, laneBoxes, planRoad, stationsOf, lineCells, unitCells, sealPlan, orderFill, isFluid, exposed, runUnit, wrongCells, cellState, audit, createPitJob, SEAL_ITEMS, CHUNK, TILE, SWEEP_R };

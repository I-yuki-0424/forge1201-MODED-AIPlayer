'use strict';
// What a stuck picture shows, as data: the cells of three slices around a bot (top view at the feet with the floor under them and the head level over them, a vertical slice
// along its facing, one across it), read through a `blockAt(x, y, z)` of the bot's own world (what it planned on), and the overlays (its exact body, its route and target, the
// registered temporary blocks, the other bots, the last fall-guard hold, a cell named by the log line). Pure: the caller supplies the reads; JSON-serialisable for the event file.
//
// A cell: { n: name (bare), s: collision boxes [[x0,y0,z0,x1,y1,z1], ..] in the block (0..1), f: 'water' | 'lava' | null, p: state properties 'k=v,..' | '' } or null (not loaded).
const R = 6;                                  // cells each side of the bot: 13 x 13 per slice
const WET = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;

/** The axis the bot faces most (mineflayer's yaw: 0 looks to -Z, the look vector is (-sin yaw, -cos yaw)): { fx, fz } with one of them +-1. */
function facingOf(yaw) {
    const dx = -Math.sin(yaw || 0), dz = -Math.cos(yaw || 0);
    return Math.abs(dx) >= Math.abs(dz) ? { fx: Math.sign(dx) || 1, fz: 0 } : { fx: 0, fz: Math.sign(dz) || 1 };
}
const DIR = (fx, fz) => (fx > 0 ? 'east' : fx < 0 ? 'west' : fz > 0 ? 'south' : 'north');

/** The keys 'x,y,z' a scene around feet cell `c` reads (all three slices). */
function cellsOf(c, f, r = R) {
    const out = new Set(), rx = -f.fz, rz = f.fx;            // right hand of the facing (east -> south, north -> east)
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        for (const dy of [-1, 0, 1]) out.add(`${c.x + a},${c.y + dy},${c.z + b}`);
        out.add(`${c.x + f.fx * a},${c.y + b},${c.z + f.fz * a}`);
        out.add(`${c.x + rx * a},${c.y + b},${c.z + rz * a}`);
    }
    return out;
}

/** One cell from a mineflayer Block (or null). */
function cellOf(b) {
    if (!b) return null;
    const n = String(b.name || '?'), props = typeof b.getProperties === 'function' ? (() => { try { return b.getProperties(); } catch (_) { return {}; } })() : (b.props || {});
    const f = n === 'lava' ? 'lava' : WET.test(n) || props.waterlogged === true || props.waterlogged === 'true' ? 'water' : null;
    const s = Array.isArray(b.shapes) ? b.shapes.filter((q) => Array.isArray(q) && q.length === 6).slice(0, 16).map((q) => q.map((v) => Math.round(v * 1000) / 1000)) : [];
    return { n, s, f, p: Object.entries(props).map(([k, v]) => `${k}=${v}`).join(',') };
}

/**
 * Capture a scene. `blockAt(x, y, z)` -> a mineflayer Block or null; `pos` the bot's exact position; `yaw`; `over` the overlays
 * { path: [[x,y,z]..], temps: [{x,y,z,by}], others: [{name,x,y,z}], guard: {x,y,z,from,to}|null, mark: {x,y,z,label}|null, sneak }.
 */
function capture(blockAt, pos, yaw, over = {}, r = R) {
    const c = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-3), z: Math.floor(pos.z) }, f = facingOf(yaw);
    const pal = [], ix = new Map(), cells = {};
    const read = (k) => {
        if (k in cells) return pal[cells[k]];
        const [x, y, z] = k.split(',').map(Number);
        let b = null; try { b = blockAt(x, y, z); } catch (_) { b = null; }
        const cell = cellOf(b), j = JSON.stringify(cell);
        if (!ix.has(j)) { ix.set(j, pal.length); pal.push(cell); }
        cells[k] = ix.get(j);
        return cell;
    };
    for (const k of cellsOf(c, f, r)) read(k);
    // the top view shows the first block under the feet level of each column (a floating bot: how far it is to the ground): down to r cells
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let d = 1; d <= r; d++) { const cell = read(`${c.x + a},${c.y - d},${c.z + b}`); if (!cell || !/^(air|cave_air|void_air)$/.test(cell.n)) break; }
    return { r, c, pos: { x: pos.x, y: pos.y, z: pos.z }, yaw: yaw || 0, f, dir: DIR(f.fx, f.fz), pal, cells, diff: null, over: { path: [], temps: [], others: [], guard: null, mark: null, sneak: false, ...over } };
}

/** The bot's cell at x,y,z: a palette entry, or undefined outside the scene, null not loaded. */
const cellAt = (sc, x, y, z) => { const i = sc.cells[`${x},${y},${z}`]; return i === undefined ? undefined : sc.pal[i]; };

/** The state string `minecraft:name[k=v,..]` of a cell, for `execute if block`. */
const stateOf = (cell) => `minecraft:${cell.n}${cell.p ? `[${cell.p}]` : ''}`;

/**
 * The server's truth for the scene's cells, over RCON (`execute if block` per cell: the bot's state, then its name, then air), sequential so other RCON users interleave.
 * Fills sc.diff: { 'x,y,z': 'ghost' (bot: a block, server: air) | 'missing' (bot: air, server: a block) | 'state' (same block, other state) | 'other' (another block) }; cells that
 * agree are left out. `rcon(cmd)` -> reply text. Bounded by `budgetMs`; the cells not checked are counted in sc.unchecked.
 */
async function truth(sc, rcon, { budgetMs = 20000, now = Date.now } = {}) {
    const t0 = now(), diff = {}; let checked = 0, unchecked = 0;
    const pass = async (cmd) => /passed/i.test(String(await rcon(cmd)));
    // the cells nearest the bot first: a budget that runs out leaves the edges unchecked, not the body's cells
    const keys = Object.keys(sc.cells).sort((a, b) => dist(sc, a) - dist(sc, b));
    for (const k of keys) {
        const cell = sc.pal[sc.cells[k]];
        if (!cell) continue;
        if (now() - t0 > budgetMs) { unchecked++; continue; }
        const [x, y, z] = k.split(',');
        try {
            if (await pass(`execute if block ${x} ${y} ${z} ${stateOf(cell)}`)) { checked++; continue; }
            const air = /^(air|cave_air|void_air)$/.test(cell.n);
            if (air) diff[k] = 'missing';
            else if (await pass(`execute if block ${x} ${y} ${z} minecraft:${cell.n}`)) diff[k] = 'state';
            else diff[k] = (await pass(`execute if block ${x} ${y} ${z} minecraft:air`)) || (await pass(`execute if block ${x} ${y} ${z} minecraft:cave_air`)) ? 'ghost' : 'other';
            checked++;
        } catch (_) { unchecked++; }
    }
    sc.diff = diff; sc.checked = checked; sc.unchecked = unchecked;
    return sc;
}
function dist(sc, k) { const [x, y, z] = k.split(',').map(Number); return Math.abs(x - sc.c.x) + Math.abs(y - sc.c.y) + Math.abs(z - sc.c.z); }

module.exports = { R, facingOf, cellsOf, cellOf, capture, cellAt, stateOf, truth, DIR };

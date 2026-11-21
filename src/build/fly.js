'use strict';
// Creative flight: where a player's body fits (two cells of air, no portal), a shortest path through free cells (A*, 26 neighbours, no corner cutting), and the motion along it
// by position packets (physics off: the bot's own position is what mineflayer sends every tick). The server accepts any move that does not run into a block; a move it refuses
// comes back as a position correction ('forcedMove'), which ends the flight so the caller plans again.
const { Vec3 } = require('vec3');

const AVOID = new Set(['nether_portal', 'end_portal', 'end_gateway', 'cobweb', 'powder_snow', 'sweet_berry_bush', 'bubble_column', 'scaffolding', 'moving_piston', 'piston_head', 'fire', 'soul_fire', 'lava']);
const SPEED = 0.8;
const DIG_COST = 6;                      // a cell broken on the way costs as much as six cells of flight                       // blocks per tick (creative sprint-flight is ~1.1; the server's limit is ~10)
const key = (x, y, z) => `${x},${y},${z}`;

/** Can a body occupy this cell (no collision, nothing that teleports, slows or burns)? Unloaded = no. */
function free(bot, x, y, z, blocked) {
    if (blocked && (typeof blocked === 'function' ? blocked(x, y, z) : blocked.has(key(x, y, z)))) return false;
    const b = bot.blockAt(new Vec3(x, y, z), false);
    if (!b) return false;
    if (AVOID.has(b.name)) return false;
    return b.boundingBox === 'empty';
}
/** A body with its feet in cell (x, y, z): that cell and the one above. */
const fits = (bot, x, y, z, blocked) => free(bot, x, y, z, blocked) && free(bot, x, y + 1, z, blocked);

class Heap {
    constructor() { this.a = []; }
    push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= n.f) break; a[i] = a[p]; i = p; } a[i] = n; }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < (m === i ? last.f : a[m].f)) m = l; if (r < a.length && a[r].f < (m === i ? last.f : a[m].f)) m = r; if (m === i) break; a[i] = a[m]; i = m; } a[i] = last; } return top; }
    get size() { return this.a.length; }
}

const NEIGH = []; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) NEIGH.push([dx, dy, dz, Math.hypot(dx, dy, dz)]);

/**
 * Shortest flight from feet cell `a` to feet cell `b` (or to any cell `goal(x, y, z)` accepts). `blocked`: cells to keep out of (other bots' bodies, cells about to be built).
 * Returns [cells...] (a and b included) or null. Diagonal steps only when every cell the body sweeps is free.
 */
function path(bot, a, b, { blocked = null, maxNodes = 60000, goal = null, dig = null } = {}) {
    const done = goal || ((x, y, z) => x === b.x && y === b.y && z === b.z);
    const h = (x, y, z) => Math.hypot(x - b.x, y - b.y, z - b.z);
    const open = new Heap(), seen = new Map();
    open.push({ x: a.x, y: a.y, z: a.z, g: 0, f: h(a.x, a.y, a.z), p: null });
    seen.set(key(a.x, a.y, a.z), 0);
    // `dig(x, y, z)`: may this cell be broken on the way (a tunnel through terrain)? A cell to break costs DIG_COST more.
    const cellCost = new Map(), one = (x, y, z) => { const k = key(x, y, z); let v = cellCost.get(k); if (v === undefined) { v = free(bot, x, y, z, blocked) ? 0 : dig && !(blocked && (typeof blocked === 'function' ? blocked(x, y, z) : blocked.has(k))) && dig(x, y, z) ? DIG_COST : Infinity; cellCost.set(k, v); } return v; };
    const ok = new Map(), fitCost = (x, y, z) => { const k = key(x, y, z); let v = ok.get(k); if (v === undefined) { v = one(x, y, z) + one(x, y + 1, z); ok.set(k, v); } return v; };
    const fit = (x, y, z) => fitCost(x, y, z) === 0;
    let n = 0;
    while (open.size && n++ < maxNodes) {
        const c = open.pop();
        if (done(c.x, c.y, c.z)) { const out = []; for (let q = c; q; q = q.p) out.push({ x: q.x, y: q.y, z: q.z }); return out.reverse(); }
        if (c.g > (seen.get(key(c.x, c.y, c.z)) ?? Infinity)) continue;
        for (const [dx, dy, dz, d] of NEIGH) {
            const x = c.x + dx, y = c.y + dy, z = c.z + dz;
            const fc = fitCost(x, y, z);
            if (fc === Infinity) continue;
            if (fc > 0 && (dx !== 0) + (dy !== 0) + (dz !== 0) > 1) continue;           // tunnels go straight, one axis at a time
            if ((dx !== 0) + (dy !== 0) + (dz !== 0) > 1) {          // a diagonal step: the body sweeps the whole box between the two cells, every cell of it must fit
                let clear = true;
                for (let ix = Math.min(0, dx); ix <= Math.max(0, dx) && clear; ix++) for (let iy = Math.min(0, dy); iy <= Math.max(0, dy) && clear; iy++) for (let iz = Math.min(0, dz); iz <= Math.max(0, dz) && clear; iz++) if (!fit(c.x + ix, c.y + iy, c.z + iz)) clear = false;
                if (!clear) continue;
            }
            const g = c.g + d + fc, k = key(x, y, z);
            if (g >= (seen.get(k) ?? Infinity)) continue;
            seen.set(k, g);
            open.push({ x, y, z, g, f: g + h(x, y, z), p: c });
        }
    }
    return null;
}

/** Fewer waypoints: drop the middle of straight runs. */
function simplify(cells) {
    if (cells.length < 3) return cells;
    const out = [cells[0]];
    for (let i = 1; i < cells.length - 1; i++) {
        const a = out[out.length - 1], b = cells[i], c = cells[i + 1];
        const d1 = [b.x - a.x, b.y - a.y, b.z - a.z], d2 = [c.x - b.x, c.y - b.y, c.z - b.z];
        const n1 = Math.hypot(...d1), n2 = Math.hypot(...d2);
        if (Math.abs(d1[0] / n1 - d2[0] / n2) + Math.abs(d1[1] / n1 - d2[1] / n2) + Math.abs(d1[2] / n1 - d2[2] / n2) > 1e-6) out.push(b);
    }
    out.push(cells[cells.length - 1]);
    return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (c) => new Vec3(c.x + 0.5, c.y, c.z + 0.5);

/** Take the bot off physics and tell the server it flies (creative: allowed). Idempotent. */
function takeOff(bot) {
    if (!bot.__flying) {
        bot.physicsEnabled = false;
        if (bot.entity && bot.entity.velocity) bot.entity.velocity.set(0, 0, 0);
        bot.__flying = true;
        bot.on('respawn', () => { bot.__flying = false; });
        bot.on('game', () => { bot.__flying = false; });
    }
    try { bot._client.write('abilities', { flags: 2 }); } catch (_) { /* disconnected */ }
}

/**
 * Fly along `cells` (feet cells). Resolves {ok} at the end, {ok: false, reason: 'corrected'} when the server put the bot back (a block appeared in the way), 'cancelled' on cancel.
 * Every waypoint is a cell centre; the steps between are at most SPEED long, one per tick.
 */
async function along(bot, cells, cancel = { cancelled: false }, dig = null) {
    takeOff(bot);
    let corrected = false;
    const onForced = () => { corrected = true; };
    bot.on('forcedMove', onForced);
    try {
        for (const c of cells) {
            if (dig && !fits(bot, c.x, c.y, c.z)) {
                for (const y of [c.y, c.y + 1]) if (!free(bot, c.x, y, c.z)) await dig({ x: c.x, y, z: c.z });
                for (let w = 0; w < 10 && !fits(bot, c.x, c.y, c.z); w++) await sleep(50);
                if (!fits(bot, c.x, c.y, c.z)) return { ok: false, reason: 'dig_failed', at: c };
            }
            const target = center(c);
            for (;;) {
                if (cancel.cancelled) return { ok: false, reason: 'cancelled' };
                if (corrected) return { ok: false, reason: 'corrected', at: bot.entity.position.clone() };
                const p = bot.entity.position, d = target.minus(p), n = d.norm();
                if (n < 1e-6) break;
                const step = Math.min(SPEED, n);
                bot.entity.position = p.plus(d.scaled(step / n));
                bot.entity.velocity.set(0, 0, 0);
                await sleep(50);
            }
        }
        await sleep(60);
        if (corrected) return { ok: false, reason: 'corrected', at: bot.entity.position.clone() };
        return { ok: true };
    } finally { bot.removeListener('forcedMove', onForced); }
}

/** The feet cell the bot is in. */
const feet = (bot) => { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) }; };

/**
 * Fly to feet cell `to` (or to the nearest cell `goal` accepts), planning around `blocked`; up to `tries` plans when the server corrects the flight.
 * Returns {ok, reason, cells}.
 */
async function flyTo(bot, to, { blocked = null, goal = null, cancel, tries = 4, maxNodes, dig = null, canDig = null } = {}) {
    for (let t = 0; t < tries; t++) {
        const a = feet(bot);
        // a body inside blocks (put there, or a block placed into it): up into a cell where it fits, else the blocks of its own cells are broken (when allowed)
        if (!fits(bot, a.x, a.y, a.z, null)) {
            const p = bot.entity.position;
            if (fits(bot, a.x, a.y + 1, a.z, null)) { bot.entity.position = new Vec3(p.x, a.y + 1, p.z); await sleep(100); continue; }
            if (dig && canDig) { for (const y of [a.y, a.y + 1]) if (!free(bot, a.x, y, a.z) && canDig(a.x, y, a.z)) await dig({ x: a.x, y, z: a.z }); await sleep(120); }
        }
        let route = path(bot, a, to || a, { blocked, goal, maxNodes });
        let tunnel = false;
        if (!route && dig && canDig) { route = path(bot, a, to || a, { blocked, goal, maxNodes, dig: canDig }); tunnel = !!route; }
        if (!route) return { ok: false, reason: 'no_path', from: a };
        const r = await along(bot, tunnel ? route : simplify(route), cancel, tunnel ? dig : null);
        if (r.ok) return { ok: true, cells: route.length };
        if (r.reason === 'cancelled') return r;
        await sleep(150);
    }
    return { ok: false, reason: 'corrected_repeatedly' };
}

module.exports = { free, fits, path, simplify, along, flyTo, feet, takeOff, AVOID };

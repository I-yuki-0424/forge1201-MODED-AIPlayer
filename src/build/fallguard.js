'use strict';
// The fall guard: under every move a bot makes, a body that stands on support never moves sideways onto a column where it would fall more than `maxFall` (three: no damage) or
// land on something that hurts (lava, magma, fire, cactus ...). It works on the bot's own physics, tick by tick (the bot's client computes its position and the server takes it),
// so it holds whatever the controls do: momentum after a jump onto a pillar top, a jump that hit its head and came down short, a step off a corner, a push.
//
// Why not sneaking alone: sneaking stops a body at an edge only on the ground (prismarine-physics `control.sneak && onGround`, as vanilla), so it does nothing in a jump or
// after one (a jump that hit its head and came down short, the momentum of a landing), and the mover sneaks only where it expects an edge (the end of a run, a turn): a step
// planned as safe that is not (a block gone since the plan, a corner cut) is walked upright. Bots slipped off structures from early in every run and died of it in the tail
// (owner 2026-11-24, instruction 2).
//
// A planned drop is let through: the mover names the columns it may fall into and how far (`allow`), for the time of that move; a drop whose landing is not there when the
// body steps off is held like any other (five bots died one after the other dropping onto a temporary block that was gone, live 2026-11-25 hb2 w1).
const { Vec3 } = require('vec3');

// BlockTags.CLIMBABLE (1.21.1; src/native/physics/blocks.js): a body in such a cell does not fall (vanilla onClimbable clamps the fall and resets its distance), so a ladder or vine
// within the reach of a fall holds the body like a floor. The walk plans climb nodes and drops caught by a ladder (src/skills/planner.js); without this the guard held a bot that
// stepped onto a vine over a drop.
const CLIMBABLE = require('../native/physics/blocks').CLIMBABLE;
const HURTS = /^(lava|magma_block|fire|soul_fire|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose|pointed_dripstone|powder_snow)$/;
const HALF = 0.3;

/**
 * Is a body with its feet at (x, y, z) held within `depth` of its feet, by the block under any of the columns its box covers? Water within reach of the fall holds it too
 * (a fall into water does no damage); an unloaded cell counts as held (nothing is known, nothing is stopped).
 */
function held(world, x, y, z, depth) {
    for (const [cx, cz] of columns(x, z)) if (heldIn(world, cx, cz, y, depth, x, z)) return true;
    return false;
}
/** The cell columns a body's box at (x, z) covers. */
function columns(x, z) {
    const x0 = Math.floor(x - HALF + 1e-4), x1 = Math.floor(x + HALF - 1e-4), z0 = Math.floor(z - HALF + 1e-4), z1 = Math.floor(z + HALF - 1e-4), out = [];
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) out.push([cx, cz]);
    return out;
}
/**
 * Does column (cx, cz) hold a body with its feet at (x, y, z) within `depth`? Only block shapes under the body's box count: an open trapdoor is a plate along one side of its
 * cell, and four bots that stepped onto one fell through it (live 2026-11-25 hb3 w1).
 */
function heldIn(world, cx, cz, y, depth, x = cx + 0.5, z = cz + 0.5) {
    const fx0 = x - HALF - cx, fx1 = x + HALF - cx, fz0 = z - HALF - cz, fz1 = z + HALF - cz;          // the box in the cell's own coordinates
    const under = (sh) => sh[0] < fx1 - 1e-4 && sh[3] > fx0 + 1e-4 && sh[2] < fz1 - 1e-4 && sh[5] > fz0 + 1e-4;
    const p = new Vec3(0, 0, 0);
    for (let cy = Math.floor(y + 1e-3); cy >= Math.floor(y) - depth - 1; cy--) {
        p.set(cx, cy, cz);
        const b = world.getBlock(p);
        if (!b) return true;
        if (b.name === 'water' || b.name === 'bubble_column') return y - (cy + 1) <= depth + 1;
        if (CLIMBABLE.has(b.name)) return true;
        if (HURTS.test(b.name)) return false;
        const shapes = (b.shapes || []).filter(under);
        if (!shapes.length) continue;
        const t = cy + Math.max(...shapes.map((s) => s[4]));
        if (t > y + 0.01) continue;                       // a block beside the body (it is in this column above the feet): the collision handles it, look further down
        return y - t <= depth;                            // the first floor under the feet: near enough, or this column does not hold the body
    }
    return false;
}

/**
 * Install the guard on a bot (once; later calls return the same guard). guard.allow: null or a Map 'x,z' -> depth of the columns a planned drop may fall into and how far;
 * guard.on: false switches it off; guard.stops: how many ticks it held a body back (for the logs).
 */
function install(bot, { maxFall = 3 } = {}) {
    if (bot.__fallGuard) return bot.__fallGuard;
    const ph = bot.physics;
    if (!ph || typeof ph.simulatePlayer !== 'function') return null;
    const g = { on: true, allow: null, maxFall, stops: 0, lastStop: null, episodes: [] };
    const orig = ph.simulatePlayer.bind(ph);
    ph.simulatePlayer = (state, world) => {
        const x0 = state.pos.x, y0 = state.pos.y, z0 = state.pos.z;
        const out = orig(state, world);
        try {
            if (!g.on || state.isInWater || state.isInLava || state.elytraFlying) return out;
            const mode = bot.game && bot.game.gameMode;
            if (mode === 'creative' || mode === 'spectator') return out;
            const s = out || state, x = s.pos.x, z = s.pos.z;
            if (x === x0 && z === z0) return out;
            if (held(world, x, s.pos.y, z, g.maxFall)) return out;
            if (!held(world, x0, y0, z0, g.maxFall)) return out;          // already falling (a block taken from under it, a planned drop): not this guard's business
            if (g.allow) for (const [cx, cz] of columns(x, z)) { const d = g.allow.get(`${cx},${cz}`); if (d !== undefined && heldIn(world, cx, cz, s.pos.y, d, x, z)) return out; }
            // the part of the move along one axis that still holds the body is kept (it slides along the edge): undone as a whole, a bot perched on the rim of a block with a
            // step toward its target that also left the rim stood there for minutes (7 484 ticks held, live 2026-11-25 hb4 w1)
            if (held(world, x, s.pos.y, z0, g.maxFall)) { s.pos.z = z0; s.vel.z = 0; }
            else if (held(world, x0, s.pos.y, z, g.maxFall)) { s.pos.x = x0; s.vel.x = 0; }
            else { s.pos.x = x0; s.pos.z = z0; s.vel.x = 0; s.vel.z = 0; }
            g.stops++; g.lastStop = { at: Date.now(), x: Math.floor(x), y: Math.floor(s.pos.y), z: Math.floor(z) };
            note(g, bot, x0, y0, z0, x, s.pos.y, z, world);
        } catch (_) { /* the guard never breaks the physics tick */ }
        return out;
    };
    bot.__fallGuard = g;
    return g;
}

/**
 * One record per episode of stops (the same mover, within a second of the last stop): where the body was, where the move would have taken it, how often, and who moved it
 * (bot.__moveTag: the action-layer command and, in a walk, the path node it steered to). What tells a mover that plans into a fall from a body that was pushed.
 */
function note(g, bot, x0, y0, z0, x, y, z, world) {
    const now = Date.now(), tag = bot.__moveTag ? JSON.stringify(bot.__moveTag).slice(0, 300) : null, e = g.episodes[g.episodes.length - 1];
    if (e && now - e.last < 1000 && e.tag === tag) { e.n++; e.last = now; return; }
    const r2 = (v) => Math.round(v * 100) / 100;
    // what lies under the body where the move would have taken it (the cells of each column it covers, from the feet down four): a stop the planner did not expect names its block
    let under = null;
    try { under = columns(x, z).map(([cx, cz]) => `${cx},${cz}:` + [0, 1, 2, 3, 4].map((d) => { const b = world.getBlock(new Vec3(cx, Math.floor(y + 1e-3) - d, cz)); return b ? `${b.name}${b.shapes && b.shapes.length ? '' : '()'}` : '?'; }).join('/')).join(' '); } catch (_) { /* a record only */ }
    g.episodes.push({ at: now, last: now, n: 1, from: [r2(x0), r2(y0), r2(z0)], to: [r2(x), r2(y), r2(z)], tag, under });
    if (g.episodes.length > 16) g.episodes.shift();
}

/** Run fn with the columns `cols` ({x, z, depth}: a fall of at most `depth`) open for a planned drop; the guard closes them again afterwards. */
async function allowing(bot, cols, fn) {
    const g = bot.__fallGuard;
    if (!g) return fn();
    const prev = g.allow, m = new Map(prev || []);
    for (const c of cols) { const k = `${c.x},${c.z}`; m.set(k, Math.max(m.get(k) || 0, c.depth ?? g.maxFall)); }
    g.allow = m;
    try { return await fn(); } finally { g.allow = prev; }
}

module.exports = { install, allowing, held, heldIn, HURTS };

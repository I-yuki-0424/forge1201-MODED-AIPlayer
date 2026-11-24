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
// A planned drop is let through: the mover names the columns it may fall into (`allow`), for the time of that move.
const { Vec3 } = require('vec3');

const HURTS = /^(lava|magma_block|fire|soul_fire|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose|pointed_dripstone|powder_snow)$/;
const HALF = 0.3;

/**
 * Is a body with its feet at (x, y, z) held within `depth` of its feet, by the block under any of the columns its box covers? Water within reach of the fall holds it too
 * (a fall into water does no damage); an unloaded cell counts as held (nothing is known, nothing is stopped).
 */
function held(world, x, y, z, depth) {
    const x0 = Math.floor(x - HALF + 1e-4), x1 = Math.floor(x + HALF - 1e-4), z0 = Math.floor(z - HALF + 1e-4), z1 = Math.floor(z + HALF - 1e-4);
    const top = Math.floor(y + 1e-3), bottom = Math.floor(y) - depth - 1, p = new Vec3(0, 0, 0);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        for (let cy = top; cy >= bottom; cy--) {
            p.set(cx, cy, cz);
            const b = world.getBlock(p);
            if (!b) return true;
            if (b.name === 'water' || b.name === 'bubble_column') { if (y - (cy + 1) <= depth + 1) return true; break; }
            if (HURTS.test(b.name)) break;
            const shapes = b.shapes || [];
            if (!shapes.length) continue;
            const t = cy + Math.max(...shapes.map((s) => s[4]));
            if (t > y + 0.01) continue;                       // a block beside the body (it is in this column above the feet): the collision handles it, look further down
            if (y - t <= depth) return true;
            break;                                            // the first floor under the feet is too far down: this column does not hold the body
        }
    }
    return false;
}

/**
 * Install the guard on a bot (once; later calls return the same guard). guard.allow: null or a Set of 'x,z' columns a planned drop may fall into; guard.on: false switches it
 * off; guard.stops: how many ticks it held a body back (for the logs).
 */
function install(bot, { maxFall = 3 } = {}) {
    if (bot.__fallGuard) return bot.__fallGuard;
    const ph = bot.physics;
    if (!ph || typeof ph.simulatePlayer !== 'function') return null;
    const g = { on: true, allow: null, maxFall, stops: 0, lastStop: null };
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
            if (g.allow) { for (let cx = Math.floor(x - HALF); cx <= Math.floor(x + HALF); cx++) for (let cz = Math.floor(z - HALF); cz <= Math.floor(z + HALF); cz++) if (g.allow.has(`${cx},${cz}`)) return out; }
            s.pos.x = x0; s.pos.z = z0; s.vel.x = 0; s.vel.z = 0;
            g.stops++; g.lastStop = { at: Date.now(), x: Math.floor(x), y: Math.floor(s.pos.y), z: Math.floor(z) };
        } catch (_) { /* the guard never breaks the physics tick */ }
        return out;
    };
    bot.__fallGuard = g;
    return g;
}

/** Run fn with the columns `cols` ('x,z' strings or {x, z}) open for a planned fall; the guard closes them again afterwards. */
async function allowing(bot, cols, fn) {
    const g = bot.__fallGuard;
    if (!g) return fn();
    const prev = g.allow, set = new Set(prev || []);
    for (const c of cols) set.add(typeof c === 'string' ? c : `${c.x},${c.z}`);
    g.allow = set;
    try { return await fn(); } finally { g.allow = prev; }
}

module.exports = { install, allowing, held, HURTS };

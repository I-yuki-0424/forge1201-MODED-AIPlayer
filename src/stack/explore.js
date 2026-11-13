'use strict';
// Finding things that are not within reach yet (docs/proposed/ACCEPTANCE-v1.md): `gather` mines what the bot has loaded and can dig to; when nothing is there the goal layer
// (obtain.js) looks further. Rule-based, with the instructions through the router:
//   surface   (logs, sand ...) walk out on rings around where the search began and look again after each stop
//   prospect  (ores) dig a staircase down to the depth where the ore is common, then drive a tunnel and look again every few steps; the way back is the staircase, walked
// Pure given `deps` (here, w, command, travel, survey, cancelled): the tests drive it with a fake world.
const ORE_LEVEL = Object.freeze({ raw_iron: 16, coal: 48, raw_copper: 40, raw_gold: -16, diamond: -58, redstone: -58, lapis_lazuli: 0, emerald: 100 });
const DIRS = ['north', 'east', 'south', 'west'], VEC = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const RINGS = [80, 160, 240, 320, 480, 640], ANGLES = 8;
const FATAL = new Set(['died', 'disconnected', 'cancelled']);

/** Walk out on rings around the start until `found()` says the thing is near. Resolves {found, tried, stops}. */
async function surface(deps, found, { maxRing = 640 } = {}) {
    const a = deps.here(), stops = [];
    for (const r of RINGS) {
        if (r > maxRing) break;
        for (let k = 0; k < ANGLES; k++) {
            if (deps.cancelled && deps.cancelled()) return { found: false, stops, why: 'cancelled' };
            const th = (k / ANGLES) * 2 * Math.PI, t = { x: Math.round(a.x + r * Math.cos(th)), z: Math.round(a.z + r * Math.sin(th)) };
            const w = await deps.travel(t, { near: 8 });
            stops.push({ ring: r, to: [t.x, t.z], ok: !!w.ok });
            if (w.reason && FATAL.has(w.reason)) return { found: false, stops, why: w.reason };
            if (await found()) return { found: true, stops };
        }
    }
    return { found: false, stops, why: 'nothing found within the rings' };
}

/**
 * Dig down to `level` and tunnel until `found()` (the ore is within 24 blocks of the bot) or the steps run out; then walk back to where the shaft began.
 * `command('tunnel', {dir, dy})` is the router's: tool in hand, being sealed in, are not this function's business.
 */
async function prospect(deps, found, level, { maxStairs = 120, maxTunnel = 160 } = {}) {
    const entry = deps.here(), log = { stairs: 0, tunnel: 0, fails: [] };
    let dir = 0, fails = 0;
    const step = async (dy) => {
        for (let k = 0; k < 4; k++) {
            const r = await deps.command('tunnel', { dir: DIRS[dir], dy });
            if (r.ok) { fails = 0; return true; }
            if (FATAL.has(r.reason)) throw Object.assign(new Error(r.reason), { fatal: r.reason });
            // "Nothing to dig (a walk)": the cell ahead is already open (a cave, an old tunnel). That is no refusal, it is free ground: walk the step, and the search goes on from there
            // (acceptance world 4, 2026-11-13: such answers were counted as failures, turned the tunnel and ended it after six).
            if (deps.exec && r.detail && /nothing to dig/.test(String(r.detail.why || ''))) {
                const h = deps.here(), [vx, vz] = VEC[DIRS[dir]];
                const w = await deps.exec('move_to', { x: h.x + vx, y: h.y + dy, z: h.z + vz });
                if (w.ok) { fails = 0; return true; }
            }
            log.fails.push(`${DIRS[dir]}${dy ? ' ' + dy : ''}: ${(r.detail && r.detail.why) || r.reason}`); fails++;
            dir = (dir + 1) % 4;                                                    // water, lava, no floor, a drop: another way
        }
        return false;
    };
    try {
        while (deps.here().y > level && log.stairs < maxStairs) { if (!(await step(-1))) break; log.stairs++; }
        if (await found()) return { found: true, ...log, entry };
        while (log.tunnel < maxTunnel) {
            if (deps.cancelled && deps.cancelled()) break;
            // Ore in sight but not yet workable: head for it (the horizontal axis it is furthest along, a stair up or down when it lies two or more levels off), instead of a heading chosen blind
            let dy = 0;
            const tgt = deps.nearest ? await deps.nearest() : null;
            if (tgt) {
                const h = deps.here(), ddx = tgt.x - h.x, ddz = tgt.z - h.z, ddy = tgt.y - h.y;
                if (Math.abs(ddx) + Math.abs(ddz) > 0 || ddy) dir = DIRS.indexOf(Math.abs(ddx) >= Math.abs(ddz) ? (ddx > 0 ? 'east' : 'west') : (ddz > 0 ? 'south' : 'north'));
                if (Math.abs(ddy) >= 2 && Math.abs(ddx) + Math.abs(ddz) >= 1) dy = Math.sign(ddy);
            }
            if (!(await step(dy))) { dir = (dir + 1) % 4; if (++fails > 6) break; continue; }
            log.tunnel++;
            if (log.tunnel % 3 === 0 && await found()) return { found: true, ...log, entry };
            if (log.tunnel % 40 === 0) dir = (dir + 1) % 4;                         // a new strip, so that the search does not run along one line for ever
        }
    } catch (e) { if (!e.fatal) throw e; return { found: false, ...log, entry, why: e.fatal }; }
    return { found: !!(await found()), ...log, entry, why: 'the tunnel ended' };
}

/** After prospecting: back to the surface by the way the bot came (the staircase is a 1 x 2 corridor with steps of one block: walkable). */
async function back(deps, entry) { return deps.travel({ x: entry.x, y: entry.y, z: entry.z }, { near: 2, nearY: 3 }); }

module.exports = { surface, prospect, back, ORE_LEVEL, RINGS };

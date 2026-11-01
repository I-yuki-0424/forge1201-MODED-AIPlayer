'use strict';
// The client half of a faster game clock (tools/tickrate is the server half). With GAME_SPEED=k the server ticks every
// 50/k ms; the bot's client physics must tick as often, or every movement, jump and dig would be k times too slow from the
// server's point of view. Mineflayer's physics (lib/plugins/physics.js) advances one 50 ms step whenever performance.now()
// has moved on by 50 ms and polls with setInterval(doPhysics, 50). Both are scaled here, process-wide and once: the clock
// performance.now() reports runs k times faster, and the physics poll comes every 50/k ms, so each poll is one tick and the
// ticks are evenly spaced (not k-tick bursts). Game-time code (ticks) is unaffected; wall-clock timeouts stay wall time.
const { performance } = require('perf_hooks');

let applied = 1;

/** Run every bot in this process at k times the normal tick rate (1 <= k <= 10). Returns k. */
function setTimeScale(k) {
    k = Number(k);
    if (!(k >= 1 && k <= 10)) throw new Error(`time scale must be in [1, 10], got ${k}`);
    if (applied !== 1) { if (applied !== k) throw new Error(`time scale already ${applied}`); return k; }
    if (k === 1) return 1;
    const now = performance.now.bind(performance), t0 = now();
    performance.now = () => t0 + (now() - t0) * k;
    const si = global.setInterval;
    global.setInterval = function setIntervalScaled(fn, ms, ...rest) {
        return si.call(this, fn, fn && fn.name === 'doPhysics' ? ms / k : ms, ...rest);
    };
    applied = k;
    return k;
}

/** GAME_SPEED from the environment (default 1). */
const fromEnv = () => setTimeScale(process.env.GAME_SPEED || 1);

module.exports = { setTimeScale, fromEnv, get scale() { return applied; } };

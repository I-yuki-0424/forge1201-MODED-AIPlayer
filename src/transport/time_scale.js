'use strict';
// The client half of a faster (or slower) game clock. A server ticking k times as fast as 20 ticks/s (vanilla `/tick rate 20k` since 1.20.3,
// tools/tickrate on the Forge 1.20.1 server) needs the bot's client physics to tick as often, or every movement, jump and dig would be k times too
// slow from the server's point of view. Mineflayer's physics (lib/plugins/physics.js) advances one 50 ms step whenever performance.now() has moved on
// by 50 ms and polls with setInterval(doPhysics, 50). Both are scaled here, process-wide: the clock performance.now() reports runs k times faster,
// and the physics poll comes every 50/k ms, so each poll is one tick and the ticks are evenly spaced (not k-tick bursts). Game-time code (ticks) is
// unaffected; wall-clock timeouts stay wall time.
//
// Where k comes from (TASK-20261125-079): the server says it. Since 1.20.3 the server sends `set_ticking_state` (tick rate, frozen) when a player
// joins and whenever `/tick rate` changes; a vanilla client ticks at exactly that rate, so `follow(bot)` does the same and the clock changes while the
// bots run (performance.now() stays continuous, the physics poll is re-armed at the new period). GAME_SPEED is only the start value and the whole
// story on servers without the packet (Forge 1.20.1 with tools/tickrate). One rate per process: every bot of a process plays on one server.
const { performance } = require('perf_hooks');

const MIN = 0.1, MAX = 10;
const realNow = performance.now.bind(performance), realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
let k = 1, base = { real: realNow(), scaled: realNow() }, lastSaid = null;
const polls = new Set();          // the physics polls: { fn, args, timer }, re-armed when k changes

function install() {
    performance.now = () => base.scaled + (realNow() - base.real) * k;
    global.setInterval = function setIntervalScaled(fn, ms, ...args) {
        if (!(fn && fn.name === 'doPhysics')) return realSetInterval.call(this, fn, ms, ...args);
        const p = { fn, ms, args, timer: null };
        p.timer = realSetInterval(fn, ms / k, ...args);
        polls.add(p);
        const handle = { [Symbol.toPrimitive]: () => p.timer[Symbol.toPrimitive](), ref() { p.timer.ref(); return handle; }, unref() { p.timer.unref(); return handle; }, hasRef: () => p.timer.hasRef(), __poll: p };
        return handle;
    };
    global.clearInterval = function clearIntervalScaled(h) {
        if (h && h.__poll) { polls.delete(h.__poll); return realClearInterval(h.__poll.timer); }
        return realClearInterval(h);
    };
}
install();          // at load, before mineflayer arms its physics poll: a poll armed by the plain setInterval could not follow a later change

/** Run every bot in this process at `k` times the normal tick rate (0.1 <= k <= 10); may change while bots run. Returns k. */
function setTimeScale(next) {
    next = Number(next);
    if (!(next >= MIN && next <= MAX)) throw new Error(`time scale must be in [${MIN}, ${MAX}], got ${next}`);
    if (next === k) return k;
    const r = realNow();
    base = { real: r, scaled: base.scaled + (r - base.real) * k };       // the clock stays continuous across the change
    k = next;
    for (const p of polls) { realClearInterval(p.timer); p.timer = realSetInterval(p.fn, p.ms / k, ...p.args); }
    return k;
}

/** GAME_SPEED from the environment (default 1): the start value until the server says otherwise. */
const fromEnv = () => setTimeScale(process.env.GAME_SPEED || 1);

/**
 * Follow the server's tick rate (`set_ticking_state`, 1.20.3 and later): the client clock is set to tick_rate / 20 whenever the server sends it.
 * A rate outside [2, 200] ticks/s is clamped and said once (the client could not keep it; results at that rate are not comparable). Returns the bot.
 */
function follow(bot) {
    bot._client.on('set_ticking_state', (p) => {
        const rate = Number(p.tick_rate ?? p.tickRate);
        if (!(rate > 0)) return;
        const want = rate / 20, got = setTimeScale(Math.min(MAX, Math.max(MIN, want)));
        const said = `${rate}/${got}`;
        if (said !== lastSaid) {
            lastSaid = said;
            console.log(`[time_scale] server tick rate ${rate}/s${p.is_frozen ?? p.isFrozen ? ' (frozen)' : ''}: client clock x${got}${got !== want ? ` (clamped from x${want})` : ''}`);
        }
    });
    return bot;
}

module.exports = { setTimeScale, fromEnv, follow, get scale() { return k; } };

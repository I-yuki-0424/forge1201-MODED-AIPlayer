'use strict';
// node --require ./scripts/t26/loop_lag.js   (run.sh N TEST.js NODE_ARGS='--require ./scripts/t26/loop_lag.js')   the bot side of a test's speed (docs/implemented/SPEED-v1.md, TASK-20261125-079):
// every LOOP_EVERY_S seconds (default 30) one line with the harness process's event-loop delay (p50, p99, max: a stall of d ms holds every bot's keys for d*k/50 ticks at speed k, since
// mineflayer catches up the missed physics ticks in a burst with the old input), its CPU in % of one core, its memory, and the client clock factor.
const { monitorEventLoopDelay } = require('perf_hooks');
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
let cpu0 = process.cpuUsage(), w0 = Date.now();
const every = Number(process.env.LOOP_EVERY_S || 30) * 1000;
setInterval(() => {
    const c = process.cpuUsage(cpu0), w = Date.now() - w0, ms = (v) => Math.round(v / 1e6);
    const k = require('../../src/transport/time_scale').scale;
    console.log(`[loop] lag p50 ${ms(h.percentile(50))} p99 ${ms(h.percentile(99))} max ${ms(h.max)} ms | cpu ${Math.round((c.user + c.system) / 10 / w)} % | rss ${Math.round(process.memoryUsage().rss / 1048576)} MB | clock x${k}`);
    h.reset(); cpu0 = process.cpuUsage(); w0 = Date.now();
}, every).unref();

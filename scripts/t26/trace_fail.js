'use strict';
// node --require ./scripts/t26/trace_fail.js   (run.sh N TEST.js NODE_ARGS='--require ./scripts/t26/trace_fail.js')   test code: every runner command that does not end `ok` writes its per-tick
// trace (src/skills/runner.js rows: [t, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, onGround, hotbar]), its phases and the clock factor to /out/<RUN>/trace-fail.jsonl, so a failure seen
// at one game speed and not another can be read tick by tick (docs/implemented/SPEED-v1.md). Loaded before the bot code, as scripts/sim/record.js: later destructuring sees the wrapper.
const fs = require('fs'), path = require('path');
const runner = require(path.join(__dirname, '../../src/skills/runner.js'));
const file = `/out/${process.env.RUN || 'trace'}/trace-fail.jsonl`;
const orig = runner.run;
runner.run = async function run(bot, command, args, opts) {
    const r = await orig.call(this, bot, command, args, opts);
    if (!r.ok) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, JSON.stringify({ bot: bot && bot.username, command: command && command.name, reason: r.reason, detail: r.detail, clock: require('../../src/transport/time_scale').scale,
                ticks: r.ticks, ms: r.ms, phases: r.phases, trace: r.trace.slice(-240) }) + '\n');
        } catch (_) { /* a trace is never worth a failed test */ }
    }
    return r;
};

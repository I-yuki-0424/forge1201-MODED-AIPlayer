'use strict';
// One pure bot: claim units from the crew ledger, run them with the action layer, report. No decisions, no LLM, no learner
// (docs/proposed/WORKERS-v1.md). The loop is the same for every job kind; the job supplies `runUnit`.
const janitor = require('./janitor');
const { isBotSide } = require('./crew');

const MAX_BAD_STREAK = 12;     // consecutive failed units (each after a fix and a wait) before a bot cools down; the service brings it back
const BOT_NEEDS = new Set(['missing_tool', 'missing_item']);       // waiting for the operator, not a fault to retry
/** Seconds between attempts after the n-th failure in a row: 3, 5, 8, 12, 20, then 30. Problems of the world or the server often pass by themselves. */
const backoffMs = (n) => [3000, 5000, 8000, 12000, 20000, 30000][Math.min(n, 6) - 1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param job     { ledger, runUnit(regionId, unit, env) } (createPitJob, createBuildJob)
 * @param id      the bot's name in the ledger
 * @param env     { exec(name, args), w, have(item), inv(), here(), pos() -> {x,z}, now() -> ms }
 * @param opts    { cancel, policy (janitor), pollMs, batch, onEvent }
 * @returns       { ended: 'finished' | 'cancelled' | 'died' | 'disconnected', units, failed }
 */
async function runWorker(job, id, env, { cancel = { cancelled: false }, policy = null, pollMs = 500, batch = 1, onEvent = () => {}, backoff: backoffOpt } = {}) {
    const backoff = backoffOpt || backoffMs;
    const L = job.ledger, now = env.now || Date.now;
    let units = 0, failed = 0, idle = 0, streak = 0;
    L.join(id);
    const hb = setInterval(() => L.heartbeat(id, now()), Math.max(1000, L.leaseMs / 3));
    // Wait in slices so that a cancel is seen within a second.
    const wait = async (ms) => { for (let t = 0; t < ms && !cancel.cancelled; t += 500) await sleep(Math.min(500, ms - t)); };
    try {
        while (!cancel.cancelled) {
            const claim = L.claim(id, env.pos(), now(), { batch });
            if (!claim) {
                if (L.finished()) { if (job.cleanup) await job.cleanup(env); return { ended: 'finished', units, failed }; }
                // The next layer waits for units other bots are still running; if nobody is running anything, nothing will change.
                if (L.progress().leased === 0 && ++idle > 20) { L.leave(id, now()); return { ended: 'stalled', units, failed }; }
                await sleep(pollMs);
                continue;
            }
            idle = 0;
            for (const u of claim.units) {
                if (cancel.cancelled) { L.leave(id, now()); return { ended: 'cancelled', units, failed }; }
                if (policy) {
                    const m = await janitor.maintain(env, policy);        // a stalled janitor must not stall the job: log, carry on
                    if (!m.ok) onEvent('janitor_failed', { id, reason: m.reason, detail: m.detail });
                }
                const t0 = now();
                const r = await job.runUnit(claim.region, u, env);
                onEvent('unit', { id, region: claim.region, unit: u.unit, role: claim.role, ok: r.ok, reason: r.reason, ms: now() - t0, detail: r.detail });
                if (r.ok) { L.done(id, claim.region, u.unit, now()); units++; streak = 0; if (env.rememberGood) env.rememberGood(); continue; }
                failed++;
                L.fail(id, claim.region, u.unit, r.reason, now(), r.detail);
                if (r.reason === 'died' || r.reason === 'disconnected') { L.leave(id, now()); return { ended: r.reason, units, failed }; }
                for (const rest of claim.units) if (rest.unit > u.unit) L.fail(id, claim.region, rest.unit, 'cancelled', now());   // back to the pool, not counted
                if (BOT_NEEDS.has(r.reason)) { L.leave(id, now()); return { ended: 'unhealthy', units, failed, last: r.reason }; }   // it needs a tool or an item: the service waits for it
                streak++;
                if (streak >= MAX_BAD_STREAK) { L.leave(id, now()); return { ended: 'unhealthy', units, failed, last: r.reason }; }
                // Basic fixes before the next try: the ladder (wait / jump / sidestep / back to where it last worked) and a pause of a few seconds.
                onEvent('recover', { id, streak, reason: r.reason });
                if (env.recover) { try { await env.recover(streak + 1, r); } catch (_) { /* a failed fix is not a failed unit */ } }
                await wait(backoff(streak));
                break;
            }
        }
        L.leave(id, now());
        if (job.cleanup) await job.cleanup(env);
        return { ended: 'cancelled', units, failed };
    } finally { clearInterval(hb); }
}

/** The environment of a real Mineflayer bot on the action layer. */
function botEnv(bot, { cancel } = {}) {
    const { execute } = require('../skills');
    const { fromBot } = require('../skills/world');
    const { feetCell } = require('../skills/motion');
    const w = fromBot(bot);
    let good = null;                                             // the feet cell where the bot last finished a unit: a place it can stand and work
    const hold = async (key, ms) => { bot.setControlState(key, true); await sleep(ms); bot.setControlState(key, false); };
    /** One basic fix per level, then the caller waits: 2 jump, 3 step to a safe neighbouring cell, 4+ walk back to the last good place. */
    async function recover(level) {
        if (cancel && cancel.cancelled) return;
        if (level === 2) { await hold('jump', 350); await sleep(250); await hold('jump', 350); return; }
        if (level === 3) {
            const f = feetCell(bot.entity.position), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5);
            for (const [dx, dz] of dirs) {                       // free feet and head cell ahead, solid floor, no fluid or danger: safe to step into
                const k = (y) => w.kindAt(f.x + dx, f.y + y, f.z + dz);
                if (k(0) === 'air' && k(1) === 'air' && k(-1) === 'solid') {
                    await bot.look(Math.atan2(-dx, -dz), 0, true); await hold('forward', 350); return;
                }
            }
            await hold('jump', 350); return;
        }
        if (good) {
            const here = feetCell(bot.entity.position);
            if (Math.abs(here.x - good.x) + Math.abs(here.z - good.z) + Math.abs(here.y - good.y) > 2) await execute(bot, 'move_to', { x: good.x, y: good.y, z: good.z }, { cancel });
        }
    }
    return {
        w, now: Date.now, recover, rememberGood: () => { good = feetCell(bot.entity.position); },
        pause: (ticks) => sleep(ticks * 50),                       // let the thing in the way (another bot, an item) move on
        exec: (name, args) => execute(bot, name, args, { cancel }),
        have: (item) => bot.inventory.items().reduce((n, i) => n + (i.name === item ? i.count : 0), 0),
        inv: () => janitor.inventoryOf(bot),
        here: () => feetCell(bot.entity.position),
        pos: () => ({ x: bot.entity.position.x, z: bot.entity.position.z }),
    };
}

module.exports = { runWorker, botEnv, backoffMs, MAX_BAD_STREAK };

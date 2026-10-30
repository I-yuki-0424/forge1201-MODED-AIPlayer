'use strict';
// Entry point of the RL environment process: connects one bot to the Forge server, then serves episodes to a policy
// over the DPOD file API (two JSON-lines files, see docs/implemented/RL-INTERFACE-v1.md).
//   node src/rl/run_env.js --run-id r1 --root /exchange --spec min --ticks 4 --episodes 3 --goal '{"v":1,"type":"reach","offset":[5,0]}'   (--goal also takes a JSON array: episode i uses goals[i % n])
// Environment: MC_HOST MC_PORT RCON_HOST RCON_PORT RCON_PASSWORD (optional: RL_GROUND_Y, RL_PROFILE=vanilla|modded,
// RL_BOT_NAME, RL_ORIGIN_X, RL_ORIGIN_Z: one bot and one arena per process when several share a server).
// Options: --gap-ms N waits N ms after each terminal observation before the next reset (for graders that inspect the server).
const fs = require('fs');
const path = require('path');
const { createForgeBot, attachForgeHandshake } = require('../transport/forge_bot');
const { Rcon } = require('./rcon');
const { LineWriter, LineReader } = require('./jsonl_channel');
const { SPECS, specHash, checkSpec, validate } = require('./action_spec');
const { obsSpec } = require('./observation');
const { validateGoal, ITEMS } = require('./goal');
const { EventLog } = require('./events');
const { McEnv } = require('./env');

const ENV_VERSION = '2026-10-30';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mulberry32(a) {
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function parseArgs(argv) {
    const o = { root: '/exchange', runId: null, spec: 'min', ticks: 4, episodes: 1, goal: null, sample: null, seed: 0, actTimeout: 120, settleMs: 25, gapMs: 0 };
    for (let i = 0; i < argv.length; i += 2) {
        const k = argv[i], v = argv[i + 1];
        const map = { '--root': ['root'], '--run-id': ['runId'], '--spec': ['spec'], '--ticks': ['ticks', Number], '--episodes': ['episodes', Number],
            '--goal': ['goal', JSON.parse], '--sample': ['sample'], '--seed': ['seed', Number], '--act-timeout': ['actTimeout', Number], '--settle-ms': ['settleMs', Number], '--gap-ms': ['gapMs', Number] };
        if (!map[k] || v === undefined) throw new Error(`bad argument ${k}`);
        o[map[k][0]] = map[k][1] ? map[k][1](v) : v;
    }
    if (!o.runId) throw new Error('--run-id is required');
    if (!SPECS[o.spec]) throw new Error(`--spec must be one of ${Object.keys(SPECS)}`);
    if (!!o.goal === !!o.sample) throw new Error('give exactly one of --goal <json> and --sample reach|collect');
    return o;
}

/** Goals are fed directly (no LLM). `sample` draws a fresh goal per episode from the seeded generator. */
function goalFor(o, rng, episode) {
    if (o.goal) return validateGoal(Array.isArray(o.goal) ? o.goal[episode % o.goal.length] : o.goal);
    if (o.sample === 'reach') {
        const d = 3 + Math.floor(rng() * 6), ang = rng() * 2 * Math.PI;
        return validateGoal({ v: 1, type: 'reach', offset: [Math.round(d * Math.cos(ang) * 2) / 2, Math.round(d * Math.sin(ang) * 2) / 2] });
    }
    if (o.sample === 'collect') return validateGoal({ v: 1, type: 'collect', item: ITEMS[0], count: 1 });
    throw new Error(`unknown --sample ${o.sample}`);
}

const state = { closing: false };

async function connectBot(events, username) {
    const bot = createForgeBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username });
    attachForgeHandshake(bot, { inject: process.env.RL_PROFILE === 'modded' });
    bot.on('kicked', (r) => { if (state.closing) return; events.emit('kicked', { reason: String(r).slice(0, 200) }, 'error'); process.exit(4); });
    bot.on('error', (e) => events.emit('bot_error', { message: String(e.message || e).slice(0, 200) }, 'warn'));
    bot.on('end', (r) => { if (state.closing) return; events.emit('bot_end', { reason: String(r) }, 'error'); process.exit(5); });
    await new Promise((resolve, reject) => {
        bot.once('spawn', resolve);
        setTimeout(() => reject(new Error('no spawn within 60 s')), 60000);
    });
    const t0 = Date.now();
    while (bot.blockAt(bot.entity.position) == null) {
        if (Date.now() - t0 > 30000) throw new Error('chunks did not load');
        await sleep(50);
    }
    return bot;
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const dir = path.join(o.root, o.runId);
    fs.mkdirSync(dir, { recursive: true });
    const out = new LineWriter(path.join(dir, 'env_to_policy.jsonl'));
    const inp = new LineReader(path.join(dir, 'policy_to_env.jsonl'), { runId: o.runId, allowed: ['hello_ack', 'act'] });
    const botName = process.env.RL_BOT_NAME || 'RLBot0';
    const events = new EventLog(path.join(dir, 'events.jsonl'), { runId: o.runId, botId: botName });
    let seq = 0;
    const send = (type, fields) => out.send({ v: 1, type, run_id: o.runId, env_id: 0, seq: seq++, t: Math.round(Date.now()) / 1000, ...fields });

    const spec = checkSpec(SPECS[o.spec](o.ticks));
    events.emit('run_start', { env_version: ENV_VERSION, spec: spec.name, ticks_per_step: spec.ticks_per_step, spec_hash: specHash(spec), episodes: o.episodes, seed: o.seed, goal_source: o.goal ? 'fixed' : `sample:${o.sample}` });
    const rcon = new Rcon({ host: process.env.RCON_HOST || 'localhost', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '' });
    await rcon.connect();
    for (const rule of ['doDaylightCycle false', 'doMobSpawning false', 'doWeatherCycle false', 'doImmediateRespawn true', 'announceAdvancements false', 'sendCommandFeedback false', 'logAdminCommands false', 'randomTickSpeed 0', 'doTileDrops true']) await rcon.command(`gamerule ${rule}`);
    await rcon.command('time set day');
    const bot = await connectBot(events, botName);
    const mcData = require('minecraft-data')(bot.version);
    const env = new McEnv({ bot, rcon, spec, mcData, events, groundY: Number(process.env.RL_GROUND_Y ?? -61), settleMs: o.settleMs,
        originX: Number(process.env.RL_ORIGIN_X ?? 0.5), originZ: Number(process.env.RL_ORIGIN_Z ?? 0.5) });
    events.emit('connected', { username: bot.username, version: bot.version, origin: [env.originX, env.originZ] });
    await env.preflight();      // a failure here ends the run before any observation is sent

    send('hello', { env_version: ENV_VERSION, action_spec: spec, obs_spec: obsSpec() });
    const queue = [];
    const pump = () => { for (const m of inp.poll()) queue.push(m); };
    const next = async (pred, timeoutMs) => {
        const t0 = Date.now();
        for (;;) {
            pump();
            const i = queue.findIndex(pred);
            if (i >= 0) return queue.splice(i, 1)[0];
            if (Date.now() - t0 > timeoutMs) return null;
            await sleep(3);
        }
    };
    const ack = await next((m) => m.type === 'hello_ack', 60000);
    if (!ack || !ack.accepted) { events.emit('hello_refused', { reason: ack ? ack.reason : 'no hello_ack in 60 s' }, 'error'); send('bye', {}); process.exit(3); }
    if (ack.action_spec_hash !== specHash(spec)) { events.emit('spec_hash_mismatch', { ours: specHash(spec), theirs: ack.action_spec_hash }, 'error'); send('bye', {}); process.exit(3); }

    let stopped = null;
    for (let episode = 0; episode < o.episodes && !stopped; episode++) {
        const rng = mulberry32((o.seed * 1000003 + episode) >>> 0);
        let msg = await env.reset(goalFor(o, rng, episode), rng, episode);
        let step = 0;
        for (;;) {
            send('obs', { episode, step, ...msg });
            if (msg.terminated || msg.truncated) { await sleep(o.gapMs); break; }   // gap: lets an external grader read the server state
            const t0 = Date.now();
            const act = await next((m) => m.type === 'act' && m.episode === episode && m.step === step, o.actTimeout * 1000);
            if (!act) { stopped = 'no act within timeout'; break; }
            try { validate(spec, act.action); } catch (e) { events.emit('invalid_act', { episode, step, reason: e.message }, 'error'); stopped = 'invalid act'; break; }
            const policyWaitMs = Date.now() - t0;
            msg = await env.step(act.action);
            events.emit('step_timing', { episode, step: step + 1, policy_wait_ms: policyWaitMs });
            step++;
        }
    }
    events.emit('run_end', { reason: stopped || 'episodes done' }, stopped ? 'warn' : 'info');
    send('bye', {});
    state.closing = true;
    env.controls.release();
    rcon.close(); out.close(); events.close();
    bot.end();
    setTimeout(() => process.exit(stopped ? 6 : 0), 200);
}

if (require.main === module) main().catch((e) => { console.error('[rl-env] fatal:', e.message); process.exit(1); });

module.exports = { parseArgs, goalFor, mulberry32 };

'use strict';
// RL v2 environment process (docs/proposed/RL-TRAINING-v2.md): N bots in one survival world, skill-level actions, reward v2.
// Serves the DPOD file API (PROTOCOL.md v1) with env_id = bot index. Inference is on demand: a bot sends its observation
// when its previous command has ended, so bots step at their own pace and the policy answers each one as it arrives.
//   node src/rl/run_skill_env.js --base train1 --bots 4 [--root /exchange] [--max-steps 20000] [--region 576] [--seed 1]
// Every start is a new run (<base>-<UTC time>, PROTOCOL.md: a new environment process = a new run_id); <root>/<base>.current
// names the latest, so a learner can follow restarts. An episode is one life: it ends on death (terminated) or after
// --max-steps commands (truncated). Reset over RCON: revoke advancements, clear inventory and effects, xp 0, survival, a
// random site in the pre-generated region (scripts/skills/bench_lv2.js --pregen 1, docs/LESSONS.md L10).
// Environment: MC_HOST MC_PORT RCON_HOST RCON_PORT RCON_PASSWORD, BOT_REGISTRY (default auto), RL_BOT_PREFIX (default Train).
const fs = require('fs');
const path = require('path');
const { createForgeBot, attachForgeHandshake } = require('../transport/forge_bot');
const { Rcon } = require('./rcon');
const { LineWriter, LineReader } = require('./jsonl_channel');
const { EventLog } = require('./events');
const { mulberry32 } = require('./run_env');
const { execute } = require('../skills');
const { fromBot, standable } = require('../skills/world');
const { Vec3 } = require('vec3');
const { ProgressTracker } = require('./progress');
const { CrafterReward, TABLE, TERMS, MILESTONES, NOTABLE } = require('./crafter_reward');
const { SkillSpace, vocab, obsSpec, actionSpec, K, CMDS, REASON_LIST } = require('./skill_space');
const { LiveBoard } = require('./live_board');

const ENV_VERSION = '2026-11-01-skills-v1.1';   // v1.1: reward term `invalid`, live board, one tick minimum per step
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAMERULES = ['doDaylightCycle true', 'doMobSpawning true', 'doImmediateRespawn true', 'keepInventory false',
    'playersSleepingPercentage 1', 'announceAdvancements false', 'sendCommandFeedback false', 'logAdminCommands false', 'spawnRadius 0'];

function parseArgs(argv) {
    const o = { root: '/exchange', base: null, bots: 4, maxSteps: 20000, region: 576, seed: 1, actTimeout: 600 };
    const map = { '--root': ['root'], '--base': ['base'], '--bots': ['bots', Number], '--max-steps': ['maxSteps', Number],
        '--region': ['region', Number], '--seed': ['seed', Number], '--act-timeout': ['actTimeout', Number] };
    for (let i = 0; i < argv.length; i += 2) {
        const m = map[argv[i]];
        if (!m || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
        o[m[0]] = m[1] ? m[1](argv[i + 1]) : argv[i + 1];
    }
    if (!/^[a-z0-9_-]{1,40}$/i.test(o.base || '')) throw new Error('--base <name> is required ([a-z0-9_-])');
    if (!(o.bots >= 1 && o.bots <= 16)) throw new Error('--bots must be 1..16');
    return o;
}

/** One RCON connection, one command at a time (docs/LESSONS.md L9). */
function queued(rcon) {
    let tail = Promise.resolve();
    return (cmd) => { const p = tail.then(() => rcon.command(cmd)); tail = p.catch(() => {}); return p; };
}

/** Run `ticks` physics ticks doing nothing (the 'wait' candidate; also how a sleeping bot passes the night). */
function idle(bot, ticks, cancel) {
    return new Promise((resolve) => {
        let n = 0;
        const on = () => { if (++n >= ticks || cancel.cancelled) { bot.removeListener('physicsTick', on); resolve({ ok: !cancel.cancelled, reason: cancel.cancelled ? 'cancelled' : undefined, ticks: n }); } };
        bot.on('physicsTick', on);
    });
}

/** What a candidate is about, in words, for the live board (block, entity or item names; never sent to the policy). */
function describe(bot, c) {
    const a = c.args || {};
    const at = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b ? b.name : '?'; };
    const ent = (id) => { const e = bot.entities[id]; return e ? (e.name === 'item' && e.getDroppedItem && e.getDroppedItem() ? `item ${e.getDroppedItem().name}` : e.name) : `#${id}`; };
    const dist = (x, y, z) => (bot.entity ? Math.round(bot.entity.position.distanceTo(new Vec3(x + 0.5, y, z + 0.5))) : '?');
    switch (c.cmd) {
        case 'move_to': return `(${a.x} ${a.y} ${a.z}) ${dist(a.x, a.y, a.z)} m`;
        case 'mine': case 'activate': return `${at(a.x, a.y, a.z)} (${a.x} ${a.y} ${a.z}) ${dist(a.x, a.y, a.z)} m`;
        case 'attack': case 'pickup': return ent(a.entity);
        case 'place': return `${a.item} (${a.x} ${a.y} ${a.z})`;
        case 'wait': return `${a.ticks} ticks`;
        default: return a.item ? `${a.item}${a.count ? ` x${a.count}` : ''}` : '';
    }
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const runId = `${o.base}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
    const dir = path.join(o.root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(o.root, `${o.base}.current`), runId + '\n');
    const out = new LineWriter(path.join(dir, 'env_to_policy.jsonl'));
    const inp = new LineReader(path.join(dir, 'policy_to_env.jsonl'), { runId, allowed: ['hello_ack', 'act'] });
    const events = new EventLog(path.join(dir, 'events.jsonl'), { runId, botId: 'all', component: 'skill_env' });
    let seq = 0;
    // The live board for the human watcher: <root>/<base>.live.json, rewritten once a second (tools/train-dash serves it).
    const board = new LiveBoard({ run: runId, base: o.base });
    const liveFile = path.join(o.root, `${o.base}.live.json`);
    setInterval(() => { try { board.write(liveFile); } catch (e) { /* the next second retries */ } }, 1000).unref();
    const send = (envId, type, fields) => out.send({ v: 1, type, run_id: runId, env_id: envId, seq: seq++, t: Math.round(Date.now()) / 1000, ...fields });

    // Acts are routed to the waiting bot by (env_id, episode, step); anything else is logged and dropped.
    const waiters = new Map(), acks = new Map();
    setInterval(() => {
        for (const m of inp.poll()) {
            if (m.type === 'hello_ack') { acks.set(m.env_id, m); continue; }
            const w = waiters.get(m.env_id);
            if (w && w.episode === m.episode && w.step === m.step) { waiters.delete(m.env_id); w.resolve(m); }
            else events.emit('stale_act', { env_id: m.env_id, episode: m.episode, step: m.step }, 'warn');
        }
    }, 5).unref();
    const nextAct = (envId, episode, step) => new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(envId); resolve(null); }, o.actTimeout * 1000);
        waiters.set(envId, { episode, step, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });

    const rcon = new Rcon({ host: process.env.RCON_HOST || 'localhost', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '' });
    await rcon.connect();
    const cmd = queued(rcon);
    for (const g of GAMERULES) await cmd(`gamerule ${g}`);
    const mcData = require('minecraft-data')('1.20.1');
    const voc = vocab(mcData, (() => { try { return require('../../modpack/forgeaip-create.registry.json'); } catch { return null; } })());
    const hello = { env_version: ENV_VERSION, action_spec: actionSpec(), obs_spec: obsSpec(),
        vocab_sizes: { item: voc.items.length, entity: voc.entities.length, cmd: CMDS.length, reason: REASON_LIST.length, category: 11 },
        milestones: MILESTONES, notable: NOTABLE, reward_terms: TERMS, stages: TABLE.stages, reward_table_version: TABLE.v };
    events.emit('run_start', { env_version: ENV_VERSION, bots: o.bots, max_steps: o.maxSteps, region: o.region, seed: o.seed, K });

    // A bot that is lost (kick, timeout, closed socket) ends the whole run: the container restarts (unless-stopped) with all
    // bots and a new run id, which the learner follows. Waiting for the others would train on fewer bots indefinitely.
    let ended = false;
    const finish = (fatal) => {
        if (ended) return; ended = true;
        events.emit('run_end', { reason: fatal || 'done' }, fatal ? 'error' : 'info');
        for (let i = 0; i < o.bots; i++) send(i, 'bye', {});
        out.close(); events.close(); rcon.close();
        setTimeout(() => process.exit(fatal ? 6 : 0), 300);
    };
    const prefix = process.env.RL_BOT_PREFIX || 'Train';
    await Promise.all(Array.from({ length: o.bots }, (_, i) => sleep(i * 4000).then(() => !ended && runBot(i, `${prefix}${i}`)).catch((e) => {
        if (ended) return;
        events.emit('bot_fatal', { env_id: i, message: String(e.message).slice(0, 300) }, 'error');
        finish(`${prefix}${i}: ${e.message}`);
    })));
    finish(null);

    async function runBot(envId, name) {
        const bot = createForgeBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: name });
        attachForgeHandshake(bot, { registry: process.env.BOT_REGISTRY || 'auto' });
        const lost = new Promise((_, reject) => {
            bot.on('kicked', (r) => reject(new Error(`kicked: ${String(r).slice(0, 200)}`)));
            bot.on('end', (r) => reject(new Error(`connection ended: ${r}`)));
        });
        lost.catch(() => {});
        bot.on('error', (e) => events.emit('bot_error', { env_id: envId, message: String(e.message || e).slice(0, 200) }, 'warn'));
        await Promise.race([new Promise((r) => bot.once('spawn', r)), lost, sleep(90000).then(() => { throw new Error('no spawn within 90 s'); })]);
        lost.catch((e) => board.lost(envId, e.message));
        const tracker = new ProgressTracker(bot), space = new SkillSpace(bot, voc), reward = new CrafterReward();
        board.attach(envId, name, bot);
        let cancel = { cancelled: false };
        bot.on('death', () => { cancel.cancelled = true; });
        events.emit('connected', { env_id: envId, username: name });
        send(envId, 'hello', hello);
        for (let t = 0; !acks.has(envId); t++) { if (t > 6000) throw new Error('no hello_ack within 60 s'); await sleep(10); }
        if (!acks.get(envId).accepted) throw new Error(`hello refused: ${acks.get(envId).reason}`);

        const rng = mulberry32((o.seed * 7919 + envId) >>> 0);
        for (let episode = 0; ; episode++) {
            await Promise.race([reset(bot, name, rng), lost]);
            await tracker.begin(); reward.newEpisode(); cancel = { cancelled: false };
            let msg = { reward: 0, reward_terms: Object.fromEntries(TERMS.map((t) => [t, 0])), terminated: false, truncated: false };
            let last = { reason: 'ok', ticks: 0 };
            const ep = { ret: 0, nights: 0, slept: 0, t0: Date.now(), cmds: {} };
            for (let step = 0; ; step++) {
                send(envId, 'obs', { episode, step, obs: space.observe(reward.progress(), last), ...msg });
                if (msg.terminated || msg.truncated) break;
                const act = await Promise.race([nextAct(envId, episode, step), lost]);
                if (!act) throw new Error(`no act for episode ${episode} step ${step} within ${o.actTimeout} s`);
                const c = space.cands[act.action && act.action.candidate];
                let res;
                const t0 = Date.now();
                board.begin(envId, { episode, step, cmd: c ? c.cmd : 'invalid', label: c ? describe(bot, c) : '', index: act.action && act.action.candidate,
                    offered: space.cands.map((x) => x.cmd) });
                let ticks = 0;
                const count = () => { ticks++; };
                bot.on('physicsTick', count);
                if (!c) { events.emit('invalid_candidate', { env_id: envId, episode, step, candidate: act.action && act.action.candidate }, 'warn'); res = await idle(bot, 20, cancel); res.reason = 'invalid_args'; }
                else if (c.cmd === 'wait') res = await idle(bot, c.args.ticks, cancel);
                else res = await Promise.race([execute(bot, c.cmd, c.args, { cancel }), lost]);
                // A command refused before any input (unreachable, missing tool, ...) still costs one game tick, so a policy
                // that keeps choosing such commands cannot spin hundreds of steps a second (run train-20261101T012004: 5 ms).
                if (ticks === 0) await Promise.race([new Promise((r) => bot.once('physicsTick', r)), sleep(200)]);
                bot.removeListener('physicsTick', count);
                if (tracker.dead || bot.health <= 0) await sleep(300);   // let the death packet and the last statistics arrive
                const { events: evs, statsOk } = await tracker.collect();
                if (!res.ok) evs.push({ type: 'failed', reason: res.reason });   // scored by reward term `invalid`
                const sc = reward.score(evs);
                const dead = tracker.dead;
                msg = { reward: sc.total, reward_terms: sc.terms, terminated: dead, truncated: !dead && step + 1 >= o.maxSteps };
                last = { reason: res.ok ? 'ok' : res.reason, ticks: Math.max(ticks, 1) };
                ep.ret += sc.total; ep.cmds[c ? c.cmd : 'invalid'] = (ep.cmds[c ? c.cmd : 'invalid'] || 0) + 1;
                let nights = 0, slept = 0;
                for (const e of evs) if (e.type === 'dawn') { nights++; if (e.slept) slept++; }
                ep.nights += nights; ep.slept += slept;
                board.end(envId, { ok: !!res.ok, reason: last.reason, ms: Date.now() - t0, ticks: last.ticks, reward: sc.total, nights, slept });
                events.emit('step', { env_id: envId, episode, step: step + 1, cmd: c ? c.cmd : null, args: c ? c.args : null, ok: !!res.ok,
                    reason: last.reason, ticks: last.ticks, ms: Date.now() - t0, reward: sc.total, terms: sc.terms,
                    progress_events: evs.length ? evs : undefined, stats_ok: statsOk || undefined, health: bot.health, food: bot.food });
            }
            const rec = { env_id: envId, episode, return: Math.round(ep.ret * 1e4) / 1e4, nights: ep.nights, slept: ep.slept,
                wall_s: Math.round((Date.now() - ep.t0) / 1000), terminated: msg.terminated, cmds: ep.cmds };
            events.emit('episode_end', rec);
            board.episodeEnd(envId, rec);
            if (msg.terminated) {
                for (let t = 0; bot.health <= 0 && t < 600; t++) await sleep(50);   // auto-respawn
                await sleep(1000);
            }
        }
    }

    async function reset(bot, name, rng) {
        if (bot.health <= 0) { try { bot.respawn(); } catch { /* auto-respawn */ } await sleep(1500); }
        for (const c of [`gamemode survival ${name}`, `advancement revoke ${name} everything`, `clear ${name}`, `effect clear ${name}`,
            `xp set ${name} 0 levels`, `xp set ${name} 0 points`]) await cmd(c);
        // spreadplayers refuses sites without safe ground (ocean: "Could not spread") and may still land in shallow water,
        // where the action layer cannot act (no swimming, SKILLS-v1 limits): draw another site until the bot stands dry.
        const R = o.region - 64, w = fromBot(bot);
        let why = '';
        for (let i = 0; i < 30; i++) {
            const pos = bot.entity.position.clone();
            const reply = String(await cmd(`spreadplayers ${Math.round((rng() * 2 - 1) * R)} ${Math.round((rng() * 2 - 1) * R)} 0 24 false ${name}`));
            if (!/^Spread/.test(reply)) { why = reply.slice(0, 120); continue; }
            for (let t = 0; t < 200 && bot.entity.position.distanceTo(pos) < 1; t++) await sleep(50);   // the teleport arrived
            for (let t = 0; t < 100 && !bot.blockAt(bot.entity.position.offset(0, -1, 0)); t++) await sleep(50);   // its chunk too
            await sleep(300);
            const p = bot.entity.position, x = Math.floor(p.x), y = Math.floor(p.y + 0.2), z = Math.floor(p.z);
            if (!bot.entity.isInWater && standable(w, x, y, z)) { why = ''; break; }
            why = 'landed in water or not on dry ground';
        }
        if (why) throw new Error(`reset: no dry site in 30 tries (${why})`);
        for (let t = 0; t < 200 && bot.inventory.items().length; t++) await sleep(50);
        await sleep(500);
        await cmd(`spawnpoint ${name} ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}`);
    }
}

if (require.main === module) main().catch((e) => { console.error('[skill-env] fatal:', e.message); process.exit(1); });

module.exports = { parseArgs, queued, idle, describe, GAMERULES, ENV_VERSION };

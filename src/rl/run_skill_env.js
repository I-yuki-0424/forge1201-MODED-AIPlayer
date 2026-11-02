'use strict';
// RL v2 environment process (docs/proposed/RL-TRAINING-v2.md): N bots in one survival world, skill-level actions, reward v2.
// Serves the DPOD file API (PROTOCOL.md v1) with env_id = bot index. Inference is on demand: a bot sends its observation
// when its previous command has ended, so bots step at their own pace and the policy answers each one as it arrives.
//   node src/rl/run_skill_env.js --base train1 --bots 4 [--root /exchange] [--max-steps 20000] [--region 576] [--seed 1]
// Every start is a new run (<base>-<UTC time>, PROTOCOL.md: a new environment process = a new run_id); <root>/<base>.current
// names the latest, so a learner can follow restarts. An episode is one life: it ends on death (terminated) or after
// --max-steps commands (truncated). Reset over RCON: revoke advancements, clear inventory and effects, xp 0, survival, a
// random site in the pre-generated region (scripts/skills/bench_lv2.js --pregen 1, docs/LESSONS.md L10), or with --sites FILE
// a fixed start per bot (bot k of every shard at sites[k]: pairs with the same start in different worlds, owner 2026-11-02).
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
const { SkillSpace, vocab, obsSpec, actionSpec, K, CMDS, REASON_LIST, VIEW_H, VIEW_W } = require('./skill_space');
const { LiveBoard } = require('./live_board');

// v1.1: term `invalid`, live board, one tick minimum per step; v1.2: stuck cut; v1.3: swimming, ladders, `tunnel`, candidates
// only what the action layer can do (K 64), a sector of the region per bot, game speed (tools/tickrate + GAME_SPEED);
// v2.0 (DPOD TASK-20261101-031): observation fields view_* (first-hit image of the field of view), killed (kills this episode
// per entity type), clock (episode age, step); mine candidates use the command's own reach-and-visibility goal;
// v2.1: --sites (fixed start per bot, `start` in hello: site index = pair across shards), reward table v4 (no achievement
// paid in the step of a death, create:root unscored)
const ENV_VERSION = '2026-11-02-skills-v2.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chunks a bot asks the server for: it acts within about 20 blocks (candidates, the reachability flood), so 5 is ample and
// keeps chunk sending and parsing low with many bots (mineflayer's default 'far' = 12, capped by the server's 8).
const VIEW = Number(process.env.RL_VIEW_DISTANCE) || 5;
const GAMERULES = ['doDaylightCycle true', 'doMobSpawning true', 'doImmediateRespawn true', 'keepInventory false',
    'playersSleepingPercentage 1', 'announceAdvancements false', 'sendCommandFeedback false', 'logAdminCommands false', 'spawnRadius 0'];

function parseArgs(argv) {
    const o = { root: '/exchange', base: null, bots: 4, maxSteps: 20000, region: 576, seed: 1, actTimeout: 600, shard: -1, sites: null };
    const map = { '--root': ['root'], '--base': ['base'], '--bots': ['bots', Number], '--max-steps': ['maxSteps', Number],
        '--region': ['region', Number], '--seed': ['seed', Number], '--act-timeout': ['actTimeout', Number], '--shard': ['shard', Number],
        '--sites': ['sites', (f) => (f ? loadSites(f) : null)] };
    for (let i = 0; i < argv.length; i += 2) {
        const m = map[argv[i]];
        if (!m || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
        o[m[0]] = m[1] ? m[1](argv[i + 1]) : argv[i + 1];
    }
    if (!/^[a-z0-9_-]{1,40}$/i.test(o.base || '')) throw new Error('--base <name> is required ([a-z0-9_-])');
    if (!(o.bots >= 1 && o.bots <= 16)) throw new Error('--bots must be 1..16');
    if (!(Number.isInteger(o.shard) && o.shard >= -1 && o.shard <= 15)) throw new Error('--shard must be 0..15');
    if (o.sites && o.sites.length < o.bots) throw new Error(`--sites: ${o.sites.length} sites for ${o.bots} bots`);
    return o;
}

/** Start sites: {"sites": [[x, y, z], ...]} with integer block coordinates inside the world border (y = the feet). */
function loadSites(file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isInteger) && Math.abs(v[0]) < 29999984 && Math.abs(v[2]) < 29999984 && v[1] > -64 && v[1] < 320;
    if (!Array.isArray(j.sites) || !j.sites.length || !j.sites.every(ok)) throw new Error(`--sites ${file}: "sites" must be [[x, y, z], ...] of integers`);
    return j.sites;
}

/** Columns around (x, z) out to radius r, nearest first, ties in a fixed order (the same search in every world). */
function ring(x, z, r) {
    const out = [];
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) out.push([dx * dx + dz * dz, dx, dz]);
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map(([, dx, dz]) => [x + dx, z + dz]);
}

/** One RCON connection, one command at a time (docs/LESSONS.md L9). A command that times out is sent again (up to `retries`
 *  times): replies are matched by request id and late ones dropped (src/rl/rcon.js), and every command the environment sends
 *  is safe to repeat. A lagging server used to end the whole run on one 5 s timeout (run train4: 8 restarts of shard 0 in an
 *  hour, every bot reset each time). */
function queued(rcon, { retries = 2 } = {}) {
    let tail = Promise.resolve();
    const once = async (cmd) => {
        for (let i = 0; ; i++) {
            try { return await rcon.command(cmd); } catch (e) { if (i >= retries || !/timeout/.test(String(e.message))) throw e; }
        }
    };
    return (cmd) => { const p = tail.then(() => once(cmd)); tail = p.catch(() => {}); return p; };
}

/** Stuck detector: true once fewer than `minOk` of the last `n` commands were successful commands other than `wait` and the
 *  bot stayed within `radius` blocks. The action layer cannot act there (a pit, a tree top), so the episode is cut (truncated)
 *  and the bot reset; otherwise a trapped bot keeps living through nights, which the survival term pays for (run 1). Waiting
 *  always succeeds, so it does not count as acting (run train3: Train6 waited 183 times on a tree top, 91 % "success"). */
class StuckDetector {
    constructor({ n = 200, minOk = 0.1, radius = 2 } = {}) { this.n = n; this.minOk = minOk; this.radius = radius; this.reset(); }
    reset() { this.ring = []; }
    push(ok, pos, cmd) {
        this.ring.push({ ok: !!ok && cmd !== 'wait', pos: pos ? [pos.x, pos.y, pos.z] : null });
        if (this.ring.length > this.n) this.ring.shift();
        if (this.ring.length < this.n || this.ring.some((r) => !r.pos)) return false;
        if (this.ring.filter((r) => r.ok).length / this.n >= this.minOk) return false;
        return [0, 1, 2].every((i) => Math.max(...this.ring.map((r) => r.pos[i])) - Math.min(...this.ring.map((r) => r.pos[i])) <= this.radius);
    }
}

/**
 * The part of the square region [-R, R]^2 where bot `i` of `n` is reset: a grid of ceil(sqrt(n)) columns, one cell per
 * bot, so bots start far apart (no interference; their chunks spread over the world). Returns [x0, x1, z0, z1].
 */
function sector(i, n, R) {
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), w = (2 * R) / cols, h = (2 * R) / rows;
    const cx = i % cols, cz = Math.floor(i / cols), m = Math.min(32, w / 4, h / 4);
    return [-R + cx * w + m, -R + (cx + 1) * w - m, -R + cz * h + m, -R + (cz + 1) * h - m];
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
        case 'tunnel': return `${a.dir} ${a.dy < 0 ? 'down' : a.dy > 0 ? 'up' : 'level'}`;
        default: return a.item ? `${a.item}${a.count ? ` x${a.count}` : ''}` : '';
    }
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    // Shards (--shard i): several environment processes, each with its own server, feed one learner. Bot ids are global
    // (i * bots + k), files are per shard: run <base>-s<i>-<time>, <base>.s<i>.current, <base>.s<i>.live.json.
    const sh = o.shard >= 0, off = sh ? o.shard * o.bots : 0, tag = sh ? `${o.base}.s${o.shard}` : o.base;
    const runId = `${o.base}${sh ? `-s${o.shard}` : ''}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
    const dir = path.join(o.root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(o.root, `${tag}.current`), runId + '\n');
    const out = new LineWriter(path.join(dir, 'env_to_policy.jsonl'));
    const inp = new LineReader(path.join(dir, 'policy_to_env.jsonl'), { runId, allowed: ['hello_ack', 'act'] });
    const events = new EventLog(path.join(dir, 'events.jsonl'), { runId, botId: 'all', component: 'skill_env' });
    let seq = 0;
    // The live board for the human watcher: <root>/<base>.live.json, rewritten once a second (tools/train-dash serves it).
    const board = new LiveBoard({ run: runId, base: o.base });
    const liveFile = path.join(o.root, `${tag}.live.json`);
    setInterval(() => { try { board.write(liveFile); } catch (e) { /* the next tick retries */ } }, 500).unref();
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

    const rcon = new Rcon({ host: process.env.RCON_HOST || 'localhost', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '',
        timeoutMs: Number(process.env.RCON_TIMEOUT_MS) || 10000 });
    await rcon.connect();
    const cmd = queued(rcon);
    for (const g of GAMERULES) await cmd(`gamerule ${g}`);
    // One clock for server and bots: the server's tick rate (tools/tickrate) is set from this process's GAME_SPEED, which
    // also scales the bots' client physics (src/transport/time_scale.js).
    const speed = require('../transport/time_scale').fromEnv();
    const rate = String(await cmd(`tickrate ${speed}`));
    if (!/^tickrate /.test(rate)) throw new Error(`server has no tick rate control (tools/tickrate): ${rate.slice(0, 120)}`);
    const mcData = require('minecraft-data')('1.20.1');
    const voc = vocab(mcData, (() => { try { return require('../../modpack/forgeaip-create.registry.json'); } catch { return null; } })());
    const hello = { env_version: ENV_VERSION, action_spec: actionSpec(), obs_spec: obsSpec(voc.entities.length),
        vocab_sizes: { item: voc.items.length, entity: voc.entities.length, cmd: CMDS.length, reason: REASON_LIST.length, category: 11 },
        milestones: MILESTONES, notable: NOTABLE, reward_terms: TERMS, stages: TABLE.stages, reward_table_version: TABLE.v,
        // v2.0: id -> name tables (the learner names the owner's task goals, e.g. 'diamond'; the policy sees ids only) and the
        // view image's rows x columns.
        vocab: { items: voc.items, entities: voc.entities }, view_shape: [VIEW_H, VIEW_W] };
    events.emit('run_start', { env_version: ENV_VERSION, bots: o.bots, shard: o.shard, env_id_offset: off, max_steps: o.maxSteps, region: o.region, seed: o.seed, K, speed,
        view_distance: VIEW, sites: o.sites ? o.sites.slice(0, o.bots) : undefined,
        sectors: o.sites ? undefined : Array.from({ length: o.bots }, (_, i) => sector(i, o.bots, o.region - 64).map(Math.round)) });

    // A bot that is lost (kick, timeout, closed socket) ends the whole run: the container restarts (unless-stopped) with all
    // bots and a new run id, which the learner follows. Waiting for the others would train on fewer bots indefinitely.
    let ended = false;
    const finish = (fatal) => {
        if (ended) return; ended = true;
        events.emit('run_end', { reason: fatal || 'done' }, fatal ? 'error' : 'info');
        for (let i = 0; i < o.bots; i++) send(off + i, 'bye', {});
        out.close(); events.close(); rcon.close();
        setTimeout(() => process.exit(fatal ? 6 : 0), 300);
    };
    const prefix = process.env.RL_BOT_PREFIX || 'Train';
    await Promise.all(Array.from({ length: o.bots }, (_, i) => sleep(i * 4000).then(() => !ended && runBot(off + i, `${prefix}${off + i}`)).catch((e) => {
        if (ended) return;
        events.emit('bot_fatal', { env_id: off + i, message: String(e.message).slice(0, 300) }, 'error');
        finish(`${prefix}${off + i}: ${e.message}`);
    })));
    finish(null);

    async function runBot(envId, name) {
        const bot = createForgeBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: name, viewDistance: VIEW });
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
        // `start`: where this bot's episodes begin. Bookkeeping for the learner and the page (pairs: the same site in other
        // shards), never part of the observation.
        const site = o.sites ? envId - off : null;
        board.site(envId, site === null ? null : { site, pos: o.sites[site], shard: Math.max(o.shard, 0) });
        send(envId, 'hello', { ...hello, start: site === null ? null : { site, pos: o.sites[site], shard: Math.max(o.shard, 0) } });
        for (let t = 0; !acks.has(envId); t++) { if (t > 6000) throw new Error('no hello_ack within 60 s'); await sleep(10); }
        if (!acks.get(envId).accepted) throw new Error(`hello refused: ${acks.get(envId).reason}`);

        const rng = mulberry32((o.seed * 7919 + envId) >>> 0);
        for (let episode = 0; ; episode++) {
            await Promise.race([site === null ? reset(bot, name, rng, sector(envId - off, o.bots, o.region - 64)) : resetAt(bot, name, o.sites[site]), lost]);
            await tracker.begin(); reward.newEpisode(); cancel = { cancelled: false };
            let msg = { reward: 0, reward_terms: Object.fromEntries(TERMS.map((t) => [t, 0])), terminated: false, truncated: false };
            let last = { reason: 'ok', ticks: 0 }, epTicks = 0;
            const ep = { ret: 0, nights: 0, slept: 0, t0: Date.now(), cmds: {}, stuck: false };
            const stuck = new StuckDetector();
            for (let step = 0; ; step++) {
                send(envId, 'obs', { episode, step, obs: space.observe(reward.progress(), last, reward.kills, { ticks: epTicks, step }), ...msg });
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
                // Tool multiplier of `mined` (owner 2026-11-02): which blocks this command broke with a tool (action-layer result).
                const used = res.ok && c ? (c.cmd === 'mine' ? [res.detail && res.detail.tool] : c.cmd === 'tunnel' ? (res.detail && res.detail.tools) || [] : []) : [];
                if (used.length) evs.push({ type: 'tool', frac: used.filter(Boolean).length / used.length });
                const sc = reward.score(evs);
                const dead = tracker.dead;
                ep.stuck = !dead && stuck.push(res.ok, bot.entity && bot.entity.position, c ? c.cmd : null);
                msg = { reward: sc.total, reward_terms: sc.terms, terminated: dead, truncated: !dead && (ep.stuck || step + 1 >= o.maxSteps) };
                last = { reason: res.ok ? 'ok' : res.reason, ticks: Math.max(ticks, 1) };
                epTicks += last.ticks;
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
                wall_s: Math.round((Date.now() - ep.t0) / 1000), terminated: msg.terminated, stuck: ep.stuck || undefined, cmds: ep.cmds };
            events.emit('episode_end', rec);
            board.episodeEnd(envId, rec);
            if (msg.terminated) {
                for (let t = 0; bot.health <= 0 && t < 600; t++) await sleep(50);   // auto-respawn
                await sleep(1000);
            }
        }
    }

    async function clean(bot, name) {
        if (bot.health <= 0) { try { bot.respawn(); } catch { /* auto-respawn */ } await sleep(1500); }
        for (const c of [`gamemode survival ${name}`, `advancement revoke ${name} everything`, `clear ${name}`, `effect clear ${name}`,
            `xp set ${name} 0 levels`, `xp set ${name} 0 points`]) await cmd(c);
    }

    async function settle(bot, name) {
        for (let t = 0; t < 200 && bot.inventory.items().length; t++) await sleep(50);
        await sleep(500);
        await cmd(`spawnpoint ${name} ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}`);
    }

    /** Teleport and wait until the bot is there and its chunk has arrived. */
    async function tpTo(bot, name, x, y, z) {
        const pos = bot.entity.position.clone(), far = pos.distanceTo(new Vec3(x + 0.5, y, z + 0.5)) >= 1;
        await cmd(`tp ${name} ${x + 0.5} ${y} ${z + 0.5}`);
        for (let t = 0; far && t < 400 && bot.entity.position.distanceTo(pos) < 1; t++) await sleep(50);
        for (let t = 0; t < 400 && !bot.blockAt(new Vec3(x, y - 1, z)); t++) await sleep(50);
        await sleep(300);
    }

    /** Fixed start (--sites): the site's own cell when it is dry standable ground, else the nearest such cell found by the same
     *  deterministic search in every world (columns nearest first, heights nearest the site's first), so paired bots start
     *  alike as long as their worlds are alike there. Earlier episodes may have dug or built at the site. */
    async function resetAt(bot, name, [sx, sy, sz]) {
        await clean(bot, name);
        await tpTo(bot, name, sx, sy, sz);
        const w = fromBot(bot);
        const dry = (x, y, z) => standable(w, x, y, z) && !/water|lava/.test(w.nameAt(x, y, z) || '') && !/_(leaves|log|wood)$|water|lava/.test(w.nameAt(x, y - 1, z) || '');
        const dys = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, -8, 12, -12];
        let cell = null;
        for (const [x, z] of ring(sx, sz, 6)) {
            const y = dys.map((d) => sy + d).find((yy) => dry(x, yy, z));
            if (y !== undefined) { cell = [x, y, z]; break; }
        }
        if (!cell) throw new Error(`reset: no dry standable cell within 6 blocks of site ${sx} ${sy} ${sz}`);
        if (cell.some((v, i) => v !== [sx, sy, sz][i])) {
            events.emit('site_moved', { bot: name, site: [sx, sy, sz], cell }, 'info');
            await tpTo(bot, name, ...cell);
        }
        if (bot.entity.isInWater) throw new Error(`reset: in water at site ${sx} ${sy} ${sz}`);
        await settle(bot, name);
    }

    async function reset(bot, name, rng, [x0, x1, z0, z1]) {
        await clean(bot, name);
        // spreadplayers refuses sites without safe ground (ocean: "Could not spread") and may still land in shallow water,
        // where the action layer cannot act (no swimming, SKILLS-v1 limits): draw another site until the bot stands dry.
        const w = fromBot(bot);
        // The bot's own sector first; a sector that is mostly ocean (run train3, Train4: 30 wet sites) falls back on the
        // whole region after 40 tries, logged.
        let why = '';
        const R = o.region - 64;
        for (let i = 0; i < 80; i++) {
            const pos = bot.entity.position.clone();
            if (i === 40) events.emit('sector_fallback', { bot: name, sector: [x0, x1, z0, z1].map(Math.round) }, 'warn');
            const [ax, bx, az, bz] = i < 40 ? [x0, x1, z0, z1] : [-R, R, -R, R];
            const reply = String(await cmd(`spreadplayers ${Math.round(ax + rng() * (bx - ax))} ${Math.round(az + rng() * (bz - az))} 0 24 false ${name}`));
            if (!/^Spread/.test(reply)) { why = reply.slice(0, 120); continue; }
            for (let t = 0; t < 200 && bot.entity.position.distanceTo(pos) < 1; t++) await sleep(50);   // the teleport arrived
            for (let t = 0; t < 100 && !bot.blockAt(bot.entity.position.offset(0, -1, 0)); t++) await sleep(50);   // its chunk too
            await sleep(300);
            const p = bot.entity.position, x = Math.floor(p.x), y = Math.floor(p.y + 0.2), z = Math.floor(p.z);
            // Not on a tree either: spreadplayers counts leaves as safe ground, and a bot on a tree top ends up on a one-block
            // trunk with no way down (run train3, Train6).
            const under = w.nameAt(x, y - 1, z) || '';
            if (!bot.entity.isInWater && standable(w, x, y, z) && !/_(leaves|log|wood)$/.test(under)) { why = ''; break; }
            why = `landed in water, on a tree or not on dry ground (${under})`;
        }
        if (why) throw new Error(`reset: no dry site in 80 tries (${why})`);
        await settle(bot, name);
    }
}

if (require.main === module) main().catch((e) => { console.error('[skill-env] fatal:', e.message); process.exit(1); });

module.exports = { parseArgs, queued, idle, describe, sector, ring, loadSites, StuckDetector, GAMERULES, ENV_VERSION };

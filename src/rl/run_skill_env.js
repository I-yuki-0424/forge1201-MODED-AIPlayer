'use strict';
// RL environment process (docs/proposed/RL-TRAINING-v2.md, env v3.0): one group of bots in one world (one server), skill-level
// actions, reward v5. Serves the DPOD file API (PROTOCOL.md v1) with env_id = global bot index. Inference is on demand: a bot
// sends its observation when its previous command has ended, so bots step at their own pace.
//   node src/rl/run_skill_env.js --base train7 --shard 0 --bots 2 --candidates /exchange/sites-20261101.json [--days 3]
// Every start is a new run (<base>-s<i>-<UTC time>); <root>/<base>.s<i>.current names the latest, so the learner follows
// restarts. Owner 2026-11-02 (env v3.0):
//   - Groups: the bots of one process share one world and form a pair (`start.pair` = the shard: the learner gives both the
//     same goal). Each group has its own server, so its clock is its own.
//   - An episode is --days in-game days for the whole group: the clock is set to morning at the start and every bot's episode
//     ends (terminated: the time left is in the observation) at the first observation past days x 24000 ticks. A death costs
//     the death penalty and play goes on from the respawn at the episode's site; every dawn reached alive since the last pays.
//   - Progress is judged here from server statistics (src/rl/progress-list.json), so no advancement is revoked between episodes.
//   - Every episode starts each bot at a new site: the next candidate of the seed's list (tools/site-finder: tree biome, not
//     an island, 512+ blocks from every other candidate), checked on arrival (logs within 16 blocks, a dry standable cell,
//     500+ blocks from the partner's site). Used candidates are recorded per world (<root>/sites/<world>.json), so no site is
//     used twice in a world; when the list is used up the process stops with exit code 7 (scripts/train: new world).
// Environment: MC_HOST MC_PORT RCON_HOST RCON_PORT RCON_PASSWORD, BOT_REGISTRY (default auto), RL_BOT_PREFIX (default Train),
// GAME_SPEED (src/transport/time_scale.js).
const fs = require('fs');
const path = require('path');
const { createForgeBot, attachForgeHandshake } = require('../transport/forge_bot');
const { Rcon } = require('./rcon');
const { LineWriter, LineReader } = require('./jsonl_channel');
const { EventLog } = require('./events');
const { execute } = require('../skills');
const { fromBot, standable } = require('../skills/world');
const { Vec3 } = require('vec3');
const { ProgressTracker } = require('./progress');
const { CrafterReward, TABLE, TERMS, MILESTONES, NOTABLE } = require('./crafter_reward');
const { SkillSpace, vocab, obsSpec, actionSpec, K, CMDS, REASON_LIST, VIEW_H, VIEW_W } = require('./skill_space');
const { LiveBoard } = require('./live_board');

// v1.1-v2.1: see git history. v3.0 (owner 2026-11-02): groups (one world per pair), episodes of --days in-game days with play
// after death, progress list judged from statistics (reward v5), a new seed-derived start site per bot per episode, clock
// [share of the episode gone, log step, time of day].
const ENV_VERSION = '2026-11-02-skills-v3.0';
const DAY = 24000;
const SITE_GAP = 500;   // owner: no start within 500 blocks of a used one or of another bot
const LOG = /_log$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chunks a bot asks the server for: it acts within about 20 blocks, so 5 is ample with many bots.
const VIEW = Number(process.env.RL_VIEW_DISTANCE) || 5;
const GAMERULES = ['doDaylightCycle true', 'doMobSpawning true', 'doImmediateRespawn true', 'keepInventory false',
    'playersSleepingPercentage 1', 'announceAdvancements false', 'sendCommandFeedback false', 'logAdminCommands false', 'spawnRadius 0'];

function parseArgs(argv) {
    const o = { root: '/exchange', base: null, bots: 2, days: 3, seed: 1, actTimeout: 600, shard: 0, candidates: null, world: null, minLogs: 12 };
    const map = { '--root': ['root'], '--base': ['base'], '--bots': ['bots', Number], '--days': ['days', Number], '--seed': ['seed', Number],
        '--act-timeout': ['actTimeout', Number], '--shard': ['shard', Number], '--candidates': ['candidates'], '--world': ['world'],
        '--min-logs': ['minLogs', Number] };
    for (let i = 0; i < argv.length; i += 2) {
        const m = map[argv[i]];
        if (!m || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
        o[m[0]] = m[1] ? m[1](argv[i + 1]) : argv[i + 1];
    }
    if (!/^[a-z0-9_-]{1,40}$/i.test(o.base || '')) throw new Error('--base <name> is required ([a-z0-9_-])');
    if (!(o.bots >= 1 && o.bots <= 16)) throw new Error('--bots must be 1..16');
    if (!(Number.isInteger(o.shard) && o.shard >= 0 && o.shard <= 31)) throw new Error('--shard must be 0..31');
    if (!(o.days > 0 && o.days <= 100)) throw new Error('--days must be in (0, 100]');
    if (!o.candidates) throw new Error('--candidates <site-finder output> is required');
    o.world = o.world || `${o.base}-s${o.shard}`;
    if (!/^[a-z0-9_.-]{1,60}$/i.test(o.world)) throw new Error('--world: [a-z0-9_.-]');
    return o;
}

/** Columns around (x, z) out to radius r, nearest first, ties in a fixed order. */
function ring(x, z, r) {
    const out = [];
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) out.push([dx * dx + dz * dz, dx, dz]);
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map(([, dx, dz]) => [x + dx, z + dz]);
}

/**
 * The start-site candidates of one world, consumed in order (owner 2026-11-02: never a site already used or within 500 blocks of
 * one; the site finder's cells already keep candidates 512+ apart). Every candidate taken is recorded with its outcome, rejected
 * ones too, and the state is written before the bot goes there, so a restart never reuses a site.
 */
class SiteBook {
    constructor(file, candidates) {
        this.file = file; this.cands = candidates.sites; this.seed = candidates.seed;
        let st = null;
        try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new world */ }
        if (st && st.seed !== this.seed) throw new Error(`${file}: seed ${st.seed}, candidates are for ${this.seed}`);
        this.next = st ? st.next : 0; this.used = st ? st.used : [];
    }
    get left() { return this.cands.length - this.next; }
    /** The next candidate at least SITE_GAP from every point in `avoid` ([x, z]); skipped ones are recorded as used. */
    take(avoid = [], who = {}) {
        while (this.next < this.cands.length) {
            const i = this.next++, [x, z, y] = this.cands[i];
            const near = avoid.find(([ax, az]) => Math.hypot(ax - x, az - z) < SITE_GAP);
            this.mark(i, near ? `another bot within ${SITE_GAP}` : 'taken', who);
            if (!near) return { i, x, y, z };
        }
        return null;
    }
    mark(i, outcome, who = {}) {
        const u = this.used.find((r) => r.i === i);
        if (u) u.outcome = outcome;
        else this.used.push({ i, x: this.cands[i][0], z: this.cands[i][1], outcome, ...who, t: Math.round(Date.now() / 1000) });
        this.save();
    }
    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ seed: this.seed, next: this.next, used: this.used }) + '\n');
        fs.renameSync(`${this.file}.tmp`, this.file);
    }
}

/** Log blocks within a horizontal radius r around (x, z), between y0 - 6 and y0 + 24 (loaded cells only). */
function countLogs(w, x, y0, z, r = 16) {
    let n = 0;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r) continue;
        for (let y = y0 - 6; y <= y0 + 24; y++) if (LOG.test(w.nameAt(x + dx, y, z + dz) || '')) n++;
    }
    return n;
}

/** A dry standable cell on the ground near (x, z): columns nearest first, each scanned from y0 + 30 down to y0 - 20, the first
 *  standable cell whose floor is not leaves, a log or fluid (under a canopy the scan passes through to the forest floor). */
function groundCell(w, x, y0, z, r = 8) {
    const dry = (cx, cy, cz) => standable(w, cx, cy, cz) && !/water|lava/.test(w.nameAt(cx, cy, cz) || '') && !/_(leaves|log|wood)$|water|lava|ice/.test(w.nameAt(cx, cy - 1, cz) || '');
    for (const [cx, cz] of ring(x, z, r)) {
        for (let cy = y0 + 30; cy >= y0 - 20; cy--) {
            const name = w.nameAt(cx, cy - 1, cz);
            if (name === null) break;   // not loaded
            if (dry(cx, cy, cz)) return [cx, cy, cz];
            if (name && name !== 'air' && !/_(leaves|log)$|vine/.test(name)) break;   // ground reached without a dry cell
        }
    }
    return null;
}

/** One RCON connection, one command at a time (docs/LESSONS.md L9); a command that times out is sent again (safe to repeat). */
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
 *  bot stayed within `radius` blocks (a pit, a tree top: the action layer cannot act there). v3.0: the environment then kills
 *  the bot (death penalty, respawn at the site), so hiding cannot collect days (run 1). */
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

class SitesExhausted extends Error {}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const off = o.shard * o.bots, tag = `${o.base}.s${o.shard}`;
    const runId = `${o.base}-s${o.shard}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
    const dir = path.join(o.root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(o.root, `${tag}.current`), runId + '\n');
    const out = new LineWriter(path.join(dir, 'env_to_policy.jsonl'));
    const inp = new LineReader(path.join(dir, 'policy_to_env.jsonl'), { runId, allowed: ['hello_ack', 'act'] });
    const events = new EventLog(path.join(dir, 'events.jsonl'), { runId, botId: 'all', component: 'skill_env' });
    const book = new SiteBook(path.join(o.root, 'sites', `${o.world}.json`), JSON.parse(fs.readFileSync(o.candidates, 'utf8')));
    let seq = 0;
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
    // One clock for server and bots: the server's tick rate (tools/tickrate) is set from GAME_SPEED, which also scales the bots'
    // client physics (src/transport/time_scale.js).
    const speed = require('../transport/time_scale').fromEnv();
    const rate = String(await cmd(`tickrate ${speed}`));
    if (!/^tickrate /.test(rate)) throw new Error(`server has no tick rate control (tools/tickrate): ${rate.slice(0, 120)}`);
    const mcData = require('minecraft-data')('1.20.1');
    const voc = vocab(mcData, (() => { try { return require('../../modpack/forgeaip-create.registry.json'); } catch { return null; } })());
    const hello = { env_version: ENV_VERSION, action_spec: actionSpec(), obs_spec: obsSpec(voc.entities.length),
        vocab_sizes: { item: voc.items.length, entity: voc.entities.length, cmd: CMDS.length, reason: REASON_LIST.length, category: 11 },
        milestones: MILESTONES, notable: NOTABLE, reward_terms: TERMS, stages: TABLE.stages, reward_table_version: TABLE.v,
        vocab: { items: voc.items, entities: voc.entities }, view_shape: [VIEW_H, VIEW_W], days: o.days };
    events.emit('run_start', { env_version: ENV_VERSION, bots: o.bots, shard: o.shard, env_id_offset: off, days: o.days, seed: o.seed, K, speed,
        view_distance: VIEW, world: o.world, sites_left: book.left });

    // A bot that is lost (kick, timeout, closed socket) ends the whole run: the process restarts with all bots and a new run id.
    let ended = false;
    const finish = (fatal, code) => {
        if (ended) return; ended = true;
        events.emit('run_end', { reason: fatal || 'done' }, fatal ? 'error' : 'info');
        for (let i = 0; i < o.bots; i++) send(off + i, 'bye', {});
        out.close(); events.close(); rcon.close();
        setTimeout(() => process.exit(code ?? (fatal ? 6 : 0)), 300);
    };
    const prefix = process.env.RL_BOT_PREFIX || 'Train';
    try {
        const bots = await Promise.all(Array.from({ length: o.bots }, (_, k) => sleep(k * 4000).then(() => connect(off + k, `${prefix}${off + k}`))));
        for (let episode = 0; !ended; episode++) {
            const sites = [];
            for (const b of bots) sites.push(b.site = await place(b, episode, sites));
            await cmd('time set 0'); await cmd('weather clear');
            for (let t = 0; t < 100 && bots.some((b) => !(b.bot.time && b.bot.time.time < DAY / 2)); t++) await sleep(50);   // the clock arrived
            await Promise.all(bots.map((b) => Promise.race([play(b, episode), b.lost])));
        }
    } catch (e) {
        if (e instanceof SitesExhausted) { events.emit('sites_exhausted', { world: o.world, used: book.used.length }, 'error'); finish(e.message, 7); return; }
        events.emit('bot_fatal', { message: String(e.message).slice(0, 300) }, 'error');
        finish(String(e.message));
        return;
    }
    finish(null);

    async function connect(envId, name) {
        const bot = createForgeBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: name, viewDistance: VIEW });
        attachForgeHandshake(bot, { registry: process.env.BOT_REGISTRY || 'auto' });
        const lost = new Promise((_, reject) => {
            bot.on('kicked', (r) => reject(new Error(`${name} kicked: ${String(r).slice(0, 200)}`)));
            bot.on('end', (r) => reject(new Error(`${name} connection ended: ${r}`)));
        });
        lost.catch((e) => board.lost(envId, e.message));
        bot.on('error', (e) => events.emit('bot_error', { env_id: envId, message: String(e.message || e).slice(0, 200) }, 'warn'));
        await Promise.race([new Promise((r) => bot.once('spawn', r)), lost, sleep(90000).then(() => { throw new Error(`${name}: no spawn within 90 s`); })]);
        const b = { envId, name, bot, lost, tracker: new ProgressTracker(bot), space: new SkillSpace(bot, voc), reward: new CrafterReward(), cancel: { cancelled: false } };
        board.attach(envId, name, bot);
        bot.on('death', () => { b.cancel.cancelled = true; });
        events.emit('connected', { env_id: envId, username: name });
        // `start`: the pair (= this group) and member, bookkeeping for the learner and the page, never part of the observation.
        const start = { pair: o.shard, shard: o.shard, member: envId - off, world: o.world };
        board.site(envId, start);
        send(envId, 'hello', { ...hello, start });
        for (let t = 0; !acks.has(envId); t++) { if (t > 6000) throw new Error(`${name}: no hello_ack within 60 s`); await sleep(10); }
        if (!acks.get(envId).accepted) throw new Error(`hello refused: ${acks.get(envId).reason}`);
        return b;
    }

    /** Teleport and wait until the bot is there and the cell's chunk has arrived. */
    async function tpTo(bot, name, x, y, z) {
        const pos = bot.entity.position.clone(), far = pos.distanceTo(new Vec3(x + 0.5, y, z + 0.5)) >= 1;
        await cmd(`tp ${name} ${x + 0.5} ${y} ${z + 0.5}`);
        for (let t = 0; far && t < 400 && bot.entity.position.distanceTo(pos) < 1; t++) await sleep(50);
        for (let t = 0; t < 400 && !bot.blockAt(new Vec3(x, Math.min(y, 300) - 1, z)); t++) await sleep(50);
        await sleep(300);
    }

    /** Start of an episode for one bot: respawned, emptied, then the next candidate site that passes the checks on arrival. The
     *  bot looks from above in spectator mode (no fall, chunks load around it), then stands on the chosen cell in survival. */
    async function place(b, episode, taken) {
        const { bot, name } = b;
        if (bot.health <= 0) { try { bot.respawn(); } catch { /* auto-respawn */ } await sleep(1500); }
        for (const c of [`gamemode spectator ${name}`, `clear ${name}`, `effect clear ${name}`, `xp set ${name} 0 levels`, `xp set ${name} 0 points`]) await cmd(c);
        const avoid = taken.map((s) => [s.x, s.z]);
        for (;;) {
            const s = book.take(avoid, { bot: b.envId, episode });
            if (!s) throw new SitesExhausted(`${o.world}: the ${book.cands.length} site candidates are used up`);
            await tpTo(bot, name, s.x, s.y + 40, s.z);
            const corners = [[16, 16], [16, -16], [-16, 16], [-16, -16]].map(([dx, dz]) => new Vec3(s.x + dx, s.y, s.z + dz));
            for (let t = 0; t < 200 && corners.some((v) => !bot.blockAt(v)); t++) await sleep(50);   // the cells counted below
            const w = fromBot(bot), logs = countLogs(w, s.x, s.y, s.z), cell = groundCell(w, s.x, s.y, s.z);
            const why = logs < o.minLogs ? `${logs} logs within 16 blocks (< ${o.minLogs})` : !cell ? 'no dry ground cell within 8 blocks' : null;
            if (why) { book.mark(s.i, `rejected: ${why}`, { bot: b.envId, episode }); events.emit('site_rejected', { bot: name, site: [s.x, s.z], why }, 'info'); continue; }
            await tpTo(bot, name, ...cell);
            await cmd(`gamemode survival ${name}`);
            await sleep(500);
            if (bot.entity.isInWater) { book.mark(s.i, 'rejected: in water on arrival', { bot: b.envId, episode }); continue; }
            await cmd(`spawnpoint ${name} ${cell[0]} ${cell[1]} ${cell[2]}`);
            book.mark(s.i, 'used', { bot: b.envId, episode, cell, logs });
            events.emit('site', { bot: name, episode, i: s.i, cell, logs, left: book.left });
            board.site(b.envId, { pair: o.shard, shard: o.shard, member: b.envId - off, world: o.world, site: s.i, pos: cell });
            return { ...s, cell };
        }
    }

    /** One episode of one bot: until the group's clock passes days x 24000 ticks. */
    async function play(b, episode) {
        const { bot, name, envId, tracker, space, reward } = b;
        const limit = o.days * DAY;
        await tracker.begin(); reward.newEpisode(); b.cancel = { cancelled: false };
        let msg = { reward: 0, reward_terms: Object.fromEntries(TERMS.map((t) => [t, 0])), terminated: false, truncated: false };
        let last = { reason: 'ok', ticks: 0 };
        const ep = { ret: 0, days: 0, slept: 0, deaths: 0, stuck: 0, t0: Date.now(), cmds: {} };
        const stuck = new StuckDetector();
        const clock = (step) => ({ frac: (bot.time.time || 0) / limit, step, tod: (bot.time.timeOfDay || 0) / DAY });
        for (let step = 0; ; step++) {
            send(envId, 'obs', { episode, step, obs: space.observe(reward.progress(), last, reward.kills, clock(step)), ...msg });
            if (msg.terminated) break;
            const act = await nextAct(envId, episode, step);
            if (!act) throw new Error(`${name}: no act for episode ${episode} step ${step} within ${o.actTimeout} s`);
            const c = space.cands[act.action && act.action.candidate];
            let res;
            const t0 = Date.now();
            board.begin(envId, { episode, step, cmd: c ? c.cmd : 'invalid', label: c ? describe(bot, c) : '', index: act.action && act.action.candidate,
                offered: space.cands.map((x) => x.cmd) });
            let ticks = 0;
            const count = () => { ticks++; };
            bot.on('physicsTick', count);
            if (!c) { events.emit('invalid_candidate', { env_id: envId, episode, step, candidate: act.action && act.action.candidate }, 'warn'); res = await idle(bot, 20, b.cancel); res.reason = 'invalid_args'; }
            else if (c.cmd === 'wait') res = await idle(bot, c.args.ticks, b.cancel);
            else res = await execute(bot, c.cmd, c.args, { cancel: b.cancel });
            // A command refused before any input still costs one game tick (run train-20261101T012004: 5 ms per step).
            if (ticks === 0) await Promise.race([new Promise((r) => bot.once('physicsTick', r)), sleep(200)]);
            bot.removeListener('physicsTick', count);
            if (tracker.dead || bot.health <= 0) await sleep(300);   // the death packet and the last statistics
            const { events: evs, statsOk } = await tracker.collect();
            if (!res.ok) evs.push({ type: 'failed', reason: res.reason });
            const sc = reward.score(evs);
            const died = evs.some((e) => e.type === 'death');
            if (died) {
                ep.deaths++;
                for (let t = 0; (bot.health <= 0 || !bot.entity) && t < 600; t++) await sleep(50);   // auto-respawn at the site
                await sleep(500);
                tracker.revive(); b.cancel = { cancelled: false }; stuck.reset();
            } else if (stuck.push(res.ok, bot.entity && bot.entity.position, c ? c.cmd : null)) {
                ep.stuck++; stuck.reset();
                events.emit('stuck_kill', { env_id: envId, episode, step }, 'info');
                await cmd(`kill ${name}`);   // reported as a death with the next command's events
            }
            msg = { reward: sc.total, reward_terms: sc.terms, terminated: (bot.time.time || 0) >= limit, truncated: false };
            last = { reason: res.ok ? 'ok' : res.reason, ticks: Math.max(ticks, 1) };
            ep.ret += sc.total; ep.cmds[c ? c.cmd : 'invalid'] = (ep.cmds[c ? c.cmd : 'invalid'] || 0) + 1;
            let days = 0, slept = 0;
            for (const e of evs) if (e.type === 'dawn') { days++; if (e.slept) slept++; }
            board.end(envId, { ok: !!res.ok, reason: last.reason, ms: Date.now() - t0, ticks: last.ticks, reward: sc.total, nights: days, slept });
            events.emit('step', { env_id: envId, episode, step: step + 1, cmd: c ? c.cmd : null, args: c ? c.args : null, ok: !!res.ok,
                reason: last.reason, ticks: last.ticks, ms: Date.now() - t0, reward: sc.total, terms: sc.terms,
                progress_events: evs.length ? evs : undefined, stats_ok: statsOk || undefined, health: bot.health, food: bot.food });
        }
        const rec = { env_id: envId, episode, return: Math.round(ep.ret * 1e4) / 1e4, days: reward.days, slept: reward.slept, deaths: ep.deaths,
            stuck_kills: ep.stuck || undefined, progress: [...reward.done], wall_s: Math.round((Date.now() - ep.t0) / 1000), site: b.site && b.site.i, cmds: ep.cmds };
        events.emit('episode_end', rec);
        board.episodeEnd(envId, rec);
    }
}

if (require.main === module) main().catch((e) => { console.error('[skill-env] fatal:', e.message); process.exit(1); });

module.exports = { parseArgs, queued, idle, describe, ring, SiteBook, countLogs, groundCell, StuckDetector, GAMERULES, ENV_VERSION, SITE_GAP };

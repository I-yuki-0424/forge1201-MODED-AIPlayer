'use strict';
// The work service: a roster of pure bots (Mineflayer on the action layer, no policy, no LLM), jobs on the crew ledger (open
// pits, structures from blueprints), a structure library, and the operator helpers (player positions, kits) that need RCON.
// Everything the console (console.js) can do is a method here, validated; the HTTP layer adds authentication only.
// Design: docs/implemented/WORK-CONSOLE-v1.md. Jobs: docs/proposed/WORKERS-v1.md.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const bp = require('./blueprint');
const build = require('./build');
const pit = require('./pit');
const janitor = require('./janitor');
const { runWorker } = require('./worker');
const inventory = require('./inventory');
const { catalog } = require('./catalog');
const { MapStore } = require('./maps');
const skills = require('../skills');

const BOT_NAME = /^[A-Za-z0-9_]{3,16}$/;
const STRUCT_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ITEM_ID = /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/;
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const COORD = 29_999_000;
const MIN_Y = -64, MAX_Y = 319;
const MAX_SIDE = 256, MAX_DEPTH = 256;
const ACTIVE = new Set(['running', 'paused', 'ready']);

const DEFAULT_KIT = { iron_pickaxe: { min: 2, give: 3 }, cobblestone: { min: 32, give: 64 }, bread: { min: 8, give: 16 } };

class Problem extends Error {                          // a refusal the caller can show: carries the HTTP status
    constructor(message, status = 400) { super(message); this.status = status; }
}
const need = (cond, msg, status) => { if (!cond) throw new Problem(msg, status); };
const int = (v, what) => { need(Number.isInteger(v) && Math.abs(v) <= COORD, `${what} must be an integer`); return v; };

function normalizeBox(b) {
    need(b && typeof b === 'object', 'box missing');
    const x0 = Math.min(int(b.x0, 'x0'), int(b.x1, 'x1')), x1 = Math.max(b.x0, b.x1);
    const z0 = Math.min(int(b.z0, 'z0'), int(b.z1, 'z1')), z1 = Math.max(b.z0, b.z1);
    const top = Math.max(int(b.top, 'top'), int(b.bottom, 'bottom')), bottom = Math.min(b.top, b.bottom);
    need(x1 - x0 < MAX_SIDE && z1 - z0 < MAX_SIDE, `a pit is at most ${MAX_SIDE} blocks per side (make several)`);
    need(top <= MAX_Y && bottom >= MIN_Y, `y must be between ${MIN_Y} and ${MAX_Y}`);
    need(top - bottom + 1 <= MAX_DEPTH, `a pit is at most ${MAX_DEPTH} deep`);
    return { x0, z0, x1, z1, top, bottom };
}

const overlap = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Default bot factory: a Mineflayer bot with the FML3 handshake and the mod table (BOT_MOD_TABLE). */
function defaultFactory({ host, port }) {
    const { createForgeBot, attachForgeHandshake } = require('../transport/forge_bot');
    return (name) => {
        const bot = createForgeBot({ host, port, username: name, viewDistance: 4 });
        attachForgeHandshake(bot, { registry: process.env.BOT_REGISTRY || 'auto' });
        return bot;
    };
}

class WorkService extends EventEmitter {
    /**
     * @param opts.dataDir   where structures, jobs and state.json live (created)
     * @param opts.factory   (name) -> bot (default: real Mineflayer bot of `host`/`port`)
     * @param opts.envFactory (bot, cancel) -> worker env (default: worker.botEnv)
     * @param opts.rcon      {host, port, password} or null; or an object with command(cmd) (tests)
     * @param opts.known     (blockName) -> bool: does the bots' registry have this block (null = do not check)
     */
    constructor(opts) {
        super();
        this.o = { host: 'localhost', port: 25565, maxBots: 24, kit: DEFAULT_KIT, reconnectMs: 3000, restore: true, ...opts };
        this.o.kit = this.o.kit || DEFAULT_KIT;               // an explicit `kit: undefined` must not hide the default
        need(this.o.dataDir, 'dataDir');
        for (const d of ['structures', 'jobs']) fs.mkdirSync(path.join(this.o.dataDir, d), { recursive: true });
        this.factory = this.o.factory || defaultFactory(this.o);
        this.envFactory = this.o.envFactory || ((bot, cancel) => require('./worker').botEnv(bot, { cancel }));
        this.known = this.o.known || null;
        this.bots = new Map();            // name -> record
        this.jobs = new Map();            // id -> job
        this.log = [];
        this.settings = { autoKit: false };
        this.seq = 0;
        this._saveTimer = null;
        this._rcon = null; this._rconTail = Promise.resolve();
        this.maps = new MapStore(this.o.worldDir || null);
        this.cmdSeq = 0;
        this.started = Date.now();
    }

    // ------------------------------------------------------------------------------------------------ log, persistence

    note(level, msg, extra = {}) {
        const e = { t: Date.now(), level, msg: String(msg).slice(0, 300), ...extra };
        this.log.push(e); if (this.log.length > 400) this.log.shift();
        this.emit('event', e);
        if (level !== 'debug') console.log(`[work] ${level} ${e.msg}`);
    }
    _dirty() { if (!this._saveTimer) this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 500); this._saveTimer.unref?.(); this.emit('change'); }
    save() {
        const f = path.join(this.o.dataDir, 'state.json');
        const data = {
            settings: this.settings, seq: this.seq,
            bots: [...this.bots.values()].filter((b) => !b.removed).map((b) => ({ name: b.name, job: b.job })),
            jobs: [...this.jobs.values()].map((j) => ({ id: j.id, kind: j.kind, name: j.name, spec: j.spec, state: j.state, created: j.created, bots: [...j.bots] })),
        };
        fs.writeFileSync(f + '.tmp', JSON.stringify(data)); fs.renameSync(f + '.tmp', f);
    }
    /** Bring back the roster and the jobs of the last run. Jobs come back paused: the world is the truth, units run again are no-ops. */
    async restore() {
        let d; try { d = JSON.parse(fs.readFileSync(path.join(this.o.dataDir, 'state.json'), 'utf8')); } catch (_) { return; }
        this.settings = { ...this.settings, ...(d.settings || {}) }; this.seq = d.seq || 0;
        for (const j of d.jobs || []) {
            try {
                const job = await this._rebuild(j);
                job.state = ['finished', 'cancelled'].includes(j.state) ? j.state : 'paused';
                job.bots = new Set((j.bots || []).filter((n) => BOT_NAME.test(n)));
                this.jobs.set(job.id, job);
            } catch (e) { this.note('warn', `job ${j.id} not restored: ${e.message}`); }
        }
        for (const b of d.bots || []) if (BOT_NAME.test(b.name)) { try { this.addBot(b.name, { job: this.jobs.has(b.job) ? b.job : null }); } catch (e) { this.note('warn', `bot ${b.name}: ${e.message}`); } }
        this.note('info', `restored ${this.bots.size} bots, ${this.jobs.size} jobs (jobs are paused: press Start)`);
    }

    // ------------------------------------------------------------------------------------------------ bots

    addBot(name, { job = null } = {}) {
        need(typeof name === 'string' && BOT_NAME.test(name), 'bot name: 3-16 letters, digits or _');
        const have = this.bots.get(name);
        need(!have || have.removed, `bot ${name} exists`, 409);
        need([...this.bots.values()].filter((b) => !b.removed).length < this.o.maxBots, `at most ${this.o.maxBots} bots`, 409);
        const rec = { name, bot: null, state: 'connecting', job, worker: null, attempts: 0, error: null, removed: false, timer: null, retired: null, since: Date.now(), kitAt: 0 };
        this.bots.set(name, rec);
        this._connect(rec);
        this.note('info', `bot ${name} added`);
        this._dirty();
        return this._botView(rec);
    }

    _connect(rec) {
        if (rec.removed) return;
        rec.state = 'connecting'; rec.error = null;
        let bot;
        try { bot = this.factory(rec.name); } catch (e) { rec.error = String(e.message).slice(0, 200); return this._retry(rec); }
        rec.bot = bot;
        const mine = () => rec.bot === bot && !rec.removed;
        bot.once('spawn', () => { if (!mine()) return; rec.state = 'online'; rec.attempts = 0; rec.since = Date.now(); this.note('info', `bot ${rec.name} online`); this._dirty(); this._resume(rec); });
        bot.on('spawn', () => { if (mine() && rec.state === 'online') setTimeout(() => this._resume(rec), 2500); });        // respawn after death
        bot.on('death', () => { if (mine()) this.note('warn', `bot ${rec.name} died`); });
        bot.on('error', (e) => { if (mine()) rec.error = String((e && e.message) || e).slice(0, 200); });
        bot.on('kicked', (r) => { if (mine()) { rec.error = `kicked: ${JSON.stringify(r).slice(0, 160)}`; this.note('warn', `bot ${rec.name} ${rec.error}`); } });
        bot.on('end', (why) => {
            if (!mine()) return;
            rec.state = 'offline'; this._stopWorker(rec);
            this.note('warn', `bot ${rec.name} disconnected${rec.error ? ': ' + rec.error : ''} (${String(why).slice(0, 60)})`);
            this._retry(rec); this._dirty();
        });
    }
    _retry(rec) {
        if (rec.removed) return;
        rec.state = 'offline';
        const wait = Math.min(60000, this.o.reconnectMs * 2 ** Math.min(rec.attempts++, 5));
        clearTimeout(rec.timer); rec.timer = setTimeout(() => this._connect(rec), wait); rec.timer.unref?.();
    }

    removeBot(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        rec.removed = true; clearTimeout(rec.timer);
        this._stopWorker(rec);
        try { rec.bot && rec.bot.quit && rec.bot.quit(); } catch (_) { /* already gone */ }
        for (const j of this.jobs.values()) j.bots.delete(name);
        this.bots.delete(name);
        this.note('info', `bot ${name} removed`);
        this._dirty();
    }

    _botView(rec) {
        const b = rec.bot, e = b && b.entity && rec.state === 'online' ? b.entity : null;
        const items = b && b.inventory && rec.state === 'online' ? b.inventory.items() : [];
        const count = (re) => items.reduce((n, i) => n + (re.test(i.name) ? i.count : 0), 0);
        return {
            name: rec.name, state: rec.state, job: rec.job, working: !!rec.worker, retired: rec.retired, error: rec.error,
            cmd: rec.cmd ? { id: rec.cmd.id, name: rec.cmd.name, status: rec.cmd.status, since: rec.cmd.started, result: rec.cmd.result || null } : null,
            pos: e ? { x: Math.round(e.position.x * 10) / 10, y: Math.round(e.position.y * 10) / 10, z: Math.round(e.position.z * 10) / 10 } : null,
            health: b && rec.state === 'online' ? b.health ?? null : null, food: b && rec.state === 'online' ? b.food ?? null : null,
            pickaxes: count(/_pickaxe$/), free: b && b.inventory && rec.state === 'online' ? b.inventory.emptySlotCount?.() ?? null : null,
        };
    }

    // ------------------------------------------------------------------------------------------------ jobs

    _id(prefix) { return `${prefix}${++this.seq}`; }

    _jobBox(job) {
        if (job.kind === 'pit') { const b = job.spec.box; return { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.bottom, y1: b.top }; }
        if (job._box) return job._box;
        const p = job.impl.plan, box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: p.minY, y1: p.minY + p.layers - 1 };
        for (const k of p.footprint) { const [x, z] = k.split(',').map(Number); if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x; if (z < box.z0) box.z0 = z; if (z > box.z1) box.z1 = z; }
        return (job._box = box);
    }
    _guardOverlap(job, force) {
        const box = this._jobBox(job);
        for (const o of this.jobs.values()) if (o !== job && ACTIVE.has(o.state) && overlap(box, this._jobBox(o))) need(force, `overlaps job ${o.id} (${o.name}); pass force to allow`, 409);
        return box;
    }

    /** Open-pit job. spec: { name?, box: {x0,z0,x1,z1,top,bottom}, depot?: {kind,x,y,z}, bots?: [...], start?, force? } */
    createPit(spec) {
        need(spec && typeof spec === 'object', 'spec missing');
        const box = normalizeBox(spec.box);
        let impl;
        try { impl = pit.createPitJob(box, { leaseMs: 45000 }); } catch (e) { throw new Problem(e.message); }
        const depot = spec.depot ? this._depot(spec.depot) : null;
        const job = this._newJob('pit', spec.name || `pit ${box.x1 - box.x0 + 1}x${box.z1 - box.z0 + 1}x${box.top - box.bottom + 1}`, { box, depot }, impl);
        job.policy = janitor.pitPolicy(depot ? { depot } : {});
        this._guardOverlap(job, spec.force);
        return this._register(job, spec);
    }

    _depot(d) {
        need(d && ['chest', 'shulker'].includes(d.kind), 'depot.kind is chest or shulker');
        return d.kind === 'chest' ? { kind: 'chest', x: int(d.x, 'depot.x'), y: int(d.y, 'depot.y'), z: int(d.z, 'depot.z') } : { kind: 'shulker', item: 'shulker_box' };
    }

    /** Build job. spec: { name?, structure, origin: {x,y,z}, ops?: [...], bots?, start?, force? } */
    async createBuild(spec) {
        need(spec && typeof spec === 'object', 'spec missing');
        need(typeof spec.structure === 'string' && STRUCT_NAME.test(spec.structure), 'structure name');
        const o = spec.origin || {};
        const origin = { x: int(o.x, 'origin.x'), y: int(o.y, 'origin.y'), z: int(o.z, 'origin.z') };
        need(origin.y >= MIN_Y && origin.y <= MAX_Y, `origin.y must be between ${MIN_Y} and ${MAX_Y}`);
        let b = await this.getStructure(spec.structure);
        if (spec.ops && spec.ops.length) b = await this._ops(b, spec.ops);
        const id = this._id('j');
        const file = path.join(this.o.dataDir, 'jobs', `${id}.nbt`);
        fs.writeFileSync(file, bp.write(b));                                            // an immutable copy: editing the library later changes nothing
        let impl;
        try { impl = build.createBuildJob(bp.cells(b), origin, { leaseMs: 45000 }, { known: this.known }); } catch (e) { fs.rmSync(file, { force: true }); throw new Problem(e.message); }
        const job = this._newJob('build', spec.name || `build ${spec.structure}`, { structure: spec.structure, origin, file: path.basename(file) }, impl, id);
        job.summary = { size: b.size, count: impl.plan.count, unsupported: impl.plan.unsupported, materials: this._materials(impl.plan) };
        try { this._guardOverlap(job, spec.force); } catch (e) { fs.rmSync(file, { force: true }); throw e; }
        return this._register(job, spec);
    }

    _materials(plan) {
        const m = {};
        for (const t of plan.tiles.values()) for (const list of t.cells.values()) for (const c of list) { const it = build.itemFor(c.block); if (it) m[it] = (m[it] || 0) + 1; }
        return m;
    }

    _newJob(kind, name, spec, impl, id = null) {
        return { id: id || this._id('j'), kind, name: String(name).slice(0, 60), spec, impl, state: 'ready', created: Date.now(), bots: new Set(), workers: new Map(), policy: null, repairs: 0, summary: null, started: null, ended: null, diff: null };
    }

    _register(job, spec) {
        for (const n of spec.bots || []) this._assign(job, n);
        this.jobs.set(job.id, job);
        this.note('info', `job ${job.id} created: ${job.name}`);
        this._dirty();
        if (spec.start) this.startJob(job.id);
        return this._jobView(job);
    }

    async _rebuild(j) {
        const base = { id: j.id, kind: j.kind, name: j.name, spec: j.spec, created: j.created };
        let impl;
        if (j.kind === 'pit') impl = pit.createPitJob(normalizeBox(j.spec.box), { leaseMs: 45000 });
        else {
            const b = await bp.read(fs.readFileSync(path.join(this.o.dataDir, 'jobs', path.basename(j.spec.file))));
            impl = build.createBuildJob(bp.cells(b), j.spec.origin, { leaseMs: 45000 }, { known: this.known });
        }
        const job = this._newJob(j.kind, j.name, j.spec, impl, j.id);
        job.created = base.created;
        if (j.kind === 'pit') job.policy = janitor.pitPolicy(j.spec.depot ? { depot: j.spec.depot } : {});
        else job.summary = { count: impl.plan.count, unsupported: impl.plan.unsupported, materials: this._materials(impl.plan) };
        return job;
    }

    _job(id) { const j = this.jobs.get(id); need(j, `no job ${id}`, 404); return j; }

    _assign(job, name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        need(!rec.job || rec.job === job.id || !this.jobs.has(rec.job) || !ACTIVE.has(this.jobs.get(rec.job).state), `bot ${name} works on ${rec.job}`, 409);
        rec.job = job.id; rec.retired = null; job.bots.add(name);
    }

    assign(id, names) {
        const job = this._job(id);
        need(ACTIVE.has(job.state), `job is ${job.state}`, 409);
        for (const n of names) this._assign(job, n);
        this._dirty();
        if (job.state === 'running') for (const n of names) this._startWorker(job, this.bots.get(n));
        return this._jobView(job);
    }
    unassign(id, name) {
        const job = this._job(id), rec = this.bots.get(name);
        job.bots.delete(name);
        if (rec && rec.job === id) { rec.job = null; this._stopWorker(rec); }
        this._dirty();
        return this._jobView(job);
    }

    startJob(id) {
        const job = this._job(id);
        need(['ready', 'paused'].includes(job.state), `job is ${job.state}`, 409);
        if (!job.bots.size) for (const rec of this.bots.values()) if (!rec.removed && !rec.job && rec.state !== 'offline') { rec.job = job.id; job.bots.add(rec.name); }     // no choice made: every idle bot
        need(job.bots.size, 'no bots assigned and no idle bot online', 409);
        job.state = 'running'; job.started = job.started || Date.now();
        for (const n of job.bots) this._startWorker(job, this.bots.get(n));
        this.note('info', `job ${job.id} started with ${job.bots.size} bots`);
        this._dirty();
        return this._jobView(job);
    }

    pauseJob(id) {
        const job = this._job(id);
        need(job.state === 'running', `job is ${job.state}`, 409);
        job.state = 'paused';
        for (const n of job.bots) { const rec = this.bots.get(n); if (rec) this._stopWorker(rec); }
        this.note('info', `job ${job.id} paused`);
        this._dirty();
        return this._jobView(job);
    }

    cancelJob(id) {
        const job = this._job(id);
        need(ACTIVE.has(job.state), `job is ${job.state}`, 409);
        job.state = 'cancelled'; job.ended = Date.now();
        this._release(job);
        this.note('info', `job ${job.id} cancelled`);
        this._dirty();
        return this._jobView(job);
    }

    deleteJob(id) {
        const job = this._job(id);
        need(!ACTIVE.has(job.state) || job.state === 'ready', `job is ${job.state}: cancel it first`, 409);
        this._release(job);
        this.jobs.delete(id);
        if (job.kind === 'build') fs.rmSync(path.join(this.o.dataDir, 'jobs', path.basename(job.spec.file)), { force: true });
        this._dirty();
    }

    _release(job) {
        for (const n of job.bots) { const rec = this.bots.get(n); if (rec) { this._stopWorker(rec); if (rec.job === job.id) rec.job = null; } }
        job.bots.clear();
    }

    /** Give every stuck unit another round (the repair pass of pit_live.js); the job runs again if it had ended. */
    repairJob(id) {
        const job = this._job(id), n = job.impl.ledger.requeueStuck(Date.now());
        if (job.state === 'finished' && n) { job.state = 'paused'; this.startJob(id); }
        this._dirty();
        return { requeued: n, job: this._jobView(job) };
    }

    // ------------------------------------------------------------------------------------------------ workers

    _resume(rec) {
        if (rec.removed || rec.state !== 'online' || !rec.job) return;
        const job = this.jobs.get(rec.job);
        if (job && job.state === 'running') this._startWorker(job, rec);
    }

    async _startWorker(job, rec) {
        if (!rec || rec.worker || rec.removed || rec.state !== 'online' || job.state !== 'running' || rec.retired) return;
        const cancel = { cancelled: false };
        rec.worker = { cancel, job: job.id, since: Date.now() };
        let env;
        try {
            if (this.settings.autoKit && this.o.rcon) await this.kitBot(rec.name, { quiet: true }).catch(() => {});
            if (cancel.cancelled || job.state !== 'running' || rec.state !== 'online') { if (rec.worker && rec.worker.cancel === cancel) rec.worker = null; return; }
            env = this.envFactory(rec.bot, cancel);
        } catch (e) { rec.worker = null; this.note('warn', `bot ${rec.name}: cannot start (${e.message})`); return; }
        this._dirty();
        runWorker(job.impl, rec.name, env, {
            cancel, policy: job.policy, pollMs: 1000,
            onEvent: (ev, d) => {
                if (ev === 'unit' && d.ok) rec.fixes = 0;
                if (ev === 'unit' && !d.ok) {
                    rec.missing = d.reason === 'missing_item' && d.detail && ITEM_ID.test(String(d.detail.item)) ? String(d.detail.item) : null;
                    this.note('debug', `${d.id} ${d.region} u${d.unit} ${d.reason}`, { job: job.id, detail: d.detail });
                }
                if (ev === 'janitor_failed') this.note('debug', `${d.id} janitor ${d.reason}`, { job: job.id });
            },
        }).then((res) => this._workerEnded(job, rec, res, cancel), (e) => this._workerEnded(job, rec, { ended: 'error', error: String(e.message).slice(0, 160) }, cancel));
    }

    /** Auto-kit: a bot that ran out of something gets exactly that (two stacks) or the kit, and goes on. */
    async _restock(job, rec, reason) {
        if (reason === 'missing_item' && rec.missing) {
            await this.rcon(`give ${rec.name} ${rec.missing.includes(':') ? rec.missing : 'minecraft:' + rec.missing} 128`);
            this.note('info', `restock for ${rec.name}: ${rec.missing} x128`);
        } else await this.kitBot(rec.name, { quiet: false });
        rec.retired = null; rec.missing = null;
        this._resume(rec);
        this._dirty();
    }

    /** Un-retire a bot (after a kit, materials, or a look in the game) and put it back to work. */
    resumeBot(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        rec.retired = null; rec.missing = null; rec.fixes = 0;
        this._resume(rec);
        this._dirty();
        return this._botView(rec);
    }

    _stopWorker(rec) { if (rec.worker) { rec.worker.cancel.cancelled = true; } }

    _workerEnded(job, rec, res, cancel) {
        if (rec.worker && rec.worker.cancel === cancel) rec.worker = null;
        this.note('debug', `bot ${rec.name} ended: ${res.ended}`, { job: job.id, res });
        const L = job.impl.ledger;
        if (job.state === 'running' && !cancel.cancelled) {
            if (res.ended === 'died') setTimeout(() => this._resume(rec), 4000);           // respawn event restarts it as well; whichever comes first wins
            else if (res.ended === 'unhealthy') {
                const missing = res.last === 'missing_item' || res.last === 'missing_tool';
                if (missing && this.settings.autoKit && this.o.rcon && (rec.fixes = (rec.fixes || 0) + 1) <= 5) { this._restock(job, rec, res.last).catch((e) => { rec.retired = `retired: ${res.last} (restock failed: ${String(e.message).slice(0, 80)})`; this._dirty(); }); return; }
                rec.retired = `retired: ${res.last || 'failed units'}${rec.missing ? ' ' + rec.missing : ''}`;
                this.note('warn', `bot ${rec.name} ${rec.retired}. ${missing ? 'Kit / Give materials, then Resume.' : 'Look at it in the game, then Resume.'}`);
            }
            else if (res.ended === 'stalled') this.note('warn', `bot ${rec.name}: nothing claimable and nothing running (job ${job.id})`);
            else if (res.ended === 'error') { rec.retired = `error: ${res.error}`; this.note('warn', `bot ${rec.name} ${rec.retired}`); }
        }
        if (job.state === 'running' && L.finished()) this._maybeFinish(job);
        else if (cancel.cancelled && job.state === 'running' && rec.job === job.id) this._resume(rec);       // stopped by a pause that was resumed before it ended
        this._dirty();
    }

    _maybeFinish(job) {
        if ([...job.bots].some((n) => this.bots.get(n)?.worker)) return;                   // wait for the last worker
        const L = job.impl.ledger;
        if (L.stuck.length && job.repairs < 1) {                                          // one automatic repair pass, like pit_live.js
            job.repairs++; const n = L.requeueStuck(Date.now());
            this.note('info', `job ${job.id}: ${n} stuck units, repair pass`);
            for (const name of job.bots) this._startWorker(job, this.bots.get(name));
            return;
        }
        job.state = 'finished'; job.ended = Date.now();
        if (job.kind === 'build') {
            const rec = [...job.bots].map((n) => this.bots.get(n)).find((r) => r && r.state === 'online');
            if (rec) { try { job.diff = job.impl.diff(require('../skills/world').fromBot(rec.bot)).length; } catch (_) { /* world not readable */ } }
        }
        for (const n of job.bots) { const rec = this.bots.get(n); if (rec && rec.job === job.id) rec.job = null; }
        job.bots.clear();
        this.note('info', `job ${job.id} finished: ${JSON.stringify(L.progress())}${job.diff !== null ? ` diff ${job.diff}` : ''}`);
    }

    // ------------------------------------------------------------------------------------------------ structures

    _file(name) { need(typeof name === 'string' && STRUCT_NAME.test(name), 'structure name: a-z 0-9 _ - (max 48)'); return path.join(this.o.dataDir, 'structures', `${name}.nbt`); }

    async getStructure(name) {
        const f = this._file(name);
        need(fs.existsSync(f), `no structure ${name}`, 404);
        return bp.read(fs.readFileSync(f));
    }
    structureFile(name) { const f = this._file(name); need(fs.existsSync(f), `no structure ${name}`, 404); return fs.readFileSync(f); }

    async putStructure(name, buf, { overwrite = false } = {}) {
        const f = this._file(name);
        need(overwrite || !fs.existsSync(f), `structure ${name} exists`, 409);
        const b = await bp.read(buf).catch((e) => { throw new Problem(e.message); });
        fs.writeFileSync(f, bp.write(b));                                                // normalised: gzip, our palette order
        this._dirty();
        return this._structView(name, b);
    }
    deleteStructure(name) { const f = this._file(name); need(fs.existsSync(f), `no structure ${name}`, 404); fs.rmSync(f); this._dirty(); }

    async _ops(b, ops) { try { return await bp.applyOps(b, ops, (n) => this.getStructure(n)); } catch (e) { throw e instanceof Problem ? e : new Problem(e.message); } }

    /** Apply edit steps to a stored structure; `as` stores the result under a new name (or the same one with overwrite). */
    async editStructure(name, ops, as, { overwrite = false } = {}) {
        const b = await this._ops(await this.getStructure(name), ops);
        const out = as || name;
        need(overwrite || out !== name, 'give a new name (as) or allow overwrite');
        return this.putStructure(out, bp.write(b), { overwrite: true });
    }
    /** Generated parts: a plain house, or an empty canvas to fill and merge. */
    async generate(kind, p, as) {
        try { return await this._generate(kind, p, as); } catch (e) { throw e instanceof Problem ? e : new Problem(e.message); }
    }
    async _generate(kind, p, as) {
        let b;
        if (kind === 'house') b = bp.fromCells(build.house({ w: p.w | 0 || 7, d: p.d | 0 || 7, h: p.h | 0 || 4, wall: p.wall || 'oak_planks', floor: p.floor || 'cobblestone', glass: p.glass || 'glass', door: p.door || 'oak_door' }));
        else if (kind === 'empty') b = bp.empty(p.w | 0, p.h | 0, p.d | 0);
        else if (kind === 'box') { b = bp.fill(bp.empty(p.w | 0, p.h | 0, p.d | 0), { x0: 0, y0: 0, z0: 0, x1: (p.w | 0) - 1, y1: (p.h | 0) - 1, z1: (p.d | 0) - 1 }, p.block || 'stone'); }
        else throw new Problem('kind is house, box or empty');
        return this.putStructure(as, bp.write(b));
    }
    _structView(name, b) { return { name, ...bp.stats(b, this.known ? (n) => this.known(n) : null) }; }
    async listStructures() {
        const out = [];
        for (const f of fs.readdirSync(path.join(this.o.dataDir, 'structures')).filter((x) => x.endsWith('.nbt')).sort()) {
            const name = f.slice(0, -4);
            if (!STRUCT_NAME.test(name)) continue;
            try { const s = this._structView(name, await bp.read(fs.readFileSync(path.join(this.o.dataDir, 'structures', f)))); out.push({ ...s, names: s.names.slice(0, 12) }); } catch (e) { out.push({ name, error: e.message }); }
        }
        return out;
    }
    async structureDetail(name) { return this._structView(name, await this.getStructure(name)); }
    async structureLayer(name, y) { const b = await this.getStructure(name); try { return bp.layer(b, y); } catch (e) { throw new Problem(e.message); } }

    // ------------------------------------------------------------------------------------------------ RCON helpers

    async rcon(cmd) {
        need(this.o.rcon, 'RCON is not configured (RCON_PASSWORD)', 503);
        const run = async () => {
            if (this.o.rcon.command) return this.o.rcon.command(cmd);                  // an injected client (tests)
            if (!this._rcon) { const { Rcon } = require('../rl/rcon'); const r = new Rcon({ ...this.o.rcon, timeoutMs: 8000 }); await r.connect(); this._rcon = r; }
            try { return await this._rcon.command(cmd); } catch (e) { try { this._rcon.close(); } catch (_) { /* gone */ } this._rcon = null; throw e; }
        };
        const p = this._rconTail.then(run); this._rconTail = p.catch(() => {});
        return p;
    }

    /** Players on the server with their position (RCON: `list`, `data get entity`). Bots are listed too, flagged. */
    async players() {
        const list = await this.rcon('list');
        const m = /:\s*(.*)$/.exec(String(list).replace(/\x1b\[[0-9;]*m/g, '').trim());
        const names = (m && m[1] ? m[1].split(',').map((s) => s.trim()).filter((s) => PLAYER_NAME.test(s)) : []);
        const out = [];
        for (const name of names) {
            const p = { name, bot: this.bots.has(name), pos: null, dimension: null };
            try {
                const pos = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await this.rcon(`data get entity ${name} Pos`));
                if (pos) p.pos = { x: Math.floor(Number(pos[1])), y: Math.floor(Number(pos[2])), z: Math.floor(Number(pos[3])) };
                const dim = /"([a-z0-9_:]+)"/.exec(await this.rcon(`data get entity ${name} Dimension`));
                if (dim) p.dimension = dim[1];
            } catch (_) { /* position unknown */ }
            out.push(p);
        }
        return out;
    }

    /** Top solid block (not leaves or logs) at x,z from the chunks a bot has loaded; null when nothing is loaded there. */
    surface(x, z) {
        int(x, 'x'); int(z, 'z');
        const rec = [...this.bots.values()].find((r) => r.state === 'online' && r.bot);
        need(rec, 'no bot online to read the terrain', 503);
        const w = require('../skills/world').fromBot(rec.bot);
        if (w.kindAt(x, 64, z) === 'unknown') return { y: null, why: 'chunk not loaded near any bot' };
        for (let y = MAX_Y; y >= MIN_Y; y--) {
            if (w.kindAt(x, y, z) !== 'solid') continue;
            if (/leaves|_log$|_wood$/.test(w.nameAt(x, y, z) || '')) continue;
            return { y, block: w.nameAt(x, y, z) };
        }
        return { y: null, why: 'no ground' };
    }

    /** Bring a bot's inventory up to the kit minimums with `give` (operator action through RCON). */
    async kitBot(name, { quiet = false } = {}) {
        need(this.o.rcon, 'RCON is not configured (RCON_PASSWORD)', 503);
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        need(rec.state === 'online', `bot ${name} is ${rec.state}`, 409);
        const have = (re) => rec.bot.inventory.items().reduce((n, i) => n + (i.name === re ? i.count : 0), 0);
        const given = [];
        for (const [item, k] of Object.entries(this.o.kit)) {
            need(ITEM_ID.test(item), 'kit item id');
            if (have(item) >= k.min) continue;
            await this.rcon(`give ${name} ${item.includes(':') ? item : 'minecraft:' + item} ${Math.max(1, Math.min(2304, k.give | 0))}`);
            given.push(`${item} x${k.give}`);
        }
        if (given.length && !quiet) this.note('info', `kit for ${name}: ${given.join(', ')}`);
        rec.retired = null;
        if (rec.job) this._resume(rec);
        return { given };
    }

    /** Give the materials a build job needs, split over its bots (or the named one). One `give` per item and bot. */
    async supply(id, botName = null) {
        const job = this._job(id);
        need(job.kind === 'build' && job.summary, 'only build jobs have materials', 409);
        const names = botName ? [botName] : [...job.bots];
        need(names.length, 'no bots assigned', 409);
        for (const n of names) need(this.bots.get(n)?.state === 'online', `bot ${n} is not online`, 409);
        const given = {};
        // Scaffold stairs are built from cheap blocks (build.js: K(K+1)/2 for K layers above the ground) and eat the same
        // cobblestone the structure may need: add them per bot (live run: both bots ran dry).
        const K = Math.min(10, Math.max(0, job.impl.plan.layers - 1)), margin = K ? (K * (K + 1)) / 2 + 8 : 0;
        const mats = { ...job.summary.materials };
        if (margin) mats.cobblestone = (mats.cobblestone || 0) + margin * names.length;
        for (const [item, total] of Object.entries(mats)) {
            need(ITEM_ID.test(item), 'item id');
            const each = Math.ceil(total / names.length);
            for (const n of names) {
                let left = each;
                while (left > 0) { const c = Math.min(left, 64 * 9); await this.rcon(`give ${n} ${item.includes(':') ? item : 'minecraft:' + item} ${c}`); left -= c; }
            }
            given[item] = each * names.length;
        }
        this.note('info', `materials for ${job.id} given to ${names.join(', ')}`);
        return { given };
    }


    // ------------------------------------------------------------------------------------------------ commands to single bots

    catalog() { return catalog(); }

    _online(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        need(rec.state === 'online' && rec.bot, `bot ${name} is ${rec.state}`, 409);
        return rec;
    }

    /**
     * Send one command to some bots. `bots`: a list of names, or 'all' (every online bot that is free). Each bot runs it on its own; the
     * call returns at once with who started and who refused (and why). Progress and results are in the bot view (`cmd`).
     */
    async runCommand({ bots, command, args = {} }) {
        const spec = catalog().find((c) => c.name === command);
        need(spec, `unknown command ${JSON.stringify(String(command).slice(0, 40))}`);
        need(args && typeof args === 'object' && !Array.isArray(args), 'args must be an object');
        let names;
        if (bots === 'all') names = [...this.bots.values()].filter((r) => !r.removed && r.state === 'online').map((r) => r.name);
        else { need(Array.isArray(bots) && bots.length && bots.length <= this.o.maxBots, 'bots: a list of names or "all"'); names = bots.map(String); }
        need(names.length, 'no bot is online', 409);
        if (spec.rcon) need(this.o.rcon, 'this command needs RCON', 503);
        const started = [], refused = [];
        for (const n of names) {
            const rec = this.bots.get(n);
            if (!rec || rec.removed) { refused.push({ name: n, why: 'no such bot' }); continue; }
            if (rec.state !== 'online') { refused.push({ name: n, why: rec.state }); continue; }
            if (command === 'stop') { if (rec.cmd && rec.cmd.status === 'running') rec.cmd.cancel.cancelled = true; started.push(n); continue; }
            if (rec.worker) { refused.push({ name: n, why: `works on job ${rec.job} (pause the job or take the bot off it)` }); continue; }
            if (rec.cmd && rec.cmd.status === 'running') { refused.push({ name: n, why: `busy with ${rec.cmd.name} (send Stop first)` }); continue; }
            if (spec.args.length) { try { this._checkArgs(spec, args); } catch (e) { refused.push({ name: n, why: e.message }); continue; } }
            this._exec(rec, command, args);
            started.push(n);
        }
        this._dirty();
        return { started, refused };
    }

    _checkArgs(spec, args) {
        if (spec.meta) {
            if (spec.name === 'say') { need(typeof args.text === 'string' && args.text.trim().length && args.text.length <= 100, 'text: 1-100 characters'); need(!args.text.trim().startsWith('/'), 'text must not start with /'); }
            if (spec.name === 'teleport') {
                const xyz = ['x', 'y', 'z'].filter((k) => args[k] !== undefined);
                need((args.player && inventory.NAME.test(String(args.player))) || xyz.length === 3, 'give a player or all of x, y, z');
                for (const k of xyz) int(args[k], k);
            }
            if (spec.name === 'come' && args.player !== undefined) need(inventory.NAME.test(String(args.player)), 'player name');
            return;
        }
        try { skills.validateArgs(spec.name, args); } catch (e) { throw new Problem(`${e.detail && e.detail.why ? e.detail.why : e.reason || e.message}`); }
    }

    _exec(rec, command, args) {
        const cancel = { cancelled: false }, id = ++this.cmdSeq, t0 = Date.now();
        rec.cmd = { id, name: command, args, status: 'running', started: t0, cancel, result: null };
        const bot = rec.bot;
        const finish = (res) => {
            if (!rec.cmd || rec.cmd.id !== id) return;
            const ok = res && res.ok !== false;
            rec.cmd.status = cancel.cancelled && !ok ? 'cancelled' : ok ? 'ok' : 'failed';
            rec.cmd.result = { ok, reason: ok ? null : (res && res.reason) || 'error', detail: res && res.detail ? JSON.stringify(res.detail).slice(0, 240) : null, ms: Date.now() - t0 };
            rec.history = [{ id, name: command, args, status: rec.cmd.status, ms: rec.cmd.result.ms, reason: rec.cmd.result.reason, at: t0 }, ...(rec.history || [])].slice(0, 12);
            this.note('debug', `${rec.name} ${command} ${rec.cmd.status}`, { args });
            this._dirty();
        };
        (async () => {
            if (command === 'say') { bot.chat(String(args.text)); return { ok: true }; }
            if (command === 'teleport') {
                const dest = args.player ? String(args.player) : `${args.x} ${args.y} ${args.z}`;
                const r = String(await this.rcon(`tp ${rec.name} ${dest}`)).replace(/\x1b\[[0-9;]*m/g, '');
                return /^Teleported/i.test(r.trim()) ? { ok: true } : { ok: false, reason: 'refused', detail: { server: r.trim().slice(0, 120) } };
            }
            if (command === 'come') {
                const players = await this.players(), p = args.player ? players.find((q) => q.name === args.player) : players.find((q) => !q.bot && q.pos);
                if (!p || !p.pos) return { ok: false, reason: 'invalid_target', detail: { why: 'no operator position (is the player online?)' } };
                return skills.execute(bot, 'move_to', { x: p.pos.x, y: p.pos.y, z: p.pos.z }, { cancel });
            }
            return skills.execute(bot, command, args, { cancel });
        })().then(finish, (e) => finish({ ok: false, reason: 'error', detail: { message: String(e.message).slice(0, 160) } }));
    }

    botDetail(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        const v = this._botView(rec), b = rec.bot;
        const held = b && rec.state === 'online' && b.heldItem ? { id: b.heldItem.name, count: b.heldItem.count } : null;
        return { ...v, held, history: rec.history || [], cmdArgs: rec.cmd ? rec.cmd.args : null, game: b && rec.state === 'online' && b.game ? { mode: b.game.gameMode, dimension: b.game.dimension } : null };
    }

    /** Entities near a bot (for attack / pickup / look_at): nearest first. */
    nearbyEntities(name, radius = 32) {
        const rec = this._online(name), me = rec.bot.entity.position, out = [];
        for (const e of Object.values(rec.bot.entities || {})) {
            if (!e || e === rec.bot.entity || !e.position) continue;
            const d = e.position.distanceTo(me); if (d > radius) continue;
            const item = e.name === 'item' && e.metadata ? (e.getDroppedItem ? e.getDroppedItem() : null) : null;
            out.push({ id: e.id, type: e.name || e.type, kind: e.type, username: e.username || null, item: item ? item.name : null, dist: Math.round(d * 10) / 10, pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) } });
        }
        return out.sort((a, b) => a.dist - b.dist).slice(0, 40);
    }

    /** Container blocks in the chunks a bot has loaded, within `radius` of it (for the inventory GUI). */
    containersNear(name, radius = 24) {
        const rec = this._online(name), b = rec.bot;
        const pos = b.findBlocks({ matching: (blk) => !!blk && inventory.CONTAINER.test(blk.name), maxDistance: Math.min(64, radius), count: 60 });
        return pos.map((p) => ({ x: p.x, y: p.y, z: p.z, block: b.blockAt(p)?.name || '?' }));
    }

    // ------------------------------------------------------------------------------------------------ inventories

    _run() { return (cmd) => this.rcon(cmd); }

    /** The bot's own view of its inventory (works without RCON; no stack NBT). Slots use the game's numbering. */
    _botSlots(rec) {
        const map = (w) => (w >= 36 && w <= 44 ? w - 36 : w >= 9 && w <= 35 ? w : w === 5 ? 103 : w === 6 ? 102 : w === 7 ? 101 : w === 8 ? 100 : w === 45 ? -106 : null);
        const out = [];
        (rec.bot.inventory.slots || []).forEach((it, w) => { const s = map(w); if (it && s !== null) out.push({ slot: s, id: it.name.includes(':') ? it.name : `minecraft:${it.name}`, count: it.count, label: null, damage: null, enchanted: false, nbt: null }); });
        return { kind: 'player', size: 36, slots: out };
    }

    async inventory(target) {
        let t; try { t = inventory.target(target); } catch (e) { throw new Problem(e.message); }
        if (!this.o.rcon) {
            const rec = t.type === 'entity' ? this.bots.get(t.name) : null;
            need(rec && rec.state === 'online', 'RCON is not configured: only bots can be read (no stack details)', 503);
            return this._botSlots(rec);
        }
        try { return await inventory.read(this._run(), t); } catch (e) { throw e instanceof Problem ? e : new Problem(e.message, /not configured/.test(e.message) ? 503 : 409); }
    }

    async moveStack({ src, srcSlot, dst, dstSlot = null }) {
        need(this.o.rcon, 'moving items needs RCON', 503);
        try {
            const r = await inventory.move(this._run(), src, srcSlot, dst, dstSlot);
            this.note('info', `moved ${r.moved.count} ${r.moved.id.replace('minecraft:', '')}: ${this._who(src)}[${r.from}] -> ${this._who(dst)}[${r.to}]`);
            return r;
        } catch (e) { throw e instanceof Problem ? e : new Problem(e.message, 409); }
    }
    async moveAllStacks({ src, dst }) {
        need(this.o.rcon, 'moving items needs RCON', 503);
        try { const r = await inventory.moveAll(this._run(), src, dst); this.note('info', `moved ${r.moved.length} stacks ${this._who(src)} -> ${this._who(dst)}${r.stopped ? ' (stopped: ' + r.stopped + ')' : ''}`); return r; }
        catch (e) { throw e instanceof Problem ? e : new Problem(e.message, 409); }
    }
    _who(t) { return t && t.type === 'entity' ? t.name : t && t.type === 'block' ? `${t.x},${t.y},${t.z}` : '?'; }

    // ------------------------------------------------------------------------------------------------ map

    mapIndex(dim = 'overworld') { need(this.maps.available, 'no world folder is mounted (WORK_WORLD)', 503); try { return { dim, regions: this.maps.index(dim) }; } catch (e) { throw new Problem(e.message, e.status || 400); } }
    async mapRegion(dim, rx, rz) { need(this.maps.available, 'no world folder is mounted (WORK_WORLD)', 503); try { return await this.maps.region(dim, rx, rz); } catch (e) { throw new Problem(e.message, e.status || 500); } }
    /** Ask the server to write its chunks to disk, then forget the cached regions: the map follows what the server has saved. */
    async mapRefresh() { need(this.o.rcon, 'refreshing the map needs RCON (save-all)', 503); await this.rcon('save-all flush'); this.maps.invalidate(); return { ok: true }; }

    setSettings(s) {
        if (s && typeof s.autoKit === 'boolean') this.settings.autoKit = s.autoKit;
        this._dirty();
        return this.settings;
    }

    // ------------------------------------------------------------------------------------------------ views

    _jobView(job, full = false) {
        const L = job.impl.ledger, p = L.progress();
        const v = {
            id: job.id, kind: job.kind, name: job.name, state: job.state, spec: { ...job.spec, file: undefined }, progress: p, bots: [...job.bots],
            stuck: L.stuck.length, repairs: job.repairs, workers: [...job.bots].filter((n) => this.bots.get(n)?.worker?.job === job.id).length, created: job.created, started: job.started, ended: job.ended, diff: job.diff,
            summary: job.summary, box: this._jobBox(job),
        };
        // Running with nobody able to work: every assigned bot is retired, offline or gone (the page shows it, nothing else will).
        v.blocked = job.state === 'running' && !v.workers && !L.finished() ? (job.bots.size ? 'no bot is working: ' + [...job.bots].map((n) => { const r = this.bots.get(n); return r ? `${n} ${r.retired || r.state}` : `${n} gone`; }).join(', ') : 'no bots assigned') : null;
        if (full) {
            v.report = L.report();
            v.regions = [...L.regions.values()].map((r) => ({ id: r.id, anchor: r.anchor, n: r.n, done: r.doneN, stuck: r.stuckN, leased: r.leasedN, meta: r.meta }));
        }
        return v;
    }
    jobDetail(id) { return this._jobView(this._job(id), true); }

    status() {
        return {
            now: Date.now(), uptime: Date.now() - this.started, server: { host: this.o.host, port: this.o.port }, settings: this.settings,
            rcon: !!this.o.rcon, kit: this.o.kit, maxBots: this.o.maxBots, map: this.maps.available,
            bots: [...this.bots.values()].filter((b) => !b.removed).map((b) => this._botView(b)),
            jobs: [...this.jobs.values()].map((j) => this._jobView(j)),
            log: this.log.filter((e) => e.level !== 'debug').slice(-60),
        };
    }

    async stop() {
        clearTimeout(this._saveTimer); this._saveTimer = null;
        try { this.save(); } catch (_) { /* best effort */ }
        for (const rec of this.bots.values()) { rec.removed = true; clearTimeout(rec.timer); this._stopWorker(rec); try { rec.bot && rec.bot.quit && rec.bot.quit(); } catch (_) { /* gone */ } }
        if (this._rcon) { try { this._rcon.close(); } catch (_) { /* gone */ } }
        this.maps.close();
    }
}

module.exports = { WorkService, Problem, normalizeBox, BOT_NAME, STRUCT_NAME, DEFAULT_KIT };

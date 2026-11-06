'use strict';
// The work service: a roster of pure bots (Mineflayer on the action layer, no policy, no LLM), jobs on the crew ledger (open
// pits, structures from blueprints), a structure library, and the operator helpers (player positions, kits) that need RCON.
// Everything the console (console.js) can do is a method here, validated; the HTTP layer adds authentication only.
// Design: docs/implemented/WORK-CONSOLE-v1.md. Jobs: docs/proposed/WORKERS-v1.md.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { MapStore } = require('../world/maps');
const { Sites } = require('../bot/sites');
const scriptLib = require('../bot/script');
const { Problems } = require('../bot/problems');
const { need, BOT_NAME, STRUCT_NAME, DEFAULT_KIT, Problem, normalizeBox } = require('./common');

/** Default bot factory: a Mineflayer bot with the FML3 handshake and the mod table (BOT_MOD_TABLE). */
function defaultFactory({ host, port }) {
    const { createForgeBot, attachForgeHandshake } = require('../../transport/forge_bot');
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
        this.o = { host: 'localhost', port: 25565, maxBots: 24, kit: DEFAULT_KIT, reconnectMs: 3000, coolMs: 60000, repairMs: 15000, restore: true, ...opts };
        this.o.kit = this.o.kit || DEFAULT_KIT;               // an explicit `kit: undefined` must not hide the default
        need(this.o.dataDir, 'dataDir');
        for (const d of ['structures', 'jobs', 'scripts']) fs.mkdirSync(path.join(this.o.dataDir, d), { recursive: true });
        this.factory = this.o.factory || defaultFactory(this.o);
        // `worker`: the env of a bot that works a job (defence, a place to dump trash away from every job); one-off commands get the plain env.
        this.envFactory = this.o.envFactory || ((bot, cancel, o = {}) => require('../bot/worker').botEnv(bot, {
            cancel, rcon: this.o.rcon ? (c) => this.rcon(c) : null,
            ...(o.worker ? { guard: true, defend: this.settings.defend !== false, avoid: () => this._activeBoxes(), others: () => this._botSpots(bot.username) } : {}),
        }));
        this.known = this.o.known || null;
        this.bots = new Map();            // name -> record
        this.jobs = new Map();            // id -> job
        this.log = [];
        this.settings = { autoKit: false, retireWorn: true, scripts: true, defend: true, glow: true, directPickup: true };      // retireWorn: a nearly broken tool counts as no tool; scripts: recovery scripts (missing tool) on
        this.problems = new Problems({ file: path.join(this.o.dataDir, 'problems.jsonl') });   // problem bots: where, facing, standing on what (problems.js)
        this.sites = new Sites();                                                  // tagged chests by coordinates (sites.js)
        this.scripts = new Map(scriptLib.BUILT_IN);                                // built in + the operator's own (dataDir/scripts/*.json)
        this._loadScripts();
        this.seq = 0;
        this._saveTimer = null;
        this._rcon = null; this._rconTail = Promise.resolve();
        this.maps = new MapStore(this.o.worldDir || null);
        this._watch = setInterval(() => this._watchWaiting(), 2000); this._watch.unref?.();
        this.cmdSeq = 0;
        this.started = Date.now();
    }

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
            settings: this.settings, seq: this.seq, sites: this.sites.list(),
            bots: [...this.bots.values()].filter((b) => !b.removed).map((b) => ({ name: b.name, job: b.job })),
            jobs: [...this.jobs.values()].map((j) => ({ id: j.id, kind: j.kind, name: j.name, spec: j.spec, state: j.state, created: j.created, bots: [...j.bots] })),
        };
        fs.writeFileSync(f + '.tmp', JSON.stringify(data)); fs.renameSync(f + '.tmp', f);
    }
    /** Bring back the roster and the jobs of the last run. Jobs come back paused: the world is the truth, units run again are no-ops. */
    async restore() {
        let d; try { d = JSON.parse(fs.readFileSync(path.join(this.o.dataDir, 'state.json'), 'utf8')); } catch (_) { return; }
        this.settings = { ...this.settings, ...(d.settings || {}) }; this.seq = d.seq || 0;
        this.sites = new Sites(d.sites || []);
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

    async stop() {
        clearTimeout(this._saveTimer); this._saveTimer = null;
        try { this.save(); } catch (_) { /* best effort */ }
        for (const rec of this.bots.values()) { rec.removed = true; clearTimeout(rec.timer); this._stopWorker(rec); try { rec.bot && rec.bot.quit && rec.bot.quit(); } catch (_) { /* gone */ } }
        if (this._rcon) { try { this._rcon.close(); } catch (_) { /* gone */ } }
        clearInterval(this._watch); this.maps.close();
    }
}

// The service is one class in several files, one per concern (each part is a class whose methods are copied here).
for (const file of ['bots', 'jobs', 'workers', 'structures', 'operator', 'commands', 'inventories', 'world', 'diagnostics', 'library', 'links', 'views']) {
    const Part = Object.values(require(`./${file}`))[0];
    for (const name of Object.getOwnPropertyNames(Part.prototype)) if (name !== 'constructor') Object.defineProperty(WorkService.prototype, name, Object.getOwnPropertyDescriptor(Part.prototype, name));
}

module.exports = { WorkService, Problem, normalizeBox, BOT_NAME, STRUCT_NAME, DEFAULT_KIT };

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
const { Gates } = require('../bot/queue');
const scriptLib = require('../bot/script');
const { Problems } = require('../bot/problems');
const { Health } = require('./health');
const watchdog = require('./watchdog');
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
     * @param opts.envFactory (bot, cancel) -> worker env (default: env.botEnv)
     * @param opts.rcon      {host, port, password} or null; or an object with command(cmd) (tests)
     * @param opts.known     (blockName) -> bool: does the bots' registry have this block (null = do not check)
     */
    constructor(opts) {
        super();
        this.o = { host: 'localhost', port: 25565, maxBots: 24, kit: DEFAULT_KIT, reconnectMs: 3000, coolMs: 5000, repairMs: 3000, restore: true, ...opts };
        this.o.kit = this.o.kit || DEFAULT_KIT;               // an explicit `kit: undefined` must not hide the default
        need(this.o.dataDir, 'dataDir');
        for (const d of ['structures', 'jobs', 'scripts']) fs.mkdirSync(path.join(this.o.dataDir, d), { recursive: true });
        this.factory = this.o.factory || defaultFactory(this.o);
        // `worker`: the env of a bot that works a job (defence, a place to dump trash away from every job); one-off commands get the plain env.
        this.envFactory = this.o.envFactory || ((bot, cancel, o = {}) => require('../bot/env').botEnv(bot, {
            cancel, rcon: this.o.rcon ? (c) => this.rcon(c) : null, moved: (m) => this._moved(bot.username, m), teleport: () => this.settings.teleport || 'near', gates: this.gates,
            ...(o.worker ? { guard: true, defend: this.settings.defend !== false, avoid: () => this._activeBoxes(), others: () => this._botSpots(bot.username) } : {}),
        }));
        this.known = this.o.known || null;
        this.gates = new Gates({ holdMs: 60000, waitMs: 180000 });                  // the lines at beds and containers (bot/queue.js)
        this.bots = new Map();            // name -> record
        this.jobs = new Map();            // id -> job
        this.log = [];
        this.settings = { autoKit: false, retireWorn: true, scripts: true, resumeJobs: true, defend: true, glow: true, directPickup: true, discardWorn: true, reflex: true, endDump: true, bedrockExploit: false, endDumpEnder: { left: 'white', middle: 'white', right: 'white' }, teleport: 'near', toolPolicy: { wooden: 'use_up', stone: 'use_up', iron: 'use_up', golden: 'use_up', diamond: 'keep', netherite: 'keep' }, display: { on: true, paths: true, lanes: true, tags: true } };      // retireWorn: a nearly broken tool counts as no tool; scripts: recovery scripts (missing tool) on
        this.problems = new Problems({ file: path.join(this.o.dataDir, 'problems.jsonl') });   // problem bots: where, facing, standing on what (problems.js)
        this.health = new Health({ file: this.o.dataDir ? path.join(this.o.dataDir, 'health.jsonl') : null });   // where the time goes, once a minute (health.js)
        this.sites = new Sites();                                                  // tagged chests by coordinates (sites.js)
        this.placed = new Set();                                                   // "x,y,z" of boxes (chest, shulker box, ender chest) a bot placed from its pack: only these may be broken (skills/fixtures.js)
        this.scripts = new Map(scriptLib.BUILT_IN);                                // built in + the operator's own (dataDir/scripts/*.json)
        this._loadScripts();
        this.seq = 0;
        this._saveTimer = null;
        this._rcon = null; this._rconTail = Promise.resolve();
        this.maps = new MapStore(this.o.worldDir || null);
        this._watch = setInterval(() => { this._watchWaiting(); this._watchDimension(); this._watchResume(); }, 2000); this._watch.unref?.();
        this.cmdSeq = 0;
        this.started = Date.now();
        this._startDisplay();
        // All bots live in this one process: whatever blocks the event loop stops every bot. Say so (and what the bots were doing) instead of leaving it a mystery.
        let lagAt = Date.now();
        this._lag = setInterval(() => {
            const now = Date.now(), late = now - lagAt - 250; lagAt = now;
            this._lagMax = Math.max(this._lagMax || 0, late);
            if (late > 1200) this.note('warn', `event loop blocked for ${late} ms (every bot stops meanwhile); busy: ${[...this.bots.values()].filter((r) => r.phase && now - r.phase.at < 30000).map((r) => `${r.name}:${r.phase.name}`).join(' ') || 'unknown'}`);
        }, 250);
        this._lag.unref?.();
        this._lagMax = 0;
        this._health = setInterval(() => this._heartbeat(), this.o.healthMs || 60000); this._health.unref?.();
    }

    /** Once a minute: the window's counters and a snapshot of the bots, into the log (one line) and health.jsonl; a window without a finished unit is a warning. */
    _heartbeat() {
        try {
            const bottoms = [...this.jobs.values()].filter((j) => j.state === 'running' && j.kind === 'pit' && j.spec && j.spec.box).map((j) => j.spec.box.bottom);
            const low = bottoms.length ? Math.min(...bottoms) + 4 : null;
            const bots = [...this.bots.values()].filter((r) => !r.removed && r.state === 'online').map((r) => ({
                name: r.name, working: !!(r.worker || r.script || (r.cmd && r.cmd.status === 'running')), retired: r.retired,
                phase: r.phase && Date.now() - r.phase.at < 180000 ? r.phase.name : null,
                onFloor: low !== null && !!(r.bot && r.bot.entity && r.bot.entity.position.y <= low),
            }));
            const h = this.health.flush({ bots, lines: this.gates.busy(), lagMs: this._lagMax }); this._lagMax = 0;
            if (bots.length || h.row.done || h.row.failed || h.row.cancelled) this.note(h.warn ? 'warn' : 'info', h.text);
            if (h.warn) this.note('warn', `STALL: ${h.warn}; ${h.text}`);
        } catch (e) { this.note('debug', `heartbeat failed: ${e.message}`); }
    }

    note(level, msg, extra = {}) {
        const e = { t: Date.now(), level, msg: String(msg).slice(0, 900), ...extra };
        this.log.push(e); if (this.log.length > 400) this.log.shift();
        this.emit('event', e);
        if (level !== 'debug') console.log(`[work] ${level} ${e.msg}`);
    }
    _dirty() { if (!this._saveTimer) this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 500); this._saveTimer.unref?.(); this.emit('change'); }
    save() {
        const f = path.join(this.o.dataDir, 'state.json');
        const data = {
            settings: this.settings, seq: this.seq, sites: this.sites.list(), placed: [...this.placed].slice(-300),
            bots: [...this.bots.values()].filter((b) => !b.removed).map((b) => ({ name: b.name, job: b.job })),
            jobs: [...this.jobs.values()].map((j) => ({ id: j.id, kind: j.kind, name: j.name, spec: j.spec, state: j.state, created: j.created, bots: [...j.bots] })),
        };
        fs.writeFileSync(f + '.tmp', JSON.stringify(data)); fs.renameSync(f + '.tmp', f);
    }
    /** Bring back the roster and the jobs of the last run. Jobs come back paused: the world is the truth, units run again are no-ops. */
    async restore() {
        let d; try { d = JSON.parse(fs.readFileSync(path.join(this.o.dataDir, 'state.json'), 'utf8')); } catch (_) { return; }
        this.settings = { ...this.settings, ...(d.settings || {}) }; this.seq = d.seq || 0;
        this._mapSaveTimer();
        this.sites = new Sites(d.sites || []);
        for (const k of Array.isArray(d.placed) ? d.placed : []) if (/^-?\d+,-?\d+,-?\d+$/.test(k)) this.placed.add(k);
        const fz = watchdog.lastFreeze(this.o.dataDir), looping = !!(fz && fz.n >= 3 && Date.now() - fz.at < 3600000);
        const resume = this.settings.resumeJobs !== false && !looping;
        if (looping) this.note('warn', `the process was frozen ${fz.n} times in the last hour (top of stack: ${(fz.stack || []).slice(0, 3).join(' < ')}): jobs come back paused, press Start`);
        for (const j of d.jobs || []) {
            try {
                const job = await this._rebuild(j);
                // A job that was running when the process ended comes back running (owner 2026-11-09: "it should resume by itself"); the world is the truth, units run again are no-ops.
                // Not after repeated freezes (watchdog.js): then it comes back paused so that a job that freezes the process cannot do it again every minute.
                job.state = ['finished', 'cancelled'].includes(j.state) ? j.state : (j.state === 'running' && resume ? 'running' : 'paused');
                job.bots = new Set((j.bots || []).filter((n) => BOT_NAME.test(n)));
                this.jobs.set(job.id, job);
            } catch (e) { this.note('warn', `job ${j.id} not restored: ${e.message}`); }
        }
        for (const b of d.bots || []) if (BOT_NAME.test(b.name)) { try { this.addBot(b.name, { job: this.jobs.has(b.job) ? b.job : null }); } catch (e) { this.note('warn', `bot ${b.name}: ${e.message}`); } }
        const running = [...this.jobs.values()].filter((j) => j.state === 'running').length;
        this.note('info', `restored ${this.bots.size} bots, ${this.jobs.size} jobs${running ? `, ${running} running again (bots work as soon as they are online)` : ' (paused: press Start)'}`);
    }

    async stop() {
        clearTimeout(this._saveTimer); this._saveTimer = null;
        try { this.save(); } catch (_) { /* best effort */ }
        for (const rec of this.bots.values()) { rec.removed = true; clearTimeout(rec.timer); this._stopWorker(rec); try { rec.bot && rec.bot.quit && rec.bot.quit(); } catch (_) { /* gone */ } }
        if (this._rcon) { try { this._rcon.close(); } catch (_) { /* gone */ } }
        clearInterval(this._watch); clearInterval(this._lag); clearInterval(this._mapSave); this.maps.close(); if (this.display) this.display.stop();
    }
}

// The service is one class in several files, one per concern (each part is a class whose methods are copied here).
for (const file of ['bots', 'jobs', 'workers', 'structures', 'operator', 'commands', 'inventories', 'world', 'diagnostics', 'library', 'ender', 'links', 'display', 'views']) {
    const Part = Object.values(require(`./${file}`))[0];
    for (const name of Object.getOwnPropertyNames(Part.prototype)) if (name !== 'constructor') Object.defineProperty(WorkService.prototype, name, Object.getOwnPropertyDescriptor(Part.prototype, name));
}

module.exports = { WorkService, Problem, normalizeBox, BOT_NAME, STRUCT_NAME, DEFAULT_KIT };

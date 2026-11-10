'use strict';
// The roster: bots that connect, reconnect, and what the page shows about each.
// A part of WorkService (index.js copies these methods onto it).
const { need, BOT_NAME } = require('./common');
const dimensions = require('../world/dimensions');

class BotsPart {
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
        bot.__noVines = true;                  // the planner does not climb vines (see skills/world.js)
        // Owner rule (2026-11-09): a box or tagged block the bots did not place is never broken. The Set of own boxes is shared and kept across restarts.
        bot.__placed = this.placed;
        bot.__temps = this.temps;                 // the shared list of placed blocks (water seals, pillars ...): registered when placed, forgotten when broken, cleaned up (bot/temps.js)
        // Reflexes (fall: water bucket or a block under the feet; lava): one watcher per bot, whatever it is doing (work/bot/reflex.js).
        try {
            bot.__reflex = require('../bot/reflex').attach(bot, { world: require('../../skills/world').fromBot(bot), enabled: () => this.settings.reflex !== false, onEvent: (n, d) => this._reflexEvent(rec, n, d) });
        } catch (e) { this.note('warn', `${rec.name}: reflexes not attached: ${String(e.message).slice(0, 80)}`); }
        require('../../skills/options').configure(bot, { fixture: (name, x, y, z) => this.isFixture(name, x, y, z), toolPolicy: this.settings.toolPolicy });
        this._trackPath(rec, bot);
        // How long a bot goes without a physics tick (50 ms each): if every bot shows the same gap at the same moment, the process or the server stalled; one bot alone, it was waiting.
        bot.on('physicsTick', () => {
            const now = Date.now(), gap = rec.tickAt ? now - rec.tickAt : 0; rec.tickAt = now;
            if (gap > 1500 && rec.state === 'online' && mine()) this.note('warn', `${rec.name}: no physics tick for ${gap} ms (phase ${rec.phase ? rec.phase.name : 'none'}); others: ${[...this.bots.values()].filter((r) => r !== rec && r.tickAt).map((r) => `${r.name}:${now - r.tickAt}`).join(' ')}`);
        });
        const mine = () => rec.bot === bot && !rec.removed;
        bot.once('spawn', () => { if (!mine()) return; rec.state = 'online'; rec.attempts = 0; rec.since = Date.now(); this.note('info', `bot ${rec.name} online`); this._tagDirect(rec); this._dirty(); this._resume(rec); });
        bot.on('spawn', () => { if (mine() && rec.state === 'online') setTimeout(() => this._resume(rec), 2500); });        // respawn after death
        bot.on('death', () => { if (mine()) { this.note('warn', `bot ${rec.name} died`); this.force.reset(rec.name); } });
        bot.on('error', (e) => { if (mine()) rec.error = String((e && e.message) || e).slice(0, 200); });
        bot.on('kicked', (r) => { if (mine()) { rec.error = `kicked: ${JSON.stringify(r).slice(0, 160)}`; this.note('warn', `bot ${rec.name} ${rec.error}`); } });
        bot.on('end', (why) => {
            if (!mine()) return;
            rec.state = 'offline'; this._stopWorker(rec);
            this.note('warn', `bot ${rec.name} disconnected${rec.error ? ': ' + rec.error : ''} (${String(why).slice(0, 60)})`);
            this._retry(rec); this._dirty();
        });
    }
    /**
     * A bot that is not in the overworld (a portal block on its way, a respawn anchor ...) is sent back by the server: the work layer knows one place that is safe on the
     * surface, the depot of an active job. Live pit 2026-11-07: a bot that had respawned at the world spawn walked into a nether portal and crafted in the Nether.
     * Called every few seconds; one try per bot per 15 s.
     */
    _watchDimension() {
        if (!this.o.rcon) return;
        const now = Date.now();
        for (const rec of this.bots.values()) {
            const dim = rec.bot && rec.state === 'online' && rec.bot.game ? (dimensions.canon(rec.bot.game.dimension) || String(rec.bot.game.dimension || '')) : '';
            if (!dim || dim === 'overworld' || rec.crossing || now - (rec.dimTry || 0) < 15000) continue;      // `crossing`: a journey through a portal is on purpose
            // On purpose too: the dimension of its active job, and the one the operator sent it to (journey / teleport with a dimension set `inDim`).
            const job = rec.job && this.jobs.get(rec.job);
            if (rec.inDim === dim || (job && ['running', 'paused', 'ready'].includes(job.state) && (job.spec.dim || 'overworld') === dim)) continue;
            rec.dimTry = now;
            if (this.settings.teleport === 'off') { if (now - (rec.dimNote || 0) > 600000) { rec.dimNote = now; this.note('warn', `${rec.name} is in ${dim}, not in a job's dimension; server moves are off, so it stays (walk it to a gate: move with a dimension)`); } continue; }
            let depot = null;
            for (const j of this.jobs.values()) { const d = j.spec && j.spec.depot; if (d && Number.isInteger(d.x) && Number.isInteger(d.y) && Number.isInteger(d.z)) { depot = d; if (['running', 'paused'].includes(j.state)) break; } }
            if (!depot) { this.note('warn', `${rec.name} is in ${dim} and no job depot is known to send it back`); continue; }
            this.rcon(`execute in minecraft:overworld run tp ${rec.name} ${depot.x}.5 ${depot.y + 2} ${depot.z}.5`)
                .then(() => this.note('warn', `${rec.name} was in ${dim}: sent back to the overworld (depot ${depot.x} ${depot.y} ${depot.z})`))
                .catch((e) => this.note('warn', `${rec.name} is in ${dim}: could not send it back (${String(e.message).slice(0, 80)})`));
        }
    }
    _reflexEvent(rec, name, d) {
        if (name === 'reflex') { rec.reflex = { kind: d.kind, at: Date.now() }; rec.reflexes = (rec.reflexes || 0) + 1; this.note('warn', `${rec.name}: reflex ${d.kind}${d.drop ? ` (${d.drop} blocks of air below)` : ''}${d.kind === 'fall' ? (d.bucket ? ', water bucket' : ', no bucket') : ''}`); this._dirty(); }
        else if (name === 'reflex_end') this.note('info', `${rec.name}: reflex ${d.name} over${d.error ? ' (failed)' : ''}; the work goes on`);
    }
    /** The server moved a bot (tp): said in the log and in the bot's row, so that a jump is never a mystery. */
    _moved(name, m) {
        const rec = this.bots.get(name); if (!rec) return;
        rec.lastMove = { ...m, at: Date.now() }; rec.moves = (rec.moves || 0) + 1;
        this.note('info', `${name} was moved by the server ${m.dist} blocks (${m.why}): ${m.from.x} ${m.from.y} ${m.from.z} -> ${m.to.x} ${m.to.y} ${m.to.z}`);
        this._dirty();
    }
    /** A trained expert (src/experts) took over a move: one line for the log and a counter per bot (`rec.expertUses`: {expert: {n, ok}}). */
    _expertLog(name, m) {
        const rec = this.bots.get(name); if (!rec) return;
        const u = (rec.expertUses = rec.expertUses || {}), e = (u[m.expert] = u[m.expert] || { n: 0, ok: 0 });
        e.n++; if (m.ok) e.ok++;
        this.note(m.ok ? 'info' : 'warn', `${name}: the ${m.expert} expert ${m.ok ? 'got the bot' : `failed (${m.reason})`} from ${m.from.x} ${m.from.y} ${m.from.z} to ${m.to.x} ${m.to.y} ${m.to.z} (aim ${m.target.x} ${m.target.y} ${m.target.z}) in ${m.steps} steps, ${Math.round(m.ms / 1000)} s${m.why ? `: ${m.why}` : ''}`);
        this._dirty();
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
            name: rec.name, state: rec.state, dim: e && b.game && b.game.dimension ? (dimensions.canon(b.game.dimension) || String(b.game.dimension)) : null, job: rec.job, working: !!rec.worker, retired: rec.retired, error: rec.error,
            cmd: rec.cmd ? { id: rec.cmd.id, name: rec.cmd.name, status: rec.cmd.status, since: rec.cmd.started, result: rec.cmd.result || null, progress: rec.cmd.progress || null } : null,
            pos: e ? { x: Math.round(e.position.x * 10) / 10, y: Math.round(e.position.y * 10) / 10, z: Math.round(e.position.z * 10) / 10 } : null,
            health: b && rec.state === 'online' ? b.health ?? null : null, food: b && rec.state === 'online' ? b.food ?? null : null,
            pickaxes: count(/_pickaxe$/), free: b && b.inventory && rec.state === 'online' ? b.inventory.emptySlotCount?.() ?? null : null,
            // tools with their durability, for the table and the summary: worn = the retireWorn rule passes them over
            tools: items.filter((i) => i.maxDurability && /(_pickaxe|_axe|_shovel|_hoe|_sword)$/.test(i.name)).slice(0, 12).map((i) => ({ name: i.name, left: i.maxDurability - (i.durabilityUsed || 0), max: i.maxDurability, worn: this._worn(b, i) })),
            script: rec.script ? rec.script.name : null,
            routine: rec.script && rec.script.routine ? { ...rec.script.routine } : null,
            // what it is doing now (the action layer's phase, seconds since it began) and the last problem: a bot that stands and searches a path, or glows, says why
            phase: rec.phase && rec.state === 'online' && Date.now() - rec.phase.at < (rec.worker ? 15000 : 180000) && (rec.worker || rec.cmd && rec.cmd.status === 'running') ? { name: rec.phase.name, s: Math.round((Date.now() - rec.phase.at) / 1000) } : null,
            act: this._actView(rec),
            problem: rec.problem ? { kind: rec.problem.kind, reason: rec.problem.reason, stage: rec.problem.stage, cell: rec.problem.cell, s: Math.round((Date.now() - rec.problem.at) / 1000) } : null,
            inPit: this._inPit(rec),
            reflex: rec.reflex && Date.now() - rec.reflex.at < 120000 ? { kind: rec.reflex.kind, s: Math.round((Date.now() - rec.reflex.at) / 1000), n: rec.reflexes } : null,
            moved: rec.lastMove && Date.now() - rec.lastMove.at < 120000 ? { dist: rec.lastMove.dist, why: rec.lastMove.why, s: Math.round((Date.now() - rec.lastMove.at) / 1000), n: rec.moves } : null,
        };
    }
}

module.exports = { BotsPart };

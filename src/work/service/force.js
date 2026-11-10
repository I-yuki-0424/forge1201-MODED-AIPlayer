'use strict';
// Pushing bots that do nothing (owner 2026-11-10; decision in bot/force.js): a forced FALL for a high bot that has not moved for 30 s, a forced KILL for a bot that has failed for 60 s
// or that stays put after its fall. Both are written to forced.jsonl and counted in the health row (`forced`), so that "how often does this happen" is a number. Settings `forceFall`
// and `forceKill` (on by default) switch them off one at a time. A part of WorkService.
const fs = require('fs');
const path = require('path');
const { isHigh } = require('../bot/force');
const { CONTAINER } = require('../bot/janitor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ForcePart {
    /** Every 2 s (from _sampleBots): decide for each working bot and carry it out. */
    _watchForce() {
        if (!this.force || (this.settings.forceFall === false && this.settings.forceKill === false)) return;
        const now = Date.now();
        for (const rec of this.bots.values()) {
            if (rec.removed || rec.state !== 'online' || !rec.bot || !rec.bot.entity || rec.forcing) continue;
            const working = !!(rec.worker && !rec.worker.dump && rec.worker.job) || !!(rec.retired && /^cooling/.test(rec.retired));
            const p = rec.bot.entity.position, f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
            let high = false;
            try { const w = require('../../skills/world').fromBot(rec.bot); high = isHigh((x, y, z) => w.kindAt(x, y, z), f); } catch (_) { high = false; }
            const d = this.force.decide(rec.name, { working, act: rec.act && rec.act.name, sub: rec.act && rec.act.sub && rec.act.sub.name, stillMs: rec.stillSince ? now - rec.stillSince : 0, high, now });
            if (!d) continue;
            if (d.action === 'fall' && this.settings.forceFall === false) continue;
            if (d.action === 'kill' && (this.settings.forceKill === false || !this.o.rcon)) continue;
            rec.forcing = true;
            this._force(rec, d, f).catch((e) => this.note('warn', `forced ${d.action} of ${rec.name} failed: ${String(e && e.message || e).slice(0, 100)}`)).finally(() => { rec.forcing = false; });
        }
    }

    async _force(rec, d, f) {
        const now = Date.now(), job = this.jobs.get(rec.job) || null;
        const row = { t: now, bot: rec.name, kind: d.action, cause: d.cause, still: Math.round(d.stillMs / 1000), errFor: Math.round(d.errorMs / 1000), act: rec.act && (rec.act.sub ? rec.act.sub.name : rec.act.name), pos: [f.x, f.y, f.z], job: rec.job || null, hp: rec.bot.health };
        let how = null;
        if (d.action === 'fall') how = await this._forceFall(rec, f);
        else { await this.rcon(`kill ${rec.name}`); how = 'kill'; }
        row.how = how;
        this.force.did(rec.name, how === 'none' ? 'fall' : d.action, Date.now());
        this.health.force(d.action, d.cause.split(':')[0]);
        this._forcedLog(row);
        this.note('warn', `forced ${d.action} of ${rec.name} (${d.cause}; still ${row.still} s${row.errFor ? `, failing ${row.errFor} s` : ''}; at ${f.x} ${f.y} ${f.z}; ${how})`, { job: rec.job || undefined, forced: row });
        if (job) this._problem(rec, `forced_${d.action}`, { reason: d.cause, job: rec.job, cell: [f.x, f.y, f.z] });
    }

    /**
     * The fall: the block under the feet is broken from where the bot stands (never a container, bed or tagged block); when there is none to break (nothing under the feet: it stands on another
     * bot) it steps off sideways. The reflex that would catch the fall (reflex.js) is off for 12 s and the running command is stopped (`bot.__preempt`), as the reflex does it.
     * Returns what was done: 'dug', 'stepped' or 'none'.
     */
    async _forceFall(rec, f) {
        const bot = rec.bot, w = require('../../skills/world').fromBot(bot);
        bot.__noReflexUntil = Date.now() + 12000; bot.__preempt = true;
        try {
            const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
            if (under && w.kindAt(f.x, f.y - 1, f.z) === 'solid' && !CONTAINER.test(under.name) && !this.isFixture(under.name, under.position.x, under.position.y, under.position.z)) {
                try { await Promise.race([bot.dig(under, true), sleep(7000).then(() => { throw new Error('dig timed out'); })]); } catch (e) { try { bot.stopDigging(); } catch (_) { /* not digging */ } }
                await sleep(300);
                if (!bot.entity.onGround || w.kindAt(f.x, f.y - 1, f.z) !== 'solid') return 'dug';
            }
            // Step off: the way with air beside the feet; walk one second that way.
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5)) {
                if (w.kindAt(f.x + dx, f.y, f.z + dz) !== 'air' || w.kindAt(f.x + dx, f.y - 1, f.z + dz) === 'solid') continue;
                await bot.look(Math.atan2(-dx, -dz), 0, true);
                bot.setControlState('forward', true); await sleep(900); bot.setControlState('forward', false);
                return 'stepped';
            }
            return 'none';
        } finally { bot.__preempt = false; }
    }

    _forcedLog(row) {
        if (!this.o.dataDir) return;
        const file = path.join(this.o.dataDir, 'forced.jsonl');
        try {
            if ((this._forcedWrites = (this._forcedWrites || 0) + 1) % 50 === 1) { try { if (fs.statSync(file).size > 2e6) fs.renameSync(file, file + '.1'); } catch (_) { /* no file yet */ } }
            fs.appendFileSync(file, JSON.stringify(row) + '\n');
        } catch (_) { /* a log is never a reason to stop work */ }
    }
}

module.exports = { ForcePart };

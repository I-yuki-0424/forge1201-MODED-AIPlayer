'use strict';
// The loop of a bot that works a job: start, restock, wait for a tool, retire or cool down, finish the job.
// A part of WorkService (index.js copies these methods onto it).
const { runWorker } = require('../bot/worker');
const scriptLib = require('../bot/script');
const { need, ITEM_ID } = require('./common');

class WorkersPart {
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
            env = this.envFactory(rec.bot, cancel, { worker: true });
            if (env && env.configure) env.configure({ retireWorn: !!this.settings.retireWorn, defend: this.settings.defend !== false });
            // Three usable pickaxes in the pack before the work starts (stock-tools: from the tools chest, when one is in reach): a worn one is replaced on the spot.
            if (this.settings.scripts && this.sites.find('tools') && this.scripts.get('stock-tools')) {
                try {
                    const senv = Object.assign(Object.create(env), { sites: this.sites, policy: job.policy, box: job.spec.box });
                    const sr = await scriptLib.runScript(this.scripts.get('stock-tools'), senv, { cancel });
                    this.note(sr.ok ? 'info' : 'warn', `${rec.name} stock-tools: ${sr.ended}${sr.log && sr.log.length ? ` (${sr.log.slice(-3).join('; ')})` : ''}`, { job: job.id });
                } catch (e) { this.note('warn', `${rec.name} stock-tools failed: ${String(e.message).slice(0, 100)}`); }
            }
        } catch (e) { rec.worker = null; this.note('warn', `bot ${rec.name}: cannot start (${e.message})`); return; }
        this._dirty();
        runWorker(job.impl, rec.name, env, {
            cancel, policy: job.policy, pollMs: 1000, backoff: this.o.backoff,
            handlers: this.settings.scripts ? { missing_tool: this.scripts.get('replace-tool') } : null,
            scriptEnv: () => ({ sites: this.sites, policy: job.policy, box: job.spec.box }),
            onEvent: (ev, d) => {
                if (ev === 'unit' && d.ok) { rec.fixes = 0; rec.cool = 0; this._clearGlow(rec); }
                // A problem is written down where it happens and the bot glows (problems.js): unit failures that are the unit's or the bot's own trouble,
                // failed repairs, scripts and janitor runs that gave up, a pit range that keeps refilling.
                if ((ev === 'unit' && !d.ok && !['cancelled'].includes(d.reason)) || ev === 'janitor_failed' || (ev === 'script' && !d.ok) || (ev === 'audit' && d.gaveUp) || ev === 'audit_failed') {
                    this._problem(rec, ev === 'unit' ? 'unit_failed' : ev, { reason: d.reason || d.ended, stage: d.detail && d.detail.stage, why: ev === 'script' ? (d.log || []).slice(-3).join('; ') : d.detail && (d.detail.why || d.detail.goal), cell: d.detail && d.detail.cell, job: job.id, region: d.region, unit: d.unit });
                }
                if (ev === 'defend' && d.fought) this.note('info', `${rec.name} defended itself: ${d.killed}/${d.fought} killed`, { job: job.id });
                if (ev === 'audit') this.note(d.gaveUp ? 'warn' : 'info', `${d.id} range check: ${d.reopened} unit(s) sent back, ${d.gaveUp} given up on`, { job: job.id, first: d.first });
                if (ev === 'temp_cleaned') this.note('info', `${d.id} removed ${d.n} temporary block(s)`, { job: job.id });
                if (ev === 'recover') this.note('debug', `${d.id} fix level ${d.streak + 1} after ${d.reason}`, { job: job.id });
                if (ev === 'unit') {                                                    // a record of what happened, for the job's detail view (why does it stop?)
                    const e = rec.bot && rec.bot.entity && rec.bot.entity.position;
                    (job.recent = job.recent || []).push({ t: Date.now(), bot: d.id, region: d.region, unit: d.unit, ok: d.ok, reason: d.reason || null, ms: d.ms, stage: d.detail && d.detail.stage, cell: d.detail && d.detail.cell, why: d.detail && (d.detail.why || d.detail.goal), pos: e ? [Math.round(e.x * 10) / 10, Math.round(e.y * 10) / 10, Math.round(e.z * 10) / 10] : null, hp: rec.bot && rec.bot.health });
                    if (job.recent.length > 120) job.recent.shift();
                }
                if (ev === 'unit' && !d.ok) {
                    rec.missing = d.reason === 'missing_item' && d.detail && ITEM_ID.test(String(d.detail.item)) ? String(d.detail.item) : null;
                    rec.missingTool = d.reason === 'missing_tool' && d.detail && typeof d.detail.block === 'string' ? d.detail.block : null;
                    this.note('debug', `${d.id} ${d.region} u${d.unit} ${d.reason}`, { job: job.id, detail: d.detail });
                }
                if (ev === 'janitor_failed') this.note('debug', `${d.id} janitor ${d.reason}`, { job: job.id });
                if (ev === 'script') this.note(d.ok ? 'info' : 'warn', `${d.id} script ${d.name} for ${d.reason}: ${d.ended}${d.log && d.log.length ? ` (${d.log.slice(-4).join('; ')})` : ''}`, { job: job.id });
                if (ev === 'rescue' && (d.filled || d.surfaced)) this.note('info', `${d.id} water rescue: ${d.surfaced ? 'to the shore, ' : ''}${d.filled} filled${d.ok ? '' : ` (${d.reason})`}`, { job: job.id });
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

    _toolClass(rec, block) {
        const reg = rec.bot && rec.bot.registry, b = reg && reg.blocksByName[block];
        if (!b || !b.harvestTools) return null;
        return [...new Set(Object.keys(b.harvestTools).map((id) => reg.items[id] && reg.items[id].name).filter(Boolean).map((n) => n.split('_').pop()))].join(' or ') || null;
    }
    _canBreak(rec, block) {
        const reg = rec.bot.registry, b = reg.blocksByName[block];
        if (!b || !b.harvestTools) return true;
        const worn = (i) => { try { return require('../../skills/options').isWorn(rec.bot, i); } catch (_) { return false; } };       // a worn-out tool is no tool (the worker thinks so too)
        return rec.bot.inventory.items().some((i) => { const it = reg.itemsByName[i.name]; return it && b.harvestTools[it.id] && !worn(i); });
    }
    /** A bot that waits for a tool or an item goes back to work by itself as soon as the inventory has it (the operator gave it through the GUI). */
    _watchWaiting() {
        for (const rec of this.bots.values()) {
            if (rec.removed || !rec.retired || !rec.waitFor || rec.state !== 'online' || !rec.bot) continue;
            let ok = false;
            try {
                if (rec.waitFor.tool) ok = this._canBreak(rec, rec.waitFor.tool);
                else if (rec.waitFor.item) ok = rec.bot.inventory.items().some((i) => i.name === rec.waitFor.item.replace(/^minecraft:/, '') && i.count > 0);
            } catch (_) { ok = false; }
            if (ok) { rec.retired = null; rec.waitFor = null; rec.fixes = 0; this.note('info', `bot ${rec.name} has what it waited for: continues`); this._resume(rec); this._dirty(); }
            // Waiting for a tool is not waiting for the operator (owner 2026-11-07): every 15 s the bot tries the replace-tool script again (the tools chest, then
            // iron or stone made from what it carries), so a chest that was filled or a mined ingot gets it going without a click.
            else if (rec.waitFor.tool && !rec.script && !rec.worker && this.settings.scripts && Date.now() - (rec.replaceAt || 0) > 15000) {
                rec.replaceAt = Date.now();
                this.runScript(rec.name, 'replace-tool').then((r) => { this.note(r.ok ? 'info' : 'warn', `${rec.name} replace-tool while waiting: ${r.ended}${r.log && r.log.length ? ` (${r.log.slice(-4).join('; ')})` : ''}`); }, (e) => this.note('debug', `${rec.name} replace-tool: ${e.message}`));
            }
        }
    }

    /** Un-retire a bot (after a kit, materials, or a look in the game) and put it back to work. */
    resumeBot(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        rec.retired = null; rec.missing = null; rec.waitFor = null; rec.fixes = 0; rec.cool = 0; clearTimeout(rec.coolTimer);
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
                if (res.last === 'missing_tool' && rec.missingTool) {
                    const cls = this._toolClass(rec, rec.missingTool);
                    rec.waitFor = { tool: rec.missingTool };
                    rec.retired = `waiting for ${cls ? 'a ' + cls : 'a tool'} (to break ${rec.missingTool.replace('minecraft:', '')}): give one in Inventory and it continues by itself`;
                } else if (res.last === 'missing_item' && rec.missing) {
                    rec.waitFor = { item: rec.missing };
                    rec.retired = `waiting for ${rec.missing.replace('minecraft:', '')}: give some in Inventory and it continues by itself`;
                } else {                                              // owner 2026-11-07: never retired for good; a short rest, then it tries again, as often as it takes
                    // Repeated failures after fixes and waits: rest a minute, then try again by itself (up to six times in a row).
                    rec.cool = (rec.cool || 0) + 1; rec.retired = `cooling down after ${res.last || 'repeated failures'} (try ${rec.cool}), resumes by itself`;
                    clearTimeout(rec.coolTimer);
                    rec.coolTimer = setTimeout(() => { if (!rec.removed && rec.retired && rec.retired.startsWith('cooling')) { rec.retired = null; this._resume(rec); this._dirty(); } }, this.o.coolMs);
                    rec.coolTimer.unref?.();
                }
                this.note('warn', `bot ${rec.name} ${rec.retired}`);
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
        if (L.stuck.length && job.repairs < 30) {                                          // up to three repair passes, a few seconds apart (some problems pass by themselves)
            job.repairs++;
            this.note('info', `job ${job.id}: ${L.stuck.length} stuck units, repair pass ${job.repairs} of 30 in ${Math.round(this.o.repairMs / 1000)} s`);
            setTimeout(() => {
                if (job.state !== 'running') return;
                const n = L.requeueStuck(Date.now());
                if (n) for (const name of job.bots) this._startWorker(job, this.bots.get(name));
                else this._maybeFinish(job);
            }, this.o.repairMs).unref?.();
            return;
        }
        job.state = 'finished'; job.ended = Date.now();
        if (job.kind === 'build') {
            const rec = [...job.bots].map((n) => this.bots.get(n)).find((r) => r && r.state === 'online');
            if (rec) { try { job.diff = job.impl.diff(require('../../skills/world').fromBot(rec.bot)).length; } catch (_) { /* world not readable */ } }
        }
        for (const n of job.bots) { const rec = this.bots.get(n); if (rec && rec.job === job.id) rec.job = null; }
        job.bots.clear();
        this.note('info', `job ${job.id} finished: ${JSON.stringify(L.progress())}${job.diff !== null ? ` diff ${job.diff}` : ''}`);
    }
}

module.exports = { WorkersPart };

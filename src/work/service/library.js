'use strict';
// Sites (tagged blocks by coordinates) and scripts.
// A part of WorkService (index.js copies these methods onto it).
const fs = require('fs');
const path = require('path');
const scriptLib = require('../bot/script');
const { Problem, need } = require('./common');

class LibraryPart {
    /** The tagged blocks with what the world says is there now (from a bot's loaded chunks, null if none is near) and where each link ends. */
    listSites() {
        const sites = this.sites.list().map((s) => {
            const out = { ...s, block: this._blockName(s.x, s.y, s.z) };
            out.missing = /^(minecraft:)?(air|cave_air|void_air)$/.test(out.block || '') && s.purpose !== 'other';          // the coordinates point at nothing (a bot sees the chunk): wrong cell, or the block was taken away
            if (s.via) { try { const e = this.sites.through(s.x, s.y, s.z); out.end = { x: e.x, y: e.y, z: e.z, path: e.via }; } catch (e) { out.broken = e.message; } }
            return out;
        });
        const { PURPOSES } = require('../bot/sites');
        return { tags: PURPOSES, purposes: PURPOSES, sites, migrated: this.sites.migrated, colours: require('../world/enderstorage').COLOURS };
    }
    /** Must this block stay? A box or a tagged block that no bot placed from its pack is the owner's (skills/fixtures.js); the bots use what is inside, never break it. */
    isFixture(name, x, y, z) {
        if (this.placed.has(`${x},${y},${z}`)) return false;
        const fx = require('../../skills/fixtures');
        return fx.isBox(name) || fx.isBed(name) || !!this.sites.at(x, y, z);          // a bed is one too: it may be the respawn point (owner 2026-11-10)
    }
    addSite(s) {
        // A container purpose on a cell that a bot sees as air is a typo in the coordinates (owner 2026-11-09: the tools chest was tagged one chest over and "did not respond").
        if (s && Number.isInteger(s.x) && Number.isInteger(s.y) && Number.isInteger(s.z) && s.purpose !== 'other' && s.purpose !== 'portal') {
            const bn = this._blockName(s.x, s.y, s.z);
            if (bn && /^(minecraft:)?(air|cave_air|void_air)$/.test(bn)) throw new Problem(`there is nothing at ${s.x} ${s.y} ${s.z} (air): check the coordinates (the Tag Tool and "block near a bot" give exact ones)`);
        }
        let site; try { site = this.sites.add(s); } catch (e) { throw new Problem(e.message); } this._dirty(); return site; }
    removeSite(name) {
        let gone; try { gone = this.sites.remove(String(name)); } catch (e) { throw new Problem(e.message, 409); }
        need(gone, `no site ${String(name).slice(0, 24)}`, 404); this._dirty(); return { ok: true };
    }
    /** Block name at x, y, z from the chunks of any online bot (best effort: null when nobody has the chunk). */
    _blockName(x, y, z) {
        for (const rec of this.bots.values()) {
            if (rec.state !== 'online' || !rec.bot || !rec.bot.blockAt) continue;
            try { const b = rec.bot.blockAt(new (require('vec3').Vec3)(x, y, z)); if (b) return b.name; } catch (_) { /* not loaded for this bot */ }
        }
        return null;
    }

    _loadScripts() {
        const dir = path.join(this.o.dataDir, 'scripts');
        let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return; }
        for (const f of files) { try { const sc = scriptLib.validate(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); this.scripts.set(sc.name, sc); } catch (e) { this.note('warn', `script ${f}: ${e.message}`); } }
    }
    listScripts() { return [...this.scripts.values()].map((sc) => ({ name: sc.name, builtIn: scriptLib.BUILT_IN.has(sc.name) && this.scripts.get(sc.name) === scriptLib.BUILT_IN.get(sc.name), steps: sc.steps })); }
    putScript(sc) {
        let v; try { v = scriptLib.validate(sc); } catch (e) { throw new Problem(e.message); }
        need(!scriptLib.BUILT_IN.has(v.name), 'a built-in script cannot be replaced: give yours another name');
        fs.writeFileSync(path.join(this.o.dataDir, 'scripts', `${v.name}.json`), JSON.stringify(v, null, 2));
        this.scripts.set(v.name, v);
        return { name: v.name, steps: v.steps };
    }
    deleteScript(name) { need(this.scripts.has(name) && !scriptLib.BUILT_IN.has(name), `no script ${String(name).slice(0, 32)} (built-in scripts stay)`, 404); this.scripts.delete(name); fs.rmSync(path.join(this.o.dataDir, 'scripts', `${path.basename(name)}.json`), { force: true }); return { ok: true }; }
    /**
     * Start a stored script as a routine: over and over until Stop (or the same failure five rounds in a row). Returns at once; progress is `script` / `routine` in the bot view.
     */
    startRoutine(botName, scriptName, { pauseMs = 2000 } = {}) {
        const rec = this.bots.get(botName); need(rec && !rec.removed && rec.state === 'online' && rec.bot, `no online bot ${botName}`, 404);
        const sc = this.scripts.get(scriptName); need(sc, `no script ${String(scriptName).slice(0, 32)}`, 404);
        need(Number.isInteger(pauseMs) && pauseMs >= 500 && pauseMs <= 60000, 'pauseMs: 500..60000');
        need(!rec.worker && !rec.script && !(rec.cmd && rec.cmd.status === 'running'), `bot ${botName} is busy`, 409);
        const cancel = { cancelled: false }; rec.script = { cancel, name: sc.name, routine: { rounds: 0, fails: 0, since: Date.now() } };
        (async () => {
            try {
                const env = this.envFactory(rec.bot, cancel); if (env && env.configure) env.configure({ retireWorn: !!this.settings.retireWorn });
                const senv = Object.assign(Object.create(env), { sites: this.sites });
                senv.leavePit = null;
                const res = await scriptLib.runLoop(sc, senv, { cancel, pauseMs, onRound: (r) => { if (rec.script) { rec.script.routine.rounds = r.rounds; rec.script.routine.fails = r.fails; rec.script.routine.last = r.last.ok ? 'ok' : r.last.reason || r.last.ended; this._dirty(); } } });
                this.note(res.ok ? 'info' : 'warn', `${botName}: routine ${sc.name} ${res.ended} after ${res.rounds} rounds${res.reason ? ` (${res.reason})` : ''}`);
            } catch (e) { this.note('warn', `${botName}: routine ${sc.name} failed: ${String(e.message).slice(0, 120)}`); }
            finally { rec.script = null; this._dirty(); }
        })();
        return { started: true, bot: botName, script: sc.name };
    }
    /** Run a stored script once on a bot (the operator's "do this now"): { ended, ok, steps, log }. */
    async runScript(botName, scriptName) {
        const rec = this.bots.get(botName); need(rec && !rec.removed && rec.state === 'online' && rec.bot, `no online bot ${botName}`, 404);
        const sc = this.scripts.get(scriptName); need(sc, `no script ${String(scriptName).slice(0, 32)}`, 404);
        need(!rec.worker && !rec.script, `bot ${botName} is busy`, 409);
        const cancel = { cancelled: false }; rec.script = { cancel, name: sc.name };
        try {
            const env = this.envFactory(rec.bot, cancel); if (env && env.configure) env.configure({ retireWorn: !!this.settings.retireWorn });
            const j = rec.job && this.jobs.get(rec.job);
            const senv = Object.assign(Object.create(env), { sites: this.sites, policy: j && j.policy, box: j && j.spec && j.spec.box, need: rec.waitFor && rec.waitFor.tool });
            senv.leavePit = (box) => require('../bot/exit').leavePit(senv, box);
            return await scriptLib.runScript(sc, senv, { cancel });
        } finally { rec.script = null; }
    }
}

module.exports = { LibraryPart };

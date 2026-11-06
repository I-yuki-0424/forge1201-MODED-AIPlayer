'use strict';
// Sites (tagged blocks by coordinates) and scripts.
// A part of WorkService (index.js copies these methods onto it).
const fs = require('fs');
const path = require('path');
const scriptLib = require('../bot/script');
const { Problem, need } = require('./common');

class LibraryPart {
    listSites() { return { tags: require('../bot/sites').TAGS, sites: this.sites.list() }; }
    addSite(s) { let site; try { site = this.sites.add(s); } catch (e) { throw new Problem(e.message); } this._dirty(); return site; }
    removeSite(name) { need(this.sites.remove(String(name)), `no site ${String(name).slice(0, 24)}`, 404); this._dirty(); return { ok: true }; }

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
    /** Run a stored script once on a bot (the operator's "do this now"): { ended, ok, steps, log }. */
    async runScript(botName, scriptName) {
        const rec = this.bots.get(botName); need(rec && !rec.removed && rec.state === 'online' && rec.bot, `no online bot ${botName}`, 404);
        const sc = this.scripts.get(scriptName); need(sc, `no script ${String(scriptName).slice(0, 32)}`, 404);
        need(!rec.worker && !rec.script, `bot ${botName} is busy`, 409);
        const cancel = { cancelled: false }; rec.script = { cancel, name: sc.name };
        try {
            const env = this.envFactory(rec.bot, cancel); if (env && env.configure) env.configure({ retireWorn: !!this.settings.retireWorn });
            const j = rec.job && this.jobs.get(rec.job);
            const senv = Object.assign(Object.create(env), { sites: this.sites, policy: j && j.policy, box: j && j.spec && j.spec.box });
            senv.leavePit = (box) => require('../bot/exit').leavePit(senv, box);
            return await scriptLib.runScript(sc, senv, { cancel });
        } finally { rec.script = null; }
    }
}

module.exports = { LibraryPart };

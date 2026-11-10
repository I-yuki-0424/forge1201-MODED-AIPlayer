'use strict';
// The map from the world folder, and the settings switches.
// A part of WorkService (index.js copies these methods onto it).
const { Problem, need } = require('./common');

class WorldPart {
    mapIndex(dim = 'overworld') { need(this.maps.available, 'no world folder is mounted (WORK_WORLD)', 503); try { return { dim, regions: this.maps.index(dim) }; } catch (e) { throw new Problem(e.message, e.status || 400); } }
    async mapRegion(dim, rx, rz, top = null) { need(this.maps.available, 'no world folder is mounted (WORK_WORLD)', 503); try { return await this.maps.region(dim, rx, rz, top); } catch (e) { throw new Problem(e.message, e.status || 500); } }
    /** Ask the server to write its chunks to disk, then forget the cached regions: the map follows what the server has saved. */
    async mapRefresh() { need(this.o.rcon, 'refreshing the map needs RCON (save-all)', 503); await this.rcon('save-all flush'); this.maps.invalidate(); return { ok: true }; }

    /** The map follows the files the server saves; with `mapSave` the service asks it to save (save-all, not flush: no wait for the disk) so that it follows the bots more closely. */
    _mapSaveTimer() {
        clearInterval(this._mapSave); this._mapSave = null;
        const every = this.settings.mapSave | 0;
        if (!every || !this.o.rcon) return;
        this._mapSave = setInterval(() => { this.rcon('save-all').then(() => this.maps.invalidate()).catch(() => {}); }, every * 1000);
        this._mapSave.unref?.();
    }

    setSettings(s) {
        if (s && s.display && typeof s.display === 'object') for (const k of ['on', 'paths', 'lanes', 'tags']) if (typeof s.display[k] === 'boolean') this.settings.display = { ...this.settings.display, [k]: s.display[k] };
        if (s && s.experts !== undefined) { need(typeof s.experts === 'boolean', 'experts: true or false (the trained movement and stuck-escape experts)'); this.settings.experts = s.experts; }
        if (s && s.pitExpert !== undefined) { need(typeof s.pitExpert === 'boolean', 'pitExpert: true or false (new pits use the learned station planner; false = the tile sweep)'); this.settings.pitExpert = s.pitExpert; }
        if (s && s.move3 !== undefined) { need(typeof s.move3 === 'boolean', 'move3: true or false (the learned cell-level walk goes first within 48 blocks; false = the chunk router and the old chain)'); this.settings.move3 = s.move3; }
        if (s && s.router !== undefined) { need(typeof s.router === 'boolean', 'router: true or false (the chunk-exit router walks first; false = the old legs)'); this.settings.router = s.router; }
        // teleport: off = the server never moves a bot (no tp of any kind: not a recovery, not a lift, not a jump into a dimension, not the operator's command); near / any limit only the recovery moves.
        if (s && s.teleport !== undefined) { need(['off', 'near', 'any'].includes(s.teleport), 'teleport: off, near or any'); this.settings.teleport = s.teleport; }
        if (s && s.reachChunks !== undefined) { need(Number.isInteger(s.reachChunks) && s.reachChunks >= 1 && s.reachChunks <= 200, 'reachChunks: 1..200 chunks (how far a bot looks for a chest)'); this.settings.reachChunks = s.reachChunks; this.sites.setReach(s.reachChunks); }
        if (s && s.toolPolicy && typeof s.toolPolicy === 'object') {
            const tp = { ...this.settings.toolPolicy };
            for (const [t, v] of Object.entries(s.toolPolicy)) { need(require('../../skills/options').TIERS.includes(t), `toolPolicy: unknown tier ${String(t).slice(0, 12)}`); need(v === 'use_up' || v === 'keep', 'toolPolicy: use_up or keep'); tp[t] = v; }
            this.settings.toolPolicy = tp;
            for (const r of this.bots.values()) if (r.bot && !r.removed) { try { require('../../skills/options').configure(r.bot, { toolPolicy: tp }); } catch (_) { /* not connected */ } }
        }
        if (s && s.mapSave !== undefined) { need([0, 30, 60, 120, 300].includes(s.mapSave), 'mapSave: 0 (off), 30, 60, 120 or 300 seconds'); this.settings.mapSave = s.mapSave; this._mapSaveTimer(); }
        if (s && s.chestSlots !== undefined) { need(Number.isInteger(s.chestSlots) && s.chestSlots >= 1 && s.chestSlots <= 6, 'chestSlots: 1..6 bots at a chest at the same time'); this.settings.chestSlots = s.chestSlots; }
        if (s && typeof s.autoKit === 'boolean') this.settings.autoKit = s.autoKit;
        if (s && typeof s.reflex === 'boolean') this.settings.reflex = s.reflex;
        if (s && typeof s.scripts === 'boolean') this.settings.scripts = s.scripts;
        if (s && typeof s.resumeJobs === 'boolean') this.settings.resumeJobs = s.resumeJobs;      // read when the console starts: running jobs come back running
        if (s && typeof s.glow === 'boolean') { this.settings.glow = s.glow; if (!s.glow) for (const r of this.bots.values()) this._clearGlow(r); }
        if (s && typeof s.discardWorn === 'boolean') this.settings.discardWorn = s.discardWorn;
        if (s && typeof s.bedrockExploit === 'boolean') this.settings.bedrockExploit = s.bedrockExploit;      // bot/bedrock.js: off unless the operator turns it on
        if (s && typeof s.autoRepair === 'boolean') this.settings.autoRepair = s.autoRepair;      // stuck units of a finished job are tried again by themselves (workers.js _watchRepair)
        if (s && typeof s.endDump === 'boolean') this.settings.endDump = s.endDump;      // the dump at the end of a finished pit or build (workers.js _endDump)
        if (s && s.endDumpEnder !== undefined) { let f; try { f = require('../world/enderstorage').frequency(s.endDumpEnder); } catch (e) { need(false, e.message); } need(!f.owner, 'endDumpEnder: a public chest (three colours), no owner'); this.settings.endDumpEnder = f; }
        if (s && typeof s.defend === 'boolean') this.settings.defend = s.defend;      // workers read it at start; bots that work now are told at once below
        if (s && typeof s.directPickup === 'boolean') { this.settings.directPickup = s.directPickup; for (const r of this.bots.values()) if (r.state === 'online' && !r.removed) this._tagDirect(r, s.directPickup); }
        if (s && typeof s.retireWorn === 'boolean') {
            this.settings.retireWorn = s.retireWorn;                       // the switch applies at once, also to bots that are working
            for (const r of this.bots.values()) if (r.bot && !r.removed) { try { require('../../skills/options').configure(r.bot, { retireWorn: s.retireWorn }); } catch (_) { /* not connected */ } }
        }
        this._dirty();
        return this.settings;
    }
}

module.exports = { WorldPart };

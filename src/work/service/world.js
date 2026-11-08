'use strict';
// The map from the world folder, and the settings switches.
// A part of WorkService (index.js copies these methods onto it).
const { Problem, need } = require('./common');

class WorldPart {
    mapIndex(dim = 'overworld') { need(this.maps.available, 'no world folder is mounted (WORK_WORLD)', 503); try { return { dim, regions: this.maps.index(dim) }; } catch (e) { throw new Problem(e.message, e.status || 400); } }
    async mapRegion(dim, rx, rz) { need(this.maps.available, 'no world folder is mounted (WORK_WORLD)', 503); try { return await this.maps.region(dim, rx, rz); } catch (e) { throw new Problem(e.message, e.status || 500); } }
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
        if (s && s.mapSave !== undefined) { need([0, 30, 60, 120, 300].includes(s.mapSave), 'mapSave: 0 (off), 30, 60, 120 or 300 seconds'); this.settings.mapSave = s.mapSave; this._mapSaveTimer(); }
        if (s && typeof s.autoKit === 'boolean') this.settings.autoKit = s.autoKit;
        if (s && typeof s.scripts === 'boolean') this.settings.scripts = s.scripts;
        if (s && typeof s.glow === 'boolean') { this.settings.glow = s.glow; if (!s.glow) for (const r of this.bots.values()) this._clearGlow(r); }
        if (s && typeof s.discardWorn === 'boolean') this.settings.discardWorn = s.discardWorn;
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

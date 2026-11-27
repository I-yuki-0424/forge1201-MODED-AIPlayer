'use strict';
// Routes: the stuck snapshots (src/debug/stuck.js, TASK-20261127-084), read-only, from the stuck folder only (WORK_STUCK_DIR). Same session as every route. Every path part is
// matched by a closed pattern before it touches the disk, and the file found must resolve (symlinks followed) inside the folder: no traversal, no other files.
//   GET /api/stuck/runs                          the runs, newest first, with their counts per cause
//   GET /api/stuck/run/<run>                     a run's index (events grouped by cause)
//   GET /api/stuck/event/<run>/<id>              one event's facts (event.json)
//   GET /api/stuck/img/<run>/<id>/<view>.png     one of its pictures (top | along | across, or progress)
//   (/api/stuck/runs also returns status.json: the folder's bytes and its budget)
const fs = require('fs');
const path = require('path');
const { Raw } = require('../http');
const { Problem } = require('../../service');

const RUN = '([A-Za-z0-9][A-Za-z0-9_-]{0,63})', ID = '(\\d{3,6}-[a-z_]{1,20}-[A-Za-z0-9_]{1,16})';
const P_RUN = new RegExp(`^/api/stuck/run/${RUN}$`), P_EVENT = new RegExp(`^/api/stuck/event/${RUN}/${ID}$`), P_IMG = new RegExp(`^/api/stuck/img/${RUN}/${ID}/(top|along|across|progress)\\.png$`);
const MAX = 8 * 1024 * 1024;

module.exports = (service, { stuckDir = null } = {}) => {
    /** The file `parts` under the stuck folder, if it is a regular file inside it (after symlinks); else null. */
    function inside(...parts) {
        if (!stuckDir) return null;
        try {
            const root = fs.realpathSync(stuckDir), real = fs.realpathSync(path.join(root, ...parts));
            if (!real.startsWith(root + path.sep)) return null;
            const st = fs.statSync(real); return st.isFile() && st.size <= MAX ? real : null;
        } catch (_) { return null; }
    }
    const readJson = (...parts) => { const f = inside(...parts); if (!f) throw new Problem('not found', 404); try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { throw new Problem('unreadable', 500); } };
    return async (req, url, m, p) => {
        if (m !== 'GET' || !p.startsWith('/api/stuck/')) return undefined;
        if (p === '/api/stuck/runs') {
            if (!stuckDir || !fs.existsSync(stuckDir)) return { available: false, runs: [] };
            const runs = [];
            for (const d of fs.readdirSync(stuckDir, { withFileTypes: true })) {
                if (!d.isDirectory() || !new RegExp(`^${RUN}$`).test(d.name)) continue;
                const f = inside(d.name, 'index.json'); if (!f) continue;
                try { const ix = JSON.parse(fs.readFileSync(f, 'utf8')); const by = {}; for (const [k, v] of Object.entries(ix.byKind || {})) by[k] = Array.isArray(v) ? v.length : 0; runs.push({ run: d.name, updated: ix.updated || null, events: (ix.events || []).length, byKind: by, mtime: fs.statSync(f).mtimeMs }); } catch (_) { /* skipped */ }
            }
            runs.sort((a, b) => b.mtime - a.mtime);
            let status = null; const sf = inside('status.json'); if (sf) { try { status = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (_) { status = null; } }
            return { available: true, runs: runs.slice(0, 200), status };
        }
        let x = P_RUN.exec(p); if (x) return readJson(x[1], 'index.json');
        x = P_EVENT.exec(p); if (x) return readJson(x[1], x[2], 'event.json');
        x = P_IMG.exec(p);
        if (x) { const f = inside(x[1], x[2], `${x[3]}.png`); if (!f) throw new Problem('not found', 404); return new Raw(fs.readFileSync(f), 'image/png', { 'Cache-Control': 'private, max-age=3600' }); }
        throw new Problem('not found', 404);           // every other path under /api/stuck/ (a traversal attempt among them)
    };
};

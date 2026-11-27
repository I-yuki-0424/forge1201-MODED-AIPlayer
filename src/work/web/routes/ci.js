'use strict';
// Routes: the CI history (scripts/ci/history.js, TASK-20261125-080), read-only, from the CI folder only (WORK_CI_DIR). Same session as every route. The run id is matched by a closed
// pattern before it touches the disk, and the file found must resolve (symlinks followed) inside the folder: no traversal, no other files.
//   GET /api/ci/runs          the runs, newest first (the lines of history.jsonl: per test verdict, trials, seconds; what got worse and what got better)
//   GET /api/ci/run/<id>      one run's record (runs/<id>.json: every test with its seed, speed, failures and its change against the baseline)
const fs = require('fs');
const path = require('path');
const { Problem } = require('../../service');

const ID = /^\d{4}-\d{4}-[0-9a-f]{8}(-[a-z0-9-]{1,24})?$/, P_RUN = /^\/api\/ci\/run\/([^/]{1,64})$/;
const MAX = 4 * 1024 * 1024, KEEP = 300;

module.exports = (service, { ciDir = null } = {}) => {
    /** The file `parts` under the CI folder, if it is a regular file inside it (after symlinks); else null. */
    function inside(...parts) {
        if (!ciDir) return null;
        try {
            const root = fs.realpathSync(ciDir), real = fs.realpathSync(path.join(root, ...parts));
            if (!real.startsWith(root + path.sep)) return null;
            const st = fs.statSync(real); return st.isFile() && st.size <= MAX ? real : null;
        } catch (_) { return null; }
    }
    return async (req, url, m, p) => {
        if (m !== 'GET' || !p.startsWith('/api/ci/')) return undefined;
        if (p === '/api/ci/runs') {
            const f = inside('history.jsonl');
            if (!f) return { available: !!ciDir && fs.existsSync(ciDir), runs: [] };
            const runs = [];
            for (const l of fs.readFileSync(f, 'utf8').split('\n').slice(-KEEP)) { if (!l) continue; try { const r = JSON.parse(l); if (r && ID.test(r.id)) runs.push(r); } catch (_) { /* a torn line */ } }
            return { available: true, runs: runs.reverse() };
        }
        const x = P_RUN.exec(p);
        if (x && ID.test(x[1])) {
            const f = inside('runs', `${x[1]}.json`); if (!f) throw new Problem('not found', 404);
            try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { throw new Problem('unreadable', 500); }
        }
        throw new Problem('not found', 404);           // every other path under /api/ci/ (a traversal attempt among them)
    };
};

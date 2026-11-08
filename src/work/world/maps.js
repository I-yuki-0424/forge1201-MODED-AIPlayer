'use strict';
// Map data for the console: lists a world's region files and serves decoded regions (mca.js in a worker thread), cached by file
// modification time. Read-only on the world folder (mounted read-only into the console container).
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const DIMS = { overworld: 'region', nether: 'DIM-1/region', end: 'DIM1/region' };
const FILE = /^r\.(-?\d{1,7})\.(-?\d{1,7})\.mca$/;

class MapStore {
    constructor(worldDir, { cacheSize = 48 } = {}) {
        this.dir = worldDir; this.cacheSize = cacheSize;
        this.cache = new Map(); this.good = new Map();       // good: the most complete decode of each region so far          // key -> { mtime, size, data }
        this.worker = null; this.pending = new Map(); this.seq = 0; this.queue = Promise.resolve();
    }
    get available() { return !!this.dir && fs.existsSync(path.join(this.dir, DIMS.overworld)); }
    _dir(dim) { if (!(dim in DIMS)) throw Object.assign(new Error('dimension is overworld, nether or end'), { status: 400 }); return path.join(this.dir, DIMS[dim]); }

    /** Region files that hold data: [{rx, rz, bytes, mtime}]. */
    index(dim) {
        const d = this._dir(dim);
        if (!fs.existsSync(d)) return [];
        const out = [];
        for (const f of fs.readdirSync(d)) {
            const m = FILE.exec(f); if (!m) continue;
            const st = fs.statSync(path.join(d, f));
            if (st.size > 8192) out.push({ rx: Number(m[1]), rz: Number(m[2]), bytes: st.size, mtime: Math.floor(st.mtimeMs) });
        }
        return out.sort((a, b) => a.rz - b.rz || a.rx - b.rx);
    }

    _worker() {
        if (this.worker) return this.worker;
        const w = this.worker = new Worker(path.join(__dirname, 'mapworker.js'));
        w.on('message', (m) => { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); } });
        w.on('error', (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); this.worker = null; });
        w.on('exit', () => { this.worker = null; });
        w.unref();
        return w;
    }

    /** One decoded region: { rx, rz, mtime, names, idx (Buffer), h (Buffer), chunks }. Concurrent calls are run one after another. */
    async region(dim, rx, rz) {
        if (!Number.isInteger(rx) || !Number.isInteger(rz) || Math.abs(rx) > 1e6 || Math.abs(rz) > 1e6) throw Object.assign(new Error('bad region'), { status: 400 });
        const file = path.join(this._dir(dim), `r.${rx}.${rz}.mca`);
        let st; try { st = fs.statSync(file); } catch (_) { return { rx, rz, mtime: 0, names: [], idx: null, h: null, chunks: 0 }; }
        const key = `${dim}/${rx}/${rz}`, hit = this.cache.get(key);
        if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) { this.cache.delete(key); this.cache.set(key, hit); return hit.data; }
        const run = this.queue.then(async () => {
            const id = ++this.seq;
            const r = await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this._worker().postMessage({ id, file }); });
            let data = { rx, rz, mtime: Math.floor(st.mtimeMs), names: r.names, idx: Buffer.from(r.idx.buffer), h: Buffer.from(r.h.buffer), chunks: r.chunks };
            // A read that catches the server in the middle of saving the file loses chunks (a half-written sector does not inflate): they show as black squares. A world
            // never loses chunks, so a decode with fewer than the last good one is read once more, and if it is still short and the file was written a moment ago the
            // last complete picture is kept (with the new mtime, so that it is looked at again after the next change).
            const prev = this.good.get(key);
            if (prev && data.chunks < prev.chunks) {
                const again = await new Promise((resolve, reject) => { const id2 = ++this.seq; this.pending.set(id2, { resolve, reject }); setTimeout(() => this._worker().postMessage({ id: id2, file }), 400); });
                if (again.chunks >= data.chunks) data = { ...data, names: again.names, idx: Buffer.from(again.idx.buffer), h: Buffer.from(again.h.buffer), chunks: again.chunks };
                if (data.chunks < prev.chunks && Date.now() - st.mtimeMs < 10000) data = { ...prev, mtime: Math.floor(st.mtimeMs) };
            }
            if (!prev || data.chunks >= prev.chunks) { this.good.delete(key); this.good.set(key, data); while (this.good.size > this.cacheSize * 2) this.good.delete(this.good.keys().next().value); }
            this.cache.set(key, { mtime: st.mtimeMs, size: st.size, data });
            while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
            return data;
        });
        this.queue = run.catch(() => {});
        return run;
    }
    invalidate() { this.cache.clear(); }
    close() { if (this.worker) this.worker.terminate(); }
}

module.exports = { MapStore, DIMS };

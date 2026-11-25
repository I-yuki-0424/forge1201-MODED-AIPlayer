'use strict';
// The game's own pictures for the console's inventory (owner 2026-11-25, list 5 Small 3: "the inventory is all text; take textures from in-game data"): the Minecraft
// client jar of the server's version, from Mojang's version manifest (piston-meta), checked against its SHA-1, and only the block/item models and textures and the
// English names extracted into a cache folder (`WORK_ASSETS`, on /mnt/data; never in git). Fetched once, at deploy (`node src/work/web/assets/fetch.js <version> <dir>`)
// or on the first request. Served same-origin by routes/assets.js under the strict CSP.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zip = require('./zip');
const models = require('./models');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const HOSTS = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com']);
const VERSION = /^\d{1,2}\.\d{1,3}(\.\d{1,3})?$/;
const TAKE = /^assets\/minecraft\/(models\/(block|item)\/[a-z0-9_/]{1,80}\.json|textures\/(block|item)\/[a-z0-9_/]{1,80}\.png|lang\/en_us\.json)$/;
const MAX_JAR = 96 * 1024 * 1024;

/** GET a URL of one of Mojang's hosts (https only, no redirect elsewhere), at most `max` bytes. */
function get(url, max, redirects = 2) {
    return new Promise((resolve, reject) => {
        let u; try { u = new URL(url); } catch (_) { return reject(new Error('bad url')); }
        if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) return reject(new Error(`refused host ${u.hostname}`));
        const req = https.get(u, { headers: { 'User-Agent': 'work-console-assets' }, timeout: 30000 }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, u).href, max, redirects - 1)); }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${u.hostname}: HTTP ${res.statusCode}`)); }
            const parts = []; let n = 0;
            res.on('data', (c) => { n += c.length; if (n > max) { req.destroy(new Error('download too large')); return; } parts.push(c); });
            res.on('end', () => resolve(Buffer.concat(parts)));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('download timed out')));
        req.on('error', reject);
    });
}

/** Write the wanted entries of client jar `jar` (a Buffer) into `dir`. Returns how many files were written. */
function extract(jar, dir) {
    let n = 0;
    for (const e of zip.entries(jar)) {
        if (!TAKE.test(e.name)) continue;
        const rel = e.name.slice('assets/minecraft/'.length), out = path.join(dir, rel);
        if (!out.startsWith(dir + path.sep)) continue;                     // the pattern already rules out '..'; belt and braces
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, zip.read(jar, e));
        n++;
    }
    return n;
}

/** Download the client jar of `version` (checked against the SHA-1 Mojang lists) and extract it into `<root>/<version>`. */
async function fetchVersion(version, root) {
    if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
    const dir = path.join(root, version);
    if (fs.existsSync(path.join(dir, 'ready'))) return dir;
    const manifest = JSON.parse((await get(MANIFEST, 4 * 1024 * 1024)).toString('utf8'));
    const v = (manifest.versions || []).find((x) => x.id === version); if (!v) throw new Error(`Mojang lists no version ${version}`);
    const meta = JSON.parse((await get(v.url, 4 * 1024 * 1024)).toString('utf8')), client = meta.downloads && meta.downloads.client;
    if (!client || !client.url || !/^[0-9a-f]{40}$/.test(client.sha1 || '')) throw new Error(`no client download for ${version}`);
    const jar = await get(client.url, MAX_JAR);
    const sha = crypto.createHash('sha1').update(jar).digest('hex');
    if (sha !== client.sha1) throw new Error(`client jar of ${version}: SHA-1 ${sha} is not the listed ${client.sha1}`);
    const tmp = `${dir}.part${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    const n = extract(jar, tmp);
    if (n < 100) throw new Error(`client jar of ${version}: only ${n} asset files`);
    fs.writeFileSync(path.join(tmp, 'ready'), JSON.stringify({ version, sha1: sha, files: n, at: new Date().toISOString() }));
    fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
    return dir;
}

class AssetStore {
    /** @param o.root  the cache folder; @param o.version  () -> the server's version ('1.21.1') or null while it is unknown; @param o.fetch  (version, root) -> dir (tests) */
    constructor(o) { this.o = o; this.dirs = new Map(); this.pending = new Map(); this.errors = new Map(); this.specs = new Map(); this.langs = new Map(); }

    version() { const v = this.o.version && this.o.version(); return typeof v === 'string' && VERSION.test(v) ? v : null; }

    /** The cache folder of the current version, or null while it is being fetched (the fetch starts on the first call). */
    dir() {
        const v = this.version(); if (!v) return null;
        if (this.dirs.has(v)) return this.dirs.get(v);
        const d = path.join(this.o.root, v);
        if (fs.existsSync(path.join(d, 'ready'))) { this.dirs.set(v, d); return d; }
        if (!this.pending.has(v) && !(this.errors.has(v) && Date.now() - this.errors.get(v).at < 600000)) {
            const p = (this.o.fetch || fetchVersion)(v, this.o.root).then((dd) => { this.dirs.set(v, dd); this.errors.delete(v); }, (e) => { this.errors.set(v, { message: e.message, at: Date.now() }); }).finally(() => this.pending.delete(v));
            this.pending.set(v, p);
        }
        return null;
    }

    status() {
        const v = this.version(), d = this.dir();
        return { version: v, ready: !!d, fetching: !!(v && this.pending.has(v)), error: v && this.errors.has(v) ? this.errors.get(v).message : null };
    }

    _readModel(d, name) {
        const f = path.join(d, 'models', `${name}.json`);
        if (!/^(block|item)\/[a-z0-9_/]{1,80}$/.test(name) || !f.startsWith(path.join(d, 'models') + path.sep)) return null;
        try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
    }
    _lang(d) { if (!this.langs.has(d)) { let l = {}; try { l = JSON.parse(fs.readFileSync(path.join(d, 'lang', 'en_us.json'), 'utf8')); } catch (_) { /* no names */ } this.langs.set(d, l); } return this.langs.get(d); }

    /** Specs and names of item ids: { ready, icons: { id: { name, ...spec } } } (ready false while the version is being fetched). */
    icons(ids) {
        const d = this.dir(); if (!d) return { ready: false, icons: {} };
        const out = {};
        for (const id of ids) {
            const k = `${d}|${id}`;
            if (!this.specs.has(k)) { const s = models.itemSpec(id, (n) => this._readModel(d, n)); this.specs.set(k, { name: models.nameOf(id, this._lang(d)), ...s }); }
            out[id] = this.specs.get(k);
        }
        return { ready: true, icons: out };
    }

    /** The bytes of texture `rel` (block/stone), or null. */
    texture(rel) {
        const d = this.dir(); if (!d || !models.texPath(rel)) return null;
        const f = path.join(d, 'textures', `${rel}.png`);
        if (!f.startsWith(path.join(d, 'textures') + path.sep)) return null;
        try { return fs.readFileSync(f); } catch (_) { return null; }
    }
}

module.exports = { AssetStore, fetchVersion, extract, get, VERSION, TAKE, HOSTS };

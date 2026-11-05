'use strict';
// The work console: an HTTP API plus a static page (public/work/) in front of WorkService (service.js).
// The operator can add and remove bots, designate pits, manage and edit structure files and build them. It can also reach RCON
// (give items, read positions), so it is treated as an administrative interface, not as a status page:
//   - a random access token (file, mode 0600, never logged or put in a URL) is exchanged for an HttpOnly SameSite=Strict session
//   - every request needs the session; every non-GET also the CSRF header of that session and a same-host Origin (if sent)
//   - the Host header must be localhost, an IP literal, a *.ts.net name or listed in WORK_ALLOWED_HOSTS (DNS rebinding)
//   - JSON only (no form posts), bounded bodies, closed routes, closed validation in the service, strict CSP, no CORS
//   - binds to 127.0.0.1 unless WORK_BIND says otherwise; the owner's route to it is the tailnet (docs/LESSONS.md L3)
//   - failed logins are throttled per address
// Run: node src/work/console.js   (env: docs/implemented/WORK-CONSOLE-v1.md)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WorkService, Problem, BOT_NAME } = require('./service');

const PUBLIC = path.join(__dirname, '..', '..', 'public', 'work');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/work.js': ['work.js', 'text/javascript; charset=utf-8'], '/work.css': ['work.css', 'text/css; charset=utf-8'] };
const MAX_JSON = 256 * 1024, MAX_UPLOAD = 8 * 1024 * 1024;
const SESSION_MS = 12 * 3600 * 1000;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Read the token file, creating it (random, mode 0600) if it does not exist. */
function loadToken(file) {
    try { const t = fs.readFileSync(file, 'utf8').trim(); if (t.length >= 24) return t; } catch (_) { /* create */ }
    const t = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t + '\n', { mode: 0o600 });
    return t;
}

function hostAllowed(host, extra) {
    if (!host) return false;
    const h = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[0-9a-f:]+$/.test(h) && h.includes(':') || h.endsWith('.ts.net') || extra.includes(h);
}

function createConsole({ service, token, allowedHosts = [], now = Date.now }) {
    const sessions = new Map(), fails = new Map();
    const reap = () => { for (const [k, s] of sessions) if (s.until < now()) sessions.delete(k); };

    const send = (res, status, body, type = 'application/json', extra = {}) => {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cross-Origin-Resource-Policy': 'same-origin', ...extra });
        res.end(buf);
    };
    const fail = (res, status, msg) => send(res, status, { error: msg });

    function readBody(req, limit) {
        return new Promise((resolve, reject) => {
            const chunks = []; let n = 0;
            req.on('data', (c) => { n += c.length; if (n > limit) { chunks.length = 0; if (n - c.length <= limit) reject(new Problem('body too large', 413)); } else chunks.push(c); });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
    }
    async function json(req) {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const buf = await readBody(req, MAX_JSON);
        if (!buf.length) return {};
        if (type !== 'application/json') throw new Problem('content-type must be application/json', 415);
        try { const v = JSON.parse(buf.toString('utf8')); if (v === null || typeof v !== 'object') throw new Error('x'); return v; } catch (_) { throw new Problem('invalid JSON'); }
    }

    function cookieOf(req) { const m = /(?:^|;\s*)wc_session=([0-9a-f]{64})/.exec(req.headers.cookie || ''); return m ? m[1] : null; }

    async function route(req, res, url) {
        const { pathname: p } = url, m = req.method;
        const ip = req.socket.remoteAddress || '?';

        if (m === 'GET' && STATIC[p]) {                                                      // the page itself holds nothing secret
            const [file, type] = STATIC[p];
            return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
        }
        if (!p.startsWith('/api/')) return fail(res, 404, 'not found');

        // Origin: a browser sends it on cross-site and same-site POSTs; if it is there it must be this host.
        if (m !== 'GET' && m !== 'HEAD') {
            const o = req.headers.origin;
            if (o) { let oh = null; try { oh = new URL(o).host; } catch (_) { /* bad */ } if (oh !== req.headers.host) return fail(res, 403, 'cross-origin request refused'); }
        }

        if (p === '/api/login' && m === 'POST') {
            const f = fails.get(ip) || { n: 0, until: 0 };
            if (f.n >= 8 && f.until > now()) return fail(res, 429, 'too many attempts, wait ten minutes');
            const body = await json(req);
            if (typeof body.token !== 'string' || !safeEq(body.token, token)) {
                fails.set(ip, { n: (f.until > now() ? f.n : 0) + 1, until: now() + 600000 });
                service.note('warn', `console: failed login from ${ip}`);
                return fail(res, 401, 'wrong token');
            }
            fails.delete(ip); reap();
            const sid = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(16).toString('hex');
            sessions.set(sid, { csrf, until: now() + SESSION_MS });
            service.note('info', `console: login from ${ip}`);
            return send(res, 200, { ok: true, csrf }, 'application/json', { 'Set-Cookie': `wc_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
        }

        const sid = cookieOf(req), sess = sid && sessions.get(sid);
        if (!sess || sess.until < now()) return fail(res, 401, 'login required');
        if (p === '/api/session') return send(res, 200, { ok: true, csrf: sess.csrf });
        if (p === '/api/logout' && m === 'POST') { sessions.delete(sid); return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'wc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
        if (m !== 'GET' && m !== 'HEAD' && !safeEq(req.headers['x-csrf'] || '', sess.csrf)) return fail(res, 403, 'csrf header missing');

        let a;
        // ---- state
        if (m === 'GET' && p === '/api/state') return send(res, 200, service.status());
        if (m === 'GET' && p === '/api/players') return send(res, 200, await service.players());
        if (m === 'GET' && p === '/api/surface') return send(res, 200, service.surface(Number(url.searchParams.get('x')), Number(url.searchParams.get('z'))));
        if (m === 'POST' && p === '/api/settings') return send(res, 200, service.setSettings(await json(req)));
        // ---- bots
        if (m === 'POST' && p === '/api/bots') {
            const b = await json(req), added = [];
            if (b.name !== undefined) added.push(service.addBot(String(b.name)));
            else {
                const count = Number(b.count), prefix = String(b.prefix || 'Work');
                if (!Number.isInteger(count) || count < 1 || count > 24) throw new Problem('count is 1..24');
                let n = 1; const taken = (x) => service.bots.has(x);
                while (added.length < count && n < 1000) { const name = `${prefix}${n++}`; if (!BOT_NAME.test(name)) throw new Problem('prefix: letters, digits, _ (max 13)'); if (!taken(name)) added.push(service.addBot(name)); }
            }
            return send(res, 200, { added });
        }
        if ((a = /^\/api\/bots\/([A-Za-z0-9_]{3,16})(?:\/(kit|resume))?$/.exec(p))) {
            if (m === 'DELETE' && !a[2]) { service.removeBot(a[1]); return send(res, 200, { ok: true }); }
            if (m === 'POST' && a[2] === 'kit') return send(res, 200, await service.kitBot(a[1]));
            if (m === 'POST' && a[2] === 'resume') return send(res, 200, service.resumeBot(a[1]));
        }
        // ---- jobs
        if (m === 'POST' && p === '/api/jobs/pit') return send(res, 200, service.createPit(await json(req)));
        if (m === 'POST' && p === '/api/jobs/build') return send(res, 200, await service.createBuild(await json(req)));
        if ((a = /^\/api\/jobs\/(j\d{1,9})(?:\/(start|pause|cancel|repair|supply|assign|unassign))?$/.exec(p))) {
            const id = a[1], act = a[2];
            if (m === 'GET' && !act) return send(res, 200, service.jobDetail(id));
            if (m === 'DELETE' && !act) { service.deleteJob(id); return send(res, 200, { ok: true }); }
            if (m === 'POST') {
                if (act === 'start') return send(res, 200, service.startJob(id));
                if (act === 'pause') return send(res, 200, service.pauseJob(id));
                if (act === 'cancel') return send(res, 200, service.cancelJob(id));
                if (act === 'repair') return send(res, 200, service.repairJob(id));
                const b = await json(req);
                if (act === 'supply') return send(res, 200, await service.supply(id, b.bot ? String(b.bot) : null));
                if (act === 'assign') { if (!Array.isArray(b.bots)) throw new Problem('bots must be a list'); return send(res, 200, service.assign(id, b.bots.map(String))); }
                if (act === 'unassign') return send(res, 200, service.unassign(id, String(b.bot)));
            }
        }
        // ---- structures
        if (m === 'GET' && p === '/api/structures') return send(res, 200, await service.listStructures());
        if (m === 'POST' && p === '/api/structures/generate') { const b = await json(req); return send(res, 200, await service.generate(String(b.kind), b.params || {}, String(b.as))); }
        if ((a = /^\/api\/structures\/([a-z0-9][a-z0-9_-]{0,47})(?:\/(download|edit|layer\/(\d{1,3})))?$/.exec(p))) {
            const name = a[1], sub = a[2];
            if (m === 'GET' && !sub) return send(res, 200, await service.structureDetail(name));
            if (m === 'GET' && sub === 'download') return send(res, 200, service.structureFile(name), 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${name}.nbt"` });
            if (m === 'GET' && a[3] !== undefined) return send(res, 200, await service.structureLayer(name, Number(a[3])));
            if (m === 'POST' && sub === 'edit') { const b = await json(req); return send(res, 200, await service.editStructure(name, b.ops, b.as ? String(b.as) : null, { overwrite: b.overwrite === true })); }
            if (m === 'POST' && !sub) {                                                       // upload: the raw .nbt as the body
                const buf = await readBody(req, MAX_UPLOAD);
                return send(res, 200, await service.putStructure(name, buf, { overwrite: url.searchParams.get('overwrite') === '1' }));
            }
            if (m === 'DELETE' && !sub) { service.deleteStructure(name); return send(res, 200, { ok: true }); }
        }
        return fail(res, 404, 'not found');
    }

    const server = http.createServer((req, res) => {
        if (!hostAllowed(req.headers.host, allowedHosts)) return fail(res, 421, 'host not allowed');
        let url; try { url = new URL(req.url, 'http://x'); } catch (_) { return fail(res, 400, 'bad url'); }
        route(req, res, url).catch((e) => {
            if (res.headersSent) return;
            if (e instanceof Problem) return fail(res, e.status, e.message);       // an oversized body is drained, not buffered (destroying the socket would eat the reply)
            console.error('[console] internal error:', e && e.stack || e);
            fail(res, 500, 'internal error');
        });
    });
    server.requestTimeout = 60000; server.headersTimeout = 15000; server.maxHeadersCount = 40;
    return { server, sessions };
}

/** Table of the bots' registry -> (name) -> bool, from BOT_MOD_TABLE (the same file the handshake uses). */
function knownFromTable(file) {
    try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8')), set = new Set(t.blocks.map((b) => b.name));
        return (n) => set.has(n.includes(':') ? n : `minecraft:${n}`);
    } catch (_) { return null; }
}

async function main() {
    const env = process.env, dataDir = path.resolve(env.WORK_DATA || path.join(__dirname, '..', '..', 'data', 'work'));
    const table = env.BOT_MOD_TABLE || path.join(__dirname, '..', '..', 'modpack', 'forgeaip-create.registry.json');
    let kit; try { kit = env.WORK_KIT ? JSON.parse(env.WORK_KIT) : undefined; } catch (_) { console.error('WORK_KIT is not JSON; default kit used'); }
    const service = new WorkService({
        dataDir, host: env.MC_HOST || 'localhost', port: Number(env.MC_PORT) || 25565, known: knownFromTable(table), kit,
        maxBots: Number(env.WORK_MAX_BOTS) || 24,
        rcon: env.RCON_PASSWORD ? { host: env.RCON_HOST || env.MC_HOST || 'localhost', port: Number(env.RCON_PORT) || 25575, password: env.RCON_PASSWORD } : null,
    });
    const tokenFile = env.WORK_TOKEN_FILE || path.join(dataDir, 'console.token');
    const token = loadToken(tokenFile);
    await service.restore();
    const { server } = createConsole({ service, token, allowedHosts: (env.WORK_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) });
    const bind = env.WORK_BIND || '127.0.0.1', port = Number(env.WORK_PORT) || 3020;
    server.listen(port, bind, () => console.log(`[console] http://${bind}:${port}  server ${service.o.host}:${service.o.port}  table ${service.known ? table : 'none (vanilla names only)'}  rcon ${service.o.rcon ? 'on' : 'off'}  token file ${tokenFile}`));
    const down = async () => { server.close(); await service.stop(); process.exit(0); };
    process.on('SIGTERM', down); process.on('SIGINT', down);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createConsole, loadToken, hostAllowed, knownFromTable };

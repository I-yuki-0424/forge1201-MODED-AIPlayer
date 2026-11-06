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
const zlib = require('zlib');
const { WorkService, Problem, BOT_NAME } = require('./service');
const { Access } = require('./web/access');

const PUBLIC = path.join(__dirname, '..', '..', 'public', 'work');
const STATIC = Object.fromEntries([['/', 'index.html', 'text/html; charset=utf-8'], ...['work.js', 'ui.js', 'map.js', 'cmd.js', 'inv.js', 'tools.js', 'blockcolor.js'].map((f) => [`/${f}`, f, 'text/javascript; charset=utf-8']), ['/work.css', 'work.css', 'text/css; charset=utf-8']].map(([u, f, t]) => [u, [f, t]]));
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

function createConsole({ service, token, allowedHosts = [], publicHost = null, access = null, now = Date.now }) {
    publicHost = publicHost ? String(publicHost).toLowerCase() : null;
    if (publicHost) allowedHosts = [...allowedHosts, publicHost];
    const sessions = new Map(), fails = new Map();
    const reap = () => { for (const [k, s] of sessions) if (s.until < now()) sessions.delete(k); };

    const send = (res, status, body, type = 'application/json', extra = {}) => {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const head = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cross-Origin-Resource-Policy': 'same-origin', ...extra };
        const gz = buf.length > 1024 && /gzip/.test((res.req && res.req.headers['accept-encoding']) || '') && /json|text|javascript/.test(type);
        if (!gz) { res.writeHead(status, { ...head, 'Content-Length': buf.length }); return res.end(buf); }
        zlib.gzip(buf, (e, z) => { if (e) { res.writeHead(500); return res.end(); } res.writeHead(status, { ...head, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': z.length }); res.end(z); });
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
        // Cloudflare Access: through the public hostname every request must carry a valid Access assertion (a tunnel mistake must not
        // expose the console); a valid one for the owner's e-mail also signs the owner in without the token.
        const jwtUser = access && req.headers['cf-access-jwt-assertion'] ? await access.verify(req.headers['cf-access-jwt-assertion']) : null;
        if (publicHost && String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '') === publicHost && !jwtUser) return fail(res, 403, 'Cloudflare Access required');

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

        if (p === '/api/notice' && m === 'GET') {                       // before the login: a line the operator left for the sign-in screen (ready, address); no secrets
            let text = ''; try { text = fs.readFileSync(path.join(service.o.dataDir, 'notice.txt'), 'utf8').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 400); } catch (_) { /* none */ }
            return send(res, 200, { text });
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

        let sid = cookieOf(req), sess = sid && sessions.get(sid);
        if ((!sess || sess.until < now()) && jwtUser && p === '/api/session') {              // signed in at Cloudflare: no second token
            sid = crypto.randomBytes(32).toString('hex'); sess = { csrf: crypto.randomBytes(16).toString('hex'), until: now() + SESSION_MS };
            sessions.set(sid, sess); service.note('info', `console: Access login ${jwtUser.email}`);
            return send(res, 200, { ok: true, csrf: sess.csrf, via: 'access' }, 'application/json', { 'Set-Cookie': `wc_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
        }
        if (!sess || sess.until < now()) return fail(res, 401, 'login required');
        if (p === '/api/session') return send(res, 200, { ok: true, csrf: sess.csrf });
        if (p === '/api/logout' && m === 'POST') { sessions.delete(sid); return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'wc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
        if (m !== 'GET' && m !== 'HEAD' && !safeEq(req.headers['x-csrf'] || '', sess.csrf)) return fail(res, 403, 'csrf header missing');

        let a;
        // ---- state
        if (m === 'GET' && p === '/api/state') return send(res, 200, service.status());
        if (m === 'GET' && p === '/api/log') return send(res, 200, service.log.slice(-Number(url.searchParams.get('n') || 200)));
        if (m === 'GET' && p === '/api/problems') return send(res, 200, service.problemsView(Number(url.searchParams.get('n') || 100)));
        if (m === 'GET' && p === '/api/players') return send(res, 200, await service.players());
        if (m === 'GET' && p === '/api/surface') return send(res, 200, service.surface(Number(url.searchParams.get('x')), Number(url.searchParams.get('z'))));
        if (m === 'POST' && p === '/api/settings') return send(res, 200, service.setSettings(await json(req)));
        // ---- sites (tagged chests by coordinates) and scripts
        if (m === 'GET' && p === '/api/sites') return send(res, 200, service.listSites());
        if (m === 'POST' && p === '/api/sites') return send(res, 200, service.addSite(await json(req)));
        if ((a = /^\/api\/sites\/([a-z0-9][a-z0-9_-]{0,23})$/.exec(p)) && m === 'DELETE') return send(res, 200, service.removeSite(a[1]));
        if (m === 'GET' && p === '/api/scripts') return send(res, 200, service.listScripts());
        if (m === 'POST' && p === '/api/scripts') return send(res, 200, service.putScript(await json(req)));
        if ((a = /^\/api\/scripts\/([a-z0-9][a-z0-9_-]{0,31})$/.exec(p)) && m === 'DELETE') return send(res, 200, service.deleteScript(a[1]));
        if ((a = /^\/api\/scripts\/([a-z0-9][a-z0-9_-]{0,31})\/run$/.exec(p)) && m === 'POST') { const b = await json(req); return send(res, 200, await service.runScript(String(b.bot), a[1])); }
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
        if ((a = /^\/api\/bots\/([A-Za-z0-9_]{3,16})(?:\/(kit|resume|leave))?$/.exec(p))) {
            if (m === 'DELETE' && !a[2]) { service.removeBot(a[1]); return send(res, 200, { ok: true }); }
            if (m === 'POST' && a[2] === 'kit') return send(res, 200, await service.kitBot(a[1]));
            if (m === 'POST' && a[2] === 'resume') return send(res, 200, service.resumeBot(a[1]));
            if (m === 'POST' && a[2] === 'leave') return send(res, 200, await service.leavePit(a[1]));
        }
        // ---- commands, bot detail, inventories, map
        if (m === 'GET' && p === '/api/commands/catalog') return send(res, 200, service.catalog());
        if (m === 'POST' && p === '/api/commands') { const b = await json(req); return send(res, 200, await service.runCommand({ bots: b.bots, command: String(b.command), args: b.args || {} })); }
        if (m === 'POST' && p === '/api/inventory') { const b = await json(req); return send(res, 200, await service.inventory(b.target)); }
        if (m === 'POST' && p === '/api/inventory/move') { const b = await json(req); return send(res, 200, await service.moveStack({ src: b.src, srcSlot: b.srcSlot, dst: b.dst, dstSlot: b.dstSlot ?? null })); }
        if (m === 'POST' && p === '/api/inventory/moveall') { const b = await json(req); return send(res, 200, await service.moveAllStacks({ src: b.src, dst: b.dst })); }
        if (m === 'GET' && p === '/api/map/regions') return send(res, 200, service.mapIndex(url.searchParams.get('dim') || 'overworld'));
        if (m === 'GET' && p === '/api/map/region') {
            const r = await service.mapRegion(url.searchParams.get('dim') || 'overworld', Number(url.searchParams.get('rx')), Number(url.searchParams.get('rz')));
            return send(res, 200, { rx: r.rx, rz: r.rz, mtime: r.mtime, chunks: r.chunks, names: r.names, idx: r.idx ? r.idx.toString('base64') : null, h: r.h ? r.h.toString('base64') : null });
        }
        if (m === 'POST' && p === '/api/map/refresh') return send(res, 200, await service.mapRefresh());
        if ((a = /^\/api\/bots\/([A-Za-z0-9_]{3,16})\/(entities|containers|find)$/.exec(p)) && m === 'GET') {
            const radius = Number(url.searchParams.get('radius')) || (a[2] === 'containers' ? 24 : 32);
            return send(res, 200, a[2] === 'entities' ? service.nearbyEntities(a[1], radius) : a[2] === 'find' ? service.survey(a[1], String(url.searchParams.get('target') || ''), radius) : service.containersNear(a[1], radius));
        }
        if ((a = /^\/api\/bots\/([A-Za-z0-9_]{3,16})$/.exec(p)) && m === 'GET') return send(res, 200, service.botDetail(a[1]));
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
        dataDir, worldDir: env.WORK_WORLD || null, host: env.MC_HOST || 'localhost', port: Number(env.MC_PORT) || 25565, known: knownFromTable(table), kit,
        maxBots: Number(env.WORK_MAX_BOTS) || 24,
        rcon: env.RCON_PASSWORD ? { host: env.RCON_HOST || env.MC_HOST || 'localhost', port: Number(env.RCON_PORT) || 25575, password: env.RCON_PASSWORD } : null,
    });
    const tokenFile = env.WORK_TOKEN_FILE || path.join(dataDir, 'console.token');
    const token = loadToken(tokenFile);
    await service.restore();
    const access = env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD ? new Access({ team: env.CF_ACCESS_TEAM, aud: env.CF_ACCESS_AUD, emails: (env.WORK_ALLOWED_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean) }) : null;
    if (env.WORK_PUBLIC_HOST && !access) { console.error('WORK_PUBLIC_HOST needs CF_ACCESS_TEAM and CF_ACCESS_AUD: refusing to serve the public name without Access'); process.exit(1); }
    const { server } = createConsole({ service, token, access, publicHost: env.WORK_PUBLIC_HOST || null, allowedHosts: (env.WORK_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) });
    const bind = env.WORK_BIND || '127.0.0.1', port = Number(env.WORK_PORT) || 3020;
    server.listen(port, bind, () => console.log(`[console] http://${bind}:${port}  server ${service.o.host}:${service.o.port}  table ${service.known ? table : 'none (vanilla names only)'}  rcon ${service.o.rcon ? 'on' : 'off'}  token file ${tokenFile}`));
    const down = async () => { server.close(); await service.stop(); process.exit(0); };
    process.on('SIGTERM', down); process.on('SIGINT', down);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createConsole, loadToken, hostAllowed, knownFromTable };

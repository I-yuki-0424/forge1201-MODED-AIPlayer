'use strict';
// The console's HTTP server: authentication in front of the route modules (routes/*.js), which call WorkService.
// The operator can add and remove bots, designate pits, manage and edit structure files and build them. It can also reach RCON
// (give items, read positions), so it is treated as an administrative interface, not as a status page:
//   - who may reach it is decided by the network: loopback and the tailnet (no token), or the public name behind Cloudflare Access (a valid
//     Access assertion for an allowed e-mail). A request that came through a proxy (Cloudflare headers, X-Forwarded-For) and carries no valid
//     assertion is refused, so a tunnel mistake cannot open the console. `token` (WORK_REQUIRE_TOKEN=1) brings the old access token back:
//     a random token (file, mode 0600, never logged or put in a URL) is then exchanged for the session
//   - every request needs the session (issued by GET /api/session, an HttpOnly SameSite=Strict cookie); every non-GET also the CSRF header of that session and a same-host Origin (if sent)
//   - the Host header must be localhost, an IP literal, a *.ts.net name or listed in WORK_ALLOWED_HOSTS (DNS rebinding)
//   - JSON only (no form posts), bounded bodies, closed routes, closed validation in the service, strict CSP, no CORS
//   - binds to 127.0.0.1 unless WORK_BIND says otherwise; the owner's route to it is the tailnet (docs/LESSONS.md L3)
//   - failed logins are throttled per address
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Problem } = require('../service');
const { SESSION_MS, safeEq, hostAllowed, send, fail, json, Raw } = require('./http');

const PUBLIC = path.join(__dirname, '..', '..', '..', 'public', 'work');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC_NAME = /^\/([a-z0-9_]{1,24})\.(js|css)$/;               // a file of public/work/, nothing else (no directories, no dots)
const ROUTES = ['state', 'bots', 'jobs', 'structures', 'inventory'];

const PROXY_HEADERS = ['cf-ray', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-access-jwt-assertion'];

function createConsole({ service, token = null, allowedHosts = [], publicHost = null, access = null, now = Date.now }) {
    publicHost = publicHost ? String(publicHost).toLowerCase() : null;
    if (publicHost) allowedHosts = [...allowedHosts, publicHost];
    const sessions = new Map(), fails = new Map();
    const reap = () => { for (const [k, s] of sessions) if (s.until < now()) sessions.delete(k); };
    const handlers = ROUTES.map((r) => require(`./routes/${r}`)(service));
    const cookieOf = (req) => { const m = /(?:^|;\s*)wc_session=([0-9a-f]{64})/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
    const setCookie = (sid) => ({ 'Set-Cookie': `wc_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });

    async function route(req, res, url) {
        const { pathname: p } = url, m = req.method;
        const ip = req.socket.remoteAddress || '?';
        // Cloudflare Access: through the public hostname every request must carry a valid Access assertion (a tunnel mistake must not
        // expose the console); a valid one for the owner's e-mail also signs the owner in without the token.
        const jwtUser = access && req.headers['cf-access-jwt-assertion'] ? await access.verify(req.headers['cf-access-jwt-assertion']) : null;
        if (publicHost && String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '') === publicHost && !jwtUser) return fail(res, 403, 'Cloudflare Access required');

        const proxied = PROXY_HEADERS.some((k) => req.headers[k] !== undefined);                // came through Cloudflare or another proxy: the network is not the authentication
        if (proxied && !token && !jwtUser) return fail(res, 403, 'Cloudflare Access required');

        if (m === 'GET' && (p === '/' || STATIC_NAME.test(p))) {                             // the page itself holds nothing secret
            const file = p === '/' ? 'index.html' : p.slice(1), full = path.join(PUBLIC, file);
            if (!fs.existsSync(full)) return fail(res, 404, 'not found');
            return send(res, 200, fs.readFileSync(full), file === 'index.html' ? 'text/html; charset=utf-8' : TYPES[path.extname(file)]);
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
        if (p === '/api/login' && m === 'POST' && token) {
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
            return send(res, 200, { ok: true, csrf }, 'application/json', setCookie(sid));
        }

        let sid = cookieOf(req), sess = sid && sessions.get(sid);
        if ((!sess || sess.until < now()) && p === '/api/session' && (jwtUser || !token)) {   // signed in at Cloudflare, or on loopback / the tailnet: no second token
            reap(); sid = crypto.randomBytes(32).toString('hex'); sess = { csrf: crypto.randomBytes(16).toString('hex'), until: now() + SESSION_MS };
            sessions.set(sid, sess); if (jwtUser) service.note('info', `console: Access login ${jwtUser.email}`);
            return send(res, 200, { ok: true, csrf: sess.csrf, via: jwtUser ? 'access' : 'network' }, 'application/json', setCookie(sid));
        }
        if (!sess || sess.until < now()) return fail(res, 401, 'login required');
        if (p === '/api/session') return send(res, 200, { ok: true, csrf: sess.csrf });
        if (p === '/api/logout' && m === 'POST') { sessions.delete(sid); return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'wc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
        if (m !== 'GET' && m !== 'HEAD' && !safeEq(req.headers['x-csrf'] || '', sess.csrf)) return fail(res, 403, 'csrf header missing');

        for (const h of handlers) {                                                           // the first route module that knows the path answers
            const out = await h(req, url, m, p);
            if (out === undefined) continue;
            return out instanceof Raw ? send(res, out.status, out.body, out.type, out.extra) : send(res, 200, out);
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

module.exports = { createConsole };

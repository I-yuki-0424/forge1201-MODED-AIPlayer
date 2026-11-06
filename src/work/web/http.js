'use strict';
// HTTP helpers of the console: response writer (security headers, gzip), bounded body readers, token file, Host check.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Problem } = require('../service');

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

function send(res, status, body, type = 'application/json', extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const head = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cross-Origin-Resource-Policy': 'same-origin', ...extra };
    const gz = buf.length > 1024 && /gzip/.test((res.req && res.req.headers['accept-encoding']) || '') && /json|text|javascript/.test(type);
    if (!gz) { res.writeHead(status, { ...head, 'Content-Length': buf.length }); return res.end(buf); }
    zlib.gzip(buf, (e, z) => { if (e) { res.writeHead(500); return res.end(); } res.writeHead(status, { ...head, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': z.length }); res.end(z); });
}
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

/** A reply that is not JSON 200 (a file download): returned by a route handler instead of a plain value. */
class Raw { constructor(body, type, extra = {}, status = 200) { Object.assign(this, { body, type, extra, status }); } }

module.exports = { MAX_JSON, MAX_UPLOAD, SESSION_MS, CSP, safeEq, loadToken, hostAllowed, send, fail, readBody, json, Raw };

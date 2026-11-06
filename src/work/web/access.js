'use strict';
// Cloudflare Access: verify the `Cf-Access-Jwt-Assertion` header (RS256 against the team's published keys, issuer, audience, expiry, and
// an allowed e-mail). Used so that a request that arrives through the public hostname must have passed Access, and so that the owner,
// already signed in at Cloudflare, needs no second token. Keys are fetched from https://<team>/cdn-cgi/access/certs and cached.
const crypto = require('crypto');
const https = require('https');

const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 8000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`certs: HTTP ${res.statusCode}`)); }
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('certs: timeout'))); req.on('error', reject);
    });
}

class Access {
    /** @param cfg { team: "<name>.cloudflareaccess.com", aud: "<application AUD tag>", emails: [..] } ; opts.getKeys () => JWKS (tests) */
    constructor(cfg, { getKeys = null, now = Date.now } = {}) {
        this.team = String(cfg.team).replace(/^https?:\/\//, '').replace(/\/.*$/, ''); this.aud = String(cfg.aud); this.emails = (cfg.emails || []).map((e) => e.toLowerCase());
        this.getKeys = getKeys || (() => fetchJson(`https://${this.team}/cdn-cgi/access/certs`)); this.now = now;
        this.keys = new Map(); this.fetched = 0;
    }
    async _key(kid) {
        if (!this.keys.has(kid) && this.now() - this.fetched > 60000) {                     // unknown kid: refresh, at most once a minute
            const jwks = await this.getKeys(); this.fetched = this.now(); this.keys.clear();
            for (const k of jwks.keys || []) this.keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
        }
        return this.keys.get(kid) || null;
    }
    /** Returns { email } for a valid token, null otherwise. Never throws on bad input. */
    async verify(token) {
        try {
            const parts = String(token || '').split('.');
            if (parts.length !== 3) return null;
            const head = JSON.parse(b64(parts[0]).toString()), body = JSON.parse(b64(parts[1]).toString());
            if (head.alg !== 'RS256' || typeof head.kid !== 'string') return null;
            const key = await this._key(head.kid); if (!key) return null;
            if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64(parts[2]))) return null;
            const t = this.now() / 1000;
            if (typeof body.exp !== 'number' || body.exp < t || (typeof body.nbf === 'number' && body.nbf > t + 30)) return null;
            if (body.iss !== `https://${this.team}`) return null;
            const aud = [].concat(body.aud || []); if (!aud.includes(this.aud)) return null;
            const email = String(body.email || '').toLowerCase();
            if (!email || (this.emails.length && !this.emails.includes(email))) return null;
            return { email };
        } catch (_) { return null; }
    }
}

module.exports = { Access };

'use strict';
// The sign-in link of the in-game browser under jsdom: #token=... signs in once (the token goes to /api/login only), the address is cleaned at once,
// #kiosk switches to the large layout and is remembered, a wrong token shows the sign-in form and is not retried in a loop.
//   docker run --rm -v "$PWD":/w -w /w node:20-slim sh -c 'npm i --no-save --prefix /tmp/j jsdom >/dev/null 2>&1 && NODE_PATH=/tmp/j/node_modules node scripts/work/ui_fragment_check.js'
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const dir = path.join(__dirname, '../../public/work');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map((m) => m[1]);
let checks = 0; const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else checks++; };
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function run(hash, goodToken) {
    const dom = new JSDOM(html.replace(/<script src="[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: `http://127.0.0.1:3020/${hash}` });
    const w = dom.window, sent = []; let loggedIn = false;
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.fetch = async (url, o = {}) => {
        const m = (o.method || 'GET').toUpperCase(), u = String(url).split('?')[0], body = o.body ? JSON.parse(o.body) : null; sent.push([m, u, body]);
        let status = 404, json = { error: 'x' };
        if (u === '/api/session') [status, json] = loggedIn ? [200, { ok: true, csrf: 'c' }] : [401, { error: 'login required' }];
        else if (u === '/api/login') { if (body.token === goodToken) { loggedIn = true; [status, json] = [200, { ok: true, csrf: 'c' }]; } else [status, json] = [401, { error: 'wrong token' }]; }
        else if (u === '/api/notice') [status, json] = [200, { text: '' }];
        else if (u === '/api/state') [status, json] = [200, { now: Date.now(), uptime: 1, server: { host: 'h', port: 1 }, settings: {}, rcon: false, kit: {}, maxBots: 24, map: false, bots: [], jobs: [], log: [] }];
        else if (m === 'GET') [status, json] = [200, []];
        return { ok: status < 400, status, json: async () => json };
    };
    const ctx = dom.getInternalVMContext();
    for (const f of srcs) new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }).runInContext(ctx);
    await tick(300);
    return { w, sent };
}

(async () => {
    let r = await run('#token=abc123&kiosk', 'abc123');
    ok(r.sent.some((s) => s[1] === '/api/login' && s[2].token === 'abc123'), 'the token in the link is sent to /api/login');
    ok(!r.w.document.querySelector('#app').classList.contains('hidden') && r.w.document.querySelector('#login').classList.contains('hidden'), 'signed in: the app is shown');
    ok(!r.w.location.hash.includes('abc123') && !r.w.location.href.includes('token'), `the token is gone from the address: ${r.w.location.href}`);
    ok(r.w.document.body.classList.contains('kiosk'), '#kiosk switches to the large layout');
    ok(r.sent.filter((s) => s[1] === '/api/login').length === 1, 'one login only');
    ok(!r.sent.some((s) => s[1] !== '/api/login' && JSON.stringify(s[2] || '').includes('abc123')), 'the token goes nowhere else');

    r = await run('#token=wrong', 'abc123');
    ok(r.sent.filter((s) => s[1] === '/api/login').length === 1, 'a wrong token is tried once, not in a loop');
    ok(!r.w.document.querySelector('#login').classList.contains('hidden'), 'and the sign-in form is shown');
    ok(!r.w.document.body.classList.contains('kiosk'), 'no kiosk without the flag');

    r = await run('', 'abc123');
    ok(!r.sent.some((s) => s[1] === '/api/login'), 'no fragment: no automatic login');
    r = await run('#kiosk=0', 'abc123');
    ok(!r.w.document.body.classList.contains('kiosk'), '#kiosk=0 turns it off');
    console.log(`ui fragment check: ${checks} ok${process.exitCode ? ', FAILED' : ''}`);
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });

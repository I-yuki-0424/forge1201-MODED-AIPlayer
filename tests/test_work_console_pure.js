// The work console's HTTP layer (src/work/console.js): authentication, CSRF, Host and Origin checks, content types, body limits,
// closed routes, throttling, and the main flows over HTTP (bots, a pit, structure upload/edit/download). Fake service, no game.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { WorkService } = require('../src/work/service');
const { createConsole, loadToken, hostAllowed } = require('../src/work/console');
const bp = require('../src/work/jobs/blueprint');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcon-'));
    const factory = (name) => { const b = new EventEmitter(); Object.assign(b, { entity: { position: { x: 1, y: 70, z: 2 } }, inventory: { items: () => [], emptySlotCount: () => 30 } }); b.quit = () => {}; setTimeout(() => b.emit('spawn'), 5); return b; };
    const service = new WorkService({ dataDir: dir, factory, envFactory: () => ({}) });
    const tokFile = path.join(dir, 'console.token');
    const token = loadToken(tokFile);
    const mode = fs.statSync(tokFile).mode & 0o777;
    const { server } = createConsole({ service, token });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    function call(method, url, { body, headers = {}, cookie, csrf, raw, host } = {}) {
        return new Promise((resolve, reject) => {
            const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
            const h = { Host: host || `127.0.0.1:${port}`, ...(data !== null ? { 'Content-Type': raw !== undefined ? 'application/octet-stream' : 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
            if (cookie) h.Cookie = cookie; if (csrf) h['X-CSRF'] = csrf;
            const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: h }, (res) => {
                const chunks = []; res.on('data', (c) => chunks.push(c));
                res.on('end', () => { const buf = Buffer.concat(chunks); let j = null; try { j = JSON.parse(buf.toString()); } catch (_) { /* binary or html */ } resolve({ status: res.statusCode, json: j, buf, headers: res.headers }); });
            });
            req.on('error', reject); if (data !== null) req.write(data); req.end();
        });
    }
    let cookie, csrf;

    await test('token file is private; the page is public, every API route needs the session', async () => {
        assert.strictEqual(mode, 0o600); assert.ok(token.length >= 48);
        const page = await call('GET', '/'); assert.strictEqual(page.status, 200);
        assert.match(page.headers['content-security-policy'], /default-src 'none'.*script-src 'self'/); assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');
        for (const [m, u] of [['GET', '/api/state'], ['GET', '/api/players'], ['POST', '/api/bots'], ['GET', '/api/structures'], ['DELETE', '/api/bots/Abc'], ['GET', '/api/surface?x=1&z=1']]) {
            const r = await call(m, u, m === 'POST' ? { body: { name: 'Abc' } } : {}); assert.strictEqual(r.status, 401, `${m} ${u}`);
        }
        assert.strictEqual((await call('GET', '/api/state', { cookie: 'wc_session=' + 'a'.repeat(64) })).status, 401);
        assert.strictEqual((await call('GET', '/etc/passwd')).status, 404); assert.strictEqual((await call('GET', '/../../package.json')).status, 404);
        assert.strictEqual((await call('GET', '/work.js')).status, 200);
    });

    await test('login: wrong token refused (and throttled), right token gives a strict cookie and a CSRF value', async () => {
        const bad = await call('POST', '/api/login', { body: { token: 'x'.repeat(48) } }); assert.strictEqual(bad.status, 401);
        assert.strictEqual((await call('POST', '/api/login', { body: { token: 5 } })).status, 401);
        const ok = await call('POST', '/api/login', { body: { token } });
        assert.strictEqual(ok.status, 200);
        const sc = ok.headers['set-cookie'][0]; assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.ok(!sc.includes(token));
        cookie = sc.split(';')[0]; csrf = ok.json.csrf;
        assert.strictEqual((await call('GET', '/api/state', { cookie })).status, 200);
        for (let i = 0; i < 9; i++) await call('POST', '/api/login', { body: { token: 'nope' + i } });
        assert.strictEqual((await call('POST', '/api/login', { body: { token } })).status, 429, 'locked out after repeated failures');
        // the lockout is per address and time bound; the test restarts the console to continue
    });

    server.close();                                                            // a second console (fresh throttle table), same service
    const c2 = createConsole({ service, token }); const s2 = c2.server; await new Promise((r) => s2.listen(0, '127.0.0.1', r)); const p2 = s2.address().port;
    const call2 = (m, u, o = {}) => new Promise((resolve, reject) => {
        const data = o.body !== undefined ? JSON.stringify(o.body) : o.raw !== undefined ? o.raw : null;
        const h = { Host: o.host || `127.0.0.1:${p2}`, ...(data !== null ? { 'Content-Type': o.type || (o.raw !== undefined ? 'application/octet-stream' : 'application/json'), 'Content-Length': Buffer.byteLength(data) } : {}), ...(o.headers || {}) };
        if (o.cookie) h.Cookie = o.cookie; if (o.csrf) h['X-CSRF'] = o.csrf;
        const req = http.request({ host: '127.0.0.1', port: p2, path: u, method: m, headers: h }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j = null; try { j = JSON.parse(buf.toString()); } catch (_) { /* binary */ } resolve({ status: res.statusCode, json: j, buf, headers: res.headers }); }); });
        req.on('error', reject); if (data !== null) req.write(data); req.end();
    });
    const login = await call2('POST', '/api/login', { body: { token } }); cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.json.csrf;
    const A = { cookie, csrf };

    await test('writes need the CSRF header, the same Origin, JSON; Host must be local; bodies are bounded', async () => {
        assert.strictEqual((await call2('POST', '/api/bots', { body: { name: 'Hack1' }, cookie })).status, 403, 'no csrf header');
        assert.strictEqual((await call2('POST', '/api/bots', { body: { name: 'Hack1' }, cookie, csrf: 'wrong' })).status, 403);
        assert.strictEqual((await call2('POST', '/api/bots', { body: { name: 'Hack1' }, ...A, headers: { Origin: 'http://evil.example' } })).status, 403, 'foreign origin');
        assert.strictEqual((await call2('POST', '/api/bots', { raw: '{"name":"Hack1"}', type: 'text/plain', ...A })).status, 415, 'no form or text posts');
        assert.strictEqual((await call2('GET', '/api/state', { ...A, host: 'evil.example' })).status, 421, 'DNS rebinding');
        assert.strictEqual((await call2('GET', '/api/state', { ...A, host: 'vps.tailfc1fac.ts.net:3021' })).status, 200);
        assert.strictEqual((await call2('POST', '/api/bots', { raw: 'x'.repeat(300 * 1024), type: 'application/json', ...A })).status, 413);
        assert.strictEqual((await call2('POST', '/api/bots', { raw: '{not json', type: 'application/json', ...A })).status, 400);
        assert.strictEqual((await call2('POST', '/api/bots', { body: { name: 'Hack1' }, ...A, headers: { Origin: `http://127.0.0.1:${p2}` } })).status, 200, 'same origin passes');
        assert.ok(hostAllowed('localhost:3020', []) && hostAllowed('[::1]:3020', []) && hostAllowed('100.77.246.23:3021', []) && !hostAllowed('example.com', []) && hostAllowed('box.lan', ['box.lan']));
    });

    await test('bots over HTTP: add one, add a batch, bad names refused, remove', async () => {
        assert.strictEqual((await call2('POST', '/api/bots', { body: { name: 'bad name!' }, ...A })).status, 400);
        const b = await call2('POST', '/api/bots', { body: { prefix: 'Crew', count: 3 }, ...A }); assert.deepStrictEqual(b.json.added.map((x) => x.name), ['Crew1', 'Crew2', 'Crew3']);
        assert.strictEqual((await call2('POST', '/api/bots', { body: { prefix: 'Crew', count: 99 }, ...A })).status, 400);
        assert.strictEqual((await call2('DELETE', '/api/bots/Crew3', A)).status, 200);
        assert.strictEqual((await call2('DELETE', '/api/bots/Crew3', A)).status, 404);
        assert.strictEqual((await call2('DELETE', '/api/bots/..%2F..%2Fx', A)).status, 404);
        const s = await call2('GET', '/api/state', A); assert.ok(s.json.bots.length >= 3); assert.strictEqual(s.json.rcon, false);
        assert.strictEqual((await call2('POST', '/api/bots/Crew1/kit', A)).status, 503, 'no RCON configured');
        assert.strictEqual((await call2('GET', '/api/players', A)).status, 503);
    });

    await test('pit over HTTP: created paused, listed with its box, deleted; an impossible pit is a 400 with the reason', async () => {
        const bad = await call2('POST', '/api/jobs/pit', { body: { method: 'rows', box: { x0: 0, z0: 0, x1: 2, z1: 2, top: 90, bottom: 10 } }, ...A }); assert.strictEqual(bad.status, 400); assert.match(bad.json.error, /haul road/);
        const ok = await call2('POST', '/api/jobs/pit', { body: { name: 'north cut', box: { x0: 10, z0: 10, x1: 40, z1: 30, top: 80, bottom: 78 } }, ...A });
        assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.state, 'ready'); assert.strictEqual(ok.json.progress.total > 0, true);
        const d = await call2('GET', `/api/jobs/${ok.json.id}`, A); assert.ok(d.json.regions.length >= 4 && d.json.box.top === undefined);
        assert.strictEqual((await call2('GET', '/api/jobs/zzz', A)).status, 404);
        assert.strictEqual((await call2('DELETE', `/api/jobs/${ok.json.id}`, A)).status, 200);
    });

    await test('dimensions over HTTP: the range check and the dimension list need a session; a pit in the Nether is created with its dimension and refused above its ceiling', async () => {
        for (const [m, u] of [['GET', '/api/dimensions'], ['POST', '/api/range/check']]) assert.strictEqual((await call2(m, u, {})).status, 401, `${m} ${u} without a session`);
        const l = await call2('GET', '/api/dimensions', A); assert.strictEqual(l.status, 200); assert.deepStrictEqual(l.json.dimensions.slice(0, 3).map((d) => d.name), ['overworld', 'nether', 'end']);
        const c = await call2('POST', '/api/range/check', { body: { dim: 'minecraft:the_nether', x0: 0, x1: 15, z0: 0, z1: 15 }, ...A }); assert.strictEqual(c.status, 200); assert.strictEqual(c.json.range.dim, 'nether'); assert.strictEqual(c.json.range.y1, 122);
        assert.strictEqual((await call2('POST', '/api/range/check', { body: { dim: 'mars', x0: 0, x1: 1, z0: 0, z1: 1 }, ...A })).status, 400);
        assert.strictEqual((await call2('POST', '/api/range/check', { body: { dim: 'nether', x0: 0, x1: 1, z0: 0, z1: 1, y1: 400 }, ...A })).status, 400);
        const spec = { name: 'nether cut', dim: 'nether', box: { x0: 1000, z0: 1000, x1: 1010, z1: 1010, top: 100, bottom: 98 } };
        assert.strictEqual((await call2('POST', '/api/jobs/pit', { body: { ...spec, box: { ...spec.box, top: 300 } }, ...A })).status, 400);
        const ok = await call2('POST', '/api/jobs/pit', { body: spec, ...A }); assert.strictEqual(ok.status, 200);
        assert.strictEqual((await call2('DELETE', `/api/jobs/${ok.json.id}`, A)).status, 200);
    });

    await test('every script the page loads is served (a file missing from the static list breaks the page and no other test sees it)', async () => {
        const html = fs.readFileSync(path.join(__dirname, '../public/work/index.html'), 'utf8');
        const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).concat([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]));
        assert.ok(srcs.includes('/page_tags.js') && srcs.length >= 12, srcs.join(' '));
        for (const u of srcs) { const r = await call2('GET', u, {}); assert.strictEqual(r.status, 200, `${u} is ${r.status}`); }
    });

    await test('v5 routes: sites, scripts and Leave pit need the session; bad input is a 400 with the reason, unknown names a 404', async () => {
        for (const [m, u] of [['GET', '/api/sites'], ['POST', '/api/sites'], ['GET', '/api/scripts'], ['POST', '/api/scripts'], ['POST', '/api/bots/Crew1/leave'], ['POST', '/api/scripts/x/run']]) assert.strictEqual((await call2(m, u, {})).status, 401, `${m} ${u} without a session`);
        assert.strictEqual((await call2('POST', '/api/sites', { body: { name: 'a', x: 1, y: 2, z: 3, tags: ['wood'] }, ...A })).status, 400);
        assert.strictEqual((await call2('POST', '/api/sites', { body: { name: 'ore1', x: 1, y: 64, z: 3, tags: ['ore', 'storage'] }, ...A })).status, 400, 'two purposes for one block are refused');
        const ok = await call2('POST', '/api/sites', { body: { name: 'ore1', x: 1, y: 64, z: 3, purpose: 'ore' }, ...A }); assert.strictEqual(ok.status, 200);
        const list = await call2('GET', '/api/sites', A); assert.deepStrictEqual(list.json.sites.map((x) => x.name), ['ore1']); assert.ok(list.json.tags.tools);
        assert.strictEqual((await call2('DELETE', '/api/sites/ore1', A)).status, 200); assert.strictEqual((await call2('DELETE', '/api/sites/ore1', A)).status, 404);
        assert.strictEqual((await call2('DELETE', '/api/sites/..%2Fx', A)).status, 404, 'a name outside the pattern never reaches the service');
        const bad = await call2('POST', '/api/scripts', { body: { name: 's', steps: [{ cmd: 'rm' }] }, ...A }); assert.strictEqual(bad.status, 400); assert.match(bad.json.error, /unknown command/);
        assert.strictEqual((await call2('POST', '/api/scripts', { body: { name: 'hello', steps: [{ return: 'ok' }] }, ...A })).status, 200);
        const sc = await call2('GET', '/api/scripts', A); assert.ok(sc.json.some((x) => x.name === 'hello') && sc.json.some((x) => x.name === 'replace-tool' && x.builtIn));
        assert.strictEqual((await call2('DELETE', '/api/scripts/replace-tool', A)).status, 404, 'built-in scripts stay');
        assert.strictEqual((await call2('DELETE', '/api/scripts/hello', A)).status, 200);
        assert.strictEqual((await call2('POST', '/api/scripts/hello/run', { body: { bot: 'Nobody' }, ...A })).status, 404);
        assert.strictEqual((await call2('POST', '/api/bots/Nobody/leave', { body: {}, ...A })).status, 404);
        const set = await call2('POST', '/api/settings', { body: { retireWorn: false, scripts: false }, ...A }); assert.deepStrictEqual([set.json.retireWorn, set.json.scripts], [false, false]);
        assert.strictEqual((await call2('POST', '/api/settings', { body: { retireWorn: 'no' }, ...A })).json.retireWorn, false, 'a non-boolean changes nothing');
    });

    await test('structures over HTTP: upload raw .nbt, inspect, edit to a new name, download a valid file, delete', async () => {
        const part = bp.fill(bp.empty(4, 2, 1), { x0: 0, y0: 0, z0: 0, x1: 3, y1: 1, z1: 0 }, 'spruce_planks');
        const up = await call2('POST', '/api/structures/wall1', { raw: bp.write(part), ...A }); assert.strictEqual(up.status, 200); assert.strictEqual(up.json.blocks, 8);
        assert.strictEqual((await call2('POST', '/api/structures/wall1', { raw: bp.write(part), ...A })).status, 409);
        assert.strictEqual((await call2('POST', '/api/structures/wall1?overwrite=1', { raw: bp.write(part), ...A })).status, 200);
        assert.strictEqual((await call2('POST', '/api/structures/junk', { raw: 'not nbt at all, sorry', ...A })).status, 400);
        assert.strictEqual((await call2('POST', '/api/structures/Bad_Name', { raw: bp.write(part), ...A })).status, 404, 'upper case does not match the closed route');
        const e = await call2('POST', '/api/structures/wall1/edit', { body: { ops: [{ op: 'rotate', turns: 1 }, { op: 'replace', from: 'spruce_planks', to: 'birch_planks' }], as: 'wall1_r' }, ...A });
        assert.strictEqual(e.status, 200); assert.deepStrictEqual(e.json.size, [1, 2, 4]);
        const dl = await call2('GET', '/api/structures/wall1_r/download', A); assert.strictEqual(dl.status, 200);
        assert.match(dl.headers['content-disposition'], /wall1_r\.nbt/);
        const back = await bp.read(dl.buf); assert.deepStrictEqual(back.size, [1, 2, 4]); assert.strictEqual(back.palette[0].name, 'minecraft:birch_planks');
        const lay = await call2('GET', '/api/structures/wall1_r/layer/1', A); assert.strictEqual(lay.json.grid.length, 4);
        assert.strictEqual((await call2('GET', '/api/structures/wall1_r/layer/9', A)).status, 400);
        const list = await call2('GET', '/api/structures', A); assert.deepStrictEqual(list.json.map((s) => s.name).sort(), ['wall1', 'wall1_r']);
        const g = await call2('POST', '/api/structures/generate', { body: { kind: 'box', params: { w: 3, h: 3, d: 3, block: 'stone' }, as: 'cube' }, ...A }); assert.strictEqual(g.json.blocks, 27);
        const job = await call2('POST', '/api/jobs/build', { body: { structure: 'cube', origin: { x: 0, y: 70, z: 0 }, ops: [{ op: 'mirror', axis: 'x' }] }, ...A });
        assert.strictEqual(job.status, 200); assert.strictEqual(job.json.summary.count, 27);
        assert.strictEqual((await call2('POST', '/api/jobs/build', { body: { structure: '../x', origin: { x: 0, y: 70, z: 0 } }, ...A })).status, 400);
        assert.strictEqual((await call2('DELETE', '/api/structures/cube', A)).status, 200);
    });

    await test('logout ends the session', async () => {
        assert.strictEqual((await call2('POST', '/api/logout', A)).status, 200);
        assert.strictEqual((await call2('GET', '/api/state', A)).status, 401);
    });
    s2.close(); server.close(); await service.stop();
    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

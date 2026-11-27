'use strict';
// The console's CI routes (src/work/web/routes/ci.js, TASK-20261125-080): 401 without a session; the runs and one run with one (a real file is served: the control);
// closed run ids, traversal, a symlink out of the folder and proxy headers without Cloudflare Access refused.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

(async () => {
    const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
    const root = tmp('cir-'), outside = tmp('cio-'), id = '1128-0034-c788e373', neg = '1128-0200-0badc0de-negative';
    fs.mkdirSync(path.join(root, 'runs'));
    fs.writeFileSync(path.join(root, 'history.jsonl'), [{ id, sha: 'c788e373', pass: 8, ran: 10, tests: [] }, { id: '../x', pass: 0 }, { id: neg, label: 'negative', pass: 1, ran: 3, tests: [] }].map((x) => JSON.stringify(x)).join('\n') + '\n{torn');
    fs.writeFileSync(path.join(root, 'runs', `${id}.json`), JSON.stringify({ id, tests: [{ name: 'tags', verdict: 'pass' }] }));
    fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":1}'); fs.symlinkSync(path.join(outside, 'secret.json'), path.join(root, 'runs', `${neg}.json`));
    const { WorkService } = require('../src/work/service'), { createConsole } = require('../src/work/web/server');
    const svc = new WorkService({ dataDir: tmp('cisvc-'), factory: () => { throw new Error('no bots'); }, envFactory: () => ({}), display: false });
    const { server } = createConsole({ service: svc, ciDir: root }); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
    const call = (u, cookie, extra = {}) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: u, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...extra } }, (res) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString() })); }).on('error', reject); });
    try {
        assert.strictEqual((await call('/api/ci/runs')).status, 401, 'no session');
        assert.strictEqual((await call(`/api/ci/run/${id}`)).status, 401, 'no session, no run');
        const cookie = String((await call('/api/session')).headers['set-cookie']).split(';')[0];
        assert.strictEqual((await call('/api/ci/runs', cookie, { 'x-forwarded-for': '1.2.3.4' })).status, 403, 'through a proxy without Access');
        const runs = JSON.parse((await call('/api/ci/runs', cookie)).body);
        assert.deepStrictEqual(runs.runs.map((r) => r.id), [neg, id], 'newest first, a bad id and a torn line dropped');
        const one = await call(`/api/ci/run/${id}`, cookie); assert.strictEqual(one.status, 200, 'control: a real run'); assert.strictEqual(JSON.parse(one.body).tests[0].name, 'tags');
        for (const bad of [`/api/ci/run/${neg}`, '/api/ci/run/..%2Fhistory', '/api/ci/run/../history.jsonl', '/api/ci/run/1128-0034-C788E373', '/api/ci/run/x', '/api/ci/history.jsonl', '/api/ci/run/1128-0034-c788e373/x', '/api/ci/run/9999-9999-00000000']) {
            const r = await call(bad, cookie); assert.ok([400, 404].includes(r.status), `${bad}: ${r.status}`); assert.ok(!r.body.includes('secret'), bad);
        }
    } finally { server.close(); await svc.stop(); }
    console.log('test_ci_route_pure: ok');
})().catch((e) => { console.error(e); process.exit(1); });

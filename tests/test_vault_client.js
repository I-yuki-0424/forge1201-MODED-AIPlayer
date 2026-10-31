// Tests of src/vault_client.js against a local stand-in for the vault (http on 127.0.0.1, allowed only with
// VAULT_ALLOW_LOCAL_HTTP=1). The real vault is checked live: unauthenticated 302, this client 404 until the record exists.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { readConf, get, loadLlmCredentials } = require('../src/vault_client');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

(async () => {
    const records = { 'ollama/forgeaip': { value: 'k3y-value', fields: { url: 'https://ollama.example/api/generate' } } };
    const seen = [];
    const srv = http.createServer((req, res) => {
        seen.push({ url: req.url, id: req.headers['cf-access-client-id'], secret: req.headers['cf-access-client-secret'] });
        const u = new URL(req.url, 'http://x');
        const rec = records[u.pathname.replace('/v1/secrets/', '')];
        const field = u.searchParams.get('field');
        const v = rec && (field ? rec.fields[field] : rec.value);
        res.statusCode = v ? 200 : 404;
        res.end(v || '{"error":"not found"}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    process.env.VAULT_ALLOW_LOCAL_HTTP = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    const conf = path.join(dir, 'vault-llm.conf');
    fs.writeFileSync(conf, `VAULT_URL=http://127.0.0.1:${srv.address().port}\nVAULT_CLIENT_ID=abc.access\nVAULT_CLIENT_SECRET=s3cr3t\n`, { mode: 0o600 });

    try {
        await test('client file: mode 600 required, https only (local http only when allowed)', () => {
            assert.deepStrictEqual(readConf(conf), { url: `http://127.0.0.1:${srv.address().port}`, id: 'abc.access', secret: 's3cr3t' });
            fs.chmodSync(conf, 0o644);
            assert.throws(() => readConf(conf), /chmod 600/);
            fs.chmodSync(conf, 0o600);
            assert.strictEqual(readConf(path.join(dir, 'missing.conf')), null);
            delete process.env.VAULT_ALLOW_LOCAL_HTTP;
            assert.throws(() => readConf(conf), /bare https origin/);
            process.env.VAULT_ALLOW_LOCAL_HTTP = '1';
        });

        await test('get: value and field with the service-token headers; 404 is null; bad ids refused', async () => {
            const c = readConf(conf);
            assert.strictEqual(await get(c, 'ollama/forgeaip'), 'k3y-value');
            assert.strictEqual(await get(c, 'ollama/forgeaip', 'field=url'), 'https://ollama.example/api/generate');
            assert.strictEqual(await get(c, 'ollama/forgeaip', 'field=model'), null);
            assert.strictEqual(await get(c, 'ollama/other'), null);
            assert.deepStrictEqual([seen[0].id, seen[0].secret, seen[0].url], ['abc.access', 's3cr3t', '/v1/secrets/ollama/forgeaip?format=value']);
            await assert.rejects(get(c, '../etc/passwd'), /bad record id/);
        });

        await test('loadLlmCredentials: vault first, .env kept when absent or unreachable, never logs values', async () => {
            const env = { OLLAMA_API_KEY: 'from-env', OLLAMA_URL: 'http://pc:11434/api/generate', OLLAMA_MODEL: 'm1' };
            const r = await loadLlmCredentials({ file: conf, env });
            assert.deepStrictEqual(r, { source: 'vault', fields: ['OLLAMA_API_KEY', 'OLLAMA_URL'] });
            assert.deepStrictEqual(env, { OLLAMA_API_KEY: 'k3y-value', OLLAMA_URL: 'https://ollama.example/api/generate', OLLAMA_MODEL: 'm1' });
            const env2 = { OLLAMA_API_KEY: 'from-env' };
            const absent = await loadLlmCredentials({ file: conf, record: 'ollama/missing', env: env2 });
            assert.strictEqual(absent.source, 'env'); assert.match(absent.why, /absent/); assert.strictEqual(env2.OLLAMA_API_KEY, 'from-env');
            assert.strictEqual((await loadLlmCredentials({ file: path.join(dir, 'none.conf'), env: env2 })).source, 'env');
            fs.writeFileSync(conf, 'VAULT_URL=http://127.0.0.1:1\nVAULT_CLIENT_ID=abc.access\nVAULT_CLIENT_SECRET=s3cr3t\n', { mode: 0o600 });
            const down = await loadLlmCredentials({ file: conf, env: env2 });
            assert.strictEqual(down.source, 'env'); assert.match(down.why, /ECONNREFUSED/); assert.doesNotMatch(down.why, /s3cr3t/);
        });
    } finally {
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('All vault client tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });

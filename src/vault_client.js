'use strict';
// Read-only client of the owner's token vault (MCP-credential-broker/vault, https://vault.i-yuki.com), TASK-20261031-018.
// One GET per value with this bot's Access service-token pair (config/vault-llm.conf, mode 600, written by
// MCP-credential-broker/scripts/vault-client.py). The vault grants this client the record ollama/forgeaip only:
//   value = the Ollama API key;  field url = the endpoint (e.g. https://ollama.com/api/generate);  field model (optional).
// Values are never logged; errors name the record and the HTTP status, nothing else.
const fs = require('fs');
const http = require('http');
const https = require('https');

const DEFAULT_URL = 'https://vault.i-yuki.com';
const MAX_BYTES = 16384;

/** {url, id, secret} from a KEY=VALUE file, or null when it does not exist. Refuses a file others can read. */
function readConf(file) {
    if (!file || !fs.existsSync(file)) return null;
    if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error(`vault: ${file} must not be readable by group or others (chmod 600)`);
    const kv = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const conf = { url: kv.VAULT_URL || DEFAULT_URL, id: kv.VAULT_CLIENT_ID, secret: kv.VAULT_CLIENT_SECRET };
    if (!/^[A-Za-z0-9._-]+$/.test(`${conf.id}${conf.secret}`)) throw new Error(`vault: ${file} lacks a valid VAULT_CLIENT_ID / VAULT_CLIENT_SECRET`);
    const local = process.env.VAULT_ALLOW_LOCAL_HTTP === '1' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(conf.url);
    if (!/^https:\/\/[A-Za-z0-9.:-]+$/.test(conf.url) && !local) throw new Error('vault: VAULT_URL must be a bare https origin');
    return conf;
}

/** The value of `record` (query `format=value` or `field=<name>`): a string, or null when absent / not granted (404). */
function get(conf, record, query = 'format=value') {
    if (!/^[a-z0-9][a-z0-9_.-]{0,62}\/[a-z0-9][a-z0-9_.-]{0,62}$/.test(record)) return Promise.reject(new Error('vault: bad record id'));
    const u = new URL(`/v1/secrets/${record}?${query}`, conf.url);
    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request(u, { method: 'GET', timeout: 15000, headers: {
            'CF-Access-Client-Id': conf.id, 'CF-Access-Client-Secret': conf.secret, 'User-Agent': 'forgeaip/1.0', Accept: 'text/plain' } }, (res) => {
            let body = '', size = 0;
            res.setEncoding('utf8');
            res.on('data', (d) => { size += d.length; if (size > MAX_BYTES) { req.destroy(); reject(new Error(`vault: ${record}: reply too large`)); } else body += d; });
            res.on('end', () => {
                if (res.statusCode === 200) return resolve(body.trim());
                if (res.statusCode === 404) return resolve(null);
                reject(new Error(`vault: ${record}: HTTP ${res.statusCode}`));
            });
        });
        req.on('timeout', () => req.destroy(new Error(`vault: ${record}: timeout`)));
        req.on('error', (e) => reject(new Error(`vault: ${record}: ${e.code || e.message}`)));
        req.end();
    });
}

/**
 * Put the LLM credentials from the vault into `env` (OLLAMA_API_KEY, and OLLAMA_URL / OLLAMA_MODEL when the record has
 * those fields). Vault first; when there is no client file, the record is absent, or the vault cannot be reached, `env`
 * keeps what .env gave it. Returns {source: 'vault' | 'env', why?, fields: [names set]} for one log line.
 */
async function loadLlmCredentials({ file, record = 'ollama/forgeaip', env = process.env } = {}) {
    let conf;
    try { conf = readConf(file); } catch (e) { return { source: 'env', why: e.message, fields: [] }; }
    if (!conf) return { source: 'env', why: 'no vault client file', fields: [] };
    try {
        const key = await get(conf, record);
        if (!key) return { source: 'env', why: `vault record ${record} absent (save it in the vault page)`, fields: [] };
        const [url, model] = await Promise.all([get(conf, record, 'field=url'), get(conf, record, 'field=model')]);
        env.OLLAMA_API_KEY = key;
        const fields = ['OLLAMA_API_KEY'];
        if (url) { env.OLLAMA_URL = url; fields.push('OLLAMA_URL'); }
        if (model) { env.OLLAMA_MODEL = model; fields.push('OLLAMA_MODEL'); }
        return { source: 'vault', fields };
    } catch (e) {
        return { source: 'env', why: e.message, fields: [] };
    }
}

module.exports = { readConf, get, loadLlmCredentials, DEFAULT_URL };

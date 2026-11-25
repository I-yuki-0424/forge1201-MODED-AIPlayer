'use strict';
// Capture every packet a bot receives and sends from the connection until SECONDS after the spawn (TASK-20261125-078, SIM-PARITY-v1 section 6):
// the configuration and login packets the in-process packet front end replays, and the counts and sizes of what a server sends a standing bot.
//   REPO=$PWD scripts/t26/run.sh N ../sim/capture.js [SECONDS=20] [OUT=/out/simrec/capture-<version>.jsonl] [NAME=Cap<N>]
// One JSON line per packet: {d: 'in'|'out', st: state, n: name, ms, p: params} (Buffers as {b64}); chunk payloads are kept (the front end needs one).
const fs = require('fs');
const { createBot } = require('../../src/transport');

const SECONDS = Number(process.env.SECONDS || 20), NAME = process.env.NAME || `Cap${process.env.T26_WORLD || 0}`;
const enc = (v) => {
    if (Buffer.isBuffer(v)) return { b64: v.toString('base64') };
    if (typeof v === 'bigint') return { big: v.toString() };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = enc(x); return o; }
    return v;
};
const bot = createBot({ host: process.env.MC_HOST || 'mc', port: Number(process.env.MC_PORT) || 25565, username: NAME });
const out = process.env.OUT || `/out/simrec/capture-${process.env.MC_VERSION || 'x'}.jsonl`;
fs.mkdirSync(require('path').dirname(out), { recursive: true });
const fd = fs.openSync(out, 'w');
const t0 = Date.now(), counts = {};
const line = (o) => fs.writeSync(fd, JSON.stringify(o) + '\n');
bot._client.on('packet', (data, meta) => {
    const k = `in:${meta.state}:${meta.name}`; counts[k] = (counts[k] || 0) + 1;
    line({ d: 'in', st: meta.state, n: meta.name, ms: Date.now() - t0, p: enc(data) });
});
const write = bot._client.write.bind(bot._client);
bot._client.write = (name, params) => { const k = `out:${bot._client.state}:${name}`; counts[k] = (counts[k] || 0) + 1; line({ d: 'out', st: bot._client.state, n: name, ms: Date.now() - t0, p: enc(params) }); return write(name, params); };
bot.once('spawn', () => {
    console.log(`[capture] spawned after ${Date.now() - t0} ms; recording ${SECONDS} s more`);
    setTimeout(() => {
        fs.closeSync(fd);
        console.log(`[capture] ${out}: ${JSON.stringify(counts)}`);
        bot.quit(); setTimeout(() => process.exit(0), 500);
    }, SECONDS * 1000);
});
bot.on('error', (e) => console.error('[capture]', e.message));
setTimeout(() => { console.error('[capture] no spawn in 120 s'); process.exit(1); }, 120000).unref();

'use strict';
// PC end of the training relay (scripts/train/pc_relay.py runs it over SSH from the VPS; stdin/stdout are the link). The PC's
// environments write the DPOD file API under <root>; the learner on the VPS reads and writes a mirror of it. Messages are JSON
// lines: {"have": {path: bytes}} once from each end first (what it already holds, so a reconnect resends nothing), then
// {"f": path, "a": text} (append; complete lines only) or {"f": path, "w": text} (replace). PC -> VPS: <base>.s<i>.current,
// <base>.s<i>.live.json, <run>/env_to_policy.jsonl, <run>/events.jsonl, sites/pc-s<i>.json. VPS -> PC: <run>/policy_to_env.jsonl
// only; anything else is refused. Paths are checked against these forms on both ends.
//   node relay.js <root> <base>
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const root = path.resolve(process.argv[2]), base = process.argv[3];
if (!/^[a-z0-9_-]{1,40}$/i.test(base || '')) { console.error('usage: relay.js <root> <base>'); process.exit(2); }
const RUN = `${base}-s\\d{1,2}-\\d{8}T\\d{6}`;
const IN = new RegExp(`^${RUN}/policy_to_env\\.jsonl$`);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const size = (f) => { try { return fs.statSync(path.join(root, f)).size; } catch { return -1; } };

let peer = null;                      // the VPS's {path: bytes}, null until it arrived
const off = new Map(), seen = new Map();

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.have && typeof m.have === 'object') { peer = m.have; return; }
    if (typeof m.f !== 'string' || typeof m.a !== 'string' || !IN.test(m.f)) return;
    const f = path.join(root, m.f);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, m.a);
}).on('close', () => process.exit(0));

/** Complete lines appended to `f` since the last call (from the VPS's size the first time). */
function tail(f) {
    const n = size(f);
    if (n < 0) return;
    let o = off.has(f) ? off.get(f) : Math.max(0, Number(peer[f]) || 0);
    if (n <= o) { off.set(f, o); return; }
    const fd = fs.openSync(path.join(root, f), 'r');
    try {
        while (o < n) {
            const buf = Buffer.alloc(Math.min(n - o, 1 << 20));
            fs.readSync(fd, buf, 0, buf.length, o);
            const end = buf.lastIndexOf(0x0a);
            if (end < 0) break;
            send({ f, a: buf.subarray(0, end + 1).toString('utf8') });
            o += end + 1;
        }
    } finally { fs.closeSync(fd); }
    off.set(f, o);
}

/** Replace-type files: sent when their modification time changes, at most every `every` ms. */
function mirror(f, every) {
    let st;
    try { st = fs.statSync(path.join(root, f)); } catch { return; }
    const s = seen.get(f);
    if (s && (s.m === st.mtimeMs || Date.now() - s.t < every)) return;
    seen.set(f, { m: st.mtimeMs, t: Date.now() });
    try { send({ f, w: fs.readFileSync(path.join(root, f), 'utf8') }); } catch { /* replaced meanwhile: next pass */ }
}

async function main() {
    const have = {};
    for (const c of fs.readdirSync(root).filter((n) => new RegExp(`^${base}\\.s\\d{1,2}\\.current$`).test(n))) {
        const run = fs.readFileSync(path.join(root, c), 'utf8').trim();
        if (new RegExp(`^${RUN}$`).test(run)) have[`${run}/policy_to_env.jsonl`] = Math.max(0, size(`${run}/policy_to_env.jsonl`));
    }
    send({ have });
    while (peer === null) await sleep(20);
    for (let i = 0; ; i++) {
        for (const c of fs.readdirSync(root).filter((n) => new RegExp(`^${base}\\.s\\d{1,2}\\.current$`).test(n))) {
            mirror(c, 0);
            const run = fs.readFileSync(path.join(root, c), 'utf8').trim();
            if (!new RegExp(`^${RUN}$`).test(run)) continue;
            tail(`${run}/env_to_policy.jsonl`);
            if (i % 25 === 0) tail(`${run}/events.jsonl`);
            mirror(c.replace(/\.current$/, '.live.json'), 1000);
        }
        if (i % 250 === 0 && fs.existsSync(path.join(root, 'sites'))) {
            for (const s of fs.readdirSync(path.join(root, 'sites')).filter((n) => /^pc-s\d{1,2}\.json$/.test(n))) mirror(`sites/${s}`, 10000);
        }
        await sleep(10);
    }
}

main().catch((e) => { console.error(`relay: ${e.message}`); process.exit(1); });

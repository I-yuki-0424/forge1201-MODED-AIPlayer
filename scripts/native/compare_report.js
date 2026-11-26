'use strict';
// The equal-seed comparisons of scripts/native/compare.sh as one table: per test and seed, mineflayer's modules vs the native ones (trials passed, the
// trials' seconds, deaths). Markdown on stdout.   python-free: node scripts/native/compare_report.js /mnt/data/forgeaip-play/t26/out
const fs = require('fs');
const path = require('path');

const out = process.argv[2] || '/out';
const rows = new Map();
for (const d of fs.readdirSync(out).filter((x) => /^cmp-[a-z_]+-[-0-9]+-(mf|native)$/.test(x))) {
    const [, test, seed, mode] = /^cmp-([a-z_]+)-([-0-9]+)-(mf|native)$/.exec(d);
    const f = fs.readdirSync(path.join(out, d)).find((x) => x.startsWith(`${test}-w`) && x.endsWith('.json'));
    if (!f) continue;
    const j = JSON.parse(fs.readFileSync(path.join(out, d, f), 'utf8'));
    const secs = j.trials.map((t) => (t.detail && (t.detail.sec ?? t.detail.elapsed)) || null).filter((x) => x !== null);
    const deaths = j.trials.reduce((a, t) => a + ((t.detail && t.detail.deaths) || 0), 0);
    const k = `${test} ${seed}`;
    if (!rows.has(k)) rows.set(k, {});
    rows.get(k)[mode] = { passed: j.passed, n: j.trials.length, sec: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : j.sec, deaths, fails: j.trials.filter((t) => !t.ok).map((t) => `${t.bot}: ${JSON.stringify(t.detail).slice(0, 120)}`) };
}
console.log('| Test | Seed | mineflayer: passed, mean s, deaths | native: passed, mean s, deaths |');
console.log('| :-- | :-- | :-- | :-- |');
for (const [k, v] of [...rows].sort()) {
    const [test, seed] = k.split(' '), f = (m) => (m ? `${m.passed}/${m.n}, ${m.sec} s, ${m.deaths}` : '-');
    console.log(`| ${test} | ${seed} | ${f(v.mf)} | ${f(v.native)} |`);
}
for (const [k, v] of [...rows].sort()) for (const m of ['mf', 'native']) for (const x of (v[m] && v[m].fails) || []) console.log(`- ${k} ${m}: ${x}`);

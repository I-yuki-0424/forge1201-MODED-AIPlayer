'use strict';
// The CI history (TASK-20261125-080, docs/implemented/CI-v1.md): one finished run of scripts/ci/regress.sh into the record, and its change against the previous run, BOTH ways
// (worse and better: a part that got better without being worked on is as much a finding as one that broke).
//   node scripts/ci/history.js /out/ci-<id> /out/ci      writes <ci>/runs/<id>.json, appends a line to <ci>/history.jsonl, prints the report
// The baseline of a run is the newest earlier run WITHOUT a label (main's own runs); a labelled run (a negative control, a branch) is compared with it but never becomes one.
// Every number comes from the tests' own server-graded JSON (/out/ci-<id>-<fixed|random>/<test>-w9.json); nothing here grades.
const fs = require('fs'), path = require('path');

const TIME_WORSE = 1.25, TIME_MIN_SEC = 30;                 // a time counts as changed beyond 25 % and 30 s (the tests' own run-to-run spread on one seed is about 10 %)

/** key=value lines of run.env. */
const env = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

/** One test's result from its JSON (the newest file of that test in the run's folder of that kind), or null. */
function result(root, id, name, kind) {
    const dir = path.join(root, `ci-${id}-${kind}`);
    let files = []; try { files = fs.readdirSync(dir).filter((f) => f.startsWith(name) && /-w\d\.json$/.test(f)).map((f) => path.join(dir, f)); } catch (_) { return null; }
    if (!files.length) return null;
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    let d; try { d = JSON.parse(fs.readFileSync(files[0], 'utf8')); } catch (_) { return null; }
    const trials = Array.isArray(d.trials) ? d.trials : [];
    const k = trials.filter((t) => t.ok).length;
    return {
        k, n: trials.length, sec: Number.isFinite(d.sec) ? d.sec : null, seedReported: d.seed ? String(d.seed).replace(/\D*(-?\d+).*/s, '$1') : null, speed: d.speed || null,
        fails: trials.filter((t) => !t.ok).slice(0, 4).map((t) => `${t.bot}: ${JSON.stringify(t.detail).slice(0, 240)}`),
    };
}

/** The run as one record. */
function record(runDir, root) {
    const e = env(path.join(runDir, 'run.env')), id = e.id, tests = [];
    const lines = fs.existsSync(path.join(runDir, 'tests.txt')) ? fs.readFileSync(path.join(runDir, 'tests.txt'), 'utf8').trim().split('\n').filter(Boolean) : [];
    for (const l of lines) {
        const [st, name, kind, seed, wall, rc, speed] = l.split(' ');
        const t = { name, kind, seed, status: st === 'ran' ? 'ran' : st === 'skip' ? 'skipped' : 'no_world', wall: Number(wall) || null, exit: rc === undefined ? null : Number(rc), speed: speed ? Number(speed) : null };
        if (st === 'ran') {
            const r = result(root, id, name, kind);
            if (r) Object.assign(t, { k: r.k, n: r.n, rate: r.n ? r.k / r.n : 0, sec: r.sec, fails: r.fails });
            else t.status = 'no_result';                                     // it crashed or hit the wall cap before writing its report
        }
        t.verdict = t.status !== 'ran' ? t.status : t.n > 0 && t.k === t.n ? 'pass' : 'fail';
        tests.push(t);
    }
    const pass = tests.filter((t) => t.verdict === 'pass').length, ran = tests.filter((t) => t.status === 'ran' || t.status === 'no_result' || t.status === 'no_world').length;
    return { id, sha: e.sha, ref: e.ref, label: e.label || '', subject: e.subject || '', committed: Number(e.committed) || null, profile: e.profile, started: Number(e.started) || null, ended: Number(e.ended) || null, pass, ran, tests };
}

/** The change of one test against the baseline's same test: { rate: worse|better|same, time: worse|better|same, ... }, or null without a comparable one. */
function change(t, b) {
    if (!b) return null;
    const same = t.kind === 'fixed' && b.kind === 'fixed' && t.seed === b.seed;            // a random seed is compared too, but says it is another box
    const r = (x) => (x.verdict === 'pass' || x.verdict === 'fail' ? x.rate : -1);         // no result counts below every rate
    const dr = r(t) - r(b);
    let time = 'same';
    if (t.verdict === 'pass' && b.verdict === 'pass' && t.sec && b.sec) {
        if (t.sec > b.sec * TIME_WORSE && t.sec - b.sec >= TIME_MIN_SEC) time = 'worse';
        else if (t.sec * TIME_WORSE < b.sec && b.sec - t.sec >= TIME_MIN_SEC) time = 'better';
    }
    return { against: b.run, rate: dr < -1e-9 ? 'worse' : dr > 1e-9 ? 'better' : 'same', time, was: { verdict: b.verdict, k: b.k, n: b.n, sec: b.sec }, sameSeed: same };
}

function main() {
    const [runDir, ciDir] = process.argv.slice(2), root = path.dirname(runDir);
    const rec = record(runDir, root);
    const histF = path.join(ciDir, 'history.jsonl');
    const hist = fs.existsSync(histF) ? fs.readFileSync(histF, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : [];
    const base = [...hist].reverse().find((h) => !h.label && h.id !== rec.id) || null;
    let baseRec = null; if (base) { try { baseRec = JSON.parse(fs.readFileSync(path.join(ciDir, 'runs', `${base.id}.json`), 'utf8')); } catch (_) { baseRec = null; } }
    for (const t of rec.tests) {
        const b = baseRec && baseRec.tests.find((x) => x.name === t.name && x.kind === t.kind);
        t.change = change(t, b ? { ...b, run: baseRec.id } : null);
    }
    rec.baseline = baseRec ? baseRec.id : null;
    rec.worse = rec.tests.filter((t) => t.change && (t.change.rate === 'worse' || t.change.time === 'worse')).map((t) => `${t.name}/${t.kind}`);
    rec.better = rec.tests.filter((t) => t.change && (t.change.rate === 'better' || t.change.time === 'better')).map((t) => `${t.name}/${t.kind}`);
    fs.mkdirSync(path.join(ciDir, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(ciDir, 'runs', `${rec.id}.json`), JSON.stringify(rec, null, 1));
    const line = { id: rec.id, sha: rec.sha, label: rec.label, subject: rec.subject.slice(0, 160), started: rec.started, ended: rec.ended, pass: rec.pass, ran: rec.ran, worse: rec.worse, better: rec.better,
        tests: rec.tests.map((t) => ({ name: t.name, kind: t.kind, verdict: t.verdict, k: t.k ?? null, n: t.n ?? null, sec: t.sec ?? null })) };
    fs.appendFileSync(histF, JSON.stringify(line) + '\n');
    // the report
    const out = [`CI run ${rec.id}${rec.label ? ` [${rec.label}]` : ''}: ${rec.sha.slice(0, 8)} "${rec.subject.slice(0, 90)}" on ${rec.profile}, test world 9: ${rec.pass}/${rec.ran} tests passed${rec.baseline ? `; against ${rec.baseline}` : '; first run (no baseline)'}`];
    for (const t of rec.tests) {
        const c = t.change, ch = c ? ` | rate ${c.rate}${c.rate !== 'same' ? ` (was ${c.was.k ?? '-'}/${c.was.n ?? '-'} ${c.was.verdict})` : ''}, time ${c.time}${c.was.sec && t.sec ? ` (${c.was.sec} -> ${t.sec} s)` : ''}${c.sameSeed ? '' : ' [other seed]'}` : '';
        out.push(`  ${t.verdict.toUpperCase().padEnd(9)} ${t.name.padEnd(12)} ${t.kind.padEnd(6)} seed ${t.seed}${t.speed ? ` x${t.speed}` : ''}: ${t.n !== undefined ? `${t.k}/${t.n}` : '-'}${t.sec ? ` in ${t.sec} s` : ''}${ch}`);
        for (const f of (t.fails || []).slice(0, 2)) out.push(`      ${f.slice(0, 200)}`);
    }
    out.push(`  worse: ${rec.worse.join(', ') || 'none'} | better: ${rec.better.join(', ') || 'none'}`);
    console.log(out.join('\n'));
}

if (require.main === module) main();
module.exports = { record, change };

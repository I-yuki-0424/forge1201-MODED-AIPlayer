'use strict';
// Freeze watchdog. All bots live in this one process, so one loop that never yields stops every keep-alive and the server drops all bots
// ("Timed out", 2026-11-09: a worker looped for 100 minutes at 140 % CPU and nothing noticed). A second thread watches a counter that the main
// thread bumps every 500 ms. When it stands still for `limitMs` the thread asks the main thread where it is (inspector, works on a busy
// loop), writes the stack and the time to <dir>/freeze.json and kills the process; the container's restart policy brings it back, the
// service restores its roster and (service.restore) its running jobs. Three freezes in a row bring the jobs back paused instead.
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, workerData } = require('worker_threads');

const FILE = 'freeze.json';

/** Starts the watchdog in the main thread. `limitMs` 0 = off. Returns { stop() } or null. */
function start({ dir, limitMs = 25000, intervalMs = 500, killSignal = 'SIGKILL' } = {}) {
    if (!isMainThread || !limitMs || limitMs < 2000) return null;
    const beat = new Int32Array(new SharedArrayBuffer(4));
    const t = setInterval(() => Atomics.add(beat, 0, 1), intervalMs); t.unref();
    const w = new Worker(__filename, { workerData: { beat, dir, limitMs, killSignal } });
    w.unref();
    w.on('error', (e) => console.error('[watchdog] stopped:', e && e.message));
    return { stop() { clearInterval(t); w.terminate(); } };
}

/** What the last freezes were: { at, n, ms, stack }. Null when none is on record. */
function lastFreeze(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')); } catch (_) { return null; } }
/** The process ran well for a while: forget the freezes. */
function forget(dir) { try { fs.rmSync(path.join(dir, FILE), { force: true }); } catch (_) { /* nothing to forget */ } }

function watch({ beat, dir, limitMs, killSignal }) {
    let last = Atomics.load(beat, 0), since = Date.now(), fired = false;
    setInterval(() => {
        const now = Date.now(), v = Atomics.load(beat, 0);
        if (v !== last) { last = v; since = now; return; }
        if (fired || now - since < limitMs) return;
        fired = true;
        const prev = lastFreeze(dir), rec = { at: now, n: (prev && now - prev.at < 3600000 ? prev.n : 0) + 1, ms: now - since, stack: [] };
        let done = false;
        const finish = () => {
            if (done) return; done = true;
            try { fs.writeFileSync(path.join(dir, FILE), JSON.stringify(rec)); fs.writeSync(2, `[watchdog] event loop frozen for ${rec.ms} ms (freeze ${rec.n}); top of stack: ${rec.stack.slice(0, 6).join(' < ')}; killing the process\n`); } catch (_) { /* the kill matters more */ }
            process.kill(process.pid, killSignal);
        };
        try {
            const inspector = require('inspector'), s = new inspector.Session();
            s.connectToMainThread();
            s.on('Debugger.paused', (m) => { rec.stack = m.params.callFrames.slice(0, 30).map((f) => `${f.functionName || '(anon)'} ${String(f.url || '').split('/src/').pop()}:${f.location.lineNumber + 1}`); finish(); });
            s.post('Debugger.enable', () => s.post('Debugger.pause'));
            setTimeout(finish, 4000);                          // no answer: the stack is lost, the kill is not
        } catch (_) { finish(); }
    }, 1000);
}

if (!isMainThread && workerData && workerData.beat) watch(workerData);

module.exports = { start, lastFreeze, forget, FILE };

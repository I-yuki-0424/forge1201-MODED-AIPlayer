'use strict';
// The /dev command's other half (docs/implemented/TEST-WORLDS-T26.md): watches world/scripts/dev.data/requests.txt of ONE T26 world (written by docker/tw/dev.sc) and runs the test asked for
// as a child process, telling the players in chat what starts, which bots to follow, every PASS/FAIL line and the verdict. One test at a time per world. Runs in container forgeaip-t26-dev-N.
const fs = require('fs');
const { spawn } = require('child_process');
const { Rcon } = require('../../src/rl/rcon');

const FILE = '/mcdata/world/scripts/dev.data/requests.txt', WORLD = process.env.T26_WORLD || '?';
const TESTS = new Set(['move_a', 'move_b', 'mine_a', 'mine_b', 'place_a', 'place_b', 'place_c_area', 'place_c_layer', 'place_c_window']);
// place_c_area / place_c_layer: the Litematica build of the iron farm by three bots in 20 minutes (scripts/t26/place_c.js), by the two methods of the builder (docs/implemented/SYNCMATICA-v1.md):
// area = one area per bot, units of a few levels; layer = the same with a barrier between levels (a level opens when the levels below are settled); window = layer with three levels
// above the lowest unsettled one open already.
const SCRIPT = (t) => (t.startsWith('place_c_') ? 'place_c' : t), EXTRA = (t) => (t === 'place_c_layer' ? { BUILD_MODE: 'layer', BUILD_TRACE: '1' } : t === 'place_c_window' ? { BUILD_MODE: 'layer', BUILD_WINDOW: '3', BUILD_TRACE: '1' } : t === 'place_c_area' ? { BUILD_MODE: 'area', BUILD_TRACE: '1' } : {});
let rc = null, child = null, current = null, last = null, offset = 0, queue = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rcon(cmd) {
    for (let i = 0; i < 3; i++) {
        try { if (!rc) { rc = new Rcon({ host: process.env.RCON_HOST || 'mc', port: 25575, password: process.env.RCON_PASSWORD, timeoutMs: 15000 }); await rc.connect(); } return await rc.command(cmd); }
        catch (e) { rc = null; await sleep(1000); }
    }
    return '';
}
const tell = (text, color = 'aqua') => rcon(`tellraw @a ${JSON.stringify({ text: `[dev w${WORLD}] ${String(text).slice(0, 240)}`, color })}`);

function start(test, reps) {
    const run = `dev-${test}-${new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12)}`;
    current = { test, reps, run, started: Date.now(), pass: 0, fail: 0 };
    child = spawn('node', [`scripts/t26/${SCRIPT(test)}.js`], { env: { ...process.env, RUN: run, BOTS: '3', ...EXTRA(test) }, stdio: ['ignore', 'pipe', 'pipe'] });
    tell(`${test} started (run ${run}${reps > 1 ? `, ${queue + 1} of ${reps}` : ''}). Watch: /dev bots, then /dev follow <name>. Results: /mnt/data/forgeaip-play/t26/out/${run}/`);
    const onLine = (line) => {
        process.stdout.write(line + '\n');
        const m = /\] (PASS|FAIL) (\S+) (.*)$/.exec(line);
        if (m) { current[m[1] === 'PASS' ? 'pass' : 'fail']++; tell(`${m[1]} ${m[2]} ${m[3].slice(0, 160)}`, m[1] === 'PASS' ? 'green' : 'red'); }
        else if (/^\[place_c site\]/.test(line)) tell(line.replace(/^\[place_c site\] /, 'site: ').replace(/; reference copy.*?; /, '; ').slice(0, 230), 'gold');
        else if (/^\[progress \d+ min\]/.test(line)) tell(line.replace(/; missing by block.*$/, ''));
        else if (/trials passed|^\[test\]|starts|strip-mines|builds/.test(line)) tell(line.replace(/^\[[^\]]*\] /, ''));
    };
    for (const s of [child.stdout, child.stderr]) { let buf = ''; s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } }); }
    child.on('exit', (code) => {
        last = { ...current, code, min: Math.round((Date.now() - current.started) / 60000) };
        tell(`${test} ended after ${last.min} min: ${last.pass} passed, ${last.fail} failed (exit ${code})`, last.fail || code ? 'red' : 'green');
        child = null; current = null;
        if (++queue < last.reps) setTimeout(() => start(test, last.reps), 3000); else queue = 0;
    });
}

async function handle(line) {
    const [, who, what, test, n] = line.trim().split(/\s+/);
    if (what === 'run') {
        if (!TESTS.has(test)) return tell(`unknown test ${test}`, 'red');
        if (child) return tell(`busy: ${current.test} runs since ${Math.round((Date.now() - current.started) / 60000)} min (/dev stop first)`, 'yellow');
        queue = 0; return start(test, Math.max(1, Math.min(20, Number(n) || 1)));
    }
    if (what === 'stop') { if (!child) return tell('nothing runs'); queue = 99; child.kill('SIGTERM'); setTimeout(() => { if (child) child.kill('SIGKILL'); }, 8000); return tell(`stopping ${current.test} (asked by ${who})`, 'yellow'); }
    if (what === 'status') return tell(child ? `${current.test} runs for ${Math.round((Date.now() - current.started) / 60000)} min: ${current.pass} passed, ${current.fail} failed so far` : `idle; last: ${last ? `${last.test} ${last.pass} passed ${last.fail} failed (${last.min} min)` : 'none'}`);
}

(async () => {
    try { offset = fs.statSync(FILE).size; } catch (_) { offset = 0; }               // requests made before the watcher started are not replayed
    console.log(`[dev] watching ${FILE} from byte ${offset}`);
    for (;;) {
        await sleep(1500);
        let size = 0; try { size = fs.statSync(FILE).size; } catch (_) { continue; }
        if (size < offset) offset = 0;
        if (size === offset) continue;
        const fd = fs.openSync(FILE, 'r'), buf = Buffer.alloc(size - offset); fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); offset = size;
        for (const line of buf.toString('utf8').split('\n')) if (/^\d+ \S+ (run|stop|status) /.test(line.trim())) await handle(line).catch((e) => console.error(e));
    }
})();

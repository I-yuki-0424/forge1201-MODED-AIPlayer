'use strict';
// Training on the owner's PC (owner 2026-11-02: bots from 11 on and the training itself use the PC). One Forge server (127.0.0.1
// only) and one environment process (src/rl/run_skill_env.js) per group, plus the learner (DPOD scripts/botsystem_goal_ppo.py in
// <home>/venv), kept running the way the VPS containers are (restart on exit, with back-off). The VPS groups reach the learner
// through scripts/train/relay.py. Started detached by scripts/train/pc.sh; stops when <home>/STOP exists. Node 20 (portable,
// <home>/node), Java 17 from PATH.
//   node supervisor.js <home>       config: <home>/config.json (written by pc.sh), RCON password: <home>/rcon.txt
// Quiet hours (owner 2026-11-02: the PC is also for private life and work): between cfg.quiet.from and .to o'clock JST (default
// 12-18), or while <home>/PAUSE exists (the owner may create it any time), everything is stopped gracefully (servers save with
// `stop`, the learner's checkpoint is written after every update) and nothing runs; it resumes by itself. Children run at
// below-normal priority. The learner runs on the GPU when <home>/gpu.json ({"distro","python"}, written by `pc.sh gpu-setup`)
// names a WSL2 distro with CUDA jax; otherwise on the CPU in <home>/venv (jax has no native-Windows CUDA wheels).
// A group whose site candidates are used up (environment exit code 7) gets a new world of the same seed: the server is stopped,
// its world and the world's used-site record are deleted, and both start again (owner: regenerate only when the list runs out).
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const home = path.resolve(process.argv[2] || 'C:\\forgeaip');
const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
const pass = fs.readFileSync(path.join(home, 'rcon.txt'), 'utf8').trim();
const app = path.join(home, 'app'), logs = path.join(home, 'logs'), root = path.join(home, 'exchange');
const node = path.join(home, 'node', 'node.exe');
const { Rcon } = require(path.join(app, 'src', 'rl', 'rcon.js'));
fs.mkdirSync(logs, { recursive: true });
const log = (m) => fs.appendFileSync(path.join(logs, 'supervisor.log'), `${new Date().toISOString()} ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stopping = () => fs.existsSync(path.join(home, 'STOP'));
const QUIET = { from: 12, to: 18, ...(cfg.quiet || {}) };
const jstHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const quiet = () => (QUIET.from <= jstHour() && jstHour() < QUIET.to) || fs.existsSync(path.join(home, 'PAUSE'));
let paused = false;

const groups = Array.from({ length: cfg.groups }, (_, g) => ({
    g, shard: cfg.shard0 + g, dir: path.join(home, 'servers', `g${g}`), port: 25600 + g, rport: 25700 + g, world: `pc-s${cfg.shard0 + g}`,
    server: null, env: null, fails: 0, regen: false,
}));

function run(name, cmd, args, opts) {
    const out = fs.openSync(path.join(logs, `${name}.log`), 'a');
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out], windowsHide: true });
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { log(`priority ${name}: ${e.message}`); }
    p.on('exit', () => fs.closeSync(out));
    log(`start ${name} pid ${p.pid}`);
    return p;
}

const portOpen = (port) => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

async function rcon(g, cmd) {
    const c = new Rcon({ host: '127.0.0.1', port: g.rport, password: pass, timeoutMs: 10000 });
    try { await c.connect(); return await c.command(cmd); } finally { c.close(); }
}

function startServer(g) {
    const args = fs.readFileSync(path.join(g.dir, 'args.txt'), 'utf8').trim();   // pc.sh: @user_jvm_args.txt @libraries/.../win_args.txt
    g.server = run(`g${g.g}-server`, 'java', [...args.split(/\s+/), 'nogui'], { cwd: g.dir, env: { ...process.env, FORGEAIP_TICKRATE: String(cfg.speed) } });
    g.server.on('exit', (code) => { log(`g${g.g} server exit ${code}`); g.server = null; });
}

function startEnv(g) {
    const args = [path.join(app, 'src', 'rl', 'run_skill_env.js'), '--root', root, '--base', cfg.base, '--bots', String(cfg.bots), '--shard', String(g.shard),
        '--days', String(cfg.days), '--candidates', path.join(root, cfg.candidates), '--world', g.world, '--seed', String(g.shard)];
    g.env = run(`g${g.g}-env`, node, args, { cwd: app, env: { ...process.env, MC_HOST: '127.0.0.1', MC_PORT: String(g.port), RCON_HOST: '127.0.0.1',
        RCON_PORT: String(g.rport), RCON_PASSWORD: pass, BOT_REGISTRY: 'auto', GAME_SPEED: String(cfg.speed) } });
    g.env.on('exit', (code) => { log(`g${g.g} env exit ${code}`); g.env = null; if (code === 7) g.regen = true; else if (!paused) g.fails++; });
}

async function stopServer(g) {
    if (!g.server) return;
    try { await rcon(g, 'stop'); } catch (e) { log(`g${g.g} rcon stop: ${e.message}`); }
    for (let t = 0; t < 120 && g.server; t++) await sleep(500);
    if (g.server) g.server.kill();
}

/** One pass over a group: whatever is not running is started (the environment once the server answers on RCON). */
async function tend(g) {
    if (g.regen) {
        log(`g${g.g}: site candidates used up, new world of the same seed`);
        if (g.env) g.env.kill();
        await stopServer(g);
        fs.rmSync(path.join(g.dir, 'world'), { recursive: true, force: true });
        fs.rmSync(path.join(root, 'sites', `${g.world}.json`), { force: true });
        g.regen = false;
    }
    if (!g.server) { startServer(g); return; }
    if (!g.env && await portOpen(g.rport)) {
        await sleep(Math.min(300000, 5000 * 2 ** Math.min(g.fails, 6)));   // back-off after failures
        if (!stopping() && g.server && !g.env) startEnv(g);
    }
}

// The learner (one process for every group on both machines; resumes from <root>/<base>/train/checkpoint.pkl).
const learner = { proc: null, fails: 0, next: 0 };
const wslPath = (p) => p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
const gpuCfg = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'gpu.json'), 'utf8')); } catch { return null; } };
const learnerArgs = (dpod, rootDir) => [path.join(dpod, 'scripts', 'botsystem_goal_ppo.py'), '--root', rootDir, '--base', cfg.base,
    '--learn', String(cfg.learn), '--seed', '42', '--population', '1', ...(cfg.learner_args || [])];
function tendLearner() {
    if (!cfg.learner || learner.proc || Date.now() < learner.next) return;
    const gpu = gpuCfg();
    if (gpu && gpu.distro && gpu.python) {
        const j = (...x) => x.join('/');
        learner.proc = run('learner', 'wsl.exe', ['-d', gpu.distro, '--', 'env', 'XLA_PYTHON_CLIENT_PREALLOCATE=false', 'XLA_PYTHON_CLIENT_MEM_FRACTION=0.5',
            'PYTHONDONTWRITEBYTECODE=1', gpu.python, ...learnerArgs(j(wslPath(home), 'dpod'), wslPath(root))], { cwd: home });
    } else {
        learner.proc = run('learner', path.join(home, 'venv', 'Scripts', 'python.exe'), learnerArgs(path.join(home, 'dpod'), root),
            { cwd: path.join(home, 'dpod'), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    }
    learner.proc.on('exit', (code) => { log(`learner exit ${code}`); learner.proc = null; if (!paused) { learner.fails++; learner.next = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(learner.fails, 6)); } });
}
async function stopLearner() {
    if (!learner.proc) return;
    const gpu = gpuCfg();
    if (gpu && gpu.distro) spawnSync('wsl.exe', ['-d', gpu.distro, '--', 'pkill', '-TERM', '-f', 'botsystem_goal_ppo.py']);
    else learner.proc.kill();
    for (let t = 0; t < 120 && learner.proc; t++) await sleep(500);
    if (learner.proc) { spawnSync('taskkill', ['/T', '/F', '/PID', String(learner.proc.pid)]); }
}

async function pauseAll() {
    paused = true;
    log(`quiet hours (${QUIET.from}-${QUIET.to} JST) or PAUSE: stopping everything`);
    await stopLearner();
    for (const g of groups) if (g.env) g.env.kill();
    await Promise.all(groups.map(stopServer));
}

async function main() {
    fs.writeFileSync(path.join(home, 'supervisor.pid'), String(process.pid));
    log(`supervisor up: ${cfg.groups} groups x ${cfg.bots} bots, base ${cfg.base}, shards ${cfg.shard0}..${cfg.shard0 + cfg.groups - 1}, speed ${cfg.speed}`);
    const busy = new Set();
    while (!stopping()) {
        if (quiet()) {
            if (!paused) await pauseAll();
            fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify({ t: Date.now(), paused: true, groups: [], learner: null }));
            await sleep(5000);
            continue;
        }
        if (paused) { paused = false; log('quiet hours over: resuming'); for (const g of groups) g.fails = 0; learner.fails = 0; learner.next = 0; }
        for (const g of groups) {
            if (busy.has(g)) continue;
            busy.add(g);
            tend(g).catch((e) => log(`g${g.g}: ${e.message}`)).finally(() => busy.delete(g));
        }
        tendLearner();
        fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify({ t: Date.now(), groups: groups.map((g) => ({ g: g.g, shard: g.shard,
            server: g.server ? g.server.pid : null, env: g.env ? g.env.pid : null, fails: g.fails })), learner: learner.proc ? learner.proc.pid : null }));
        for (const g of groups) if (g.env && g.fails) g.fails = Math.max(0, g.fails - 0.01);   // decays while running
        await sleep(2000);
    }
    log('STOP: stopping environments and servers');
    for (const g of groups) if (g.env) g.env.kill();
    await stopLearner();   // its checkpoint is written after every update
    await Promise.all(groups.map(stopServer));
    fs.rmSync(path.join(home, 'supervisor.pid'), { force: true });
    log('supervisor down');
}

main().catch((e) => { log(`fatal: ${e.stack}`); process.exit(1); });

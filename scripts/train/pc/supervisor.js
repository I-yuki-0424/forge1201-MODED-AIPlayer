'use strict';
// Training groups on the owner's PC (owner 2026-11-02: bots from 11 on use the PC). One Forge server (127.0.0.1 only) and one
// environment process (src/rl/run_skill_env.js) per group, kept running the way the VPS containers are (restart on exit, with
// back-off); the learner on the VPS reaches the environments through scripts/train/pc/relay.js. Started detached by
// scripts/train/pc.sh; stops when <home>/STOP exists. Node 20 (portable, <home>/node), Java 17 from PATH.
//   node supervisor.js <home>       config: <home>/config.json (written by pc.sh), RCON password: <home>/rcon.txt
// A group whose site candidates are used up (environment exit code 7) gets a new world of the same seed: the server is stopped,
// its world and the world's used-site record are deleted, and both start again (owner: regenerate only when the list runs out).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

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

const groups = Array.from({ length: cfg.groups }, (_, g) => ({
    g, shard: cfg.shard0 + g, dir: path.join(home, 'servers', `g${g}`), port: 25600 + g, rport: 25700 + g, world: `pc-s${cfg.shard0 + g}`,
    server: null, env: null, fails: 0, regen: false,
}));

function run(name, cmd, args, opts) {
    const out = fs.openSync(path.join(logs, `${name}.log`), 'a');
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out], windowsHide: true });
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
    g.env.on('exit', (code) => { log(`g${g.g} env exit ${code}`); g.env = null; if (code === 7) g.regen = true; else g.fails++; });
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

async function main() {
    fs.writeFileSync(path.join(home, 'supervisor.pid'), String(process.pid));
    log(`supervisor up: ${cfg.groups} groups x ${cfg.bots} bots, base ${cfg.base}, shards ${cfg.shard0}..${cfg.shard0 + cfg.groups - 1}, speed ${cfg.speed}`);
    const busy = new Set();
    while (!stopping()) {
        for (const g of groups) {
            if (busy.has(g)) continue;
            busy.add(g);
            tend(g).catch((e) => log(`g${g.g}: ${e.message}`)).finally(() => busy.delete(g));
        }
        fs.writeFileSync(path.join(home, 'status.json'), JSON.stringify({ t: Date.now(), groups: groups.map((g) => ({ g: g.g, shard: g.shard,
            server: g.server ? g.server.pid : null, env: g.env ? g.env.pid : null, fails: g.fails })) }));
        for (const g of groups) if (g.env && g.fails) g.fails = Math.max(0, g.fails - 0.01);   // decays while running
        await sleep(2000);
    }
    log('STOP: stopping environments and servers');
    for (const g of groups) if (g.env) g.env.kill();
    await Promise.all(groups.map(stopServer));
    fs.rmSync(path.join(home, 'supervisor.pid'), { force: true });
    log('supervisor down');
}

main().catch((e) => { log(`fatal: ${e.stack}`); process.exit(1); });

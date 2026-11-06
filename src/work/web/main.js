'use strict';
// Starts the console from the environment (docs/implemented/WORK-CONSOLE-v1.md): service, token, Cloudflare Access, listener.
const fs = require('fs');
const path = require('path');
const { WorkService } = require('../service');
const { Access } = require('./access');
const { createConsole } = require('./server');
const { loadToken } = require('./http');

/** Table of the bots' registry -> (name) -> bool, from BOT_MOD_TABLE (the same file the handshake uses). */
function knownFromTable(file) {
    try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8')), set = new Set(t.blocks.map((b) => b.name));
        return (n) => set.has(n.includes(':') ? n : `minecraft:${n}`);
    } catch (_) { return null; }
}

async function main() {
    const env = process.env, dataDir = path.resolve(env.WORK_DATA || path.join(__dirname, '..', '..', '..', 'data', 'work'));
    const table = env.BOT_MOD_TABLE || path.join(__dirname, '..', '..', '..', 'modpack', 'forgeaip-create.registry.json');
    let kit; try { kit = env.WORK_KIT ? JSON.parse(env.WORK_KIT) : undefined; } catch (_) { console.error('WORK_KIT is not JSON; default kit used'); }
    const service = new WorkService({
        dataDir, worldDir: env.WORK_WORLD || null, host: env.MC_HOST || 'localhost', port: Number(env.MC_PORT) || 25565, known: knownFromTable(table), kit,
        maxBots: Number(env.WORK_MAX_BOTS) || 24,
        rcon: env.RCON_PASSWORD ? { host: env.RCON_HOST || env.MC_HOST || 'localhost', port: Number(env.RCON_PORT) || 25575, password: env.RCON_PASSWORD } : null,
    });
    const tokenFile = env.WORK_TOKEN_FILE || path.join(dataDir, 'console.token');
    const token = loadToken(tokenFile);
    await service.restore();
    const access = env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD ? new Access({ team: env.CF_ACCESS_TEAM, aud: env.CF_ACCESS_AUD, emails: (env.WORK_ALLOWED_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean) }) : null;
    if (env.WORK_PUBLIC_HOST && !access) { console.error('WORK_PUBLIC_HOST needs CF_ACCESS_TEAM and CF_ACCESS_AUD: refusing to serve the public name without Access'); process.exit(1); }
    const { server } = createConsole({ service, token, access, publicHost: env.WORK_PUBLIC_HOST || null, allowedHosts: (env.WORK_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) });
    const bind = env.WORK_BIND || '127.0.0.1', port = Number(env.WORK_PORT) || 3020;
    server.listen(port, bind, () => console.log(`[console] http://${bind}:${port}  server ${service.o.host}:${service.o.port}  table ${service.known ? table : 'none (vanilla names only)'}  rcon ${service.o.rcon ? 'on' : 'off'}  token file ${tokenFile}`));
    const down = async () => { server.close(); await service.stop(); process.exit(0); };
    process.on('SIGTERM', down); process.on('SIGINT', down);
}

module.exports = { main, knownFromTable };

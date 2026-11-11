'use strict';
// Shared code of the REAL-WORLD verification (docs/implemented/REAL-WORLD-VERIFICATION-v1.md). Test code.
// Standard (owner 2026-11-11): a number about movement, escape or mining counts only when it was measured on a disposable COPY of the owner's play world
// (real seed, natural terrain, the same mods; /mnt/data/forgeaip-play/real, 127.0.0.1:25572) and graded from the SERVER's state. A world the simulator or a script built
// with /fill is a smoke test, never evidence.
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

/** Wilson 95 % interval of k successes in n trials. */
function wilson(k, n, z = 1.96) {
    if (!n) return [0, 1];
    const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
const pct = (k, n) => (n ? `${(100 * k / n).toFixed(0)} % (${k}/${n}, Wilson 95 % [${wilson(k, n).map((v) => (100 * v).toFixed(0)).join(', ')}])` : 'n/a');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Connect RCON (one queue) and the Server helper. */
async function connectRcon() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'real', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    return { shared, S: new Server(shared, 'x') };
}

/** A work service with the PRODUCTION settings (experts, router, move3, pitExpert on; teleport off) and `names` bots online. */
async function openService(shared, names, settings = {}) {
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/real-live-'), host: process.env.MC_HOST || 'real', port: Number(process.env.MC_PORT) || 25565, maxBots: Math.max(4, names.length), reconnectMs: 4000, display: false, rcon: shared });
    svc.settings.autoKit = false; Object.assign(svc.settings, settings);
    for (const n of names) svc.addBot(n);
    const t0 = Date.now();
    while (!svc.status().bots.every((b) => b.state === 'online')) { if (Date.now() - t0 > 180000) throw new Error('bots did not come online'); await sleep(300); }
    await sleep(2500);
    return svc;
}

const dimId = (d) => (d === 'end' ? 'minecraft:the_end' : d === 'nether' ? 'minecraft:the_nether' : 'minecraft:overworld');

async function posOf(S, name) {
    const o = (await S.cmd(`data get entity ${name} Pos`)).replace(/\x1b\[[0-9;]*m/g, '');
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(o);
    return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

/** Put a bot somewhere in a dimension: `execute in <dim> run tp`. */
const tpIn = (S, name, dim, x, y, z) => S.must(`execute in ${dimId(dim)} run tp ${name} ${x} ${y} ${z}`);


const BAD_FLOOR = /water|lava|ice|leaves|cactus|magma|fire|powder_snow|bubble|kelp|seagrass|vine|web|campfire|berry/;
const LOOK_THROUGH = (b) => b.boundingBox === 'empty' && !/water|lava|bubble_column/.test(b.name);

/**
 * The standing cell of the column (x, z) as the bot sees it through the loaded chunks: the TOP block, plants and snow layers looked through; water, lava, ice, leaves, logs and the like make the
 * column unusable (null). The bot flies in spectator while looking: no gravity, no reflexes. The first version of this probe walked down through an ocean into a cave and graded trials that started 30
 * blocks under the surface: a harness bug, found 2026-11-11 and kept here as a warning.
 */
async function standCell(S, bot, name, dim, x, z) {
    const Vec3 = require('vec3');
    await S.must(`gamemode spectator ${name}`);
    const top = dim === 'end' ? 120 : 319, lo = dim === 'end' ? 0 : -63;
    await tpIn(S, name, dim, x + 0.5, top - 1, z + 0.5);
    for (let i = 0; i < 60; i++) {
        await sleep(250);
        if (!bot.blockAt(new Vec3(x, lo, z)) || !bot.blockAt(new Vec3(x, top - 2, z))) continue;           // chunk not there yet
        for (let y = top - 2; y >= lo; y--) {
            const b = bot.blockAt(new Vec3(x, y, z)); if (!b) return null;
            if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || LOOK_THROUGH(b)) continue;
            if (BAD_FLOOR.test(b.name) || /(_log|_wood|_leaves|_stem|_planks|_slab|_stairs|snow_block|honey|slime|glass)$/.test(b.name) || b.boundingBox !== 'block') return null;
            const h1 = bot.blockAt(new Vec3(x, y + 1, z)), h2 = bot.blockAt(new Vec3(x, y + 2, z));
            if (!h1 || !h2 || !(h1.boundingBox === 'empty' && h2.boundingBox === 'empty') || /water|lava/.test(h1.name + h2.name)) return null;
            return { x, y: y + 1, z, floor: b.name };
        }
        return null;
    }
    return null;
}

/** Is (x, y, z) a place to stand: air for the body, a full block under the feet (read through the bot's world)? */
function standableAt(bot, x, y, z) {
    const Vec3 = require('vec3'), f = bot.blockAt(new Vec3(x, y - 1, z)), a = bot.blockAt(new Vec3(x, y, z)), b = bot.blockAt(new Vec3(x, y + 1, z));
    return !!(f && a && b && f.boundingBox === 'block' && !BAD_FLOOR.test(f.name) && a.boundingBox === 'empty' && b.boundingBox === 'empty' && !/water|lava/.test(a.name + b.name));
}
module.exports = { standCell, standableAt, BAD_FLOOR, wilson, pct, rng, connectRcon, openService, posOf, tpIn, dimId, sleep, Server };

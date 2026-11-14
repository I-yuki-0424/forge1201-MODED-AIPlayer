'use strict';
// T26 test MOVE B (owner 2026-11-14): 1 bot per world starts at the deepest standable point of the cave nearest the world spawn and must get to the surface.
// Kit: full tools, 64 temporary blocks, food; Normal, no keepInventory. A trial passes when the SERVER says the bot's feet cell can see the sky (location predicate can_see_sky),
// with no server move. A death fails the trial (mobs may kill it: the owner counts 80 % as a success for this test). Starting point: test/harness only (a spectator scan of the loaded chunks).
//   scripts/t26/run.sh N move_b.js [LIMIT_MIN=20] [CONTROL=noop]
const T = require('./lib');
const Vec3 = require('vec3');
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 20), name = `Cave${T.WORLD}`;

const AIRY = (b) => !!b && (b.name === 'air' || b.name === 'cave_air');
/** The nearest real cave (a connected body of 200+ cells of air under a roof: rock between it and the sky) and its lowest standable cell, read from the bot's loaded chunks. */
function findCave(bot, c, R = 56) {
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
    const tops = new Map();
    const top = (x, z) => { const k = `${x},${z}`; if (tops.has(k)) return tops.get(k); let t = null; for (let y = 200; y >= -60; y--) { const b = at(x, y, z); if (!b) break; if (!AIRY(b) && b.boundingBox === 'block' && !/leaves|water/.test(b.name)) { t = y; break; } } tops.set(k, t); return t; };
    const roofed = (x, y, z) => { const t = top(x, z); return t !== null && y < t - 2; };
    const seen = new Set(), key = (x, y, z) => `${x},${y},${z}`;
    const cols = [];
    for (let dx = -R; dx <= R; dx += 3) for (let dz = -R; dz <= R; dz += 3) cols.push([c.x + dx, c.z + dz, Math.hypot(dx, dz)]);
    cols.sort((a, b) => a[2] - b[2]);
    for (const [x, z] of cols) {
        const t = top(x, z); if (t === null) continue;
        for (let y = t - 3; y >= -58; y--) {
            const b = at(x, y, z); if (!b) break;
            if (!AIRY(b) || seen.has(key(x, y, z))) continue;
            // a body of underground air: flood it (6-neighbour, air under a roof only), at most 20000 cells
            const q = [[x, y, z]], body = []; seen.add(key(x, y, z));
            while (q.length && body.length < 20000) {
                const [a, bb, d] = q.pop(); body.push([a, bb, d]);
                for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                    const nx = a + ox, ny = bb + oy, nz = d + oz, k = key(nx, ny, nz); if (seen.has(k)) continue;
                    if (Math.abs(nx - c.x) > R + 24 || Math.abs(nz - c.z) > R + 24) continue;
                    const n = at(nx, ny, nz); if (!n || !AIRY(n) || !roofed(nx, ny, nz)) continue;
                    seen.add(k); q.push([nx, ny, nz]);
                }
            }
            if (body.length < 200) continue;
            // the lowest cell to stand on: air for feet and head, a full block under it, no liquid beside the feet
            const stand = body.filter(([a, bb, d]) => { const f = at(a, bb - 1, d), h = at(a, bb + 1, d); return f && f.boundingBox === 'block' && !/lava|water|magma/.test(f.name) && AIRY(h); })
                .filter(([a, bb, d]) => ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oz]) => /lava|water/.test((at(a + ox, bb, d + oz) || {}).name || '')));
            if (!stand.length) continue;
            stand.sort((p, q2) => p[1] - q2[1]);
            const [sx, sy, sz] = stand[0];
            return { x: sx, y: sy, z: sz, cells: body.length, surface: top(sx, sz), depth: top(sx, sz) - sy };
        }
    }
    return null;
}

(async () => {
    const rep = T.reporter('move_b');
    const { S, svc, seed } = await T.open([name]);
    const deaths = T.countDeaths(svc, [name], S), moves = T.countMoves(svc), bot = svc.bots.get(name).bot;
    const p0 = await T.posOf(S, name), sp = { x: Math.floor(p0.x), z: Math.floor(p0.z) };
    await S.must(`gamemode spectator ${name}`); await S.must(`tp ${name} ${sp.x} 100 ${sp.z}`);
    let cave = null;
    for (let i = 0; i < 30 && !cave; i++) { await T.sleep(2000); cave = findCave(bot, sp); }
    if (!cave) { rep.trial(name, false, { why: 'harness: no cave found within 56 blocks of the spawn', spawn: sp }); rep.write({ seed }); await svc.stop(); process.exit(3); }
    await S.must(`tp ${name} ${cave.x + 0.5} ${cave.y} ${cave.z + 0.5}`);
    await S.must(`gamemode survival ${name}`);
    await T.sleep(2500);
    await T.kit(S, name);
    const start = await T.posOf(S, name);
    const skyAtStart = await T.seesSky(S, cave.x, cave.y, cave.z);
    await T.say(S, `move_b: ${name} starts in a cave at ${cave.x} ${cave.y} ${cave.z} (${cave.cells} cells of air)`);
    const r = await T.command(svc, name, process.env.CMD || 'surface', {}, LIMIT_MIN);
    const p = await T.posOf(S, name), f = p && { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) };
    const sky = !!f && await T.seesSky(S, f.x, f.y, f.z);
    if (deaths.read) await deaths.read();
    rep.trial(name, sky && deaths[name] === 0 && !moves[name] && !skyAtStart, { cave, start: start && [start.x, start.y, start.z].map(Math.round), skyAtStart, at: f, sky, deaths: deaths[name], serverMoves: moves[name] || 0, sec: r.sec, timeout: r.timeout, said: r.result });
    const k = rep.write({ seed, spawn: sp });
    await svc.stop(); process.exit(k ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

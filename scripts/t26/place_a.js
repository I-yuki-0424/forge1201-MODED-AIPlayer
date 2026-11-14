'use strict';
// T26 test PLACE A (owner 2026-11-14): 4 bots stand on a 3x3 platform 40 blocks above the ground at the world spawn; each builds a 30-block bridge, level with the platform, to the east,
// west, south or north. Kit: full tools, 64 temporary blocks (the bridge material), food; Normal, no keepInventory. A trial passes when the SERVER finds all 30 cells of the bridge solid,
// the bot is alive (no death) and not below the platform (it did not fall). Required: 100 %. The platform is test setup (setblock), the bridge is the bot's.
//   scripts/t26/run.sh N place_a.js [LEN=30] [LIMIT_MIN=15] [CONTROL=noop]
const T = require('./lib');
const LEN = Number(process.env.LEN || 30), LIMIT_MIN = Number(process.env.LIMIT_MIN || 15);
const DIRS = [['E', 1, 0], ['W', -1, 0], ['S', 0, 1], ['N', 0, -1]], names = DIRS.map(([d]) => `Br${d}${T.WORLD}`);

(async () => {
    const rep = T.reporter('place_a');
    const { S, svc, seed } = await T.open(names);
    const deaths = T.countDeaths(svc, names, S), moves = T.countMoves(svc);
    const p0 = await T.posOf(S, names[0]), c = { x: Math.floor(p0.x), z: Math.floor(p0.z) };
    await T.onSurface(S, names[0], c.x, c.z);
    const g = await T.posOf(S, names[0]), Y = Math.floor(g.y) + 40;        // the platform's top layer; the bots' feet are at Y + 1
    await S.must(`fill ${c.x - 1} ${Y} ${c.z - 1} ${c.x + 1} ${Y} ${c.z + 1} minecraft:stone`);
    for (let i = 0; i < names.length; i++) {
        const [, dx, dz] = DIRS[i];
        await S.must(`tp ${names[i]} ${c.x + dx + 0.5} ${Y + 1} ${c.z + dz + 0.5}`);
        await T.kit(S, names[i]);
    }
    await T.sleep(3000);
    await T.say(S, `place_a: 4 bots bridge ${LEN} blocks E/W/S/N from the platform at ${c.x} ${Y} ${c.z}`);
    await Promise.all(names.map((n, i) => (async () => {
        const [d, dx, dz] = DIRS[i], e = { x: c.x + dx * (1 + LEN), z: c.z + dz * (1 + LEN) };       // the last bridge cell
        const r = process.env.CMD === 'bridge' ? await T.command(svc, n, 'bridge', { x: e.x + dx, y: Y + 1, z: e.z + dz, job: 'none' }, LIMIT_MIN)
            : await T.command(svc, n, 'build_bridge', { dir: { E: 'east', W: 'west', S: 'south', N: 'north' }[d], length: LEN }, LIMIT_MIN);
        let solid = 0; const gaps = [];
        for (let k = 2; k <= 1 + LEN; k++) { const x = c.x + dx * k, z = c.z + dz * k; if (/^Test passed/.test(T.strip(await S.cmd(`execute unless block ${x} ${Y} ${z} minecraft:air`)))) solid++; else gaps.push(k - 1); }
        const p = await T.posOf(S, n);
        const fell = !p || p.y < Y - 1;
        if (deaths.read) await deaths.read();
        rep.trial(n, solid === LEN && deaths[n] === 0 && !fell && !moves[n], { dir: d, solid, of: LEN, gaps: gaps.slice(0, 10), at: p && [p.x, p.y, p.z].map(Math.round), fell, deaths: deaths[n], sec: r.sec, timeout: r.timeout, said: r.result });
    })()));
    const k = rep.write({ seed, platform: { ...c, y: Y } });
    await svc.stop(); process.exit(k === names.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

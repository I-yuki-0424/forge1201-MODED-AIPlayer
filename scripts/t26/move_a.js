'use strict';
// T26 test MOVE A (owner 2026-11-14): 4 bots per world, each sent 2000 blocks east, west, south or north of the world spawn. Kit: full tools, 64 temporary blocks, food; Normal, no keepInventory.
// A trial passes when the SERVER has the bot within 4 blocks (across) of its target, alive (no death on the way) and no server move. Required: 100 %.
//   scripts/t26/run.sh N move_a.js [DIST=2000] [LIMIT_MIN=90] [CONTROL=noop]
const T = require('./lib');
const DIST = Number(process.env.DIST || 2000), LIMIT_MIN = Number(process.env.LIMIT_MIN || 90);
const DIRS = [['E', 1, 0], ['W', -1, 0], ['S', 0, 1], ['N', 0, -1]], names = DIRS.map(([d]) => `Mv${d}${T.WORLD}`);

(async () => {
    const rep = T.reporter('move_a');
    const { S, svc, seed } = await T.open(names);
    const deaths = T.countDeaths(svc, names, S), moves = T.countMoves(svc);
    const p0 = await T.posOf(S, names[0]), sp = { x: Math.floor(p0.x), z: Math.floor(p0.z) };
    for (const n of names) { await T.onSurface(S, n, sp.x, sp.z); await T.kit(S, n); }
    await T.sleep(3000);
    await T.say(S, `move_a: 4 bots, ${DIST} blocks E/W/S/N of ${sp.x} ${sp.z}`);
    const runs = DIRS.map(([d, dx, dz], i) => (async () => {
        const n = names[i], t = { x: sp.x + dx * DIST, z: sp.z + dz * DIST };
        const r = await T.command(svc, n, 'journey', t, LIMIT_MIN);
        const p = await T.posOf(S, n), off = p ? Math.round(Math.hypot(p.x - t.x - 0.5, p.z - t.z - 0.5)) : null;
        if (deaths.read) await deaths.read();
        rep.trial(n, off !== null && off <= 4 && deaths[n] === 0 && !moves[n], { dir: d, target: t, at: p && [p.x, p.y, p.z].map(Math.round), off, deaths: deaths[n], serverMoves: moves[n] || 0, sec: r.sec, timeout: r.timeout, said: r.result });
    })());
    await Promise.all(runs);
    const k = rep.write({ seed, spawn: sp, dist: DIST });
    await svc.stop(); process.exit(k === names.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

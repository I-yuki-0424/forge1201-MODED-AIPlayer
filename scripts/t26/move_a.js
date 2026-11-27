'use strict';
// T26 test MOVE A (owner 2026-11-14): 4 bots per world, each sent 2000 blocks east, west, south or north of the world spawn. Kit: full tools, 64 temporary blocks, food; Normal, no keepInventory.
// A trial passes when the SERVER has the bot within 4 blocks (across) of its target, alive (no death on the way) and no server move. Required: 100 %.
//   scripts/t26/run.sh N move_a.js [DIST=2000] [LIMIT_MIN=90] [CONTROL=noop]
const T = require('./lib');
const DIST = Number(process.env.DIST || 2000), LIMIT_MIN = Number(process.env.LIMIT_MIN || 90);
const DIRS = [['E', 1, 0], ['W', -1, 0], ['S', 0, 1], ['N', 0, -1]], names = DIRS.map(([d]) => `Mv${d}${T.WORLD}`);

(async () => {
    const rep = T.reporter('move_a');
    const { S, svc, seed } = await T.open(names, {}, 'normal');
    const deaths = T.countDeaths(svc, names, S), moves = T.countMoves(svc);
    const p0 = await T.posOf(S, names[0]), sp = { x: Math.floor(p0.x), z: Math.floor(p0.z) };
    for (const n of names) { await T.onSurface(S, n, sp.x, sp.z); await T.kit(S, n); }
    await T.sleep(3000);
    // The cells that turned into a temporary-block kind during the run, as each bot's world saw them change (a block update, never a chunk load): the end scan counts only these.
    // Pumpkins grow wild: ma075s (seed 7601, 97ac3537) counted 10 'left' at x 663-675 y 67, and the same 10 cells are pumpkins in the untouched world (scan.js on a new world of that seed).
    const TB0 = require('../../src/work/bot/tempblocks'), kinds = new Set(TB0.only()), placed = new Set();
    for (const n of names) svc.bots.get(n).bot.on('blockUpdate', (o, b) => { if (b && kinds.has(b.name) && (!o || o.name !== b.name)) placed.add(`${b.position.x},${b.position.y},${b.position.z}`); });
    await T.say(S, `move_a: 4 bots, ${DIST} blocks E/W/S/N of ${sp.x} ${sp.z}`);
    const runs = DIRS.map(([d, dx, dz], i) => (async () => {
        const n = names[i], t = { x: sp.x + dx * DIST, z: sp.z + dz * DIST };
        const r = await T.command(svc, n, 'journey', t, LIMIT_MIN);
        const p = await T.posOf(S, n), off = p ? Math.round(Math.hypot(p.x - t.x - 0.5, p.z - t.z - 0.5)) : null;
        // temporary blocks (pumpkins) the walk left: around where it ended (+-24) by a scan, along the way by the registry (TASK-20261125-075: none may be left)
        const TB = require('../../src/work/bot/tempblocks'), q = p || t, area = { x0: Math.floor(q.x) - 24, x1: Math.floor(q.x) + 24, z0: Math.floor(q.z) - 24, z1: Math.floor(q.z) + 24, y0: Math.floor(q.y || 64) - 16, y1: Math.floor(q.y || 64) + 24 };
        const scan = TB.scanBox(svc.bots.get(n).bot, area), wild = !kinds.size ? [] : scan.cells.filter((c) => !placed.has(`${c.x},${c.y},${c.z}`)), tempScan = kinds.size ? { ...scan, cells: scan.cells.filter((c) => placed.has(`${c.x},${c.y},${c.z}`)) } : scan, tempsRegistered = svc.temps.list((r0) => r0.by === n).length;
        if (deaths.read) await deaths.read();
        rep.trial(n, off !== null && off <= 4 && deaths[n] === 0 && !moves[n], { tempScanLeft: tempScan.cells.length, wildTempKinds: wild.length, tempScanCells: tempScan.cells.slice(0, 20), tempsRegistered, dir: d, target: t, at: p && [p.x, p.y, p.z].map(Math.round), off, deaths: deaths[n], serverMoves: moves[n] || 0, sec: r.sec, timeout: r.timeout, said: r.result });
    })());
    await Promise.all(runs);
    const k = rep.write({ seed, spawn: sp, dist: DIST });
    await svc.stop(); process.exit(k === names.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

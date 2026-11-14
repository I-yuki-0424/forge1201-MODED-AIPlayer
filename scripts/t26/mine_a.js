'use strict';
// T26 test MINE A (owner 2026-11-14): 4 bots per world, each starting 2000 blocks from the others (the corners of a 2000-block square at the spawn), each collects in this order
// 8 or more of: any log, cobblestone, coal, raw iron, raw gold. Kit: full tools, 64 temporary blocks, food; Normal, no keepInventory.
// A trial (one bot) passes when the SERVER counts >= 8 of each of the five in its pack at the end, no server move. Required: 90 %.
//   scripts/t26/run.sh N mine_a.js [LIMIT_MIN=60 per item] [CONTROL=noop]
const T = require('./lib');
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 60), N_EACH = Number(process.env.EACH || 8);
const GOALS = [['wood', '#minecraft:logs'], ['cobblestone', 'cobblestone'], ['coal', 'coal'], ['raw_iron', 'raw_iron'], ['raw_gold', 'raw_gold']];
const CORNERS = [[0, 0], [2000, 0], [0, 2000], [2000, 2000]], names = CORNERS.map((_, i) => `Mn${i + 1}w${T.WORLD}`);

(async () => {
    const rep = T.reporter('mine_a');
    const { S, svc, seed } = await T.open(names);
    const deaths = T.countDeaths(svc, names, S), moves = T.countMoves(svc);
    const p0 = await T.posOf(S, names[0]), sp = { x: Math.floor(p0.x), z: Math.floor(p0.z) };
    const starts = [];
    for (let i = 0; i < names.length; i++) { const s = await T.onSurface(S, names[i], sp.x + CORNERS[i][0], sp.z + CORNERS[i][1]); starts.push(s.at); await T.kit(S, names[i]); }
    await T.sleep(4000);
    await T.say(S, `mine_a: 4 bots 2000 blocks apart collect ${N_EACH} each of log, cobblestone, coal, raw iron, raw gold`);
    await Promise.all(names.map((n, i) => (async () => {
        const steps = [];
        for (const [item, count] of GOALS) {
            const r = await T.command(svc, n, 'obtain', { item, count: N_EACH }, LIMIT_MIN);
            steps.push({ item, ok: r.result && r.result.ok, reason: r.result && r.result.reason, why: r.result && r.result.detail && String(r.result.detail.why || '').slice(0, 120), sec: r.sec, timeout: r.timeout });
            if (T.CONTROL) continue;
        }
        const have = {}; for (const [item, id] of GOALS) have[item] = await T.holds(S, n, id);
        const ok = GOALS.every(([item]) => have[item] >= N_EACH) && !moves[n];
        if (deaths.read) await deaths.read();
        rep.trial(n, ok, { start: starts[i] && [starts[i].x, starts[i].y, starts[i].z].map(Math.round), have, deaths: deaths[n], serverMoves: moves[n] || 0, steps });
    })()));
    const k = rep.write({ seed, spawn: sp });
    await svc.stop(); process.exit(k >= Math.ceil(0.9 * names.length) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

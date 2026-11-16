'use strict';
// T26 test PLACE B (owner 2026-11-14): 1 bot builds a structure (a 7 x 7 cottage: cobblestone floor, oak plank walls with a doorway and glass windows, an oak plank roof) on a site
// beside the world spawn. Kit: full tools, 64 temporary blocks, food, and exactly the materials of the structure. After the bot reports completion the SERVER compares the site with a
// reference copy placed by command in the sky (`execute if blocks <site> <reference> all`: every cell, air included): that is the owner's "replace with the structure and nothing changes".
// The site is cleared to air above a stone floor first (test setup); the control: the empty site must NOT match. Required: 100 %.
//   scripts/t26/run.sh N place_b.js [LIMIT_MIN=30] [CONTROL=noop]
const T = require('./lib');
const bp = require('../../src/work/jobs/blueprint');
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 30), name = `Bld${T.WORLD}`;

/** The cottage: cells relative to its origin (x, z 0..6, y 0..4). */
function cottage() {
    const cells = [];
    for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) cells.push({ x, y: 0, z, block: 'cobblestone' });
    for (let y = 1; y <= 3; y++) for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) {
        if (x !== 0 && x !== 6 && z !== 0 && z !== 6) continue;
        if (x === 3 && z === 0 && y <= 2) continue;                                            // the doorway
        const win = y === 2 && ((z === 6 && (x === 2 || x === 4)) || ((x === 0 || x === 6) && z === 3));
        cells.push({ x, y, z, block: win ? 'glass' : 'oak_planks' });
    }
    for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) cells.push({ x, y: 4, z, block: 'oak_planks' });
    return cells;
}

(async () => {
    const rep = T.reporter('place_b');
    const { S, svc, seed } = await T.open([name]);
    const deaths = T.countDeaths(svc, [name], S), moves = T.countMoves(svc);
    const p0 = await T.posOf(S, name);
    await T.onSurface(S, name, Math.floor(p0.x), Math.floor(p0.z));
    const g = await T.posOf(S, name), gy = Math.floor(g.y);
    const o = { x: Math.floor(g.x) + 4, y: gy, z: Math.floor(g.z) - 3 };                      // the structure's origin (its floor layer at the bot's feet level)
    const X1 = o.x + 6, Y1 = o.y + 4, Z1 = o.z + 6;
    // the site: air from the floor layer up, stone under it, two cells of margin
    await S.must(`fill ${o.x - 2} ${o.y} ${o.z - 2} ${X1 + 2} ${Y1 + 4} ${Z1 + 2} minecraft:air`);
    await S.must(`fill ${o.x - 2} ${o.y - 1} ${o.z - 2} ${X1 + 2} ${o.y - 1} ${Z1 + 2} minecraft:stone`);
    // a foundation under the pad: on a slope the cleared site floated over a cliff (pb-d, seed -6411205641318655142: a 40-block fall and a death with the materials); air and water under it become stone
    await S.must(`fill ${o.x - 2} ${o.y - 14} ${o.z - 2} ${X1 + 2} ${o.y - 2} ${Z1 + 2} minecraft:stone replace minecraft:air`);
    await S.must(`fill ${o.x - 2} ${o.y - 14} ${o.z - 2} ${X1 + 2} ${o.y - 2} ${Z1 + 2} minecraft:stone replace minecraft:water`);
    // the reference copy in the sky (air around it)
    const ref = { x: o.x, y: 230, z: o.z };
    await S.must(`fill ${ref.x} ${ref.y} ${ref.z} ${ref.x + 6} ${ref.y + 4} ${ref.z + 6} minecraft:air`);
    const cells = cottage();
    for (const q of cells) await S.must(`setblock ${ref.x + q.x} ${ref.y + q.y} ${ref.z + q.z} minecraft:${q.block}`);
    const match = async () => /^Test passed/.test(T.strip(await S.cmd(`execute if blocks ${o.x} ${o.y} ${o.z} ${X1} ${Y1} ${Z1} ${ref.x} ${ref.y} ${ref.z} all`)));
    const controlOk = !(await match());
    await S.must(`tp ${name} ${o.x - 1.5} ${o.y} ${o.z + 3.5}`);
    await T.kit(S, name);
    const need = {}; for (const q of cells) need[q.block] = (need[q.block] || 0) + 1;
    for (const [b, n] of Object.entries(need)) for (let k = n; k > 0; k -= 64) await S.must(`give ${name} minecraft:${b} ${Math.min(64, k)}`);
    await T.sleep(2500);
    await T.say(S, `place_b: ${name} builds a 7x7 cottage at ${o.x} ${o.y} ${o.z} (${cells.length} blocks)`);
    const t0 = Date.now(); let state = 'control';
    if (!T.CONTROL) {
        const job = await svc._buildFrom(bp.fromCells(cells), o, { name: 'cottage', bots: [name], start: true }, null, { dim: 'overworld' });
        while (Date.now() - t0 < LIMIT_MIN * 60000) { const j = svc.jobs.get(job.id); if (!j || j.state === 'finished' || j.state === 'cancelled') { state = j ? j.state : 'gone'; break; } await T.sleep(2000); }
        if (state === 'control') state = 'timeout';
    }
    await T.sleep(2000);
    const ok = await match();
    let wrong = [];
    if (!ok) for (const q of cells) { if (wrong.length >= 15) break; if (!/^Test passed/.test(T.strip(await S.cmd(`execute if block ${o.x + q.x} ${o.y + q.y} ${o.z + q.z} minecraft:${q.block}`)))) wrong.push([q.x, q.y, q.z, q.block]); }
    // the air cells of the box too (a block left inside the house fails the comparison as much as a missing wall)
    if (!ok) { const set = new Set(cells.map((q) => `${q.x},${q.y},${q.z}`)); for (let x = 0; x <= 6; x++) for (let y = 0; y <= 4; y++) for (let z = 0; z <= 6; z++) { if (set.has(`${x},${y},${z}`) || wrong.length >= 20) continue; if (!/^Test passed/.test(T.strip(await S.cmd(`execute if block ${o.x + x} ${o.y + y} ${o.z + z} minecraft:air`)))) wrong.push([x, y, z, 'air']); } }
    if (deaths.read) await deaths.read();
    rep.trial(name, controlOk && ok && state === 'finished' && deaths[name] === 0 && !moves[name], { problems: (svc.problems && svc.problems.list || []).slice(-12).map((q) => JSON.stringify(q).slice(0, 380)), origin: o, controlOk, state, match: ok, wrongCells: wrong, min: Math.round((Date.now() - t0) / 60000), deaths: deaths[name], serverMoves: moves[name] || 0 });
    const k = rep.write({ seed });
    await svc.stop(); process.exit(k ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

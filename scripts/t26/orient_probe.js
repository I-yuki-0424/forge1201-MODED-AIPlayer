'use strict';
// Probe (test code, TASK-20261121-071): does the placement model of orient.js give the facing it promises? For each block and each wanted facing the planner's FIRST recipe is carried out by a bot against a
// stone block, and the SERVER says which facing the block got. Prints one line per (block, wanted) that differs, and a table of what a recipe's look gave.
//   scripts/t26/run.sh 9 orient_probe.js [BLOCKS=observer,piston,...]
const T = require('./lib'), O = require('../../src/work/jobs/orient');
const name = `Op${T.WORLD}`, sleep = T.sleep, DIRS = ['north', 'south', 'east', 'west', 'up', 'down'];
const BLOCKS = (process.env.BLOCKS || 'observer,piston,sticky_piston,dropper,dispenser,hopper,chest,repeater,comparator').split(',');
(async () => {
    const { S, svc } = await T.open([name]);
    const X = 3500, Y = 200, Z = 3500;
    await S.must(`forceload add ${X - 8} ${Z - 8} ${X + 24} ${Z + 40}`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 24} ${Y + 8} ${Z + 40} minecraft:air`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 24} ${Y - 1} ${Z + 40} minecraft:stone`);
    await S.must(`tp ${name} ${X - 2.5} ${Y} ${Z + 0.5}`); await T.kit(S, name);
    for (const b of BLOCKS) await S.must(`give ${name} minecraft:${b} 64`);
    await sleep(3000);
    const facingOf = async (block, x, y, z) => { for (const d of DIRS) if (/^Test passed/.test(T.strip(await S.cmd(`execute if block ${x} ${y} ${z} minecraft:${block}[facing=${d}]`)))) return d; return /^Test passed/.test(T.strip(await S.cmd(`execute if block ${x} ${y} ${z} minecraft:air`))) ? 'air' : '?'; };
    let row = 0; const bad = [], good = [];
    for (const block of BLOCKS) for (const want of DIRS) {
        const props = { facing: want }, recs = O.recipes(block, props, () => true), r = recs[0];
        if (!r) { console.log(`${block} ${want}: the model has no recipe`); continue; }
        const x = X + 3 * (row % 6), z = Z + 3 * Math.floor(row / 6) + 2, y = Y + 1; row++;
        const D = O.DIR[r.support]; await S.must(`setblock ${x + D[0]} ${y + D[1]} ${z + D[2]} minecraft:stone`);
        await svc.runCommand({ bots: [name], command: 'place', args: { x, y, z, item: block, recipe: { support: r.support, face: r.face, hy: r.hy, yRot: r.yRot, pitch: r.pitch } } });
        const rec = svc.bots.get(name); for (let i = 0; i < 100 && rec.cmd && rec.cmd.status === 'running'; i++) await sleep(300);
        const got = await facingOf(block, x, y, z), res = rec.cmd && rec.cmd.result, line = `${block} wanted ${want}: recipe look yRot ${r.yRot} pitch ${r.pitch} clicked ${r.clicked} -> got ${got}${res && !res.ok ? ' (' + res.reason + ')' : ''}`;
        (got === want ? good : bad).push(line);
        await S.cmd(`fill ${x - 1} ${y - 1} ${z - 1} ${x + 1} ${y + 1} ${z + 1} minecraft:air`); await S.cmd(`tp ${name} ${X - 2.5} ${Y} ${Z + 0.5}`); await sleep(400);
    }
    console.log(`[orient] ${good.length} as the model says, ${bad.length} differ`); for (const l of bad) console.log('  WRONG ' + l);
    for (const l of good.slice(0, 12)) console.log('  ok    ' + l);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

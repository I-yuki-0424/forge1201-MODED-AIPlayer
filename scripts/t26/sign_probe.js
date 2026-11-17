'use strict';
// Probe (test code): can a wall sign end up hanging on another wall sign in survival (the owner's iron farm has 6 of them)? A bot places signs by recipe against a temporary solid
// block and the block is then broken by the bot. Prints what the SERVER holds after each step.
const T = require('./lib'), O = require('../../src/work/jobs/orient');
const name = `Sg${T.WORLD}`, sleep = T.sleep;
(async () => {
    const { S, svc } = await T.open([name]);
    const at = (x, y, z) => T.strip(S.cmd ? '' : '');
    const state = async (x, y, z) => { for (const b of ['oak_wall_sign', 'stone', 'glass', 'air']) if (/^Test passed/.test(T.strip(await S.cmd(`execute if block ${x} ${y} ${z} minecraft:${b}`)))) return b; return '?'; };
    const X = 10, Y = 200, Z = 10;
    await S.must(`forceload add ${X - 8} ${Z - 8} ${X + 8} ${Z + 8}`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y + 6} ${Z + 6} minecraft:air`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`);
    await S.must(`tp ${name} ${X + 3.5} ${Y} ${Z + 4.5}`); await T.kit(S, name); await S.must(`give ${name} minecraft:oak_sign 8`); await sleep(3000);
    const run = async (x, y, z, item, block, props) => {
        const sol = (d) => { const v = O.DIR[d]; return true; };
        const r = O.recipes(block, props, (d) => d === O.OPP[props.facing]).filter((q) => q.name === block)[0]; console.log('recipe', JSON.stringify(r));
        const res = await svc.runCommand({ bots: [name], command: 'place', args: { x, y, z, item, block, recipe: { support: r.support, face: r.face, hy: r.hy, yRot: r.yRot, pitch: r.pitch } } });
        const rec = svc.bots.get(name); while (rec.cmd && rec.cmd.status === 'running') await sleep(300);
        return rec.cmd && rec.cmd.result;
    };
    const dbg = async (x, y, z) => console.log('  block:', T.strip(await S.cmd(`data get block ${x} ${y} ${z}`)).slice(0, 140), '| rot:', T.strip(await S.cmd(`data get entity ${name} Rotation`)).slice(-30), '| below:', await state(x, y - 1, z));
    const log = []; const L = async (m) => { const s = `${m}: z${Z + 1}=${await state(X, Y, Z + 1)} z${Z + 2}=${await state(X, Y, Z + 2)}`; console.log(s); log.push(s); };
    await S.must(`setblock ${X} ${Y} ${Z} minecraft:glass`);
    let r = await run(X, Y, Z + 1, 'oak_sign', 'oak_wall_sign', { facing: 'south' }); console.log('sign1', JSON.stringify(r).slice(0, 300)); await dbg(X, Y, Z + 1); await L('after sign1 on glass');
    // try placing sign2 directly against sign1 (what the owner's blueprint needs)
    r = await run(X, Y, Z + 2, 'oak_sign', 'oak_wall_sign', { facing: 'south' }); console.log('sign2 on sign1', JSON.stringify(r).slice(0, 240)); await L('after sign2 on sign1 (direct)');
    // with a temporary solid block in place of sign1
    await S.must(`setblock ${X} ${Y} ${Z + 1} minecraft:stone replace`);
    r = await run(X, Y, Z + 2, 'oak_sign', 'oak_wall_sign', { facing: 'south' }); console.log('sign2 on temp stone', JSON.stringify(r).slice(0, 200)); await L('sign2 on stone');
    const rec = svc.bots.get(name);
    const m = await svc.runCommand({ bots: [name], command: 'mine', args: { x: X, y: Y, z: Z + 1 } }); while (rec.cmd && rec.cmd.status === 'running') await sleep(300);
    await sleep(1500); await L('after the bot broke the stone');
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// Probe (test code, 2026-11-19): which facing does the SERVER give a fence gate placed by the recipe model for each wanted facing? (live runs: "no placement recipe gave the wanted state", 4 tries of 20 s each)
const T = require('./lib'), O = require('../../src/work/jobs/orient');
const name = `Gt${T.WORLD}`, sleep = T.sleep;
(async () => {
    const { S, svc } = await T.open([name]);
    const X = 10, Y = 200, Z = 10;
    await S.must(`forceload add ${X - 8} ${Z - 8} ${X + 12} ${Z + 8}`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 12} ${Y + 6} ${Z + 6} minecraft:air`);
    await S.must(`fill ${X - 6} ${Y - 1} ${Z - 6} ${X + 12} ${Y - 1} ${Z + 6} minecraft:stone`);
    await S.must(`tp ${name} ${X + 3.5} ${Y} ${Z + 4.5}`); await T.kit(S, name); await S.must(`give ${name} minecraft:spruce_fence_gate 16`); await sleep(3000);
    const rec = svc.bots.get(name), facings = ['north', 'south', 'east', 'west'];
    const read = async (x, y, z) => { for (const f of facings) for (const o of ['true', 'false']) if (/^Test passed/.test(T.strip(await S.cmd(`execute if block ${x} ${y} ${z} minecraft:spruce_fence_gate[facing=${f},open=${o}]`)))) return `${f}/open=${o}`; return 'none'; };
    for (const [i, want] of facings.entries()) {
        const x = X + 2 * i, z = Z;
        const rs = O.recipes('spruce_fence_gate', { facing: want, open: 'false', in_wall: 'false', powered: 'false' }, (d) => d === 'down');
        const r = rs[0]; console.log(`want ${want}: ${rs.length} recipes, first ${JSON.stringify(r)}`);
        if (!r) continue;
        await svc.runCommand({ bots: [name], command: 'place', args: { x, y: Y, z, item: 'spruce_fence_gate', recipe: { support: r.support, face: r.face, hy: r.hy, yRot: r.yRot, pitch: r.pitch } } });
        while (rec.cmd && rec.cmd.status === 'running') await sleep(300);
        await sleep(600);
        console.log(`  placed: ${JSON.stringify(rec.cmd && rec.cmd.result && (rec.cmd.result.ok !== undefined ? { ok: rec.cmd.result.ok, reason: rec.cmd.result.reason } : rec.cmd.result)).slice(0, 120)} -> the server holds ${await read(x, Y, z)} (wanted ${want}); bot rotation ${T.strip(await S.cmd(`data get entity ${name} Rotation`)).slice(-30)}`);
    }
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

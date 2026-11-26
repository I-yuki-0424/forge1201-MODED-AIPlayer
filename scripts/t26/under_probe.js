'use strict';
// Probe (TASK-20261125-075, owner ruling 2026-11-26, OWNER-LIST-5 addendum 4): does the 1.21.1 server accept a block placed against the BOTTOM face of the block under the bot's
// feet (the cell two below the feet), as Tweakeroo does, and the dig of the block two below? One bot stands on a single block high in the air; the work layer's `descend` places a
// block against the underside of its floor and breaks the floor (moves.js, blind: the server checks the reach, not the line of sight). Graded by the server (`execute if block`).
//   scripts/t26/run.sh N under_probe.js [TRIALS=3]
const T = require('./lib');
const TRIALS = Number(process.env.TRIALS || 3), name = `Und${T.WORLD}`;
(async () => {
    const { S, svc } = await T.open([name], {}, 'peaceful');
    await T.kit(S, name, { blocks: 64 });
    const bot = svc.bots.get(name).bot, p0 = bot.entity.position.clone(), M = require('../../src/work/bot/moves');
    let pass = 0;
    for (let i = 0; i < TRIALS; i++) {
        const x = Math.floor(p0.x) + 6 + i * 4, z = Math.floor(p0.z), y = 200;
        await S.cmd(`forceload add ${x} ${z}`); await S.cmd(`fill ${x - 1} ${y - 8} ${z - 1} ${x + 1} ${y + 3} ${z + 1} air`); await S.cmd(`setblock ${x} ${y} ${z} stone`);
        await S.cmd(`tp ${name} ${x + 0.5} ${y + 1} ${z + 0.5}`); await T.sleep(2500);
        const r = await M.runMove(bot, 'descend', { levels: 1 }, { cancel: { cancelled: false } }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        await T.sleep(1500);
        const placed = /Test passed/.test(T.strip(await S.cmd(`execute if block ${x} ${y - 1} ${z} #minecraft:mineable/axe`))) || /Test passed/.test(T.strip(await S.cmd(`execute unless block ${x} ${y - 1} ${z} air`)));
        const floorGone = /Test passed/.test(T.strip(await S.cmd(`execute if block ${x} ${y} ${z} air`)));
        const at = bot.entity.position;
        const ok = placed && floorGone && Math.floor(at.y + 0.1) === y;
        if (ok) pass++;
        console.log(`[under] trial ${i}: placed under the floor ${placed}, floor dug ${floorGone}, bot at ${at.x.toFixed(1)},${at.y.toFixed(2)},${at.z.toFixed(1)} -> ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(r).slice(0, 300)}`);
    }
    console.log(`[under] ${pass}/${TRIALS}`);
    await svc.stop(); process.exit(pass === TRIALS ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

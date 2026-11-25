'use strict';
// Drives the server-side movement recordings (TASK-20261125-076; wrapper scripts/native/fake_trace.sh): per case an arena of air in the sky with the
// case's blocks, a carpet fake player standing at the start (on a barrier when the start is in the air: taken away at tick 0), and the scarpet app
// `ntrace` running the case's /player actions tick by tick while it logs the player's state. Writes /out/<RUN>/fake_meta.json (origins, programs).
const fs = require('fs');
const T = require('../t26/lib');
const { CASES, actions } = require('./fake_cases');

const only = (process.env.CASES || '').split(',').filter(Boolean);
const sleep = T.sleep;

(async () => {
    const { shared, S } = await require('../real/lib').connectRcon();
    const meta = { run: T.RUN, world: T.WORLD, version: process.env.MC_VERSION || null, cases: [] };
    const r = (c) => S.cmd(c);
    const lr = await r('script load ntrace global'); console.log('load:', T.strip(lr).slice(0, 120));
    await r('gamerule doDaylightCycle false'); await r('time set 6000'); await r('gamerule doMobSpawning false');
    let i = 0;
    for (const c of CASES) {
        if (only.length && !only.includes(c.name)) continue;
        const O = { x: 3000 + 48 * i++, y: 200, z: 3000 }, name = `Nt${T.WORLD}${String.fromCharCode(97 + (i % 26))}`;
        await r(`forceload add ${O.x - 16} ${O.z - 16} ${O.x + 16} ${O.z + 16}`);
        await r(`fill ${O.x - 9} ${O.y - 4} ${O.z - 9} ${O.x + 9} ${O.y + 14} ${O.z + 9} minecraft:air`);
        for (const [x0, y0, z0, x1, y1, z1, st] of c.blocks) await r(`fill ${O.x + x0} ${O.y + y0} ${O.z + z0} ${O.x + x1} ${O.y + y1} ${O.z + z1} minecraft:${st}`);
        const [sx, sy, sz, yaw, pitch] = c.start, feet = { x: O.x + sx, y: O.y + sy, z: O.z + sz };
        const inAir = !c.blocks.some(([x0, y0, z0, x1, y1, z1]) => sx >= x0 && sx <= x1 && sz >= z0 && sz <= z1 && sy - 1 >= y0 && sy - 1 <= y1);
        if (inAir) await r(`setblock ${feet.x} ${feet.y - 1} ${feet.z} minecraft:barrier`);
        await r(`player ${name} kill`); await sleep(500);
        console.log(name, T.strip(await r(`player ${name} spawn at ${feet.x + 0.5} ${feet.y} ${feet.z + 0.5} facing ${yaw} ${pitch} in minecraft:overworld in survival`)).slice(0, 100));
        await sleep(3000);
        await r(`effect give ${name} minecraft:saturation 60 1 true`);
        const prog = [];
        let prev = '.......';
        if (inAir) prog.push([0, `!setblock ${feet.x} ${feet.y - 1} ${feet.z} minecraft:air`]);
        for (const [t, keys] of c.program) { for (const a of actions(prev, keys)) prog.push([t, a]); prev = keys; }
        const progS = `[${prog.map(([t, a]) => `[${t},'${a}']`).join(',')}]`;
        const tag = `${T.RUN}_${c.name}`;
        console.log(c.name, T.strip(await r(`script in ntrace run start('${name}', ${progS}, ${c.ticks}, '${tag}')`)).slice(0, 80));
        await sleep(c.ticks * 50 + 1500);
        await r(`player ${name} kill`);
        meta.cases.push({ name: c.name, tag, origin: O, feet, inAir, yaw, pitch, program: c.program, prog, ticks: c.ticks });
        await r(`forceload remove ${O.x - 16} ${O.z - 16} ${O.x + 16} ${O.z + 16}`);
    }
    fs.mkdirSync(`/out/${T.RUN}`, { recursive: true });
    fs.writeFileSync(`/out/${T.RUN}/fake_meta.json`, JSON.stringify(meta, null, 1));
    console.log('cases', meta.cases.length);
    shared.close && shared.close();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

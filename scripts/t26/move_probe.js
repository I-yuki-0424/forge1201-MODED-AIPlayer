'use strict';
// Probe (test code): the survival mover (src/build/move.js) on natural terrain: walks of 20-40 blocks in four directions, a climb of 10 on temporary blocks, the way back
// down, a bridge over a 4-wide gap made by command; every end read from the SERVER (position), the temporary blocks counted. scripts/t26/run.sh N move_probe.js
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const { Mover, feet } = require('../../src/build/move');
const sleep = T.sleep, strip = T.strip;

(async () => {
    const { S } = await T.connectRcon();
    await S.cmd('difficulty peaceful');
    const name = `Mv${T.WORLD}`;
    const bot = createBot({ host: 'mc', port: 25565, username: name, viewDistance: 6 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res) => bot.once('spawn', res));
    await S.cmd(`gamemode survival ${name}`); await S.cmd(`clear ${name}`);
    for (const it of ['dirt 64', 'dirt 64', 'diamond_pickaxe 1', 'diamond_shovel 1', 'diamond_axe 1']) await S.cmd(`give ${name} minecraft:${it}`);
    await sleep(4000);
    const temps = [];
    const rules = { canDig: (x, y, z, b) => !/(chest|bedrock|obsidian)$/.test(b.name), temp: () => 'dirt', onTemp: (c) => temps.push(c) };
    const mv = new Mover(bot, rules);
    const res = [];
    const run = async (label, to, goal, opts = {}) => {
        const t0 = Date.now(); const r = await mv.goto(to, { goal, ...opts });
        const sp = await T.posOf(S, name), at = sp ? { x: Math.floor(sp.x), y: Math.floor(sp.y + 0.01), z: Math.floor(sp.z) } : null;
        const ok = r.ok && at && (goal ? goal(at.x, at.y, at.z) : at.x === to.x && at.y === to.y && at.z === to.z);
        res.push(ok); console.log(`[${label}] ${ok ? 'OK' : 'FAIL'} ${Math.round((Date.now() - t0) / 100) / 10} s, steps ${r.steps}, server ${at && `${at.x},${at.y},${at.z}`}${r.ok ? '' : ' why ' + r.why}`);
        return ok;
    };
    const near = (c, d = 1) => (x, y, z) => Math.abs(x - c.x) <= d && Math.abs(z - c.z) <= d && Math.abs(y - c.y) <= 3;
    const p0 = feet(bot);
    for (const [dx, dz] of [[25, 0], [0, 25], [-25, 0], [0, -25]]) { const b = feet(bot), c = { x: b.x + dx, y: b.y, z: b.z + dz }; await run(`walk ${dx},${dz}`, c, near(c)); }
    const b1 = feet(bot);
    await run('climb 10', { x: b1.x, y: b1.y + 10, z: b1.z }, (x, y, z) => y >= b1.y + 10);
    await run('back down', { x: b1.x, y: b1.y, z: b1.z }, (x, y, z) => y <= b1.y && Math.abs(x - b1.x) <= 2 && Math.abs(z - b1.z) <= 2);
    // a gap: a 4-wide trench 3 deep across the way east
    const b2 = feet(bot);
    await S.cmd(`fill ${b2.x + 2} ${b2.y - 3} ${b2.z - 2} ${b2.x + 5} ${b2.y + 3} ${b2.z + 2} minecraft:air`);
    await S.cmd(`fill ${b2.x + 6} ${b2.y - 1} ${b2.z - 2} ${b2.x + 8} ${b2.y - 1} ${b2.z + 2} minecraft:stone`);
    await S.cmd(`fill ${b2.x + 6} ${b2.y} ${b2.z - 2} ${b2.x + 8} ${b2.y + 3} ${b2.z + 2} minecraft:air`);
    await S.cmd(`fill ${b2.x - 1} ${b2.y - 1} ${b2.z - 1} ${b2.x + 1} ${b2.y - 1} ${b2.z + 1} minecraft:stone`);
    await sleep(1500);
    await run('across a gap', { x: b2.x + 7, y: b2.y, z: b2.z }, (x, y, z) => x >= b2.x + 6 && y === b2.y);
    console.log(`[move] ${res.filter(Boolean).length}/${res.length} moves ended where planned; ${temps.length} temporary blocks placed; health ${bot.health}; from ${p0.x},${p0.y},${p0.z}`);
    bot.quit(); await sleep(300); process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });

'use strict';
// Bench (test code): the survival mover (src/build/move.js) on natural terrain, TRIPS random trips (15-40 blocks, any direction, to the surface there), each end read from the SERVER.
// Failures print what is around the start and the end (the blocks the plan saw). scripts/t26/run.sh N move_bench.js [TRIPS=30]
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const { Mover, View, feet } = require('../../src/build/move');
const sleep = T.sleep;

(async () => {
    const { S } = await T.connectRcon();
    await S.cmd('difficulty peaceful');
    const name = `Mb${T.WORLD}`, TRIPS = Number(process.env.TRIPS || 30), rnd = T.rng(Number(process.env.SEED || 7));
    const bot = createBot({ host: 'mc', port: 25565, username: name, viewDistance: 6 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res) => bot.once('spawn', res));
    await S.cmd(`gamemode survival ${name}`); await S.cmd(`clear ${name}`);
    for (const it of ['dirt 64', 'dirt 64', 'dirt 64', 'diamond_pickaxe 1', 'diamond_shovel 1', 'diamond_axe 1']) await S.cmd(`give ${name} minecraft:${it}`);
    await sleep(4000);
    let temps = 0;
    const rules = { canDig: (x, y, z, b) => !/(chest|bedrock|obsidian|barrel|shulker_box)$/.test(b.name), temp: () => 'dirt', onTemp: () => { temps++; } };
    const mv = new Mover(bot, rules);
    const around = (c) => { const v = new View(bot, rules), out = []; for (let dy = -2; dy <= 2; dy++) { const b = bot.blockAt(new Vec3(c.x, c.y + dy, c.z)); out.push(`${dy}:${b ? b.name : '?'}${dy === -1 ? (v.stands(c.x, c.y - 1, c.z) ? '(stands)' : '(no)') : ''}`); } return out.join(' '); };
    let ok = 0, secs = 0; const why = {};
    for (let t = 0; t < TRIPS; t++) {
        const s = feet(bot), a = rnd() * Math.PI * 2, d = 15 + rnd() * 25, tx = Math.round(s.x + Math.cos(a) * d), tz = Math.round(s.z + Math.sin(a) * d);
        // the surface at the target column, as the bot sees it (after the walk starts it may come into view: a goal within 2 of the column at any height)
        const goal = (x, y, z) => Math.abs(x - tx) <= 2 && Math.abs(z - tz) <= 2;
        const t0 = Date.now(), r = await mv.goto({ x: tx, y: s.y, z: tz }, { goal, maxNodes: 60000 });
        const sp = await T.posOf(S, name), at = sp && { x: Math.floor(sp.x), y: Math.floor(sp.y + 0.16), z: Math.floor(sp.z) };
        const good = r.ok && at && goal(at.x, at.y, at.z);
        secs += (Date.now() - t0) / 1000;
        if (good) ok++; else { const k = String(r.why).replace(/-?\d+/g, '#').slice(0, 60); why[k] = (why[k] || 0) + 1; console.log(`[trip ${t}] FAIL ${r.why} from ${s.x},${s.y},${s.z} [${around(s)}] to ${tx},${tz} at ${at && `${at.x},${at.y},${at.z}`} [${at ? around(at) : ''}]`); }
    }
    console.log(`[bench] ${ok}/${TRIPS} trips ended at the goal (server), ${Math.round(secs)} s in all, ${temps} temporary blocks, health ${bot.health}; failures ${JSON.stringify(why)}`);
    bot.quit(); await sleep(300); process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });

'use strict';
// Probe (test code): every distinct block state of the given blueprints placed by a SURVIVAL bot with a real click: the face, hit point and stance found by src/build/place.js
// (the look ray must hit that face first), the state read back by the server. Supports come from commands (stone), the bot is put on its stance by command (test only):
// what is under test is the placement model. scripts/t26/run.sh N place_probe.js
const fs = require('fs');
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const lit = require('../../src/work/jobs/litematic');
const S = require('../../src/build/state');
const R = require('../../src/build/rules');
const P = require('../../src/build/place');
const { Target } = require('../../src/build/target');
const strip = T.strip, sleep = T.sleep;

let aimed = 0, aimedOk = 0;
(async () => {
    const files = (process.env.LITEMATIC || '/app/tests/fixtures/iron-farm-34.litematic,/app/tests/fixtures/iron-farm-34-nether-side-main.litematic').split(',');
    const states = new Map();
    for (const f of files) {
        const p = lit.parse(fs.readFileSync(f)), t = new Target(lit.place(p, { pos: { x: 0, y: 0, z: 0 } }, { keepAir: true }).bp, { x: 0, y: 0, z: 0 });
        for (let i = 0; i < t.n; i++) { const r = t.recipe[i]; if (!r || r.op !== 'place') continue; const st = t.stateOf(i), k = S.str(st.name, st.props); if (!states.has(k)) states.set(k, { st, r }); }
    }
    const { S: srv } = await T.connectRcon();
    await srv.cmd('difficulty peaceful');
    const name = `Pl${T.WORLD}`;
    const bot = createBot({ host: 'mc', port: 25565, username: name, viewDistance: 4 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res) => bot.once('spawn', res));
    await srv.cmd(`gamemode survival ${name}`); await srv.cmd(`clear ${name}`);
    await sleep(1000);
    const p0 = await T.posOf(srv, name), X0 = Math.floor(p0.x) + 6, Y0 = 220, Z0 = Math.floor(p0.z) + 6;
    const Item = require('prismarine-item')(bot.registry);
    let i = 0, pass = 0; const fails = [];
    const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
    for (const [k, { st, r }] of states) {
        if (ONLY && !ONLY.test(k)) continue;
        const n = S.bare(st.name), item = r.item;
        const base = { x: X0 + (i % 8) * 9, y: Y0, z: Z0 + Math.floor(i / 8) * 9 }; i++;
        // the place: a 7x7 stone floor at y-1, the cell's supports (rules.js deps), a block over the cell two up (for looks upward), a column of 2 east for high stances
        await srv.cmd(`fill ${base.x - 3} ${base.y - 1} ${base.z - 3} ${base.x + 3} ${base.y - 1} ${base.z + 3} minecraft:stone`);
        await srv.cmd(`fill ${base.x - 3} ${base.y} ${base.z - 3} ${base.x + 3} ${base.y + 4} ${base.z + 3} minecraft:air`);
        for (const tall of [0, 2]) {
            const Tc = { x: base.x, y: base.y + tall, z: base.z };
            await srv.cmd(`fill ${base.x - 3} ${base.y} ${base.z - 3} ${base.x + 3} ${base.y + 4} ${base.z + 3} minecraft:air`);
            if (tall) { await srv.cmd(`setblock ${Tc.x} ${Tc.y + 1} ${Tc.z} minecraft:stone`); }
            const deps = (r.deps || []).length ? [...r.deps] : [];
            if (n === 'hopper' && st.props.facing !== 'down') deps.push(require('../../src/build/vanilla').VEC[st.props.facing]);
            for (const d of deps) await srv.cmd(`setblock ${Tc.x + d[0]} ${Tc.y + d[1]} ${Tc.z + d[2]} minecraft:stone`);
            if (/chest$/.test(n) && st.props.type === 'left') { const d = r.deps[0]; await srv.cmd(`setblock ${Tc.x + d[0]} ${Tc.y} ${Tc.z + d[2]} minecraft:${n}[facing=${st.props.facing},type=single]`); }
            await sleep(400);
            const world = P.botWorld(bot), stations = [];
            for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
                const s = { x: base.x + dx, y: base.y, z: base.z + dz };
                const a = world.block(s.x, s.y, s.z), b = world.block(s.x, s.y + 1, s.z);
                if (a && b && a.name === 'air' && b.name === 'air') stations.push(s);
            }
            stations.sort((a, b) => Math.hypot(a.x - Tc.x, a.z - Tc.z) - Math.hypot(b.x - Tc.x, b.z - Tc.z));
            const ways = P.ways(world, Tc, st, item, stations, { max: 1 });
            if (process.env.ONLY) console.log(`[debug] ${k} tall=${tall} stations ${stations.length} ways ${JSON.stringify(ways[0] || null)}`);
            if (!ways.length) { if (tall) fails.push(`${k}: no way found (floor or high)`); continue; }
            const w = ways[0];
            if (w.aim) aimed = (aimed || 0) + 1;
            await srv.cmd(`tp ${name} ${w.station.x + 0.5} ${w.station.y} ${w.station.z + 0.5}`);
            await sleep(700);
            const def = bot.registry.itemsByName[item];
            await srv.cmd(`item replace entity ${name} hotbar.0 with minecraft:${item} 1`);
            bot.setQuickBarSlot(0);
            const yaw = Math.atan2(-w.look[0], -w.look[2]), pitch = Math.atan2(w.look[1], Math.hypot(w.look[0], w.look[2]));
            if (w.sneak) bot.setControlState('sneak', true);
            await bot.look(yaw, pitch, true);
            await sleep(150);
            bot._client.write('block_place', { hand: 0, location: new Vec3(...w.n), direction: require('../../src/build/vanilla').FACE[w.face], cursorX: w.hit[0] - w.n[0], cursorY: w.hit[1] - w.n[1], cursorZ: w.hit[2] - w.n[2], insideBlock: false, worldBorderHit: false, sequence: 1 });
            bot.swingArm();
            await sleep(250);
            if (w.sneak) { bot.setControlState('sneak', false); await sleep(100); }
            // clicks the state needs after placement (note, delay, mode, open): on a face of the block the eye sees
            const want = S.decidedProps(n, st.props);
            const seen = P.botWorld(bot).block(Tc.x, Tc.y, Tc.z);
            const need = seen ? require('../../src/build/survey').clicksFor(st, seen) : null;
            if (need) {
                const c = P.clickable(P.botWorld(bot), Tc, w.station);
                if (c) {
                    await srv.cmd(`item replace entity ${name} hotbar.0 with minecraft:air`);
                    const look = need.look ? R.lookAngles(need.look) : { yaw: Math.atan2(-c.look[0], -c.look[2]), pitch: Math.atan2(c.look[1], Math.hypot(c.look[0], c.look[2])) };
                    await bot.look(Math.atan2(-c.look[0], -c.look[2]), Math.atan2(c.look[1], Math.hypot(c.look[0], c.look[2])), true); await sleep(150);
                    for (let q = 0; q < need.clicks; q++) bot._client.write('block_place', { hand: 0, location: new Vec3(Tc.x, Tc.y, Tc.z), direction: require('../../src/build/vanilla').FACE[c.face], cursorX: c.hit[0] - Tc.x, cursorY: c.hit[1] - Tc.y, cursorZ: c.hit[2] - Tc.z, insideBlock: false, worldBorderHit: false, sequence: 2 + q });
                    void look; await sleep(300);
                }
            }
            const ok = /passed/.test(strip(await srv.cmd(`execute if block ${Tc.x} ${Tc.y} ${Tc.z} ${S.str(n, want)}`)));
            if (process.env.ONLY) { const bb = bot.blockAt(new Vec3(Tc.x, Tc.y, Tc.z)); console.log(`[debug] result ${ok} sees ${bb && bb.name} held ${bot.heldItem && bot.heldItem.name} pos ${bot.entity.position}`); }
            if (ok) { pass++; if (w.aim) aimedOk = (aimedOk || 0) + 1; break; }
            const b = bot.blockAt(new Vec3(Tc.x, Tc.y, Tc.z));
            if (w.aim) console.log(`[aim-fail] ${k} tall=${tall} -> ${b ? b.name + JSON.stringify(b.getProperties()) : '?'} face ${w.face} look ${w.look.map((v) => v.toFixed(2))}`);
            if (tall) fails.push(`${k} -> sees ${b ? b.name + JSON.stringify(b.getProperties()) : '?'} via face ${w.face} of ${w.n} sneak ${w.sneak} look ${w.look.map((v) => v.toFixed(2))}`);
            void def;
        }
    }
    console.log(`[place] ${pass}/${states.size} states right by survival clicks; ${aimedOk || 0} of ${aimed || 0} exact-look (flexible) placements right`);
    for (const f of fails) console.log('  FAIL', f);
    bot.quit(); await sleep(300); process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });

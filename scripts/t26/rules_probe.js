'use strict';
// Probe (test code): every distinct block state of the given blueprints, placed by ONE creative bot into the air with the recipe of src/build/rules.js, read back by the SERVER
// (`execute if block` with the decided properties). Supports a recipe needs (the cell below, a wall) are set by command first (stone); a double chest is placed half by half.
// scripts/t26/run.sh N rules_probe.js [LITEMATIC=/app/tests/fixtures/a.litematic,/app/tests/fixtures/b.litematic]
const fs = require('fs');
const T = require('./lib');
const { Vec3 } = require('vec3');
const { createBot, attachHandshake } = require('../../src/transport');
const lit = require('../../src/work/jobs/litematic');
const S = require('../../src/build/state');
const R = require('../../src/build/rules');
const { Target } = require('../../src/build/target');
const { Hand, sleep } = require('../../src/build/act');
const fly = require('../../src/build/fly');
const strip = T.strip;

(async () => {
    const files = (process.env.LITEMATIC || '/app/tests/fixtures/iron-farm-34.litematic,/app/tests/fixtures/iron-farm-34-nether-side-main.litematic').split(',');
    const states = new Map();
    for (const f of files) {
        const p = lit.parse(fs.readFileSync(f)), pl = lit.place(p, { pos: { x: 0, y: 0, z: 0 }, rotation: 'NONE', mirror: 'NONE' }, { keepAir: true });
        const t = new Target(pl.bp, { x: 0, y: 0, z: 0 });
        for (let i = 0; i < t.n; i++) {
            const r = t.recipe[i]; if (!r || r.op !== 'place') continue;
            const st = t.stateOf(i), k = S.str(st.name, st.props);
            if (!states.has(k)) states.set(k, { st, r });
        }
    }
    console.log(`[rules] ${states.size} distinct placeable states`);
    const { S: srv } = await T.connectRcon();
    const name = `Rp${T.WORLD}`;
    const bot = createBot({ host: process.env.MC_HOST || 'mc', port: 25565, username: name, viewDistance: 4 });
    attachHandshake(bot, { registry: 'vanilla' });
    await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
    await srv.cmd(`gamemode creative ${name}`);
    await sleep(1000);
    const p0 = await T.posOf(srv, name), X0 = Math.floor(p0.x) + 8, Y0 = 200, Z0 = Math.floor(p0.z) + 8;
    await srv.cmd(`forceload add ${X0 - 4} ${Z0 - 4} ${X0 + 80} ${Z0 + 80}`);
    for (let xa = X0 - 2; xa <= X0 + 70; xa += 24) await srv.cmd(`fill ${xa} ${Y0 - 3} ${Z0 - 2} ${Math.min(xa + 23, X0 + 70)} ${Y0 + 3} ${Z0 + 70} air`);
    await srv.cmd(`tp ${name} ${X0 - 1.5} ${Y0 + 3} ${Z0 - 1.5}`);
    await sleep(2500);
    fly.takeOff(bot);
    const hand = new Hand(bot);
    let i = 0, pass = 0; const fails = [];
    for (const [k, { st, r }] of states) {
        const c = { x: X0 + (i % 14) * 5, y: Y0, z: Z0 + Math.floor(i / 14) * 5 }; i++;
        const n = S.bare(st.name);
        for (const d of r.deps) await srv.cmd(`setblock ${c.x + d[0]} ${c.y + d[1]} ${c.z + d[2]} minecraft:stone`);
        // a LEFT chest: its RIGHT partner first, by the same hand
        if (/chest$/.test(n) && st.props.type === 'left') { await srv.cmd(`setblock ${c.x + r.deps[0][0]} ${c.y} ${c.z + r.deps[0][2]} air`); }
        const station = fly.feet(bot), want = { x: c.x - 2, y: c.y + 1, z: c.z - 2 };
        const fr = await fly.flyTo(bot, want); hand.moved();
        if (!fr.ok) { console.log('fly failed', fr); }
        if (/chest$/.test(n) && st.props.type === 'left') {
            const d = r.deps[0], pc = { x: c.x + d[0], y: c.y, z: c.z + d[2] };
            const rr = R.recipe({ name: n, props: { ...st.props, type: 'right' } });
            await hand.aim(rr.look, rr.sneak); hand.place(pc, rr); await sleep(150);
        }
        await hand.aim(r.look, r.sneak);
        hand.place(c, r);
        if (r.clicks) { await hand.aim(r.clickLook || r.look, false); hand.click(c, r.clicks); }
        await sleep(350);
        const dp = S.decidedProps(n, st.props), test = S.str(n, dp);
        const ok = /passed/.test(strip(await srv.cmd(`execute if block ${c.x} ${c.y} ${c.z} ${test}`)));
        if (ok) pass++;
        else {
            const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
            fails.push(`${k}  ->  bot sees ${b ? b.name + JSON.stringify(b.getProperties()) : '?'}  recipe ${JSON.stringify({ face: r.face, look: r.look, sneak: r.sneak, clicks: r.clicks })}`);
        }
        void station;
    }
    console.log(`[rules] ${pass}/${states.size} states right`);
    for (const f of fails) console.log('  FAIL', f);
    for (let xa = X0 - 2; xa <= X0 + 70; xa += 24) await srv.cmd(`fill ${xa} ${Y0 - 3} ${Z0 - 2} ${Math.min(xa + 23, X0 + 70)} ${Y0 + 3} ${Z0 + 70} air`);
    await srv.cmd(`forceload remove ${X0 - 4} ${Z0 - 4} ${X0 + 80} ${Z0 + 80}`);
    bot.quit(); await sleep(300); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });

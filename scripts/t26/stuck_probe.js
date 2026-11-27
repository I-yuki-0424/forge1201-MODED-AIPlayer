'use strict';
// Load probe of the stuck snapshots (TASK-20261127-084): what one stuck event costs the server and the harness. BOTS bots stand each on a bottom slab in the air
// (natural terrain below), then ROUNDS rounds: a [stall] line per bot through the work service's own note() (the hook the real lines take), the snapshots written
// with the server's truth over RCON. Measured: the server's mean ms per tick (`tick query`, last 100 ticks) every 5 s while idle and while the events run, each
// event's RCON time / command count / bytes / renderMs (event.json). Not a stuck rate: the stall line is the probe's own, the cost is what it measures.
//   scripts/t26/run.sh N stuck_probe.js RUN=sp084a [BOTS=4] [ROUNDS=3]          (snapshots are on by default in harness runs)
const fs = require('fs');
const path = require('path');
const T = require('./lib');

const BOTS = Math.min(8, Math.max(1, Number(process.env.BOTS || 4))), ROUNDS = Math.min(6, Math.max(1, Number(process.env.ROUNDS || 3)));
const names = Array.from({ length: BOTS }, (_, i) => `Sp${T.WORLD}${'abcdefgh'[i]}`);
const mspt = (s) => { const m = /Average time per tick: ([\d.]+) ?ms/i.exec(T.strip(s)); return m ? Number(m[1]) : null; };

(async () => {
    if (!require('../../src/debug/stuck').enabled()) throw new Error('the snapshots are off (STUCK_SNAPSHOTS=0, or no /out): nothing to measure');
    const { S, svc } = await T.open(names, { teleport: 'off', autoKit: false });
    const root = process.env.STUCK_DIR || '/out/stuck', run = process.env.RUN || 'probe', dir = path.join(root, run);
    const spots = names.map((n, i) => ({ x: 40 * i + 0.5, y: 150, z: 0.5 }));
    for (const [i, n] of names.entries()) {
        const p = spots[i];
        await S.cmd(`forceload add ${Math.floor(p.x)} 0`);
        await S.cmd(`setblock ${Math.floor(p.x)} ${p.y - 1} 0 minecraft:stone_slab[type=bottom]`);
        await S.cmd(`setblock ${Math.floor(p.x) + 1} ${p.y - 1} 0 minecraft:oak_slab[type=bottom]`);
        await S.cmd(`tp ${n} ${p.x} ${p.y - 0.5} ${p.z} 90 0`);
    }
    await T.sleep(8000);
    const sample = async () => ({ t: Date.now(), mspt: mspt(await S.cmd('tick query')) });
    const idle = []; for (let k = 0; k < 6; k++) { idle.push(await sample()); await T.sleep(5000); }
    const busy = [], events = [];
    const count = () => { try { return fs.readdirSync(dir).filter((d) => /^\d{3}-stall-/.test(d)).length; } catch (_) { return 0; } };
    const expect = Math.min(BOTS, 3);           // the watcher keeps at most 3 events waiting (StuckWatch queue): a 4th at the same moment is dropped and counted (index.json dropped)
    for (let r = 0; r < ROUNDS; r++) {
        const before = count(), t0 = Date.now();
        for (const [i, n] of names.entries()) { const p = svc.bots.get(n).bot.entity.position; svc.note('warn', `job probe: [stall] ${n} no action for 61 s at ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} in probe round ${r} (${i})`); }
        while (count() < before + expect && Date.now() - t0 < 300000) { busy.push(await sample()); await T.sleep(5000); }
        const wall = Date.now() - t0;
        console.log(`[stuck_probe] round ${r}: ${count() - before} events in ${Math.round(wall / 1000)} s`);
        if (r < ROUNDS - 1) await T.sleep(Math.max(0, 125000 - wall));          // the per-bot limit is one stall event per 2 min
    }
    for (const id of fs.readdirSync(dir).filter((d) => /^\d{3}-stall-/.test(d))) {
        try { const e = JSON.parse(fs.readFileSync(path.join(dir, id, 'event.json'), 'utf8')); events.push({ id, bytes: e.bytes, renderMs: e.renderMs, rconMs: e.server && e.server.ms, commands: e.server && e.server.commands, checked: e.server && e.server.checked, unchecked: e.server && e.server.unchecked, diff: e.server && e.server.diff ? Object.keys(e.server.diff).length : null, textures: e.textures }); } catch (_) { /* half written */ }
    }
    const mean = (a) => { const v = a.map((s) => s.mspt).filter(Number.isFinite); return v.length ? +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(2) : null; };
    const max = (a) => { const v = a.map((s) => s.mspt).filter(Number.isFinite); return v.length ? Math.max(...v) : null; };
    const out = { run, bots: BOTS, rounds: ROUNDS, idle: { n: idle.length, meanMspt: mean(idle), maxMspt: max(idle) }, busy: { n: busy.length, meanMspt: mean(busy), maxMspt: max(busy) }, events };
    fs.writeFileSync(`/out/${run}-probe.json`, JSON.stringify(out, null, 1));
    console.log(`[stuck_probe] ${JSON.stringify({ idle: out.idle, busy: out.busy, events: events.length })}`);
    for (const p of spots) await S.cmd(`forceload remove ${Math.floor(p.x)} 0`).catch(() => {});
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

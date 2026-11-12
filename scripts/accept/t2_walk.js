'use strict';
// ACCEPTANCE test 2 (docs/proposed/ACCEPTANCE-v1.md): 2000 blocks north of the initial point and back, through the console's own `journey` command, graded by the SERVER's position.
// Allowed changes from the initial state: none (no chest needed). teleport stays off; no server move may happen; the bot may not die.
//   scripts/accept/run.sh t2_walk.js DIST=2000 LIVE_OUT=/out/t2.json        CONTROL=noop: nothing is sent (must fail both checks)
const fs = require('fs');
const L = require('../real/lib');

const DIST = Number(process.env.DIST || 2000), CONTROL = process.env.CONTROL || '', A = process.env.BOTNAME || 'AccA', LIMIT_MIN = Number(process.env.LIMIT_MIN || 60);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[accept-t2] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail !== undefined ? JSON.stringify(detail).slice(0, 500) : ''}`); };

async function main() {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' });
    const rec = svc.bots.get(A), bot = rec.bot; S.name = A;
    let moves = 0, deaths = 0; const om = svc._moved.bind(svc); svc._moved = (n, m) => { moves++; return om(n, m); }; bot.on('death', () => { deaths++; });
    await L.sleep(4000);
    const p0 = await L.posOf(S, A), init = { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) };
    console.log(`[accept-t2] initial point ${JSON.stringify(init)} seed ${(await S.cmd('seed')).replace(/\x1b\[[0-9;]*m/g, '')}`);
    const send = async (x, z) => {
        const t0 = Date.now();
        if (CONTROL !== 'noop') {
            const r = await svc.runCommand({ bots: [A], command: 'journey', args: { x, z } });
            if (!r.started || !r.started.length) return { ok: false, why: 'refused', r };
            while (Date.now() - t0 < LIMIT_MIN * 60000 && rec.cmd && rec.cmd.status === 'running') await L.sleep(1000);
            if (rec.cmd && rec.cmd.status === 'running') rec.cmd.cancel.cancelled = true;
        } else await L.sleep(10000);
        await L.sleep(1500);
        return { said: rec.cmd && rec.cmd.result, sec: Math.round((Date.now() - t0) / 1000) };
    };
    const across = (p, t) => Math.hypot(p.x - t.x - 0.5, p.z - t.z - 0.5);
    const north = { x: init.x, z: init.z - DIST };
    const a = await send(north.x, north.z), p1 = await L.posOf(S, A);
    check(`${DIST} blocks north of the initial point`, !!p1 && across(p1, north) <= 4, { target: north, at: p1 && [p1.x, p1.y, p1.z].map(Math.round), off: p1 && Math.round(across(p1, north)), sec: a.sec, said: a.said });
    const b = await send(init.x, init.z), p2 = await L.posOf(S, A);
    check('back at the initial point (counts only if the walk out succeeded)', results[0].ok && !!p2 && across(p2, init) <= 4 && Math.abs(p2.y - init.y) <= 3, { target: init, at: p2 && [p2.x, p2.y, p2.z].map(Math.round), off: p2 && Math.round(across(p2, init)), sec: b.sec, said: b.said });
    check('no server move, no death', moves === 0 && deaths === 0, { moves, deaths });
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`[accept-t2] ${results.length - failed.length}/${results.length} pass${CONTROL ? ' (CONTROL ' + CONTROL + ')' : ''}`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify({ init, results }, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

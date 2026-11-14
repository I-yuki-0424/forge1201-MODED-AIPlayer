'use strict';
// T26 test MINE B (owner 2026-11-14): 1 bot strip-mines the world spawn's chunk from the top of its terrain down to y -59 (above the bedrock band). Best tools (netherite, efficiency 255,
// unbreakable), 2 stacks of temporary blocks, food; Normal, no keepInventory. The job counts as done ONLY if not a single block (fluids included) is left in the box: the SERVER compares
// every layer with air in the sky (`execute if blocks ... masked`; the untouched chunk must fail the same check: the control). Required: 100 %.
//   scripts/t26/run.sh N mine_b.js [LIMIT_MIN=240] [DEPTH=layers from the top, a rehearsal] [W=16] [METHOD=sweep|expert|rows] [CONTROL=noop]
const T = require('./lib');
const Vec3 = require('vec3');
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 240), DEPTH = Number(process.env.DEPTH || 0), W = Number(process.env.W || 16), name = `Pit${T.WORLD}`;

(async () => {
    const rep = T.reporter('mine_b');
    const { S, svc, seed } = await T.open([name]);
    const deaths = T.countDeaths(svc, [name], S), moves = T.countMoves(svc), bot = svc.bots.get(name).bot;
    const p0 = await T.posOf(S, name), cx = Math.floor(Math.floor(p0.x) / 16), cz = Math.floor(Math.floor(p0.z) / 16);
    const x0 = cx * 16, z0 = cz * 16, x1 = x0 + W - 1, z1 = z0 + W - 1;
    await S.must(`forceload add ${x0} ${z0} ${x1} ${z1}`);
    // the top of the terrain in the box (the bot's view), the bot then stands beside the box on the surface
    await T.sleep(3000);
    const colTop = (x, z) => { for (let y = 319; y >= -64; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.name !== 'air' && b.name !== 'cave_air') return y; } return null; };
    let top = -64; for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) top = Math.max(top, colTop(x, z) ?? -64);
    const bottom = DEPTH ? top - DEPTH + 1 : -59, box = { x0, z0, x1, z1, top, bottom };
    const refY = Math.max(top + 20, 200);
    const layerClean = async (y) => /^Test passed/.test(T.strip(await S.cmd(`execute if blocks ${x0} ${y} ${z0} ${x1} ${y} ${z1} ${x0} ${refY} ${z0} masked`)));
    const dirty = async () => { const out = []; for (let y = bottom; y <= top; y++) if (!(await layerClean(y))) out.push(y); return out; };
    const before = await dirty();
    const controlOk = before.length > 0;                           // the untouched chunk must fail
    await T.onSurface(S, name, x1 + 3, z0 + 8);
    await T.kit(S, name, { blocks: 128, best: true });
    await T.sleep(2000);
    await T.say(S, `mine_b: ${name} strip-mines ${JSON.stringify(box)} (${W * W * (top - bottom + 1)} cells)`);
    const t0 = Date.now();
    let state = 'control';
    if (!T.CONTROL) {
        const pit = svc.createPit({ box, bots: [name], start: true, ...(process.env.METHOD ? { method: process.env.METHOD } : {}) });
        let last = 0;
        while (Date.now() - t0 < LIMIT_MIN * 60000) {
            const j = svc.jobs.get(pit.id); if (!j || j.state === 'finished' || j.state === 'cancelled') { state = j ? j.state : 'gone'; break; }
            if (Date.now() - last > 120000) { last = Date.now(); const v = svc._jobView(j); console.log(`[mine_b w${T.WORLD}] ${Math.round((Date.now() - t0) / 60000)} min ${JSON.stringify(v.progress || v.summary || {}).slice(0, 200)} temps ${svc.temps.size}`); }
            await T.sleep(3000);
        }
        if (state === 'control') { state = 'timeout'; const j = svc.jobs.get(pit.id); if (j && svc.pauseJob) try { svc.pauseJob(pit.id); } catch (_) { /* best effort */ } }
    }
    await T.sleep(3000);
    const left = await dirty();
    const tempsLeft = svc.temps.list((r) => r.x >= x0 - 2 && r.x <= x1 + 2 && r.z >= z0 - 2 && r.z <= z1 + 2).map((r) => [r.x, r.y, r.z, r.kind]);
    if (deaths.read) await deaths.read();
    rep.trial(name, controlOk && left.length === 0 && !moves[name], { box, controlDirtyLayers: before.length, state, min: Math.round((Date.now() - t0) / 60000), dirtyLayers: left.length, firstDirty: left.slice(0, 12), registeredTempsLeft: tempsLeft.length, temps: tempsLeft.slice(0, 20), deaths: deaths[name], serverMoves: moves[name] || 0 });
    await S.cmd(`forceload remove ${x0} ${z0} ${x1} ${z1}`);
    const k = rep.write({ seed });
    await svc.stop(); process.exit(k ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// T26 test MINE B (owner 2026-11-14): 1 bot strip-mines the world spawn's chunk from the top of its terrain down to y -59 (above the bedrock band). Best tools (netherite, efficiency 255,
// unbreakable), 2 stacks of temporary blocks, food; Normal, no keepInventory. The job counts as done ONLY if not a single block (fluids included) is left in the box: the SERVER compares
// every layer with air in the sky (`execute if blocks ... masked`; the untouched chunk must fail the same check: the control). Required: 100 %.
//   scripts/t26/run.sh N mine_b.js [LIMIT_MIN=240] [DEPTH=layers from the top, a rehearsal] [W=16] [METHOD=sweep|expert|rows] [CONTROL=noop]
//   [KILL_AT_END=1 [KILL_AFTER_MS=4000]]: kill the bot during the end's cleanup at the time limit (TASK-075's negative test: nothing may be left anyway)
//   [POND=WxD] plants a pond (W x W cells across, D deep, flush with the ground, source blocks) in the middle of the box before the run: a SMOKE test of the water rule, never evidence
//   (built with commands); [PIT_LAKE=0] turns the lake fill off (A/B). The natural coast/aquifer chunks are the evidence.
const T = require('./lib');
const Vec3 = require('vec3');
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 240), DEPTH = Number(process.env.DEPTH || 0), W = Number(process.env.W || 16), name = `Pit${T.WORLD}`;

(async () => {
    const rep = T.reporter('mine_b');
    const { S, svc, seed } = await T.open([name]);
    const deaths = T.countDeaths(svc, [name], S), moves = T.countMoves(svc), bot = svc.bots.get(name).bot;
    // THE WORLD SPAWN's chunk (the owner's definition), the same for every run of a seed: a bot joins at a random spot around the spawn, and boxes taken from its position differed between two
    // runs of one seed (found 2026-11-16: cmp-sweep-a/cmp-expert-a compared different chunks). bot.spawnPoint is the spawn_position packet; the bot's own position only if it is missing.
    const sp = bot.spawnPoint, p0 = sp ? { x: sp.x, y: sp.y, z: sp.z } : await T.posOf(S, name), cx = Math.floor(Math.floor(p0.x) / 16), cz = Math.floor(Math.floor(p0.z) / 16);
    const x0 = cx * 16, z0 = cz * 16, x1 = x0 + W - 1, z1 = z0 + W - 1;
    await S.must(`forceload add ${x0} ${z0} ${x1} ${z1}`);
    // the top of the terrain in the box (the bot's view), the bot then stands beside the box on the surface
    // "Top of terrain" (owner): tree blocks are not terrain. A canopy 10 blocks over the ground (seed -8223826995433110289: 150 leaves at y 88-96 over ground at 85) would otherwise set the box top, and the pit
    // leaves such trees alone by design (pit.js aerialTree: out of reach for a bot on the ground). Tree blocks BELOW the terrain top, rooted in the box, are in the box and are graded like anything else.
    const TREE = /(_leaves|_log|_wood|_vines?|^vine|^bamboo|^mangrove_roots)$/;
    const colTop = (x, z) => { let seen = false; for (let y = 319; y >= -64; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) continue; seen = true; if (b.name !== 'air' && b.name !== 'cave_air' && !TREE.test(b.name)) return y; } return seen ? -64 : null; };
    // the box's chunk must be in the bot's view before it is measured (a loaded server delayed it past a fixed wait: "y must be between -64 and 319")
    let top = -64;
    for (let tries = 0; tries < 40; tries++) {
        await T.sleep(1500); top = -64; let missing = 0;
        for (let x = x0; x <= x1; x += 3) for (let z = z0; z <= z1; z += 3) { const t = colTop(x, z); if (t === null) missing++; else top = Math.max(top, t); }
        if (!missing) break;
    }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) top = Math.max(top, colTop(x, z) ?? -64);
    if (top <= -64) throw new Error('mine_b: the box chunk never loaded');
    let bottom = DEPTH ? top - DEPTH + 1 : -59;
    const box = { x0, z0, x1, z1, top, bottom };
    let pond = null;
    if (process.env.POND) {
        const [pw, pd] = process.env.POND.split('x').map(Number), px = x0 + Math.floor((W - pw) / 2), pz = z0 + Math.floor((W - pw) / 2), g = colTop(px + (pw >> 1), pz + (pw >> 1));
        await S.must(`fill ${px} ${g - pd + 1} ${pz} ${px + pw - 1} ${g} ${pz + pw - 1} minecraft:water`);
        pond = { px, pz, pw, pd, surface: g }; await T.sleep(2500);
        top = Math.min(top, g + 2); bottom = g - pd; box.top = top; box.bottom = bottom;          // the smoke box is the pond's own layers (+ the air layers above), the rest is not the question
    }
    const refY = Math.max(top + 20, 200);
    const layerClean = async (y) => /^Test passed/.test(T.strip(await S.cmd(`execute if blocks ${x0} ${y} ${z0} ${x1} ${y} ${z1} ${x0} ${refY} ${z0} masked`)));
    const dirty = async () => { const out = []; for (let y = bottom; y <= top; y++) if (!(await layerClean(y))) out.push(y); return out; };
    // fluid in the box and in the one-cell ring around it (the water the pit has to deal with), read from the bot's view of the chunks
    const fluidAt = (x, y, z) => { let b = null; try { b = bot.blockAt(new Vec3(x, y, z)); } catch (_) { /* unloaded */ } return b ? (/water|lava|bubble_column|kelp|seagrass/.test(b.name) || (b.getProperties && b.getProperties().waterlogged === true) ? b.name : null) : null; };
    const fluid = { box: 0, ring: 0, kinds: {} };
    for (let y = bottom; y <= top; y++) for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
        const f = fluidAt(x, y, z); if (!f) continue;
        const inside = x >= x0 && x <= x1 && z >= z0 && z <= z1; fluid[inside ? 'box' : 'ring']++; fluid.kinds[f] = (fluid.kinds[f] || 0) + 1;
    }
    const before = await dirty();
    const controlOk = before.length > 0;                           // the untouched chunk must fail
    await T.onSurface(S, name, x1 + 3, z0 + 8);
    await T.kit(S, name, { blocks: 128, best: true });
    // A tools chest beside the start (a world condition like a player's base, TASK-075 2026-11-27, orchestrator): a bot that died lost its pack (keep_inventory false) and takes its
    // pickaxe there (the service's missing_tool script, site purpose 'tools'), as a player would; without it the bot wandered for cobblestone with no pickaxe (mb075p w2)
    { const p = await T.posOf(S, name), cx = Math.floor(p.x) + 2, cy = Math.floor(p.y), cz = Math.floor(p.z);
      await S.must(`setblock ${cx} ${cy} ${cz} minecraft:chest replace`);
      const spare = T.toolItems ? T.toolItems(true) : [];
      for (const [j, it] of [...spare, ...spare].entries()) await S.must(`item replace block ${cx} ${cy} ${cz} container.${j} with ${it}`);
      await S.must(`item replace block ${cx} ${cy} ${cz} container.20 with minecraft:cooked_beef 32`);
      svc.addSite({ name: 'tools', x: cx, y: cy, z: cz, purpose: 'tools' });
      console.log(`[mine_b w${T.WORLD}] tools chest at ${cx} ${cy} ${cz}: ${spare.length * 2} tools`); }
    await T.sleep(2000);
    await T.say(S, `mine_b: ${name} strip-mines ${JSON.stringify(box)} (${W * W * (top - bottom + 1)} cells)`);
    // temporary blocks (pumpkins) around the box before the job: the end scan counts only new ones (TASK-20261125-075)
    const TB = require('../../src/work/bot/tempblocks'), scanArea = { x0: x0 - 12, x1: x1 + 12, z0: z0 - 12, z1: z1 + 12, y0: bottom - 4, y1: top + 24 };
    const scan0 = TB.scanBox(bot, scanArea), before0 = new Set(scan0.cells.map((c) => `${c.x},${c.y},${c.z}`));
    const t0 = Date.now();
    let state = 'control';
    if (!T.CONTROL) {
        const pit = svc.createPit({ box, bots: [name], start: true, plants: true, ...(process.env.METHOD ? { method: process.env.METHOD } : {}) });
        let last = 0, killed = false;
        for (const limit = T.budget(() => (svc.bots.get(name) || {}).bot, LIMIT_MIN); !limit.over();) {
            const j = svc.jobs.get(pit.id); if (!j || j.state === 'finished' || j.state === 'cancelled') { state = j ? j.state : 'gone'; break; }
            // KILL_AT_END=1 when the job ends by itself: the ledger is finished and the worker's end pass (cleanup, nav's sweep) is running; the bot is killed in it (mb075k ended before the limit)
            if (process.env.KILL_AT_END === '1' && !killed && j.impl && j.impl.ledger && j.impl.ledger.finished && j.impl.ledger.finished()) { killed = true; await T.sleep(Number(process.env.KILL_AFTER_MS || 4000)); console.log(`[wrap] killing ${name} during the job's own end (KILL_AT_END)`); await S.cmd(`kill ${name}`); }
            if (Date.now() - last > 120000) { last = Date.now(); const v = svc._jobView(j); console.log(`[mine_b w${T.WORLD}] ${Math.round((Date.now() - t0) / 60000)} min ${JSON.stringify(v.progress || v.summary || {}).slice(0, 200)} temps ${svc.temps.size}`); }
            await T.sleep(3000);
        }
        if (state === 'control') {
            state = 'timeout'; const j = svc.jobs.get(pit.id);
            // the time is over before the pit: the crew takes its movement blocks away first (pit.js wrapUp; owner list 5 Large 1: a clean site at the end of every run), WRAP_MIN at most
            if (j && j.impl && j.impl.wrapUp && Number(process.env.WRAP_MIN ?? 5) > 0) {
                if (svc.wrapJob) svc.wrapJob(pit.id); else j.impl.wrapUp(); const tw = Date.now();
                // KILL_AT_END=1: the bot is killed a few seconds into the end's cleanup (the live negative test of TASK-075 item 4: the respawned bot must still take every block away)
                if (process.env.KILL_AT_END === '1' && !killed) { await T.sleep(Number(process.env.KILL_AFTER_MS || 4000)); console.log(`[wrap] killing ${name} during the end (KILL_AT_END)`); await S.cmd(`kill ${name}`); }
                while (Date.now() - tw < Number(process.env.WRAP_MIN ?? 5) * 60000) { const jj = svc.jobs.get(pit.id); if (!jj || jj.state !== 'running') break; await T.sleep(3000); }
                console.log(`[wrap] ${Math.round((Date.now() - tw) / 1000)} s, job ${(svc.jobs.get(pit.id) || {}).state}, registered ${svc.temps.size}: ${JSON.stringify(((svc.jobs.get(pit.id) || {}).impl || {}).plan ? svc.jobs.get(pit.id).impl.plan.endReport || {} : {}).slice(0, 300)}`);
            }
            if (j && j.state === 'running' && svc.pauseJob) try { svc.pauseJob(pit.id); } catch (_) { /* best effort */ }
        }
    }
    await T.sleep(3000);
    const left = await dirty();
    let jobEnd = null; try { const j = [...svc.jobs.values()][0]; if (j) { const v = svc.jobDetail(j.id); const jj = svc.jobs.get(j.id); jobEnd = { problems: (svc.problems && svc.problems.list || []).slice(-14).map((q) => JSON.stringify(q).slice(0, 420)), endReport: jj && jj.impl && jj.impl.plan && jj.impl.plan.endReport, progress: v.progress, stuck: v.stuck, report: JSON.stringify(v.report || {}).slice(0, 1200) }; } } catch (_) { /* informational */ }
    const tempsLeft = svc.temps.list((r) => r.x >= x0 - 2 && r.x <= x1 + 2 && r.z >= z0 - 2 && r.z <= z1 + 2).map((r) => [r.x, r.y, r.z, r.kind]);
    const tempScan = TB.scanBox(svc.bots.get(name).bot, scanArea, null, before0);
    console.log(`[temps] ${tempScan.cells.length} temporary blocks left around the box (${tempScan.unloaded} cells not loaded): ${JSON.stringify(tempScan.cells.slice(0, 20))}`);
    if (deaths.read) await deaths.read();
    rep.trial(name, controlOk && left.length === 0 && !moves[name], { tempScanLeft: tempScan.cells.length, tempScanCells: tempScan.cells.slice(0, 40), spawn: p0, pond, lakeFill: process.env.PIT_LAKE !== '0', method: process.env.METHOD || 'default', fluid, sec: Math.round((Date.now() - t0) / 1000), jobEnd, box, controlDirtyLayers: before.length, state, min: Math.round((Date.now() - t0) / 60000), dirtyLayers: left.length, firstDirty: left.slice(0, 12), registeredTempsLeft: tempsLeft.length, temps: tempsLeft.slice(0, 20), deaths: deaths[name], serverMoves: moves[name] || 0 });
    await S.cmd(`forceload remove ${x0} ${z0} ${x1} ${z1}`);
    const k = rep.write({ seed });
    await svc.stop(); process.exit(k ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

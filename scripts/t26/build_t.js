'use strict';
// T26 test BUILD T (owner 2026-11-21, TASK-20261121-073): a SURVIVAL crew (keep inventory off) builds a Litematica blueprint on NATURAL terrain of a new random world, Peaceful. The only setup:
// the materials in shulker boxes inside a chest (double chests) on the ground beside the site: the blueprint's items by count (+5 %), temporary blocks (dirt) and tools; the bots put beside it. The job is created and run by the work console's own service
// (createConstruct: the same code as the Litematica page). Judged by the SERVER, cell by cell (`execute if block`): the block and the properties the builder decides must be the blueprint's
// (power, connections, lit, extended, occupied, flowing fluid levels are the world's and are reported apart); a trial passes when the job ends by itself and no cell is wrong. The untouched site
// must fail the same judge (the negative control). (Before 2026-11-21 20:00 a reference copy made by commands was compared: its own lava ran over the sky and made thousands of false differences.)
//   scripts/t26/run.sh N build_t.js LITEMATIC=/app/tests/fixtures/iron-farm-34.litematic [DIM=nether] [BOTS=8] [LIMIT_MIN=120] [SEED_SITE=n] [CONTROL=noop]
const fs = require('fs');
const T = require('./lib');
const SUP = require('../../src/build/supply');
// PROFILE_AT=minutes: two minutes of CPU profile from then on, written to /out/prof/<RUN>.cpuprofile while the run goes on (a run that never exits writes no --cpu-prof)
if (process.env.PROFILE_AT) {
    const insp = require('inspector'), fs = require('fs'), ses = new insp.Session(); ses.connect();
    setTimeout(() => ses.post('Profiler.enable', () => ses.post('Profiler.start', () => setTimeout(() => ses.post('Profiler.stop', (e, r) => {
        if (!e) { fs.mkdirSync('/out/prof', { recursive: true }); fs.writeFileSync(`/out/prof/${process.env.RUN || 'run'}.cpuprofile`, JSON.stringify(r.profile)); console.log('[build_t] cpu profile written'); }
    }), 120000))), Number(process.env.PROFILE_AT) * 60000).unref();
}
const { Vec3 } = require('vec3');
const lit = require('../../src/work/jobs/litematic');
const S = require('../../src/build/state');
const { Target } = require('../../src/build/target');
const P = require('../../src/build/pistons');

const NETHER = (process.env.DIM || 'overworld') === 'nether', BOTS = Math.min(12, Math.max(1, Number(process.env.BOTS || 8))), LIMIT_MIN = Number(process.env.LIMIT_MIN || 120);
const FILE = process.env.LITEMATIC || '/app/tests/fixtures/iron-farm-34.litematic';
const names = Array.from({ length: BOTS }, (_, i) => `Bd${T.WORLD}${'abcdefghijkl'[i]}`);
const sleep = T.sleep, strip = T.strip;
const rnd = T.rng(Number(process.env.SEED_SITE || Date.now() % 1e9));
const dimCmd = (c) => (NETHER ? (/^execute /.test(c) ? c.replace(/^execute /, 'execute in minecraft:the_nether ') : `execute in minecraft:the_nether run ${c}`) : c);
const STACK = (it) => (/(_bed|_bucket|flint_and_steel|shulker_box|_sword|_pickaxe|_shovel|_axe)$/.test(it) ? 1 : /(_sign|snowball|egg|ender_pearl)$/.test(it) ? 16 : 64);

async function main() {
    const rep = T.reporter(NETHER ? 'build_t_nether' : 'build_t');
    const { S: S0, svc, seed } = await T.open(names, { teleport: 'off', autoKit: false });
    const srv = { cmd: (c) => S0.cmd(dimCmd(c)), must: (c) => S0.must(dimCmd(c)) };
    const bot0 = () => svc.bots.get(names[0]).bot;
    await S0.cmd('gamerule keep_inventory false');
    for (const n of names) { await S0.must(`gamemode survival ${n}`); await S0.cmd(`clear ${n}`); }
    const file = fs.readFileSync(FILE), parsed = lit.parse(file);
    const placed0 = lit.place(parsed, { pos: { x: 0, y: 0, z: 0 }, rotation: 'NONE', mirror: 'NONE' }, { keepAir: true });
    const [sx, sy, sz] = placed0.bp.size;
    // ---- the site: natural terrain near the spawn (Nether: near the spawn's Nether coordinates), a random direction and distance ----
    const sp = bot0().spawnPoint || bot0().entity.position;
    const scout = svc.bots.get(names[0]).bot;
    await S0.must(`gamemode spectator ${names[0]}`);                                                   // the site is looked at from above (setup only: no fall)
    const at = (x, y, z) => { const b = scout.blockAt(new Vec3(x, y, z)); return b ? b.name : null; };
    // a site on land (Overworld: a farm is not built in the sea; at most a tenth of the footprint's surface water), up to twelve draws
    let cx, cz;
    for (let draw = 0; draw < 30; draw++) {
        const ang = rnd() * Math.PI * 2, dist = 40 + rnd() * 60 + draw * 60;
        cx = Math.floor((NETHER ? sp.x / 8 : sp.x) + Math.cos(ang) * dist); cz = Math.floor((NETHER ? sp.z / 8 : sp.z) + Math.sin(ang) * dist);
        await srv.must(`tp ${names[0]} ${cx + 0.5} ${NETHER ? 100 : 250} ${cz + 0.5}`);
        await sleep(NETHER ? 6000 : 9000);
        if (NETHER) break;
        let wet = 0, n = 0;
        for (let x = cx - Math.floor(sx / 2); x < cx + sx / 2; x += 4) for (let z = cz - Math.floor(sz / 2); z < cz + sz / 2; z += 4) { for (let y = 200; y > -60; y--) { const b = at(x, y, z); if (b && b !== 'air' && !/leaves|log/.test(b)) { n++; if (/water|ice|kelp|seagrass/.test(b)) wet++; break; } } }
        console.log(`[build_t] site draw ${draw}: ${cx} ${cz}, ${wet}/${n} of the surface is water`);
        if (n && wet / n <= 0.1) break;
    }
    const GROUNDLESS = /^(air|cave_air|void_air|.*_leaves|.*_log|.*_wood|vine|short_grass|tall_grass|fern|large_fern|.*_flower|dandelion|poppy|snow|water|lava|bamboo|sugar_cane)$/;
    const groundY = (x, z, top) => { for (let y = top; y > (NETHER ? 32 : -60); y--) { const n = at(x, y, z); if (n && !GROUNDLESS.test(n)) return y; } return null; };
    let y0;
    if (NETHER) y0 = 40 + Math.floor(rnd() * 40);                                                       // somewhere inside the Nether's rock, above the lava sea, under the roof
    else { const g = groundY(cx, cz, 200); if (g === null) throw new Error('no ground under the site'); y0 = g + Math.floor(rnd() * 4) - 2; }
    const M = { x: cx - Math.floor(sx / 2), y: y0, z: cz - Math.floor(sz / 2) };
    const pos = { x: M.x - placed0.origin.x, y: M.y - placed0.origin.y, z: M.z - placed0.origin.z };
    const target = new Target(lit.place(parsed, { pos, rotation: 'NONE', mirror: 'NONE' }, { keepAir: true }).bp, M);
    console.log(`[build_t] seed ${seed} ${NETHER ? 'nether' : 'overworld'} box ${M.x} ${M.y} ${M.z} size ${sx}x${sy}x${sz}; ${[...target.items.values()].reduce((a, b) => a + b, 0)} items, ${target.portals.length} portals`);
    // ---- the chest: on solid ground beside the box, two cells of air above it ----
    let C = null;
    const noLava = (x, y, z) => { for (let dx = -2; dx <= 3; dx++) for (let dy = -2; dy <= 3; dy++) for (let dz = -2; dz <= 2; dz++) if (/lava/.test(at(x + dx, y + dy, z + dz) || '')) return false; return true; };
    const spot = (x, y, z) => { const n = at(x, y, z), n2 = at(x + 1, y, z); return n && n2 && !GROUNDLESS.test(n) && !GROUNDLESS.test(n2) && [at(x, y + 1, z), at(x, y + 2, z), at(x + 1, y + 1, z), at(x + 1, y + 2, z)].every((q) => /^(cave_)?air$/.test(q || '')) && noLava(x, y, z); };      // the chest not beside lava (bots stand there)
    for (let wait = 0; wait < 4 && !C; wait++) {
        if (wait) await sleep(5000);
        for (let r = 3; r <= 24 && !C; r++) {
            const ring = []; for (let x = M.x - r; x <= M.x + sx - 1 + r; x++) { ring.push([x, M.z - r]); ring.push([x, M.z + sz - 1 + r]); } for (let z = M.z - r; z <= M.z + sz - 1 + r; z++) { ring.push([M.x - r, z]); ring.push([M.x + sx - 1 + r, z]); }
            for (const [x, z] of ring) {
                if (x + 1 >= M.x && x <= M.x + sx - 1 && z >= M.z && z <= M.z + sz - 1) continue;
                for (let y = M.y + sy; y >= M.y - 8 && !C; y--) if (spot(x, y, z)) C = { x, y: y + 1, z };
                if (C) break;
            }
        }
    }
    if (!C) throw new Error('no place for the chest');
    // materials: the blueprint's items plus the lighter and the buckets, in shulker boxes of 27 stacks, the boxes in a double chest (54 slots, a second double chest if needed)
    const items = new Map([...target.items].map(([k, n]) => [k, Math.ceil(n * 1.05)]));
    if (target.portals.length) items.set('flint_and_steel', Math.max(items.get('flint_and_steel') || 0, 2 + Math.ceil(target.portals.length / 20)));
    // temporary blocks (pillars, bridges, supports, fluid fills): the first scaffold block the blueprint does not use (a blueprint with dirt in it left the crew without any)
    { const tmp = SUP.TEMPS.find((n) => !items.has(n)); items.set(tmp, Number(process.env.TEMPS || 64 * 24)); }
    for (const [tool, n] of [['diamond_pickaxe', BOTS * 3], ['diamond_shovel', BOTS * 2], ['diamond_axe', BOTS]]) items.set(tool, n);
    const stacks = []; for (const [it, n] of items) { const st = STACK(it); for (let r = Math.max(1, n); r > 0; r -= st) stacks.push({ it, n: Math.min(st, r) }); }
    // shulker boxes the blueprint uses go loose into the chest (vanilla keeps a shulker box out of another one)
    const loose = stacks.filter((st) => SUP.SHULKER.test(st.it)), packed = stacks.filter((st) => !SUP.SHULKER.test(st.it));
    const boxes = []; for (let i = 0; i < packed.length; i += 27) boxes.push(packed.slice(i, i + 27));
    const chests = []; for (let i = 0; i < Math.ceil((boxes.length + loose.length) / 54); i++) chests.push({ x: C.x, y: C.y, z: C.z + i * 2 });
    await srv.must(`forceload add ${M.x - 16} ${M.z - 16} ${M.x + sx + 16} ${M.z + sz + 16}`);
    for (const ch of chests) {
        await srv.must(`setblock ${ch.x} ${ch.y} ${ch.z} minecraft:chest[facing=north,type=right] replace`);
        await srv.must(`setblock ${ch.x + 1} ${ch.y} ${ch.z} minecraft:chest[facing=north,type=left] replace`);
    }
    const tmp = { x: C.x, y: C.y + 3, z: C.z };
    for (const [bi, box] of boxes.entries()) {
        const ch = chests[Math.floor(bi / 54)], half = (bi % 54) < 27 ? 0 : 1, slot = bi % 27;
        await srv.must(`setblock ${tmp.x} ${tmp.y} ${tmp.z} minecraft:white_shulker_box replace`);
        for (const [j, st] of box.entries()) await srv.must(`item replace block ${tmp.x} ${tmp.y} ${tmp.z} container.${j} with minecraft:${st.it} ${st.n}`);
        await srv.must(`loot replace block ${ch.x + half} ${ch.y} ${ch.z} container.${slot} mine ${tmp.x} ${tmp.y} ${tmp.z} minecraft:iron_pickaxe`);
        await srv.must(`setblock ${tmp.x} ${tmp.y} ${tmp.z} minecraft:air replace`);
    }
    for (const [li, st] of loose.entries()) {
        const bi = boxes.length + li, ch = chests[Math.floor(bi / 54)], half = (bi % 54) < 27 ? 0 : 1, slot = bi % 27;
        await srv.must(`item replace block ${ch.x + half} ${ch.y} ${ch.z} container.${slot} with minecraft:${st.it} ${st.n}`);
    }
    console.log(`[build_t] chest at ${C.x} ${C.y} ${C.z}: ${boxes.length} shulker boxes, ${stacks.length} stacks, ${items.size} item types`);
    // ---- the crew: beside the chest, survival; the materials chest tagged for the console ----
    for (const [i, n] of names.entries()) await srv.must(`tp ${n} ${C.x + 0.3 + (i % 2) * 0.9} ${C.y + 1} ${C.z + 0.5}`);
    await S0.must(`gamemode survival ${names[0]}`);          // on top of the chest (two cells of air were checked there); players do not collide
    await sleep(5000);
    for (const [i, ch] of chests.entries()) svc.addSite({ name: `mats${i}`, x: ch.x, y: ch.y, z: ch.z, purpose: 'materials', ...(NETHER ? { dim: 'nether' } : {}) });
    const control = await judge(srv, target), controlFails = control.wrong.length > 0;
    console.log(`[build_t] negative control: the untouched site has ${control.wrong.length} wrong cells`);
    await T.say(S0, `build_t: ${BOTS} bots build ${parsed.meta.name} at ${M.x} ${M.y} ${M.z}${NETHER ? ' (nether)' : ''}`);
    const t0 = Date.now(); let state = 'control', job = null, err = null;
    if (!T.CONTROL) {
        try {
            const v = svc.createConstruct({ file, placement: { pos, rotation: 'NONE', mirror: 'NONE' }, name: parsed.meta.name, bots: names, start: true, dim: NETHER ? 'nether' : 'overworld' });
            job = svc.jobs.get(v.id);
            let last = 0;
            while (Date.now() - t0 < LIMIT_MIN * 60000) {
                if (job.state === 'finished' || job.state === 'cancelled') { state = job.state; break; }
                if (Date.now() - last > 60000) { last = Date.now(); const s = job.impl.build.status(); console.log(`[progress ${Math.round((Date.now() - t0) / 60000)} min] stage ${s.stage} right ${s.right}/${s.total} work ${JSON.stringify(s.work)} claimed ${s.claimed} parked ${s.parked} frontier ${s.frontier} time ${JSON.stringify(s.time)} stats ${JSON.stringify(s.stats)}`); }
                await sleep(2000);
            }
            if (state === 'control') state = 'timeout';
        } catch (e) { err = e.message; state = 'error'; console.error(e); }
    }
    for (const l of svc.log.filter((e) => /job j/.test(e.msg || e.message || '')).slice(-40)) console.log(`[log] ${l.msg || l.message}`);
    await sleep(8000);                                                                                     // the circuit and the fluids settle
    // ---- the judge: every cell of the box, asked of the server ----
    const J = await judge(srv, target), wrong = J.wrong, dynamic = J.dynamic, strict = J.wrong.length === 0 && J.dynamic.length === 0;
    const wrongBy = {}; for (const w of wrong) { const k = w.want.replace(/\[.*$/, ''); wrongBy[k] = (wrongBy[k] || 0) + 1; }
    const dynBy = {}; for (const w of dynamic) { const k = w.want.replace(/\[.*$/, ''); dynBy[k] = (dynBy[k] || 0) + 1; }
    const res = job ? job.impl.build.result : null, st = job ? job.impl.build.status() : null;
    console.log(`[judge] ${J.checked} cells checked; WRONG ${wrong.length} ${JSON.stringify(wrongBy)}; right in what the builder decides but not in what the world decides (power, connections, flows): ${dynamic.length} ${JSON.stringify(dynBy)}; cells in front of pistons in the other phase: ${J.phase.length}`);
    for (const w of wrong.slice(0, 40)) console.log(`  wrong ${w.at.join(',')} want ${w.want}`);
    const pass = controlFails && state === 'finished' && wrong.length === 0;
    rep.trial(`${parsed.meta.name}${NETHER ? '@nether' : ''}`, pass, { state, err, minutes: Math.round((Date.now() - t0) / 6000) / 10, strict, wrong: wrong.length, wrongBy, wrongCells: wrong.slice(0, 80), dynamic: dynamic.length, dynamicBy: dynBy, dynamicCells: dynamic.slice(0, 40), phaseCells: J.phase.length, controlFails, box: M, size: [sx, sy, sz], chest: C, boxes: boxes.length, result: res, status: st, history: job ? job.impl.build.history : null, seed });
    rep.write({ seed, file: FILE, required: '100 %' });
    await srv.cmd(`forceload remove ${M.x - 16} ${M.z - 16} ${M.x + sx + 16} ${M.z + sz + 16}`);
    await svc.stop(); process.exit(pass ? 0 : 1);
}

/**
 * Every cell of the box against the target, by the server (`execute if block`): wrong = the block or a property the builder decides differs (a fluid where air belongs, a flow outside its
 * place, a block left behind); dynamic = right in what the builder decides, different in what the world decides (power, connections, an extended piston and its head, a flow's level).
 */
async function judge(srv, target) {
    const wrong = [], dynamic = [], phase = [];
    const is = async (c, st) => /^Test passed/.test(strip(await srv.cmd(`execute if block ${c.x} ${c.y} ${c.z} ${st}`)));
    // pistons the world holds in the other phase than the blueprint's: the cells in front are judged as that phase leaves them (src/build/pistons.js), and counted apart
    const over = new Map();
    for (const p of target.pistons) {
        const st = target.stateOf(p.i);
        if (!(await is(p.at, `minecraft:${st.name}[facing=${st.props.facing},extended=${!p.extended}]`))) continue;
        const cells = P.otherPhase(target, p); if (!cells) continue;
        for (const c of cells) if (target.inside(c.x, c.y, c.z)) over.set(target.idx(c.x, c.y, c.z), c.state || { name: 'air', props: {} });
    }
    const jobs = [];
    for (let i = 0; i < target.n; i++) jobs.push(i);
    const one = async (i) => {
        const c = target.cell(i), want = over.has(i) ? over.get(i) : target.stateOf(i), wn = want.name, rel = [c.x - target.box.x, c.y - target.box.y, c.z - target.box.z];
        let ok, exact = true;
        if (S.AIR.has(wn)) { ok = (await is(c, 'minecraft:air')) || (await is(c, 'minecraft:cave_air')) || (await is(c, 'minecraft:void_air')); if (!ok && ((await is(c, 'minecraft:piston_head')) || (await is(c, 'minecraft:moving_piston')))) { ok = true; exact = false; } }
        else if (S.FLUIDS.has(wn)) {
            if (Number(want.props.level || 0) > 0) { ok = (await is(c, `minecraft:${wn}`)) || (await is(c, 'minecraft:air')); exact = ok && (await is(c, S.str(wn, want.props))); }
            else ok = await is(c, `minecraft:${wn}[level=0]`);
        } else if (wn === 'piston_head') { ok = (await is(c, 'minecraft:piston_head')) || (await is(c, 'minecraft:air')) || (await is(c, 'minecraft:moving_piston')); exact = ok && (await is(c, S.str(wn, want.props))); }
        else { ok = await is(c, S.str(wn, S.decidedProps(wn, want.props))); if (ok && Object.keys(want.props).length) exact = await is(c, S.str(wn, want.props)); }
        if (!ok) wrong.push({ at: rel, want: S.str(wn, want.props), ...(over.has(i) ? { phase: true } : {}) });
        else if (over.has(i)) phase.push({ at: rel, want: S.str(wn, want.props) });
        else if (!exact) dynamic.push({ at: rel, want: S.str(wn, want.props) });
    };
    for (let k = 0; k < jobs.length; k += 64) await Promise.all(jobs.slice(k, k + 64).map(one));
    return { wrong, dynamic, phase, checked: jobs.length, phasedPistons: [...new Set([...over.keys()])].length };
}

main().catch((e) => { console.error(e); process.exit(2); });

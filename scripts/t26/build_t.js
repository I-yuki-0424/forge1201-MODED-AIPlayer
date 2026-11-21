'use strict';
// T26 test BUILD T (owner 2026-11-21, TASK-20261121-073): a creative crew builds a Litematica blueprint on NATURAL terrain of a new random world, Peaceful. The only setup: the materials
// in shulker boxes inside a chest (a double chest) on the ground beside the site, and the bots put beside it in creative mode. The job is created and run by the work console's own service
// (createConstruct: the same code as the Litematica page). Judged by the SERVER: the box against a reference copy made by commands from the blueprint, every differing cell tested for the
// block and the properties the builder decides (power, connections, lit, extended, occupied, flowing fluid levels are the world's); a trial passes when the job ends by itself and no cell is wrong.
//   scripts/t26/run.sh N build_t.js LITEMATIC=/app/tests/fixtures/iron-farm-34.litematic [DIM=nether] [BOTS=8] [LIMIT_MIN=120] [SEED_SITE=n] [CONTROL=noop]
const fs = require('fs');
const T = require('./lib');
const { Vec3 } = require('vec3');
const lit = require('../../src/work/jobs/litematic');
const S = require('../../src/build/state');
const { Target } = require('../../src/build/target');

const NETHER = (process.env.DIM || 'overworld') === 'nether', BOTS = Math.min(12, Math.max(1, Number(process.env.BOTS || 8))), LIMIT_MIN = Number(process.env.LIMIT_MIN || 120);
const FILE = process.env.LITEMATIC || '/app/tests/fixtures/iron-farm-34.litematic';
const names = Array.from({ length: BOTS }, (_, i) => `Bd${T.WORLD}${'abcdefghijkl'[i]}`);
const sleep = T.sleep, strip = T.strip;
const rnd = T.rng(Number(process.env.SEED_SITE || Date.now() % 1e9));
const dimCmd = (c) => (NETHER ? (/^execute /.test(c) ? c.replace(/^execute /, 'execute in minecraft:the_nether ') : `execute in minecraft:the_nether run ${c}`) : c);
const STACK = (it) => (/(_bed|_bucket|flint_and_steel|shulker_box|_sword|_pickaxe)$/.test(it) ? 1 : /(_sign|snowball|egg|ender_pearl)$/.test(it) ? 16 : 64);

async function main() {
    const rep = T.reporter(NETHER ? 'build_t_nether' : 'build_t');
    const { S: S0, svc, seed } = await T.open(names, { teleport: 'off', autoKit: false });
    const srv = { cmd: (c) => S0.cmd(dimCmd(c)), must: (c) => S0.must(dimCmd(c)) };
    const bot0 = () => svc.bots.get(names[0]).bot;
    for (const n of names) { await S0.must(`gamemode creative ${n}`); await S0.cmd(`clear ${n}`); }
    const file = fs.readFileSync(FILE), parsed = lit.parse(file);
    const placed0 = lit.place(parsed, { pos: { x: 0, y: 0, z: 0 }, rotation: 'NONE', mirror: 'NONE' }, { keepAir: true });
    const [sx, sy, sz] = placed0.bp.size;
    // ---- the site: natural terrain near the spawn (Nether: near the spawn's Nether coordinates), a random direction and distance ----
    const sp = bot0().spawnPoint || bot0().entity.position, ang = rnd() * Math.PI * 2, dist = 40 + rnd() * 60;
    const cx = Math.floor((NETHER ? sp.x / 8 : sp.x) + Math.cos(ang) * dist), cz = Math.floor((NETHER ? sp.z / 8 : sp.z) + Math.sin(ang) * dist);
    const scout = svc.bots.get(names[0]).bot;
    await srv.must(`tp ${names[0]} ${cx + 0.5} ${NETHER ? 100 : 250} ${cz + 0.5}`);
    await sleep(NETHER ? 6000 : 9000);
    const at = (x, y, z) => { const b = scout.blockAt(new Vec3(x, y, z)); return b ? b.name : null; };
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
    const spot = (x, y, z) => { const n = at(x, y, z), n2 = at(x + 1, y, z); return n && n2 && !GROUNDLESS.test(n) && !GROUNDLESS.test(n2) && [at(x, y + 1, z), at(x, y + 2, z), at(x + 1, y + 1, z), at(x + 1, y + 2, z)].every((q) => /^(cave_)?air$/.test(q || '')); };
    for (let wait = 0; wait < 4 && !C; wait++) {
        if (wait) await sleep(5000);
        for (let r = 3; r <= 16 && !C; r++) {
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
    const items = new Map(target.items); if (target.portals.length) items.set('flint_and_steel', 1);
    const stacks = []; for (const [it, n] of items) { const st = STACK(it); for (let r = Math.max(1, n); r > 0; r -= st) stacks.push({ it, n: Math.min(st, r) }); }
    const boxes = []; for (let i = 0; i < stacks.length; i += 27) boxes.push(stacks.slice(i, i + 27));
    const chests = []; for (let i = 0; i < Math.ceil(boxes.length / 54); i++) chests.push({ x: C.x, y: C.y, z: C.z + i * 2 });
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
    console.log(`[build_t] chest at ${C.x} ${C.y} ${C.z}: ${boxes.length} shulker boxes, ${stacks.length} stacks, ${items.size} item types`);
    // the reference copy: the target by commands, far from the site (Overworld: in the sky 300 blocks east; Nether: above the bedrock roof)
    const ref = NETHER ? { x: M.x, y: 140, z: M.z } : { x: M.x + 300, y: Math.min(319 - sy, 250), z: M.z };
    await srv.must(`forceload add ${ref.x - 2} ${ref.z - 2} ${ref.x + sx + 2} ${ref.z + sz + 2}`);
    for (let xa = ref.x; xa < ref.x + sx; xa += 32) for (let ya = ref.y; ya < ref.y + sy; ya += 16) await srv.cmd(`fill ${xa} ${ya} ${ref.z} ${Math.min(xa + 31, ref.x + sx - 1)} ${Math.min(ya + 15, ref.y + sy - 1)} ${ref.z + sz - 1} minecraft:air`);
    const fluids = [], portals = [];
    for (let i = 0; i < target.n; i++) {
        if (target.isAir(i)) continue;
        const st = target.stateOf(i), c = target.cell(i), r = { x: ref.x + c.x - M.x, y: ref.y + c.y - M.y, z: ref.z + c.z - M.z };
        if (S.FLUIDS.has(st.name)) { fluids.push([r, st]); continue; }
        if (st.name === 'nether_portal') { portals.push([r, st]); continue; }
        await srv.cmd(`setblock ${r.x} ${r.y} ${r.z} ${S.str(st.name, st.props)} strict`);
    }
    for (const [r, st] of [...fluids, ...portals]) await srv.cmd(`setblock ${r.x} ${r.y} ${r.z} ${S.str(st.name, st.props)} strict`);
    // ---- the crew: beside the chest, creative; the materials chest tagged for the console ----
    for (const [i, n] of names.entries()) await srv.must(`tp ${n} ${C.x + 0.3 + (i % 2) * 0.9} ${C.y + 1} ${C.z + 0.5}`);          // on top of the chest (two cells of air were checked there); players do not collide
    await sleep(5000);
    for (const [i, ch] of chests.entries()) svc.addSite({ name: `mats${i}`, x: ch.x, y: ch.y, z: ch.z, purpose: 'materials', ...(NETHER ? { dim: 'nether' } : {}) });
    const box = { a: M, b: ref, size: [sx, sy, sz] };
    const matchAll = async () => /^Test passed/.test(strip(await diffQuery(srv, box, [0, 0, 0], [sx, sy, sz])));
    const controlFails = !(await matchAll());
    await T.say(S0, `build_t: ${BOTS} bots build ${parsed.meta.name} at ${M.x} ${M.y} ${M.z}${NETHER ? ' (nether)' : ''}`);
    const t0 = Date.now(); let state = 'control', job = null, err = null;
    if (!T.CONTROL) {
        try {
            const v = svc.createConstruct({ file, placement: { pos, rotation: 'NONE', mirror: 'NONE' }, name: parsed.meta.name, bots: names, start: true, dim: NETHER ? 'nether' : 'overworld' });
            job = svc.jobs.get(v.id);
            let last = 0;
            while (Date.now() - t0 < LIMIT_MIN * 60000) {
                if (job.state === 'finished' || job.state === 'cancelled') { state = job.state; break; }
                if (Date.now() - last > 60000) { last = Date.now(); const s = job.impl.build.status(); console.log(`[progress ${Math.round((Date.now() - t0) / 60000)} min] stage ${s.stage} right ${s.right}/${s.total} work ${JSON.stringify(s.work)} claimed ${s.claimed} parked ${s.parked} frontier ${s.frontier} stats ${JSON.stringify(s.stats)}`); }
                await sleep(2000);
            }
            if (state === 'control') state = 'timeout';
        } catch (e) { err = e.message; state = 'error'; console.error(e); }
    }
    for (const l of svc.log.filter((e) => /job j/.test(e.msg || e.message || '')).slice(-40)) console.log(`[log] ${l.msg || l.message}`);
    await sleep(8000);                                                                                     // the circuit and the fluids settle
    // ---- the judge ----
    const strict = await matchAll();
    const diffs = strict ? [] : await differing(srv, box, 20000);
    const wrong = [], dynamic = [];
    for (const o of diffs) {
        const x = M.x + o[0], y = M.y + o[1], z = M.z + o[2], want = target.at(x, y, z), wn = want.name;
        const is = async (st) => /^Test passed/.test(strip(await srv.cmd(`execute if block ${x} ${y} ${z} ${st}`)));
        let ok;
        if (S.AIR.has(wn)) ok = (await is('minecraft:air')) || (await is('minecraft:cave_air')) || (await is('minecraft:piston_head')) || (await is('minecraft:moving_piston'));
        else if (S.FLUIDS.has(wn)) ok = Number(want.props.level || 0) > 0 ? (await is(`minecraft:${wn}`)) || (await is('minecraft:air')) : await is(`minecraft:${wn}[level=0]`);
        else if (wn === 'piston_head' || wn === 'moving_piston') ok = (await is('minecraft:air')) || (await is('minecraft:piston_head')) || (await is('minecraft:moving_piston'));
        else ok = await is(S.str(wn, S.decidedProps(wn, want.props)));
        (ok ? dynamic : wrong).push({ at: o, want: S.str(wn, want.props) });
    }
    const wrongBy = {}; for (const w of wrong) { const k = w.want.replace(/\[.*$/, ''); wrongBy[k] = (wrongBy[k] || 0) + 1; }
    const res = job ? job.impl.build.result : null, st = job ? job.impl.build.status() : null;
    console.log(`[judge] strict ${strict}; ${diffs.length} cells differ from the reference, ${dynamic.length} only in what the world decides; WRONG ${wrong.length} ${JSON.stringify(wrongBy)}`);
    for (const w of wrong.slice(0, 40)) console.log(`  wrong ${w.at.join(',')} want ${w.want}`);
    const pass = controlFails && state === 'finished' && wrong.length === 0;
    rep.trial(`${parsed.meta.name}${NETHER ? '@nether' : ''}`, pass, { state, err, minutes: Math.round((Date.now() - t0) / 6000) / 10, strict, wrong: wrong.length, wrongBy, wrongCells: wrong.slice(0, 80), dynamic: dynamic.length, controlFails, box: M, size: [sx, sy, sz], chest: C, boxes: boxes.length, result: res, status: st, history: job ? job.impl.build.history : null, seed });
    rep.write({ seed, file: FILE, required: '100 %' });
    await srv.cmd(`forceload remove ${M.x - 16} ${M.z - 16} ${M.x + sx + 16} ${M.z + sz + 16}`);
    await svc.stop(); process.exit(pass ? 0 : 1);
}

/** `execute if blocks` of the sub-box at offset o, size s (the server allows 32768 cells per query: larger boxes are split). */
async function diffQuery(srv, box, o, s) {
    const { a, b } = box;
    if (s[0] * s[1] * s[2] > 32768) {
        const k = s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2, h = Math.floor(s[k] / 2), s1 = [...s], s2 = [...s], o2 = [...o]; s1[k] = h; s2[k] = s[k] - h; o2[k] += h;
        const r1 = await diffQuery(srv, box, o, s1); if (!/^Test passed/.test(strip(r1))) return r1;
        return diffQuery(srv, box, o2, s2);
    }
    return srv.cmd(`execute if blocks ${a.x + o[0]} ${a.y + o[1]} ${a.z + o[2]} ${a.x + o[0] + s[0] - 1} ${a.y + o[1] + s[1] - 1} ${a.z + o[2] + s[2] - 1} ${b.x + o[0]} ${b.y + o[1]} ${b.z + o[2]} all`);
}
/** Every cell where the box differs from the reference (halving), at most `max`. */
async function differing(srv, box, max) {
    const out = [];
    const walk = async (o, s) => {
        if (out.length >= max) return;
        if (/^Test passed/.test(strip(await diffQuery(srv, box, o, s)))) return;
        if (s[0] * s[1] * s[2] === 1) { out.push(o); return; }
        const k = s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2, h = Math.floor(s[k] / 2), s1 = [...s], s2 = [...s], o2 = [...o]; s1[k] = h; s2[k] = s[k] - h; o2[k] += h;
        await walk(o, s1); await walk(o2, s2);
    };
    await walk([0, 0, 0], box.size);
    return out;
}

main().catch((e) => { console.error(e); process.exit(2); });

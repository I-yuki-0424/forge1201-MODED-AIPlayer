'use strict';
// T26 test PLACE C (owner 2026-11-17): a bot builds a Litematica blueprint that reached it THROUGH SYNCMATICA, in mid-air, from supply chests, and the SERVER compares the result.
//   - the file (default tests/fixtures/easy-ironfarm-fixd.litematic = the owner's E:\...\iron-farm\easy-ironfarm-fixd.litematic, a simple iron golem trap) is uploaded by one bot as a Syncmatica
//     placement (the owner does the same from Litematica), the builder bot reads the list, downloads the file, parses it, applies the placement (origin, rotation, mirror) and builds it;
//   - the world: survival (keep inventory on), peaceful; the site is a flat stone deck in the sky (200 up), nothing else near; every item of the material list (as the plan counts it: buckets for
//     fluid sources and waterlogged blocks) is in tagged chests (purpose `free`) on the deck; the builder has the tools and 64 cobblestone for temporary blocks, nothing more;
//   - judge: the box of the blueprint is compared with a REFERENCE copy that the harness makes by commands (every cell, air included: `execute if blocks ... all`); the empty site must NOT match.
//     The strict comparison includes properties the game derives (power, lit, extended ...): they can differ without the structure being wrong, so the report also lists every differing cell
//     and says whether the difference is only in such a property ("static" verdict: same block, same placement-decided properties, same fluids).
//   2026-11-21 (TASK-20261121-071, the owner's iron-farm-34 and its Nether side): DIM=nether builds in the Nether (every coordinate command runs `execute in minecraft:the_nether`), SITE_X / SITE_Z / SITE_Y place the box
//   (the old iron golem trap's site stays untouched), TEMP_BLOCK=pumpkin (temporary blocks you can see; the kit and the chests hold them; the bots' scripts use them: src/work/bot/tempblocks.js), SURPLUS=1.1 (material
//   list x 1.1 + a few), RESUME=1 (the site, the reference copy and the chests are left as they are: a run continues what stands, the judge is the same), LITEMATIC=<file>. Entities of a blueprint are ignored.
//   scripts/t26/run.sh N place_c.js [BOTS=3] [BUILD_MODE=area|layer|zlayer] [BUILD_WINDOW=n] [LIMIT_MIN=20 (= 60 / BOTS)] [TRIALS=1] [CONTROL=noop] [LITEMATIC=/app/tests/fixtures/x.litematic] [ROT=CLOCKWISE_90] [MIR=LEFT_RIGHT] [KEEP_SITE=1]
const fs = require('fs'), path = require('path');
const T = require('./lib');
const { createBot, attachHandshake } = require('../../src/transport');
const sm = require('../../src/transport/syncmatica');
const lit = require('../../src/work/jobs/litematic');
const build = require('../../src/work/jobs/build');
const O = require('../../src/work/jobs/orient');
const TRIALS = Number(process.env.TRIALS || 1), BOTS = Math.min(8, Math.max(1, Number(process.env.BOTS || 3)));
const NETHER = (process.env.DIM || 'overworld') === 'nether', RESUME = process.env.RESUME === '1', SURPLUS = Number(process.env.SURPLUS || 2), TEMP = process.env.TEMP_BLOCK || 'cobblestone', SITE_Y = Number(process.env.SITE_Y || (NETHER ? 64 : 200));
const LIMIT_MIN = Number(process.env.LIMIT_MIN || Math.round(60 / BOTS));          // the owner's bar (2026-11-18): within one hour / the number of bots (3 bots: 20 minutes)
const names = Array.from({ length: BOTS }, (_, i) => `Fm${T.WORLD}${'abcdefgh'[i - 1] || ''}`), name = names[0];      // BOTS=n: n builders on one job (the crew ledger shares the units)
const FILE = process.env.LITEMATIC || path.join(__dirname, '../../tests/fixtures/easy-ironfarm-fixd.litematic');
const STACK = { white_bed: 1, water_bucket: 1, lava_bucket: 1, oak_sign: 16, snowball: 16, flint_and_steel: 1, white_shulker_box: 1 };
const ONE = new Set(['white_bed', 'water_bucket', 'lava_bucket', 'flint_and_steel', 'white_shulker_box']);     // not stackable: a few spare, not a percentage
const sleep = T.sleep, strip = T.strip;
let moves = {};

/** Upload the file as a Syncmatica placement with a throw-away bot (what the owner's Litematica does with "share"); resolves the placement the server lists. */
async function shareFile(file, pos, rotation, mirror) {
    const bot = createBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: `Sh${T.WORLD}`, viewDistance: 2 });
    attachHandshake(bot, { registry: 'vanilla' });
    const c = bot.syncmatica;
    await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', (r) => rej(new Error('kicked ' + JSON.stringify(r)))); });
    await Promise.race([new Promise((r) => c.once('ready', r)), sleep(20000)]);
    if (!c.ready) throw new Error('Syncmatica did not answer (is the mod on this server?)');
    const parsed = lit.parse(file);
    const p = await c.share({ file, name: parsed.meta.name || 'blueprint', pos, rotation, mirror, owner: '00000000-0000-0000-0000-0000000000a1', ownerName: bot.username, dataVersion: parsed.meta.dataVersion || 0 });
    await sleep(1500); bot.quit(); await sleep(300);
    return p;
}

/** Compare two boxes cell by cell by halving: the cells that differ (at most `max`). Each query is one `execute if blocks` on the server. */
async function differing(S, a, b, size, max = 60) {
    const same = async (o, s) => /^Test passed/.test(strip(await S.cmd(`execute if blocks ${a.x + o[0]} ${a.y + o[1]} ${a.z + o[2]} ${a.x + o[0] + s[0] - 1} ${a.y + o[1] + s[1] - 1} ${a.z + o[2] + s[2] - 1} ${b.x + o[0]} ${b.y + o[1]} ${b.z + o[2]} all`)));
    const out = [], walk = async (o, s) => {
        if (out.length >= max || await same(o, s)) return;
        if (s[0] * s[1] * s[2] === 1) { out.push(o); return; }
        const k = s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2, h = Math.floor(s[k] / 2);
        const s1 = [...s], s2 = [...s], o2 = [...o]; s1[k] = h; s2[k] = s[k] - h; o2[k] += h;
        await walk(o, s1); await walk(o2, s2);
    };
    await walk([0, 0, 0], size);
    return out;
}

/** In the Nether every command that has a place runs in that dimension; commands without one (give, clear, tellraw, gamerule ...) are left alone. */
function inDim(S0) {
    if (!NETHER) return S0;
    const wrap = (c) => (/^(give|clear|effect|tellraw|gamemode|scoreboard|gamerule|difficulty|seed|kill|time|weather|script|say)\b/.test(c) ? c : /^execute /.test(c) ? c.replace(/^execute /, 'execute in minecraft:the_nether ') : `execute in minecraft:the_nether run ${c}`);
    return { ...S0, cmd: (c, ...a) => S0.cmd(wrap(c), ...a), must: (c, ...a) => S0.must(wrap(c), ...a) };
}

async function trial(k, S0, svc, seed, rep) {
    const S = inDim(S0);
    const file = fs.readFileSync(FILE), parsed = lit.parse(file), probe = lit.toBlueprint(parsed, { keepAir: false });
    const placement0 = { rotation: process.env.ROT || 'NONE', mirror: process.env.MIR || 'NONE' };
    const p0 = await T.posOf(S, name);
    // the site: the box's minimum corner M at height 200 (Nether 64), 100 blocks apart for the trials, around the spawn; SITE_X / SITE_Z put it elsewhere (the older sites of a world are not touched)
    const base = { x: process.env.SITE_X !== undefined ? Number(process.env.SITE_X) + k * 100 : Math.floor(p0.x) + 60 + k * 100, z: process.env.SITE_Z !== undefined ? Number(process.env.SITE_Z) : Math.floor(p0.z) - 20 };
    const placed = lit.place(parsed, { pos: { x: 0, y: 0, z: 0 }, ...placement0 }, { keepAir: true });
    const [sx, sy, sz] = placed.bp.size;
    const M = { x: base.x, y: SITE_Y, z: base.z };
    const pos = { x: M.x - placed.origin.x, y: M.y - placed.origin.y, z: M.z - placed.origin.z };       // the Syncmatica placement origin that puts the box's corner at M
    const X1 = M.x + sx - 1, Y1 = M.y + sy - 1, Z1 = M.z + sz - 1;
    const ref = { x: M.x, y: M.y, z: M.z + sz + 40 };
    await S.must(`forceload add ${M.x - 8} ${M.z - 8} ${X1 + 8} ${ref.z + sz + 8}`);
    // clear (air) the box and the margin, lay the deck: one layer of stone under the box, 4 wide margin around (RESUME=1: what stands is kept)
    if (!RESUME) {
        for (const [x0, z0, x1, z1] of [[M.x - 6, M.z - 6, X1 + 6, Z1 + 6], [ref.x - 3, ref.z - 3, ref.x + sx + 2, ref.z + sz + 2]]) {
            for (let xa = x0; xa <= x1; xa += 24) for (let za = z0; za <= z1; za += 24) for (let y = M.y - 2; y <= Y1 + 6; y += 8)
                await S.must(`fill ${xa} ${y} ${za} ${Math.min(xa + 23, x1)} ${Math.min(y + 7, Y1 + 6)} ${Math.min(za + 23, z1)} minecraft:air`);
        }
        await S.must(`fill ${M.x - 6} ${M.y - 1} ${M.z - 6} ${X1 + 6} ${M.y - 1} ${Z1 + 6} minecraft:stone`);
        // The Nether (live 2026-11-21: three bots "tried to swim in lava" in the first minute, lava ran onto the cleared deck): the cleared space is walled in with stone, sides and roof, the box and its
        // reference copy each; the bots work inside. Nothing can flow in; the walls are 1 beyond the cleared margin.
        if (NETHER) for (const [x0, z0, x1, z1] of [[M.x - 6, M.z - 6, X1 + 6, Z1 + 6], [ref.x - 3, ref.z - 3, ref.x + sx + 2, ref.z + sz + 2]]) {
            const top = Y1 + 7, a = x0 - 1, b = x1 + 1, c = z0 - 1, d = z1 + 1;
            await S.must(`fill ${a} ${M.y - 2} ${c} ${b} ${M.y - 2} ${d} minecraft:stone`);                      // under the deck
            await S.must(`fill ${a} ${M.y - 1} ${c} ${a} ${top} ${d} minecraft:stone`); await S.must(`fill ${b} ${M.y - 1} ${c} ${b} ${top} ${d} minecraft:stone`);
            await S.must(`fill ${a} ${M.y - 1} ${c} ${b} ${top} ${c} minecraft:stone`); await S.must(`fill ${a} ${M.y - 1} ${d} ${b} ${top} ${d} minecraft:stone`);
            for (let xa = a; xa <= b; xa += 40) await S.must(`fill ${xa} ${top} ${c} ${Math.min(xa + 39, b)} ${top} ${d} minecraft:stone`);   // the roof
        }
    }
    // the reference copy, from the same blueprint with every state (dynamic ones included), then settle
    const pl = lit.place(parsed, { pos, ...placement0 }, { keepAir: false });
    // cells the survival game cannot hold (a wall sign hung on a wall sign: pasted by commands): not part of the reference, reported
    const plan0 = build.planBuild(require('../../src/work/jobs/blueprint').cells(pl.bp), { x: 0, y: 0, z: 0 }, { tile: 64 }), never = new Set(plan0.unbuildable.map((u) => u.at));
    const fluids = [], solids = [], portals = [];
    for (const b of pl.bp.blocks) {
        if (never.has(`${b.x},${b.y},${b.z}`)) continue;
        const p = pl.bp.palette[b.s], st = build.kindOf({ block: p.name, props: p.props });
        if (/^minecraft:(piston_head|moving_piston)$/.test(p.name)) continue;                              // made by the circuit (power), not placed; a piston is set retracted and extends itself when powered
        if (p.name === 'minecraft:nether_portal') { portals.push({ b, p }); continue; }                     // the portal blocks go in last, when the frame stands
        (st === 'flow' || st === 'fluid' ? fluids : solids).push({ b, p });
    }
    const stateStr = (p) => `${p.name}${Object.keys(p.props).length ? '[' + Object.entries(p.props).map(([a, v]) => `${a}=${v}`).join(',') + ']' : ''}`;
    if (!RESUME) {
        for (const { b, p } of solids) { if (O.derivedCell(p.name, p.props) && /_bed$/.test(p.name) && p.props.part === 'head') continue; await S.cmd(`setblock ${ref.x + b.x} ${ref.y + b.y} ${ref.z + b.z} ${stateStr({ name: p.name, props: { ...p.props, ...(p.props.waterlogged ? { waterlogged: 'false' } : {}), ...(/piston$/.test(p.name) ? { extended: 'false' } : {}) } })} replace`); }
        for (const { b, p } of fluids) if (p.props.level === '0' || !p.props.level) await S.cmd(`setblock ${ref.x + b.x} ${ref.y + b.y} ${ref.z + b.z} ${p.name} replace`);
        for (const { b, p } of solids) if (p.props.waterlogged === 'true') await S.cmd(`setblock ${ref.x + b.x} ${ref.y + b.y} ${ref.z + b.z} ${stateStr(p)} replace`);
        for (const { b, p } of portals) await S.cmd(`setblock ${ref.x + b.x} ${ref.y + b.y} ${ref.z + b.z} ${stateStr(p)} replace`);
        // (the head half of a bed was placed by the foot's setblock)
        await sleep(20000);                                                                                   // water and lava flow, redstone settles
    }
    const bx = { a: M, b: ref, size: [sx, sy, sz] };
    const match = async () => /^Test passed/.test(strip(await S.cmd(`execute if blocks ${M.x} ${M.y} ${M.z} ${X1} ${Y1} ${Z1} ${ref.x} ${ref.y} ${ref.z} all`)));
    const controlOk = RESUME ? true : !(await match());
    // PREFILL=n (2026-11-18): the first n cells of the plan are set by commands before the bots start, so that the tail of the build (the upper layers, the fluids, trapdoors, gates, torches, the dirt
    // columns) can be tested in minutes instead of after twenty minutes of the rest. A test aid for the developer: the owner's run is PREFILL=0.
    const PRE = Number(process.env.PREFILL || 0);
    if (PRE > 0 && !RESUME) {
        const done = new Set();
        for (const c of plan0.list.slice(0, PRE)) {
            const ax = M.x + c.x, ay = M.y + c.y, az = M.z + c.z, props = { ...(c.props || {}) };
            if (c.waterlog) { await S.cmd(`setblock ${ax} ${ay} ${az} ${stateStr({ name: 'minecraft:' + c.of, props: { ...(plan0.byKey.get(`${c.x},${c.y},${c.z}`) || {}).props, waterlogged: 'true' } })} replace`); continue; }
            if (/^(water|lava)$/.test(c.block)) { await S.cmd(`setblock ${ax} ${ay} ${az} minecraft:${c.block} replace`); continue; }
            if (c.props && 'waterlogged' in c.props) props.waterlogged = 'false';
            await S.cmd(`setblock ${ax} ${ay} ${az} ${stateStr({ name: 'minecraft:' + c.block, props })} replace`);
            done.add(c.k);
        }
        await sleep(15000);
        console.log(`[prefill] ${PRE} cells of the plan set by commands`);
    }
    // supply chests on the deck (tagged `free`), every item of the plan's material list
    const mats = plan0.materials;                                                                             // the plan's own list: lightings count as flint and steel, derived cells not at all
    const stacks = []; for (const [it, n0] of Object.entries(mats)) { const n = ONE.has(it) ? n0 + Math.ceil(n0 * (SURPLUS - 1)) + 2 : Math.ceil(n0 * SURPLUS), ms = STACK[it] || 64; for (let r = n; r > 0; r -= ms) stacks.push({ it, n: Math.min(ms, r) }); }      // SURPLUS 2 = the old default (several builders fetch a stack each and must not starve each other); the owner's run: 1.1
    for (let r = Number(process.env.TEMP_STOCK || 1024); r > 0; r -= 64) stacks.push({ it: TEMP, n: 64 });  // temporary blocks (pumpkins: the bots' drops come back to them, see scripts/t26/vacuum.sh)
    // The chests: the items with few stacks (lever, pistons, comparators ... ) together in the first chests, next to where the builders start; the bulk (glass, stone, beds, pumpkins) spread over all of them, so
    // that one visit to the nearest chest gives a bit of everything (the bots do not know what a chest holds: the first live run walked past 13 chests for one redstone).
    const byItem = new Map(); for (const st of stacks) (byItem.get(st.it) || byItem.set(st.it, []).get(st.it)).push(st);
    const rare = [], bulk = []; for (const [, list] of byItem) (list.length <= 6 ? rare : bulk).push(...list);
    const nCh = Math.ceil(stacks.length / 27) + 1, chests0 = Array.from({ length: nCh }, () => []);
    { let ci = 0; for (const st of rare) { while (chests0[ci].length >= 27) ci++; chests0[ci].push(st); } let cj = 0; for (const st of bulk) { let n = 0; while (chests0[cj % nCh].length >= 27 && n++ < nCh) cj++; chests0[cj % nCh].push(st); cj++; } }
    const chests = chests0.filter((c) => c.length);
    const sup = chests.map((_, i) => ({ x: M.x - 3, y: M.y, z: M.z + 3 * i }));
    for (let i = 0; i < chests.length; i++) {
        await S.must(`setblock ${sup[i].x} ${sup[i].y} ${sup[i].z} minecraft:chest[facing=east] replace`);
        const items = chests[i].map((s, j) => `{Slot:${j}b,id:"minecraft:${s.it}",count:${s.n}}`).join(',');
        await S.must(`data merge block ${sup[i].x} ${sup[i].y} ${sup[i].z} {Items:[${items}]}`);
    }
    // the builders stand on the deck (it reaches 6 beyond the box; the third bot used to stand outside it and fell 136 blocks)
    // a bot that dies comes back on the deck (a bed beside the site), not at the world spawn 250 blocks away with no way up
    for (const [i, n] of names.entries()) { const bx0 = M.x - 5.5, bz0 = M.z - 3.5 + i; await S.must(`tp ${n} ${bx0} ${M.y} ${bz0}`); await S.must(`spawnpoint ${n} ${Math.floor(bx0)} ${M.y} ${Math.floor(bz0)}`); await T.kit(S, n, { blocks: 320, block: TEMP }); }
    await sleep(4000);
    for (let i = 0; i < chests.length; i++) svc.addSite({ name: `supply${i}`, x: sup[i].x, y: sup[i].y, z: sup[i].z, purpose: 'free' });      // after the bot sees the chunk
    console.log(`[place_c site] box minimum ${M.x} ${M.y} ${M.z}, size ${sx} x ${sy} x ${sz}; reference copy at ${ref.x} ${ref.y} ${ref.z}; supply chests at x ${M.x - 3}; /tp ${M.x + 22} ${M.y + 30} ${M.z + 22} to look down on it`);
    await T.say(S, `place_c: ${name} builds ${parsed.meta.name} (${probe.blocks.length} blocks) at ${M.x} ${M.y} ${M.z}, trial ${k + 1}/${TRIALS}`);
    const t0 = Date.now(); let state = 'control', shared = null, got = null, err = null;
    if (!T.CONTROL) {
        try {
            shared = await shareFile(file, pos, placement0.rotation, placement0.mirror);
            // the builder bot has been in the world since before the upload: the server announces the new placement to it (register_metadata)
            const c = svc.bots.get(name).bot.syncmatica;
            if (!c || !c.ready) throw new Error('the builder bot has no Syncmatica list (is the mod on this server?)');
            for (let i = 0; i < 40 && !c.placements.has(shared.id); i++) await sleep(500);
            const found = c.placements.get(shared.id);
            if (!found) throw new Error(`the placement ${shared.id} did not reach the builder (${c.placements.size} placements; log: ${c.log.slice(-3).join(' | ')})`);
            const f = await c.fetch(found.id);
            got = { id: found.id, bytes: f.length, pos: found.pos, hashOk: sm.hashOf(f) === found.hash, rotation: found.rotation, mirror: found.mirror };
            const pp = lit.place(lit.parse(f), found, { keepAir: false });
            const job = await svc._buildFrom(pp.bp, pp.origin, { name: 'iron-farm', bots: names, start: true, tile: 64, mode: ['layer', 'zlayer'].includes(process.env.BUILD_MODE) ? process.env.BUILD_MODE : 'area', window: Number(process.env.BUILD_WINDOW || 0) }, null, { dim: NETHER ? 'nether' : 'overworld' });
            got.origin = pp.origin; got.job = job.id;
            let lastLog = 0;
            while (Date.now() - t0 < LIMIT_MIN * 60000) {
                const j = svc.jobs.get(job.id); if (!j || j.state === 'finished' || j.state === 'cancelled') { state = j ? j.state : 'gone'; break; }
                if (Date.now() - lastLog > 120000) {          // progress, read from the bot's own view of the world (a diagnostic, never the verdict)
                    lastLog = Date.now();
                    try {
                        const bot = svc.bots.get(name).bot, miss = j.impl.diff(require('../../src/skills/world').fromBot(bot)), by = {};
                        for (const c of miss) by[c.waterlog ? 'waterlog' : c.block] = (by[c.waterlog ? 'waterlog' : c.block] || 0) + 1;
                        // is the bots' view behind the server? (2026-11-18: builders kept failing `not_confirmed` on cells the server held)
                        let stale = 0, probed = 0;
                        for (const c of miss.filter((q) => !q.waterlog).slice(0, 10)) { probed++; if (/^Test passed/.test(strip(await S.cmd(`execute if block ${c.x} ${c.y} ${c.z} minecraft:${c.block}`)))) stale++; }
                        console.log(`[stale view] ${stale} of ${probed} cells the bots call missing exist on the server`);
                        console.log(`[progress ${Math.round((Date.now() - t0) / 60000)} min] ${j.impl.plan.count - miss.length}/${j.impl.plan.count} cells right; missing by block: ${JSON.stringify(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
                        {   // who can go on: pending units, how many pass the gate, and what the first blocked ones wait for (a deadlock explains itself)
                            const L2 = j.impl.ledger, r2 = L2.regions.get('b0'), pl2 = j.impl.plan, R2 = require('../../src/work/builder/run'), W2 = require('../../src/skills/world').fromBot(bot), cnt2 = [0, 0, 0, 0], open = [], blocked = [];
                            for (let u = 0; u < pl2.units.length; u++) { cnt2[r2.state[u]]++; if (r2.state[u] === 2) continue; let g = false; try { g = R2.gateOf(pl2, j.impl, u); } catch (_) { g = false; } if (g && r2.state[u] === 0) open.push(u); else if (!g && blocked.length < 4) { const c = pl2.units[u].find((q) => !R2.right(q, W2)); if (c) blocked.push(`u${u}[${['pend', 'lease', 'done', 'stuck'][r2.state[u]]}] ${c.block}@${c.x - M.x},${c.y - M.y},${c.z - M.z} waits ${(c.pre || []).filter((k) => { const q = pl2.byKey.get(k); return q && !R2.right(q, W2); }).slice(0, 2).map((k) => { const q = pl2.byKey.get(k); return `${q.block}@${q.x - M.x},${q.y - M.y},${q.z - M.z}`; }).join('/') || 'support ' + c.sup}`); } }
                            console.log(`[gate] units pending ${cnt2[0]} leased ${cnt2[1]} done ${cnt2[2]} stuck ${cnt2[3]}; open now ${open.length}; blocked e.g. ${blocked.join(' | ')}`);
                        }
                        const all = j.impl.ledger.stuck || [], cnt = {};
                        for (const x of all) { const k = `${x.reason}/${(x.detail && x.detail.stage) || ''}`; cnt[k] = (cnt[k] || 0) + 1; }
                        const rel = (x) => { const c = x.detail && x.detail.cell; return c ? `${c.block}@${c.x - pp.origin.x},${c.y - pp.origin.y},${c.z - pp.origin.z}` : '?'; };
                        if (all.length) console.log(`[stuck units ${all.length}] ${JSON.stringify(cnt)} first: ${all.slice(0, 10).map((x) => rel(x) + ' ' + JSON.stringify(x.detail && x.detail.nav || x.detail && x.detail.why || '').slice(0, 230)).join(' | ')}`);
                    } catch (e) { console.log('[progress] failed:', e.message); }
                }
                await sleep(3000);
            }
            if (state === 'control') state = 'timeout';
        } catch (e) { err = e.message; state = 'error'; console.error(e); }
    }
    // which units are left and why (2026-11-18): state, attempts, whether the gate lets a bot take it, its first cell
    try {
        const j = svc.jobs.get(got && got.job), L = j.impl.ledger, r = L.regions.get('b0'), R = require('../../src/work/builder/run'), pl = j.impl.plan, left = [];
        for (let u = 0; u < pl.units.length; u++) {
            if (r.state[u] === 2) continue;
            const c = pl.units[u][0], undone = pl.units[u].filter((q) => !R.right(q, require('../../src/skills/world').fromBot(svc.bots.get(name).bot))).length;
            left.push(`u${u}[${['pending', 'leased', 'done', 'stuck'][r.state[u]]} att${r.attempts[u]} gate=${R.gateOf(pl, j.impl, u)} ${undone}/${pl.units[u].length} ${c.block}@${c.x - M.x},${c.y - M.y},${c.z - M.z}]`);
        }
        console.log(`[units left ${left.length}] ${left.slice(0, 60).join(' ')}`);
        const lg = L.log, t00 = lg.length ? lg[0].t : 0;          // who claimed what when (the ledger keeps the last 500 events): the timeline of every bot
        console.log(`[ledger log] ${lg.filter((e) => e.ev === 'claim' || e.ev === 'done' || e.ev === 'fail' || e.ev === 'release').map((e) => `${Math.round((e.t - t00) / 1000)}s ${e.bot || ''}${e.ev === 'claim' ? '+' + e.units.join(',') : e.ev === 'done' ? ' done u' + e.unit : e.ev === 'fail' ? ' FAIL u' + e.unit + ' ' + e.reason : ' rel u' + e.unit}`).join(' | ')}`);
    } catch (e) { console.log('[units left] failed:', e.message); }
    await sleep(25000);                                                                                       // let the fluids and the circuit settle before judging
    const strict = await match();
    let wrong = [];
    if (!strict) {
        // Every cell where the build differs from the reference copy (the halving walk), each judged by the SERVER against the BLUEPRINT: the block with the properties placement decides and the ones a right-click
        // sets (open, delay, mode, note) is "static"; what the circuit decides (power, lit, extended, a piston's head, flowing water) is dynamic and does not count. A cell where the blueprint has air and the build
        // has something (a temporary block left behind) is wrong.
        const cellsDiff = await differing(S, M, ref, [sx, sy, sz], 8000);
        const props = (wp) => { const o = { ...O.staticProps(wp.name, wp.props), ...O.useProps(wp.name, wp.props) }; return Object.keys(o).length ? '[' + Object.entries(o).map(([a, v]) => `${a}=${v}`).join(',') + ']' : ''; };
        const derived = (wp) => !!wp && (/^minecraft:(piston_head|moving_piston)$/.test(wp.name) || (/^minecraft:(water|lava)$/.test(wp.name) && wp.props.level && wp.props.level !== '0'));
        const at0 = new Map(pl.bp.blocks.map((q) => [`${q.x},${q.y},${q.z}`, pl.bp.palette[q.s]]));
        for (const o of cellsDiff) {
            const x = M.x + o[0], y = M.y + o[1], z = M.z + o[2], wp = at0.get(`${o[0]},${o[1]},${o[2]}`) || null;
            let sameStatic = false;
            if (derived(wp)) sameStatic = true;
            else if (wp && wp.name === 'minecraft:nether_portal') sameStatic = /^Test passed/.test(strip(await S.cmd(`execute if block ${x} ${y} ${z} minecraft:nether_portal`)));
            else if (wp) sameStatic = /^Test passed/.test(strip(await S.cmd(`execute if block ${x} ${y} ${z} ${wp.name}${props(wp)}${/^minecraft:(water|lava)$/.test(wp.name) ? '[level=0]' : ''}`)));
            else sameStatic = /^Test passed/.test(strip(await S.cmd(`execute if block ${x} ${y} ${z} minecraft:air`)));
            wrong.push({ at: o, want: wp ? stateStr(wp) : 'air', dynamicOnly: sameStatic });
        }
    }
    const staticOk = strict || wrong.every((q) => q.dynamicOnly);
    const hard = wrong.filter((q) => !q.dynamicOnly), hardBy = {}; for (const q of hard) hardBy[q.want.replace(/\[.*$/, '')] = (hardBy[q.want.replace(/\[.*$/, '')] || 0) + 1;
    console.log(`[judge] strict ${strict}; ${wrong.length} cells differ from the reference, ${wrong.length - hard.length} of them only in what the circuit decides; WRONG ${hard.length} ${JSON.stringify(hardBy)}`);
    wrong = [...hard.slice(0, 60), ...wrong.filter((q) => q.dynamicOnly).slice(0, 20)];
    const noTeleport = Object.keys(moves).length === 0;
    rep.trial(`${name}#${k + 1}`, controlOk && state === 'finished' && staticOk && noTeleport, { strict, staticOk, controlOk, noTeleport, bots: BOTS, limitMin: LIMIT_MIN, state, err, minutes: Math.round((Date.now() - t0) / 60000), min: M, box: [sx, sy, sz], blocks: probe.blocks.length, unbuildable: plan0.unbuildable, materials: mats, syncmatica: got, wrongCells: wrong, wrongBy: hardBy, problems: (svc.problems && svc.problems.list || []).slice(-8).map((q) => JSON.stringify(q).slice(0, 300)), serverMoves: moves, units: (svc.jobs.get(got && got.job) || {}).progress });
    return { strict, staticOk };
}

(async () => {
    const rep = T.reporter('place_c');
    const { S, svc, seed } = await T.open(names, { teleport: process.env.TELEPORT || 'off' });     // no server moves at all (owner 2026-11-18: "it worked around movement by teleporting"); TELEPORT=near allows them, counted as serverMoves, and fails the trial
    moves = T.countMoves(svc);
    await S.must('gamerule keep_inventory true');                                                             // owner: survival with keep inventory, peaceful
    const out = [];
    for (let k = 0; k < TRIALS; k++) out.push(await trial(k, S, svc, seed, rep));
    const ok = out.filter((r) => r.staticOk).length;
    console.log(`[place_c w${T.WORLD}] static ${ok}/${TRIALS}, strict ${out.filter((r) => r.strict).length}/${TRIALS}`);
    const n = rep.write({ seed, file: FILE, required: '50 %' });
    await svc.stop(); process.exit(n >= Math.ceil(TRIALS / 2) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

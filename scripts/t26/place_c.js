'use strict';
// T26 test PLACE C (owner 2026-11-17): a bot builds a Litematica blueprint that reached it THROUGH SYNCMATICA, in mid-air, from supply chests, and the SERVER compares the result.
//   - the file (default tests/fixtures/easy-ironfarm-fixd.litematic = the owner's E:\...\iron-farm\easy-ironfarm-fixd.litematic, a simple iron golem trap) is uploaded by one bot as a Syncmatica
//     placement (the owner does the same from Litematica), the builder bot reads the list, downloads the file, parses it, applies the placement (origin, rotation, mirror) and builds it;
//   - the world: survival (keep inventory on), peaceful; the site is a flat stone deck in the sky (200 up), nothing else near; every item of the material list (as the plan counts it: buckets for
//     fluid sources and waterlogged blocks) is in tagged chests (purpose `free`) on the deck; the builder has the tools and 64 cobblestone for temporary blocks, nothing more;
//   - judge: the box of the blueprint is compared with a REFERENCE copy that the harness makes by commands (every cell, air included: `execute if blocks ... all`); the empty site must NOT match.
//     The strict comparison includes properties the game derives (power, lit, extended ...): they can differ without the structure being wrong, so the report also lists every differing cell
//     and says whether the difference is only in such a property ("static" verdict: same block, same placement-decided properties, same fluids).
//   scripts/t26/run.sh N place_c.js [LIMIT_MIN=90] [TRIALS=1] [CONTROL=noop] [LITEMATIC=/app/tests/fixtures/x.litematic] [ROT=CLOCKWISE_90] [MIR=LEFT_RIGHT] [KEEP_SITE=1]
const fs = require('fs'), path = require('path');
const T = require('./lib');
const { createBot, attachHandshake } = require('../../src/transport');
const sm = require('../../src/transport/syncmatica');
const lit = require('../../src/work/jobs/litematic');
const build = require('../../src/work/jobs/build');
const O = require('../../src/work/jobs/orient');
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 90), TRIALS = Number(process.env.TRIALS || 1), BOTS = Math.min(6, Math.max(1, Number(process.env.BOTS || 1)));
const names = Array.from({ length: BOTS }, (_, i) => `Fm${T.WORLD}${'abcdef'[i - 1] || ''}`), name = names[0];      // BOTS=n: n builders on one job (the crew ledger shares the units)
const FILE = process.env.LITEMATIC || path.join(__dirname, '../../tests/fixtures/easy-ironfarm-fixd.litematic');
const STACK = { white_bed: 1, water_bucket: 1, lava_bucket: 1, oak_sign: 16, snowball: 16 };
const sleep = T.sleep, strip = T.strip;

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

async function trial(k, S, svc, seed, rep) {
    const file = fs.readFileSync(FILE), parsed = lit.parse(file), probe = lit.toBlueprint(parsed, { keepAir: false });
    const placement0 = { rotation: process.env.ROT || 'NONE', mirror: process.env.MIR || 'NONE' };
    const p0 = await T.posOf(S, name);
    // the site: the box's minimum corner M at height 200, 100 blocks apart for the trials, around the spawn
    const base = { x: Math.floor(p0.x) + 60 + k * 100, z: Math.floor(p0.z) - 20 };
    const placed = lit.place(parsed, { pos: { x: 0, y: 0, z: 0 }, ...placement0 }, { keepAir: true });
    const [sx, sy, sz] = placed.bp.size;
    const M = { x: base.x, y: 200, z: base.z };
    const pos = { x: M.x - placed.origin.x, y: M.y - placed.origin.y, z: M.z - placed.origin.z };       // the Syncmatica placement origin that puts the box's corner at M
    const X1 = M.x + sx - 1, Y1 = M.y + sy - 1, Z1 = M.z + sz - 1;
    const ref = { x: M.x, y: M.y, z: M.z + sz + 40 };
    await S.must(`forceload add ${M.x - 8} ${M.z - 8} ${X1 + 8} ${ref.z + sz + 8}`);
    // clear (air) the box and the margin, lay the deck: one layer of stone under the box, 4 wide margin around
    for (const [x0, z0, x1, z1] of [[M.x - 6, M.z - 6, X1 + 6, Z1 + 6], [ref.x - 3, ref.z - 3, ref.x + sx + 2, ref.z + sz + 2]]) {
        for (let xa = x0; xa <= x1; xa += 24) for (let za = z0; za <= z1; za += 24) for (let y = M.y - 2; y <= Y1 + 6; y += 8)
            await S.must(`fill ${xa} ${y} ${za} ${Math.min(xa + 23, x1)} ${Math.min(y + 7, Y1 + 6)} ${Math.min(za + 23, z1)} minecraft:air`);
    }
    await S.must(`fill ${M.x - 6} ${M.y - 1} ${M.z - 6} ${X1 + 6} ${M.y - 1} ${Z1 + 6} minecraft:stone`);
    // the reference copy, from the same blueprint with every state (dynamic ones included), then settle
    const pl = lit.place(parsed, { pos, ...placement0 }, { keepAir: false });
    // cells the survival game cannot hold (a wall sign hung on a wall sign: pasted by commands): not part of the reference, reported
    const plan0 = build.planBuild(require('../../src/work/jobs/blueprint').cells(pl.bp), { x: 0, y: 0, z: 0 }, { tile: 64 }), never = new Set(plan0.unbuildable.map((u) => u.at));
    const fluids = [], solids = [];
    for (const b of pl.bp.blocks) { if (never.has(`${b.x},${b.y},${b.z}`)) continue; const p = pl.bp.palette[b.s], st = build.kindOf({ block: p.name, props: p.props }); (st === 'flow' || st === 'fluid' ? fluids : solids).push({ b, p }); }
    const stateStr = (p) => `${p.name}${Object.keys(p.props).length ? '[' + Object.entries(p.props).map(([a, v]) => `${a}=${v}`).join(',') + ']' : ''}`;
    for (const { b, p } of solids) { if (O.derivedCell(p.name, p.props) && /_bed$/.test(p.name) && p.props.part === 'head') continue; await S.cmd(`setblock ${ref.x + b.x} ${ref.y + b.y} ${ref.z + b.z} ${stateStr({ name: p.name, props: { ...p.props, ...(p.props.waterlogged ? { waterlogged: 'false' } : {}) } })} replace`); }
    for (const { b, p } of fluids) if (p.props.level === '0' || !p.props.level) await S.cmd(`setblock ${ref.x + b.x} ${ref.y + b.y} ${ref.z + b.z} ${p.name} replace`);
    for (const { b, p } of solids) if (p.props.waterlogged === 'true') await S.cmd(`setblock ${ref.x + b.x} ${ref.y + b.y} ${ref.z + b.z} ${stateStr(p)} replace`);
    // (the head half of a bed was placed by the foot's setblock)
    await sleep(20000);                                                                                       // water and lava flow, redstone settles
    const bx = { a: M, b: ref, size: [sx, sy, sz] };
    const match = async () => /^Test passed/.test(strip(await S.cmd(`execute if blocks ${M.x} ${M.y} ${M.z} ${X1} ${Y1} ${Z1} ${ref.x} ${ref.y} ${ref.z} all`)));
    const controlOk = !(await match());
    // supply chests on the deck (tagged `free`), every item of the plan's material list
    const mats = pl && build.materialsOf(pl.bp.blocks.filter((b) => !never.has(`${b.x},${b.y},${b.z}`)).map((b) => ({ block: pl.bp.palette[b.s].name.replace(/^minecraft:/, ''), props: pl.bp.palette[b.s].props })).filter((c) => !/^(air|cave_air|void_air)$/.test(c.block)));
    const stacks = []; for (const [it, n] of Object.entries(mats)) { const ms = STACK[it] || 64; for (let r = n; r > 0; r -= ms) stacks.push({ it, n: Math.min(ms, r) }); }
    const chests = []; for (let i = 0; i < stacks.length; i += 27) chests.push(stacks.slice(i, i + 27));
    const sup = chests.map((_, i) => ({ x: M.x - 3, y: M.y, z: M.z + 2 * i }));
    for (let i = 0; i < chests.length; i++) {
        await S.must(`setblock ${sup[i].x} ${sup[i].y} ${sup[i].z} minecraft:chest[facing=east] replace`);
        const items = chests[i].map((s, j) => `{Slot:${j}b,id:"minecraft:${s.it}",count:${s.n}}`).join(',');
        await S.must(`data merge block ${sup[i].x} ${sup[i].y} ${sup[i].z} {Items:[${items}]}`);
    }
    for (const [i, n] of names.entries()) { await S.must(`tp ${n} ${M.x - 4.5 - i} ${M.y} ${M.z - 3.5}`); await T.kit(S, n, { blocks: 128 }); }
    await sleep(4000);
    for (let i = 0; i < chests.length; i++) svc.addSite({ name: `supply${i}`, x: sup[i].x, y: sup[i].y, z: sup[i].z, purpose: 'free' });      // after the bot sees the chunk
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
            const job = await svc._buildFrom(pp.bp, pp.origin, { name: 'iron-farm', bots: names, start: true, tile: 64 }, null, { dim: 'overworld' });
            got.origin = pp.origin; got.job = job.id;
            let lastLog = 0;
            while (Date.now() - t0 < LIMIT_MIN * 60000) {
                const j = svc.jobs.get(job.id); if (!j || j.state === 'finished' || j.state === 'cancelled') { state = j ? j.state : 'gone'; break; }
                if (Date.now() - lastLog > 120000) {          // progress, read from the bot's own view of the world (a diagnostic, never the verdict)
                    lastLog = Date.now();
                    try {
                        const bot = svc.bots.get(name).bot, miss = j.impl.diff(require('../../src/skills/world').fromBot(bot)), by = {};
                        for (const c of miss) by[c.waterlog ? 'waterlog' : c.block] = (by[c.waterlog ? 'waterlog' : c.block] || 0) + 1;
                        console.log(`[progress ${Math.round((Date.now() - t0) / 60000)} min] ${j.impl.plan.count - miss.length}/${j.impl.plan.count} cells right; missing by block: ${JSON.stringify(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
                        const pk = (j.impl.ledger.stuck || []).slice(-6).map((x) => { const c = x.detail && x.detail.cell; return `${x.reason}@${c ? `${c.block} ${c.x - pp.origin.x},${c.y - pp.origin.y},${c.z - pp.origin.z}` : '?'} ${x.detail && x.detail.stage || ''}`; });
                        if (pk.length) console.log(`[stuck units] ${pk.join(' | ')}`);
                    } catch (e) { console.log('[progress] failed:', e.message); }
                }
                await sleep(3000);
            }
            if (state === 'control') state = 'timeout';
        } catch (e) { err = e.message; state = 'error'; console.error(e); }
    }
    await sleep(25000);                                                                                       // let the fluids and the circuit settle before judging
    const strict = await match();
    let wrong = [];
    if (!strict) {
        const cellsDiff = await differing(S, M, ref, [sx, sy, sz]);
        const bot = svc.bots.get(name).bot, Vec3 = require('vec3');
        for (const o of cellsDiff) {
            const x = M.x + o[0], y = M.y + o[1], z = M.z + o[2], b = bot ? bot.blockAt(new Vec3(x, y, z), false) : null;
            const want = pl.bp.blocks.find((q) => q.x === o[0] && q.y === o[1] && q.z === o[2]), wp = want ? pl.bp.palette[want.s] : null;
            const got = b ? { name: b.name, props: b.getProperties ? b.getProperties() : {} } : null;
            const sameStatic = !!(wp && got && `minecraft:${got.name}` === wp.name && JSON.stringify(O.staticProps(wp.name, got.props)) === JSON.stringify(O.staticProps(wp.name, wp.props)) && !/^(water|lava)$/.test(got.name));
            wrong.push({ at: o, want: wp ? stateStr(wp) : 'air', got: got ? `${got.name}${Object.keys(got.props).length ? JSON.stringify(got.props) : ''}` : null, dynamicOnly: sameStatic });
        }
    }
    const staticOk = strict || (wrong.length > 0 && wrong.every((q) => q.dynamicOnly));
    rep.trial(`${name}#${k + 1}`, controlOk && state === 'finished' && staticOk, { strict, staticOk, controlOk, state, err, minutes: Math.round((Date.now() - t0) / 60000), min: M, box: [sx, sy, sz], blocks: probe.blocks.length, unbuildable: plan0.unbuildable, materials: mats, syncmatica: got, wrongCells: wrong.slice(0, 40), problems: (svc.problems && svc.problems.list || []).slice(-8).map((q) => JSON.stringify(q).slice(0, 300)), units: (svc.jobs.get(got && got.job) || {}).progress });
    return { strict, staticOk };
}

(async () => {
    const rep = T.reporter('place_c');
    const { S, svc, seed } = await T.open(names);
    await S.must('gamerule keep_inventory true');                                                             // owner: survival with keep inventory, peaceful
    const out = [];
    for (let k = 0; k < TRIALS; k++) out.push(await trial(k, S, svc, seed, rep));
    const ok = out.filter((r) => r.staticOk).length;
    console.log(`[place_c w${T.WORLD}] static ${ok}/${TRIALS}, strict ${out.filter((r) => r.strict).length}/${TRIALS}`);
    const n = rep.write({ seed, file: FILE, required: '50 %' });
    await svc.stop(); process.exit(n >= Math.ceil(TRIALS / 2) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });

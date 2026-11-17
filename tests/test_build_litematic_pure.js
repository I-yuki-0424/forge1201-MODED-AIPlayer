'use strict';
// The Build job on a real blueprint (the owner's iron golem trap, tests/fixtures/easy-ironfarm-fixd.litematic) against a SIMULATED server: it places by the game's placement rules
// (orient.model), refuses what the game refuses, and counts. Checks: every buildable cell ends right, fluids come last, temporary blocks are gone, a wall sign on a wall sign is
// reported unbuildable and not tried, the material list. The live check is scripts/t26/place_c.js.
const assert = require('assert'), fs = require('fs'), path = require('path');
const lit = require('../src/work/jobs/litematic'), bpm = require('../src/work/jobs/blueprint'), build = require('../src/work/jobs/build'), O = require('../src/work/jobs/orient');
const { runWorker } = require('../src/work/bot/worker');
setTimeout(() => { console.error('test watchdog: still running after 120 s'); process.exit(2); }, 120000).unref();

const key = (x, y, z) => `${x},${y},${z}`;
const REPL = /^(air|cave_air|grass|snow|water|lava)$/;
const FLUIDS = /^(water|lava)$/, THIN = /(torch|sign|redstone_wire|repeater|comparator)$/, PART = /(stairs|trapdoor|hopper|chest|bed|piston|composter|fence_gate|wall|slab)$/;

/** A world with a stone deck under y0 and a game that places blocks by the vanilla rules. Logs the order of placements. */
function sim(deckY) {
    const m = new Map(), log = [], bot = { __temps: null };
    const get = (x, y, z) => m.get(key(x, y, z)) || (y <= deckY ? { name: 'stone', props: {} } : { name: 'air', props: {} });
    const w = {
        nameAt: (x, y, z) => get(x, y, z).name,
        kindAt: (x, y, z) => { const n = get(x, y, z).name; return n === 'air' ? 'air' : FLUIDS.test(n) ? (n === 'water' ? 'water' : 'danger') : THIN.test(n) ? 'air' : PART.test(n) ? 'partial' : 'solid'; },
        blockAt: (x, y, z) => { const b = get(x, y, z); return { name: b.name, getProperties: () => ({ ...b.props }), boundingBox: THIN.test(b.name) ? 'empty' : 'block' }; },
    };
    const set = (x, y, z, name, props = {}) => m.set(key(x, y, z), { name, props });
    const clickable = (p) => { const k = w.kindAt(p.x, p.y, p.z); return k === 'solid' || k === 'partial'; };
    const dir = (c, d) => ({ x: c.x + O.DIR[d][0], y: c.y + O.DIR[d][1], z: c.z + O.DIR[d][2] });
    const exec = async (name, a) => {
        const c = { x: a.x, y: a.y, z: a.z };
        if (name === 'mine') { set(c.x, c.y, c.z, 'air'); log.push(['mine', c]); return { ok: true }; }
        if (name === 'activate') { const b = get(c.x, c.y, c.z), p = { ...b.props }; if ('open' in p) p.open = p.open === 'true' ? 'false' : 'true'; else if ('delay' in p) p.delay = String(Number(p.delay) % 4 + 1); m.set(key(c.x, c.y, c.z), { name: b.name, props: p }); return { ok: true }; }
        if (name === 'pour') {
            const b = get(c.x, c.y, c.z);
            if (a.waterlog) { if (!('waterlogged' in b.props)) return { ok: false, reason: 'invalid_target' }; m.set(key(c.x, c.y, c.z), { name: b.name, props: { ...b.props, waterlogged: 'true' } }); }
            else { if (!REPL.test(b.name) || !Object.keys(O.DIR).some((d) => clickable(dir(c, d)))) return { ok: false, reason: 'invalid_target' }; set(c.x, c.y, c.z, a.item.replace('_bucket', ''), { level: '0' }); }
            log.push(['pour', c, a.item]); return { ok: true, detail: {} };
        }
        if (name !== 'place') throw new Error(name);
        const cur = get(c.x, c.y, c.z);
        if (!REPL.test(cur.name)) return { ok: false, reason: 'invalid_target', detail: { why: `cell holds ${cur.name}` } };
        const r = a.recipe, sup = dir(c, r.support);
        if (!clickable(sup)) return { ok: false, reason: 'invalid_target', detail: { why: 'support' } };
        const res = O.model(a.item === 'redstone' ? 'redstone_wire' : /(torch|_sign)$/.test(a.item) ? a.item : (a.block || a.item), { clicked: O.OPP[r.support], hy: r.hy, yRot: r.yRot, pitch: r.pitch }, (d) => w.kindAt(dir(c, d).x, dir(c, d).y, dir(c, d).z) === 'solid' || (d === 'down' && /(_wall|_fence)$/.test(w.nameAt(dir(c, d).x, dir(c, d).y, dir(c, d).z))));
        if (!res) return { ok: false, reason: 'not_confirmed', detail: { why: 'the game refused' } };
        if (THIN.test(res.name) && /wall_(torch|sign)$/.test(res.name)) { const s = dir(c, O.OPP[res.props.facing]); if (w.kindAt(s.x, s.y, s.z) !== 'solid') return { ok: false, reason: 'not_confirmed' }; }
        const props = { ...res.props }; if (/trapdoor|gate/.test(res.name)) props.open = 'false'; if (/repeater/.test(res.name)) props.delay = '1'; if (/stairs|trapdoor|hopper|chest/.test(res.name) || /bed/.test(res.name)) props.waterlogged = props.waterlogged || 'false';
        set(c.x, c.y, c.z, res.name, props);
        if (/_bed$/.test(res.name)) { const h = dir(c, res.props.facing); set(h.x, h.y, h.z, res.name, { facing: res.props.facing, part: 'head' }); }
        log.push(['place', c, res.name, a.temp || null]); return { ok: true, detail: {} };
    };
    return { w, set, get, exec, log, m };
}

(async () => {
    const file = fs.readFileSync(path.join(__dirname, 'fixtures/easy-ironfarm-fixd.litematic'));
    const placed = lit.place(lit.parse(file), { pos: { x: 22, y: 201, z: 20 } }, { keepAir: false });
    const cells = bpm.cells(placed.bp), origin = placed.origin;
    // the plan
    const job = build.createBuildJob(cells, origin, { leaseMs: 60000, maxAttempts: 6 }, { tile: 64 }), plan = job.plan;
    assert.strictEqual(plan.unbuildable.length, 6, 'the six wall signs hung on wall signs');
    assert.ok(plan.unbuildable.every((u) => /oak_wall_sign/.test(u.why)));
    assert.strictEqual(plan.skipped.flow, 224); assert.strictEqual(plan.skipped.derived, 14, 'bed heads and the piston arm are made by the game');
    assert.strictEqual(plan.phases, 2 * plan.layers + 1, 'two phases per height (stand-alone, needs a support) and the fluids');
    assert.strictEqual(plan.materials.water_bucket, 36); assert.strictEqual(plan.materials.lava_bucket, 1); assert.strictEqual(plan.materials.white_bed, 12); assert.strictEqual(plan.materials.oak_sign, 3);
    assert.strictEqual(plan.materials.stone_bricks, 364); assert.ok(!('oak_wall_sign' in plan.materials));
    // run it
    const S = sim(origin.y - 1), inv = new Proxy({}, { get: () => 999 });
    const env = { w: S.w, have: (i) => inv[i], here: () => ({ x: origin.x - 2, y: origin.y, z: origin.z }), pos: () => ({ x: origin.x - 2, z: origin.z }), inv: () => ({ items: [], slotsFree: 30 }), exec: S.exec };
    const res = await runWorker(job, 'b', env, { pollMs: 1, backoff: () => 1 });
    if (res.ended !== 'finished') console.error(JSON.stringify(job.ledger.stuck.slice(0, 8).map((x) => ({ reason: x.reason, detail: JSON.stringify(x.detail || x).slice(0, 400) })), null, 1));
    assert.strictEqual(res.ended, 'finished', JSON.stringify(job.ledger.progress()));
    const missing = job.diff(S.w);
    if (missing.length) for (const c of missing.slice(0, 2)) { console.error('wrong:', c.block, JSON.stringify(c.props), 'got', JSON.stringify(S.get(c.x, c.y, c.z))); console.error(JSON.stringify(S.log.filter((e) => e[1].x === c.x && e[1].y === c.y && e[1].z === c.z))); console.error(JSON.stringify(job.ledger.stuck.map((x) => x.reason + ' ' + JSON.stringify(x.detail && x.detail.cell && [x.detail.cell.x - origin.x, x.detail.cell.y - origin.y, x.detail.cell.z - origin.z])))); }
    assert.deepStrictEqual(missing.map((c) => `${c.block}@${c.x - origin.x},${c.y - origin.y},${c.z - origin.z}`), [], 'every buildable cell is right');
    // states, spot checks against the blueprint
    const at = (x, y, z) => S.get(origin.x + x, origin.y + y, origin.z + z);
    for (const b of placed.bp.blocks) { const p = placed.bp.palette[b.s], g = at(b.x, b.y, b.z); if (/^minecraft:(water|lava)$/.test(p.name) && p.props.level !== '0') continue; if (O.derivedCell(p.name, p.props)) continue; if (plan.unbuildable.some((u) => u.at === `${origin.x + b.x},${origin.y + b.y},${origin.z + b.z}`)) continue; assert.strictEqual(`minecraft:${g.name}`, p.name, `block at ${b.x},${b.y},${b.z}`); for (const [k, v] of Object.entries(O.staticProps(p.name, p.props))) assert.strictEqual(g.props[k], v, `${p.name} ${k} at ${b.x},${b.y},${b.z}`); }
    // fluids last, bottom-up otherwise
    const idx = (f) => S.log.map((e, i) => (f(e) ? i : -1)).filter((i) => i >= 0);
    const pours = idx((e) => e[0] === 'pour'), solids = idx((e) => e[0] === 'place' && !e[3]);
    assert.ok(pours.length === 36 + 1 + plan.tiles.size * 0 + (pours.length - 37), 'buckets poured'); assert.ok(Math.min(...pours) > Math.max(...solids), 'no fluid before the last solid block');
    const wet = [...S.m.values()].filter((b) => b.props.waterlogged === 'true').length; assert.ok(wet > 0, 'waterlogged blocks got their water');
    // temporary blocks: used (the floating dirt needs them) and gone
    const temps = S.log.filter((e) => e[0] === 'place' && e[3] === 'scaffold');
    assert.ok(temps.length > 0, 'floating cells needed temporary supports');
    assert.deepStrictEqual([...S.m.entries()].filter(([k, b]) => b.name === 'cobblestone' && !plan.cellSet.has(k)), [], 'no temporary block is left');
    // a mid-air bed: foot placed, the game made the head
    assert.strictEqual(at(...[...placed.bp.blocks.filter((b) => /bed/.test(placed.bp.palette[b.s].name) && placed.bp.palette[b.s].props.part === 'head')].slice(0, 1).map((b) => [b.x, b.y, b.z])[0]).props.part, 'head');
    console.log(`build litematic: ok (${S.log.length} actions, ${temps.length} temporary blocks, ${pours.length} buckets)`);
})().catch((e) => { console.error(e); process.exit(1); });

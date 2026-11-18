'use strict';
// The new Build (src/work/builder/, 2026-11-18): the plan of the owner's iron golem trap and a SIMULATED builder that walks the plan the way a bot does (station by station), on a virtual
// world: every cell must be placed once, each from a station that exists (a block under the feet, or a temporary one that can be climbed to) and from which the SUPPORT is within reach,
// fluids only when what holds them stands, and the lava before its lid. The live check is scripts/t26/place_c.js.
const assert = require('assert'), fs = require('fs'), path = require('path');
const lit = require('../src/work/jobs/litematic'), bpm = require('../src/work/jobs/blueprint');
const P = require('../src/work/builder/plan'), S = require('../src/work/builder/stations'), R = require('../src/work/builder/run'), C = require('../src/work/builder/cells');
setTimeout(() => { console.error('test watchdog: still running after 120 s'); process.exit(2); }, 120000).unref();

const key = (x, y, z) => `${x},${y},${z}`;
const THIN = /(torch|sign|redstone_wire|repeater|comparator)$/, PART = /(stairs|trapdoor|hopper|chest|bed|piston|composter|fence_gate|wall|slab)$/;

/** A virtual world: ground below `deckY`, blocks (name + properties) placed by the simulation. */
function world(deckY) {
    const m = new Map(), wl = new Set();
    const get = (x, y, z) => m.get(key(x, y, z)) || (y <= deckY ? { name: 'stone', props: {} } : { name: 'air', props: {} });
    return {
        set: (x, y, z, name, props = {}) => m.set(key(x, y, z), { name, props }), waterlog: (x, y, z) => wl.add(key(x, y, z)),
        nameAt: (x, y, z) => get(x, y, z).name,
        kindAt: (x, y, z) => { const n = get(x, y, z).name; return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'lava' ? 'danger' : THIN.test(n) ? 'air' : PART.test(n) ? 'partial' : 'solid'; },
        blockAt: (x, y, z) => { const b = get(x, y, z); return { name: b.name, getProperties: () => ({ ...b.props, level: '0', ...(wl.has(key(x, y, z)) ? { waterlogged: 'true' } : {}) }) }; },
    };
}

(async () => {
    const file = fs.readFileSync(path.join(__dirname, 'fixtures/easy-ironfarm-fixd.litematic'));
    const placed = lit.place(lit.parse(file), { pos: { x: 22, y: 201, z: 20 } }, { keepAir: false });
    const cells = bpm.cells(placed.bp), origin = placed.origin;
    const plan = P.planBuild(cells, origin);

    // ---- the plan
    assert.strictEqual(plan.count, 1288, 'every buildable cell is in the plan (flows and bed heads are made by the game)');
    assert.strictEqual(plan.unbuildable.length, 0, 'nothing in the owner\'s file is unbuildable (a sneaked click hangs a sign on a sign)');
    assert.strictEqual(new Set(plan.list.map((c) => c.k)).size, plan.count, 'every cell once');
    const flat = plan.units.flat(); assert.strictEqual(flat.length, plan.count);
    plan.deps.forEach((d, i) => d.forEach((x) => assert.ok(x < i, 'a unit waits only for earlier units')));
    const seeds = plan.list.filter((c) => c.seed);
    assert.ok(seeds.length <= 20, `few floating pieces need a temporary support (${seeds.length})`);
    assert.strictEqual(plan.materials.water_bucket, 36); assert.strictEqual(plan.materials.lava_bucket, 1);
    // fluids wait for what holds them; the lid of the lava waits for the lava
    const lava = plan.list.find((c) => c.block === 'lava'), lavaSeq = lava.seq;
    assert.ok(lava.pre.length >= 9, 'the lava waits for its floor and walls');
    for (const k of lava.pre) assert.ok(plan.byKey.get(k).seq < lavaSeq, 'the lava comes after what holds it');
    const lid = plan.list.filter((c) => c.y >= lava.y + 5 && Math.abs(c.x - lava.x) <= 1 && Math.abs(c.z - lava.z) <= 1); assert.ok(lid.length >= 1, 'the tower has a lid'); for (const c of lid) assert.ok(c.seq > lavaSeq, 'the lid goes on after the lava');
    assert.ok(plan.list.filter((c) => c.fluid).every((c) => c.pre.length > 0 || c.waterlog), 'no fluid source without something to wait for');

    // ---- a simulated builder walks the plan
    const w = world(origin.y - 1), view = S.viewOf(w, plan.cellSet);
    const st = { stations: 0, pillar: 0, native: 0, bridged: 0, climb: 0, failed: [], placed: 0 };
    let feet = { x: origin.x, y: origin.y, z: origin.z - 4 };
    const rel = (c) => `${c.block}@${c.x - origin.x},${c.y - origin.y},${c.z - origin.z}`;
    for (let pass = 0; pass < 8; pass++) {
        let progress = 0;
        for (let u = 0; u < plan.units.length; u++) {
            const unit = plan.units[u];
            for (let round = 0; round < 12; round++) {
                const ready = unit.filter((c) => !R.right(c, w) && R.cellReady(plan, c, w));
                if (!ready.length) break;
                const todo = unit.filter((c) => !R.right(c, w)), s = S.chooseStation(view, todo, { from: feet, skip: new Set(), ok: (c, local) => R.readyLocal(plan, c, w, local) });
                if (!s) { if (pass === 7) st.failed.push({ unit: u, cell: rel(ready[0]), n: ready.length }); break; }
                st.stations++; st[s.kind]++; if (s.kind === 'pillar') { if (s.bridge && 45 + 20 * s.bridge.g < 40 + 26 * (s.S.y - 1 - s.base.y)) st.bridged++; else st.climb += s.S.y - 1 - s.base.y; }
                feet = s.S;
                if (s.serves.some((v) => v.cell.block === 'lava')) console.log('LAVA station', s.kind, rel({ block: 'S', ...s.S }), 'floor', w.nameAt(s.S.x, s.S.y - 1, s.S.z), 'sup', s.serves.find((v) => v.cell.block === 'lava').sup, 'lava at', rel(plan.list.find((c) => c.block === 'lava')));
                for (const sv of s.serves) {
                    const c = sv.cell;
                    if (c.waterlog) w.waterlog(c.x, c.y, c.z); else { const pr = { ...c.props }; delete pr.waterlogged; w.set(c.x, c.y, c.z, c.block, pr); }
                    st.placed++; progress++;
                }
            }
        }
        if (!progress) break;
    }
    console.log('stations', JSON.stringify(st).slice(0, 600));
    const missing = plan.list.filter((c) => !R.right(c, w));
    if (missing.length) { const m0 = missing[0], u0 = plan.unitOf.get(m0.k); const tt = plan.units[u0].filter((c) => !R.right(c, w)); console.log('DBG unit', u0, 'todo', tt.length, 'station', JSON.stringify((() => { const q = S.chooseStation(view, tt, { from: feet, ok: (c, l) => R.readyLocal(plan, c, w, l) }); return q && { S: q.S, n: q.serves.length, k: q.kind }; })()), 'free body', w.kindAt(m0.x + 1, m0.y + 1, m0.z), w.kindAt(m0.x + 1, m0.y + 2, m0.z), w.nameAt(m0.x + 1, m0.y, m0.z)); }
    if (missing.length) console.log('NOT PLACED', missing.length, missing.slice(0, 14).map((c) => `${rel(c)}${c.waterlog ? 'w' : ''} dirs=${(c.dirs || []).join('/')} sup=${c.sup} seed=${c.seed} props=${JSON.stringify(c.props)}`).join(' | '));
    assert.strictEqual(st.failed.length, 0, 'every unit finds a station: ' + JSON.stringify(st.failed.slice(0, 5)));
    assert.strictEqual(st.placed, plan.count, 'every cell is placed from some station');
    console.log('build plan: ok');
})().catch((e) => { console.error(e); process.exit(1); });

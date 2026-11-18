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
    assert.strictEqual(st.placed, plan.count, 'every cell is placed from some station (the arm-tip trapdoor ladders get a temporary support beside them)');

    // ---- the areas (owner 2026-11-18): one per bot, balanced, each ordered bottom-up; a bot keeps its own, helps only when it has none or has finished; a bot that left hands its area on
    {
        const build = require('../src/work/jobs/build'), posts = require('../src/work/builder/posts');
        const p3 = P.planBuild(cells, origin, { zones: 3 });
        assert.strictEqual(p3.zones.n, 3, 'three areas for three bots');
        assert.strictEqual(p3.count, 1288); assert.strictEqual(p3.units.flat().length, 1288, 'every cell in one unit of one area');
        const sizes = p3.zones.units.map(([a, b]) => p3.units.slice(a, b).reduce((n, u) => n + u.length, 0));
        assert.ok(Math.max(...sizes) <= 1.35 * (1288 / 3), 'areas of about the same size ' + sizes);
        p3.zones.units.forEach(([a, b], z) => { const ys = p3.units.slice(a, b).flat().map((c) => c.y), first = p3.units[a][0]; assert.ok(first.y <= Math.min(...ys) + 2, `area ${z} starts at its lowest levels (a cell that hangs on another area's cell may come later)`); for (let i = a; i < b; i++) for (const c of p3.units[i]) assert.strictEqual(c.zone, z, 'a unit holds cells of one area'); });
        // within one area a level starts at its middle: the first cell of the lowest level is among the nearest 15 % to the area's centre
        { const z = 1, m = p3.zones.centre[z], [a, b] = p3.zones.units[z], mine = p3.units.slice(a, b).flat(), low = mine.filter((c) => c.y === mine[0].y), dc = (c) => Math.hypot(c.x - m.x, c.z - m.z), rank = low.filter((c) => dc(c) < dc(mine[0])).length; assert.ok(rank <= Math.max(2, 0.15 * low.length), `the first cell of an area's lowest level is near its middle (rank ${rank} of ${low.length})`); }
        // the ledger: three bots, three areas, kept
        const job = build.createBuildJob(cells, origin, { leaseMs: 45000 }, { zones: 3 }), L = job.ledger, now = Date.now();
        const w3 = world(origin.y - 1); for (const c of p3.list) if (c.y <= origin.y + 3 && !c.fluid) w3.set(c.x, c.y, c.z, c.block, c.props);          // the base stands: every area can start
        job.world = w3;                                                               // set by the first unit any bot runs: the gate then reads cells, not whole units
        const zoneOfClaim = (c) => p3.zones.ofUnit[c.units[0].unit];
        const claims = ['A', 'B', 'C'].map((id, i) => L.claim(id, { x: origin.x + 10 * i, y: origin.y, z: origin.z + 10 * i }, now, { batch: 1 }));
        assert.ok(claims.every(Boolean), 'every bot gets a unit at the start');
        assert.strictEqual(new Set(claims.map(zoneOfClaim)).size, 3, 'three bots, three different areas');
        const mineOf = Object.fromEntries(['A', 'B', 'C'].map((id, i) => [id, zoneOfClaim(claims[i])]));
        for (const id of ['A', 'B', 'C']) L.release(id, 'b0', claims[['A', 'B', 'C'].indexOf(id)].units[0].unit, now, 0);
        for (let k = 0; k < 3; k++) for (const id of ['A', 'B', 'C']) { const c = L.claim(id, { x: origin.x, y: origin.y, z: origin.z }, now + k, { batch: 1 }); assert.ok(c); assert.strictEqual(zoneOfClaim(c), mineOf[id], 'a bot keeps its area'); L.release(id, 'b0', c.units[0].unit, now + k, 0); }
        // a fourth bot has no area: it takes units of another area only away from its keeper
        const dd = L.claim('D', { x: origin.x, y: origin.y, z: origin.z }, now, { batch: 1 });
        if (dd) { const z = zoneOfClaim(dd), k = ['A', 'B', 'C'].find((id) => mineOf[id] === z), at = job.posts.at.get(k); if (at) assert.ok(Math.hypot(p3.centre[dd.units[0].unit].x - at.x, p3.centre[dd.units[0].unit].z - at.z) >= posts.APART, 'a helper keeps away from the keeper'); L.release('D', 'b0', dd.units[0].unit, now, 0); }
        // a bot that has left and stayed away hands its area to the next that asks
        L.leave('A', now);
        const later = now + posts.KEEP_MS + 1000, e = L.claim('E', { x: origin.x, y: origin.y, z: origin.z }, later, { batch: 1 });
        assert.ok(e, 'a bot takes over'); assert.strictEqual(zoneOfClaim(e), mineOf.A, 'the area of the bot that left goes to the next bot');
    }
    // ---- one trip for the run of units of an area: the pack holds the materials of several units, whole units, as many as fit
    {
        const supply = require('../src/work/builder/supply'), p3 = P.planBuild(cells, origin, { zones: 3 }), w0 = world(origin.y - 1);
        const slots = Array.from({ length: 36 }, (_, i) => (i < 6 ? { name: i < 2 ? 'diamond_pickaxe' : 'cobblestone', count: 64 } : null));
        const bot = { inventory: { inventoryStart: 9, inventoryEnd: 45, slots: Object.assign(new Array(45).fill(null), Object.fromEntries(slots.map((s, i) => [9 + i, s]).filter(([, s]) => s))) }, registry: { itemsByName: {} } };
        const u0 = p3.zones.units[1][0], one = P.needsOf(p3.units[u0], w0), many = supply.batch(bot, p3, u0, w0, one);
        const n1 = Object.values(one).reduce((a, b) => a + b, 0), n2 = Object.values(many).reduce((a, b) => a + b, 0);
        assert.ok(n2 > 3 * n1, `the batch covers several units (${n1} -> ${n2} items)`);
        assert.ok(supply.slotsOf(bot, many) <= 36 - 2 - 3 + 0, `and fits the pack (${supply.slotsOf(bot, many)} slots)`);
        for (const [it, n] of Object.entries(one)) assert.ok((many[it] || 0) >= n, 'the unit at hand is always in it');
        assert.deepStrictEqual(supply.batch(null, p3, u0, w0, one), one, 'no bot: the unit alone');
        // leftovers of an earlier run are surplus: they go back into the chest to make room (a full pack once left a bot without the 3 stairs it lacked for ten minutes)
        const bot2 = { inventory: { inventoryStart: 9, inventoryEnd: 45, slots: Object.assign(new Array(45).fill(null), { 9: { name: 'stone_bricks', count: 64 }, 10: { name: 'stone_bricks', count: 64 }, 11: { name: 'glass', count: 10 }, 12: { name: 'cobblestone', count: 64 }, 13: { name: 'diamond_pickaxe', count: 1 } }) } };
        assert.deepStrictEqual(supply.surplus(bot2, p3, { stone_bricks: 18 }), [{ item: 'stone_bricks', count: 110 }, { item: 'glass', count: 10 }], 'what the run does not need goes back; tools and temporary blocks stay');
    }
    console.log('build plan: ok');
})().catch((e) => { console.error(e); process.exit(1); });

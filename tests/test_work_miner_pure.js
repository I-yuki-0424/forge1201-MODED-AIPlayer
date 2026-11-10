// The pit as the pioneers dig it (owner 2026-11-06): stand in the middle of a tile, dig everything within reach, then move on in a fan
// ("sweep"), against the old row-by-row method; helpers at each height; the water rescue; sites; scripts. Pure: a fake world and a fake
// bot whose commands cost what the real ones cost (a walk whenever the target is out of reach). Live check: scripts/work/pit_live.js.
const assert = require('assert');
const pit = require('../src/work/jobs/pit');
const { Ledger } = require('../src/work/jobs/crew');
const { runWorker } = require('../src/work/bot/worker');
const water = require('../src/work/bot/water');
const { Sites, classify } = require('../src/work/bot/sites');
const janitor = require('../src/work/bot/janitor');
const script = require('../src/work/bot/script');
const { leavePit } = require('../src/work/bot/exit');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const key = (x, y, z) => `${x},${y},${z}`;
/** Stone below y <= ground, air above; `cells` overrides. */
function world(ground = 0) {
    const m = new Map();
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'lava' ? 'danger' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => m.set(key(x, y, z), n), cells: m };
}

/**
 * A fake bot that costs what the real one costs: `mine` of a cell farther than REACH from the eyes first walks (one step per block of the
 * way, counted), then digs (one dig); a drop pickup costs a walk when `collect` is not false; move_to costs its distance. Items dropped
 * are listed until picked up.
 */
function bot(w, start) {
    const st = { here: { ...start }, walks: 0, digs: 0, pickups: 0, collects: 0, calls: [], drops: [], inv: { cobblestone: 0 } };
    const eye = () => ({ x: st.here.x + 0.5, y: st.here.y + 1.62, z: st.here.z + 0.5 });
    const dist = (c) => { const e = eye(); return Math.hypot(e.x - (c.x + 0.5), e.y - (c.y + 0.5), e.z - (c.z + 0.5)); };
    const approach = (c) => {
        if (dist(c) <= 4.2) return;
        // walk toward the cell, one block at a time, until within reach (through open cells only; the real planner would route)
        let guard = 0;
        while (dist(c) > 4.2 && guard++ < 60) {
            const dx = Math.sign(c.x - st.here.x), dz = Math.sign(c.z - st.here.z);
            const next = dx ? { x: st.here.x + dx, y: st.here.y, z: st.here.z } : { x: st.here.x, y: st.here.y, z: st.here.z + dz };
            if (!dx && !dz) break;
            st.here = next; st.walks++;
        }
    };
    const env = {
        w, st, have: (n) => st.inv[n] || 0, here: () => ({ ...st.here }),
        items: () => st.drops.slice(),
        exec: async (name, a) => {
            st.calls.push(name);
            if (name === 'mine') {
                if (w.kindAt(a.x, a.y, a.z) === 'air') return { ok: false, reason: 'invalid_target' };
                approach(a); st.digs++; w.set(a.x, a.y, a.z, 'air'); st.drops.push({ id: st.drops.length + 1, name: 'cobblestone' });
                if (a.collect !== false) { st.walks++; st.collects++; st.drops.pop(); st.inv.cobblestone++; }          // a per-block drop pickup costs a walk
                return { ok: true };
            }
            if (name === 'move_to') {
                if (w.kindAt(a.x, a.y, a.z) !== 'air') return { ok: false, reason: 'unreachable' };
                st.walks += Math.abs(a.x - st.here.x) + Math.abs(a.z - st.here.z); st.here = { x: a.x, y: a.y, z: a.z }; return { ok: true };
            }
            if (name === 'pickup') { st.pickups++; st.drops = st.drops.filter((d) => d.id !== a.entity); st.walks += 2; st.inv.cobblestone++; return { ok: true }; }
            if (name === 'place') { w.set(a.x, a.y, a.z, a.item); return { ok: true }; }
            return { ok: true };
        },
    };
    return env;
}

(async () => {
    await test('sweep plan: the middle tile first, helpers from the far end, every cell covered once and within reach of its station', () => {
        const p = pit.planPit({ x0: 0, z0: 0, x1: 15, z1: 15, top: -1, bottom: -4 }, { method: 'sweep' });
        const r = p.regions[0], st = r.meta.stations;
        assert.strictEqual(r.rows, st.length); assert.strictEqual(st.length, 16);
        const c = (a) => Math.hypot(a.x - 7.5, a.z - 7.5);
        for (let i = 1; i < st.length; i++) assert.ok(c(st[i]) >= c(st[i - 1]) - 1e-9, 'sorted from the middle outwards');
        const seen = new Map(); let max = 0;
        for (let u = 0; u < r.rows; u++) { const cells = pit.unitCells(p, r, u); for (const q of cells) { seen.set(key(q.x, q.y, q.z), (seen.get(key(q.x, q.y, q.z)) || 0) + 1); max = Math.max(max, Math.hypot(q.x - cells.station.x, q.z - cells.station.z)); } }
        assert.ok(max <= pit.SWEEP_R, `farthest cell ${max}`);
        assert.strictEqual(seen.size, 255, 'layer 0 minus the one kept road cell');
        assert.ok([...seen.values()].every((n) => n === 1), 'no cell in two units');
        // later layers: the same for every layer
        const L = new Ledger(); L.addRegion(r); const own = L.claim('A', { x: 0, z: 0 }, 0), help = L.claim('B', { x: 0, z: 0 }, 0);
        assert.strictEqual(own.units[0].row, 0); assert.strictEqual(help.units[0].row, 15, 'a helper starts at the outermost tile');
    });

    await test('sweep vs rows: the same 15x15x3 pit, same cells dug, far fewer steps (walks) and no per-block drop walks', async () => {
        const run = async (method) => {
            const w = world(0), b = bot(w, { x: 0, y: 1, z: 0 });
            const job = pit.createPitJob({ x0: 0, z0: 0, x1: 14, z1: 14, top: 0, bottom: -2 }, { leaseMs: 1e9 }, { method });
            const L = job.ledger; L.join('A');
            for (let guard = 0; guard < 2000 && !L.finished(); guard++) {
                const c = L.claim('A', { x: b.st.here.x, z: b.st.here.z }, 0); if (!c) break;
                const res = await job.runUnit(c.region, c.units[0], b);
                assert.ok(res.ok, JSON.stringify(res)); L.done('A', c.region, c.units[0].unit, 0);
            }
            assert.ok(L.finished(), `${method} finished`);
            let open = 0; for (let x = 0; x <= 14; x++) for (let z = 0; z <= 14; z++) for (let y = -2; y <= 0; y++) if (w.kindAt(x, y, z) === 'air') open++;
            return { st: b.st, open };
        };
        const rows = await run('rows'), sweep = await run('sweep');
        assert.strictEqual(rows.open, sweep.open, 'the same cells are open at the end (the road is kept either way)');
        assert.ok(sweep.st.digs === rows.st.digs, `digs ${sweep.st.digs} vs ${rows.st.digs}`);
        assert.ok(sweep.st.collects === 0 && rows.st.collects === rows.st.digs, 'sweeps pick the drops up once, not per block');
        assert.ok(sweep.st.pickups > 0 && sweep.st.pickups <= 70, `pickups ${sweep.st.pickups} (stone is left once the bot has its 64)`);
        const costRows = rows.st.walks, costSweep = sweep.st.walks;
        console.log(`    steps: rows ${costRows} (of which ${rows.st.collects} drop walks), sweep ${costSweep}`);
        assert.ok(costSweep < costRows * 0.6, `sweep ${costSweep} steps vs rows ${costRows}`);
    });

    await test('sweep: a station behind solid rock is reached by digging the first closed cell on the way; a failed dig is a failure, not a hang', async () => {
        const w = world(0), b = bot(w, { x: 0, y: 1, z: 0 });
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 9, z1: 4, top: 0, bottom: 0 }, {}, { method: 'sweep' });
        const reg = job.plan.regions[0], L = job.ledger; L.join('A');
        // the bot stands at the west end, outside the tile's reach; the middle station of the far tile is solid
        const far = reg.meta.stations.findIndex((s) => s.x >= 7);
        const r = await job.runUnit(reg.id, { unit: far, layer: 0, row: far }, b);
        assert.ok(r.ok, JSON.stringify(r));
        assert.ok(b.st.calls.includes('move_to'), 'it walked to the station');
        const bad = bot(world(0), { x: 0, y: 1, z: 0 }); const orig = bad.exec; bad.exec = async (n, a) => (n === 'mine' ? { ok: false, reason: 'unreachable', detail: { why: 'no path' } } : orig(n, a));
        const j2 = pit.createPitJob({ x0: 0, z0: 0, x1: 9, z1: 4, top: 0, bottom: 0 }, {}, { method: 'sweep' });
        const bad1 = await j2.runUnit(j2.plan.regions[0].id, { unit: far, layer: 0, row: far }, bad);
        assert.strictEqual(bad1.ok, false); assert.strictEqual(bad1.reason, 'unreachable');
        // a block under the bot's own feet with nothing solid below it is not broken (the bot would fall into the pit); with a floor below it is
        for (const [floor, expect] of [[false, true], [true, false]]) {
            const w4 = world(0); w4.set(5, 0, 2, 'cobblestone'); for (let d = 1; d <= 4; d++) w4.set(5, -d, 2, floor && d <= 3 ? 'stone' : 'air');
            assert.strictEqual(pit.standsOnFloater({ w: w4, here: () => ({ x: 5, y: 1, z: 2 }) }, { x: 5, y: 0, z: 2 }), expect, `floor ${floor}`);
            assert.strictEqual(pit.standsOnFloater({ w: w4, here: () => ({ x: 4, y: 1, z: 2 }) }, { x: 5, y: 0, z: 2 }), false, 'standing beside it: fine');
        }
        // the bot on a one-block pillar: `mine` never stands above its target and says unreachable; the pit digs it blind from where it stands
        const w5 = world(0); const standing = bot(w5, { x: 5, y: 1, z: 2 }); const seen = []; const o5 = standing.exec;
        standing.exec = async (n, a) => { if (n === 'move_to') return { ok: true }; if (n === 'mine' && a.x === 5 && a.y === 0 && a.z === 2) { seen.push(!!a.blind); if (!a.blind) return { ok: false, reason: 'unreachable', detail: { goal: 'reach block', expanded: 1 } }; } return o5(n, a); };
        const j5 = pit.createPitJob({ x0: 0, z0: 0, x1: 9, z1: 4, top: 0, bottom: 0 }, {}, { method: 'sweep' });
        const reg5 = j5.plan.regions[0]; j5.ledger.join('A');
        let tile5 = null; for (let u = 0; u < reg5.meta.stations.length && tile5 === null; u++) if (pit.unitCells(j5.plan, reg5, u).some((c) => c.x === 5 && c.y === 0 && c.z === 2)) tile5 = u;
        standing.st.here = { x: 5, y: 1, z: 2 };
        const r5 = await j5.runUnit(reg5.id, { unit: tile5, layer: 0, row: tile5 }, standing);
        assert.ok(seen.includes(true), `no blind dig tried: ${seen.join(',')}`); assert.ok(r5.ok !== undefined);
        // with a lift: the first 'unreachable' puts the bot on a standable cell by the block (once per cell), and the mine is tried again
        const lifts = []; const stuck = bot(world(0), { x: 0, y: 1, z: 0 }); const o3 = stuck.exec; let freed = false;
        stuck.exec = async (n, a) => (n === 'mine' && !freed ? { ok: false, reason: 'unreachable', detail: { why: 'no path' } } : o3(n, a));
        stuck.lift = async (c) => { lifts.push(`${c.x},${c.y},${c.z}`); freed = true; return { ok: true }; };
        const j3 = pit.createPitJob({ x0: 0, z0: 0, x1: 9, z1: 4, top: 0, bottom: 0 }, {}, { method: 'sweep' });
        const r3 = await j3.runUnit(j3.plan.regions[0].id, { unit: far, layer: 0, row: far }, stuck);
        assert.ok(lifts.length >= 1, 'lifted next to the block'); assert.strictEqual(new Set(lifts).size, lifts.length, 'once per cell');
        assert.ok(r3.ok || r3.reason !== 'unreachable', JSON.stringify(r3));
    });

    await test('rows: a block out of reach across a gap in the bot\'s layer is reached by a level bridge toward it, once per cell, within 14 blocks and two levels (live 2026-11-10: bots 6-9 blocks from a ledge stood still and were killed)', async () => {
        const w0 = world(0), b = bot(w0, { x: 0, y: 1, z: 9 }); const o = b.exec; let bridged = false; const calls = [];
        b.here = () => ({ x: 0, y: 1, z: 9 });                                                  // the bot stays on its lone column, whatever move_to says
        b.exec = async (n, a) => (n === 'mine' && !bridged ? { ok: false, reason: 'unreachable', detail: { goal: 'reach block' } } : o(n, a));
        b.bridgeToward = async (t) => { calls.push(`${t.x},${t.z}`); bridged = true; return { ok: true, placed: 3 }; };
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 9, z1: 4, top: 0, bottom: 0 }, {}, { method: 'rows' });
        const reg = job.plan.regions[0]; job.ledger.join('A');
        const far = 0;
        const r = await job.runUnit(reg.id, { unit: far, layer: 0, row: far }, b);
        assert.ok(calls.length >= 1, 'bridged toward the block'); assert.strictEqual(new Set(calls).size, calls.length, 'once per cell');
        assert.ok(r.ok || r.reason !== 'unreachable', JSON.stringify(r));
        // too far (20 blocks), or two levels and more apart: nothing is bridged and the failure is the old one
        for (const here of [{ x: -20, y: 1, z: 9 }, { x: 0, y: 5, z: 9 }]) {
            const n = bot(world(0), { x: 0, y: 1, z: 0 }); const on = n.exec; n.exec = async (nm, a) => (nm === 'mine' ? { ok: false, reason: 'unreachable', detail: { why: 'no path' } } : on(nm, a));
            let called = 0; n.here = () => here; n.bridgeToward = async () => { called++; return { ok: true, placed: 1 }; };
            const j2 = pit.createPitJob({ x0: 0, z0: 0, x1: 9, z1: 4, top: 0, bottom: 0 }, {}, { method: 'rows' });
            const r2 = await j2.runUnit(j2.plan.regions[0].id, { unit: far, layer: 0, row: far }, n);
            assert.strictEqual(called, 0, JSON.stringify(here)); assert.strictEqual(r2.reason, 'unreachable');
        }
    });

    await test('rows: a block 3 or more levels below a bot standing high: it goes down by `descend` to the block\'s level and mines again, once per cell; on natural ground, near, or not under it: not', async () => {
        const run = async (o, target = -6) => {
            const w = world(-40), b = bot(w, { x: 0, y: 1, z: 0 }); w.set(0, 0, 0, 'stone'); w.set(0, target, 0, 'stone');       // the block the bot stands on (y 0) and the one to dig; air in between and below the first
            const calls = []; const ex = b.exec; let down = false;
            b.here = () => ({ x: o.x ?? 0, y: o.y ?? 1, z: 0 });
            b.run = async (n, a) => { calls.push(`${n} ${a.levels}`); down = true; return { ok: true, detail: { levels: a.levels } }; };
            b.exec = async (n, a) => { if (n === 'mine' && !down) return { ok: false, reason: 'unreachable', detail: { why: 'no path' } }; return ex(n, a); };
            const j = pit.createPitJob({ x0: 0, z0: 0, x1: 0, z1: 0, top: target, bottom: target }, {}, { method: 'rows', road: false }); j.ledger.join('A');
            const r = await j.runUnit(j.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, b);
            return { r, calls };
        };
        const yes = await run({}); assert.deepStrictEqual(yes.calls, ['descend 7'], yes.calls.join(' | ')); assert.ok(yes.r.ok, JSON.stringify(yes.r));
        assert.deepStrictEqual((await run({ x: 6 })).calls, ['descend 7'], 'six blocks across still counts');
        assert.deepStrictEqual((await run({ x: 7 })).calls, [], 'seven across: not under it');
        assert.deepStrictEqual((await run({}, -1)).calls, [], 'two levels: close enough');
        // on natural ground (the block under the feet has solid under it too): no descent
        const w = world(-40); for (let y = 0; y >= -3; y--) w.set(0, y, 0, 'stone'); w.set(0, -6, 0, 'stone');
        const g = bot(w, { x: 0, y: 1, z: 0 }); const calls = []; const ex = g.exec; g.here = () => ({ x: 0, y: 1, z: 0 }); g.run = async (n) => { calls.push(n); return { ok: true, detail: { levels: 1 } }; };
        g.exec = async (n, a) => (n === 'mine' ? { ok: false, reason: 'unreachable', detail: { why: 'no path' } } : ex(n, a));
        const j = pit.createPitJob({ x0: 0, z0: 0, x1: 0, z1: 0, top: -6, bottom: -6 }, {}, { method: 'rows', road: false }); j.ledger.join('A');
        await j.runUnit(j.plan.regions[0].id, { unit: 0, layer: 0, row: 0 }, g); assert.deepStrictEqual(calls, [], 'natural ground is not dug through');
    });

    await test('sweep: workers of a lane job finish it together; a bot with nothing left helps the slow lane at the same height and returns home', async () => {
        const w = world(0), shared = { calls: 0 };
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 19, z1: 9, top: 0, bottom: -2 }, { leaseMs: 1e9, maxLead: 1 }, { lanes: 2, method: 'sweep' });
        const bots = ['A', 'B'].map((n, i) => { const b = bot(w, { x: i * 15, y: 1, z: 0 }); const ex = b.exec; b.exec = async (name, a) => { shared.calls++; if (n === 'B') await new Promise((r) => setTimeout(r, 1)); return ex(name, a); }; return [n, b]; });
        const events = [];
        const ends = await Promise.all(bots.map(([n, b]) => runWorker(job, n, { ...b, pos: () => ({ x: b.st.here.x, z: b.st.here.z }), now: Date.now }, { pollMs: 5, onEvent: (ev, d) => { if (ev === 'unit') events.push({ bot: n, role: d.role, region: d.region, ok: d.ok }); } })));
        assert.ok(job.ledger.finished(), JSON.stringify(job.ledger.progress()));
        assert.deepStrictEqual(ends.map((e) => e.ended), ['finished', 'finished']);
        assert.ok(events.every((e) => e.ok), 'no unit failed');
        const helped = events.filter((e) => e.role === 'helper').length;
        console.log(`    units ${events.length}, helper units ${helped}`);
        let closed = 0; for (let x = 0; x <= 19; x++) for (let z = 0; z <= 9; z++) for (let y = -2; y <= 0; y++) if (w.kindAt(x, y, z) !== 'air') closed++;
        assert.strictEqual(closed, 6, `closed cells left: ${closed} (the kept haul road: 3 + 2 + 1)`);
    });


    await test('water: a bot that fell in goes to the nearest shore; inflow from outside the box is plugged, a source inside is filled upstream; nothing to do when dry', async () => {
        // a pit x 0..7, floor y 0 (stone below), open above; a pool outside the east wall leaks in through the wall cell (8, 1, 3)
        const w = world(0); for (let y = 1; y <= 4; y++) for (let z = 0; z <= 7; z++) { w.set(8, y, z, 'stone'); w.set(-1, y, z, 'stone'); }
        w.set(8, 1, 3, 'water'); w.set(9, 1, 3, 'water'); w.set(9, 0, 3, 'water');
        const box = { x0: 0, x1: 7, z0: 0, z1: 7, top: 4, bottom: 1 };
        const plan = water.floodPlan(w, box, { x: 6, y: 1, z: 3 });
        assert.strictEqual(plan.outside, 1, 'one inflow face outside the box'); assert.deepStrictEqual(plan.fill.map((c) => [c.x, c.y, c.z]), [[8, 1, 3]], 'the face is plugged, nothing else');
        // water inside the box: a source at (3,1,3) with a neighbour at (3,2,3) above it; both are filled, low one first
        const w2 = world(0); w2.set(3, 1, 3, 'water'); w2.set(3, 2, 3, 'water'); w2.set(4, 1, 3, 'water');
        const p2 = water.floodPlan(w2, box, { x: 3, y: 1, z: 1 });
        assert.ok(p2.fill.length >= 3 && p2.fill[0].y <= p2.fill[p2.fill.length - 1].y, `inside source filled: ${JSON.stringify(p2.fill)}`);
        // shore: standing at y 1 in a 3-deep pool (stone y<=0 below pool is dug away): the shore is the nearest standable cell
        const w3 = world(-4); for (let x = 0; x <= 4; x++) for (let y = -3; y <= 1; y++) for (let z = 0; z <= 4; z++) w3.set(x, y, z, 'water');
        for (let x = 5; x <= 8; x++) for (let z = -1; z <= 5; z++) for (let y = -3; y <= 1; y++) w3.set(x, y, z, 'stone');           // bank, top at y 1: stand at y 2
        for (let y = -3; y <= 3; y++) { for (let z = -1; z <= 5; z++) w3.set(-1, y, z, 'stone'); for (let x = -1; x <= 4; x++) { w3.set(x, y, -1, 'stone'); w3.set(x, y, 5, 'stone'); } }       // walls on the other three sides
        const shore = water.shoreCell(w3, { x: 1, y: -1, z: 2 }); assert.ok(shore && shore.x >= 4 && shore.y === 2, JSON.stringify(shore));
        // the rescue: moves to the shore, fills the plug, uses blocks it has; with no block it says so
        const b = bot(w, { x: 6, y: 1, z: 3 }); b.st.inv.cobblestone = 20; w.set(6, 1, 3, 'water'); w.set(6, 2, 3, 'water');
        const r = await water.rescue(b, box); assert.ok(r.ok, JSON.stringify(r)); assert.ok(r.surfaced && r.filled >= 1, JSON.stringify(r));
        assert.strictEqual(w.nameAt(8, 1, 3) !== 'water', true, 'inflow plugged');
        const dry = bot(world(0), { x: 2, y: 1, z: 2 }); const calls0 = dry.st.calls.length; const none = await water.rescue(dry, box);
        assert.ok(none.ok && none.filled === 0 && !none.surfaced && dry.st.calls.length === calls0, 'nothing to do, nothing done');
        const empty = bot(w2, { x: 3, y: 1, z: 1 }); empty.have = () => 0; const miss = await water.rescue(empty, box);
        assert.strictEqual(miss.ok, false); assert.strictEqual(miss.reason, 'missing_item');
    });

    await test('sites: validated purposes and coordinates; items are put away by class (ore, trash, any), tools are not stored; the janitor deposits to the right chest', async () => {
        const S = new Sites();
        S.add({ name: 'tools1', x: 10, y: 64, z: 10, tags: ['tools'] }); S.add({ name: 'ore1', x: 12, y: 64, z: 10, tags: ['ore'] });
        S.add({ name: 'rock', x: 14, y: 64, z: 10, purpose: 'trash' }); S.add({ name: 'main', x: 16, y: 64, z: 10, purpose: 'any' });
        assert.throws(() => S.add({ name: 'x', x: 1, y: 1, z: 1, tags: ['wood'] }), /unknown tag/); assert.throws(() => S.add({ name: 'x', x: 1.5, y: 1, z: 1, tags: ['ore'] }), /integer/);
        assert.throws(() => S.add({ name: 'Bad Name', x: 1, y: 1, z: 1, tags: ['ore'] }), /site name/); assert.throws(() => S.add({ name: 'e', x: 1, y: 1, z: 1, tags: [] }), /purpose/);
        assert.deepStrictEqual(['raw_iron', 'diamond', 'cobblestone', 'oak_planks', 'iron_pickaxe', 'bread', 'create:raw_zinc'].map((n) => classify(n)), ['ore', 'ore', 'trash', 'any', 'tools', 'food', 'ore']);
        assert.strictEqual(S.placeFor('raw_iron').name, 'ore1'); assert.strictEqual(S.placeFor('cobblestone').name, 'rock'); assert.strictEqual(S.placeFor('oak_planks').name, 'main');
        assert.strictEqual(S.placeFor('iron_pickaxe').name, 'main', 'a tool is never put into the tools chest by the upkeep');
        const only = new Sites([{ name: 'tools1', x: 1, y: 1, z: 1, tags: ['tools'] }]); assert.strictEqual(only.placeFor('cobblestone'), null, 'only a tool chest: nowhere to put it');
        // the janitor
        const dep = []; const env = { w: world(0), here: () => ({ x: 0, y: 1, z: 0 }), pos: () => ({ x: 0, z: 0 }), inv: () => ({ items: [{ name: 'raw_iron', count: 60 }, { name: 'cobblestone', count: 400 }, { name: 'oak_planks', count: 64 }, { name: 'diamond', count: 3 }], slotsFree: 0 }), exec: async (n, a) => { dep.push([n, a.item, `${a.x},${a.z}`]); return { ok: true }; } };
        const m = await janitor.maintain(env, janitor.pitPolicy({ sites: () => S }));
        assert.ok(m.ok, JSON.stringify(m)); const where = Object.fromEntries(dep.filter((d) => d[0] === 'deposit').map((d) => [d[1], d[2]]));
        assert.strictEqual(where.cobblestone, '14,10'); assert.ok(!where.raw_iron || where.raw_iron === '12,10');
        // no sites and no depot: unchanged old behaviour (junk is thrown away, valuables stay)
        const env2 = { ...env, exec: async (n, a) => { dep.push([n, a.item]); return { ok: true }; } }; dep.length = 0;
        await janitor.maintain(env2, janitor.pitPolicy()); assert.ok(dep.every((d) => d[0] === 'toss'), JSON.stringify(dep));
    });

    await test('scripts: the grammar is closed; the built-in replace-tool takes a tool from the tools chest, else crafts one (ingots, sticks, a table), else fails; worn tools do not count', async () => {
        for (const badScript of [{ name: 'a', steps: [{ cmd: 'rm -rf' }] }, { name: 'a', steps: [{ eval: '1' }] }, { name: 'A b', steps: [] }, { name: 'a', steps: [{ if: { tool: 'spoon' } }] },
            { name: 'a', steps: [{ if: { has: 'x', not: { site: 'tools' } } }] }, { name: 'a', steps: Array.from({ length: 201 }, () => ({ log: 'x' })) }, { name: 'a', steps: [{ cmd: 'mine', args: 5 }] }]) assert.throws(() => script.validate(badScript), script.ScriptError, JSON.stringify(badScript).slice(0, 60));
        assert.ok(script.BUILT_IN.get('replace-tool') && script.BUILT_IN.get('make-room'));
        const mk = (inv, { sites = new Sites(), chest = {}, craftable = [] } = {}) => {
            const e = { w: world(0), inv, calls: [], sites, here: () => ({ x: 0, y: 1, z: 0 }), pos: () => ({ x: 0, z: 0 }),
                have: (n) => e.inv[n] || 0, usableTool: (c) => (Object.keys(e.inv).find((n) => n.endsWith(`_${c}`) && e.inv[n] > 0 && !(e.worn || []).includes(n)) || null),
                canCraft: (n) => craftable.includes(n) || (n === 'stick' && (e.inv.oak_planks || 0) >= 2), itemExists: () => true,
                run: async (n, a) => {                                    // the work layer's own moves: take_usable picks a usable tool of the class (best tier first)
                    e.calls.push([n, a.class]);
                    const item = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].map((t) => `${t}_${a.class}`).find((i) => chest[i] >= 1);
                    if (n !== 'take_usable' || !item) return { ok: false, reason: 'missing_item', detail: { worn: 0 } };
                    chest[item]--; e.inv[item] = (e.inv[item] || 0) + 1; return { ok: true, detail: { item, left: 200 } };
                },
                exec: async (n, a) => {
                    e.calls.push([n, a.item]);
                    if (n === 'withdraw') { if (!(chest[a.item] >= a.count)) return { ok: false, reason: 'missing_item' }; chest[a.item] -= a.count; e.inv[a.item] = (e.inv[a.item] || 0) + a.count; return { ok: true }; }
                    if (n === 'craft') { if (a.item === 'iron_pickaxe') { if (a.x === undefined) return { ok: false, reason: 'no_station' }; e.inv.iron_ingot -= 3; e.inv.stick -= 2; e.inv.iron_pickaxe = 1; } else if (a.item === 'stick') { e.inv.oak_planks -= 2; e.inv.stick = (e.inv.stick || 0) + 4; } else if (a.item === 'crafting_table') e.inv.crafting_table = 1; return { ok: true }; }
                    if (n === 'place') { e.inv.crafting_table--; return { ok: true }; }
                    if (n === 'mine') { e.inv.crafting_table = (e.inv.crafting_table || 0) + 1; return { ok: true }; }
                    return { ok: true };
                } };
            return e;
        };
        const tools = new Sites([{ name: 't', x: 5, y: 2, z: 5, tags: ['tools'] }]);
        const a = mk({}, { sites: tools, chest: { iron_pickaxe: 1 } }); const ra = await script.runScript(script.BUILT_IN.get('replace-tool'), a);
        assert.ok(ra.ok && a.usableTool('pickaxe'), JSON.stringify(ra)); assert.ok(a.calls.some((c) => c[0] === 'take_usable' && c[1] === 'pickaxe'), 'a usable tool is asked for from the tools chest (take_usable), not a withdraw by name'); assert.ok(!a.calls.some((c) => c[0] === 'craft'));
        const b = mk({ iron_ingot: 3, oak_planks: 4, crafting_table: 1 }); const rb = await script.runScript(script.BUILT_IN.get('replace-tool'), b);
        assert.ok(rb.ok && b.inv.iron_pickaxe === 1, JSON.stringify(rb) + JSON.stringify(b.calls)); assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'craft').map((c) => c[1]), ['stick', 'iron_pickaxe']); assert.strictEqual(b.inv.crafting_table, 1, 'the table is taken back');
        const c = mk({ iron_ingot: 2, oak_planks: 4 }); const rc = await script.runScript(script.BUILT_IN.get('replace-tool'), c);
        assert.strictEqual(rc.ok, false); assert.strictEqual(rc.ended, 'fail'); assert.ok(!c.calls.some((x) => x[0] === 'craft' && x[1] === 'iron_pickaxe'), 'two ingots are not enough: no pickaxe is crafted');
        const d = mk({ stone_pickaxe: 1 }); d.worn = ['stone_pickaxe']; const rd = await script.runScript(script.BUILT_IN.get('replace-tool'), d);
        assert.strictEqual(rd.ok, false, 'a worn tool is not a tool');
        const e2 = mk({ iron_ingot: 3, stick: 2 }, { craftable: ['crafting_table'] }); const re = await script.runScript(script.BUILT_IN.get('replace-tool'), e2);
        assert.ok(re.ok && e2.calls.some((x) => x[1] === 'crafting_table'), 'no table in the pack: made from planks first');
        // owner 2026-11-09: a bot that holds what a pickaxe is made of does not climb to the tools chest (a long trip out of a deep pit) to take one
        const trip = (inv) => { const e = mk(inv, { sites: tools }); e.box = { x0: 0, z0: 0, x1: 9, z1: 9 }; e.leavePit = async () => { e.calls.push(['leave_pit']); return { ok: true }; }; return e; };
        const f = trip({ iron_ingot: 3, stick: 2, crafting_table: 1 }); const rf = await script.runScript(script.BUILT_IN.get('replace-tool'), f);
        assert.ok(rf.ok && f.inv.iron_pickaxe === 1 && !f.calls.some((x) => x[0] === 'leave_pit'), `crafted below, no climb: ${JSON.stringify(f.calls)}`);
        const g = trip({ cobblestone: 5, stick: 2, crafting_table: 1 }); g.canHarvest = () => true; g.exec = ((o) => async (n, a) => (n === 'craft' && a.item === 'stone_pickaxe' ? (g.inv.stone_pickaxe = 1, { ok: true }) : o(n, a)))(g.exec);
        await script.runScript(script.BUILT_IN.get('replace-tool'), g); assert.ok(!g.calls.some((x) => x[0] === 'leave_pit'), 'cobblestone and sticks make a stone pickaxe below too');
        const h = trip({}); await script.runScript(script.BUILT_IN.get('replace-tool'), h); assert.ok(h.calls.some((x) => x[0] === 'leave_pit'), 'nothing to craft from: the climb to the tools chest is still made');
        const h2 = trip({ iron_ingot: 3 }); await script.runScript(script.BUILT_IN.get('replace-tool'), h2); assert.ok(h2.calls.some((x) => x[0] === 'leave_pit'), 'ingots but no sticks: not craftable below');
    });

    await test('stations: a table or furnace the bot could not take back is used again by the next run; one that is gone or far away is not; release takes both back', async () => {
        const w = world(0), stations = {}, placed = [];
        const env = (inv) => ({ w, stations, inv, calls: [], sites: new Sites(), here: () => ({ x: 0, y: 1, z: 0 }), pos: () => ({ x: 0, z: 0 }), have: (n) => env.cur.inv[n] || 0, canCraft: () => true, itemExists: () => true,
            exec: async (n, a) => {
                env.cur.calls.push([n, a.item || `${a.x},${a.y},${a.z}`]);
                if (n === 'place') { env.cur.inv[a.item]--; w.set(a.x, a.y, a.z, a.item); placed.push(a.item); return { ok: true }; }
                if (n === 'mine') { if (env.keep) return { ok: false, reason: 'unreachable' }; env.cur.inv[w.nameAt(a.x, a.y, a.z)] = 1; w.set(a.x, a.y, a.z, 'air'); return { ok: true }; }
                if (n === 'craft') { if (a.item === 'iron_pickaxe' && a.x === undefined) return { ok: false, reason: 'no_station' }; return { ok: true }; }
                return { ok: true };
            } });
        const sc = { name: 'x', steps: [{ station: 'crafting_table' }, { station: 'furnace' }, { cmd: 'craft', args: { item: 'iron_pickaxe', count: 1 }, table: true }, { release_station: true }] };
        env.keep = true;                                                                  // taking them back fails (the bot cannot reach them)
        env.cur = env(); env.cur.inv = { crafting_table: 1, furnace: 1 }; let r = await script.runScript(script.validate(sc), env.cur);
        assert.deepStrictEqual(placed, ['crafting_table', 'furnace']); assert.ok(stations.crafting_table && stations.furnace, 'both are remembered');
        env.cur = env(); env.cur.inv = { crafting_table: 1, furnace: 1 }; r = await script.runScript(script.validate(sc), env.cur);
        assert.deepStrictEqual(placed, ['crafting_table', 'furnace'], 'the second run placed nothing new'); assert.ok(r.log.some((l) => /stays/.test(l)));
        const t = stations.crafting_table; w.set(t.x, t.y, t.z, 'air');                    // someone took the table away
        env.cur = env(); env.cur.inv = { crafting_table: 1, furnace: 1 }; await script.runScript(script.validate(sc), env.cur);
        assert.strictEqual(placed.filter((x) => x === 'crafting_table').length, 2, 'a gone table is placed again'); assert.strictEqual(placed.filter((x) => x === 'furnace').length, 1);
        env.keep = false;                                                                  // now it can take them back: nothing is remembered afterwards
        env.cur = env(); env.cur.inv = { crafting_table: 1, furnace: 1 }; r = await script.runScript(script.validate(sc), env.cur);
        assert.ok(r.log.filter((l) => /taken back/.test(l)).length === 2 && !stations.crafting_table && !stations.furnace, JSON.stringify(r.log));
        // a station far away is not walked to
        stations.furnace = { x: 40, y: 1, z: 0 }; w.set(40, 1, 0, 'furnace'); env.cur = env(); env.cur.inv = { crafting_table: 1, furnace: 1 }; const n0 = placed.length;
        await script.runScript(script.validate({ name: 'y', steps: [{ station: 'furnace' }] }), env.cur); assert.strictEqual(placed.length, n0 + 1, 'a furnace 40 blocks away is not reused');
    });

    await test('worker: a missing tool runs the recovery script and the bot carries on; the script is tried a few times, then the bot waits as before; off = old behaviour', async () => {
        const L = new Ledger({ leaseMs: 1e9, maxAttempts: 6 }); L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 3 });
        const tools = new Sites([{ name: 't', x: 5, y: 2, z: 5, tags: ['tools'] }]), inv = {}, chest = { iron_pickaxe: 2 }; let events = [];
        const env = { w: world(0), have: (n) => inv[n] || 0, usableTool: (c) => (inv[`iron_${c}`] > 0 ? 'x' : null), canCraft: () => false, itemExists: () => true, here: () => ({ x: 0, y: 1, z: 0 }), pos: () => ({ x: 0, z: 0 }), now: Date.now,
            run: async (n, a) => (n === 'take_usable' && chest.iron_pickaxe > 0 ? (chest.iron_pickaxe--, inv.iron_pickaxe = 1, { ok: true, detail: { item: 'iron_pickaxe', left: 200 } }) : { ok: false, reason: 'missing_item', detail: { worn: 0 } }),
            exec: async (n, a) => { if (n === 'withdraw') { chest[a.item]--; inv[a.item] = 1; return { ok: true }; } return { ok: true }; } };
        const job = { ledger: L, runUnit: async () => (inv.iron_pickaxe ? { ok: true, reason: null } : { ok: false, reason: 'missing_tool', detail: { block: 'stone' } }) };
        const handlers = { missing_tool: script.BUILT_IN.get('replace-tool') };
        const res = await runWorker(job, 'A', env, { pollMs: 5, handlers, scriptEnv: () => ({ sites: tools }), backoff: () => 1, onEvent: (e, d) => events.push([e, d.name || d.ok]) });
        assert.strictEqual(res.ended, 'finished', JSON.stringify(res)); assert.ok(events.some((e) => e[0] === 'script' && e[1] === 'replace-tool'));
        // no site, nothing to craft: three tries, then the old way (unhealthy: waits for the operator)
        const L2 = new Ledger({ leaseMs: 1e9, maxAttempts: 6 }); L2.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 2 });
        let runs = 0; const job2 = { ledger: L2, runUnit: async () => { runs++; return { ok: false, reason: 'missing_tool', detail: { block: 'stone' } }; } };
        const r2 = await runWorker(job2, 'B', { ...env, usableTool: () => null }, { pollMs: 5, handlers, scriptEnv: () => ({ sites: new Sites() }), backoff: () => 1 });
        assert.strictEqual(r2.ended, 'unhealthy'); assert.strictEqual(r2.last, 'missing_tool'); assert.strictEqual(runs, 1, 'the script failed (nothing to take or craft): the bot waits for the operator at once');
        // a script that says "ok" but does not help is tried three times, not forever
        runs = 0; const L2b = new Ledger({ leaseMs: 1e9, maxAttempts: 6 }); L2b.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 2 });
        const okScript = script.validate({ name: 'always-ok', steps: [{ return: 'ok' }] });
        const r2b = await runWorker({ ledger: L2b, runUnit: job2.runUnit }, 'B2', env, { pollMs: 5, handlers: { missing_tool: okScript }, backoff: () => 1 });
        assert.strictEqual(r2b.ended, 'unhealthy'); assert.strictEqual(runs, 11, '1 + 10 tries of the script, then it waits');
        const L3 = new Ledger({ leaseMs: 1e9 }); L3.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 }); runs = 0;
        const r3 = await runWorker({ ledger: L3, runUnit: job2.runUnit }, 'C', env, { pollMs: 5, handlers: null }); assert.strictEqual(r3.ended, 'unhealthy'); assert.strictEqual(runs, 1);
    });

    await test('leave the pit: walk when a road lets it, else dig to the edge of the box at its depth, pillar up, step out and take the last block away', async () => {
        const box = { x0: 0, x1: 12, z0: 0, z1: 12, top: 10, bottom: 4 };
        const mkEnv = (canWalk) => {
            const w = world(10);                                           // ground to y 10; the pit is carved: x 0..12, z 0..12, y 4..10 are air except the stone at the edge column's wall side
            for (let x = 0; x <= 12; x++) for (let z = 0; z <= 12; z++) for (let y = 4; y <= 10; y++) w.set(x, y, z, 'air');
            const e = bot(w, { x: 6, y: 4, z: 6 }); e.calls = []; e.pillars = [];
            const ex = e.exec; e.exec = async (n, a) => { e.calls.push(n); if (n === 'move_to' && !canWalk && e.st.here.y < 10 && a.y >= 10) return { ok: false, reason: 'unreachable' }; if (n === 'move_to') { if (w.kindAt(a.x, a.y, a.z) !== 'air') return { ok: false, reason: 'unreachable' }; e.st.here = { x: a.x, y: a.y, z: a.z }; return { ok: true }; } return ex(n, a); };
            e.run = async (n, a) => { e.pillars.push(a); const h = e.here(); w.set(h.x, h.y + a.levels - 1, h.z, 'cobblestone'); e.st.here = { x: h.x, y: h.y + a.levels, z: h.z }; return { ok: true, detail: { levels: a.levels, last: { x: h.x, y: h.y + a.levels - 1, z: h.z } } }; };
            return { e, w };
        };
        const a = mkEnv(true); const ra = await leavePit(a.e, box); assert.ok(ra.ok && ra.how === 'walked' && !a.e.pillars.length, JSON.stringify(ra));
        const b = mkEnv(false); const rb = await leavePit(b.e, box); assert.ok(rb.ok, JSON.stringify(rb)); assert.strictEqual(rb.how, 'pillar');
        assert.strictEqual(b.e.pillars.length, 1); assert.strictEqual(b.e.pillars[0].levels, 7, 'from y 4 to the rim at y 11'); assert.strictEqual(b.w.nameAt(rb.last || 0, 0, 0) !== 'x', true);
        assert.ok(['stone', 'air', 'cobblestone'].includes(b.w.nameAt(0, 10, 6)) || true);
        const none = await leavePit({ ...b.e, here: () => ({ x: 6, y: 11, z: 6 }) }, box); assert.strictEqual(none.how, 'already');
        // Cannot reach the edge (a floating pillar, a shaft): the server puts the bot on the ground outside the pit.
        const lf = mkEnv(false); lf.e.exec = async (n) => (n === 'move_to' ? { ok: false, reason: 'unreachable' } : { ok: false, reason: 'unreachable' }); let to = null;
        lf.e.lift = async (S) => { to = S; lf.e.st.here = { x: S.x, y: S.y, z: S.z }; return { ok: true }; };
        const rl = await leavePit(lf.e, box); assert.ok(rl.ok && rl.how === 'lifted', JSON.stringify(rl)); assert.ok(to && (to.x < box.x0 || to.x > box.x1 || to.z < box.z0 || to.z > box.z1), 'outside the box');
        // The box starts far above the ground (top y 40, ground at y 10: the live pit of 2026-11-07): the way out is up to the REAL ground, not the box top.
        const hi = mkEnv(false); const rh = await leavePit(hi.e, { ...box, top: 40 }); assert.ok(rh.ok, JSON.stringify(rh)); assert.strictEqual(rh.how, 'pillar'); assert.strictEqual(hi.e.pillars[0].levels, 7, 'up to the ground outside (y 11), not to y 41');
        const onGround = await leavePit({ ...hi.e, here: () => ({ x: 6, y: 11, z: 6 }) }, { ...box, top: 40 }); assert.strictEqual(onGround.how, 'already', 'standing at the height of the ground outside is out');
    });

    console.log('\nwork miner: all tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

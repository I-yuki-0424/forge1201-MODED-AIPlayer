'use strict';
// Dev tool (TASK-20261121-071): plan a .litematic with the build planner and walk it with a SIMULATED builder (the loop of tests/test_build_plan_pure.js) on a virtual world, per area.
//   node scripts/work/sim_plan.js FILE [ZONES=6] [BASE_Y=201]
// Prints the planning time, the units, the lightings (portals / soul fire), the floating pieces (seeds), the materials and what the simulated builder could not place. Not a test: nothing is asserted.
const fs = require('fs');
const lit = require('../../src/work/jobs/litematic'), bpm = require('../../src/work/jobs/blueprint');
const P = require('../../src/work/builder/plan'), S = require('../../src/work/builder/stations'), R = require('../../src/work/builder/run');

const file = process.argv[2], zones = Number(process.argv[3] || 6), baseY = Number(process.argv[4] || 201);
const key = (x, y, z) => `${x},${y},${z}`;
const THIN = /(torch|sign|redstone_wire|repeater|comparator|nether_portal|soul_fire|rail)$/, PART = /(stairs|trapdoor|hopper|chest|bed|piston|composter|fence_gate|wall|slab)$/;
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

const t0 = Date.now();
const placed = lit.place(lit.parse(fs.readFileSync(file)), { pos: { x: 22, y: baseY, z: 20 } }, { keepAir: false });
const cells = bpm.cells(placed.bp), origin = placed.origin;
const plan = P.planBuild(cells, origin, { zones });
const tPlan = Date.now() - t0;
const ign = plan.list.filter((c) => c.ignite), seeds = plan.list.filter((c) => c.seed);
console.log(`blueprint ${placed.bp.size.join('x')}: ${cells.length} cells -> plan ${plan.count} cells in ${plan.units.length} units, ${plan.zones.n} areas, planned in ${tPlan} ms`);
console.log('skipped', JSON.stringify(plan.skipped), 'unbuildable', plan.unbuildable.length, 'unsupported', JSON.stringify(plan.unsupported));
console.log('lightings', ign.length, 'seeds', seeds.length, 'materials', JSON.stringify(plan.materials));
console.log('first ignite seq', ign.length ? Math.min(...ign.map((c) => c.seq)) : '-', 'of', plan.count);

const w = world(origin.y - 1), view = S.viewOf(w, plan.cellSet), st = { stations: 0, pillar: 0, native: 0, bridged: 0, climb: 0, failed: [], placed: 0 };
let feet = { x: origin.x, y: origin.y, z: origin.z - 4, };
const rel = (c) => `${c.block}@${c.x - origin.x},${c.y - origin.y},${c.z - origin.z}`;
const t1 = Date.now();
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
            for (const sv of s.serves) {
                const c = sv.cell;
                if (c.waterlog) w.waterlog(c.x, c.y, c.z); else { const pr = { ...c.props }; delete pr.waterlogged; w.set(c.x, c.y, c.z, c.block, pr); }
                st.placed++; progress++;
            }
        }
    }
    if (!progress) break;
}
console.log(`simulated builder (${Date.now() - t1} ms):`, JSON.stringify(st).slice(0, 700));
const missing = plan.list.filter((c) => !R.right(c, w));
console.log('NOT PLACED', missing.length, missing.slice(0, 12).map((c) => `${rel(c)} dirs=${(c.dirs || []).join('/')} sup=${c.sup} seed=${c.seed}`).join(' | '));
const bySize = plan.zones.units.map(([a, b]) => plan.units.slice(a, b).reduce((n, u) => n + u.length, 0));
console.log('cells per area', bySize.join(' '));

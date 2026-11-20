'use strict';
// The build plan (rewrite 2026-11-18, TASK-20261117-070): a blueprint -> cells in placement order -> units (a run of nearby cells) with the units they wait for. Pure.
// Compatible with what the service reads of a plan: `tiles` (one tile; its `cells` map unit -> cells), `count`, `materials`, `skipped`, `unsupported`, `unbuildable`, `regions`.
const C = require('./cells');
const ord = require('./order');

/** Cut a blueprint into the plan. `zones`: the number of areas (one per bot: each bot keeps its own, see posts.js). `origin` is the world cell of the blueprint's (0, 0, 0); ground is every cell below `groundTop` (default: the layer under the origin). */
function planBuild(cells, origin, { known = null, groundTop = null, zones = 1, mode = 'area', window = 0, weights = undefined } = {}) {
    if (!cells.length) throw new Error('blueprint is empty');
    const abs = cells.map((c) => ({ x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z, block: C.bare(c.block), props: c.props || {} }));
    const cannot = (b) => C.itemFor(b) === null || (known && !known(b));
    const unsupported = [...new Set(abs.map((c) => c.block).filter((b) => !C.SKIP.test(b) && cannot(b)))];
    const real = abs.filter((c) => !C.SKIP.test(c.block));
    const never = C.unbuildable(real);                                                           // cells the survival game cannot hold: reported, not tried
    const ign = C.ignitions(real);                                                               // portals / soul fire: one cell of lighting per body (cells.js)
    const skipped = { flow: real.filter((c) => C.kindOf(c) === 'flow').length, derived: real.filter((c) => C.kindOf(c) === 'derived').length, unbuildable: never.size, portalCells: ign.drop.size };
    const isIgn = (c) => C.IGNITE.test(c.block);
    const placeable = [...real.filter((c) => !cannot(c.block) && C.kindOf(c) !== 'flow' && C.kindOf(c) !== 'derived' && !never.has(C.ckey(c)) && !isIgn(c)), ...ign.cells];
    if (!placeable.length) throw new Error('nothing the bots can place (every block is unsupported)');
    // a waterlogged block is placed dry and filled afterwards (a bucket used on the block itself: no flow, no race)
    const waterlog = placeable.filter((c) => c.props.waterlogged === 'true' && C.kindOf(c) !== 'fluid').map((c) => ({ x: c.x, y: c.y, z: c.z, block: 'water', props: { level: '0' }, waterlog: true, of: c.block }));
    const all = [...placeable, ...waterlog];
    const minY = Math.min(...all.map((c) => c.y)), maxY = Math.max(...all.map((c) => c.y)), gt = groundTop === null ? origin.y - 1 : groundTop;
    const o = ord.plan(all, real, (x, y, z) => y <= gt, { zones: Math.max(1, Math.floor(zones) || 1), mode: mode === 'layer' || mode === 'zlayer' ? mode : 'area', weights: weights === undefined ? require('./policy').fromEnv() : weights });
    const x0 = Math.min(...all.map((c) => c.x)), x1 = Math.max(...all.map((c) => c.x)), z0 = Math.min(...all.map((c) => c.z)), z1 = Math.max(...all.map((c) => c.z));
    const cellsOf = new Map(o.units.map((u, i) => [i, u]));
    const tiles = new Map([['b0', { id: 'b0', x0, x1, z0, z1, cells: cellsOf }]]);
    const regions = [{ id: 'b0', anchor: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 }, layers: 1, rows: o.units.length, meta: { tile: 'b0', minY } }];
    const want = new Map(placeable.filter((c) => !c.waterlog).map((c) => [C.ckey(c), c.block]));
    const footprint = new Set(placeable.map((c) => `${c.x},${c.z}`));
    const cellSet = new Set(real.map(C.ckey));                                                   // every cell the structure owns (flows and bed heads too): no temporary block goes there
    const byKey = new Map(o.list.map((c) => [c.k, c]));
    const seedUnit = o.units.map((u) => u.some((c) => c.seed));                                 // a unit with a floating piece: begun last
    const centre = o.units.map((u) => ({ x: u.reduce((a, c) => a + c.x, 0) / u.length, y: u.reduce((a, c) => a + c.y, 0) / u.length, z: u.reduce((a, c) => a + c.z, 0) / u.length }));
    const blockNames = new Set(real.map((c) => c.block));
    return { box: { x0, x1, z0, z1, y0: Math.max(minY, gt + 1), y1: maxY }, blockNames, origin, minY, maxY, layers: maxY - minY + 1, groundTop: gt, tiles, regions, units: o.units, deps: o.deps, unitOf: o.unitOf, zones: o.zones, seedUnit, mode: o.mode, levelWindow: Math.max(0, Math.floor(window) || 0), unitLayer: o.unitLayer, zoneLevels: o.zones.units.map(([a, b]) => { const ls = o.unitLayer.slice(a, b), list = [...new Set(ls)].sort((x, y) => x - y); return { list, of: ls.reduce((m, l, i) => { (m.get(l) || m.set(l, []).get(l)).push(a + i); return m; }, new Map()) }; }), levels: { list: [...new Set(o.unitLayer)].sort((a, b) => a - b), of: o.unitLayer.reduce((m, l, i) => { (m.get(l) || m.set(l, []).get(l)).push(i); return m; }, new Map()) }, list: o.list, byKey, centre, unsupported, unbuildable: [...never].map(([k, why]) => ({ at: k, why })), footprint, cellSet, want, count: all.length, skipped, materials: C.materialsOf(placeable) };
}

/** Cells of one unit in placement order. */
const unitCells = (plan, regionId, u) => plan.units[u] || [];

/** Items a unit needs (a bucket per fluid, one per block ...), counting only the cells that do not hold their block yet (`w`: the world). */
function needsOf(cells, w = null) {
    const m = {};
    for (const c of cells) {
        if (w && (c.waterlog ? false : w.nameAt(c.x, c.y, c.z) === c.block)) continue;
        const it = c.waterlog ? 'water_bucket' : C.itemFor(c.block);
        if (c.ignite) { m[it] = 1; continue; }                                                // one flint and steel does many cells
        if (it) m[it] = (m[it] || 0) + 1;
    }
    return m;
}

/**
 * Blocks inside the structure's box that no cell of the plan owns and that are of a kind the plan never uses: what a bot left behind (a temporary scaffold, a block of a pillar), as [{ x, y, z }].
 * A kind the plan uses (dirt) cannot be told from a cell of the structure that is wrong, so it is not touched; nor are containers (the supply chests).
 */
function extrasOf(plan, w) {
    const out = [], b = plan.box;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) {
        if (plan.cellSet.has(`${x},${y},${z}`)) continue;
        const k = w.kindAt(x, y, z);
        if (k !== 'solid' && k !== 'partial') continue;
        const n = String(w.nameAt(x, y, z) || '').replace(/^minecraft:/, '');
        if (!n || plan.blockNames.has(n) || /(chest|barrel|shulker)/.test(n)) continue;
        out.push({ x, y, z, block: n });
    }
    return out;
}

/** What differs between the blueprint and the world: cells whose block (or state) is not the wanted one. */
function diffBuild(plan, w) {
    const missing = [];
    for (const list of plan.units) for (const c of list) {
        const b = w.blockAt ? w.blockAt(c.x, c.y, c.z) : null;
        if (c.waterlog) { if (!b || !b.getProperties || String(b.getProperties().waterlogged) !== 'true') missing.push(c); continue; }
        if (b) { if (!C.stateMatches(b, c) || C.useMismatch(b, c)) missing.push(c); continue; }
        if (w.nameAt(c.x, c.y, c.z) !== c.block) missing.push(c);
    }
    return missing;
}

module.exports = { planBuild, unitCells, needsOf, diffBuild, extrasOf };

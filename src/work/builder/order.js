'use strict';
// The ORDER of placement and the dependencies between units (rewrite 2026-11-18). A cell is placed when (1) everything it must wait for is placed and (2) some recipe of its block
// has its support already there (ground, or a cell placed earlier). Among the cells that can go next the LOWEST goes first and, at one height, the one NEAREST the last one placed: the result
// is a bottom-up growth with a short walk from cell to cell. Only when nothing can go next (a floating piece of the cut-out terrain) the lowest remaining cell is a SEED: it gets a temporary
// support beside it (stations.js). Fluids follow what holds them: a source waits for every solid cell around its body of fluid (sides and below), and what covers a body (the cell above)
// waits for the source, so that lava is poured into a tower before its lid goes on and water is never poured into a channel with no walls (owner 2026-11-18).
// A cell's `sup` is the support direction the planner counted on: the cell below when there is one, then a side, then above. The units depend on the units of their supports, nothing more.
const O = require('../jobs/orient');
const C = require('./cells');
const D = O.DIR, DIRS = ['down', 'north', 'south', 'east', 'west', 'up'];          // the order of preference of a support
const NB = DIRS.map((d) => [d, D[d]]);
const at = (c, d) => ({ x: c.x + D[d][0], y: c.y + D[d][1], z: c.z + D[d][2] });
const key = (c) => `${c.x},${c.y},${c.z}`;
const PARTIAL = /(stairs|_slab|trapdoor|hopper|chest|_bed|piston|composter|fence|gate|torch|sign|wire|repeater|comparator|lantern|ladder|pane|bars|door|button|lever|carpet|snow|chain|water|lava|cauldron|head|skull)$/;

/** Is the block a full, sturdy one a torch or a sign can hang on (a wall or a fence carries one on top, a sign hangs on a sign)? */
const sturdy = (name, d, placing) => (/(_wall|_fence)$/.test(name) ? d === 'down' : /_sign$/.test(name) ? /_sign$/.test(placing) : !PARTIAL.test(name));

const memo = new Map();
/** Recipes for a block with a given pattern of sturdy neighbours (cached: the same block and the same neighbours give the same recipes). */
function recipesFor(c, solid) {
    const mask = DIRS.map((d) => (solid(d) ? 1 : 0)).join(''), k = `${c.block}|${JSON.stringify(c.props || {})}|${mask}`;
    let r = memo.get(k);
    if (!r) { r = O.recipes(c.block, c.props || {}, solid); if (memo.size > 5000) memo.clear(); memo.set(k, r); }
    return r;
}

/**
 * Group the cells in `order` into units: consecutive cells at most `max` (24), at most 3 levels apart, inside a box of 9 x 9, all fluids or none. Returns [[cells]].
 */
function chunk(list, { max = 24, span = 9 } = {}) {
    const units = []; let cur = null;
    const fits = (c) => cur && cur.cells.length < max && !!c.fluid === cur.fluid && Math.max(cur.y1, c.y) - Math.min(cur.y0, c.y) <= 2 && Math.max(cur.x1, c.x) - Math.min(cur.x0, c.x) < span && Math.max(cur.z1, c.z) - Math.min(cur.z0, c.z) < span;
    for (const c of list) {
        if (!fits(c)) { cur = { cells: [], fluid: !!c.fluid, x0: c.x, x1: c.x, y0: c.y, y1: c.y, z0: c.z, z1: c.z }; units.push(cur); }
        cur.cells.push(c); cur.x0 = Math.min(cur.x0, c.x); cur.x1 = Math.max(cur.x1, c.x); cur.y0 = Math.min(cur.y0, c.y); cur.y1 = Math.max(cur.y1, c.y); cur.z0 = Math.min(cur.z0, c.z); cur.z1 = Math.max(cur.z1, c.z);
    }
    return units.map((u) => u.cells);
}

/**
 * @param cells   the cells to place: { x, y, z, block, props, waterlog?, of? } (a waterlog cell is the water of a waterlogged block, placed after the block)
 * @param real    every cell of the blueprint that is not air (flows, bed heads and cells that cannot be built too): they shape the fluid bodies
 * @param ground  (x, y, z) => is it ground (present from the start)
 * Returns { list: the cells in placement order (each with .seq, .sup, .fluid, .seed), units: [[cell]] }, dependencies: [[unit index]] per unit }.
 */
function plan(cells, real, ground) {
    const owned = new Map(), byPos = new Map();
    for (const c of cells) { c.k = c.waterlog ? `${key(c)}w` : key(c); c.fluid = c.waterlog || C.kindOf(c) === 'fluid'; owned.set(c.k, c); if (!c.waterlog) byPos.set(key(c), c); }
    const pre = new Map(), later = new Map();                        // cell key -> keys that must be placed first; key -> the cells waiting for it
    const need = (c, k) => { if (!owned.has(k) || k === c.k) return; (pre.get(c.k) || pre.set(c.k, new Set()).get(c.k)).add(k); (later.get(k) || later.set(k, []).get(k)).push(c); };
    for (const c of cells) if (c.waterlog) need(c, key(c));                              // the water of a waterlogged block comes after the block
    // fluid bodies: connected fluid cells of one kind, flows included
    const fl = new Map(real.filter((c) => C.FLUID.test(C.bare(c.block))).map((c) => [key(c), c])), seen = new Set();
    // the water of a waterlogged block is a source like any other: it flows into the air beside it, so it belongs to a body and waits for what holds the body (live 2026-11-18: stairs were
    // waterlogged before the cells beside them were built and the water ran into the cells of the walls)
    for (const c of real) if (String(c.props && c.props.waterlogged) === 'true' && !fl.has(key(c))) fl.set(key(c), { x: c.x, y: c.y, z: c.z, block: 'water', props: { level: '0' } });
    const srcAt = (b) => { const o = byPos.get(key(b)); return o && o.fluid ? o : owned.get(`${key(b)}w`) || null; };
    for (const f of fl.values()) {
        if (seen.has(key(f))) continue;
        const name = C.bare(f.block), body = [], st = [f]; seen.add(key(f));
        while (st.length) { const a = st.pop(); body.push(a); for (const [, v] of NB) { const q = fl.get(`${a.x + v[0]},${a.y + v[1]},${a.z + v[2]}`); if (q && C.bare(q.block) === name && !seen.has(key(q))) { seen.add(key(q)); st.push(q); } } }
        const inBody = new Set(body.map(key)), contain = new Set(), covers = new Set();
        for (const b of body) for (const [d, v] of NB) { const n = `${b.x + v[0]},${b.y + v[1]},${b.z + v[2]}`; if (inBody.has(n) || !byPos.has(n)) continue; (d === 'up' ? covers : contain).add(n); }
        const sources = body.map(srcAt).filter(Boolean);
        // A source waits for what holds the water that can reach from IT: the solid cells within the reach of a flow (seven across) and not the whole network of channels (the water then came last,
        // when no builder was left in the trenches and nobody could get in over the walls)
        for (const s of sources) for (const n of contain) { const q = byPos.get(n); if (Math.max(Math.abs(q.x - s.x), Math.abs(q.z - s.z)) <= 8 && q.y <= s.y + 2) need(s, n); }
        for (const n of covers) if (!contain.has(n)) for (const s of sources) need(byPos.get(n), s.k);
        // A small body (a lava pit in a tower) is poured from above, through the shaft the walls leave open: everything above it that stands inside its footprint (the rest of the walls, the lid)
        // waits for the source, or the walls close the access first (live 2026-11-18: three bots built the tower up while the lava waited for its bucket, and no standing place was left).
        if (!sources.length) continue;
        const xs = body.map((b) => b.x), zs = body.map((b) => b.z), top = Math.max(...sources.map((b) => b.y));
        if (Math.max(...xs) - Math.min(...xs) <= 6 && Math.max(...zs) - Math.min(...zs) <= 6) {
            for (const c of cells) {
                if (c.waterlog || contain.has(key(c)) || c.y <= top || c.x < Math.min(...xs) - 1 || c.x > Math.max(...xs) + 1 || c.z < Math.min(...zs) - 1 || c.z > Math.max(...zs) + 1) continue;
                for (const s of sources) need(c, s.k);
            }
        }
    }
    const built = new Set(), present = (x, y, z) => ground(x, y, z) || built.has(`${x},${y},${z}`);
    const solidFor = (c) => (d) => { const q = at(c, d); if (ground(q.x, q.y, q.z)) return true; const o = byPos.get(key(q)); return !!o && built.has(key(q)) && sturdy(C.bare(o.block), d, C.bare(c.block)); };
    const supOf = (c) => {
        if (c.waterlog) return 'down';
        const have = DIRS.filter((d) => { const q = at(c, d); return present(q.x, q.y, q.z) && !(byPos.get(key(q)) && C.FLUID.test(C.bare(byPos.get(key(q)).block))); });
        if (!have.length) return null;
        if (c.fluid) return have[0];
        const recs = recipesFor(c, solidFor(c)), ok = new Set(recs.map((r) => r.support));
        return DIRS.find((d) => have.includes(d) && ok.has(d)) || null;
    };
    const wasBuilt = new Set();                                                           // keys placed (waterlog keys end in w)
    const done = (k) => wasBuilt.has(k);
    const isReady = (c) => { const p = pre.get(c.k); if (!p) return true; for (const k of p) if (!done(k)) return false; return true; };
    const cand = new Map(), left = new Set(owned.keys());
    const eval1 = (c) => { if (!left.has(c.k)) { cand.delete(c.k); return; } const s = isReady(c) ? supOf(c) : null; if (s) cand.set(c.k, { c, sup: s }); else cand.delete(c.k); };
    for (const c of cells) eval1(c);
    const list = []; let last = null;
    while (left.size) {
        let best = null, bd = Infinity;
        for (const e of cand.values()) {
            const c = e.c, d = last ? (c.x - last.x) ** 2 + (c.z - last.z) ** 2 + 4 * (c.y - last.y) ** 2 : 0;
            if (!best || c.y < best.c.y || (c.y === best.c.y && d < bd)) { best = e; bd = d; }
        }
        let seed = false;
        if (!best) {                                                                      // nothing has its support: a floating piece starts here (or a cycle of waits is broken)
            // a floating piece starts with the cell that can be placed against anything (a plain block), not with a trapdoor or a torch that needs one particular neighbour to be there
            let b = null, bn = -1;
            const free = (c) => (c.waterlog || c.fluid ? 6 : new Set(recipesFor(c, () => true).map((r) => r.support)).size);
            for (const k of left) { const c = owned.get(k); if (!isReady(c)) continue; const n = free(c); if (!b || c.y < b.y || (c.y === b.y && (n > bn || (n === bn && (c.x < b.x || (c.x === b.x && c.z < b.z)))))) { b = c; bn = n; } }
            if (!b) for (const k of left) { const c = owned.get(k); if (!b || c.y < b.y) b = c; }
            // a piece that can only hang on one particular neighbour (a trapdoor, a wall torch) starts with a plain block of the same connected piece, which the others then hang on
            if (b && free(b) < 6) {
                const seenK = new Set([b.k]), q = [b]; let alt = null;
                while (q.length) { const a = q.shift(); if (free(a) === 6 && (!alt || a.y < alt.y)) alt = a; for (const [, v] of NB) { const n = byPos.get(`${a.x + v[0]},${a.y + v[1]},${a.z + v[2]}`); if (n && left.has(n.k) && !seenK.has(n.k)) { seenK.add(n.k); q.push(n); } } }
                if (alt) b = alt;
            }
            best = { c: b, sup: null }; seed = true;
        }
        const c = best.c; c.sup = best.sup; c.seed = seed; c.seq = list.length;
        list.push(c); left.delete(c.k); cand.delete(c.k); wasBuilt.add(c.k); if (!c.waterlog) built.add(key(c)); last = c;
        for (const [, v] of NB) { const q = byPos.get(`${c.x + v[0]},${c.y + v[1]},${c.z + v[2]}`); if (q) eval1(q); }
        for (const q of later.get(c.k) || []) eval1(q);
        if (!c.waterlog) { const w = owned.get(`${key(c)}w`); if (w) eval1(w); }
    }
    // the support directions the block can be placed against at all (a top-half trapdoor facing west: only the block to the east or above), whatever stands next to it
    for (const c of list) { c.pre = pre.has(c.k) ? [...pre.get(c.k)] : []; c.dirs = c.waterlog || c.fluid ? DIRS.slice() : [...new Set(recipesFor(c, () => true).map((r) => r.support))]; }
    const units = chunk(list), unitOf = new Map();
    units.forEach((u, i) => u.forEach((c) => unitOf.set(c.k, i)));
    const deps = units.map((u, i) => {
        const s = new Set();
        for (const c of u) {
            if (c.sup && !c.waterlog) { const q = byPos.get(key(at(c, c.sup))); if (q) s.add(unitOf.get(q.k)); }
            if (c.waterlog) s.add(unitOf.get(key(c)));
            for (const k of pre.get(c.k) || []) s.add(unitOf.get(k));
        }
        s.delete(i); s.delete(undefined);
        return [...s].sort((a, b) => a - b);
    });
    return { list, units, deps, unitOf };
}

module.exports = { plan, chunk, sturdy, recipesFor, PARTIAL, DIRS };

'use strict';
// Tree pass of the open pit (owner 2026-11-16: "provide a process for removing tree trunks and floating leaves"). Neither pit method touched tree blocks that hang out of reach of a bot on the
// ground (pit.js aerialTree: the planner gave up on them in 30-85 s tries), so a canopy over a lower column, or leaves left when the ground under them was dug, stayed in the box and failed the
// exact check of mine_b (seed -8223826995433110289, seed 4461664185924705895: 2-30 leaf and log blocks in every layer 69-84).
//
// The process, per tree block T inside the box (y <= box.top; the part above the terrain top is not the pit's):
//   1. low ones (at most LOW above the ground under them): `mine` walks to them as for any block;
//   2. aerial ones: pick a standing column S (ground with free air above, next to T, reachable on foot), walk to it, RISE on a pillar of temporary blocks in stages of STAGE levels, and after each
//      stage mine every tree block within reach of the eyes (blind: the server checks only the distance, leaves hide each other), until nothing of the tree within the column's radius is left;
//   3. descend the same column (moves.js `descend` takes every block of the pillar away again), re-read the world, take the next block. Nothing of the bot's blocks outlives a column.
// A block that cannot be done (no standing column, the walk or the pillar failed) is put on a `failed` list, reported, and not tried again; the pass never loops: it ends on a time cap, a cell cap
// and the cancel token. Pure apart from `env` (w, here, exec, run, cancel): the tests drive it on a fake world.
const TREE = /(_leaves|_log|_wood|_stem|_hyphae|_vines?|^vine|^bamboo|^mangrove_roots|^nether_wart_block|^warped_wart_block|^shroomlight)$/;
const bare = (n) => String(n || '').replace(/^minecraft:/, '');
const isTree = (name) => TREE.test(bare(name));

const LOW = 3;               // a tree block at most this far above the ground under it is mined from the ground
const STAGE = 2;             // levels risen between two rounds of mining
const REACH = 4.1;           // from the eyes (feet + 1.62), blind: the server's own limit is about 4.5-5
const RADIUS = 3.6;          // horizontal distance from the pillar column up to which blocks are taken from it
const SCAN_DOWN = 48;        // how far below the box top a column is scanned for tree blocks
const MAX_CELLS = 1200, MAX_MS = 420000, TRIES = 4, NAV_MS = 60000;

const solidish = (k) => k === 'solid' || k === 'partial';

/** Tree blocks of the box, y <= top, in loaded columns; each with `gy` = the y of the ground under it (the first solid non-tree block below, -Infinity when none is loaded). Pure. */
function scan(w, box, { skip = null } = {}) {
    const out = [];
    for (let x = box.x0; x <= box.x1; x++) for (let z = box.z0; z <= box.z1; z++) {
        let gy = null;
        const found = [];
        for (let y = box.top; y >= box.top - SCAN_DOWN && y >= -64; y--) {
            const k = w.kindAt(x, y, z);
            if (k === 'unknown') break;
            if (k === 'air') continue;
            if (isTree(w.nameAt(x, y, z))) { found.push(y); continue; }
            if (solidish(k)) { gy = y; break; }              // ground (a tree block under it belongs to the same trunk: handled as found)
            if (k === 'water' || k === 'lava') { gy = y; break; }
        }
        for (const y of found) { if (skip && skip.has(`${x},${y},${z}`)) continue; out.push({ x, y, z, gy: gy === null ? -Infinity : gy }); }
    }
    return out;
}

/** Ground under a column below `fromY`: { y, ok } with `ok` = a walkable standing cell (air for body and head over a solid, dry, non-tree block). Pure. */
function groundOf(w, x, z, fromY) {
    for (let y = fromY; y >= fromY - 64 && y >= -64; y--) {
        const k = w.kindAt(x, y, z);
        if (k === 'unknown') return null;
        if (k === 'air') continue;
        if (!solidish(k) || isTree(w.nameAt(x, y, z))) return null;          // fluid, a trunk, leaves: no ground to stand on here
        const free = (yy) => { const q = w.kindAt(x, yy, z); return q === 'air' || (q !== 'unknown' && isTree(w.nameAt(x, yy, z))); };
        return free(y + 1) && free(y + 2) ? { y } : null;
    }
    return null;
}

/** Standing columns for the block `t`: horizontally 1..2.6 away, ground within a few blocks of the block's ground, nearest first. Pure. */
function columnsFor(w, t, here) {
    const out = [];
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        const d = Math.hypot(dx, dz); if (d > 2.6) continue;
        const x = t.x + dx, z = t.z + dz;
        const g = groundOf(w, x, z, t.y - 1); if (!g) continue;
        out.push({ x, z, gy: g.y, d: d + Math.abs(g.y - (Number.isFinite(t.gy) ? t.gy : g.y)) * 0.5 + Math.hypot(here.x - x, here.z - z) * 0.02 });
    }
    return out.sort((a, b) => a.d - b.d);
}

/**
 * Clear the tree blocks of `box` (y <= box.top). `env`: w (kindAt, nameAt), here(), exec(name, args), run(name, args) (moves: pillar, descend), cancel, optional travel.
 * @returns { ok, mined, risen, columns, failed: [{x,y,z,why}], left, ms, capped? }
 */
async function clearTrees(env, box, { maxMs = MAX_MS, maxCells = MAX_CELLS, find = null, done = null } = {}) {
    const t0 = Date.now(), res = { ok: true, mined: 0, direct: 0, risen: 0, columns: 0, failed: [], left: 0 };
    const failed = new Map(), w = env.w;
    // `find(w, skip)` replaces the tree scan for another kind of target (the pit's leftover seal blocks): the same walk, pillar and descend serve any block that hangs over the floor. `done(c)`: is the target gone?
    const look = (skip) => (find ? find(w, skip) : scan(w, box, { skip }));
    const stop = () => (env.cancel && env.cancel.cancelled) || Date.now() - t0 > maxMs || res.mined >= maxCells;
    const eye = () => { const h = env.here(); return { x: h.x + 0.5, y: h.y + 1.62, z: h.z + 0.5 }; };
    const inReach = (c) => { const e = eye(); return Math.hypot(e.x - (c.x + 0.5), e.y - (c.y + 0.5), e.z - (c.z + 0.5)) <= REACH; };
    const dead = (r) => r && ['died', 'disconnected', 'cancelled'].includes(r.reason);
    const lowTried = new Set();
    const give = (c, why) => { failed.set(`${c.x},${c.y},${c.z}`, { x: c.x, y: c.y, z: c.z, why }); };
    const gone = (c) => (done ? done(c) : (() => { const k = w.kindAt(c.x, c.y, c.z); return k === 'air' || !isTree(w.nameAt(c.x, c.y, c.z)); })());

    // the bot's own position may be unloaded around the box: go there first (same as the layer gate)
    const cx = (box.x0 + box.x1) >> 1, cz = (box.z0 + box.z1) >> 1;
    if (env.travel && w.kindAt(cx, box.top, cz) === 'unknown') await env.travel({ x: cx, z: cz }, { near: 20 }).catch(() => {});

    for (let round = 0; round < 400 && !stop(); round++) {
        const here = env.here();
        const all = look(new Set(failed.keys()));
        if (!all.length) break;
        // 1. blocks within reach of the ground: logs first (the leaves decay on their own once no log is near), nearest first
        // (a low block that `mine` could not take from the ground, a leaf inside the crown with no line of sight to it, goes the aerial way: a column beside it, mined blind;
        // given up after one try it stayed for good, the birch of 081's b081h at 204,75,305 with 7 leaves round it through three pit rounds)
        const low = all.filter((c) => c.y - c.gy <= LOW && !lowTried.has(`${c.x},${c.y},${c.z}`)).sort((a, b) => (/_log|_wood|_stem/.test(bare(w.nameAt(b.x, b.y, b.z))) ? 1 : 0) - (/_log|_wood|_stem/.test(bare(w.nameAt(a.x, a.y, a.z))) ? 1 : 0) || Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
        if (low.length) {
            const c = low[0];
            // within the arm's reach from where the bot stands: blind at once (the server checks the distance, not the line; leaves hide each other), else the aimed mine walks to it
            let m = inReach(c) ? await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false, blind: true }) : { ok: false, reason: 'not_tried' };
            if (!m.ok && !gone(c) && !dead(m)) m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false });
            else if (m.ok) res.lowBlind = (res.lowBlind || 0) + 1;
            if (dead(m)) { res.ok = false; res.reason = m.reason; break; }
            if (m.ok || gone(c)) { res.mined++; res.direct++; } else { lowTried.add(`${c.x},${c.y},${c.z}`); res.lowAerial = (res.lowAerial || 0) + 1; }
            continue;
        }
        // 2. an aerial block: the lowest one first (a column that rises to it takes the ones around it on the way), the nearest of those
        const t = all.sort((a, b) => a.y - b.y || Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))[0];
        const cols = columnsFor(w, t, here).slice(0, TRIES);
        let done = false, navs = 0;
        for (const col of cols) {
            if (stop()) break;
            const start = { x: col.x, y: col.gy + 1, z: col.z };
            if (Math.hypot(here.x - start.x, here.z - start.z) > 0.6 || Math.abs(here.y - start.y) > 0.6) {
                let mv = await env.exec('move_to', start);
                if (dead(mv)) { res.ok = false; res.reason = mv.reason; return finish(); }
                // the walk goes on foot only: a column it cannot reach (a dug pit floor under a hanging block, a crown's leaves in the way) is reached by NAV (dig, pillar, descend,
                // bridge), once per target, bounded (mb075r w2, 1.21.1: 249 hanging lake-fill blocks left 'no progress from the columns' at the end of a wet pit)
                if (!mv.ok && env.nav && navs < 1) {
                    navs++; res.navTrips = (res.navTrips || 0) + 1;
                    mv = await env.nav(start, { near: 0, nearY: 0, why: 'tree pass: to a column', deadline: Date.now() + NAV_MS }).catch((e) => ({ ok: false, reason: 'internal', detail: { error: String(e && e.message || e) } }));
                    if (dead(mv)) { res.ok = false; res.reason = mv.reason; return finish(); }
                    const h = env.here(); if (mv.ok && !(h.x === start.x && h.z === start.z && h.y === start.y)) mv = { ok: false, reason: 'not_there' };
                }
                if (!mv.ok) continue;
            }
            res.columns++;
            let rose = 0, progress = false;
            for (let stage = 0; stage < 40 && !stop(); stage++) {
                // everything of the tree within reach of the eyes, nearest first (blind: the server checks the distance, not the line)
                for (;;) {
                    const e = eye(), near = look(new Set(failed.keys())).filter((c) => Math.hypot(c.x + 0.5 - (col.x + 0.5), c.z + 0.5 - (col.z + 0.5)) <= RADIUS && inReach(c));
                    if (!near.length || stop()) break;
                    near.sort((a, b) => Math.hypot(a.x + 0.5 - e.x, a.y + 0.5 - e.y, a.z + 0.5 - e.z) - Math.hypot(b.x + 0.5 - e.x, b.y + 0.5 - e.y, b.z + 0.5 - e.z));
                    const c = near[0], m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false, blind: true });
                    if (dead(m)) { res.ok = false; res.reason = m.reason; await down(); return finish(); }
                    if (m.ok || gone(c)) { res.mined++; progress = true; } else give(c, m.reason || 'mine');
                }
                // what is left within the radius, above the eyes: rise another stage, or stop
                const e = eye(), up = look(new Set(failed.keys())).filter((c) => Math.hypot(c.x + 0.5 - (col.x + 0.5), c.z + 0.5 - (col.z + 0.5)) <= RADIUS && c.y + 0.5 > e.y - 0.5);
                if (!up.length || stop()) break;
                const want = Math.min(...up.map((c) => c.y)) - 1 - env.here().y;
                const n = Math.max(1, Math.min(STAGE, want));
                const p = await env.run('pillar', { levels: n });
                const got = (p.detail && p.detail.levels) || 0;
                rose += got; res.risen += got;
                if (dead(p)) { res.ok = false; res.reason = p.reason; await down(); return finish(); }
                if (!p.ok && !got) { give(up.sort((a, b) => a.y - b.y)[0], `pillar:${p.reason}`); break; }
            }
            await down();
            if (progress) { done = true; break; }
            async function down() {
                // back down the same column: descend takes the pillar's blocks away again
                const h = env.here(), lv = h.y - (col.gy + 1);
                if (lv > 0) { const d = await env.run('descend', { levels: lv }); if (!d.ok) res.stuckUp = (res.stuckUp || 0) + 1; }
            }
        }
        if (!done && !stop()) give(t, cols.length ? 'no progress from the columns' : 'no standing column');
    }
    return finish();

    function finish() {
        res.failed = [...failed.values()]; res.ms = Date.now() - t0;
        res.left = look(new Set()).length;
        if (res.left) res.ok = false;
        res.capped = stop() || undefined;
        return res;
    }
}

module.exports = { TREE, isTree, scan, groundOf, columnsFor, clearTrees, LOW, STAGE, REACH, RADIUS };

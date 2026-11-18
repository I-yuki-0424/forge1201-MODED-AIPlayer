'use strict';
// STATIONS (rewrite 2026-11-18): where a builder stands. Placing is done blind from a spot within reach of the SUPPORT block's face, so one standing place serves every cell around it.
// A station is a feet cell S with room for the body and either
//   native  a full block under it (built structure, or the ground): the bot walks there (NAV), or
//   pillar  nothing under it: a temporary block T goes under it (NAV's pillar climb from the ground below leaves exactly that block, floating), which is ALSO a support the cells beside it can be placed
//           against: that is how a floating piece (a seed) gets its first block.
// `chooseStation` scores every candidate by how many of the next cells it serves minus what it costs to get there, so that a bot stands still while it places a dozen blocks and moves when
// nothing more is in reach. Pure: the world comes in as a `view`, which the planner's simulation and the live world both provide.
const O = require('../jobs/orient');
const D = O.DIR, DIRS = ['down', 'north', 'south', 'east', 'west', 'up'];
const EYE = 1.62, REACH = 4.2;                      // eye height; the reach to the nearest point of the support block (motion.js AIM_REACH)
const at = (c, d) => ({ x: c.x + D[d][0], y: c.y + D[d][1], z: c.z + D[d][2] });
const key = (x, y, z) => `${x},${y},${z}`;
const REPLACEABLE = /^(air|cave_air|void_air|grass|tall_grass|short_grass|fern|large_fern|snow|dead_bush|seagrass|tall_seagrass|vine|glow_lichen)$/;

/** Distance from the eye at feet cell S to the nearest point of the block cell p. */
function reachTo(S, p) {
    const ex = S.x + 0.5, ey = S.y + EYE, ez = S.z + 0.5, d = (a, lo) => Math.max(lo - a, 0, a - (lo + 1));
    return Math.hypot(d(ex, p.x), d(ey, p.y), d(ez, p.z));
}

/** A line from the eye at S to the centre of the face of block `p` toward `S` is clear of blocks (a bucket takes its target from the real look ray). Samples every 0.2. */
function lineClear(view, S, p, face) {
    const ex = S.x + 0.5, ey = S.y + EYE, ez = S.z + 0.5, v = D[face], tx = p.x + 0.5 + v[0] * 0.5, ty = p.y + 0.5 + v[1] * 0.5, tz = p.z + 0.5 + v[2] * 0.5;
    const len = Math.hypot(tx - ex, ty - ey, tz - ez), n = Math.max(1, Math.ceil(len / 0.2));
    for (let i = 1; i < n; i++) {
        const t = i / n, x = Math.floor(ex + (tx - ex) * t), y = Math.floor(ey + (ty - ey) * t), z = Math.floor(ez + (tz - ez) * t);
        if (x === p.x && y === p.y && z === p.z) continue;
        if (view.opaque(x, y, z)) return false;
    }
    return true;
}

/**
 * The view of a world a station search needs. `w`: world.js's interface (kindAt, nameAt). `cellSet`: every cell the structure owns (a temporary block never goes there, a body is not
 * put in it). Returns { kind, present, opaque, free, floor }.
 */
function viewOf(w, cellSet = new Set()) {
    const kind = (x, y, z) => w.kindAt(x, y, z);
    const nm = (x, y, z) => String(w.nameAt(x, y, z) || '').replace(/^minecraft:/, '');
    return {
        kind, cellSet,
        present: (x, y, z) => { const k = kind(x, y, z); if (k === 'unknown' || k === 'water' || k === 'liquid') return false; const n = nm(x, y, z); return !!n && !REPLACEABLE.test(n) && !/^(lava)$/.test(n); },
        opaque: (x, y, z) => { const k = kind(x, y, z); return k === 'solid' || k === 'partial'; },
        free: (x, y, z) => kind(x, y, z) === 'air',
        solid: (x, y, z) => kind(x, y, z) === 'solid',
    };
}

/** Can the body stand at feet cell S (room above, no hazard beside it, nobody there)? Does not look at the floor. */
function bodyFits(view, S, avoid) {
    if (!view.free(S.x, S.y, S.z) || !view.free(S.x, S.y + 1, S.z)) return false;
    for (const o of avoid) if (Math.abs(o.x - (S.x + 0.5)) < 1.2 && Math.abs(o.z - (S.z + 0.5)) < 1.2 && Math.abs(o.y - S.y) < 3) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = view.kind(S.x + dx, S.y, S.z + dz); if (k === 'danger' || k === 'liquid') return false; }
    return true;
}

/**
 * The cells of `cells` (in order) that a bot at S can place, given the supports that exist (`view.present`, the floor block T of a pillar station, and the cells placed on the way).
 * `cells`: { x, y, z, sup?, fluid?, waterlog?, seed? }. Returns [{ cell, sup }] (sup = the support direction to click).
 */
function serves(view, S, cells, T = null, ok = null) {
    const out = [], local = new Set(), done = new Set();
    const present = (p) => view.present(p.x, p.y, p.z) || local.has(key(p.x, p.y, p.z)) || (T && p.x === T.x && p.y === T.y && p.z === T.z);
    for (const c of cells) {
        if ((c.x === S.x && c.z === S.z && (c.y === S.y || c.y === S.y + 1))) continue;           // the cell the body stands in
        if (ok && !ok(c, done)) continue;                                                        // it waits for something (a fluid for what holds it) that is neither there nor placed from here
        let pick = null;
        if (c.waterlog) { if (reachTo(S, c) <= REACH && view.present(c.x, c.y, c.z)) pick = 'self'; }
        else {
            const order = c.sup ? [c.sup, ...DIRS.filter((d) => d !== c.sup)] : DIRS;
            for (const d of order) {
                const p = at(c, d);
                if (!present(p) || reachTo(S, p) > REACH) continue;
                if (c.fluid && !lineClear(view, S, p, O.OPP[d])) continue;                        // a bucket needs a ray to the face it aims at
                pick = d; break;
            }
        }
        if (pick) { out.push({ cell: c, sup: pick }); done.add(c.k || key(c.x, c.y, c.z)); if (!c.waterlog) local.add(key(c.x, c.y, c.z)); }
    }
    return out;
}

/** A straight bridge to the floor cell T from a native floor at the same level: { g: temporary blocks (T included), from } or null. NAV bridges where nothing is within three below. */
function bridgeTo(view, T, maxGap = 5) {
    let best = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let g = 1; g <= maxGap; g++) {
            const f = { x: T.x - dx * g, y: T.y, z: T.z - dz * g };
            if (view.solid(f.x, f.y, f.z) && view.free(f.x, f.y + 1, f.z) && view.free(f.x, f.y + 2, f.z)) { if (!best || g < best.g) best = { g, from: f }; break; }
            if (!view.free(f.x, f.y, f.z) || view.cellSet.has(key(f.x, f.y, f.z))) break;
        }
    }
    return best;
}

/**
 * Where to stand for the next cells. `cells`: the cells that can be placed now, in order. `o`: { from: feet cell of the bot, avoid: [{x,y,z}] other bots, skip: Set of "x,y,z" stations that
 * failed, maxDrop }. Returns { S, floor, kind: 'native' | 'pillar', serves: [{cell, sup}], base? (pillar: the block the climb starts on), score } or null.
 */
function chooseStation(view, cells, o = {}) {
    if (!cells.length) return null;
    const from = o.from || cells[0], avoid = o.avoid || [], skip = o.skip || new Set(), ok = o.ok || null, look = cells.slice(0, o.lookahead || 40);
    const c0 = look.find((c) => !ok || ok(c, new Set())) || look[0], R = 5;
    let best = null;
    const consider = (S, kind, T, base, br = null) => {
        const sv = serves(view, S, look, T, ok);
        if (!sv.length || (!sv.some((s) => s.cell === c0))) return;                              // the first cell that can go now must be one of them (progress)
        // Costs in tenths of a second of bot time (a placement is ~12): a move to another station costs the plan and the walk (about 2 s and 0.25 s a block, 0.5 s a level), a pillar climb
        // 1.2 s a level up and about as much to get down again afterwards.
        const here = S.x === from.x && S.y === from.y && S.z === from.z, flat = Math.abs(S.x - from.x) + Math.abs(S.z - from.z), dy = Math.abs(S.y - from.y);
        let cost = 0;
        if (!here) cost = kind === 'native' ? 20 + 2.5 * flat + 5 * dy : Math.min(40 + 26 * Math.max(0, S.y - 1 - base.y) + flat, br ? 45 + 20 * br.g + flat : Infinity);
        const score = 12 * sv.length - cost;
        if (!best || score > best.score) best = { S, floor: { x: S.x, y: S.y - 1, z: S.z }, kind, serves: sv, base, bridge: br, score };
    };
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) for (let dy = -5; dy <= 4; dy++) {
        const S = { x: c0.x + dx, y: c0.y + dy, z: c0.z + dz };
        if (skip.has(key(S.x, S.y, S.z)) || !bodyFits(view, S, avoid)) continue;
        if (view.solid(S.x, S.y - 1, S.z)) { consider(S, 'native', null, null); continue; }
        // a temporary block goes under the feet: the cell must be free, not a cell of the structure, and a column of free cells must lead down to something to climb from
        const T = { x: S.x, y: S.y - 1, z: S.z };
        if (!view.free(T.x, T.y, T.z) || view.cellSet.has(key(T.x, T.y, T.z))) continue;
        let base = null;
        for (let k = 1; k <= (o.maxClimb || 48); k++) {
            const y = T.y - k, kd = view.kind(S.x, y, S.z);
            if (kd === 'solid') { base = { x: S.x, y, z: S.z }; break; }
            if (kd !== 'air') break;
        }
        const br = bridgeTo(view, T);
        if (base || br) consider(S, 'pillar', T, base || { x: S.x, y: S.y - 2, z: S.z }, br);
    }
    return best;
}

module.exports = { chooseStation, serves, viewOf, bodyFits, lineClear, reachTo, bridgeTo, REACH, EYE, DIRS };

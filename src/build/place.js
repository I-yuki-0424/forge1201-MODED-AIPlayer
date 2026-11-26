'use strict';
// Where a survival player stands and what it clicks to put a block state into a cell: a face of a neighbouring block that its eye sees FIRST along the look ray (what the
// crosshair of a vanilla client would pick), within reach, such that vanilla's rules (vanilla.js) give exactly the wanted state. Pure: the world is an accessor.
const V = require('./vanilla');
const S = require('./state');
const FB = require('./fastblock');

const REACH = 4.4;                         // the client picks up to 4.5 from the eye
const EYE = 1.62, EYE_SNEAK = 1.27;
const FULL = '0,0,0,1,1,1';
// the properties a placement decides (the rest is set by clicks afterwards or is the block's default)
const PLACED = new Set(['facing', 'half', 'type', 'axis', 'face', 'shape', 'part', 'hinge', 'hanging', 'attachment', 'rotation']);

/** A world accessor over a mineflayer bot (what it sees) with `over` (cells the caller has just changed: key -> state or null for air). */
function botWorld(bot, over = null) {
    const { Vec3 } = require('vec3');
    return {
        block(x, y, z) {
            const k = `${x},${y},${z}`;
            if (over && over.has(k)) return over.get(k);
            // by state id, shared per state (fastblock.js)
            const id = FB.stateId(bot, x, y, z);
            if (id === null) return null;
            if (id !== undefined) { const e = FB.entry(bot, id); return e.air ? AIR : e.place; }
            const b = bot.blockAt(new Vec3(x, y, z), false);
            if (!b) return null;
            if (b.name === 'air' || b.name === 'cave_air') return AIR;
            const p = {}; for (const [kk, v] of Object.entries(b.getProperties())) p[kk] = String(v);
            return { name: b.name, props: p, shapes: b.shapes || [] };
        },
    };
}
const AIR = Object.freeze({ name: 'air', props: {}, shapes: [] });
const isAir = (b) => !b || S.AIR.has(b.name);
const isFluid = (b) => b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column');
const full = (b) => !!b && Array.isArray(b.shapes) && b.shapes.length === 1 && b.shapes[0].map((v) => +v).join(',') === FULL;

/** The face of block b (its outline boxes, cell-local) that points along `dir`: { axis, plane, rect: [[a0, a1], [b0, b1]] } on the two other axes, or null. */
function faceOf(b, dir) {
    if (!b || !Array.isArray(b.shapes) || !b.shapes.length) return null;
    const v = V.VEC[dir], ax = v[0] ? 0 : v[1] ? 1 : 2, sign = v[ax];
    let best = null;
    for (const s of b.shapes) { const lo = +s[ax], hi = +s[ax + 3], pl = sign > 0 ? hi : lo; if (!best || (sign > 0 ? pl > best.pl : pl < best.pl)) best = { pl, s }; }
    const o = [0, 1, 2].filter((a) => a !== ax);
    return { axis: ax, plane: best.pl, rect: o.map((a) => [+best.s[a], +best.s[a + 3]]), others: o };
}

/** Walk the ray a -> b cell by cell: the first cell (other than air or fluid, and not `skip`) it enters, and the cell before. Cells with nothing to pick count as empty. */
function rayFirst(world, a, b) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d);
    const dir = d.map((v) => v / len), step = dir.map(Math.sign), cell = a.map(Math.floor);
    const tD = dir.map((v) => (v === 0 ? Infinity : Math.abs(1 / v)));
    const tM = [0, 1, 2].map((i) => (step[i] === 0 ? Infinity : (step[i] > 0 ? cell[i] + 1 - a[i] : a[i] - cell[i]) * tD[i]));
    let prev = null;
    for (let guard = 0; guard < 64; guard++) {
        const blk = world.block(cell[0], cell[1], cell[2]);
        if (blk === null) return { cell: [...cell], prev, unknown: true };
        if (!isAir(blk) && !isFluid(blk)) return { cell: [...cell], prev };
        prev = [...cell];
        const k = tM[0] < tM[1] ? (tM[0] < tM[2] ? 0 : 2) : (tM[1] < tM[2] ? 1 : 2);
        if (tM[k] > len + 1e-9) return null;
        cell[k] += step[k]; tM[k] += tD[k];
    }
    return null;
}

/** Is the face of the block at cell c toward direction `towards` sturdy (something can hang on it)? A full cube, or a box that covers that face. */
function sturdy(b, towards) {
    if (!b || isAir(b) || isFluid(b)) return false;
    if (full(b)) return true;
    const f = faceOf(b, towards);
    if (!f) return false;
    const v = V.VEC[towards], boundary = v[f.axis] > 0 ? 1 : 0;
    return Math.abs(f.plane - boundary) < 1e-6 && f.rect.every(([lo, hi]) => lo <= 1e-6 && hi >= 1 - 1e-6);
}

/**
 * Ways to put `want` ({name, props}, normalised) into cell T with `item`, from the feet cells `stations` (nearest first): [{ station, face, n: [x,y,z] (the clicked block),
 * hit: [x,y,z], look: [dx,dy,dz], sneak }], at most `max`. Empty when no station sees a face that gives the state (a support is missing, or the state needs another stance).
 */
// exact looks for flexible placement: the four cardinals level, and each tilted to almost straight down and up (a pure vertical has no horizontal facing)
const EXACT = (() => { const out = []; for (const [x, z] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { out.push([x, 0, z]); out.push([x * 0.02, -1, z * 0.02]); out.push([x * 0.02, 1, z * 0.02]); } return out; })();

function ways(world, T, want, item, stations, { max = 1, reach = REACH, sneakAlways = false } = {}) {
    const out = [], wantD = S.decidedProps(want.name, want.props);
    const at = (dx, dy, dz) => world.block(T.x + dx, T.y + dy, T.z + dz);
    const solid = (dx, dy, dz) => { const towards = Object.keys(V.VEC).find((k) => V.VEC[k][0] === -dx && V.VEC[k][1] === -dy && V.VEC[k][2] === -dz); return sturdy(at(dx, dy, dz), towards); };
    for (const F of V.DIRS) {
        const v = V.VEC[F], N = [T.x - v[0], T.y - v[1], T.z - v[2]];
        let nb = world.block(...N);
        if (isAir(nb) || isFluid(nb)) continue;
        if (!Array.isArray(nb.shapes) || !nb.shapes.length) nb = { ...nb, shapes: outlineOf(nb) };       // a torch, wire, rail: clicked on its outline (smooth stone over torches was never placed, live 2026-11-22 sQ2)
        // walls, fences, gates: collision 1.5 high, the outline a player clicks ends at 1.0 (a wall on a wall was never placed: the click went to the top of the collision box,
        // inside the cell above, live 2026-11-23 gb1 w1)
        else if (nb.shapes.some((q) => q[4] > 1)) nb = { ...nb, shapes: nb.shapes.map((q) => [q[0], q[1], q[2], q[3], Math.min(q[4], 1), q[5]]) };
        const face = faceOf(nb, F);
        if (!face) continue;
        const sneak0 = sneakAlways || V.INTERACTIVE.test(nb.name) || /chest$/.test(S.bare(want.name)) && (want.props.type || 'single') !== 'left';
        for (const s of stations) {
            if (s.x === T.x && s.z === T.z && (s.y === T.y || s.y + 1 === T.y)) continue;        // the body would be in the cell
            // s.lean [dx, dz]: the bot sneaks to that edge of its cell and leans over it (the eye LEAN = 0.6 out, move.js), as a player does to place beside the block it stands on
            const sneak = sneak0 || !!s.lean, lx = s.lean ? s.lean[0] * 0.6 : 0, lz = s.lean ? s.lean[1] * 0.6 : 0;
            const eye = [s.x + 0.5 + lx, s.y + (sneak ? EYE_SNEAK : EYE), s.z + 0.5 + lz];
            for (const [u, w] of [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8], [0.2, 0.2], [0.8, 0.8], [0.2, 0.8], [0.8, 0.2]]) {
                const p = [0, 0, 0], [ra, rb] = face.rect;
                p[face.axis] = N[face.axis] + face.plane - v[face.axis] * 1e-4;
                p[face.others[0]] = N[face.others[0]] + ra[0] + (ra[1] - ra[0]) * u;
                p[face.others[1]] = N[face.others[1]] + rb[0] + (rb[1] - rb[0]) * w;
                const look = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
                if (look[0] * v[0] + look[1] * v[1] + look[2] * v[2] >= 0) continue;          // the face looks away from the eye
                if (Math.hypot(...look) > reach) continue;
                const hit = rayFirst(world, eye, p);
                if (!hit || hit.unknown || hit.cell[0] !== N[0] || hit.cell[1] !== N[1] || hit.cell[2] !== N[2]) continue;
                if (!hit.prev || hit.prev[0] !== T.x || hit.prev[1] !== T.y || hit.prev[2] !== T.z) continue;     // the ray reaches the face through the target cell itself
                // the look sent with the click: the eye's own ray to the hit point, else one of the exact looks (a cardinal, level or straight up/down), as Tweakeroo's
                // flexible placement does: the server takes the facing from the player's rotation and checks only the face and the hit point (comparators whose facing a ray at
                // an angle never gave were tried for hours, owner 2026-11-23 list 3 problem 1)
                let aim = null, good = null;
                for (const lk of [look, ...EXACT]) {
                    const got = V.predict(item, { face: F, hitY: p[1] - T.y, look: lk, sneak, at, solid });
                    if (!got || S.bare(got.name) !== S.bare(want.name)) continue;
                    const gp = got.props;
                    let ok = true;
                    for (const [k, val] of Object.entries(wantD)) {
                        if (!PLACED.has(k)) continue;                    // clicks set the others afterwards (open, note, delay, mode), or they are the block's default (level, candles ...)
                        if (gp[k] === undefined || (gp[k] !== val && !(k === 'type' && /chest$/.test(want.name) && val === 'right' && gp[k] === 'single'))) { ok = false; break; }
                    }
                    if (ok) { good = lk; if (lk !== look) aim = { yaw: Math.atan2(-lk[0], -lk[2]), pitch: Math.atan2(lk[1], Math.hypot(lk[0], lk[2])) }; break; }
                }
                if (!good) continue;
                out.push({ station: s, face: F, n: N, hit: p, look: good, sneak, lean: s.lean || null, aim });
                if (out.length >= max) return out;
                break;
            }
        }
    }
    return out;
}

/** A face of cell T's own block the eye at station s sees first (for clicks on a placed block: notes, delays, opening), or null. */
// what the crosshair hits on a block with no collision box (grass, flowers, mushrooms, leaf litter, torches): its outline, about this box (with no box at all such a block was never
// "in sight", its clear task never got a stance, and the layers under it waited, live 2026-11-22 sY)
const OUTLINE = [[0.25, 0, 0.25, 0.75, 0.5, 0.75]];
/** The outline (what the crosshair hits) of a block with no collision box, close to vanilla's for the common ones. The server takes a click anywhere near the block. */
function outlineOf(b) {
    const n = S.bare(b.name);
    if (/^(torch|soul_torch|redstone_torch|copper_torch)$/.test(n)) return [[0.375, 0, 0.375, 0.625, 0.625, 0.625]];
    if (/(^redstone_wire|^tripwire$|_carpet$|^moss_carpet$|_rail$|^rail$|_pressure_plate$|^lily_pad$|^snow$)/.test(n)) return [[0, 0, 0, 1, 0.0625, 1]];
    return OUTLINE;
}
function clickable(world, T, s, { reach = REACH, faces = null } = {}) {
    let blk = world.block(T.x, T.y, T.z);
    if (isAir(blk) || isFluid(blk)) return null;
    if (!Array.isArray(blk.shapes) || !blk.shapes.length) blk = { ...blk, shapes: outlineOf(blk) };
    const eye = [s.x + 0.5, s.y + EYE, s.z + 0.5];
    for (const F of faces || V.DIRS) {
        const face = faceOf(blk, F); if (!face) continue;
        const v = V.VEC[F], p = [0, 0, 0];
        p[face.axis] = [T.x, T.y, T.z][face.axis] + face.plane - v[face.axis] * 1e-4;
        p[face.others[0]] = [T.x, T.y, T.z][face.others[0]] + (face.rect[0][0] + face.rect[0][1]) / 2;
        p[face.others[1]] = [T.x, T.y, T.z][face.others[1]] + (face.rect[1][0] + face.rect[1][1]) / 2;
        const look = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
        if (look[0] * v[0] + look[1] * v[1] + look[2] * v[2] >= 0 || Math.hypot(...look) > reach) continue;
        const hit = rayFirst(world, eye, p);
        if (hit && !hit.unknown && hit.cell[0] === T.x && hit.cell[1] === T.y && hit.cell[2] === T.z) return { face: F, hit: p, look };
    }
    return null;
}

module.exports = { ways, clickable, rayFirst, sturdy, faceOf, botWorld, full, REACH, EYE, EYE_SNEAK, AIR };

'use strict';
// Walking and aiming, built from frames: steer with yaw, hold forward, jump onto a step, sprint on long straight runs.
// Shared by every command that has to get somewhere or look at something.
const { plan, nodeKind } = require('./planner');
const { standable } = require('./world');
const { SkillError } = require('./runner');
const { EYE, BLOCK_REACH, lookAngles, aimPoints, angleDiff } = require('./geometry');

const STUCK_TICKS = 30;        // no progress for this long -> replan
const MAX_REPLANS = 5;
const LOOKAHEAD = 8;

// +0.2: on near-full ground (mud: top at 0.875) the feet are in the cell above it; on a bottom slab (0.5) they stay in its cell.
const feetCell = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y + 0.2), z: Math.floor(p.z) });
const centre = (c) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const eyeOf = (c) => ({ x: c.x + 0.5, y: c.y + EYE, z: c.z + 0.5 });

/** A player box (half-width 0.3) walking straight from p to q at height y stays on walkable cells. */
function clearLine(w, p, q, y) {
    const n = Math.ceil(hdist(p, q) / 0.25);
    for (let i = 0; i <= n; i++) {
        const x = p.x + ((q.x - p.x) * i) / n, z = p.z + ((q.z - p.z) * i) / n;
        for (const [ox, oz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
            if (!standable(w, Math.floor(x + ox), y, Math.floor(z + oz))) return false;
        }
    }
    return true;
}

/**
 * Walk until the feet cell satisfies goal.isGoal, planning with goal.h. Returns the arrival cell, or null when
 * goal.abort() turned true first (moving targets).
 * goal: {isGoal(cell), h(cell), label, settle?: true to stop near the cell centre, maxNodes?, abort?()}
 */
async function follow(ctx, goal, opts = {}) {
    // Always let at least one tick pass: callers loop around follow() (moving targets), and a call that returned at once
    // (goal already met, or aborted) made such a loop spin without the clock moving and froze the process (bench hard1).
    const t0 = ctx.t;
    const end = await walk(ctx, goal, opts);
    if (ctx.t === t0) await ctx.tick({});
    return end;
}

// A node on the path matches the feet cell; in water the feet bob up and down by a cell, so a swim node matches its column.
const onNode = (n, c) => same(n, c) || (n.kind === 'swim' && n.x === c.x && n.z === c.z && Math.abs(n.y - c.y) <= 1);

async function walk(ctx, goal, { sprint = true } = {}) {
    const bot = ctx.bot, w = ctx.world;
    let path = null, idx = 0, replans = 0, best = -Infinity, lastGain = ctx.t, airborne = 0, sunk = 0;
    const replan = (why) => {
        if (path && ++replans > MAX_REPLANS) throw new SkillError('stuck', { goal: goal.label, why, replans: replans - 1 });
        path = null;
        ctx.phase('replan', { why, n: replans });
    };
    for (;;) {
        const e = bot.entity, pos = e.position, cell = feetCell(pos);
        if (goal.abort && goal.abort()) return null;
        const onClimb = w.kindAt(cell.x, cell.y, cell.z) === 'climb';
        if (!e.onGround && !e.isInWater && !onClimb) {
            // In the air (step-up jump, drop, jump onto a ladder): keep steering toward the current target.
            if (++airborne > 80) throw new SkillError('stuck', { goal: goal.label, why: 'airborne for 4 s' });
            const tgt = path && path[Math.min(idx + 1, path.length - 1)];
            await ctx.tick(tgt ? { forward: hdist(pos, centre(tgt)) > 0.2, jump: tgt.move === 'climb', yaw: Math.atan2(-(tgt.x + 0.5 - pos.x), -(tgt.z + 0.5 - pos.z)) } : {});
            continue;
        }
        airborne = 0;
        if (e.isInWater && !path && !nodeKind(w, cell.x, cell.y, cell.z)) {
            // Under the surface band (just fell in): hold jump until the head is up; no air means no plan.
            if (++sunk > 60) throw new SkillError('stuck', { goal: goal.label, why: 'under water for 3 s' });
            await ctx.tick({ jump: true });
            continue;
        }
        sunk = 0;
        if (goal.isGoal(cell)) {
            const c = centre(cell), d = hdist(pos, c);
            if (!goal.settle || d < 0.25) {
                await ctx.until(() => Math.hypot(e.velocity.x, e.velocity.z) < 0.03, 10, 'stuck');
                if (goal.isGoal(feetCell(e.position))) return feetCell(e.position);
                continue;
            }
            await ctx.tick({ forward: d > 0.12, yaw: Math.atan2(-(c.x - pos.x), -(c.z - pos.z)) });
            continue;
        }
        if (!path) {
            ctx.phase('plan', { from: cell, goal: goal.label });
            const r = plan(w, cell, goal.isGoal, goal.h, { maxNodes: goal.maxNodes || 20000 });
            if (!r) {
                // Standing on something the planner does not model (an edge, a partial block): nudge to the cell centre once.
                const c = centre(cell);
                if (hdist(pos, c) > 0.15) { await ctx.tick({ forward: true, yaw: Math.atan2(-(c.x - pos.x), -(c.z - pos.z)) }); replans++; if (replans > MAX_REPLANS) throw new SkillError('unreachable', { goal: goal.label, why: 'start cell not standable' }); continue; }
                throw new SkillError('unreachable', { goal: goal.label, why: 'start cell not standable', cell });
            }
            if (r.partial && r.path.length === 1) throw new SkillError('unreachable', { goal: goal.label, expanded: r.expanded });
            path = r.path; idx = 0; best = -Infinity; lastGain = ctx.t;
            ctx.phase('walk', { nodes: path.length, partial: r.partial, to: path[path.length - 1], cells: path.map((n) => [n.x, n.y, n.z]) });
        }
        // Where are we on the path? Accept the current node or any of the next few.
        let k = -1;
        for (let j = idx; j < Math.min(path.length, idx + 4); j++) if (onNode(path[j], cell)) k = j;
        if (k >= 0) idx = k;
        else if (!path.slice(idx, idx + 3).some((n) => Math.abs(n.x - cell.x) <= 1 && Math.abs(n.z - cell.z) <= 1 && Math.abs(n.y - cell.y) <= 1)) { replan('off path'); continue; }
        if (idx === path.length - 1) {
            // End of a partial path, or a goal cell we passed through without stopping: plan again from here.
            if (!goal.isGoal(cell)) { replan('end of partial path'); continue; }
        }
        const here = path[idx];
        const next = path[Math.min(idx + 1, path.length - 1)];
        // Look ahead along straight walkable stretches so the bot does not zig-zag from cell centre to cell centre.
        let j = Math.min(idx + 1, path.length - 1);
        while (j + 1 < path.length && j - idx < LOOKAHEAD && path[j + 1].move === 'walk' && path[j].move !== 'up' && path[j + 1].y === cell.y
            && clearLine(w, pos, centre(path[j + 1]), cell.y)) j++;
        const tgt = centre(path[j]);
        const d = hdist(pos, tgt);
        const progress = idx + 1 / (1 + hdist(pos, centre(next)));
        if (progress > best + 0.02) { best = progress; lastGain = ctx.t; }
        if (ctx.t - lastGain > STUCK_TICKS) { replan('no progress'); continue; }
        const yaw = Math.atan2(-(tgt.x - pos.x), -(tgt.z - pos.z));
        const up = next.move === 'up' && next.y > cell.y;
        const wet = e.isInWater || here.kind === 'swim' || next.kind === 'swim';
        if (next.move === 'climb' || next.move === 'descend' || (next.move === 'swim' && next.x === cell.x && next.z === cell.z)) {
            // Vertical move in the same column: hold jump to climb or rise (the client climbs ladders on jump since 1.14),
            // nothing to slide down a ladder or sink; stay on the column centre.
            const c = centre(cell), off = hdist(pos, c);
            const rise = next.move === 'climb' || (next.move === 'swim' && next.y > cell.y);
            await ctx.tick({ forward: off > 0.15, jump: rise, yaw: off > 0.15 ? Math.atan2(-(c.x - pos.x), -(c.z - pos.z)) : e.yaw });
            continue;
        }
        // In water hold jump the whole time: it keeps the head above the surface and, against a bank, lifts the body out.
        // Leaving a ladder at its top is the same: keep climbing while walking onto the ledge.
        const jump = wet || (onClimb && up) || (up && (hdist(pos, centre(next)) < 1.3 || e.isCollidedHorizontally) && Math.abs(angleDiff(yaw, e.yaw)) < 0.6);
        const straight = j - idx >= 4 && !path.slice(idx + 1, j + 3).some((n) => n.move !== 'walk');
        const last = j === path.length - 1;
        await ctx.tick({ forward: !(last && d < 0.3), jump, sprint: sprint && straight && !last && !wet && bot.food > 6, yaw });
    }
}

/** Walk to the cell `t` (feet). The cell must be standable. */
function cellGoal(t, label = 'cell') {
    return { isGoal: (c) => same(c, t), h: (c) => Math.hypot(c.x - t.x, c.z - t.z) + 0.5 * Math.abs(c.y - t.y), label, settle: true };
}

/**
 * Goal: any standing cell from which some point of the block at `cell` is visible within reach (minus a margin for
 * not standing at the cell centre). `ok(c)` can veto cells (e.g. the target's own column).
 */
function reachGoal(w, cell, { reach = BLOCK_REACH - 0.4, face = null, ok = () => true, label = 'reach block' } = {}) {
    const tc = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
    const dist = (c) => Math.hypot(c.x + 0.5 - tc.x, c.y + EYE - tc.y, c.z + 0.5 - tc.z);
    return {
        isGoal: (c) => dist(c) <= reach + 0.9 && ok(c) && aimPoints(eyeOf(c), cell, w.shapesAt, { reach, face, limit: 1 }).length > 0,
        h: (c) => Math.max(0, dist(c) - reach), label,
    };
}

// Aim only at points this far inside the reach: the bot may still drift a few centimetres after it stops.
const AIM_REACH = BLOCK_REACH - 0.3;

/**
 * Walk to a goal from `makeGoal(reach, ok)` until `visible()` returns something from where the bot actually stands.
 * Goals are judged from the cell centre, the bot stands near it (settle) but not exactly on it: when the target is not
 * visible from the real eye (bench final-hard-a: 4 of 140, just out of reach or cut by a wall), re-approach once with a
 * tighter reach and a different cell.
 */
async function approachUntil(ctx, makeGoal, visible, label) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const here = feetCell(ctx.bot.entity.position);
        const g = makeGoal(BLOCK_REACH - 0.4 - 0.8 * attempt, attempt ? (c) => !same(c, here) : () => true);
        if (attempt || !(ctx.bot.entity.onGround && g.isGoal(here))) {
            ctx.phase(attempt ? 'reapproach' : 'approach', { target: label });
            await follow(ctx, { ...g, settle: true });
        }
        const v = visible();
        if (v) return v;
    }
    throw new SkillError('not_visible', { target: label, from: feetCell(ctx.bot.entity.position) });
}

/** Aim points whose ray from the eye no entity crosses first (a mob, or a dying one, in front of the block). */
function clearOfEntities(ctx, pts) {
    const eye = ctx.body.eye();
    return pts.filter((p) => {
        const d = { x: (p.point.x - eye.x) / p.dist, y: (p.point.y - eye.y) / p.dist, z: (p.point.z - eye.z) / p.dist };
        return !ctx.body.entityOnRay(eye, d, p.dist);
    });
}

/** Get within reach of the block at `cell` (no movement if already there). Returns the aim points from where it stands. */
async function approachBlock(ctx, cell, opts = {}) {
    const ok = opts.ok || (() => true);
    return approachUntil(ctx, (reach, ok2) => reachGoal(ctx.world, cell, { ...opts, reach, ok: (c) => ok(c) && ok2(c) }), () => {
        const pts = clearOfEntities(ctx, aimPoints(ctx.body.eye(), cell, ctx.world.shapesAt, { face: opts.face ?? null, reach: AIM_REACH }));
        return pts.length ? pts : null;
    }, cell);
}

/**
 * Turn so the crosshair rests on the block at `cell` (optionally on `face`), trying the visible aim points in turn.
 * Returns the crosshair hit. Throws not_visible when no point works.
 */
async function aimAtBlock(ctx, cell, { face = null, frame = {} } = {}) {
    const pts = aimPoints(ctx.body.eye(), cell, ctx.world.shapesAt, { face, limit: 5, reach: AIM_REACH });
    const seen = [];        // what the crosshair hit instead, for the failure detail
    for (const p of pts) {
        const { yaw, pitch } = lookAngles(ctx.body.eye(), p.point);
        await ctx.tick({ ...frame, yaw, pitch });
        let hit = ctx.body.crosshair();
        // An entity in the way may walk off or finish dying (a killed mob stays hittable for its 20-tick death animation).
        for (let i = 0; i < 10 && hit && hit.kind === 'entity'; i++) { await ctx.tick({ ...frame, yaw, pitch }); hit = ctx.body.crosshair(); }
        if (hit && hit.kind === 'block' && same(hit.block.position, cell) && (face === null || hit.face === face)) return hit;
        const r2 = (v) => Math.round(v * 100) / 100;
        seen.push(!hit ? { hit: null, aim_dist: r2(p.dist) } : hit.kind === 'entity' ? { hit: 'entity', name: hit.entity.name, id: hit.entity.id, dist: r2(hit.dist) }
            : { hit: 'block', name: hit.block.name, at: [hit.block.position.x, hit.block.position.y, hit.block.position.z], face: hit.face, dist: r2(hit.dist), aim_dist: r2(p.dist) });
    }
    throw new SkillError('not_visible', { target: cell, tried: pts.length, seen });
}

module.exports = { follow, cellGoal, reachGoal, approachUntil, approachBlock, aimAtBlock, clearOfEntities, AIM_REACH, feetCell, centre, hdist, same, eyeOf, clearLine };

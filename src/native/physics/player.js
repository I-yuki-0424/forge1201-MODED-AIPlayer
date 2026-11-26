'use strict';
// The vanilla player movement, one client tick (TASK-20261125-076, docs/implemented/NATIVE-v1.md). Written from the game's own order of calls so that each
// step can be checked against a server trace on its own:
//
//   Entity.baseTick        fluids (height, current, lava), eyes in water, swimming
//   LocalPlayer.aiStep     keys -> impulses (sneak, using an item), sprint start / stop
//   LivingEntity.aiStep    tiny speeds to zero, jump (ground, water, lava), impulses x 0.98, travel
//     travel               water / lava / ground-and-air branches, moveRelative, climbing, friction, gravity
//       Entity.move        stuck-in-block factor, sneak edge back-off, collide (step-up), flags, landing (slime, bed), stepOn, inside blocks, speed factor
//   Player.tick (end)      pose (standing, crouching, swimming) for the next tick
//
// The state is a plain object (see `fresh`): position, velocity, flags, and the inputs of the tick (keys, look, attributes, effects). Angles are the game's:
// yaw and pitch in degrees (yRot / xRot). Elytra flight, riding, creative flight, entity pushing and the client's push out of blocks are not modelled
// (docs/implemented/NATIVE-v1.md, "Gaps").
const M = require('./mth');
const S = require('./shapes');
const { View } = require('./blocks');
const { featuresOf } = require('./versions');

const f = M.f;
const F = {                               // the game's float constants, as doubles
    c098: f(0.98), c091: f(0.91), c08: f(0.8), c09: f(0.9), c002: f(0.02), c0546: f(0.54600006), c0216: f(0.21600002), c0026: f(0.025999999),
    c015: f(0.15), c06: f(0.6), c03: f(0.3), c004: f(0.04), c0005: f(0.05), c02: f(0.2), c01: f(0.1), c09p: f(0.9), c066: f(0.66), c1em5: f(1e-5), c0500001: f(0.500001),
};
const WIDTH = 0.6;
const HEIGHT = { standing: 1.8, crouching: 1.5, swimming: 0.6 };
const EYE = { standing: f(1.62), crouching: f(1.27), swimming: f(0.4) };
const SPRINT_IDS = new Set(['662a6b8d-da3e-4c1c-8813-96ea6097278d', 'minecraft:sprinting', 'sprinting']);

/** A state with every field the tick reads or writes. */
function fresh(o = {}) {
    return {
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
        onGround: false, horizontalCollision: false, minorHorizontalCollision: false, verticalCollision: false,
        fallDistance: 0, pose: 'standing', sprinting: false, swimming: false, wasTouchingWater: false, eyeFluid: null, wasEyeInWater: false,
        fluidHeight: { water: 0, lava: 0 }, noJumpDelay: 0, stuck: null, supporting: null, onGroundNoBlocks: false, firstTick: false, inPowderSnow: false,
        keys: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
        usingItem: false, food: 20,
        // attributes: base values and the server's modifiers (sprinting is the client's own and is applied from `sprinting`)
        attr: { movementSpeed: 0.1, jumpStrength: 0.42, gravity: 0.08, stepHeight: 0.6, sneakingSpeed: 0.3, waterMovementEfficiency: 0, movementEfficiency: 0 },
        speedModifiers: [],
        effects: { jumpBoost: 0, slowFalling: 0, levitation: 0, dolphinsGrace: 0 },
        walksOnPowderSnow: false, ultraWarm: false, minY: -64,
        ...o,
    };
}

const boxOf = (s, pose = s.pose) => { const h = HEIGHT[pose] || 1.8; return [s.x - WIDTH / 2, s.y, s.z - WIDTH / 2, s.x + WIDTH / 2, s.y + h, s.z + WIDTH / 2]; };

/** AttributeInstance.calculateValue over the server's modifiers plus the sprint modifier: add, then add x base, then x (1 + amount); clamped to 0..1024. */
function speedValue(s) {
    let base = s.attr.movementSpeed, add = 0, mulBase = 0, mulTotal = 1;
    const mods = s.speedModifiers.filter((m) => !SPRINT_IDS.has(String(m.id ?? m.uuid ?? '')));
    if (s.sprinting) mods.push({ amount: 0.3, operation: 2 });
    for (const m of mods) if (m.operation === 0) add += m.amount;
    const d = base + add; let e = d;
    for (const m of mods) if (m.operation === 1) mulBase += m.amount;
    e += d * mulBase;
    for (const m of mods) if (m.operation === 2) mulTotal *= 1 + m.amount;
    e *= mulTotal;
    base = Math.max(0, Math.min(1024, e));
    return f(base);
}

class Tick {
    constructor(dataVersion, facts) {
        this.feat = featuresOf(dataVersion);
        this.view = new View(facts);
    }

    // ---- world queries ---------------------------------------------------------------------------------------------
    who(s) { return { y: s.y, descending: !!s.keys.sneak, fallDistance: s.fallDistance, walksOnPowderSnow: !!s.walksOnPowderSnow }; }
    boxes(s, q) { const who = this.who(s); return S.blockBoxes(q, (x, y, z) => this.view.shapes(x, y, z, who)); }
    noCollision(s, q) { return this.boxes(s, q).length === 0; }
    containsAnyLiquid(q) {
        for (let x = Math.floor(q[0]); x < Math.ceil(q[3]); x++) for (let y = Math.floor(q[1]); y < Math.ceil(q[4]); y++) for (let z = Math.floor(q[2]); z < Math.ceil(q[5]); z++) if (this.view.fluid(x, y, z)) return true;
        return false;
    }
    isFree(s, dx, dy, dz) { const q = S.move(boxOf(s), dx, dy, dz); return this.noCollision(s, q) && !this.containsAnyLiquid(q); }
    blockPos(s) { return [Math.floor(s.x), Math.floor(s.y), Math.floor(s.z)]; }
    inBlock(s) { const [x, y, z] = this.blockPos(s); return this.view.at(x, y, z); }

    /** Entity.getOnPos(f): the supporting block when there is one (fences and walls keep their own cell for f <= 0.5), else the cell f below the feet. */
    onPos(s, fd) {
        if (s.supporting) {
            const p = s.supporting;
            if (!(fd > 1e-5)) return p;
            const d = this.view.at(p[0], p[1], p[2]);
            return fd <= 0.5 && d && d.fenceLike ? p : [p[0], Math.floor(s.y - fd), p[2]];
        }
        return [Math.floor(s.x), Math.floor(s.y - fd), Math.floor(s.z)];
    }
    belowAffecting(s) { return this.onPos(s, F.c0500001); }

    /** FluidState.getHeight: a full cell when the same fluid is above, else amount / 9. */
    fluidHeightAt(x, y, z, fl) {
        const up = this.view.fluid(x, y + 1, z);
        return up && up.type === fl.type ? 1 : f(fl.amount / 9);
    }
    ownHeight(fl) { return fl ? f(fl.amount / 9) : 0; }

    /** FlowingFluid.getFlow, normalised. */
    flow(x, y, z, fl) {
        const own = this.ownHeight(fl);
        let dx = 0, dz = 0;
        for (const [sx, sz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {          // Direction.Plane.HORIZONTAL: north, east, south, west
            const n = this.view.fluid(x + sx, y, z + sz);
            if (n && n.type !== fl.type) continue;                              // affectsFlow: empty or the same fluid
            let h = this.ownHeight(n), g = 0;
            if (h === 0) {
                const nb = this.view.at(x + sx, y, z + sz);
                if (!(nb && nb.blocksMotion)) {
                    const b = this.view.fluid(x + sx, y - 1, z + sz);
                    if (!b || b.type === fl.type) { h = this.ownHeight(b); if (h > 0) g = f(own - f(h - f(0.8888889))); }
                }
            } else if (h > 0) g = f(own - h);
            if (g !== 0) { dx += sx * g; dz += sz * g; }
        }
        let v = [dx, 0, dz];
        if (fl.falling) {
            for (const [sx, sz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
                if (this.solidFace(x + sx, y, z + sz, fl) || this.solidFace(x + sx, y + 1, z + sz, fl)) { v = norm(v); v[1] -= 6; break; }
            }
        }
        return norm(v);
    }
    solidFace(x, y, z, fl) {
        const n = this.view.fluid(x, y, z);
        if (n && n.type === fl.type) return false;
        const d = this.view.at(x, y, z);
        return !!(d && d.fullCube && !/ice$/.test(d.name));
    }

    // ---- Entity.baseTick parts ---------------------------------------------------------------------------------------
    fluidPush(s, type, scale) {
        const bb = S.deflate(boxOf(s), 0.001);
        const i = Math.floor(bb[0]), j = Math.ceil(bb[3]), k = Math.floor(bb[1]), l = Math.ceil(bb[4]), m = Math.floor(bb[2]), n = Math.ceil(bb[5]);
        let e = 0, touching = false, vx = 0, vy = 0, vz = 0, o = 0;
        for (let x = i; x < j; x++) for (let y = k; y < l; y++) for (let z = m; z < n; z++) {
            const fl = this.view.fluid(x, y, z);
            if (!fl || fl.type !== type) continue;
            const h = y + this.fluidHeightAt(x, y, z, fl);
            if (h < bb[1]) continue;
            touching = true; e = Math.max(h - bb[1], e);
            let w = this.flow(x, y, z, fl);
            if (e < 0.4) w = [w[0] * e, w[1] * e, w[2] * e];
            vx += w[0]; vy += w[1]; vz += w[2]; o++;
        }
        let len = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (len > 0) {
            if (o > 0) { vx /= o; vy /= o; vz /= o; }
            vx *= scale; vy *= scale; vz *= scale; len = Math.sqrt(vx * vx + vy * vy + vz * vz);
            if (Math.abs(s.vx) < 0.003 && Math.abs(s.vz) < 0.003 && len < 0.0045000000000000005) { const k2 = 0.0045000000000000005 / len; vx *= k2; vy *= k2; vz *= k2; }
            s.vx += vx; s.vy += vy; s.vz += vz;
        }
        s.fluidHeight[type] = e;
        return touching;
    }
    waterState(s) {
        if (this.fluidPush(s, 'water', 0.014)) { s.fallDistance = 0; s.wasTouchingWater = true; } else s.wasTouchingWater = false;
    }
    fluidsAndEyes(s) {
        s.fluidHeight = { water: 0, lava: 0 };
        this.waterState(s);
        this.fluidPush(s, 'lava', s.ultraWarm ? 0.007 : 0.0023333333333333335);
        // updateFluidOnEyes: wasEyeInWater is the previous tick's answer
        s.wasEyeInWater = s.eyeFluid === 'water';
        const ey = s.y + (EYE[s.pose] || EYE.standing) - f(0.11111111), bx = Math.floor(s.x), by = Math.floor(ey), bz = Math.floor(s.z);
        const fl = this.view.fluid(bx, by, bz);
        s.eyeFluid = fl && by + this.fluidHeightAt(bx, by, bz, fl) > ey ? fl.type : null;
        // updateSwimming
        const feet = this.view.fluid(...this.blockPos(s));
        s.swimming = s.swimming ? s.sprinting && s.wasTouchingWater : s.sprinting && s.wasEyeInWater && !!feet && feet.type === 'water';
    }
    isInLava(s) { return !s.firstTick && s.fluidHeight.lava > 0; }

    // ---- climbing ----------------------------------------------------------------------------------------------------
    onClimbable(s) {
        const [x, y, z] = this.blockPos(s), d = this.view.at(x, y, z);
        if (!d) return false;
        if (d.climbable) return true;
        if (d.trapdoor && (d.props.open === true || d.props.open === 'true')) {
            const below = this.view.at(x, y - 1, z);
            return !!(below && below.ladder && below.props.facing === d.props.facing);
        }
        return false;
    }

    // ---- LocalPlayer.aiStep: input and sprint ------------------------------------------------------------------------
    input(s) {
        const k = s.keys;
        let fwd = k.forward === k.back ? 0 : k.forward ? 1 : -1, left = k.left === k.right ? 0 : k.left ? 1 : -1;
        // LocalPlayer.crouching: room to crouch, and the sneak key or no room to stand (a body under a 1.5 ceiling stays slow after the key is let go).
        // The key of THIS tick counts (as mineflayer sends it at once); the game reads the previous tick's shift state (one tick later, unverified).
        const crouching = this.canFit(s, 'crouching') && (!!k.sneak || !this.canFit(s, 'standing'));
        const slowly = crouching || (s.pose === 'swimming' && !s.wasTouchingWater);
        if (this.feat.normalisedInput && (fwd || left)) { const l = Math.hypot(fwd, left); fwd = f(fwd / l); left = f(left / l); }
        if (slowly) { const m = f(s.attr.sneakingSpeed); fwd = f(fwd * m); left = f(left * m); }
        if (s.usingItem) { fwd = f(fwd * F.c02); left = f(left * F.c02); }
        // sprint (LocalPlayer.aiStep, 1.21.1): start on the key with forward impulse >= 0.8 (any forward under water), food > 6, not using an item
        const underWater = s.wasEyeInWater, inWater = s.wasTouchingWater;
        const impulse = underWater ? fwd > 1e-5 : fwd >= 0.8;
        const food = s.food > 6;
        if (!s.sprinting && k.sprint && impulse && food && !s.usingItem && (!inWater || underWater)) s.sprinting = true;
        if (s.sprinting) {
            const noImpulse = !(fwd > 1e-5) || !food;
            const stop = noImpulse || (s.horizontalCollision && !s.minorHorizontalCollision) || (inWater && !underWater);
            if (s.swimming) { if ((!s.onGround && !k.sneak && noImpulse) || !inWater) s.sprinting = false; } else if (stop) s.sprinting = false;
            // the bot's sprint key is held, not tapped: letting it go ends the sprint (a person's client keeps sprinting until forward is released); the
            // transport tells the server whenever `sprinting` changes, so client and server agree either way
            if (!k.sprint) s.sprinting = false;
        }
        return { fwd, left };
    }

    // ---- LivingEntity.travel and its parts ---------------------------------------------------------------------------
    moveRelative(s, speed, xxa, zza) {
        const lsq = xxa * xxa + zza * zza;
        if (lsq < 1e-7) return;
        let ix = xxa, iz = zza;
        if (lsq > 1) { const l = Math.sqrt(lsq); ix /= l; iz /= l; }
        ix *= speed; iz *= speed;
        const r = f(s.yaw * M.DEG), sn = M.sin(r, this.feat.mthDouble), cs = M.cos(r, this.feat.mthDouble);
        s.vx += ix * cs - iz * sn;
        s.vz += iz * cs + ix * sn;
    }
    frictionSpeed(s, p) {
        if (s.onGround) { const sp = speedValue(s); return f(sp * f(F.c0216 / f(f(p * p) * p))); }
        return s.sprinting ? F.c0026 : F.c002;
    }
    climb(s) {
        if (!this.onClimbable(s)) return;
        s.fallDistance = 0;
        s.vx = M.clamp(s.vx, -F.c015, F.c015); s.vz = M.clamp(s.vz, -F.c015, F.c015);
        let g = Math.max(s.vy, -F.c015);
        const inb = this.inBlock(s);
        if (g < 0 && !(inb && inb.scaffolding) && s.keys.sneak) g = 0;
        s.vy = g;
    }
    fluidFalling(s, d, falling) {
        if (d !== 0 && !s.sprinting) s.vy = falling && Math.abs(s.vy - 0.005) >= 0.003 && Math.abs(s.vy - d / 16) < 0.003 ? -0.003 : s.vy - d / 16;
    }
    travel(s, xxa, zza, jumping) {
        let d = s.attr.gravity;
        const falling = s.vy <= 0;
        if (falling && s.effects.slowFalling > 0) d = Math.min(d, 0.01);
        if (s.swimming) {                                                   // Player.travel, swimming: the look pulls the body up or down
            const xr = f(s.pitch * M.DEG), look = -M.sin(xr, this.feat.mthDouble);
            const e = look < -0.2 ? 0.085 : 0.06;
            const above = this.view.fluid(Math.floor(s.x), Math.floor(s.y + 1 - 0.1), Math.floor(s.z));
            if (look <= 0 || jumping || above) s.vy += (look - s.vy) * e;
        }
        if (s.wasTouchingWater) {
            const y0 = s.y;
            let fr = s.sprinting ? F.c09 : F.c08, g = F.c002;
            let h = f(s.attr.waterMovementEfficiency);
            if (!s.onGround) h = f(h * 0.5);
            if (h > 0) { fr = f(fr + f(f(F.c0546 - fr) * h)); g = f(g + f(f(speedValue(s) - g) * h)); }
            if (s.effects.dolphinsGrace > 0) fr = f(0.96);
            this.moveRelative(s, g, xxa, zza);
            this.move(s);
            if (s.horizontalCollision && this.onClimbable(s)) s.vy = 0.2;
            s.vx *= fr; s.vy *= F.c08; s.vz *= fr;
            this.fluidFalling(s, d, falling);
            if (s.horizontalCollision && this.isFree(s, s.vx, s.vy + F.c06 - s.y + y0, s.vz)) s.vy = F.c03;
        } else if (this.isInLava(s)) {
            const y0 = s.y;
            this.moveRelative(s, F.c002, xxa, zza);
            this.move(s);
            if (s.fluidHeight.lava <= 0.4) { s.vx *= 0.5; s.vy *= F.c08; s.vz *= 0.5; this.fluidFalling(s, d, falling); } else { s.vx *= 0.5; s.vy *= 0.5; s.vz *= 0.5; }
            if (d !== 0) s.vy += -d / 4;
            if (s.horizontalCollision && this.isFree(s, s.vx, s.vy + F.c06 - s.y + y0, s.vz)) s.vy = F.c03;
        } else {
            const bp = this.belowAffecting(s), bd = this.view.at(bp[0], bp[1], bp[2]);
            const p = f(bd ? bd.friction : 0.6), fr = s.onGround ? f(p * F.c091) : F.c091;
            // handleRelativeFrictionAndCalculateMovement
            this.moveRelative(s, this.frictionSpeed(s, p), xxa, zza);
            this.climb(s);
            this.move(s);
            if (s.horizontalCollision || jumping) {
                const inb = this.inBlock(s);
                if (this.onClimbable(s) || (inb && inb.powderSnow && s.walksOnPowderSnow)) s.vy = 0.2;
            }
            let q = s.vy;
            if (s.effects.levitation > 0) q += (0.05 * s.effects.levitation - s.vy) * 0.2;
            else if (bd) q -= d;
            else q = s.y > s.minY ? -0.1 : 0;
            s.vx *= fr; s.vy = q * F.c098; s.vz *= fr;
        }
    }

    // ---- Entity.move -------------------------------------------------------------------------------------------------
    canFallAtLeast(s, dx, dz, h) {
        const b = boxOf(s);
        if (this.feat.edgeProbeBelowFeet) return this.noCollision(s, [b[0] + dx, b[1] - h - F.c1em5, b[2] + dz, b[3] + dx, b[1], b[5] + dz]);
        return this.noCollision(s, S.move(b, dx, -h, dz));
    }
    aboveGround(s, step) {
        if (s.onGround) return true;
        if (!(s.fallDistance < step)) return false;
        if (this.feat.edgeProbeBelowFeet) return !this.canFallAtLeast(s, 0, 0, step - s.fallDistance);
        return !this.noCollision(s, S.move(boxOf(s), 0, s.fallDistance - step, 0));
    }
    backOffFromEdge(s, v) {
        const step = f(s.attr.stepHeight);
        if (v[1] > 0 || !s.keys.sneak || !this.aboveGround(s, step)) return v;
        let [d, , e] = v;
        if (this.feat.edgeProbeBelowFeet) {
            const h = Math.sign(d) * 0.05, i = Math.sign(e) * 0.05;
            while (d !== 0 && this.canFallAtLeast(s, d, 0, step)) { if (Math.abs(d) <= 0.05) { d = 0; break; } d -= h; }
            while (e !== 0 && this.canFallAtLeast(s, 0, e, step)) { if (Math.abs(e) <= 0.05) { e = 0; break; } e -= i; }
            while (d !== 0 && e !== 0 && this.canFallAtLeast(s, d, e, step)) {
                d = Math.abs(d) <= 0.05 ? 0 : d - h;
                e = Math.abs(e) <= 0.05 ? 0 : e - i;
            }
        } else {
            const stepOff = (a) => (a < 0.05 && a >= -0.05 ? 0 : a > 0 ? a - 0.05 : a + 0.05);
            while (d !== 0 && this.canFallAtLeast(s, d, 0, step)) d = stepOff(d);
            while (e !== 0 && this.canFallAtLeast(s, 0, e, step)) e = stepOff(e);
            while (d !== 0 && e !== 0 && this.canFallAtLeast(s, d, e, step)) { d = stepOff(d); e = stepOff(e); }
        }
        return [d, v[1], e];
    }
    collideBox(s, v, b) { return S.collideWithShapes(v, b, this.boxes(s, S.expandTowards(b, v[0], v[1], v[2]))); }
    collide(s, v) {
        const bb = boxOf(s);
        const w = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] === 0 ? [v[0], v[1], v[2]] : this.collideBox(s, v, bb);
        const cx = v[0] !== w[0], cy = v[1] !== w[1], cz = v[2] !== w[2];
        const step = f(s.attr.stepHeight);
        const hd = (a) => a[0] * a[0] + a[2] * a[2];
        if (!(step > 0 && (s.onGround || (cy && v[1] < 0)) && (cx || cz))) return w;
        if (this.feat.stepCandidates) {
            const bb2 = cy ? S.move(bb, 0, w[1], 0) : bb;
            let q = S.expandTowards(bb2, v[0], step, v[2]);
            if (!cy) q = S.expandTowards(q, 0, -F.c1em5, 0);
            const list = this.boxes(s, q), skip = f(w[1]), hs = new Set();
            for (const sh of list) for (const yy of [sh[1], sh[4]]) { const h = f(yy - bb2[1]); if (!(h < 0) && h !== skip && h <= step) hs.add(h); }
            for (const h of [...hs].sort((a, b) => a - b)) {
                const y = S.collideWithShapes([v[0], h, v[2]], bb2, list);
                if (hd(y) > hd(w)) return [y[0], y[1] - (bb[1] - bb2[1]), y[2]];
            }
            return w;
        }
        let x = this.collideBox(s, [v[0], step, v[2]], bb);
        const y = this.collideBox(s, [0, step, 0], S.expandTowards(bb, v[0], 0, v[2]));
        if (y[1] < step) {
            const z = this.collideBox(s, [v[0], 0, v[2]], S.move(bb, 0, y[1], 0));
            const zz = [z[0] + y[0], z[1] + y[1], z[2] + y[2]];
            if (hd(zz) > hd(x)) x = zz;
        }
        if (hd(x) > hd(w)) {
            const down = this.collideBox(s, [0, -x[1] + v[1], 0], S.move(bb, x[0], x[1], x[2]));
            return [x[0] + down[0], x[1] + down[1], x[2] + down[2]];
        }
        return w;
    }
    minorCollision(s, w, xxa, zza) {
        const r = f(s.yaw * M.DEG), d = M.sin(r, this.feat.mthDouble), e = M.cos(r, this.feat.mthDouble);
        const g = xxa * e - zza * d, h = zza * e + xxa * d, i = g * g + h * h, j = w[0] * w[0] + w[2] * w[2];
        if (i < 1e-5 || j < 1e-5) return false;
        const k = g * w[0] + h * w[2];
        return Math.acos(k / Math.sqrt(i * j)) < f(0.13962634);
    }
    supportingBlock(s, w) {
        const b = boxOf(s);
        const find = (q) => {
            let best = null, bd = Infinity;
            const who = this.who(s);
            for (let x = Math.floor(q[0] - 1e-7) - 1; x <= Math.floor(q[3] + 1e-7) + 1; x++) for (let y = Math.floor(q[1] - 1e-7) - 1; y <= Math.floor(q[4] + 1e-7) + 1; y++) for (let z = Math.floor(q[2] - 1e-7) - 1; z <= Math.floor(q[5] + 1e-7) + 1; z++) {
                const sh = this.view.shapes(x, y, z, who);
                if (!sh || !sh.some((t) => S.intersects([t[0] + x, t[1] + y, t[2] + z, t[3] + x, t[4] + y, t[5] + z], q))) continue;
                const dd = (x + 0.5 - s.x) ** 2 + (y + 0.5 - s.y) ** 2 + (z + 0.5 - s.z) ** 2;
                const later = best && (y !== best[1] ? y > best[1] : z !== best[2] ? z > best[2] : x > best[0]);    // BlockPos.compareTo: y, then z, then x
                if (dd < bd || (dd === bd && (!best || later))) { best = [x, y, z]; bd = dd; }
            }
            return best;
        };
        if (!s.onGround) { s.onGroundNoBlocks = false; s.supporting = null; return; }
        const below = [b[0], b[1] - 1e-6, b[2], b[3], b[1], b[5]];
        let p = find(below);
        if (!p && !s.onGroundNoBlocks && w) p = find(S.move(below, -w[0], 0, -w[2]));
        s.supporting = p;
        s.onGroundNoBlocks = !p;
    }
    insideBlocks(s) {
        const b = boxOf(s), e = F.c1em5;
        const x0 = Math.floor(b[0] + e), y0 = Math.floor(b[1] + e), z0 = Math.floor(b[2] + e), x1 = Math.floor(b[3] - e), y1 = Math.floor(b[4] - e), z1 = Math.floor(b[5] - e);
        const stuck = (v) => { s.fallDistance = 0; s.stuck = v; };
        const feet = this.inBlock(s);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            const d = this.view.at(x, y, z);
            if (!d) continue;
            if (d.cobweb) stuck([0.25, F.c0005, 0.25]);
            else if (d.berryBush) stuck([F.c08, 0.75, F.c08]);
            else if (d.powderSnow) { if (feet && feet.powderSnow) stuck([F.c09p, 1.5, F.c09p]); s.inPowderSnow = true; }
            else if (d.honey) {
                const half = 0.4375 + WIDTH / 2;
                if (!s.onGround && !(s.y > y + 0.9375 - 1e-7) && !(s.vy >= -0.08) && (Math.abs(x + 0.5 - s.x) + 1e-7 > half || Math.abs(z + 0.5 - s.z) + 1e-7 > half)) {
                    if (s.vy < -0.13) { const k = -0.05 / s.vy; s.vx *= k; s.vz *= k; }
                    s.vy = -0.05; s.fallDistance = 0;
                }
            } else if (d.bubble) {
                const up = this.view.at(x, y + 1, z);
                if (up && up.air) s.vy = d.bubble.down ? Math.max(-0.9, s.vy - 0.03) : Math.min(1.8, s.vy + 0.1);
                else { s.vy = d.bubble.down ? Math.max(-0.3, s.vy - 0.03) : Math.min(0.7, s.vy + 0.06); s.fallDistance = 0; }
            }
        }
    }
    /** Entity.getBlockSpeedFactor (the feet cell, else the block below unless the feet are in water), lerped toward 1 by movement efficiency (LivingEntity, 1.21). */
    speedFactor(s) {
        const feet = this.inBlock(s);
        let sf = feet ? feet.speedFactor : 1;
        if (!(feet && (feet.name === 'water' || feet.name === 'bubble_column')) && sf === 1) { const bp = this.belowAffecting(s), bd = this.view.at(bp[0], bp[1], bp[2]); sf = bd ? bd.speedFactor : 1; }
        const me = f(s.attr.movementEfficiency || 0);
        return me ? f(sf + me * (1 - sf)) : f(sf);
    }
    move(s) {
        let v = [s.vx, s.vy, s.vz];
        if (s.stuck && s.stuck[0] * s.stuck[0] + s.stuck[1] * s.stuck[1] + s.stuck[2] * s.stuck[2] > 1e-7) {
            v = [v[0] * s.stuck[0], v[1] * s.stuck[1], v[2] * s.stuck[2]];
            s.stuck = null; s.vx = 0; s.vy = 0; s.vz = 0;
        }
        v = this.backOffFromEdge(s, v);
        const w = this.collide(s, v);
        if (w[0] * w[0] + w[1] * w[1] + w[2] * w[2] > 1e-7) { s.x += w[0]; s.y += w[1]; s.z += w[2]; }
        const bx = !(Math.abs(w[0] - v[0]) < F.c1em5), bz = !(Math.abs(w[2] - v[2]) < F.c1em5);
        s.horizontalCollision = bx || bz;
        s.verticalCollision = v[1] !== w[1];
        const below = s.verticalCollision && v[1] < 0;
        s.minorHorizontalCollision = s.horizontalCollision ? this.minorCollision(s, w, this._xxa, this._zza) : false;
        s.onGround = below;
        this.supportingBlock(s, w);
        const bp = this.onPos(s, f(0.2)), bs = this.view.at(bp[0], bp[1], bp[2]);
        // LivingEntity.checkFallDamage: a body not yet in water looks again (the landing may be in water), then Entity.checkFallDamage
        if (!s.wasTouchingWater) this.waterState(s);
        if (s.onGround) s.fallDistance = 0;
        else if (w[1] < 0) s.fallDistance = f(s.fallDistance - f(w[1]));
        if (s.horizontalCollision) { if (bx) s.vx = 0; if (bz) s.vz = 0; }
        if (v[1] !== w[1]) {                                               // Block.updateEntityAfterFallOn
            if (bs && bs.slime && !s.keys.sneak) { if (s.vy < 0) s.vy = -s.vy; }
            else if (bs && bs.bed && !s.keys.sneak) { if (s.vy < 0) s.vy = -s.vy * F.c066; }
            else s.vy = 0;
        }
        if (s.onGround && bs && bs.slime) {                               // SlimeBlock.stepOn
            const dd = Math.abs(s.vy);
            if (dd < 0.1 && !s.keys.sneak) { const e = 0.4 + dd * 0.2; s.vx *= e; s.vz *= e; }
        }
        this.insideBlocks(s);
        const sf = this.speedFactor(s);
        s.vx *= sf; s.vz *= sf;
    }

    // ---- Player.updatePlayerPose ------------------------------------------------------------------------------------
    canFit(s, pose) { return this.noCollision(s, S.deflate(boxOf(s, pose), 1e-7)); }
    pose(s) {
        if (!this.canFit(s, 'swimming')) return;
        const want = s.swimming ? 'swimming' : s.keys.sneak ? 'crouching' : 'standing';
        s.pose = this.canFit(s, want) ? want : this.canFit(s, 'crouching') ? 'crouching' : 'swimming';
    }

    /** One client tick of the player `s` (mutated and returned) in `world` (prismarine interface: getBlock(Vec3) -> Block | null). */
    step(s, world) {
        this.view.reset(world);
        s.inPowderSnow = false;
        this.fluidsAndEyes(s);
        // `imp`: the impulses themselves (a server-side player such as carpet's fake player sets xxa / zza, sprinting, shift and jumping directly), else the keys
        let fwd, left;
        if (s.imp) { fwd = f(s.imp.zza || 0); left = f(s.imp.xxa || 0); s.sprinting = !!s.imp.sprinting; s.keys = { ...s.keys, sneak: !!s.imp.sneak, jump: !!s.imp.jumping }; }
        else ({ fwd, left } = this.input(s));
        const jumping = !!s.keys.jump;
        if (s.noJumpDelay > 0) s.noJumpDelay--;
        if (Math.abs(s.vx) < 0.003) s.vx = 0;
        if (Math.abs(s.vy) < 0.003) s.vy = 0;
        if (Math.abs(s.vz) < 0.003) s.vz = 0;
        if (jumping) {
            const lava = this.isInLava(s), k = lava ? s.fluidHeight.lava : s.fluidHeight.water;
            const water = s.wasTouchingWater && k > 0, l = 0.4;
            if (!water || (s.onGround && !(k > l))) {
                if (!lava || (s.onGround && !(k > l))) {
                    if ((s.onGround || (water && k <= l)) && s.noJumpDelay === 0) { this.jumpFromGround(s); s.noJumpDelay = 10; }
                } else s.vy += F.c004;
            } else s.vy += F.c004;
        } else s.noJumpDelay = 0;
        const xxa = f(left * F.c098), zza = f(fwd * F.c098);
        this._xxa = xxa; this._zza = zza;
        this.travel(s, xxa, zza, jumping);
        this.pose(s);
        s.firstTick = false;
        return s;
    }
    jumpFromGround(s) {
        const [x, y, z] = this.blockPos(s), here = this.view.at(x, y, z), bp = this.belowAffecting(s), below = this.view.at(bp[0], bp[1], bp[2]);
        const jf = here && here.jumpFactor !== 1 ? here.jumpFactor : below ? below.jumpFactor : 1;
        const boost = s.effects.jumpBoost > 0 ? f(F.c01 * s.effects.jumpBoost) : 0;
        const p = f(f(f(s.attr.jumpStrength) * f(jf)) + boost);
        if (p <= F.c1em5) return;
        s.vy = this.feat.jumpKeepsUpwardSpeed ? Math.max(p, s.vy) : p;
        if (s.sprinting) {
            const r = f(s.yaw * M.DEG);
            s.vx += -M.sin(r, this.feat.mthDouble) * 0.2;
            s.vz += M.cos(r, this.feat.mthDouble) * 0.2;
        }
    }
}

function norm(v) { const d = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); return d < 1e-4 ? [0, 0, 0] : [v[0] / d, v[1] / d, v[2] / d]; }

module.exports = { Tick, fresh, boxOf, speedValue, HEIGHT, EYE, WIDTH };

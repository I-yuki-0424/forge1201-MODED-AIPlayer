'use strict';
// The native player physics behind prismarine-physics' interface (TASK-20261125-076): `simulatePlayer(state, world)` takes and returns mineflayer's PlayerState
// (pos, vel, onGround, control, yaw/pitch in mineflayer's radians, attributes, effects), so mineflayer's physics loop, the fall guard (src/build/fallguard.js,
// which wraps this very function) and the simulators in the tests run on it unchanged. What the game keeps between ticks and PlayerState does not carry
// (fall distance, pose, sprinting, swimming, eyes in water, the supporting block, being stuck in a cobweb) is kept here, per physics object (one per bot).
const { Tick, fresh } = require('./player');
const { dataVersionOf } = require('./versions');

const RAD = 180 / Math.PI;
const EFFECTS = ['jumpBoost', 'slowFalling', 'levitation', 'dolphinsGrace'];
const ATTRS = ['jumpStrength', 'gravity', 'stepHeight', 'sneakingSpeed', 'waterMovementEfficiency', 'movementEfficiency'];
const CARRY = ['fallDistance', 'pose', 'sprinting', 'swimming', 'eyeFluid', 'wasEyeInWater', 'fluidHeight', 'stuck', 'supporting', 'onGroundNoBlocks', 'minorHorizontalCollision', 'inPowderSnow'];

/** AttributeInstance.calculateValue of a mineflayer attribute entry ({value, modifiers: [{amount, operation}]}). */
function attrValue(e, def) {
    if (!e || typeof e.value !== 'number') return def;
    const mods = Array.isArray(e.modifiers) ? e.modifiers : [];
    let d = e.value; for (const m of mods) if (m.operation === 0) d += m.amount;
    let v = d; for (const m of mods) if (m.operation === 1) v += d * m.amount;
    for (const m of mods) if (m.operation === 2) v *= 1 + m.amount;
    return v;
}

/**
 * The native physics for a registry (prismarine-registry / minecraft-data of the connected version) or a version string.
 * opts.env(): the inputs PlayerState does not carry, read each tick: { food, usingItem, walksOnPowderSnow, ultraWarm, minY }.
 */
function Physics(registryOrVersion, opts = {}) {
    const md = typeof registryOrVersion === 'string' ? require('minecraft-data')(registryOrVersion) : registryOrVersion;
    const tick = new Tick(dataVersionOf(md), new Map());
    const res = (name) => (md.attributesByName && md.attributesByName[name] ? md.attributesByName[name].resource : null);
    const keys = Object.fromEntries(['movementSpeed', ...ATTRS].map((n) => [n, res(n)]));
    const carry = fresh();
    const env = typeof opts.env === 'function' ? opts.env : () => ({});

    function toNative(st) {
        const s = fresh();
        for (const k of CARRY) s[k] = carry[k];
        s.x = st.pos.x; s.y = st.pos.y; s.z = st.pos.z; s.vx = st.vel.x; s.vy = st.vel.y; s.vz = st.vel.z;
        s.yaw = Math.fround((Math.PI - st.yaw) * RAD); s.pitch = Math.fround(-st.pitch * RAD);
        s.onGround = !!st.onGround; s.wasTouchingWater = !!st.isInWater; s.horizontalCollision = !!st.isCollidedHorizontally;
        s.noJumpDelay = st.jumpTicks || 0;
        const c = st.control || {};
        s.keys = { forward: !!c.forward, back: !!c.back, left: !!c.left, right: !!c.right, jump: !!(c.jump || st.jumpQueued), sprint: !!c.sprint, sneak: !!c.sneak };
        const at = st.attributes || {};
        const ms = keys.movementSpeed && at[keys.movementSpeed];
        if (ms && typeof ms.value === 'number') { s.attr.movementSpeed = ms.value; s.speedModifiers = Array.isArray(ms.modifiers) ? ms.modifiers : []; }
        for (const n of ATTRS) if (keys[n]) s.attr[n] = attrValue(at[keys[n]], s.attr[n]);
        if (st.depthStrider > 0) s.attr.waterMovementEfficiency = Math.max(s.attr.waterMovementEfficiency, Math.min(3, st.depthStrider) / 3);
        for (const n of EFFECTS) s.effects[n] = st[n] || 0;
        Object.assign(s, env() || {});
        return s;
    }
    function fromNative(s, st) {
        for (const k of CARRY) carry[k] = s[k];
        st.pos.x = s.x; st.pos.y = s.y; st.pos.z = s.z; st.vel.x = s.vx; st.vel.y = s.vy; st.vel.z = s.vz;
        st.onGround = s.onGround; st.isInWater = s.wasTouchingWater; st.isInLava = tick.isInLava(s); st.isInWeb = false;
        st.isCollidedHorizontally = s.horizontalCollision; st.isCollidedVertically = s.verticalCollision;
        st.jumpTicks = s.noJumpDelay; st.jumpQueued = false; st.elytraFlying = false;
        st.sprinting = s.sprinting; st.pose = s.pose; st.fallDistance = s.fallDistance; st.swimming = s.swimming;
        return st;
    }
    return {
        native: true,
        dataVersion: tick.feat.dataVersion,
        features: tick.feat,
        carry,
        /** prismarine-physics' entry point: one tick of `state` (PlayerState) in `world` ({getBlock(Vec3)}); returns the same state. */
        simulatePlayer(state, world) { return fromNative(tick.step(toNative(state), world), state); },
        /** The native state API (vanilla units: yaw/pitch in degrees), for the trace replayer and the tests. */
        step(s, world) { return tick.step(s, world); },
        reset() { Object.assign(carry, fresh()); },
    };
}

/**
 * Put the native physics under a mineflayer bot: bot.physics.simulatePlayer is replaced (the physics loop, the position packets and the fall guard stay).
 * Call before src/build/fallguard.js installs (it wraps whatever simulatePlayer is there). `restore()` puts mineflayer's back (comparison runs).
 */
function install(bot) {
    if (!bot.physics || typeof bot.physics.simulatePlayer !== 'function') return null;
    if (bot.__nativePhysics) return bot.__nativePhysics;
    const orig = bot.physics.simulatePlayer;
    const ph = Physics(bot.registry, {
        env: () => {
            const feet = bot.inventory && bot.inventory.slots ? bot.inventory.slots[8] : null, dim = String((bot.game && bot.game.dimension) || '');
            return { food: typeof bot.food === 'number' ? bot.food : 20, usingItem: !!bot.usingHeldItem, walksOnPowderSnow: !!feet && feet.name === 'leather_boots', ultraWarm: /nether/.test(dim), minY: bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64 };
        },
    });
    bot.physics.simulatePlayer = ph.simulatePlayer;
    const h = { physics: ph, restore() { if (bot.physics.simulatePlayer === ph.simulatePlayer) bot.physics.simulatePlayer = orig; delete bot.__nativePhysics; } };
    bot.__nativePhysics = h;
    return h;
}

module.exports = { Physics, install, attrValue };

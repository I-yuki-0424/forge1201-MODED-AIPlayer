'use strict';
// Writes the GENERATED golden traces of tests/golden_native/ (TASK-20261125-076): prismarine-physics on cases where it is known right (flat stone, axis-aligned
// headings: no sine-table rounding), in the shared trace format (src/native/trace.js). They check the replayer and the format; the evidence for the
// physics are the server traces (source "carpet-fake-player") added in stage B next to them.
//   docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node scripts/native/make_golden.js
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const PP = require('prismarine-physics');
const { world } = require('../../tests/native_world');
const trace = require('../../src/native/trace');

const VERSION = '1.21.1';
const w = world(VERSION).floor(0, 'stone', 8);
const registry = w.registry;
const KEYS = trace.KEYS;
const bits = (k) => KEYS.map((n, i) => (k[n] ? 'FBLRJSN'[i] : '.')).join('');

function generate(name, yawDeg, plan) {
    const yaw = Math.PI - (yawDeg * Math.PI) / 180;                 // mineflayer radians of the vanilla yaw
    const st = { pos: new Vec3(0.5, 1, 0.5), vel: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
        elytraFlying: false, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, attributes: {}, yaw, pitch: 0, control: {}, jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0,
        slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false };
    const ph = PP.Physics(registry, w), lines = [];
    const size = [17, 2, 17], min = [-8, 0, -8], cells = [];
    for (let y = 0; y < size[1]; y++) for (let z = 0; z < size[2]; z++) for (let x = 0; x < size[0]; x++) cells.push(y === 0 ? 1 : 0);
    let t = 0;
    for (const [n, k] of plan) for (let i = 0; i < n; i++, t++) {
        st.control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, ...k };
        ph.simulatePlayer(st, w);
        lines.push({ k: 't', t, in: { keys: bits(st.control) }, yaw: yawDeg, pitch: 0, pos: [st.pos.x, st.pos.y, st.pos.z], vel: [st.vel.x, st.vel.y, st.vel.z], onGround: st.onGround });
    }
    const header = { format: 'forgeaip-trace', v: 1, mc: VERSION, dataVersion: registry.version.dataVersion, source: `generated:prismarine-physics ${require('prismarine-physics/package.json').version}, flat stone, heading ${yawDeg} (axis-aligned)`,
        player: 'gen', tol: 2e-5, region: { min, size, palette: ['minecraft:air', 'minecraft:stone'], cells }, start: { pos: [0.5, 1, 0.5], vel: [0, 0, 0], yaw: yawDeg, pitch: 0, onGround: true, pose: 'standing', fallDistance: 0 },
        player_state: { food: 20 } };
    const file = path.join(__dirname, '../../tests/golden_native', `${name}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, trace.format(header, lines));
    console.log(file, lines.length, 'ticks');
}

generate('gen_flat_walk_jump_west', 90, [[20, { forward: true }], [12, { forward: true, jump: true }], [10, {}]]);
generate('gen_flat_sprint_jump_south', 0, [[15, { forward: true, sprint: true }], [24, { forward: true, sprint: true, jump: true }], [10, { back: true }]]);
generate('gen_flat_sneak_strafe_east', 270, [[30, { left: true, sneak: true }], [20, { right: true, forward: true }]]);

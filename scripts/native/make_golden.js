'use strict';
// Writes the GENERATED golden traces of tests/golden_native/ (TASK-20261125-076): prismarine-physics on cases where it is known right (flat stone, axis-aligned
// headings: no sine-table rounding), in the shared trace format (078's world lines + the `tick` line, src/native/trace.js). They check the replayer and
// the format; the evidence for the physics are the server traces added next to them in stage B.
//   docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node scripts/native/make_golden.js
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const PP = require('prismarine-physics');
const { world } = require('../../tests/native_world');
const trace = require('../../src/native/trace');

const VERSION = '1.21.1', MIN_Y = 0, HEIGHT = 16;
const w = world(VERSION).floor(0, 'stone', 24);
const registry = w.registry;
const bits = (k) => ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak', 'attack', 'use'].map((n, i) => (k[n] ? 'FBLRJSNAU'[i] : '.')).join('');

function generate(name, yawDeg, plan) {
    const yaw = Math.PI - (yawDeg * Math.PI) / 180;                 // mineflayer radians of the vanilla yaw
    const st = { pos: new Vec3(0.5, 1, 0.5), vel: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
        elytraFlying: false, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, attributes: {}, yaw, pitch: 0, control: {}, jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0,
        slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false };
    const ph = PP.Physics(registry, w), ms0 = 1764000000000;
    const out = [{ t: 'hello', format: trace.FORMAT, recorder: `generated:prismarine-physics ${require('prismarine-physics/package.json').version} (scripts/native/make_golden.js), flat stone, heading ${yawDeg}`,
        bot: name, version: VERSION, minY: MIN_Y, height: HEIGHT, dim: 'overworld', difficulty: 'peaceful', gameMode: 'survival', world: null, run: null, speed: 1, ms: ms0 }];
    const ids = new Set();
    for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) {
        const cells = new Uint16Array(16 * 16 * HEIGHT);
        for (let y = MIN_Y; y < MIN_Y + HEIGHT; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
            const s = w.getBlock({ x: cx * 16 + x, y, z: cz * 16 + z }).stateId; cells[((y - MIN_Y) * 16 + z) * 16 + x] = s;
            if (!ids.has(s)) { ids.add(s); out.push({ t: 'st', id: s, n: registry.blocksByStateId[s].name, p: w.Block.fromStateId(s, 0).getProperties() }); }
        }
        out.push({ t: 'chunk', ms: ms0, tick: 0, cx, cz, minY: MIN_Y, height: HEIGHT, enc: 'u16le-deflate-b64', cells: trace.encodeCells(cells) });
    }
    const row = (t, k) => [t, 'gen', bits(k), st.pos.x, st.pos.y, st.pos.z, st.vel.x, st.vel.y, st.vel.z, yaw, 0, st.onGround ? 1 : 0, 0];
    out.push({ t: 'tick', ms: ms0, tick: 0, row: row(0, {}) });
    let t = 1;
    for (const [n, k] of plan) for (let i = 0; i < n; i++, t++) {
        st.control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, ...k };
        ph.simulatePlayer(st, w);
        out.push({ t: 'tick', ms: ms0 + 50 * t, tick: t, row: row(t, st.control) });
    }
    const file = path.join(__dirname, '../../tests/golden_native', `${name}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, trace.lines(out));
    console.log(file, t - 1, 'ticks');
}

generate('gen_flat_walk_jump_west', 90, [[20, { forward: true }], [12, { forward: true, jump: true }], [10, {}]]);
generate('gen_flat_sprint_jump_south', 0, [[15, { forward: true, sprint: true }], [24, { forward: true, sprint: true, jump: true }], [10, { back: true }]]);
generate('gen_flat_sneak_strafe_east', 270, [[30, { left: true, sneak: true }], [20, { right: true, forward: true }]]);

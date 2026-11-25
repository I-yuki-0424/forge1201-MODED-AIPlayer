'use strict';
// Replay every golden trace (tests/golden_native/*.jsonl, or the files given) through the native physics and print per trace: ticks, first tick off by
// more than 1e-5, the worst position error and where; with --rows NAME the per-tick rows of that trace (server vs native).
//   docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node scripts/native/replay_report.js [--rows srv_walk_east]
const fs = require('fs');
const path = require('path');
const trace = require('../../src/native/trace');

const dir = path.join(__dirname, '../../tests/golden_native');
const ri = process.argv.indexOf('--rows'), rowsOf = ri > 0 ? process.argv[ri + 1] : null;

/** The same trace through prismarine-physics (mineflayer's physics), for the comparison: worst position error and the first tick off by more than 1e-5. */
function replayPrismarine(tr) {
    const Vec3 = require('vec3'), PP = require('prismarine-physics');
    const reg = require('prismarine-registry')(tr.hello.version), w = trace.traceWorld(tr, reg), ph = PP.Physics(reg, w);
    const r0 = tr.ticks[0].row;
    const st = { pos: new Vec3(r0[3], r0[4], r0[5]), vel: new Vec3(r0[6], r0[7], r0[8]), onGround: !!r0[11], isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
        elytraFlying: false, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, attributes: {}, yaw: r0[9], pitch: r0[10], control: {}, jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false };
    let worst = 0, first = null;
    for (const tk of tr.ticks.slice(1)) {
        const r = tk.row; w.until(tk.tick);
        st.yaw = r[9]; st.pitch = r[10]; st.control = trace.keysOf(r[2]);
        try { ph.simulatePlayer(st, w); } catch (_) { return { worst: Infinity, first: tk.tick }; }
        const d = Math.hypot(st.pos.x - r[3], st.pos.y - r[4], st.pos.z - r[5]);
        if (d > worst) worst = d;
        if (first === null && d > 1e-5) first = tk.tick;
    }
    return { worst, first };
}

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const tr = trace.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const r = trace.replay(tr, { tol: 1e-5 }), p = replayPrismarine(tr);
    console.log(`${f.padEnd(36)} ticks ${String(r.ticks).padStart(3)}  native: firstOff ${String(r.firstOff).padStart(4)} worst ${r.worst.dpos.toExponential(2)}  | prismarine: firstOff ${String(p.first).padStart(4)} worst ${p.worst.toExponential(2)}`);
    if (rowsOf && f.startsWith(rowsOf)) {
        const srv = new Map(tr.ticks.map((t) => [t.tick, t.row]));
        for (const row of r.rows) {
            const s = srv.get(row.tick);
            console.log(`  t${String(row.tick).padStart(3)} ${s[2]} srv ${s.slice(3, 6).map((v) => v.toFixed(5)).join(' ')} v ${s.slice(6, 9).map((v) => v.toFixed(5)).join(' ')} g${s[11]} | nat ${row.pos.map((v) => v.toFixed(5)).join(' ')} g${row.onGround ? 1 : 0} d ${row.dpos.toExponential(1)}`);
        }
    }
}

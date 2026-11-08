'use strict';
// Which way out when a move or a dig fails (owner 2026-11-09: "it repeats the same movement over and over; against the same error doing the same again is pointless, so
// vary how it escapes"). The caller asks `pick(history, level, failure, now)`; the answer rotates through different fixes for the same kind of failure in the same
// place, so the second failure there does not get the jump again but the sidestep, the third a step back, then a pause, a server lift, the walk to the last good cell.
// Pure: the fixes themselves (key presses, walking) are in env.js.
const ORDER = Object.freeze(['jump', 'sidestep', 'return', 'back_off', 'wait', 'lift']);   // level 2/3/4 on a first failure = jump / sidestep / return, as before
const FORGET_MS = 120000, MAX_AREAS = 64;

/** The area a failure belongs to: its reason and the 3x3x3 block of the world the bot stands in. */
function areaKey(failure, pos) {
    const r = failure && failure.reason ? failure.reason : 'none';
    const c = (v) => Math.floor((Number(v) || 0) / 3);
    return `${r}@${c(pos && pos.x)},${c(pos && pos.y)},${c(pos && pos.z)}`;
}

/**
 * The fix to try now. `history` is a Map kept by the caller (one per bot); `level` is the strength the caller asks for (2 = the gentlest, as in env.recover).
 * Returns { fix, n } where n is how many times this failure has been seen here recently (0 = the first time).
 */
function pick(history, level, failure, pos, now = Date.now()) {
    const key = areaKey(failure, pos);
    let h = history.get(key);
    if (!h || now - h.t > FORGET_MS) h = { n: 0, t: now, dirs: [] };
    const fix = ORDER[(h.n + Math.min(2, Math.max(0, (level | 0) - 2))) % ORDER.length];      // a long streak asks for level 5, 6 ...: no stronger than 4
    h.n++; h.t = now;
    history.delete(key); history.set(key, h);                              // most recent last
    while (history.size > MAX_AREAS) history.delete(history.keys().next().value);
    return { fix, n: h.n - 1, h };
}

/** A direction not used yet here (cells [dx, dz]); all used = any, shuffled by `rnd`. */
function freshDirection(h, rnd = Math.random) {
    const all = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => rnd() - 0.5);
    const fresh = all.filter(([dx, dz]) => !h.dirs.some(([a, b]) => a === dx && b === dz));
    const d = (fresh.length ? fresh : all)[0];
    h.dirs.push(d); if (h.dirs.length > 8) h.dirs.shift();
    return d;
}

module.exports = { pick, areaKey, freshDirection, ORDER };

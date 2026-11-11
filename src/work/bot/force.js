'use strict';
// When a bot that does nothing is pushed (owner 2026-11-10): the decision, pure (the service carries it out: service/force.js).
//   fall   the bot has not moved for `stillMs` (30 s), finished no unit meanwhile and stands high (a block or nothing under it, free air below): the block under its feet is broken
//          (or it steps off the edge) and it falls; fall damage or death is accepted, a pile of bots on a pillar never moves otherwise.
//   kill   (a) the bot's units have failed for `errorMs` (60 s) without one success, or (b) a fall was forced and it still has not moved `stillMs` later: the server kills it, it respawns
//          and the supervisor puts it back to work. Without this a bot in an error loop never gets out of it.
// A bot that waits for the operator (a tool, an item), is in a line at a chest, idles for the next layer or is in a bed is not stuck: it has a reason to stand.
const STILL_MS = 30000, ERROR_MS = 60000, REPEAT_MS = 120000, BUSY_MS = 20000;
const WAITING = new Set(['idle', 'line', 'chest', 'bed', 'queued']);                  // activities / stretches in which standing still is the job
const NEEDS = new Set(['missing_item', 'missing_tool']);                              // a need, not an error: the scripts and the operator deal with it
const NOT_ERRORS = new Set(['cancelled', 'wrong_dimension']);                         // stopped from outside (an attack, a reflex, a dimension), not the unit's or the bot's fault

class Force {
    constructor({ stillMs = STILL_MS, errorMs = ERROR_MS, repeatMs = REPEAT_MS, busyMs = BUSY_MS, now = Date.now } = {}) { Object.assign(this, { stillMs, errorMs, repeatMs, busyMs, now }); this.bots = new Map(); }
    _s(name) { let s = this.bots.get(name); if (!s) { s = { born: this.now(), errSince: 0, lastOk: 0, fallAt: 0, lastForce: 0, errReason: null }; this.bots.set(name, s); } return s; }

    /** A unit result of `name` (the worker's event): the error clock starts at the first failure after a success and stops at the next success. */
    unit(name, ok, reason, now) {
        const s = this._s(name);
        if (ok || reason === 'died' || reason === 'disconnected') { s.errSince = 0; s.errReason = null; s.fallAt = 0; if (ok) s.lastOk = now; return; }
        if (NOT_ERRORS.has(reason) || NEEDS.has(reason)) return;
        if (!s.errSince) { s.errSince = now; s.errReason = reason || 'unknown'; }
    }
    /** The bot died or was removed: nothing carries over. */
    reset(name) { this.bots.delete(name); }

    /**
     * What to do with `name` now, or null. `v`: { working, act, sub, stillMs (how long it has not moved), busyMs (how long ago its last action-layer phase began; absent = unknown), high (can fall), now }.
     * Returns { action: 'fall' | 'kill', cause, stillMs, errorMs }.
     */
    decide(name, v) {
        const s = this._s(name), now = v.now;
        if (!v.working) return null;
        const errFor = s.errSince ? now - s.errSince : 0;
        if (errFor >= this.errorMs) return { action: 'kill', cause: `errors:${s.errReason}`, stillMs: v.stillMs || 0, errorMs: errFor };
        const waiting = WAITING.has(v.act) || WAITING.has(v.sub);
        // A bot whose action layer began a new phase within `busyMs` (dig, collect, bridge ... ) is working even if its feet do not move: digging blind from one station takes minutes (live copy of the
        // play world, 2026-11-11: 4 of 5 bot deaths were falls forced on working bots over the End void). Only a bot with no phase for that long counts as still.
        if (v.busyMs !== undefined && v.busyMs < this.busyMs) return null;
        const still = v.stillMs || 0, idleSinceOk = now - Math.max(s.lastOk, s.born);      // a bot first seen now (the console just started, the bot just respawned) has 30 s to show that it works
        if (waiting || still < this.stillMs || idleSinceOk < this.stillMs) return null;
        if (s.fallAt && now - s.fallAt >= this.stillMs) return { action: 'kill', cause: 'still_after_fall', stillMs: still, errorMs: errFor };
        if (v.high && !s.fallAt && !(s.lastForce && now - s.lastForce < this.repeatMs)) return { action: 'fall', cause: 'still', stillMs: still, errorMs: errFor };
        return null;
    }
    /** The service did it (a fall or a kill): the next push waits `repeatMs`; a fall starts the clock for the kill that follows if the bot stays put. */
    did(name, action, now) { const s = this._s(name); s.lastForce = now; if (action === 'fall') s.fallAt = now; else { s.errSince = 0; s.errReason = null; s.fallAt = 0; } }
}

/** Free air below the block the bot stands on (or below the feet when nothing is under them): is a fall of at least `min` blocks to be had? `kindAt(x, y, z)`, `f` the feet cell. */
function isHigh(kindAt, f, min = 2, limit = 40) {
    const under = kindAt(f.x, f.y - 1, f.z);
    let y = under === 'air' || under === 'climb' ? f.y : f.y - 1;             // nothing under the feet (standing on another bot): the fall starts at once
    let free = 0;
    for (let d = 1; d <= limit; d++) {
        const k = kindAt(f.x, y - d, f.z);
        if (k === 'unknown') return false;
        if (k !== 'air' && k !== 'climb') break;
        free++;
    }
    return free >= min;
}

/**
 * Nothing at all to land on within `limit` cells under the bot (the End's void, an abyss): a fall from here is death with no way back, not a push. The forced fall is never made there
 * (isHigh itself stays as it was: the descent logic of the pit and the recovery ladder use it for "there is air below to go down through").
 */
function isAbyss(kindAt, f, limit = 40) {
    const under = kindAt(f.x, f.y - 1, f.z);
    const y = under === 'air' || under === 'climb' ? f.y : f.y - 1;
    for (let d = 1; d <= limit; d++) { const k = kindAt(f.x, y - d, f.z); if (k === 'unknown') return false; if (k !== 'air' && k !== 'climb') return false; }
    return true;
}

module.exports = { Force, isHigh, isAbyss, STILL_MS, ERROR_MS, REPEAT_MS, BUSY_MS, WAITING, NEEDS, NOT_ERRORS };

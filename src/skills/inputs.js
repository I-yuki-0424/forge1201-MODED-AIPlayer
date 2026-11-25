'use strict';
// Player inputs outside a running command (TASK-20261125-076): the reflexes (work/bot/reflex.js), the forced fall (work/service/force.js) and the bed touch
// (work/bot/bed.js) act at once, without the runner's clock, but with the same body as every command (body.js: the use and attack buttons, against the
// crosshair or a named cell's face), instead of mineflayer's dig / placeBlock / activateBlock helpers. Each call waits for the server's answer as a block
// change seen in the world, never for its own prediction.
const { Body } = require('./body');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One physics tick of the bot (or `ms` when no tick comes: a bot whose physics is off). */
const tick = (bot, ms = 120) => new Promise((r) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); bot.removeListener('physicsTick', done); r(); } bot.once('physicsTick', done); });
// mineflayer's blockAt wants a Vec3
const V = (c) => new (require('vec3').Vec3)(c.x, c.y, c.z);
const sidAt = (bot, c) => { const b = bot.blockAt(V(c)); return b ? b.stateId : null; };
// the face numbers of body.js / the protocol: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east
const FACE_OF = { '0,-1,0': 0, '0,1,0': 1, '0,0,-1': 2, '0,0,1': 3, '-1,0,0': 4, '1,0,0': 5 };
const faceOf = (v) => FACE_OF[`${Math.sign(v.x)},${Math.sign(v.y)},${Math.sign(v.z)}`] ?? 1;

/** Press use once: against `cell`'s `face` (a vector {x,y,z} or a face number) when given, else at the crosshair. Returns the body (released). */
async function useOnce(bot, { cell = null, face = 1 } = {}) {
    const body = new Body(bot);
    const f = typeof face === 'number' ? face : faceOf(face);
    body.apply({ use: true, ...(cell ? { cell: { x: cell.x, y: cell.y, z: cell.z, face: f } } : {}) });
    await tick(bot);
    body.apply({});
    return body;
}

/**
 * Place the held block against `ref` (a block position) on the side `face` (a vector pointing from `ref` to the new cell, as mineflayer's placeBlock takes it).
 * Resolves true when the server put a block into the cell within `ms`.
 */
async function placeAgainst(bot, ref, face, ms = 250) {
    const cell = { x: ref.x + Math.sign(face.x), y: ref.y + Math.sign(face.y), z: ref.z + Math.sign(face.z) }, before = sidAt(bot, cell);
    await useOnce(bot, { cell: ref, face });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const now = sidAt(bot, cell); if (now !== null && now !== before) return true; await sleep(10); }
    return false;
}

/** Use (right-click) the block at `cell` through the crosshair the caller has aimed, or on its top face blind. Resolves after one tick. */
async function activateCell(bot, cell, { blind = false } = {}) { return useOnce(bot, blind ? { cell, face: 1 } : {}); }

/**
 * Break the block at `cell` (blind: the face toward the eye, the server checks reach only) with the held item, a tick of attack at a time, until the server
 * clears it or `maxMs` passes. Resolves { ok, ticks }.
 */
async function digCell(bot, cell, { face = 1, maxMs = 7000, cancelled = () => false } = {}) {
    const body = new Body(bot), before = sidAt(bot, cell), t0 = Date.now();
    let ticks = 0;
    try {
        while (Date.now() - t0 < maxMs && !cancelled()) {
            body.apply({ attack: true, cell: { x: cell.x, y: cell.y, z: cell.z, face } });
            await tick(bot); ticks++;
            const now = sidAt(bot, cell);
            if (now !== before) return { ok: true, ticks };
        }
        return { ok: false, ticks };
    } finally { body.release(); }
}

module.exports = { useOnce, placeAgainst, activateCell, digCell, faceOf, tick };

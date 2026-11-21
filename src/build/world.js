'use strict';
// Reading the world through a bot: a cell's state as {name, props (strings), shape}, the eye of a body, the distance from an eye to a cell's box.
const { Vec3 } = require('vec3');

const AIR_SEEN = Object.freeze({ name: 'air', props: Object.freeze({}), shape: 'empty' });
/** The state the bot sees at a cell: {name, props, shape} or null when the chunk is not loaded. */
function seen(bot, c) {
    const b = bot.blockAt(new Vec3(c.x, c.y, c.z), false);
    if (!b) return null;
    if (b.name === 'air') return AIR_SEEN;                      // most of a box: no property object to build
    const p = {}; for (const [k, v] of Object.entries(b.getProperties())) p[k] = String(v);
    return { name: b.name, props: p, shape: b.boundingBox };
}
/** Eye position of a standing body with its feet at `p` ({x, y, z}, the body's centre). */
const eyeOf = (p, sneak = false) => new Vec3(p.x, p.y + (sneak ? 1.27 : 1.62), p.z);
/** Distance from an eye to the nearest point of cell c's box. */
function boxDist(eye, c) {
    const dx = Math.max(c.x - eye.x, 0, eye.x - (c.x + 1)), dy = Math.max(c.y - eye.y, 0, eye.y - (c.y + 1)), dz = Math.max(c.z - eye.z, 0, eye.z - (c.z + 1));
    return Math.hypot(dx, dy, dz);
}
module.exports = { seen, eyeOf, boxDist, AIR_SEEN };

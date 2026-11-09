'use strict';
// The ground above a stuck bot: the standing cell on the level of the open ground around it, nearest to the bot. The stuck-escape expert was trained with the cell above the
// shaft or pocket it started in (the `sky` of the simulator's scan); a live bot stuck in a pit, a hole or a sealed pocket has no such cell given, so it is found here from the
// loaded chunks: the top of the columns in a ring around the bot (leaves and logs do not count, they are not ground), the middle one of them is the ground level, and the cell of
// that level nearest to the bot is the target. Pure: `w` is the skill world model (kindAt, nameAt).
const TREE = /(_leaves|_log|_wood|_stem|_wart_block|vine|^vine)$/;

/** The standing cell above the top of column (x, z), or null when the column is not loaded or has no ground within `from..to`. */
function columnTop(w, x, z, from, to) {
    for (let y = to; y >= from; y--) {
        const k = w.kindAt(x, y, z);
        if (k === 'unknown') return null;
        if (k === 'solid' && !TREE.test(String(w.nameAt(x, y, z) || '').replace(/^minecraft:/, ''))) return y + 1;
    }
    return null;
}

/** { x, y, z, level } or null. `cell`: the bot's feet cell; searched: columns 3..`radius` away (a 1-wide shaft or pocket has its rim there), from 4 below to 80 above the bot. */
function groundAbove(w, cell, { radius = 8, up = 80 } = {}) {
    const tops = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
        const d = Math.max(Math.abs(dx), Math.abs(dz));
        if (d < 3) continue;
        const y = columnTop(w, cell.x + dx, cell.z + dz, cell.y - 4, cell.y + up);
        if (y !== null) tops.push({ x: cell.x + dx, y, z: cell.z + dz, d: Math.hypot(dx, dz) });
    }
    if (!tops.length) return null;
    const ys = tops.map((t) => t.y).sort((a, b) => a - b), level = ys[Math.floor(ys.length / 2)];
    const here = tops.filter((t) => Math.abs(t.y - level) <= 1).sort((a, b) => a.d - b.d)[0];
    return here ? { x: here.x, y: here.y, z: here.z, level } : null;
}

module.exports = { groundAbove, columnTop };

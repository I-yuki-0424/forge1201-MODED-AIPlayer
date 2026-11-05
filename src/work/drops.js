'use strict';
// Dropped items near a point, for the sweep's single pick-up round (pit.js sweepDrops): [{id, name, count, dist}], nearest first.
function items(bot, near, r = 7) {
    const out = [];
    for (const e of Object.values(bot.entities)) {
        if (!e || e.name !== 'item' || !e.getDroppedItem || !e.position) continue;
        const d = Math.hypot(e.position.x - near.x, e.position.y - near.y, e.position.z - near.z);
        if (d > r) continue;
        const it = e.getDroppedItem();
        if (it) out.push({ id: e.id, name: it.name, count: it.count || 1, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
}
module.exports = { items };

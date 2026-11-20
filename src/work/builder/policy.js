'use strict';
// The ORDER EXPERT (TASK-20261121-071; owner 2026-11-21: "design an expert for blueprint construction: optimise the work order, minimise temporary blocks and build time"). The order of placement
// (order.js) picks, at every step, the candidate cell with the lowest SCORE; the score is linear in a few features of the cell and the weights are LEARNED (scripts/work/train_order.js, an evolution
// strategy against the cost model in costsim.js: bot time + temporary blocks). Without weights the planner keeps its fixed rule (the lowest cell first, then the nearest). Nothing here touches a bot.
//   BUILD_ORDER_MODEL=/path/model.json   (or models/experts/build_order.json with BUILD_ORDER=expert)   -> { weights: [...] } is used by every plan made in the process.
const fs = require('fs'), path = require('path');

const NAMES = ['height', 'dist', 'dy', 'unlocks', 'supports', 'attached', 'centre', 'level'];
/** The rule of the planner as weights: a level is worth 8 horizontal blocks, the nearest next; the rest 0. */
const DEFAULT = [8, 1, 0, 0, 0, 0, 0, 0];

/** Features of candidate `c` (all roughly 0..10). `x`: { last (the last cell placed in its area or null), centre {x, z}, low (the lowest candidate y of the area), sup (support direction), unlocks, attached }. */
function features(c, x) {
    const l = x.last || { ...x.centre, y: c.y };
    return [
        c.y - x.low,                                                              // levels above the lowest candidate: climbing early costs temporary blocks
        Math.hypot(c.x - l.x, c.z - l.z) / 2,                                     // the walk from the last cell placed
        Math.abs(c.y - l.y),                                                      // a change of level
        Math.min(8, x.unlocks || 0),                                              // cells that wait for this one
        x.sup ? 0 : 1,                                                            // no support yet (a seed-like piece)
        x.attached ? 1 : 0,                                                       // a torch, a wire, a repeater ...: after the blocks around it
        Math.hypot(c.x - x.centre.x, c.z - x.centre.z) / 4,                       // the distance from the middle of the area
        (c.y - x.low) ** 2 / 4,                                                   // a steep climb counts more
    ];
}
const score = (w, f) => { let s = 0; for (let i = 0; i < f.length; i++) s += (w[i] || 0) * f[i]; return s; };

/** The weights named by the environment (BUILD_ORDER_MODEL, or BUILD_ORDER=expert for the repo's model), or null: the fixed rule. */
let cached;
function fromEnv() {
    if (cached !== undefined) return cached;
    cached = null;
    const f = process.env.BUILD_ORDER_MODEL || (process.env.BUILD_ORDER === 'expert' ? path.join(__dirname, '../../../models/experts/build_order.json') : '');
    if (f) { try { const m = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(m.weights) && m.weights.every(Number.isFinite)) cached = m.weights; } catch (_) { cached = null; } }
    return cached;
}

module.exports = { NAMES, DEFAULT, features, score, fromEnv };

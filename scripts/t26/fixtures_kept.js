'use strict';
// mine_b's grader (orchestrator ruling 2026-11-28): a block the bots must not break is not "dirty". The cells of a dirty layer that `mine` refuses by rule (skills/commands/block.js
// refusal(): a box or bed no bot placed, a tagged block, outside a pit worker's work area) are listed as "fixtures kept"; a layer whose only non-air cells are such fixtures is clean.
// Pure: `nameAt(x, y, z)` -> block name or null (unloaded), `refuse(cell, name)` -> truthy when mine refuses it. Returns { dirty: [y...], fixtures: [[x, y, z, name]...] }.
const OPEN = /^(air|cave_air|void_air)$/;
function fixturesKept(layers, box, nameAt, refuse) {
    const dirty = [], fixtures = [];
    for (const y of layers) {
        let other = false; const here = [];
        for (let x = box.x0; x <= box.x1 && !other; x++) for (let z = box.z0; z <= box.z1; z++) {
            const n = nameAt(x, y, z);
            if (n === null || n === undefined) { other = true; break; }          // not loaded: no judgement, the layer stays dirty
            const b = String(n).replace(/^minecraft:/, '');
            if (OPEN.test(b)) continue;
            if (refuse({ x, y, z }, b)) here.push([x, y, z, b]); else { other = true; break; }
        }
        if (other) dirty.push(y); else fixtures.push(...here);
    }
    return { dirty, fixtures };
}
module.exports = { fixturesKept };

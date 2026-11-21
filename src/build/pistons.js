'use strict';
// A piston in the other phase than the blueprint's: the same build, another moment of its machine. The blueprint is a snapshot (iron-farm-34 was saved while its pistons moved);
// the built machine runs its own circuit and may rest with a piston extended where the snapshot has it retracted, or the reverse. Then the cells in front of the piston hold what
// the push or the pull makes of the blueprint's cells: the builder must not "repair" them (it would fight the circuit for ever: live 2026-11-21 run o2, 12 pistons and their stones
// were placed, pushed and cleared in a loop) and the judge counts them apart from wrong cells. Pure.
const S = require('./state');

const VEC = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const PUSH_LIMIT = 12;
const IMMOVABLE = /^(obsidian|crying_obsidian|bedrock|barrier|end_portal_frame|enchanting_table|ender_chest|respawn_anchor|reinforced_deepslate|nether_portal|end_portal|end_gateway|.*chest|barrel|.*shulker_box|hopper|dropper|dispenser|furnace|blast_furnace|smoker|beacon|brewing_stand|jukebox|lectern|spawner|.*_sign|.*_banner|piston_head|moving_piston)$/;
const AIR = (st) => !st || S.AIR.has(S.bare(st.name));

/** Pistons of the target: [{ i, at, f: [dx,dy,dz], sticky, extended }]. */
function pistonsOf(target) {
    const out = [];
    for (let i = 0; i < target.n; i++) {
        if (target.isAir(i)) continue;
        const st = target.stateOf(i), n = S.bare(st.name);
        if (n !== 'piston' && n !== 'sticky_piston') continue;
        out.push({ i, at: target.cell(i), f: VEC[st.props.facing], sticky: n === 'sticky_piston', extended: st.props.extended === 'true' });
    }
    return out;
}

/**
 * The cells in front of piston `p` as the other phase leaves them: [{ x, y, z, state }] (state null = air). Extended in the blueprint, the other phase is retracted: a sticky piston
 * pulls the block in front of its head back, a plain one leaves it. Retracted in the blueprint, the other phase is extended: the row of blocks in front moves one cell on (up to 12,
 * up to the first air), the head takes the first cell. Null when the other phase is impossible (an immovable block, a row too long).
 */
function otherPhase(target, p) {
    const at = (k) => ({ x: p.at.x + p.f[0] * k, y: p.at.y + p.f[1] * k, z: p.at.z + p.f[2] * k });
    const T = (k) => { const c = at(k); return target.at(c.x, c.y, c.z); };
    const head = { name: 'piston_head', props: { facing: target.stateOf(p.i).props.facing, type: p.sticky ? 'sticky' : 'normal', short: 'false' } };
    if (p.extended) {
        const b = T(2);
        const pulled = p.sticky && b && !AIR(b) && !IMMOVABLE.test(S.bare(b.name));
        return [{ ...at(1), state: pulled ? b : null }, { ...at(2), state: pulled ? null : (AIR(b) ? null : b) }];
    }
    const row = [];
    for (let k = 1; k <= PUSH_LIMIT + 1; k++) {
        const s = T(k);
        if (!s) return null;                                           // the row runs out of the box: not judged
        if (AIR(s)) { row.push(k); break; }
        if (IMMOVABLE.test(S.bare(s.name))) return null;
        row.push(k);
        if (k === PUSH_LIMIT + 1) return null;
    }
    const out = [{ ...at(1), state: head }];
    for (let j = 1; j < row.length; j++) out.push({ ...at(row[j]), state: T(row[j] - 1) });
    return out;
}

/** Does the world (`have(x, y, z)` -> {name, props} | null) hold piston p in the other phase, with the cells in front as that phase leaves them? Returns the cells, or null. */
function inOtherPhase(target, p, have) {
    const h = have(p.at.x, p.at.y, p.at.z);
    if (!h || S.bare(h.name) !== S.bare(target.stateOf(p.i).name)) return null;
    const ext = String(h.props.extended) === 'true';
    if (ext === p.extended) return null;
    const cells = otherPhase(target, p);
    if (!cells) return null;
    for (const c of cells) {
        const w = have(c.x, c.y, c.z);
        if (!w) return null;
        if (!c.state) { if (!S.AIR.has(S.bare(w.name)) && S.bare(w.name) !== 'moving_piston') return null; continue; }
        if (S.bare(c.state.name) === 'piston_head') { if (S.bare(w.name) !== 'piston_head' && S.bare(w.name) !== 'moving_piston') return null; continue; }
        if (!S.matches(c.state, w)) return null;
    }
    return cells;
}

module.exports = { pistonsOf, otherPhase, inOtherPhase, PUSH_LIMIT };

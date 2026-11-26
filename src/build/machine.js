'use strict';
// Machines of a blueprint built safely (TASK-20261125-081, orchestrator 2026-11-27): a machine must not run while it is being built. In b081m (Fabric 1.21.1, iron-farm-34) its
// pistons moved blocks of the build mid-build: a lit redstone torch or a redstone block placed as soon as its support stood powered the part of the circuit already built.
//
// The order rule (job.ready): a power source (redstone block, redstone torch, a lever that is on) is placed only when every other block of its machine stands, so every piston is
// placed while nothing powers it and gets its power once, from the finished circuit. An observer is placed only when the cell it watches is final (it pulses when that cell
// changes). A machine is a group of redstone parts within two cells of each other (a torch powers the block over it, which powers a wire beside it), with the cells a piston of it
// can push (twelve in front) and a margin of one.
//
// The watch (attach): a piston of the build that extends or retracts and a cell that turns into moving_piston are counted (stats.pistonFires, stats.machineMoved) with what
// powered it (the lit and powered parts within two cells) in the log. The target is zero.
const S = require('./state');

const PART = /^(redstone_wire|redstone_torch|redstone_wall_torch|redstone_block|repeater|comparator|piston|sticky_piston|piston_head|observer|lever|.*_button|.*_pressure_plate|daylight_detector|target|tripwire_hook|hopper|dropper|dispenser|note_block|redstone_lamp|lectern|trapped_chest|detector_rail|powered_rail|activator_rail|sculk_sensor|calibrated_sculk_sensor)$/;
const SOURCE = /^(redstone_torch|redstone_wall_torch|redstone_block)$/;
const FACE = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };

/** Is the wanted state w a power source (a lever that is on counts; one that is off does nothing until it is pulled)? */
function isSource(w) { const n = S.bare(w.name); return SOURCE.test(n) || (n === 'lever' && String((w.props || {}).powered) === 'true'); }

/**
 * The machines of target t: Map cell index -> machine { id, cells: [indices of its region's non-air cells that are not sources] } for every source and observer, plus
 * `watch` (observer index -> the index of the cell it watches). Computed once.
 */
function machines(t) {
    if (t._machines) return t._machines;
    const b = t.box, parts = [];
    for (let i = 0; i < t.n; i++) { if (t.isAir(i)) continue; const w = t.stateOf(i); if (w && PART.test(S.bare(w.name))) parts.push(i); }
    const isPart = new Set(parts), group = new Map();
    let g = 0;
    for (const p of parts) {
        if (group.has(p)) continue;
        const q = [p]; group.set(p, g);
        for (let k = 0; k < q.length; k++) {
            const c = t.cell(q[k]);
            for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
                const x = c.x + dx, y = c.y + dy, z = c.z + dz; if (!t.inside(x, y, z)) continue;
                const j = t.idx(x, y, z); if (isPart.has(j) && !group.has(j)) { group.set(j, g); q.push(j); }
            }
        }
        g++;
    }
    // each group's region: its parts' bounding box with a margin of one, and what its pistons can push
    const box = new Map();
    const grow = (id, x, y, z) => { const r = box.get(id) || { x0: x, x1: x, y0: y, y1: y, z0: z, z1: z }; r.x0 = Math.min(r.x0, x); r.x1 = Math.max(r.x1, x); r.y0 = Math.min(r.y0, y); r.y1 = Math.max(r.y1, y); r.z0 = Math.min(r.z0, z); r.z1 = Math.max(r.z1, z); box.set(id, r); };
    for (const p of parts) {
        const c = t.cell(p), id = group.get(p), w = t.stateOf(p);
        grow(id, c.x - 1, c.y - 1, c.z - 1); grow(id, c.x + 1, c.y + 1, c.z + 1);
        if (/piston$/.test(S.bare(w.name)) && FACE[w.props.facing]) { const d = FACE[w.props.facing]; grow(id, c.x + d[0] * 13, c.y + d[1] * 13, c.z + d[2] * 13); }
    }
    const byGroup = new Map(), out = new Map(), watch = new Map();
    const cellsOf = (id) => {
        if (byGroup.has(id)) return byGroup.get(id);
        const r = box.get(id), l = [];
        for (let y = Math.max(r.y0, b.y); y <= Math.min(r.y1, b.y + b.sy - 1); y++) for (let z = Math.max(r.z0, b.z); z <= Math.min(r.z1, b.z + b.sz - 1); z++) for (let x = Math.max(r.x0, b.x); x <= Math.min(r.x1, b.x + b.sx - 1); x++) {
            const j = t.idx(x, y, z); if (t.isAir(j)) continue; const w = t.stateOf(j); if (w && !isSource(w)) l.push(j);
        }
        const m = { id, cells: l }; byGroup.set(id, m); return m;
    };
    for (const p of parts) {
        const w = t.stateOf(p), n = S.bare(w.name);
        if (isSource(w)) out.set(p, cellsOf(group.get(p)));
        if (n === 'observer' && FACE[w.props.facing]) { const c = t.cell(p), d = FACE[w.props.facing]; if (t.inside(c.x + d[0], c.y + d[1], c.z + d[2])) watch.set(p, t.idx(c.x + d[0], c.y + d[1], c.z + d[2])); }
    }
    t._machines = { gate: out, watch, groups: g };
    return t._machines;
}

/**
 * Why task tk (a place or fix of cell tk.i) waits for its machine, or null: a source while a block of its machine is still to place, an observer while the cell it watches is.
 * `open(i)`: is cell i still to place (a task of the job, not parked). Cached per machine for 5 s.
 */
function waits(t, tk, open, now = Date.now()) {
    if (tk.i < 0) return null;
    const M = machines(t), m = M.gate.get(tk.i);
    if (m) {
        if (!m.at || now - m.at > 5000) { m.at = now; m.left = m.cells.some(open); }
        if (m.left) return 'a power source: placed when its machine stands';
    }
    const wi = M.watch.get(tk.i);
    if (wi !== undefined && open(wi)) return 'an observer: placed when the cell it watches stands';
    return null;
}

/** Count the build's pistons that fire and the cells they move (b081m: three cells of piston columns moved mid-build), with what powered them, for the progress line. */
function attach(job, bot, log) {
    const t = job.t;
    const onBlock = (o, n) => {
        try {
            if (!n || !n.position) return;
            const { x, y, z } = n.position; if (!t.inside(x, y, z)) return;
            const k = `${x},${y},${z}`, nn = String(n.name || ''), on = o ? String(o.name || '') : '';
            const seen = job._machineSeen || (job._machineSeen = new Map()), at = Date.now();
            let what = null;
            if (nn === 'moving_piston' && on !== 'moving_piston') what = 'moved';
            else if (/piston$/.test(nn) && on === nn) { const a = o.getProperties ? String(o.getProperties().extended) : null, b = n.getProperties ? String(n.getProperties().extended) : null; if (a !== null && b !== null && a !== b) what = b === 'true' ? 'extended' : 'retracted'; }
            if (!what) return;
            const sk = `${k} ${what}`; if (at - (seen.get(sk) || 0) < 1000) return;          // every bot near it sees the same update
            seen.set(sk, at); if (seen.size > 5000) seen.clear();
            // before any power source of the build stands (the machine is still being built: the target is zero) or after (the finished machine running, as designed)
            const M = machines(t), powered = [...M.gate.keys()].some((i) => { const c = t.cell(i), q = bot.blockAt(n.position.offset(c.x - x, c.y - y, c.z - z), false); return !!q && S.bare(q.name) === S.bare(t.stateOf(i).name); });
            const st = job.stats.machine || (job.stats.machine = { moved: 0, fires: 0, movedPowered: 0, firesPowered: 0 });
            if (what === 'moved') st[powered ? 'movedPowered' : 'moved']++; else st[powered ? 'firesPowered' : 'fires']++;
            job.stats.machineMoved = st.moved;
            if ((job._machineLog = (job._machineLog || 0) + 1) > 40) return;
            // what could have powered it: the lit or powered parts within two cells as the bot sees them now
            const near = [];
            for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
                const q = bot.blockAt(n.position.offset(dx, dy, dz), false); if (!q || !PART.test(q.name) || /piston/.test(q.name)) continue;
                const p = q.getProperties ? q.getProperties() : {}; const live = SOURCE.test(q.name) ? String(p.lit) !== 'false' : String(p.powered) === 'true' || Number(p.power) > 0 || String(p.lit) === 'true';
                if (live) near.push(`${q.name.replace('minecraft:', '')}${p.power !== undefined ? `(${p.power})` : ''} ${dx},${dy},${dz}`);
            }
            log(`[machine] ${what} at ${k} (was ${on || '?'}; ${powered ? 'a power source of the build stands' : 'mid-build: no power source of the build placed yet'}); powered near it: ${near.slice(0, 8).join(', ') || 'nothing seen'}`);
        } catch (_) { /* counting never breaks the drive */ }
    };
    bot.on('blockUpdate', onBlock);
    return () => bot.removeListener('blockUpdate', onBlock);
}

module.exports = { machines, waits, attach, isSource, PART, SOURCE };

'use strict';
// Routes across dimensions (owner 2026-11-08, B1): walking through a portal is not a special command, it follows from the coordinates: a target in another
// dimension is reached through the nearest gate that leads there; with `viaNether` a long walk in the overworld may be shortened by the Nether (1 block there = 8 here).
// Gates are tagged blocks (sites.js purpose `portal`, `dim`, `twin`): the operator says which portal block is where and which gate it leads to. Pure planning; the
// walking is travel.js, the crossing is `env.cross` (env.js). Experimental by the owner's wish: many problems are expected.
const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const SCALE = 8;                          // Nether blocks per overworld block, the other way round

// Where a gate leads: the dimension of its twin, or (no twin: an End portal has no twin to tag, the way back is another place) the dimension it says it `leads` to.
const leadsTo = (sites, g) => (g.twin && sites.get(g.twin) ? (sites.get(g.twin).dim || 'overworld') : g.leads || null);
const gates = (sites, dim) => sites.list().filter((s) => s.purpose === 'portal' && (s.dim || 'overworld') === dim && leadsTo(sites, s));

/** The gate of `dim` nearest to `p` that leads to `toDim` (its twin is there, or it says so), or null. */
function gateTo(sites, dim, toDim, p) {
    return gates(sites, dim).filter((g) => leadsTo(sites, g) === toDim).sort((a, b) => hd(a, p) - hd(b, p))[0] || null;
}

/**
 * The steps from `from` {dim, x, y, z} to `to` {dim, x, y?, z}: [{walk: {dim, x, y?, z}}, {cross: gateName}, ...]. Same dimension = one walk, or (viaNether, overworld, far)
 * a walk to a gate, the Nether stretch, and the walk from the exit gate. Null when no gate leads where it must (the caller says so). The cost of the Nether way is its
 * walking: the overworld part plus the Nether part counted at the scale, and it is only taken when it is clearly shorter.
 */
function plan(sites, from, to, { viaNether = false } = {}) {
    const steps = [];
    if (from.dim === to.dim) {
        if (viaNether && from.dim === 'overworld') {
            const a = gateTo(sites, 'overworld', 'nether', from);
            if (a && a.twin && sites.get(a.twin)) {
                const aTwin = sites.get(a.twin);
                // The gate in the Nether nearest to the destination (scaled) that leads back to the overworld.
                const b = gateTo(sites, 'nether', 'overworld', { x: to.x / SCALE, z: to.z / SCALE });
                if (b && b.twin && sites.get(b.twin)) {
                    const bTwin = sites.get(b.twin), direct = hd(from, to);
                    const cost = hd(from, a) + hd(aTwin, b) + hd(bTwin, to);        // every block is walked one by one, in the Nether too: the saving is that a Nether block is 8 here
                    if (cost < 0.7 * direct) return [{ walk: { dim: 'overworld', x: a.x, y: a.y, z: a.z, gate: true } }, { cross: a.name }, { walk: { dim: 'nether', x: b.x, y: b.y, z: b.z, gate: true } }, { cross: b.name }, { walk: { dim: 'overworld', x: to.x, y: to.y, z: to.z } }];
                }
            }
        }
        return [{ walk: { dim: to.dim, x: to.x, y: to.y, z: to.z } }];
    }
    const g = gateTo(sites, from.dim, to.dim, from);
    if (!g) return null;
    steps.push({ walk: { dim: from.dim, x: g.x, y: g.y, z: g.z, gate: true } }, { cross: g.name }, { walk: { dim: to.dim, x: to.x, y: to.y, z: to.z } });
    return steps;
}

module.exports = { plan, gateTo, gates, SCALE };

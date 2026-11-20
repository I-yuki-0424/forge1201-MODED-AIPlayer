'use strict';
// A cost model of a build, for the order expert (TASK-20261121-071, owner: "optimise the work order: fewer temporary blocks, shorter build time"). It walks a PLAN with the same station chooser the live
// builder uses (stations.js), on a virtual world, and adds up the bot time (tenths of a second, the cost model of chooseStation: a placement 12, a move 20 + 2.5 per block + 5 per level, a pillar 40 +
// 26 per level or a bridge 45 + 20 per block) and the temporary blocks (a pillar climb: one per level; a bridge: one per block; a seed's support: one). Pure; no bot, no server.
const S = require('./stations');
const R = require('./run');
const key = (x, y, z) => `${x},${y},${z}`;
const THIN = /(torch|sign|redstone_wire|repeater|comparator|nether_portal|soul_fire|rail)$/, PART = /(stairs|trapdoor|hopper|chest|bed|piston|composter|fence_gate|wall|slab)$/;

/** A virtual world: ground below `deckY`, blocks placed by the simulation. */
function world(deckY) {
    const m = new Map(), wl = new Set();
    const get = (x, y, z) => m.get(key(x, y, z)) || (y <= deckY ? { name: 'stone', props: {} } : { name: 'air', props: {} });
    return {
        set: (x, y, z, name, props = {}) => m.set(key(x, y, z), { name, props }), waterlog: (x, y, z) => wl.add(key(x, y, z)),
        nameAt: (x, y, z) => get(x, y, z).name,
        kindAt: (x, y, z) => { const n = get(x, y, z).name; return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'lava' ? 'danger' : THIN.test(n) ? 'air' : PART.test(n) ? 'partial' : 'solid'; },
        blockAt: (x, y, z) => { const b = get(x, y, z); return { name: b.name, getProperties: () => ({ ...b.props, level: '0', ...(wl.has(key(x, y, z)) ? { waterlogged: 'true' } : {}) }) }; },
    };
}

/**
 * Walk the plan (every area by one simulated bot, one after the other: the time of the slowest area is `span`, the sum is `time`). Returns { time, span, temps, stations, placed, failed, climb, seeds }.
 * `zonesOnly`: simulate only these areas (a cheaper proxy). The cost is deterministic.
 */
function simulate(plan, { zonesOnly = null, maxPass = 8 } = {}) {
    const o = plan.origin, w = world(o.y - 1), view = S.viewOf(w, plan.cellSet);
    const res = { time: 0, span: 0, temps: 0, stations: 0, placed: 0, failed: 0, climb: 0, seeds: plan.list.filter((c) => c.seed).length, perZone: [] };
    for (let z = 0; z < plan.zones.n; z++) {
        if (zonesOnly && !zonesOnly.includes(z)) continue;
        const [a, b] = plan.zones.units[z]; let feet = { x: o.x, y: o.y, z: o.z - 4 }, t = 0;
        for (let pass = 0; pass < maxPass; pass++) {
            let progress = 0;
            for (let u = a; u < b; u++) {
                const unit = plan.units[u];
                for (let round = 0; round < 12; round++) {
                    const ready = unit.filter((c) => !R.right(c, w) && R.cellReady(plan, c, w));
                    if (!ready.length) break;
                    const todo = unit.filter((c) => !R.right(c, w)), s = S.chooseStation(view, todo, { from: feet, skip: new Set(), ok: (c, local) => R.readyLocal(plan, c, w, local) });
                    if (!s) { if (pass === maxPass - 1) res.failed++; break; }
                    const flat = Math.abs(s.S.x - feet.x) + Math.abs(s.S.z - feet.z), dy = Math.abs(s.S.y - feet.y), here = flat + dy === 0;
                    if (!here) {
                        if (s.kind === 'native') t += 20 + 2.5 * flat + 5 * dy;
                        else { const lv = Math.max(0, s.S.y - 1 - s.base.y), climb = 40 + 26 * lv + flat, br = s.bridge ? 45 + 20 * s.bridge.g + flat : Infinity; if (br < climb) { t += br; res.temps += s.bridge.g; } else { t += climb; res.temps += lv + 1; res.climb += lv; } }
                    } else if (s.kind === 'pillar') res.temps += 1;
                    t += 12 * s.serves.length; res.stations++; res.placed += s.serves.length; progress += s.serves.length;
                    for (const sv of s.serves) {
                        if (sv.temp) { res.temps++; t += 24; }                                         // a support beside the cell: placed, then mined again
                        const c = sv.cell;
                        if (c.waterlog) w.waterlog(c.x, c.y, c.z); else { const pr = { ...c.props }; delete pr.waterlogged; w.set(c.x, c.y, c.z, c.block, pr); }
                    }
                    feet = s.S;
                }
            }
            if (!progress) break;
        }
        res.perZone.push(Math.round(t)); res.time += t; res.span = Math.max(res.span, t);
    }
    return res;
}

module.exports = { simulate, world };

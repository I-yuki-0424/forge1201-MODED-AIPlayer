'use strict';
// The difference between the box and its target, read from a bot's view of the world, as work: what has to be sealed (a fluid outside the box next to it), filled (a fluid inside
// that must go), cleared (a block that must go), placed, clicked (a note, a delay: the block is right, a click-set property is not), poured or lit. Pure apart from the reads.
const S = require('./state');
const { seen } = require('./act');
const P = require('./pistons');

// Blocks a placement replaces by itself (vanilla canBeReplaced), apart from fluids.
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|vine|glow_lichen|snow|seagrass|tall_seagrass|crimson_roots|warped_roots|nether_sprouts|hanging_roots|fire|soul_fire|light|structure_void|leaf_litter|resin_clump|sculk_vein)$/;
const FLUID = (s) => s && (s.name === 'water' || s.name === 'lava' || s.name === 'bubble_column' || s.props.waterlogged === 'true' && false);
// A plant that holds water (breaking it leaves a source): treated as water.
const WATERY = /^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/;
const CLICKS = { note: 25, delay: 4 };

/**
 * How many clicks turn `have` into `want` when the block is the same and only properties that a click sets differ; null when a click cannot do it.
 */
function clicksFor(want, have) {
    const n = S.bare(want.name);
    if (n !== S.bare(have.name)) return null;
    const wp = S.decidedProps(n, want.props), hp = S.props(have.props);
    let clicks = 0, look = null;
    for (const [k, v] of Object.entries(wp)) {
        if (hp[k] === undefined || hp[k] === v) continue;
        if (k === 'note') clicks += (Number(v) - Number(hp[k]) + 25) % 25;
        else if (k === 'delay') clicks += (Number(v) - Number(hp[k]) + 4) % 4;
        else if (k === 'mode' && n === 'comparator') clicks += 1;
        else if (k === 'open' && !/^iron_/.test(n) && /(_trapdoor|_door|_fence_gate)$/.test(n)) { clicks += 1; if (/_fence_gate$/.test(n)) look = { h: wp.facing }; }
        else if (k === 'powered' && n === 'lever') clicks += 1;
        else if (k === 'inverted' && n === 'daylight_detector') clicks += 1;
        else return null;
    }
    return clicks ? { clicks, look } : null;
}

/**
 * Survey the box with `bot`'s view. Returns { tasks: [{k, kind, i, x, y, z, ...}], unknown, right, dynamic } where kind is
 *   seal  a fluid outside the box next to it (blocked with the seal block)        fill   a fluid inside that must go (a block first, cleared later)
 *   clear a block that must go (then the cell is air or gets its block)           place  the cell's recipe (a wrong block there is broken first)
 *   fix   clicks on a block that is right apart from a click-set property         pour / ignite   late work (fluids, fire and portals)
 */
function survey(target, bot, { lit = new Set() } = {}) {
    const b = target.box, tasks = [];
    let unknown = 0, right = 0, dynamic = 0;
    const fluidAt = new Uint8Array(target.n);
    const have = new Array(target.n);
    for (let i = 0; i < target.n; i++) {
        const c = target.cell(i), h = seen(bot, c);
        have[i] = h;
        if (!h) { unknown++; continue; }
        if (h.name === 'water' || h.name === 'lava' || WATERY.test(h.name)) fluidAt[i] = 1;
    }
    const portalCells = new Map(); for (const p of target.portals) for (const i of p.cells) portalCells.set(i, p);
    // a piston the world holds in the other phase than the blueprint's (its machine rests elsewhere): the cells in front are built as that phase leaves them (pistons.js)
    const over = new Map(), kept = []; let phased = 0;
    for (const p of target.pistons) {
        const h = have[p.i]; if (!h || S.bare(h.name) !== S.bare(target.stateOf(p.i).name)) continue;
        if ((String(h.props.extended) === 'true') === p.extended) continue;
        const cells = P.otherPhase(target, p); if (!cells) continue;
        phased++;
        for (const c of cells) if (target.inside(c.x, c.y, c.z)) over.set(target.idx(c.x, c.y, c.z), c.state || { name: 'air', props: {} });
    }
    for (let i = 0; i < target.n; i++) {
        const h = have[i]; if (!h) continue;
        const want = over.has(i) ? over.get(i) : target.stateOf(i), c = target.cell(i), wn = S.bare(want.name);
        if (fluidAt[i] && S.FLUIDS.has(wn) && wn === h.name) kept.push({ k: `${c.x},${c.y},${c.z}`, i, ...c, kind: 'fill' });     // a fluid where the blueprint has one: kept only when no block is left to place (job.js)
        if (S.matches(want, h)) { right++; continue; }
        if (S.dynamicPair(want, h)) { dynamic++; continue; }
        const base = { k: `${c.x},${c.y},${c.z}`, i, ...c, ...(over.has(i) ? { want } : {}) };
        if (portalCells.has(i)) {
            const p = portalCells.get(i);
            if (S.AIR.has(h.name) || h.name === 'fire') { if (!lit.has(p)) { lit.add(p); tasks.push({ ...base, kind: 'ignite', portal: p, k: `portal@${p.light.x},${p.light.y},${p.light.z}`, x: p.light.x, y: p.light.y, z: p.light.z }); } continue; }
            tasks.push({ ...base, kind: fluidAt[i] ? 'fill' : 'clear' }); continue;
        }
        if (fluidAt[i] && !(S.FLUIDS.has(wn) && wn === h.name)) {
            // a fluid where something else belongs: into a block that holds no water (not waterloggable) the block itself goes straight in; otherwise the fluid is filled first
            const r = target.recipeOf(base);
            if (r && r.op === 'place' && !('waterlogged' in want.props) && h.name !== 'bubble_column' && !WATERY.test(h.name)) tasks.push({ ...base, kind: 'place' });
            else tasks.push({ ...base, kind: 'fill' });
            continue;
        }
        if (S.AIR.has(wn)) { tasks.push({ ...base, kind: 'clear' }); continue; }
        const r = target.recipeOf(base);
        if (!r) { if (!S.AIR.has(h.name) && !REPLACEABLE.test(h.name)) tasks.push({ ...base, kind: 'clear' }); continue; }       // nothing to place here (a piston's head): only make room
        const fx = clicksFor(want, h);
        if (fx) { tasks.push({ ...base, kind: 'fix', ...fx }); continue; }
        if (r.op === 'pour' || r.op === 'ignite') { if (S.AIR.has(h.name) || REPLACEABLE.test(h.name)) tasks.push({ ...base, kind: r.op }); else tasks.push({ ...base, kind: 'clear' }); continue; }
        tasks.push({ ...base, kind: 'place', wrong: !(S.AIR.has(h.name) || REPLACEABLE.test(h.name)) });
    }
    // fluids outside the box next to it: they would run in once the box is opened
    const seal = new Set();
    const outside = (x, y, z) => {
        if (target.inside(x, y, z)) return;
        const k = `${x},${y},${z}`; if (seal.has(k)) return;
        const h = seen(bot, { x, y, z });
        if (h && (h.name === 'water' || h.name === 'lava' || WATERY.test(h.name) || h.props.waterlogged === 'true')) { seal.add(k); tasks.push({ k, kind: 'seal', i: -1, x, y, z, waterlogged: h.props.waterlogged === 'true' && h.name !== 'water' }); }
    };
    for (let y = b.y; y < b.y + b.sy; y++) for (let z = b.z; z < b.z + b.sz; z++) { outside(b.x - 1, y, z); outside(b.x + b.sx, y, z); }
    for (let y = b.y; y < b.y + b.sy; y++) for (let x = b.x; x < b.x + b.sx; x++) { outside(x, y, b.z - 1); outside(x, y, b.z + b.sz); }
    for (let z = b.z; z < b.z + b.sz; z++) for (let x = b.x; x < b.x + b.sx; x++) { outside(x, b.y + b.sy, z); outside(x, b.y - 1, z); }
    return { tasks, unknown, right, dynamic, have, phased, kept };
}

module.exports = { survey, clicksFor, REPLACEABLE, WATERY, FLUID, CLICKS };

'use strict';
// Survival movement for builders: a plan over standing cells (A*) with the moves a player makes (walk, step up, drop up to three, pillar up on a temporary block, bridge over a
// gap on one, break what is in the way, dig down), and their execution with the bot's own physics and inputs (look, forward, jump, sneak, a click, a dig). Every move is
// checked against where the server puts the bot; a move that does not end where planned ends the run, the caller plans again.
// The world: the bot's view, with `rules`: canDig(x, y, z, block) (never a built cell of the box, a container, next to a fluid ...), temp() (the item for temporary blocks
// or null), onTemp(cell, how, item) (a temporary block is about to be placed there: registered before the click, the caller's ledger confirms it), onUntemp(cell) (this mover dug
// one), onTempFail(cell, why) (a removal that did not work), ownTemp(x, y, z) (the bot's own by the ledger). The mover digs its own pillar as it leaves it and a bridge block
// behind it as it goes; nothing is kept for a later step (owner list 5 Large 1).
const { Vec3 } = require('vec3');
const P = require('./place');
const V = require('./vanilla');
const FG = require('./fallguard');
const PZ = require('./pauses');
const FB = require('./fastblock');

// (a mover's waits are ticks for the server to apply a look, a click, a step: labelled so, the pause table tells them from planning, pauses.js)
const sleep = (ms, label = 'server: mover tick wait') => PZ.sleep(ms, label);
const key = (x, y, z) => `${x},${y},${z}`;
// how far the centre goes out when leaning over an edge: 0.1 beyond it, 0.2 of the body still on the block (at 0.25 beyond it, 0.05 on, bots slipped off pit edges, live
// 2026-11-22 sK2 w5); the support's side face is in sight from there
const LEAN = 0.6;
const CLIMB = /^(vine|ladder|scaffolding|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|cave_vines|cave_vines_plant)$/;
const AVOID_IN = /^(lava|fire|soul_fire|nether_portal|end_portal|end_gateway|cobweb|sweet_berry_bush|bubble_column|wither_rose|magma_block|campfire|soul_campfire|pointed_dripstone|cactus|moving_piston)$/;
const NO_STAND = /^(magma_block|campfire|soul_campfire|cactus|.*_fence|.*_wall|.*_fence_gate|pointed_dripstone|honey_block|slime_block|powder_snow|scaffolding|.*_bed|hopper|composter)$/;
// cells a temporary block can go into (vanilla canBeReplaced): a pillar or bridge block into a cell holding redstone wire, a torch, a rail or a repeater is refused by the
// server, and a bot standing in a wire cell pillared in vain for minutes (owner 2026-11-23, problem 1)
const PLACEABLE = /^(air|cave_air|void_air|water|short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|vine|glow_lichen|snow|seagrass|tall_seagrass|crimson_roots|warped_roots|nether_sprouts|hanging_roots|leaf_litter)$/;
// blocks whose collision box the server offsets at random (the client's physics misplaces it)
const OFFSET = /^(bamboo|bamboo_sapling|pointed_dripstone)$/;
const H = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const COST = { walk: 4.6, diag: 6.5, up: 9, drop: 5, pillar: 14, bridge: 40, temp: 6, swim: 8, lava: 60 };
// How deep a column of its own the bot can take back from the cell beside its top, leaning out over the shaft (sneaking eye 1.27 over the feet, 0.4 from the column's middle, reach
// 4.4 to the top face of each block): four. A route leaves a taller column of its own sideways only by its last step, onto a stance beside the column's top, which is the stance's
// way back down (walkBack); a route that went on left the column standing out of everybody's reach: 51-76 % of the bot-seconds over two temporary blocks in the 1.21.1 smoke
// runs (build_t-w121-smoke w1-w3, columns of 5-22 left by a walk, a bridge or a drop off their top), each later taken away from a new pillar beside it (owner list 5 Large 1:
// "a placement whose removal stance cannot exist is not chosen")
const LEAN_DEPTH = 4;
/**
 * May a move from a cell on top of its own column `col` high (0: not on one) leave that column, and how: 'go' (the landing takes the column back: Mover._behind), 'last' (only as the
 * route's last step, the stance beside the top: the column is its way back down), or null (never). `move`: walk, bridge, up, drop, swim; `orth`: a straight step; `level`: the same height.
 */
function leaveColumn(col, move, orth, level, depth = LEAN_DEPTH) {
    if (!col) return 'go';
    if ((move === 'walk' || move === 'bridge') && orth && level) return col <= depth ? 'go' : 'last';
    if (move === 'walk' && !orth) return col <= 1 ? 'go' : null;          // diagonal: _behind does not lean, the top face only from where the bot stands
    if (move === 'up') return col <= 1 ? 'go' : null;                   // one higher: the shaft is seen from above its rim only one block deep
    if (move === 'drop' || move === 'swim') return col <= 2 ? 'go' : null;
    return null;
}

class Heap {
    constructor() { this.a = []; }
    push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= n.f) break; a[i] = a[p]; i = p; } a[i] = n; }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < (m === i ? last.f : a[m].f)) m = l; if (r < a.length && a[r].f < (m === i ? last.f : a[m].f)) m = r; if (m === i) break; a[i] = a[m]; i = m; } a[i] = last; } return top; }
    get size() { return this.a.length; }
}

/** The world as movement sees it: what a cell holds, with the changes a plan makes on its way (dug cells are air, temporary blocks stand). */
class View {
    constructor(bot, rules) { this.bot = bot; this.rules = rules; this.over = new Map(); this.cache = new Map(); }
    raw(x, y, z) {
        const k = key(x, y, z);
        let b = this.cache.get(k);
        if (b === undefined) { b = FB.blockAt(this.bot, x, y, z); this.cache.set(k, b); }          // by state id, one shared Block per state (fastblock.js)
        return b;
    }
    /** 'free' (a body can be in it), 'solid' (it stands on it / bumps into it), 'avoid' or 'unknown'. */
    kind(x, y, z) {
        const o = this.over.get(key(x, y, z));
        if (o) return o;
        const b = this.raw(x, y, z);
        if (!b) return 'unknown';
        if (AVOID_IN.test(b.name)) return 'avoid';
        // climbable plants have no collision box but catch a walking body (it climbs and gets nowhere: 307 failed walks in a jungle, live 2026-11-22 sJ2 w3): broken on the way
        if (CLIMB.test(b.name)) return 'solid';
        // powder snow swallows a body (it sinks and cannot get out by walking: a crew stood stuck in a snowfield, owner 2026-11-23 problem 6): an obstacle that is dug, never walked into
        if (b.name === 'powder_snow') return 'solid';
        // falling water (a waterfall) carries a body down: no route goes through it (six bots drowned swimming up one, live 2026-11-22 sN2 w2)
        if (b.name === 'water') { const lv = Number((b.getProperties() || {}).level || 0); if (lv >= 8) return 'avoid'; }
        if (b.boundingBox === 'empty') return b.name === 'water' ? 'water' : 'free';
        return 'solid';
    }
    free(x, y, z) { const k = this.kind(x, y, z); return k === 'free' || k === 'water'; }
    /** Can a temporary block be put into this cell (it is empty or holds something a placement replaces)? */
    placeable(x, y, z) {
        if (this.rules.noTemp && this.rules.noTemp(x, y, z)) return false;
        const o = this.over.get(key(x, y, z));
        if (o) return o === 'free';
        const b = this.raw(x, y, z);
        return !!b && PLACEABLE.test(b.name);
    }
    fits(x, y, z) { return this.free(x, y, z) && this.free(x, y + 1, z); }
    /** Can a body stand on the block at (x, y, z) (its top at the cell's top)? */
    stands(x, y, z) {
        const o = this.over.get(key(x, y, z));
        if (o === 'solid') return true;
        if (o) return false;
        // a block another bot has claimed to dig is gone in a moment: no route stands on it (bots walked over terrain the crew was clearing and fell 25-32 blocks into the
        // dug box, live 2026-11-23 ha6 w4)
        if (this.rules.doomed && this.rules.doomed(x, y, z)) return false;
        const b = this.raw(x, y, z);
        if (!b || b.boundingBox !== 'block' || NO_STAND.test(b.name)) return false;
        const shapes = b.shapes || [], top = Math.max(...shapes.map((s) => s[4]));
        // a full top, or nearly (soul sand, mud, a dirt path, farmland, a chest), under the middle of the cell where the body stands: an open trapdoor is a plate along one
        // side with its top at 1, and four bots stepped onto one and fell through (live 2026-11-25 hb3 w1)
        return top >= 0.85 && top <= 1 + 1e-6 && shapes.some((s) => s[4] >= 0.85 && s[0] < 0.8 && s[3] > 0.2 && s[2] < 0.8 && s[5] > 0.2);
    }
    /** Lava beside the body's two cells (a slip or a flow takes the bot) or under the feet (one or two down: a fall). Lava next to the floor block is no danger. */
    nearLava(x, y, z) {
        const k = key(x, y, z); let v = this.lavaNear && this.lavaNear.get(k);
        if (v !== undefined) return v;
        v = false;
        // regions of 8x8x8 cells without any lava answer at once (78 lookups per cell made the search crawl at 4 500 cells/s, live 2026-11-22 sQ2 w4)
        if (!this._lavaRegions(x - 2, y - 2, z - 2, x + 2, y + 3, z + 2)) { (this.lavaNear = this.lavaNear || new Map()).set(k, false); return false; }
        // two cells around the body, from two under the feet to three over them: the Nether's lava runs several cells in seconds and falls from above (bots pillaring beside it
        // burned, four deaths on one world, live 2026-11-22 sW w5); fire only where the body is
        // lava at the floor's level beside the floor cannot flow up into the body: allowed (a lava lake is filled from its shore; forbidding it left every fill without a stance,
        // live 2026-11-22 sA2 w5); the follower sneaks beside it
        for (let dy = -2; dy <= 3 && !v; dy++) for (let dx = -2; dx <= 2 && !v; dx++) for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) + Math.abs(dz) > 2) continue;
            if (dy < 0 && (dx || dz)) continue;
            const b = this.raw(x + dx, y + dy, z + dz);
            // lava sealed in the rock (no free cell beside or under it) cannot run: no danger (a pocket of one cell in netherrack kept every stance away and its fill was
            // parked; it is filled from above, where lava does not flow, live 2026-11-23 fz8 w5)
            if (b && b.name === 'lava' && this._sealed(x + dx, y + dy, z + dz)) continue;
            if (b && (b.name === 'lava' || (b.name === 'fire' && !dx && !dz && dy >= -1 && dy <= 1))) { v = true; break; }
        }
        (this.lavaNear = this.lavaNear || new Map()).set(k, v);
        return v;
    }
    /** Is a fall down the column from cell (x, y, z) deadly: into lava, onto ground more than 20 cells down, into the void or into chunks not loaded (water breaks a fall)? */
    deadly(x, y, z) {
        const k = key(x, y, z), m = this.deadC || (this.deadC = new Map()); let v = m.get(k);
        if (v !== undefined) return v;
        v = true;
        for (let d = 0; d <= 64; d++) {
            const q = this.raw(x, y - d, z);
            if (!q) break;
            if (q.name === 'lava') break;
            if (q.name === 'water') { v = false; break; }
            if (q.boundingBox === 'block') { v = d > 20; break; }
        }
        m.set(k, v);
        return v;
    }
    /** Lava at (x, y, z) with nothing it can run into: every cell beside and under it is a block (not air, not another fluid). */
    _sealed(x, y, z) {
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) { const q = this.raw(x + dx, y + dy, z + dz); if (!q || q.boundingBox !== 'block' || q.name === 'lava' || q.name === 'water') return false; const o = this.over.get(key(x + dx, y + dy, z + dz)); if (o === 'free') return false; }
        return true;
    }
    /**
     * Is there lava (or fire) in any 8x8x8 region the box touches? A region is scanned by state ids (blockAt builds a Block with its biome for each of 512 cells: the scans were a
     * sixth of all CPU in the Nether, live 2026-11-23 fx3 profile) and the answer is kept 5 s per bot, shared by its views.
     */
    _lavaRegions(x0, y0, z0, x1, y1, z1) {
        const R = 8, reg = lavaCache(this.bot);
        for (let rx = Math.floor(x0 / R); rx <= Math.floor(x1 / R); rx++) for (let ry = Math.floor(y0 / R); ry <= Math.floor(y1 / R); ry++) for (let rz = Math.floor(z0 / R); rz <= Math.floor(z1 / R); rz++) {
            const k = `${rx},${ry},${rz}`;
            let has = reg.get(k);
            if (has === undefined) {
                has = false; let unknown = false;
                const w = this.bot.world, hot = w && this.bot.registry ? hotStates(this.bot) : null, p = new Vec3(0, 0, 0);
                for (let x = rx * R; x < rx * R + R && !has; x++) for (let y = ry * R; y < ry * R + R && !has; y++) for (let z = rz * R; z < rz * R + R; z++) {
                    p.x = x; p.y = y; p.z = z;
                    if (!hot) { const b = this.bot.blockAt(p, false); if (b && (b.name === 'lava' || b.name === 'fire')) { has = true; break; } continue; }
                    // a cell whose chunk is not loaded is no proof of no lava: the region counts as hot and is not kept (a region read before its chunk came was kept as
                    // lava-free and all eight bots walked into the lava beside the chest, live 2026-11-23 fy2 w4)
                    if (!w.getColumnAt(p)) { unknown = true; has = true; break; }
                    let id; try { id = w.getBlockStateId(p); } catch (_) { id = undefined; }
                    if (id !== undefined && hot.has(id)) { has = true; break; }
                }
                if (!unknown) reg.set(k, has);
            }
            if (has) return true;
        }
        return false;
    }
    diggable(x, y, z) {
        if (this.kind(x, y, z) !== 'solid') return false;
        const k = key(x, y, z), c = this.digC || (this.digC = new Map());
        let v = c.get(k);
        if (v === undefined) { const b = this.raw(x, y, z); v = !!b && this.rules.canDig(x, y, z, b, this); c.set(k, v); }
        return v;
    }
    // with the tool the dig will use, not what the hand holds now (priced with a held bed or dirt, stone cost 150 ticks and a 9-block tunnel lost to searching 30 000 surface cells, live 2026-11-22)
    digTicks(x, y, z) {
        const b = this.raw(x, y, z); if (!b) return Infinity;
        const tool = toolFor(this.bot, b);
        try { return Math.ceil(b.digTime(tool ? tool.type : null, false, false, false, [], {}) / 50) + 2; } catch (_) { return 40; }
    }
}

/** The state ids of lava and fire (any level) for a bot's registry. */
const HOT = new WeakMap();
function hotStates(bot) {
    let s = HOT.get(bot.registry); if (s) return s;
    s = new Set();
    for (const n of ['lava', 'fire', 'soul_fire']) { const b = bot.registry.blocksByName[n]; if (b) for (let i = b.minStateId; i <= b.maxStateId; i++) s.add(i); }
    HOT.set(bot.registry, s); return s;
}
/** A bot's lava regions ('rx,ry,rz' -> bool), dropped every 5 s (lava flows; a dug cell can open onto it). */
const LAVA = new WeakMap();
function lavaCache(bot) {
    let c = LAVA.get(bot); const now = Date.now();
    if (!c || now - c.at > 5000) { c = { at: now, m: new Map() }; LAVA.set(bot, c); }
    return c.m;
}

/**
 * A plan from the bot's feet cell to a cell `goal(x, y, z)` accepts (h: a heuristic point). Returns [{ x, y, z, move, dig: [cells], place: cell | null }] (the first entry is the start) or null.
 * `temps`: how many temporary blocks the plan may use.
 */
/** Searches of the process, for the progress line: count, wall ms, failed, and walks that took the flood's route instead (PLANS). */
const PLANS = { n: 0, ms: 0, failed: 0, flood: 0, sinks: 0, sinkFailed: 0 };
function plan(view, start, goal, h, o = {}) { const t0 = Date.now(); PLANS.n++; return PZ.within(o.flood ? "cpu: flood (the claim's reach)" : 'cpu: plan (a walk)', () => plan0(view, start, goal, h, o)).then((r) => { PLANS.ms += Date.now() - t0; if (!r && !o.flood) PLANS.failed++; return r; }); }
async function plan0(view, start, goal, h, { maxNodes = 40000, temps = 0, box = null, budgetMs = 4000, lavaCost = 0, maxDrop = 4, flood = false, out = null, leanDepth = LEAN_DEPTH } = {}) {
    const open = new Heap(), best = new Map(), placed = flood ? new Map() : null, nodes = flood ? new Map() : null;          // (flood: every node, a route to any cell of it without a new search)          // (flood: the temporary blocks the best way to each cell places)
    // height to gain costs about a pillar step each (a weaker estimate searched whole hillsides before climbing 17 blocks to a tree top, live 2026-11-22)
    // weighted (a quicker search, a little longer way): a goal in the air is reached over a bridge at ten times a walk's cost, which an estimate at walking cost hid: the search
    // filled 30 000 cells of a Nether cliff and never bridged out to the site (owner 2026-11-23, problem 4 of list 2)
    // (and a goal inside rock: every cell on the way is a dig, three times a walk; the search spread through the netherrack sideways and never climbed the shaft, live
    // 2026-11-23 gb1 w6)
    const air = temps > 0 && !view.stands(h.x, h.y - 1, h.z) && view.free(h.x, h.y - 1, h.z), rock = !view.fits(h.x, h.y, h.z), W = air || rock ? 2.5 : 1.3;
    // flood: no goal, no estimate (Dijkstra): every cell the bot can get to within maxNodes, with its cost (the claim offers stances only among them, Mover.flood)
    const hh = flood ? () => 0 : (x, y, z) => W * ((Math.abs(x - h.x) + Math.abs(z - h.z)) * COST.walk * 0.9 + (h.y > y ? (h.y - y) * (temps > 0 ? COST.pillar + COST.temp : COST.up) * 0.9 : (y - h.y) * COST.drop * 0.5));
    // the column of its own the bot stands on (a pillar it climbed, kept for a next stance on the same column): its height decides how the route may leave it
    let col0 = 0; if (view.rules.ownTemp) while (col0 < 64 && view.rules.ownTemp(start.x, start.y - 1 - col0, start.z)) col0++;
    open.push({ x: start.x, y: start.y, z: start.z, g: 0, f: hh(start.x, start.y, start.z), t: 0, p: null, move: 'start', col: col0, off: false });
    best.set(key(start.x, start.y, start.z), 0);
    // (a cell reached by the last step off a tall column is kept apart from the same cell reached otherwise: it is a stance only, nothing is planned on from it)
    const bkey = (x, y, z, off) => off ? `${key(x, y, z)}|o` : key(x, y, z);
    // the cells reached only as such a stance count as reached for the flood and the region (folded in under their plain key)
    const fold = () => { for (const [k, g] of [...best]) { if (!k.endsWith('|o')) continue; best.delete(k); const b = k.slice(0, -2); if (!best.has(b) || best.get(b) > g) { best.set(b, g); if (placed && placed.has(k)) placed.set(b, placed.get(k)); } if (placed) placed.delete(k); } };
    const inBox = (x, y, z) => !box || (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1);
    let n = 0, spent = 0, slice = Date.now(), closest = null, pzs = PZ.now();
    while (open.size && n++ < maxNodes) {
        // a long search gives the event loop back after 25 ms of its own time and ends after `budgetMs` of it (by node counts, a slice beside the Nether's lava, where every cell
        // looks at 78 others, held all eight bots for 1.5-6 s: ping, owner 2026-11-23 problem 5; a synchronous search froze the work console for 25 s, live 2026-11-22)
        if (n % 32 === 0 && Date.now() - slice > 25) { PZ.slice('plan', pzs); spent += Date.now() - slice; if (spent > budgetMs) { fold(); plan.last = { why: 'time', nodes: n, best, placed, closest }; if (out) Object.assign(out, plan.last); return null; } await new Promise((r) => setImmediate(r)); slice = Date.now(); pzs = PZ.now(); }
        const c = open.pop();
        // the cell closest to the estimate's point (for the log: where a failed search got stuck)
        { const d = Math.abs(c.x - h.x) + Math.abs(c.y - h.y) * 1.5 + Math.abs(c.z - h.z); if (!closest || d < closest.d) closest = { x: c.x, y: c.y, z: c.z, d, t: c.t, g: Math.round(c.g) }; }
        if (goal(c.x, c.y, c.z)) { PZ.slice('plan', pzs); const out = []; for (let q = c; q; q = q.p) out.push({ x: q.x, y: q.y, z: q.z, move: q.move, dig: q.dig || null, place: q.place || null, off: !!q.off, tempOnly: !!q.tempOnly, ...(q.sink ? { sink: q.sink } : {}) }); return out.reverse(); }
        if ((best.get(bkey(c.x, c.y, c.z, c.off)) ?? Infinity) < c.g) continue;
        if (c.off) continue;          // the stance beside a tall column's top: the route ends here or not at all
        const add = (x, y, z, cost, move, extra = {}) => {
            if (!inBox(x, y, z)) return;
            // never a cell beside or over lava (a slip, a flow, a push: a cost was not enough, bots died in the Nether's lava sea, live 2026-11-22); a bot closed in by lava on
            // every side may get out past it at a high cost (`lavaCost`, escapes only: one stood boxed in for good, live 2026-11-23 fx1 w4)
            let extraCost = 0;
            if (view.nearLava(x, y, z)) { if (!lavaCost) return; extraCost = lavaCost; }
            // never through another bot's body (several bots planned the same cell and pushed each other off a cliff, or jumped in the same column, owner 2026-11-23)
            // (costs, not bans: as bans they were behind most failed searches, [diag] ha19-ha20; the body rule only counts near the bot, see drive.js)
            if (view.rules.occupied && (view.rules.occupied(x, y, z) || view.rules.occupied(x, y + 1, z))) extraCost += 60;
            // never onto another bot's temporary block: its placer takes it back as it steps off (Mover._behind), and a route over it stops that (onRouteOfOther: "a crew member
            // on it or its route", the most common reason a column stood after its bot left it, bt075f)
            if (view.rules.othersMove && view.rules.othersMove(x, y - 1, z)) return;
            if (move === 'pillar' && view.rules.columnBusy && view.rules.columnBusy(x, z)) extraCost += 40;
            // a bridge over a fall into lava or the void costs more (it is walked sneaking, see follow; refused outright, a site over the Nether's lava sea had no way at all,
            // live 2026-11-23 gb5 w4; walked upright, seven bots fell off such bridges, gb1 w5)
            if (move === 'bridge' && view.deadly(x, y - 1, z)) extraCost += COST.bridge;
            // a block placed where the blueprint has a plain full block is the build itself, not a temporary block (rules.buildBlock): it costs no temporary block
            // (but never on top of a column of temporary blocks: the build's block over them is not dug as the bot comes down, so the column under it is stranded, and the route
            // walked or dropped off it as off the ground: a column of 5 under a blueprint block was left by a drop, bt075a w2; the pillar goes on with temporary blocks)
            const tempOnly = move === 'pillar' && c.col > 0;
            const own = !tempOnly && !!extra.place && !!view.rules.buildBlock && !!view.rules.buildBlock(extra.place.x, extra.place.y, extra.place.z);
            // a temporary block that a pane, bars, wall or fence would connect to, or that changes a redstone wire's shape, costs more: the build flickers with every one placed
            // and taken away (owner list 5 Small 2, measured by TASK-077: 14 pane changes in 30 s beside cobblestone temps); used where no other way is (temps.js counts them)
            if (extra.place && !own && view.rules.tempCost) { const tc = view.rules.tempCost(extra.place.x, extra.place.y, extra.place.z, view); if (!Number.isFinite(tc)) return; extraCost += tc; }
            const t = c.t + (extra.place && !own ? 1 : 0);
            if (t > temps) return;
            // the column of its own under the new cell, and whether this move may leave the one under c (leaveColumn)
            let col = 0, off = false;
            if (move === 'pillar') col = own ? 0 : c.col + 1;
            else if (move === 'down') col = Math.max(0, c.col - 1);
            else if (move === 'sink') col = 1;          // on its own one block, the one above it dug
            else {
                const how = leaveColumn(c.col, move, Math.abs(x - c.x) + Math.abs(z - c.z) === 1, y === c.y, leanDepth);
                if (!how) return;
                off = how === 'last';
                col = move === 'bridge' && !own ? 1 : 0;
            }
            const g = c.g + cost + extraCost, k = bkey(x, y, z, off);
            if (g >= (best.get(k) ?? Infinity)) return;
            best.set(k, g); if (placed) placed.set(k, t);
            const nd = { x, y, z, g, f: g + hh(x, y, z), t, p: c, move, col, off, ...(tempOnly ? { tempOnly } : {}), ...extra };
            open.push(nd); if (nodes) nodes.set(k, nd);
        };
        const headFree = view.free(c.x, c.y + 2, c.z);
        // swimming: from a cell in water (or into water, or out of it onto something to stand on) in the six directions
        const wetHere = view.kind(c.x, c.y, c.z) === 'water';
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
            const x = c.x + dx, y = c.y + dy, z = c.z + dz;
            if (!view.fits(x, y, z)) continue;
            const wetThere = view.kind(x, y, z) === 'water';
            if (!(wetHere || wetThere)) continue;
            if (!wetThere && !view.stands(x, y - 1, z)) continue;
            // at the surface: a cell whose head is under water costs a dive (routes dived to the sea floor and the bot came up for air again and again, owner 2026-11-23)
            add(x, y, z, COST.swim + (view.kind(x, y + 1, z) === 'water' ? 30 : 0) + (dy < 0 ? 10 : 0), 'swim');
        }
        for (const [dx, dz] of H) {
            const x = c.x + dx, z = c.z + dz, diag = dx && dz;
            if (diag && !(view.fits(c.x + dx, c.y, c.z) && view.fits(c.x, c.y, c.z + dz))) continue;
            // walk on the same level
            if (view.fits(x, c.y, z)) {
                if (view.stands(x, c.y - 1, z)) { add(x, c.y, z, diag ? COST.diag : COST.walk, 'walk'); continue; }
                // drop down onto something: up to three, or up to `maxDrop` for a healthy bot at a cost for the damage (a bot on a plateau with four-block drops all round had
                // no way down, live 2026-11-23 ga4 w1)
                let landed = false;
                for (let k = 1; k <= maxDrop && !diag; k++) { if (!view.free(x, c.y - k, z)) { if (view.rules.othersTemp && view.rules.othersTemp(x, c.y - k, z)) break; if (view.stands(x, c.y - k, z) && view.kind(x, c.y - k + 1, z) !== 'water' || view.kind(x, c.y - k + 1, z) === 'water') { add(x, c.y - k + 1, z, COST.drop + k + (k > 4 ? (k - 4) * 15 : 0), 'drop'); landed = true; } break; } }
                // a bridge from a block under the feet, or from the temporary block this plan just put there (bridges were one cell long: the plan's view never had its own
                // blocks, live 2026-11-23 ga4 w1)
                const onTemp = !!c.place && c.place.x === c.x && c.place.y === c.y - 1 && c.place.z === c.z;
                // (a bridge step that places the blueprint's own block is the build itself: cheap, so floors are laid by walking over them)
                // (not a bridge that failed from this cell in the last minute: b081q4/q5, a bed in the stance hid the support's side and the same bridge was tried every 3 s for a minute)
                if (!landed && !diag && !(view.rules.noBridge && view.rules.noBridge(c.x, c.y, c.z, x, z))) { if (view.placeable(x, c.y - 1, z) && view.kind(x, c.y - 1, z) !== 'water' && (onTemp || (view.stands(c.x, c.y - 1, c.z) && P.full(blk(view, c.x, c.y - 1, c.z))))) add(x, c.y, z, (view.rules.buildBlock && view.rules.buildBlock(x, c.y - 1, z)) ? 12 : COST.bridge + COST.temp, 'bridge', { place: { x, y: c.y - 1, z } }); }
                continue;
            }
            if (diag) continue;
            // step up one; a jump at the edge of a drop of five or more costs as much as six pillar steps: from the top of a pillar the jump onto the next column missed and the
            // bot fell 20 blocks into the dug box, three deaths in four minutes (live 2026-11-23 ha7 w1); the plan pillars one higher and walks across level instead
            if (headFree && view.fits(x, c.y + 1, z) && view.stands(x, c.y, z)) { add(x, c.y + 1, z, COST.up + (edgeDrop(view, c, 5) ? 120 : 0), 'up'); continue; }
            // dig a step up: the block in front stays as the step, the two over it and the one over the head go (a bot without blocks at the bottom of a hole two deep beside the
            // chest had no way at all, live 2026-11-23 gd1 w6)
            if (view.stands(x, c.y, z) && !view.free(x, c.y, z)) {
                const cells = [[x, c.y + 1, z], [x, c.y + 2, z], [c.x, c.y + 2, c.z]];
                if (cells.every(([a, b, d]) => view.free(a, b, d) || view.diggable(a, b, d)) && cells.some(([a, b, d]) => !view.free(a, b, d))) {
                    const dig = cells.filter(([a, b, d]) => !view.free(a, b, d)).map(([a, b, d]) => ({ x: a, y: b, z: d }));
                    add(x, c.y + 1, z, COST.up + dig.reduce((t, q) => t + view.digTicks(q.x, q.y, q.z), 0), 'up', { dig });
                }
            }
            // break what is in the way (one or two cells) and walk on
            const d0 = !view.free(x, c.y, z), d1 = !view.free(x, c.y + 1, z);
            if ((!d0 || view.diggable(x, c.y, z)) && (!d1 || view.diggable(x, c.y + 1, z)) && view.stands(x, c.y - 1, z)) {
                const dig = []; let cost = COST.walk;
                if (d0) { dig.push({ x, y: c.y, z }); cost += view.digTicks(x, c.y, z); }
                if (d1) { dig.push({ x, y: c.y + 1, z }); cost += view.digTicks(x, c.y + 1, z); }
                add(x, c.y, z, cost, 'walk', { dig });
            }
        }
        // pillar up on a temporary block (head room first, broken when diggable), only from a cell the block can go into
        if ((temps > c.t || (view.rules.buildBlock && view.rules.buildBlock(c.x, c.y, c.z))) && view.placeable(c.x, c.y, c.z) && view.kind(c.x, c.y + 2, c.z) !== 'avoid' && (headFree || view.diggable(c.x, c.y + 2, c.z))) add(c.x, c.y + 1, c.z, COST.pillar + COST.temp + (headFree ? 0 : view.digTicks(c.x, c.y + 2, c.z)) + (view.rules.noPillar && view.rules.noPillar(c.x, c.y, c.z) ? 40 : 0), 'pillar', { place: { x: c.x, y: c.y, z: c.z }, dig: headFree ? null : [{ x: c.x, y: c.y + 2, z: c.z }] });
        // dig down one (the block under the feet), onto the one under it
        if (view.diggable(c.x, c.y - 1, c.z) && view.stands(c.x, c.y - 2, c.z)) add(c.x, c.y - 1, c.z, COST.drop + view.digTicks(c.x, c.y - 1, c.z), 'down', { dig: [{ x: c.x, y: c.y - 1, z: c.z }] });
        // sink (owner ruling 2026-11-26, OWNER-LIST-5 addendum 4: placing under the block under the feet is a Tweakeroo-class move, digging that block a player's): a temporary
        // block goes under the block the bot stands on (its bottom face clicked: the server checks reach, not sight), that block is dug, the bot comes down one onto the new block.
        // A column of its own going down, taken away as it goes: the way down from a height whose way up was taken back (b081f minute 90: six of eight bots at y 108-122 had
        // "no way to the materials" after 40 000 cells: drops of at most six over the build's walls were the only way down)
        // (the floor may be a block this route put down itself, a bridge, pillar or sink block: not in the world yet, dug all the same)
        else if (temps > c.t && (view.diggable(c.x, c.y - 1, c.z) || (c.place && c.place.y === c.y - 1 && !(view.rules.buildBlock && view.rules.buildBlock(c.place.x, c.place.y, c.place.z)))) && view.placeable(c.x, c.y - 2, c.z) && !view.stands(c.x, c.y - 2, c.z) && view.kind(c.x, c.y - 3, c.z) !== 'avoid' && !(view.rules.noTemp && view.rules.noTemp(c.x, c.y - 2, c.z)))
            add(c.x, c.y - 1, c.z, COST.drop + COST.temp + view.digTicks(c.x, c.y - 1, c.z), 'sink', { place: { x: c.x, y: c.y - 2, z: c.z }, sink: { x: c.x, y: c.y - 1, z: c.z } });
    }
    // searched out: every cell the bot can get to from here (the caller offers it only stances among them)
    PZ.slice('plan', pzs);
    fold();
    plan.last = { why: open.size ? 'nodes' : 'no more cells', nodes: n, region: open.size ? null : best, best, placed, closest, all: nodes };
    if (out) Object.assign(out, plan.last);
    return null;
}
/** Is cell c beside a drop of `k` or more (a horizontal neighbour free for k cells under the feet level)? */
function edgeDrop(view, c, k) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { let j = 1; while (j <= k && view.free(c.x + dx, c.y - j, c.z + dz)) j++; if (j > k) return true; }
    return false;
}
const blk = (view, x, y, z) => { const b = view.raw(x, y, z); return b ? { name: b.name, props: {}, shapes: b.shapes || [] } : null; };

/** The tool for block (its material: mineable/pickaxe, shovel, axe, hoe; shears for leaves, wool, cobwebs), the best tier the bot carries, or null. */
const TIER = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];
function toolFor(bot, block) {
    const m = String(block.material || ''), cls = /pickaxe/.test(m) ? 'pickaxe' : /shovel/.test(m) ? 'shovel' : /axe/.test(m) ? 'axe' : /hoe/.test(m) ? 'hoe' : /leaves|wool|cobweb/.test(block.name) ? 'shears' : null;
    if (!cls) return null;
    const cand = bot.inventory.items().filter((i) => (cls === 'shears' ? i.name === 'shears' : i.name.endsWith('_' + cls)));
    cand.sort((x, y) => TIER.indexOf(x.name.split('_')[0]) - TIER.indexOf(y.name.split('_')[0]));
    return cand[0] || null;
}

/** The feet cell of the bot. */
function feet(bot) { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y + 0.16), z: Math.floor(p.z) }; }      // + 0.16: standing on a block a little lower than a full one (soul sand 0.875) is standing on its cell

/** The mover of one bot. */
class Mover {
    constructor(bot, rules, { log = () => {} } = {}) {
        this.bot = bot; this.log = log; this.trace = []; this.mine = new Map(); this.badPillar = new Map(); this.badBridge = new Map();
        // under every move: no step sideways onto a fall of more than three (fallguard.js); planned drops open their columns (follow, step)
        this.guard = FG.install(bot);
        // a pillar that failed in a cell is not planned there again for two minutes (one was tried 13 times in a row, live 2026-11-23 gd1 w2)
        this.rules = { ...rules, noPillar: (x, y, z) => (this.badPillar.get(key(x, y, z)) || 0) > Date.now(), noBridge: (x, y, z, tx, tz) => (this.badBridge.get(`${key(x, y, z)}>${tx},${tz}`) || 0) > Date.now() };
    }
    /**
     * Standing beside the top of its own pillar (the stance's way up: a bridge block off it, or the build or ground beside it): back onto the pillar's top, its own bridge block
     * dug from there, and the pillar dug down as the bot comes down (owner list 5 Large 1: "a pillar is dug as the bot comes down, a bridge as it walks back"). Returns the blocks dug, or 0 when it is not standing so.
     */
    async walkBack(cancel) {
        const f = feet(this.bot), own = (x, y, z) => this.mine.has(key(x, y, z)) || !!(this.rules.ownTemp && this.rules.ownTemp(x, y, z));
        if (own(f.x, f.y - 1, f.z) && this.mineHow && this.mineHow.get(key(f.x, f.y - 1, f.z)) === 'pillar') return 0;          // on the pillar itself: unpillar's
        const floorOwn = own(f.x, f.y - 1, f.z);
        const v = this.view();
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const t = { x: f.x + dx, y: f.y, z: f.z + dz };
            const pil = (this.mineHow && this.mineHow.get(key(t.x, t.y - 1, t.z)) === 'pillar') || !!(this.rules.ownPillar && this.rules.ownPillar(t.x, t.y - 1, t.z));
            if (!pil || !v.fits(t.x, t.y, t.z) || own(t.x, t.y - 2, t.z) === false && !v.stands(t.x, t.y - 2, t.z)) continue;
            if (!(await this.walkTo(t, { sneak: true, timeout: 2000 }))) return 0;
            const b = { x: f.x, y: f.y - 1, z: f.z };
            if (!floorOwn) return await this.unpillar(null, () => false, cancel);          // a stance on the build or the ground beside the pillar's top: only the pillar
            if (await this.dig(b)) { this.mine.delete(key(b.x, b.y, b.z)); if (this.mineHow) this.mineHow.delete(key(b.x, b.y, b.z)); if (this.rules.onUntemp) this.rules.onUntemp(b); }
            else if (this.rules.onTempFail) this.rules.onTempFail(b, 'walk back: the dig failed');
            return 1 + (await this.unpillar(null, () => false, cancel));
        }
        return 0;
    }

    /** Does the bot stand on a temporary block of its own at cell c (the floor under c)? */
    _ownFloor(c) { if (!c) return false; const k = key(c.x, c.y - 1, c.z); return this.mine.has(k) || !!(this.rules.ownTemp && this.rules.ownTemp(c.x, c.y - 1, c.z)); }

    /**
     * The bot has just stepped off cell prev onto route[i-1], sideways: prev's floor, if it is a temporary block of its own, and the column under it are dug from here, top-down,
     * while each is in reach and its face in sight and the rest of the route does not stand on it, as a player takes back the pillar or the bridge it has just left. A bridge was
     * dug behind only over air and a pillar left sideways stood for the crew (owner list 5 Large 1: two blocks per bot, the column it stands on counting as one). Returns the dug.
     */
    async _behind(prev, route, i) {
        if (!prev) return 0;
        const at = feet(this.bot);
        if (at.x === prev.x && at.z === prev.z) return 0;                                    // still on that column (a pillar step)
        let n = 0, leaned = false, why = null, top = null;
        try {
        for (let y = prev.y - 1; y > prev.y - 8; y--) {
            const c = { x: prev.x, y, z: prev.z }, k = key(c.x, c.y, c.z);
            if (!(this.mine.has(k) || (this.rules.ownTemp && this.rules.ownTemp(c.x, c.y, c.z)))) { why = null; break; }
            if (route.slice(i).some((q) => q.x === c.x && q.z === c.z && q.y - 1 === c.y)) { why = 'the route stands on it'; break; }
            const b = this.bot.blockAt(new Vec3(c.x, c.y, c.z), false); if (!b || b.boundingBox !== 'block') { why = null; break; }
            if (this.rules.mayDig && !this.rules.mayDig(c.x, c.y, c.z)) { why = 'a crew member on it or its route'; break; }
            const v = this.view();
            if ([[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => { const q = v.raw(c.x + dx, c.y + dy, c.z + dz); return q && (q.name === 'water' || q.name === 'lava'); })) { why = 'a fluid beside it'; break; }
            // in sight from where it stands; else, the column beside its cell, leaning out over it (sneaking at the edge, the eye over the shaft) as a player looks down a hole
            const seesTop = () => { const p = this.bot.entity.position, eye = [p.x, p.y + (leaned ? 1.27 : 1.62), p.z], hit = [c.x + 0.5, c.y + 0.999, c.z + 0.5]; if (Math.hypot(hit[0] - eye[0], hit[1] - eye[1], hit[2] - eye[2]) > 4.4) return false; const r = P.rayFirst(P.botWorld(this.bot), eye, hit); return !!r && r.cell[0] === c.x && r.cell[1] === c.y && r.cell[2] === c.z; };
            // (a block at or above the feet after a drop off the column: its side face, as for any block; its top face is above the eye's line)
            let ok = !leaned && P.clickable(P.botWorld(this.bot), c, feet(this.bot)) && (c.y >= feet(this.bot).y || seesTop());
            // (leaning at any height, after a drop or a step up off the column too: the sight check decides; 9 of the 14 "not in sight" of bt075g were upright, no lean tried)
            if (!ok && !leaned && Math.abs(c.x - at.x) + Math.abs(c.z - at.z) === 1) {
                await this.lean(c.x - at.x, c.z - at.z); leaned = true; }
            if (!ok && leaned) ok = seesTop();
            if (!ok) { why = `not in sight (${leaned ? 'leaning' : 'upright'}, at ${feet(this.bot).x},${feet(this.bot).y},${feet(this.bot).z})`; break; }
            if (!(await this.dig(c))) { if (this.rules.onTempFail) this.rules.onTempFail(c, 'left behind: the dig failed'); why = 'the dig failed'; break; }
            this.mine.delete(k); if (this.mineHow) this.mineHow.delete(k); if (this.rules.onUntemp) this.rules.onUntemp(c);
            n++;
        }
        } finally { if (leaned) await this.unlean(); }
        // a column it could not take back from here: why (the first 40 of this mover; the staircases of bt075e w1 left columns of 3-5 with no reason in the ledger)
        if (why && (this.behindLog = (this.behindLog || 0) + 1) <= 40 && this.log) this.log(`[temps] ${this.bot.username} left its column at ${prev.x},${prev.z} after ${n} from ${at.x},${at.y},${at.z}: ${why}`);
        return n;
    }

    /** Can the bot get to cell `to` from where it stands (the planner itself, no move)? The route's cost, or null. */
    async canReach(to, { maxNodes = 20000, budgetMs = 1500 } = {}) {
        const start = feet(this.bot), view = new View(this.bot, this.rules), t = this.rules.temp();
        const temps = t ? this.bot.inventory.items().filter((i) => i.name === t).reduce((a, i) => a + i.count, 0) : 0;
        const r = await plan(view, start, (x, y, z) => x === to.x && y === to.y && z === to.z, to, { maxNodes, temps, budgetMs, maxDrop: (this.bot.health || 0) >= 16 ? 6 : 4, out: {} });
        return r ? r.length : null;
    }
    /** Can the bot get to any cell `goal` accepts (estimated toward `to`)? The route's length, or null. */
    async canReachGoal(goal, to, { maxNodes = 6000, budgetMs = 600 } = {}) {
        const start = feet(this.bot), view = new View(this.bot, this.rules), t = this.rules.temp();
        const temps = t ? this.bot.inventory.items().filter((i) => i.name === t).reduce((a, i) => a + i.count, 0) : 0;
        const r = await plan(view, start, goal, to, { maxNodes, temps, budgetMs, maxDrop: (this.bot.health || 0) >= 16 ? 6 : 4, out: {} });
        return r ? r.length : null;
    }

    /**
     * A temporary block this mover is about to put at c (`how`: pillar, bridge), registered BEFORE the click: the caller's ledger (onTemp) confirms it from the server's block update,
     * however late it comes (registered only when the block showed within the bot's short wait, a late placement was nobody's: owner list 5 Large 1, cause a).
     */
    _temp(c, how, item) { this.mine.set(key(c.x, c.y, c.z), item); (this.mineHow || (this.mineHow = new Map())).set(key(c.x, c.y, c.z), how); if (this.rules.onTemp) this.rules.onTemp(c, how, item); }

    /**
     * Standing on its own pillar and going somewhere else: dig it down from the top, a block at a time (one-block falls, no damage), as a player does, before the walk. A pillar left
     * standing after every climb flooded the site with temporary blocks (owner 2026-11-23, problem 2). Stops at anything that is not its own block, over a gap, or when the next
     * stance is on top of this pillar or beside its top (then the pillar is used again). Returns the blocks taken down.
     */
    async unpillar(to, goal, cancel, { any = false } = {}) {
        let n = 0;
        while (n < 80 && !cancel.cancelled) {
            // (any: every temporary block of the crew, rules.isTemp; a column nobody could take down from beside its top is dug down from on it)
            // its own: this mover's, or the bot's by the ledger (a column an escape or an earlier mover of the same bot put up)
            const f = feet(this.bot), k = key(f.x, f.y - 1, f.z), name = this.mine.has(k) ? this.mine.get(k) : ((any || (this.rules.ownTemp && this.rules.ownTemp(f.x, f.y - 1, f.z))) && this.rules.isTemp && this.rules.isTemp(f.x, f.y - 1, f.z) ? null : undefined);
            if (name === undefined || goal(f.x, f.y, f.z)) break;
            // only the next step on this same column keeps the pillar (dug down to its height when that is lower): one left for a stance beside its top became a column the crew
            // never took down (owner 2026-11-23 V4); "a next stance near it at about its height" kept columns for stances that never came (owner list 5 Large 1: removed)
            if (to && to.x === f.x && to.z === f.z && to.y >= f.y - 1) break;
            const b = this.bot.blockAt(new Vec3(f.x, f.y - 1, f.z), false);
            if (!b || (name && b.name !== name)) { this.mine.delete(k); break; }
            const v = this.view();
            if (!v.stands(f.x, f.y - 2, f.z) || v.nearLava(f.x, f.y - 1, f.z)) break;          // a gap or lava under it: the crew's untemp task takes it later
            if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const q = v.raw(f.x + dx, f.y - 1, f.z + dz); return q && (q.name === 'water' || q.name === 'lava'); })) break;      // it holds back a fluid
            // never a block another bot's route stands on (a bot climbed down its pillar while another walked across its top: falls of 25, live 2026-11-24 ha22 w1)
            if (this.rules.mayDig && !this.rules.mayDig(f.x, f.y - 1, f.z)) break;
            if (!(await this.dig({ x: f.x, y: f.y - 1, z: f.z }))) { if (this.rules.onTempFail) this.rules.onTempFail({ x: f.x, y: f.y - 1, z: f.z }, 'unpillar: the dig failed'); break; }
            this.mine.delete(k); if (this.rules.onUntemp) this.rules.onUntemp({ x: f.x, y: f.y - 1, z: f.z });
            for (let i = 0; i < 20 && feet(this.bot).y > f.y - 1; i++) await sleep(50);
            n++;
        }
        if (n) this.note(`unpillar ${n}`);
        return n;
    }

    /**
     * Waiting or idle: two cells from every other bot and not beside a drop (bots waiting at a Nether start on a cliff pushed one over, owner 2026-11-23). `others`: their positions.
     */
    async spread(others) {
        const p = this.bot.entity.position, close = others.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1.6 && Math.abs(q.y - p.y) < 2);
        if (!close.length) return false;
        const f = feet(this.bot), v = this.view();
        const edgy = (x, y, z) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { for (let k = 1; k <= 3; k++) if (!v.free(x + dx, y - k, z + dz)) return false; return true; });
        const ok = (x, y, z) => v.fits(x, y, z) && v.stands(x, y - 1, z) && !edgy(x, y, z) && !v.nearLava(x, y, z) && others.every((q) => Math.hypot(q.x - (x + 0.5), q.z - (z + 0.5)) >= 2);
        const r = await this.goto(f, { goal: (x, y, z) => Math.hypot(x - f.x, z - f.z) >= 2 && Math.abs(y - f.y) <= 1 && ok(x, y, z), maxNodes: 3000, tries: 1 });
        return r.ok;
    }

    /** Powder snow in the body's cells (the bot sank into it): dug out, the bot climbs out by the plan. */
    async unsink() {
        const f = feet(this.bot);
        for (const y of [f.y + 1, f.y]) { const b = this.bot.blockAt(new Vec3(f.x, y, f.z), false); if (b && b.name === 'powder_snow') await this.dig({ x: f.x, y, z: f.z }); }
        // bamboo and dripstone: the server shifts their boxes by a random offset the client's physics does not know, so a bot beside them is wedged where nothing is (eight bots
        // stood "no progress" in a bamboo jungle for half an hour, live 2026-11-23 gf1 w2): those in its own cells and the four around them are cut first
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [f.y, f.y + 1]) {
            const b = this.bot.blockAt(new Vec3(f.x + dx, y, f.z + dz), false);
            if (b && OFFSET.test(b.name) && (!this.rules.mayDig || this.rules.mayDig(f.x + dx, y, f.z + dz))) await this.dig({ x: f.x + dx, y, z: f.z + dz });
        }
    }
    view() { return new View(this.bot, this.rules); }

    /**
     * Every cell the bot can get to from where it stands, by the same moves and rules as goto (a flood without a goal, up to maxNodes): { from: 'x,y,z', cost: Map('x,y,z' -> cost),
     * complete } (complete: searched out, nothing else is reachable). The claim offers stances among these cells: stances chosen by the claim's own picture of the terrain were
     * cells the planner then searched 30 000 cells for in vain, 2 000-5 400 times a run (live 2026-11-23 gh1, owner list 4 problem 5).
     */
    async flood({ maxNodes = 4000, budgetMs = 250 } = {}) {
        const start = feet(this.bot), view = new View(this.bot, this.rules), t = this.rules.temp();
        const temps = t ? this.bot.inventory.items().filter((i) => i.name === t).reduce((a, i) => a + i.count, 0) : 0;
        const l = {};          // its own record: plan.last is shared by every bot's searches in this process
        await plan(view, start, () => false, start, { maxNodes, temps, budgetMs, maxDrop: (this.bot.health || 0) >= 16 ? 6 : 4, flood: true, out: l });
        const out = { from: key(start.x, start.y, start.z), cost: l.best || new Map(), placed: l.placed || new Map(), complete: !!l.region, at: Date.now() };
        this._flood = { from: out.from, at: out.at, nodes: l.all || null, temps };
        return out;
    }
    /**
     * The route to `to` out of the last flood from `start` (its nodes keep their parents): the claim offers stances inside that flood, so the walk to one needs no search of its own
     * (the crew's planning was 60 % of the harness's busy CPU and the largest class of the pauses, TASK-079 profile and the b081a pause table). Null when the flood is from
     * elsewhere, older than 15 s, made with other temporary blocks in the pack, or does not hold the cell.
     */
    _fromFlood(start, to, temps) {
        const F = this._flood;
        if (!F || !F.nodes || F.from !== key(start.x, start.y, start.z) || Date.now() - F.at > 15000 || F.temps !== temps) return null;
        const nd = F.nodes.get(key(to.x, to.y, to.z)) || F.nodes.get(`${key(to.x, to.y, to.z)}|o`);
        if (!nd) return null;
        const out = []; for (let q = nd; q; q = q.p) out.push({ x: q.x, y: q.y, z: q.z, move: q.move, dig: q.dig || null, place: q.place || null, off: !!q.off, tempOnly: !!q.tempOnly, ...(q.sink ? { sink: q.sink } : {}) });
        if (out.length > 1) this._flood = null;          // used once: the walk changes where the bot is
        PLANS.flood++;
        return out.reverse();
    }
    /** The last moves and digs (kept for a death's report). */
    note(what) { const p = this.bot.entity && this.bot.entity.position; this.trace.push(`${new Date().toISOString().slice(11, 19)} ${what}${p ? ` @${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : ''}`); if (this.trace.length > 14) this.trace.shift(); }

    /** Look along (yaw, pitch) and let the server have it (it applies a look a tick after it arrives). */
    async look(yaw, pitch) { await this.bot.look(yaw, pitch, true); await sleep(110); }
    async lookAtPoint(p) { const e = this.bot.entity.position.offset(0, this.bot.entity.eyeHeight || 1.62, 0); await this.look(Math.atan2(-(p.x - e.x), -(p.z - e.z)), Math.atan2(p.y - e.y, Math.hypot(p.x - e.x, p.z - e.z))); }

    async hold(item) {
        const b = this.bot;
        if (b.heldItem && b.heldItem.name === item) return true;
        const it = b.inventory.items().find((i) => i.name === item);
        if (!it) return false;
        try { await b.equip(it, 'hand'); } catch (_) { return false; }
        return !!(b.heldItem && b.heldItem.name === item);
    }

    /** An empty hand (clicks on blocks: a note block, a repeater, a gate). */
    async holdNothing() {
        const b = this.bot;
        if (!b.heldItem) return true;
        for (let i = 0; i < 9; i++) if (!b.inventory.slots[36 + i]) { b.setQuickBarSlot(i); await sleep(60); return true; }
        try { await b.unequip('hand'); } catch (_) { /* a full pack: the click goes with the item */ }
        return !b.heldItem;
    }

    /** Place item `name` into cell c from where the bot stands (a face it sees; any orientation). Returns true, or a string: why not. */
    async placeItem(name, c, props = {}) {
        if (!(await this.hold(name))) return `cannot hold ${name}`;
        const world = P.botWorld(this.bot), me = feet(this.bot);
        const w = P.ways(world, c, { name, props }, name, [me], { max: 1 })[0] || P.ways(world, c, { name, props }, name, [me], { max: 1, sneakAlways: true })[0];
        if (!w) return `no face in sight from ${me.x},${me.y},${me.z}`;
        await this.click(w.n, w.face, w.hit, { sneak: w.sneak, aim: w.aim || null });
        for (let i = 0; i < 10; i++) { const bb = this.bot.blockAt(new Vec3(c.x, c.y, c.z), false); if (bb && bb.name === name) return true; await sleep(50); }
        const bb = this.bot.blockAt(new Vec3(c.x, c.y, c.z), false);
        return `clicked face ${w.face} of ${w.n.join(',')}, the cell holds ${bb && bb.name}`;
    }

    /** Break the block at c with the tool its material asks for (mineable/pickaxe, shovel, axe, hoe; the best tier the bot carries; shears for leaves and wool). */
    /** Break the block at c (`tool`: this item stack instead of the best tier for the block, e.g. the one that gives the block back, recover.js). */
    async dig(c, { tool: want = undefined } = {}) {
        const b = this.bot, block = b.blockAt(new Vec3(c.x, c.y, c.z), false);
        if (block) this.note(`dig ${block.name} ${c.x},${c.y},${c.z}`);
        // nothing to break only where there is nothing at all: snow layers, grass, flowers have no collision box but are blocks (taking them for "gone" left 2 271 snow cells
        // undug after eight tries each, live 2026-11-22 sA2 w3)
        if (!block || /^(air|cave_air|void_air|water|lava|bubble_column)$/.test(block.name)) return true;
        if (this.rules.mayDig && !this.rules.mayDig(c.x, c.y, c.z)) return false;              // someone stands on it now (the plan was made before they came)
        const tool = want !== undefined ? want : toolFor(b, block);
        if (want === null && b.heldItem && /(_pickaxe|_axe|_shovel|_hoe|shears|_sword)$/.test(b.heldItem.name)) { try { await b.unequip('hand'); } catch (_) { /* the hand it has */ } }
        if (tool && (!b.heldItem || b.heldItem.name !== tool.name)) { try { await b.equip(tool, 'hand'); } catch (_) { /* the hand it has */ } }
        else if (!tool && b.heldItem && /(_sword|_pickaxe|_axe|_shovel|_hoe)$/.test(b.heldItem.name) === false) { /* any item: breaking by hand is the same */ }
        try { await b.dig(block, true); } catch (e) { return false; }
        const after = b.blockAt(new Vec3(c.x, c.y, c.z), false);
        return !after || /^(air|cave_air|void_air|water|lava|bubble_column)$/.test(after.name) || (after.boundingBox === 'empty' && after.name !== block.name);
    }

    /** Under water with little air: to the nearest cell (six around) where the head is in the air, by the shortest plan; a last resort before drowning. */
    async surface(cancel) {
        const v = this.view(), f = feet(this.bot), out = [];
        for (let dy = -2; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
            const x = f.x + dx, y = f.y + dy, z = f.z + dz, hk = v.kind(x, y + 1, z);
            if (v.free(x, y, z) && hk === 'free' && (v.stands(x, y - 1, z) || v.kind(x, y, z) === 'water' || v.kind(x, y - 1, z) === 'water')) out.push({ x, y, z, d: Math.abs(dx) + Math.abs(dy) * 0.5 + Math.abs(dz) });
        }
        out.sort((a, b) => a.d - b.d);
        this.log(`${this.bot.username}: out of breath at ${f.x},${f.y},${f.z}: to air (${out.length} cells)`);
        for (const c of out.slice(0, 4)) {
            const route = await plan(v, f, (x, y, z) => x === c.x && y === c.y && z === c.z, c, { maxNodes: 4000, temps: 0 });
            if (!route) continue;
            await this.follow(route, 1, route.length - 1, cancel || { cancelled: false }, { breath: false });
            if (!this.bot.entity.isInWater || this.bot.oxygenLevel > 12) return true;
        }
        // nothing planned: straight up, jumping
        this.bot.setControlState('jump', true); await sleep(2500); this.bot.setControlState('jump', false);
        return false;
    }

    /** Sneak to the edge of the bot's cell toward (dx, dz) and lean over it (the body keeps 0.05 on its floor); unlean() steps back to the middle. */
    async lean(dx, dz) {
        const b = this.bot, f = feet(b), edge = { x: f.x + 0.5 + dx * LEAN, z: f.z + 0.5 + dz * LEAN };
        this.leanFrom = f;                // the cell it stands on: leaning, its centre is over the next cell, and a cell worked out from the position then is the empty one
        b.setControlState('sneak', true);
        for (let i = 0; i < 60; i++) {
            const p = b.entity.position, ex = edge.x - p.x, ez = edge.z - p.z;
            if ((ex * dx + ez * dz) < 0.04) break;
            await b.look(Math.atan2(-dx, -dz), 0, true); b.setControlState('forward', true); await sleep(50);
        }
        b.setControlState('forward', false);
        await sleep(150);
    }
    async unlean() {
        // back to the cell it leaned from (from the position while leaning the bot walked into the empty cell beside its pillar: three falls of 30-40 blocks, live 2026-11-22 sH2)
        const b = this.bot, f = this.leanFrom || feet(b); this.leanFrom = null;
        await this.walkTo(f, { sneak: true, timeout: 1500 });
        b.setControlState('sneak', false);
    }

    /** A click on face `face` of block n at point `hit` (a vanilla use packet), looking at the point first. */
    async click(n, face, hit, { sneak = false, keepSneak = false, aim = null } = {}) {
        const b = this.bot;
        if (sneak) { b.setControlState('sneak', true); await sleep(60); }
        // `aim`: an exact rotation for the block's facing (flexible placement, place.js); else the eye looks at the hit point
        if (aim) await this.look(aim.yaw, aim.pitch); else await this.lookAtPoint(new Vec3(hit[0], hit[1], hit[2]));
        b._client.write('block_place', { hand: 0, location: new Vec3(n[0], n[1], n[2]), direction: V.FACE[face], cursorX: hit[0] - n[0], cursorY: hit[1] - n[1], cursorZ: hit[2] - n[2], insideBlock: false, worldBorderHit: false, sequence: (this.seq = (this.seq || 0) + 1) });
        b.swingArm();
        await sleep(120);
        if (sneak && !keepSneak) { b.setControlState('sneak', false); await sleep(60); }
    }

    /** Walk the body to the centre of cell c (same level or a step), with the bot's physics. */
    async walkTo(c, { jump = false, sneak = false, timeout = 2500 } = {}) {
        const b = this.bot, t0 = Date.now(), tx = c.x + 0.5, tz = c.z + 0.5;
        b.setControlState('sneak', sneak);
        try {
            for (;;) {
                const p = b.entity.position, dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
                if (d < 0.18 && Math.abs(p.y - c.y) < 0.6 && b.entity.onGround) break;
                if (Date.now() - t0 > timeout) return false;
                await b.look(Math.atan2(-dx, -dz), b.entity.pitch, true);
                b.setControlState('forward', d > 0.12);
                b.setControlState('sprint', false);
                b.setControlState('jump', jump && b.entity.onGround && p.y < c.y - 0.5);
                await sleep(50);
            }
        } finally { b.setControlState('forward', false); b.setControlState('jump', false); b.setControlState('sneak', false); }
        for (let i = 0; i < 10 && Math.hypot(b.entity.velocity.x, b.entity.velocity.z) > 0.02; i++) await sleep(50);
        return true;
    }

    /** Pillar: jump and put the temporary block into the cell the feet leave. */
    async pillar(c) {
        const b = this.bot, below = { x: c.x, y: c.y - 1, z: c.z }, own = !c.tempOnly && this.rules.buildBlock ? this.rules.buildBlock(below.x, below.y, below.z) : null, item = own || this.rules.temp();
        if (!item || !(await this.hold(item))) return false;
        const p = b.entity.position;
        if (Math.hypot(below.x + 0.5 - p.x, below.z + 0.5 - p.z) > 0.2) await this.walkTo(below, { sneak: true, timeout: 1500 });          // from the cell's centre, or the block lands in the body
        await this.look(b.entity.yaw, -Math.PI / 2);
        // the block under the feet is clicked: a trapdoor, door, gate, chest ... opens instead of taking the block (a bot on a trapdoor opened it, fell through and stood stuck,
        // owner 2026-11-23 list 4 problem 1); sneaking, a click places against it as a player does
        const under = b.blockAt(new Vec3(below.x, below.y - 1, below.z), false), sneak = !!under && V.INTERACTIVE.test(under.name);
        if (sneak) { b.setControlState('sneak', true); await sleep(60); }
        b.setControlState('jump', true);
        let placed = false;
        for (let i = 0; i < 30 && !placed; i++) {
            await sleep(50);
            if (b.entity.position.y > below.y + 1.12 && b.entity.velocity.y > -0.2) {
                // (the click is on the top face of the block under `below`; when that cell holds nothing solid (air, grass, snow: the bot is not where the plan had it, mid-jump after
                // a failed step up) the server puts the block INTO the clicked cell, one lower: registered there, else it was in nobody's list, bt075c w1/w2 "unregistered pumpkin")
                const sup = b.blockAt(new Vec3(below.x, below.y - 1, below.z), false), into = !sup || sup.boundingBox === 'empty' || PLACEABLE.test(sup.name) ? { x: below.x, y: below.y - 1, z: below.z } : below;
                if (!own) this._temp(into, 'pillar', item);          // before the click (the blueprint's own block is the build, not a temporary block)
                b._client.write('block_place', { hand: 0, location: new Vec3(below.x, below.y - 1, below.z), direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: (this.seq = (this.seq || 0) + 1) });
                b.swingArm(); placed = true;
            }
        }
        b.setControlState('jump', false);
        for (let i = 0; i < 30; i++) { await sleep(50); if (b.entity.onGround && b.entity.position.y >= c.y - 0.01) break; }
        if (sneak) b.setControlState('sneak', false);
        return feet(b).y === c.y;
    }

    /** Do one planned step from the cell before it. */
    async step(prev, s) {
        for (const d of s.dig || []) if (!(await this.dig(d))) return { ok: false, why: `dig ${d.x},${d.y},${d.z}` };
        if (s.move === 'walk') return (await this.walkTo(s)) ? { ok: true } : { ok: false, why: 'walk' };
        if (s.move === 'up') return (await this.walkTo(s, { jump: true })) ? { ok: true } : { ok: false, why: 'up' };
        if (s.move === 'drop') { const ok = await FG.allowing(this.bot, [{ x: s.x, z: s.z, depth: prev.y - s.y + 0.5 }], () => this.walkTo(s, { timeout: 3500 })); return ok ? { ok: true } : { ok: false, why: 'drop' }; }
        if (s.move === 'down') { for (let i = 0; i < 30 && feet(this.bot).y > s.y; i++) await sleep(50); return feet(this.bot).y === s.y ? { ok: true } : { ok: false, why: 'down' }; }
        if (s.move === 'pillar') {
            if (this.rules.onPillar) this.rules.onPillar(s);
            if (await this.pillar(s)) return { ok: true };
            this.badPillar.set(key(prev.x, prev.y, prev.z), Date.now() + 45000);          // (45 s: at two minutes it made 8 of the failed searches, [diag] ha19)
            const nm = (y) => { const q = this.bot.blockAt(new Vec3(prev.x, y, prev.z), false); return q ? q.name : '?'; };
            return { ok: false, why: `pillar (in ${nm(prev.y)}, under ${nm(prev.y - 1)}, over the head ${nm(prev.y + 2)})` };
        }
        if (s.move === 'bridge') {
            // sneak out over the edge (the body keeps 0.05 on the support), then click the support's side face toward the gap: its block goes under the next cell
            const b = this.bot, dx = s.x - prev.x, dz = s.z - prev.z, own = this.rules.buildBlock ? this.rules.buildBlock(s.place.x, s.place.y, s.place.z) : null, item = own || this.rules.temp();
            if (!item || !(await this.hold(item))) return { ok: false, why: 'bridge: no temporary block' };
            const edge = { x: prev.x + 0.5 + dx * LEAN, z: prev.z + 0.5 + dz * LEAN };
            b.setControlState('sneak', true);
            try {
                for (let i = 0; i < 60; i++) {
                    const p = b.entity.position, ex = edge.x - p.x, ez = edge.z - p.z;
                    if (Math.abs(ex * dx + ez * dz) < 0.04 || (ex * dx + ez * dz) < 0) break;
                    await b.look(Math.atan2(-dx, -dz), 0, true); b.setControlState('forward', true); await sleep(50);
                }
                b.setControlState('forward', false);
                await sleep(150);
                const p = b.entity.position, eye = [p.x, p.y + 1.27, p.z], sup = [prev.x, prev.y - 1, prev.z];
                const face = dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north';
                const plane = [sup[0] + 0.5 + dx * 0.4999, 0, sup[2] + 0.5 + dz * 0.4999];
                const hit = [dx ? plane[0] : sup[0] + 0.5, sup[1] + 0.5, dz ? plane[2] : sup[2] + 0.5];
                const r = P.rayFirst(P.botWorld(b), eye, hit);
                if (!r || r.cell[0] !== sup[0] || r.cell[1] !== sup[1] || r.cell[2] !== sup[2]) { this.badBridge.set(`${key(prev.x, prev.y, prev.z)}>${s.x},${s.z}`, Date.now() + 60000); const nm = (c) => { const q = b.blockAt(new Vec3(c[0], c[1], c[2]), false); return q ? q.name : '?'; }; return { ok: false, why: `bridge: the support side is not in sight (support ${nm(sup)}, the ray ${r ? `hit ${nm(r.cell)} at ${r.cell.join(',')}` : 'hit nothing'}, eye ${eye.map((v) => v.toFixed(2)).join(',')})` }; }
                await this.lookAtPoint(new Vec3(...hit));
                if (!own) this._temp(s.place, 'bridge', item);          // before the click
                b._client.write('block_place', { hand: 0, location: new Vec3(...sup), direction: V.FACE[face], cursorX: hit[0] - sup[0], cursorY: hit[1] - sup[1], cursorZ: hit[2] - sup[2], insideBlock: false, worldBorderHit: false, sequence: (this.seq = (this.seq || 0) + 1) });
                b.swingArm();
                await sleep(200);
            } finally {
                b.setControlState('forward', false);
                // no block came under the next cell: back onto the support before sneaking stops (released while leaning out, the bot fell, live 2026-11-22 sH2)
                const nb = b.blockAt(new Vec3(s.place.x, s.place.y, s.place.z), false);
                if (!nb || nb.boundingBox !== 'block') await this.walkTo(prev, { sneak: true, timeout: 1500 });
                b.setControlState('sneak', false);
            }
            const bb = b.blockAt(new Vec3(s.place.x, s.place.y, s.place.z), false);
            if (!bb || bb.boundingBox !== 'block') return { ok: false, why: 'bridge place' };
            return (await this.walkTo(s)) ? { ok: true } : { ok: false, why: 'bridge walk' };
        }
        if (s.move === 'sink') return this.sink(prev, s);
        return { ok: false, why: `unknown move ${s.move}` };
    }

    /** The sink move (plan): a temporary block under the block the bot stands on, clicked on that block's bottom face, then that block dug; the bot lands one lower. */
    async sink(prev, s) {
        const b = this.bot, under = s.sink, cell = s.place, item = this.rules.temp();
        if (!item || !(await this.hold(item))) return { ok: false, why: 'sink: no temporary block' };
        // over the middle of the block, then the look straight down (the server takes the click by reach; the face is the block's bottom one)
        await this.walkTo(prev, { sneak: true, timeout: 1500 });
        b.setControlState('sneak', true);
        try {
            await this.look(b.entity.yaw, -Math.PI / 2);
            this._temp(cell, 'pillar', item);          // before the click
            b._client.write('block_place', { hand: 0, location: new Vec3(under.x, under.y, under.z), direction: V.FACE.down, cursorX: 0.5, cursorY: 0, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: (this.seq = (this.seq || 0) + 1) });
            b.swingArm();
            let placed = false;
            for (let i = 0; i < 20 && !placed; i++) { await sleep(50); const nb = b.blockAt(new Vec3(cell.x, cell.y, cell.z), false); placed = !!nb && nb.boundingBox === 'block'; }
            if (!placed) { if (this.rules.onTempFail) this.rules.onTempFail(cell, 'sink: the server placed nothing under the floor'); return { ok: false, why: 'sink: nothing placed under the floor' }; }
            if (!(await this.dig(under))) return { ok: false, why: `sink: dig ${under.x},${under.y},${under.z}` };
            for (let i = 0; i < 30 && feet(b).y > s.y; i++) await sleep(50);
        } finally { b.setControlState('sneak', false); }
        const ok = feet(b).y === s.y; if (ok) PLANS.sinks++; else PLANS.sinkFailed++;
        return ok ? { ok: true } : { ok: false, why: 'sink: did not come down' };
    }

    /**
     * Follow a run of ground moves (walk, diagonal, up, drop) without stopping in between: steer at the next cell's centre, take it when within 0.35 (the last one: 0.15),
     * jump just before a step up. Ends when the bot leaves the run's cells (the caller plans again). Returns the index reached.
     */
    async follow(route, i0, i1, cancel, opts = {}) {
        // the run's planned drops: their columns are open to the fall guard while it is walked
        // (each only as deep as planned: a landing gone since the plan holds the body at the edge)
        const drops = []; for (let k = Math.max(1, i0); k <= i1; k++) if (route[k].move === 'drop') drops.push({ x: route[k].x, z: route[k].z, depth: route[k - 1].y - route[k].y + 0.5 });
        return drops.length ? FG.allowing(this.bot, drops, () => this._follow(route, i0, i1, cancel, opts)) : this._follow(route, i0, i1, cancel, opts);
    }
    async _follow(route, i0, i1, cancel, { breath = true } = {}) {
        const b = this.bot, cells = new Set(route.slice(Math.max(0, i0 - 1), i1 + 1).map((c) => key(c.x, c.y, c.z)));
        let i = i0, t0 = Date.now(), stuck = 0, lastD = Infinity;
        // cells beside a drop of four or more: walked sneaking, as a player does (momentum at a corner or at the end of a run carried bots over the edge: falls of 14-39 blocks,
        // two deaths on one Nether world, live 2026-11-22 sZ w6); sneaking stops at the edge
        const v = new View(b, this.rules);
        const deep = (x, y, z) => { if (!v.fits(x, y, z)) return false; for (let k = 1; k <= 4; k++) if (!v.free(x, y - k, z)) return false; return true; };
        const lavaAt = (x, y, z) => { const q = v.raw(x, y, z); return !!q && q.name === 'lava'; };
        // looked at again every tick, not cached: the crew digs the ground a route runs over while it is walked (three bots fell 50 blocks into lava through floors cleared
        // under a 50-cell route, live 2026-11-22 sI2 w6)
        const isEdgy = (c) => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dx, dz]) => deep(c.x + dx, c.y, c.z + dz) || lavaAt(c.x + dx, c.y - 1, c.z + dz) || lavaAt(c.x + dx, c.y, c.z + dz));
        const floorGone = (c) => { const q = b.blockAt(new Vec3(c.x, c.y - 1, c.z), false); return !!q && (q.boundingBox === 'empty' || q.name === 'lava') && q.name !== 'water'; };
        try {
            while (i <= i1 && !cancel.cancelled) {
                const c = route[i], last = i === i1, p = b.entity.position, dx = c.x + 0.5 - p.x, dz = c.z + 0.5 - p.z, d = Math.hypot(dx, dz);
                const f = feet(b);
                if (b.entity.onGround && !cells.has(key(f.x, f.y, f.z)) && !cells.has(key(f.x, f.y - 1, f.z)) && ![...cells].some((k) => { const [x, y, z] = k.split(',').map(Number); return Math.abs(x - f.x) <= 1 && Math.abs(z - f.z) <= 1 && Math.abs(y - f.y) <= 1; })) return { i, why: `off the route at ${f.x},${f.y},${f.z}` };
                v.cache.clear(); if (v.lavaNear) v.lavaNear.clear(); if (v.digC) v.digC.clear();
                if (breath && b.entity.isInWater && typeof b.oxygenLevel === 'number' && b.oxygenLevel <= 8) return { i, why: 'out of breath' };
                if (['walk', 'up', 'drop'].includes(route[i].move) && floorGone(c)) return { i, why: `the floor at ${c.x},${c.y - 1},${c.z} is gone` };
                // lava in the next cell or under it, whatever the plan saw (lava flows in seconds): stop and plan again
                if ([0, 1, -1].some((dy) => { const q = b.blockAt(new Vec3(c.x, c.y + dy, c.z), false); return !!q && (q.name === 'lava' || q.name === 'fire' || q.name === 'soul_fire'); })) return { i, why: `lava at ${c.x},${c.y},${c.z}` };
                if (d < (last ? 0.15 : 0.35) && (Math.abs(p.y - c.y) < 0.6 || (b.entity.isInWater && route[i].move === 'swim' && Math.abs(p.y - c.y) < 1.0))) { i++; t0 = Date.now(); stuck = 0; lastD = Infinity; continue; }
                if (Date.now() - t0 > 4000) { const nm = (dy) => { const q = b.blockAt(new Vec3(c.x, c.y + dy, c.z), false); return q ? q.name : '?'; }; return { i, why: `no progress toward ${c.x},${c.y},${c.z} (${route[i].move}; there ${nm(-1)}/${nm(0)}/${nm(1)}; bot at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ground ${b.entity.onGround})` }; }
                if (d > lastD - 0.005) stuck++; else stuck = 0;
                lastD = d;
                b.look(Math.atan2(-dx, -dz), 0, true);
                b.setControlState('forward', true);
                b.setControlState('sprint', false);
                const up = c.y > f.y && route[i].move === 'up', wet = b.entity.isInWater;
                // a step up is jumped only with room for the head, looked at now (a block put there since the plan, a slab or a trapdoor over the take-off: the head hit it, the jump
                // fell short and the bot came down beside its cell, owner 2026-11-24): the run ends and the plan is made again
                if (up && d < 1.4 && b.entity.onGround && (!v.free(f.x, f.y + 2, f.z) || !v.fits(c.x, c.y, c.z) || !v.stands(c.x, c.y - 1, c.z))) return { i, why: `no room to jump to ${c.x},${c.y},${c.z} (over the head ${(v.raw(f.x, f.y + 2, f.z) || {}).name || '?'}, there ${(v.raw(c.x, c.y, c.z) || {}).name || '?'}/${(v.raw(c.x, c.y + 1, c.z) || {}).name || '?'} on ${(v.raw(c.x, c.y - 1, c.z) || {}).name || '?'})` };
                // in water: up (jump) to rise or to stay at the surface, nothing to sink
                b.setControlState('jump', wet ? c.y >= f.y : ((up && d < 1.4 && b.entity.onGround) || (stuck > 6 && b.entity.onGround && c.y >= f.y)));
                // sneaking only where momentum can carry the body over: the end of a straight run or a turn, next to a drop of four or more, and always next to lava (sneaking along
                // every run that passed a pit made the crew crawl, owner 2026-11-23)
                const nx = route[i + 1], pv = route[i - 1], turn = !nx || !pv || (nx.x - c.x !== c.x - pv.x) || (nx.z - c.z !== c.z - pv.z);
                const hot = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => lavaAt(c.x + dx, c.y - 1, c.z + dz) || lavaAt(c.x + dx, c.y, c.z + dz));
                // beside a deadly fall (lava, the void, 20 down): always sneaking
                const fatal = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => v.free(c.x + dx, c.y - 1, c.z + dz) && v.deadly(c.x + dx, c.y - 1, c.z + dz));
                const careful = route[i].move !== 'drop' && route[i].move !== 'swim' && c.y >= f.y && (hot || fatal || ((last || turn) && d < 1.2 && (isEdgy(c) || isEdgy(f))));
                b.setControlState('sneak', careful || (last && d < 0.6 && route[i].move !== 'drop' && c.y >= f.y));          // a careful last step, but never before a drop (sneak stops at the edge)
                await sleep(50);
            }
        } finally { for (const k of ['forward', 'jump', 'sneak', 'sprint']) b.setControlState(k, false); }
        for (let k = 0; k < 10 && Math.hypot(b.entity.velocity.x, b.entity.velocity.z) > 0.03; k++) await sleep(50);
        return { i };
    }

    /**
     * Go to a cell `goal` accepts (or `to` itself). Plans, follows, re-plans when the bot leaves the plan (up to `tries`). { ok, why, steps }.
     */
    async goto(to, { goal = null, cancel = { cancelled: false }, tries = 6, maxNodes = 40000, box = null, lavaCost = 0, maxDrop: md = null, budgetMs = 4000 } = {}) {
        const g = goal || ((x, y, z) => x === to.x && y === to.y && z === to.z);
        let steps = 0, last = null;
        await this.unsink();
        // standing beside the top of its own pillar (the stance a route reached by its last step off that column): back onto it and down it before going anywhere else, whatever
        // asked for the walk (a bed, a hand-over, a trip ... went off without the step's release: a column of 6 stood 57 s while its bot walked 46 cells away, bt075b w3)
        { const f = feet(this.bot); if (!g(f.x, f.y, f.z)) await this.walkBack(cancel); }
        await this.unpillar(to, g, cancel);
        for (let t = 0; t < tries && !cancel.cancelled; t++) {
            const start = feet(this.bot);
            if (g(start.x, start.y, start.z)) return { ok: true, steps };
            const view = new View(this.bot, this.rules), temps = this.rules.temp() ? this.bot.inventory.items().filter((i) => i.name === this.rules.temp()).reduce((a, i) => a + i.count, 0) : 0;
            // the bot's own cell not loaded yet (after a teleport, a respawn): wait for the chunks
            if (view.kind(start.x, start.y, start.z) === 'unknown') { await sleep(1000, 'server: chunk not loaded'); continue; }
            const maxDrop = md ?? ((this.bot.health || 0) >= 16 ? 6 : 4);          // k: the floor k cells under the feet, a fall of k - 1 (three without damage)
            const route = (!box && !lavaCost && md === null && g(to.x, to.y, to.z) && this._fromFlood(start, to, temps)) || await plan(view, start, g, to, { maxNodes, temps, box, lavaCost, maxDrop, budgetMs });
            if (!route) {
                const l = plan.last || {};
                // which of the crew's rules made the search fail (at most once a minute per bot): the plan again without one rule at a time; the first that finds a way is logged
                if ((l.why === 'nodes' || l.why === 'time') && Date.now() - (this.diagAt || 0) > 300000) {          // (every five minutes per bot: five more searches each time)
                    this.diagAt = Date.now();
                    for (const drop of ['doomed', 'occupied', 'columnBusy', 'noPillar', 'noTemp']) {
                        if (!this.rules[drop]) continue;
                        const r2 = { ...this.rules }; delete r2[drop];
                        const o2 = {}, ok = await plan(new View(this.bot, r2), start, g, to, { maxNodes, temps, box, lavaCost, maxDrop, budgetMs: 1500, out: o2 });
                        if (ok) { this.log(`[diag] ${this.bot.username}: no way to ${to.x},${to.y},${to.z} with the crew's rules, a way of ${ok.length} steps without '${drop}'`); break; }
                    }
                }
                // nothing at all from where the bot believes it is (its picture of its own position is off: live 2026-11-22 the server had it on the chest, the bot a cell higher):
                // a jump lets the physics and the server's correction settle it, then plan again
                PZ.failed(`no way (${l.why})`);
                if (l.nodes <= 2 && t < tries - 1) { this.bot.setControlState('jump', true); await sleep(350, 'retry: jump to settle the position'); this.bot.setControlState('jump', false); await sleep(700, 'retry: jump to settle the position'); continue; }
                return { ok: false, nodes: l.nodes, region: l.region ? new Set(l.region.keys()) : null, why: `no plan (${l.why}, ${l.nodes} cells from ${start.x},${start.y},${start.z}${l.closest ? `, closest ${l.closest.x},${l.closest.y},${l.closest.z} (${l.closest.t} temps)` : ''}; ${temps} ${this.rules.temp()}; goal ${view.kind(to.x, to.y, to.z)}/${view.kind(to.x, to.y + 1, to.z)} over ${view.kind(to.x, to.y - 1, to.z)}${view.stands(to.x, to.y - 1, to.z) ? ' stands' : ''}${view.nearLava(to.x, to.y, to.z) ? ' lava' : ''})`, from: start, steps };
            }
            // the blocks the route stands on: the crew does not dig them while the bot walks (job, drive.js rules.onRoute)
            if (this.rules.onRoute) this.rules.onRoute(route);
            // the planned way for the in-game display (service/display.js draws it in the bot's colour)
            if (typeof this.bot.__onPhase === 'function') { try { this.bot.__onPhase({ phase: 'walk', cells: route.map((c) => [c.x, c.y, c.z]) }); } catch (_) { /* display only */ } }
            let i = 1, broke = false;
            while (i < route.length && !cancel.cancelled) {
                const s = route[i];
                // between two moves: the owner's hook (a colleague beside it waiting for items is served, pool.js), at most every two seconds
                if (this.between && Date.now() - (this.betweenAt || 0) > 2000) { this.betweenAt = Date.now(); try { await this.between(); } catch (_) { /* a hook never breaks the walk */ } }
                if (['walk', 'up', 'drop', 'swim'].includes(s.move) && !(s.dig && s.dig.length)) {
                    // off a temporary block of its own: one cell, then that block (and its column) is taken back from beside it before the walk goes on
                    const leaving = this._ownFloor(route[i - 1]);
                    let j = i; while (!leaving && j + 1 < route.length && ['walk', 'up', 'drop', 'swim'].includes(route[j + 1].move) && !(route[j + 1].dig && route[j + 1].dig.length)) j++;
                    this.note(`follow ${route[i - 1].x},${route[i - 1].y},${route[i - 1].z}->${route[j].x},${route[j].y},${route[j].z} (${j - i + 1} cells: ${route.slice(i, j + 1).map((c) => c.move[0]).join('')})`);
                    const r = await this.follow(route, i, j, cancel);
                    if (r.why === 'out of breath') { await this.surface(cancel); last = 'out of breath'; broke = true; break; }
                    steps += r.i - i;
                    if (r.i <= j) { last = r.why; broke = true; break; }
                    i = j + 1;
                    // (not off a tall column onto the stance beside its top: that column is the stance's way back down, walkBack at the release)
                    if (leaving && !route[i - 1].off) await this._behind(route[i - 2], route, i);
                    continue;
                }
                this.note(`${s.move} ${route[i - 1].x},${route[i - 1].y},${route[i - 1].z}->${s.x},${s.y},${s.z}${s.dig && s.dig.length ? ' dig' : ''}`);
                const r = await this.step(route[i - 1], s), at = feet(this.bot);
                if (!r.ok || at.x !== s.x || at.z !== s.z || at.y !== s.y) { last = r.ok ? `ended at ${at.x},${at.y},${at.z} not ${s.x},${s.y},${s.z} (${s.move})` : r.why; broke = true; break; }
                steps++; i++;
                // the block behind (a bridge, a pillar left sideways) is broken as the bot goes on, as a player does (owner 2026-11-23 V4, list 5 Large 1); a bridge's last step off
                // its own pillar's top is the stance's way back down: the column stays until the bot walks back onto it (drive.js release: the bridge block, then the column)
                const wayBack = (s.off || s.move === 'bridge') && i === route.length && this.mineHow && this.mineHow.get(key(route[i - 2].x, route[i - 2].y - 1, route[i - 2].z)) === 'pillar';
                if (s.move !== 'pillar' && s.move !== 'sink' && !wayBack) await this._behind(route[i - 2], route, i);
            }
            if (!broke && !cancel.cancelled) { const f = feet(this.bot); if (g(f.x, f.y, f.z)) return { ok: true, steps }; }
        }
        return { ok: false, why: last || 'cancelled', steps };
    }
}

module.exports = { PLANS, Mover, View, plan, feet, COST, LEAN, LEAN_DEPTH, leaveColumn };

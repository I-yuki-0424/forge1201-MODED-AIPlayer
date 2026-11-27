'use strict';
// One SURVIVAL bot of the crew: fetch what it needs from the materials containers (shulker boxes unpacked by hand), claim a stance and the tasks it can do from there, walk
// (or pillar, bridge, dig) to it, do them with a vanilla client's inputs (a dig at survival speed with the right tool, a click on a face it sees, a bucket, flint and steel),
// read every cell back, report. Nothing is made from nothing, nothing is moved by the server.
const { Vec3 } = require('vec3');
const S = require('./state');
const V = require('./vanilla');
const { Mover, View, feet } = require('./move');
const { seen, eyeOf, boxDist } = require('./world');
const { clicksFor, REPLACEABLE } = require('./survey');
const SUP = require('./supply');
const TB = require('../work/bot/tempblocks');
/** The kinds a bot may use as temporary blocks: the operator's only, on the test worlds (pumpkins); else the supply's list. Counted, kept and fetched by the same list (a bot with
 * 128 dirt of rubble counted as stocked fetched no pumpkins, and could pillar with neither: 0-8 pumpkins per bot after 15 minutes, tb1 w4). */
const tempKinds = () => { const o = TB.only(); return o.length ? o : SUP.TEMPS; };
const RC = require('./recover');
const { Pool } = require('./pool');
const PZ = require('./pauses');
const { runWorker } = require('../work/bot/worker');
// the crew's shared pool: bots hand items to each other on request (pool.js); BUILD_PEER=0 goes back to the chest only, with hand-backs
const PEER = process.env.BUILD_PEER !== '0';
const { FULL } = require('./job');

const PIT_STALL_MS = Number(process.env.BUILD_PIT_STALL_MIN || 15) * 60000;          // a pit with no unit finished this long is wrapped up (clearByPit)
const COST_LAVA = 60;                // escapes and evacuations may pass beside lava (never into it) at this cost per cell
const sleep = (ms, label = 'other: drive sleep') => PZ.sleep(ms, label);
const UNBREAKABLE = /^(bedrock|barrier|end_portal_frame|end_portal|end_gateway|nether_portal|command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|reinforced_deepslate|light)$/;
const CONTAINER = /(chest|barrel|shulker_box|hopper|dropper|dispenser|furnace|smoker|crafter|_bed|lectern|brewing_stand|decorated_pot|respawn_anchor)$/;
const FLUID = (h) => h && (h.name === 'water' || h.name === 'lava' || h.props.waterlogged === 'true');
const key = (x, y, z) => `${x},${y},${z}`;

/** The mover's rules for this job: what may be broken on the way (never a built cell of the box, a container, a supply site, next to a fluid), the temporary block. */
function rules(job, bot) {
    return {
        // `view` (the planner's): its cached blocks for the neighbours (six blockAt per check made this 55 % of all CPU in the Nether, profile fx4)
        canDig: (x, y, z, b, view = null) => {
            if (UNBREAKABLE.test(b.name) || CONTAINER.test(b.name)) return false;
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                if (view) { const q = view.raw(x + dx, y + dy, z + dz); if (q && (q.name === 'water' || q.name === 'lava' || String((q.getProperties() || {}).waterlogged) === 'true')) return false; }
                else if (FLUID(seen(bot, { x: x + dx, y: y + dy, z: z + dz }))) return false;
            }
            if (job.t.inside(x, y, z)) { const want = job.t.at(x, y, z), h = seen(bot, { x, y, z }); if (h && S.matches(want, h)) return false; }
            if (underCrew(job, bot, x, y, z) || onRouteOfOther(job, bot.username, x, y, z)) return false;
            return true;
        },
        // the temporary block: the supply's, or rubble the bot dug up (dirt, cobblestone, netherrack: what a player builds scaffolds with)
        // (the kind it carries most of: one dirt left beside 400 cobblestone made every pillar impossible, a crew sat under its stances for half an hour, live 2026-11-23 fz1 w2)
        // (the test worlds: only the operator's block, pumpkins, so the end scan sees every one: tempblocks.only)
        temp: () => { const n = {}, kinds = tempKinds(); for (const i of bot.inventory.items()) if (kinds.includes(i.name) && !job.t.items.has(i.name)) n[i.name] = (n[i.name] || 0) + i.count; let best = null; for (const [k, c] of Object.entries(n)) if (!best || c > n[best] || (c === n[best] && k === job.tempItem)) best = k; return best; },
        // another bot's temporary block (no drop lands on one: it may be gone when the bot arrives)
        isTemp: (x, y, z) => job.ledger.has({ x, y, z }),
        othersTemp: (x, y, z) => { const m = job.ledger.get({ x, y, z }); return !!m && m.by !== bot.username; },
        // another bot's pillar, bridge or scaffold block in use (a route over it kept its placer from taking it back, move.js)
        othersMove: (x, y, z) => { const m = job.ledger.get({ x, y, z }); return !!m && m.by !== bot.username && !m.orphan && (m.how === 'pillar' || m.how === 'bridge' || m.how === 'scaffold'); },
        ownTemp: (x, y, z) => { const m = job.ledger.get({ x, y, z }); return !!m && m.by === bot.username; },
        ownPillar: (x, y, z) => { const m = job.ledger.get({ x, y, z }); return !!m && m.by === bot.username && m.how === 'pillar' && !m.released; },
        mayDig: (x, y, z) => !underCrew(job, bot, x, y, z) && !onRouteOfOther(job, bot.username, x, y, z),
        // the item to climb or bridge with in cell (x, y, z) when the blueprint has a plain full block there and the bot carries it: the climb builds the structure
        buildBlock: (x, y, z) => { const it = ownBlockItem(job, x, y, z); if (!it) return null; return bot.inventory.items().some((i) => i.name === it) ? it : null; },
        // a block another bot is about to dig (its claim): not stood on by a plan
        // (only when that bot's stance is within reach of it: every block of the other bots' 64-task claims counted, and large parts of the ground dropped out of the plans:
        // 30 000-cell searches failed where a plan of 45 steps existed, probe 2026-11-24 ha18 w2)
        // (a temporary block due to be taken away is never stood on, whoever holds it: bots dropped onto such blocks as they went and fell 20, ha26 w3)
        doomed: (x, y, z) => { const k = `${x},${y},${z}`, t0 = job.tasks.get(k); if (t0 && t0.kind === 'untemp' && !(bot.__mine && bot.__mine.has(k)) && (job.ledger.get({ x, y, z }) || {}).by !== bot.username) return true; const by = job.claims.get(k); if (!by || by === bot.username) return false; const t = t0; if (!t || !(t.kind === 'clear' || t.kind === 'untemp')) return false; const o = job.bots.get(by), st = o && o.station && o.station[0]; return !!st && Math.abs(st.x - x) <= 5 && Math.abs(st.z - z) <= 5 && Math.abs(st.y - y) <= 6; },
        onRoute: (route) => { (job.routes || (job.routes = new Map())).set(bot.username, { floors: new Set(route.map((c) => `${c.x},${c.y - 1},${c.z}`)), until: Date.now() + 30000 }); },
        onRouteDone: () => { if (job.routes) job.routes.delete(bot.username); },
        // only near this bot (four cells): a body farther away moves before the bot gets there; every body on the map made the most failed searches ('occupied', [diag] ha19)
        occupied: (x, y, z) => { const p = bot.entity.position; if (Math.abs(x + 0.5 - p.x) > 4 || Math.abs(z + 0.5 - p.z) > 4 || Math.abs(y - p.y) > 4) return false; return crewAt(job, bot).some((q) => Math.floor(q.x) === x && Math.floor(q.z) === z && Math.floor(q.y + 0.16) === y); },
        // cells no temporary block may go into: a depot box's lid cell, the cells over the chests and the respawn anchor (a pillar block on a box's lid shut it for good)
        noTemp: (x, y, z) => (job.depot || []).some((d) => d.x + (d.fx || 0) === x && d.y + (d.fy ?? 1) === y && d.z + (d.fz || 0) === z) || (job.sites || []).some((c) => Math.abs(c.x - x) <= 1 && Math.abs(c.z - z) <= 1 && y === c.y + 1) || (!!job.anchorAt && job.anchorAt.x === x && job.anchorAt.z === z && job.anchorAt.y + 1 === y),
        columnBusy: (x, z) => { const c = job.columns && job.columns.get(`${x},${z}`); return !!c && c.by !== bot.username && c.until > Date.now(); },
        onPillar: (c) => { (job.columns || (job.columns = new Map())).set(`${c.x},${c.z}`, { by: bot.username, until: Date.now() + 20000 }); },
        // every temporary block registered before its click, confirmed by the server's block update (the ledger, temps.js)
        onTemp: (c, how, item) => { job.addTemp(c, how || 'temp', bot.username, item); const sv = touchesShape((x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z), false); return b && b.name; }, c.x, c.y, c.z); if (sv) { const n = job.ledger.n; n.shapes = n.shapes || {}; n.shapes[sv] = (n.shapes[sv] || 0) + 1; } },
        // a temporary block that changes a built block's shape (touchesShape): never (a cost of 60 left 11-15 such blocks in a progress line of tb2/tb4 on 1.21.1 world 4, each one
        // a flicker of the wire beside it twice, TASK-077's packet count); beside a cell where the blueprint still wants a wire or a pane: the cost (it may be gone before that is built)
        tempCost: (x, y, z, view) => (touchesShape((a, b, c) => { const q = view.raw(a, b, c); return q && q.name; }, x, y, z) ? Infinity : touchesShape(planned(job), x, y, z) ? SHAPE_COST : 0),
        onUntemp: (c) => { job.dropTemp(c); job.stats.untemp++; },
        onTempFail: (c, why) => { job.ledger.fail(c, why); },
    };
}

/**
 * Would a full block in cell (x, y, z) change the shape of a block beside it: a pane, bars, a wall or a fence connects to it (sideways), a redstone wire beside it or under it
 * re-routes (its side or step)? `nameAt(x, y, z)`: the block's name. Returns 'pane' | 'wire' | null. (owner list 5 Small 2: the flicker of glass and redstone was the builders'
 * temporary blocks going in and out beside them, TASK-077 flicker-fl1/fl2.)
 */
const CONNECTS = /(_pane|^iron_bars|_bars|_wall|_fence)$/;
/** The blueprint's block in a cell of the box (bare name), for touchesShape: the shapes still to be built. */
const planned = (job) => (x, y, z) => { if (!job.t.inside(x, y, z)) return null; const w = job.t.stateOf(job.t.idx(x, y, z)); return w ? S.bare(w.name) : null; };
const SHAPE_COST = 60;
function touchesShape(nameAt, x, y, z) {
    if (nameAt(x, y - 1, z) === 'redstone_wire') return 'wire';
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = nameAt(x + dx, y, z + dz) || '';
        if (CONNECTS.test(n)) return 'pane';
        if (n === 'redstone_wire' || nameAt(x + dx, y - 1, z + dz) === 'redstone_wire') return 'wire';
    }
    return null;
}

/**
 * What a bot keeps when it makes room: the blueprint's items and the supply's, and of the temporary kinds (dirt, cobblestone, netherrack ...) three stacks in all. Dirt is both the
 * supply's temporary block and the rubble of a hill: kept whole, 26 stacks of it filled the pack and every supply trip came back empty (live 2026-11-22 tr8).
 */
function keepRubble(job) {
    let temps = 320;          // five stacks (at three the crew threw away its blocks after clearing and stood at the chest without any: live 2026-11-23 ha11 w3)
    return (n, count) => {
        if (tempKinds().includes(n) && !job.t.items.has(n)) { if (temps <= 0) return false; temps -= count; return true; }
        return job.t.items.has(n) || job.available.has(n);
    };
}

/**
 * Does another bot of the crew stand on the block at (x, y, z), or on one of the two above it (live positions from the server, not those of the last claim)? Broken under it,
 * it falls (Nether crews fell 30-50 blocks off temporary blocks the clearing took away under them, live 2026-11-22 sJ2).
 */
/**
 * A clear task in the place stage digs a block of the build's own kind from a cell that wants another (b081w4: 107 clears while 113 glass went missing with no item on the ground:
 * glass dug without Silk Touch is gone). Counted by what was dug and what the cell wants (stats.clears), and an item the crew does not get back goes into job.lost (the ledger's
 * dug column); the first 40 are logged with the cell.
 */
function noteClear(job, name, bot, tk, h) {
    try {
        const hn = S.bare(h.name); if (!job.t.items.has(hn)) return;
        const w = job.t.wantOf(tk), wn = w ? S.bare(w.name) : 'outside', st = job.stats.clears || (job.stats.clears = {}), k = `${hn}>${wn}`;
        st[k] = (st[k] || 0) + 1;
        const back = RC.getBack(bot, hn, hn).ok;
        if (!back) (job.lost || (job.lost = new Map())).set(hn, ((job.lost && job.lost.get(hn)) || 0) + 1);
        if ((job.clearLog = (job.clearLog || 0) + 1) <= 40) job.log(`${name}: clears ${hn} from ${tk.k} (wants ${wn})${back ? '' : ', not got back'}${tk.stageAs ? ` [${tk.stageAs}]` : ''}`);
    } catch (_) { /* counting only */ }
}

/** Does any body the bot sees (its own, a crew member's, any player's) reach into cell c (a player's box: 0.6 wide, 1.8 high)? */
function bodyIn(bot, c) {
    const ps = Object.values(bot.players || {}).map((p) => p && p.entity && p.entity.position).filter(Boolean);
    if (bot.entity && bot.entity.position && !ps.includes(bot.entity.position)) ps.push(bot.entity.position);
    return ps.some((q) => q.x + 0.3 > c.x && q.x - 0.3 < c.x + 1 && q.z + 0.3 > c.z && q.z - 0.3 < c.z + 1 && q.y + 1.8 > c.y && q.y < c.y + 1);
}

function underCrew(job, bot, x, y, z) {
    for (const p of Object.values(bot.players || {})) {
        if (!p || !p.entity || p.username === bot.username || !job.bots.has(p.username)) continue;
        const q = p.entity.position;
        if (Math.abs(q.x - (x + 0.5)) < 0.8 && Math.abs(q.z - (z + 0.5)) < 0.8 && q.y >= y + 0.5 && q.y <= y + 3.2) return true;
    }
    return false;
}

/** What bounds a region of reachable cells: the blocks next to its cells that are not in it, by kind (for the log). */
function edgeOf(mv, cells) {
    const v = mv.view(), by = {};
    let n = 0;
    for (const k of cells) {
        if (n > 4000) break;
        const [x, y, z] = k.split(',').map(Number);
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
            const q = `${x + dx},${y + dy},${z + dz}`; if (cells.has(q)) continue; n++;
            const b = v.raw(x + dx, y + dy, z + dz), kd = v.kind(x + dx, y + dy, z + dz), w = `${kd}:${b ? b.name : '?'}${kd === 'solid' && !v.diggable(x + dx, y + dy, z + dz) ? '(keep)' : ''}${v.nearLava(x + dx, y + dy, z + dz) ? '(lava)' : ''}`;
            by[w] = (by[w] || 0) + 1;
        }
    }
    return JSON.stringify(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10));
}

/** Does the block at (x, y, z) hold back a fluid (water or lava beside or over it)? Never dug, not even on the way out (an escape dug into lava: five deaths, live 2026-11-23 ge1 w4). */
function holdsFluid(bot, x, y, z, view = null) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
        const q = view ? view.raw(x + dx, y + dy, z + dz) : bot.blockAt(new Vec3(x + dx, y + dy, z + dz), false);
        if (q && (q.name === 'water' || q.name === 'lava' || String((q.getProperties() || {}).waterlogged) === 'true')) return true;
    }
    return false;
}

/** Lava that can run (an open cell beside or under it) within r (Chebyshev) of cell c, read now from the world; lava sealed in rock does not count. */
function lavaWithin(bot, c, r) {
    const p = new Vec3(0, 0, 0), q2 = new Vec3(0, 0, 0);
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        p.x = c.x + dx; p.y = c.y + dy; p.z = c.z + dz; const q = bot.blockAt(p, false); if (!q || q.name !== 'lava') continue;
        for (const [ex, ey, ez] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) { q2.x = p.x + ex; q2.y = p.y + ey; q2.z = p.z + ez; const o = bot.blockAt(q2, false); if (o && o.boundingBox === 'empty' && o.name !== 'lava') return true; }
    }
    return false;
}

/** The item of a plain full block (no state of its own: smooth stone, glass, obsidian ...) the blueprint has in cell (x, y, z), or null. */
function ownBlockItem(job, x, y, z) {
    if (!job.t.inside(x, y, z)) return null;
    const i = job.t.idx(x, y, z); if (job.t.isAir(i)) return null;
    const w = job.t.stateOf(i), n = S.bare(w.name);
    if (!FULL.test(n) || Object.keys(S.decidedProps(w.name, w.props) || {}).length) return null;
    const r = job.t.recipe[i]; return r && r.item && !r.deps.length ? r.item : r && r.item && r.deps.every((d) => d[1] === -1 && d[0] === 0 && d[2] === 0) ? r.item : null;
}

/** Is (x, y, z) a block another bot's current route stands on (planned in the last 30 s)? */
function onRouteOfOther(job, me, x, y, z) {
    if (!job.routes) return false;
    const k = `${x},${y},${z}`, now = Date.now();
    for (const [n, r] of job.routes) if (n !== me && r.until > now && r.floors.has(k)) return true;
    return false;
}

/**
 * Dig out a built block for a closed-in cell (task tk, the block h): with the tool that gives it back as its own item (recover.js), then onto its drop if it lies in a cell the
 * bot can step into. A block that does not come back is counted as lost (job.lost: the spare the next dig-out may use is smaller).
 */
async function unblockDig(job, name, bot, mv, tk, h) {
    const item = (job.t.recipeOf(tk) || {}).item, rc = item ? RC.getBack(bot, h.name, item) : { ok: false, why: 'no item' }, before = (SUP.carried(bot)[item] || 0);
    const ok = await mv.dig(tk, rc.ok ? { tool: rc.tool } : {});
    if (!ok || !item) return ok;
    // the drop: picked up where the bot stands within a moment, else walked to (beside it is enough: a body picks up within a cell), twice (soul sand and a composter lay in
    // the dug cell out of reach and were counted lost, live 2026-11-25 hd1)
    const has = () => (SUP.carried(bot)[item] || 0) > before;
    for (let i = 0; i < 12 && !has(); i++) await sleep(150);
    for (let k = 0; k < 2 && !has(); k++) {
        const drop = Object.values(bot.entities).filter((e) => e.name === 'item' && Math.hypot(e.position.x - (tk.x + 0.5), e.position.y - tk.y, e.position.z - (tk.z + 0.5)) < 4).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (!drop) break;
        const c = { x: Math.floor(drop.position.x), y: Math.floor(drop.position.y + 0.2), z: Math.floor(drop.position.z) };
        await mv.goto(c, { goal: (x, y, z) => Math.abs(x - c.x) <= 1 && Math.abs(z - c.z) <= 1 && y >= c.y - 1 && y <= c.y, maxNodes: 2000, tries: 1 });
        for (let i = 0; i < 10 && !has(); i++) await sleep(150);
    }
    const back = (SUP.carried(bot)[item] || 0) > before;
    // (a dig-out that counted on a spare took it already, job._unblock: given back when the block came back anyway)
    const L = job.lost || (job.lost = new Map());
    if (!back && !tk.loses) L.set(item, (L.get(item) || 0) + 1); else if (back && tk.loses) L.set(item, Math.max(0, (L.get(item) || 0) - 1));
    job.log(`${name}: unblock dug ${S.bare(h.name)} at ${tk.k} with ${rc.ok ? (rc.tool ? rc.tool.name : 'the hand') : `the best tool (${rc.why})`}: ${back ? 'got it back' : `not got back (${item} lost ${L.get(item) || 0})`}`);
    return ok;
}

/** The live positions of the other bots of the crew. */
function crewAt(job, bot) {
    const out = [];
    for (const p of Object.values(bot.players || {})) if (p && p.entity && p.username !== bot.username && job.bots.has(p.username)) out.push(p.entity.position);
    return out;
}

/** Is task tk's cell right now? */
function holds(job, bot, tk) {
    const h = seen(bot, tk);
    if (!h) return { ok: false, why: 'not loaded' };
    if (tk.kind === 'seal' || tk.kind === 'fill') return !FLUID(h) && !/^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/.test(h.name) ? { ok: true } : { ok: false, why: `still ${h.name}` };
    if (tk.kind === 'clear' || tk.kind === 'untemp') return S.AIR.has(h.name) ? { ok: true } : { ok: false, why: `still ${h.name}` };
    if (tk.kind === 'scaffold') return !S.AIR.has(h.name) && !FLUID(h) ? { ok: true } : { ok: false, why: `still ${h.name}` };
    if (tk.kind === 'ignite' && tk.portal) { const p = seen(bot, tk.portal.at); return p && p.name === 'nether_portal' ? { ok: true } : { ok: false, why: `portal not lit (${p && p.name})` }; }
    const want = job.t.wantOf(tk);
    if (S.matches(want, h) || S.dynamicPair(want, h)) return { ok: true };
    return { ok: false, why: `got ${S.str(h.name, S.decidedProps(h.name, h.props))}` };
}

/** A click with the held item: look at the hit point (the server applies a look a tick after it arrives), then the use packet. */
async function click(mv, way) { if (way.lean) await mv.lean(way.lean[0], way.lean[1]); try { await mv.click(way.n || way.at, way.face, way.hit, { sneak: !!way.sneak, keepSneak: !!way.lean, aim: way.aim || null }); } finally { if (way.lean) await mv.unlean(); } }

/** Do one claim from its stance. Returns results for job.report. */
async function work(job, name, bot, mv, cl, cancel) {
    const results = [];
    const tw = Date.now();
    // (a search to a stance gets 1.5 s of CPU: the claim offers stances inside the bot's flood first, and a hopeless search to one outside it ran to the 4 s budget, the
    // largest share of the pauses after a failure in b081a: 'retry: plan', 40 pauses of 8 s in ten minutes)
    // (in the tail, a few hundred tasks left and most of the crew idle, the CPU is free and the last cells are stances high in the air whose routes need more: b081w4's last 53
    // cells were parked after 'no plan (time, 13-29 thousand cells)' while 1 100 claims a minute found nothing; there it gets 6 s and 80 000 cells)
    // (a container's contents too: a closed one is set before its last face is placed or never, and the walks to them in the owner's Nether box, 20-30 cells down from the
    // supply, were parked after 'no plan (time, 18-22 thousand cells)', b081x5)
    // (and a claim whose cells failed before: b081z5's tail (mineflayer, 1.21.1) parked cells 30-40 above the chest after 8 tries, every one 'no plan (time, 12-19 thousand
    // cells)' with 450-500 tasks left, just over the tail's line)
    const tail = job.tasks.size < 400 || cl.tasks.some((tk) => tk.kind === 'contents' || (job.fails && (job.fails.get(tk.k) || 0) > 0));
    const r = await mv.goto(cl.station, { cancel, maxNodes: tail ? 80000 : 30000, budgetMs: tail ? 6000 : 1500 });
    job.time.walk += Date.now() - tw;
    if (!r.ok) {
        // a stance the bot cannot get to counts against its tasks (as 'skipped' they came back for ever: live 2026-11-22 sD w2, 22 tree tops for 40 minutes)
        for (const tk of cl.tasks) results.push({ tk, ok: false, why: `no way to the stance ${cl.station.x},${cl.station.y},${cl.station.z} (${r.why})` });
        // decided at once, not after a count of failures (owner 2026-11-23: retrying, then escaping upward, wasted most of the time): a search that found next to no cells means
        // the bot is closed in (it digs out sideways now); otherwise the stance is out of this bot's reach and is not offered to it again for three minutes
        const n = (job.noPath.get(name) || 0) + 1; job.noPath.set(name, n);
        job.log(`${name}: no way to ${cl.station.x} ${cl.station.y} ${cl.station.z} (${r.why}, ${n} in a row)`);
        job.avoid(name, cl.station);
        // a search that ran out (nodes, time) to a stance in the air rules out its neighbours for this bot too: the claim offered the next cell beside it and the bot searched
        // again for as long (b081f minutes 60-78: 79 'retry: plan' pauses of 11 s, stances 12-30 above the bot that no route of the crew's rules reaches)
        if (/no plan \((nodes|time)/.test(String(r.why))) for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) job.avoid(name, { x: cl.station.x + dx, y: cl.station.y + dy, z: cl.station.z + dz });
        // searched out: the cells it can reach from here are known; claims offer it only stances among them until it moves (a bot in a pocket ringed by lava was sent 27 times
        // to stances outside it, live 2026-11-23 fy3 w5)
        if (r.region && r.from) (job.reachOf || (job.reachOf = new Map())).set(name, { from: `${r.from.x},${r.from.y},${r.from.z}`, cells: r.region });
        if (n >= 2) tell(job, name, bot, 'stuck', `no way to ${cl.station.x} ${cl.station.y} ${cl.station.z} (${String(r.why).slice(0, 90)}), ${n} in a row`);
        if (r.nodes !== undefined && r.nodes < 80) { job.noPath.set(name, 0); await escape(job, name, bot, mv, cancel); }
        // wedged: the walk makes no progress and the body is off the ground (a gap too low for the body: the server's crawl pose, which the bot's physics does not know;
        // owner 2026-11-23 V1 and Bd4f boxed in by glass): the cells round the head are dug out (whatever they are; the survey puts built cells back) and it jumps
        if (/no progress/.test(String(r.why)) && bot.entity && !bot.entity.onGround && !bot.entity.isInWater) await unwedge(job, name, bot, mv);
        return results;
    }
    job.noPath.set(name, 0);
    // a stance on its own bridge block beside its pillar's top: the column's top is the stance when every task is done from there (two-per-bot: the column left beside it
    // was the largest cause of columns left in b081w4/w5); the bridge block is dug from it
    if (cl.tasks.length && typeof mv.ontoColumn === 'function') {
        const world = require('./place').botWorld(bot), same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
        const from = (t, b) => cl.tasks.every((tk) => { if (same(tk, b) || (tk.x === t.x && tk.z === t.z && tk.y >= t.y - 1 && tk.y <= t.y + 1)) return false; const w = job._way(world, tk, t); return !!w && !(w.n && w.n[0] === b.x && w.n[1] === b.y && w.n[2] === b.z); });
        if (await mv.ontoColumn(from)) job.stats.ontoColumn = (job.stats.ontoColumn || 0) + 1;
    }
    const here = feet(bot), at = (tk) => tk.way;
    const done = [];
    for (const tk of cl.tasks) {
        if (cancel.cancelled) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        // a colleague who asked for items and has come up: thrown over between two tasks (the giver stays at its stance)
        if (job.pool) await job.pool.serve(name);
        // the stance moved (a pillar ends a cell off): the way is found again from where the bot stands
        let way = at(tk);
        if (here.x !== cl.station.x || here.y !== cl.station.y || here.z !== cl.station.z) way = job._way(require('./place').botWorld(bot), tk, here);
        const h = seen(bot, tk);
        if (!h || !way) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        // in the death report's trace too (30 of ha30's 54 deaths showed a pillar as the last move: what the bot did at the stance was not in it)
        mv.note(`task ${tk.kind} ${tk.k}${way.lean ? ` lean ${way.lean.join(',')}` : ''}${way.sneak ? ' sneak' : ''}`);
        // never the block the body stands on or lands on: the first solid block under the feet in its own column, the cells between free (b081q4: Bd4g dug its pillar's top,
        // and before its position came down one an untemp task dug the bridge block it was landing on, 'below the feet' by the stale position: a fall of 39 to its death)
        { const me = feet(bot); if (!tk.descend && (tk.kind === 'clear' || tk.kind === 'untemp') && tk.x === me.x && tk.z === me.z && tk.y < me.y && [...Array(Math.max(0, me.y - 1 - tk.y)).keys()].every((i) => { const q = bot.blockAt(new Vec3(tk.x, tk.y + 1 + i, tk.z), false); return !q || q.boundingBox === 'empty'; })) { results.push({ tk, ok: false, why: 'skipped' }); continue; } }
        // nor a block under any corner of the body (a bot at the edge of its cell stands on the neighbour too: b081y4 Bd4c dug the block beside its feet at y 119, which carried
        // it, and fell 48 cells)
        if (!tk.descend && (tk.kind === 'clear' || tk.kind === 'untemp') && underBody(bot, tk)) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        // a temporary block with a crew member anywhere above it in its column is not taken (a pillar dug out under a bot on its top: falls of 40 blocks, live 2026-11-23 fy3)
        if (tk.kind === 'untemp' && !(job.ledger.get(tk) || {}).wetOk && [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]].some(([dx, dy, dz]) => FLUID(seen(bot, { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz })))) { results.push({ tk, ok: false, why: 'skipped' }); continue; }          // it holds back a fluid now
        if (tk.kind === 'untemp' && crewAt(job, bot).concat(tk.descend ? [] : [bot.entity.position]).some((q) => Math.floor(q.x) === tk.x && Math.floor(q.z) === tk.z && q.y > tk.y && q.y < tk.y + 90)) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        // lava within two of the cell or of the bot, now (it runs in through cells opened a moment ago, from a pool two or three away: seven deaths in clearing batches,
        // live 2026-11-23 gf1 w5/w6): the rest of the claim is dropped and the bot steps away from it
        if ((tk.kind === 'clear' || tk.kind === 'untemp') && (lavaWithin(bot, tk, 2) || lavaWithin(bot, feet(bot), 2))) {
            for (const rest of cl.tasks.slice(cl.tasks.indexOf(tk))) results.push({ tk: rest, ok: false, why: 'skipped' });
            const f0 = feet(bot); job.log(`${name}: lava near ${tk.x},${tk.y},${tk.z}: the claim is dropped`);
            await mv.goto(f0, { goal: (x, y, z) => Math.hypot(x - f0.x, z - f0.z) >= 3 && !lavaWithin(bot, { x, y, z }, 3), cancel, maxNodes: 4000, tries: 1 });
            break;
        }
        // a column of temporary blocks dug down from on its top (no stance beside it: the claim put the bot on it)
        if (tk.kind === 'untemp' && tk.descend) { const n0 = job.stats.untemp; await mv.unpillar(null, () => false, cancel, { any: true }); results.push({ tk, ...holds(job, bot, tk) }); job.log(`${name}: dug the column at ${tk.x},${tk.z} down from its top (${job.stats.untemp - n0} blocks)`); continue; }
        if (tk.kind === 'clear' && tk.unblock && !S.AIR.has(h.name)) {
            // a built block dug out to open a closed-in cell: with the tool that gives it back, and picked up (job._unblock, recover.js)
            if (underCrew(job, bot, tk.x, tk.y, tk.z) || onRouteOfOther(job, name, tk.x, tk.y, tk.z)) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
            const td = Date.now(); await unblockDig(job, name, bot, mv, tk, h); job.time.dig += Date.now() - td; done.push(tk); continue;
        }
        // (never a block of its own pillar while its step lasts, dug from beside by a clear task: the top went and the rest stood, bt075c w2 "task clear 67,72,9 / dig pumpkin")
        if ((tk.kind === 'clear' || tk.kind === 'untemp') && !S.AIR.has(h.name)) { const own = job.ledger.get(tk); if (own && own.by === name && own.how === 'pillar' && !own.released && !(feet(bot).x === tk.x && feet(bot).z === tk.z)) { results.push({ tk, ok: false, why: 'skipped' }); continue; } }
        if (tk.kind === 'clear' || tk.kind === 'untemp') { if (S.AIR.has(h.name)) { results.push({ tk, ok: true }); continue; } if (underCrew(job, bot, tk.x, tk.y, tk.z) || onRouteOfOther(job, name, tk.x, tk.y, tk.z)) { results.push({ tk, ok: false, why: 'skipped' }); continue; } if (tk.kind === 'clear') noteClear(job, name, bot, tk, h); const td = Date.now(); await mv.dig(tk); job.time.dig += Date.now() - td; done.push(tk); continue; }
        // seals, fills and scaffolds are temporary blocks too: registered before the click (a scaffold in a box cell was in no list and stood to the end, hc1)
        if (tk.kind === 'seal' || tk.kind === 'fill' || tk.kind === 'scaffold') { const it = mv.rules.temp() || job.tempItem; if (!(await mv.hold(it))) { results.push({ tk, ok: false, why: 'skipped' }); continue; } job.addTemp(tk, tk.kind, name, it); await click(mv, way); done.push(tk); continue; }
        if (tk.kind === 'fix') { await mv.holdNothing(); await mv.click([tk.x, tk.y, tk.z], way.click.face, way.click.hit); for (let k = 1; k < tk.clicks; k++) await mv.click([tk.x, tk.y, tk.z], way.click.face, way.click.hit); done.push(tk); continue; }
        if (tk.kind === 'ignite') { if (!(await mv.hold('flint_and_steel'))) { results.push({ tk, ok: false, why: 'skipped' }); continue; } await mv.click([way.light.x, way.light.y, way.light.z], 'up', way.click.hit); await sleep(300); done.push(tk); continue; }
        // a container's goal: its slots set from the pack through the action layer's instruction (set_contents: the screen opened with the use key, the clicks on the game's
        // rules, graded from the window the server sends back); from the stance, it never walks
        if (tk.kind === 'contents') { results.push(await setContents(job, name, bot, mv, tk)); continue; }
        if (tk.kind === 'pour') { const ok = await pour(job, bot, mv, tk); results.push(ok ? holds(job, bot, tk) : { ok: false, why: 'no ray into the cell' }); continue; }
        if (tk.kind === 'place') {
            const rr = job.t.recipeOf(tk);
            if (S.matches(job.t.wantOf(tk), h)) { results.push({ tk, ok: true }); continue; }
            // never into a block of its own pillar while its step lasts: the build's block on the pillar's top took the bot's way back and stranded the column under it (columns of
            // 7 and 8 under a placed block, bt075b w1 "walkBack 0"); the cell is built once the pillar is gone
            // (nor into the two cells over its top: the bot's way back onto it, bt075c w3 "a column of 7 ... task place 72,74,28" over the top 72,72,28)
            { const mineP = (y) => { const e = job.ledger.get({ x: tk.x, y, z: tk.z }); return !!e && e.by === name && e.how === 'pillar' && !e.released; };
              if (mineP(tk.y) || ((mineP(tk.y - 1) || mineP(tk.y - 2)) && !(feet(bot).x === tk.x && feet(bot).z === tk.z))) { results.push({ tk, ok: false, why: 'skipped' }); continue; } }
            if (!(S.AIR.has(h.name) || REPLACEABLE.test(h.name) || h.name === 'water' || h.name === 'lava')) { await mv.dig(tk); }
            if (!(await mv.hold(rr.item))) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
            // never the block that leaves the bot's own cell without a way out (Bd4f set glass on all four sides on a piston, as the blueprint has it, and was shut in: owner
            // 2026-11-23); that block is placed from another stance
            // (nor the block that closes the last way out of the space a crew member is in: it waits until nobody is inside)
            if (PZ.sync('closes-in flood', () => { const t0 = Date.now(), r = closesIn(job, bot, tk); const st = job.stats.closeFloods || (job.stats.closeFloods = { n: 0, ms: 0 }); st.n++; st.ms += Date.now() - t0; return r; })) { job.stats.closeWaits = (job.stats.closeWaits || 0) + 1; results.push({ tk, ok: false, why: 'skipped' }); continue; }
            if (shutsIn(bot, tk) || crewAt(job, bot).some((q) => shutsInAt(bot, { x: Math.floor(q.x), y: Math.floor(q.y + 0.16), z: Math.floor(q.z) }, tk))) { results.push({ tk, ok: false, why: 'skipped' }); continue; }          // (any crew member: bots were boxed in by the others' blocks, ha26 w4)
            // a wire or a pane is not built beside a temporary block that stands (its removal would change the shape: bt075c w1 built 4 wires so): it waits until the block is gone
            { const wn = S.bare((job.t.wantOf(tk) || {}).name || ''); if (wn === 'redstone_wire' || CONNECTS.test(wn)) { const at = (x, y, z) => { if (x === tk.x && y === tk.y && z === tk.z) return wn; const b = bot.blockAt(new Vec3(x, y, z), false); return b && b.name; }; let near = false; for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++) for (let dz = -1; dz <= 1 && !near; dz++) { const e = job.ledger.get({ x: tk.x + dx, y: tk.y + dy, z: tk.z + dz }); if (e && e.state === 'placed' && touchesShape(at, e.x, e.y, e.z)) near = true; } if (near) { results.push({ tk, ok: false, why: 'skipped' }); continue; } } }
            // a bed that came out as air (159 parks "got minecraft:air" on beds in hc1/hd1): what its head cell held, who stood in the foot cell, the look sent (logged at the read-back)
            if (/_bed$/.test(rr.item)) { const f = (job.t.wantOf(tk).props || {}).facing, v = V.VEC[f] || [0, 0, 0], hc = seen(bot, { x: tk.x + v[0], y: tk.y, z: tk.z + v[2] }); tk._bed = { head: hc ? hc.name : '?', way: `${way.face} on ${(way.n || []).join(',')} look ${(way.look || []).map((q) => q.toFixed(2)).join(',')}${way.aim ? ` aim yaw ${way.aim.yaw.toFixed(2)}` : ''}`, yaw: bot.entity.yaw.toFixed(2), bodies: Object.values(bot.entities).filter((e) => e.type === 'player' && Math.floor(e.position.x) === tk.x && Math.floor(e.position.z) === tk.z && Math.abs(e.position.y - tk.y) < 1.8).map((e) => e.username).join('+') || 'none', at: feet(bot) }; }
            // the clicked block must still stand when the click goes: the server puts a block into the clicked cell itself when that cell is replaceable (air: a scaffold or a
            // temporary block taken away since the way was chosen, by this bot's release or another's untemp), so the block landed one cell off (b081m: slabs under their layer,
            // glass and a piston one cell beside their own); nor a block another bot is taking away now
            // a two-cell block (a bed's head, a door's upper half) while any body is in its other cell: the server sets that half regardless and the body is embedded in it
            // (owner 2026-11-27, b081r4 world 4: a bot's feet in a bed it placed itself, it jumped and pushed until it came free)
            if (rr.room && rr.room.some((d) => bodyIn(bot, { x: tk.x + d[0], y: tk.y + d[1], z: tk.z + d[2] }))) { job.stats.roomBody = (job.stats.roomBody || 0) + 1; results.push({ tk, ok: false, why: 'skipped' }); continue; }
            if (way.n) {
                const [nx, ny, nz] = way.n, nk = `${nx},${ny},${nz}`, ot = job.tasks.get(nk);
                const isGone = () => { const q = bot.blockAt(new Vec3(nx, ny, nz), false); return !q || S.AIR.has(q.name) || q.name === 'water' || q.name === 'lava' || REPLACEABLE.test(q.name); };
                // (a block this bot has just put down, the one before in its row, may not be back from the server yet: a moment for it)
                let gone = isGone(); for (let i = 0; gone && i < 8 && done.some((d) => d.k === nk); i++) { await sleep(50, 'server: the clicked block'); gone = isGone(); }
                if (gone) job.stats.clickGoneWhy = Object.assign(job.stats.clickGoneWhy || {}, { [done.some((d) => d.k === nk) ? 'own' : ot ? ot.kind : 'other']: ((job.stats.clickGoneWhy || {})[done.some((d) => d.k === nk) ? 'own' : ot ? ot.kind : 'other'] || 0) + 1 });
                const leaving = ot && (ot.kind === 'untemp' || ot.kind === 'clear' || ot.kind === 'scaffold') && job.claims.has(nk) && job.claims.get(nk) !== name;
                if (gone || leaving) { job.stats.clickGone = (job.stats.clickGone || 0) + 1; results.push({ tk, ok: false, why: 'skipped' }); continue; }
            }
            // the cells round it before the click: a block that lands in one of them instead (b081m: 9 cells of the build's blocks one cell off their place) is seen at the read-back
            { const nb = new Map(); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { if (!dx && !dy && !dz) continue; const q = bot.blockAt(new Vec3(tk.x + dx, tk.y + dy, tk.z + dz), false); nb.set(`${tk.x + dx},${tk.y + dy},${tk.z + dz}`, q ? q.name : '?'); } tk._near = { nb, way: `${way.face} on ${(way.n || []).join(',')} hit ${(way.hit || []).map((v) => v.toFixed(2)).join(',')}${way.under ? ' under the feet' : ''} from ${feet(bot).x},${feet(bot).y},${feet(bot).z}` }; }
            const tp = Date.now(); await click(mv, way); job.time.place += Date.now() - tp;
            // a wire or a pane built beside a temporary block that stands all the same (one placed after the check): counted, temps.shapesLate
            { const wn = S.bare((job.t.wantOf(tk) || {}).name || ''); if (wn === 'redstone_wire' || CONNECTS.test(wn)) { const at = (x, y, z) => { if (x === tk.x && y === tk.y && z === tk.z) return wn; const b = bot.blockAt(new Vec3(x, y, z), false); return b && b.name; }; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const e = job.ledger.get({ x: tk.x + dx, y: tk.y + dy, z: tk.z + dz }); if (e && e.state === 'placed' && touchesShape(at, e.x, e.y, e.z)) { const n = job.ledger.n; n.shapesLate = n.shapesLate || {}; const kk = wn === 'redstone_wire' ? 'wire' : 'pane'; n.shapesLate[kk] = (n.shapesLate[kk] || 0) + 1; } } } }
            // clicks after the placement (note, delay, mode, open), counted from what the cell holds now
            await sleep(120, 'server: block update after a click');
            const now = seen(bot, tk), fx = now ? clicksFor(job.t.wantOf(tk), now) : null;
            // (a block placed under the feet is clicked there too: its top face, by reach, as the placement was; a trapdoor's opening)
            if (fx) { const ff = feet(bot), c = require('./place').clickable(require('./place').botWorld(bot), tk, ff) || (way.under && ff.x === tk.x && ff.z === tk.z && ff.y === tk.y + 2 ? { face: 'up', hit: [tk.x + 0.5, tk.y + 0.99, tk.z + 0.5] } : null); if (c) { await mv.holdNothing(); for (let k = 0; k < fx.clicks; k++) await mv.click([tk.x, tk.y, tk.z], c.face, c.hit); } }
            done.push(tk);
        }
    }
    await sleep(250, 'server: read back');
    for (const tk of done) {
        const h = holds(job, bot, tk); results.push({ tk, ok: h.ok, why: h.why });
        if (!h.ok && tk._near) {
            const wn = S.bare(job.t.wantOf(tk).name), moved = [];
            for (const [k, was] of tk._near.nb) { const [x, y, z] = k.split(',').map(Number), q = bot.blockAt(new Vec3(x, y, z), false); if (q && q.name !== was && S.bare(q.name) === wn && !(job.t.inside(x, y, z) && S.bare(job.t.stateOf(job.t.idx(x, y, z)).name) === wn)) moved.push(`${k} (was ${was})`); }          // (not a cell that wants that block: another bot's placing there)
            if (moved.length) { job.stats.misplaced = (job.stats.misplaced || 0) + 1; if (job.stats.misplaced <= 40) job.log(`[misplaced] ${name}: ${wn} for ${tk.k} went into ${moved.join(', ')}; the click ${tk._near.way}`); }
        }
        delete tk._near;
        if (tk._bed && !h.ok && (job.bedLog = (job.bedLog || 0) + 1) <= 60) { const d = tk._bed, f = (job.t.wantOf(tk).props || {}).facing, v = V.VEC[f] || [0, 0, 0], hc = seen(bot, { x: tk.x + v[0], y: tk.y, z: tk.z + v[2] }); job.log(`[bed] ${name} ${tk.k} facing ${f}: ${h.why}; head cell had ${d.head}, has ${hc ? hc.name : '?'}; ${d.way}; yaw before ${d.yaw}, after ${bot.entity.yaw.toFixed(2)}; bodies in the cell ${d.bodies}; from ${d.at.x},${d.at.y},${d.at.z}`); }
        delete tk._bed;
    }
    // a closed container that stands now has its contents set from here at once (the claim gave it to a bot carrying them, job._needs): no second walk to it (b081y5); a goal
    // not set here is the crew's task as before (job._contentsAfter)
    for (const r of results.slice()) {
        if (!r.ok || r.tk.kind !== 'place' || cancel.cancelled) continue;
        for (const g of job._closedGoals(r.tk)) { const c = await setContents(job, name, bot, mv, job._contentsTask(g)); if (c.ok) { results.push(c); job.stats.contentsAtPlace = (job.stats.contentsAtPlace || 0) + 1; } }
    }
    await unscaffold(job, bot, mv);
    // the stance's own pillar and the rest of the step's blocks go when the bot's next step is known (drive's loop: release), not when "no placing is left around it"
    return results;
}

/** A container's goal tk set from where the bot stands, through the action layer's set_contents. Returns a result for job.report. */
async function setContents(job, name, bot, mv, tk) {
    await mv.holdNothing();
    const r = await require('../skills').execute(bot, 'set_contents', { x: tk.x, y: tk.y, z: tk.z, contents: tk.slots.map(({ slot, item, count }) => ({ slot, item, count })) }, { atomic: true });
    if (!r.ok && (job.contentsLog = (job.contentsLog || 0) + 1) <= 40) job.log(`${name}: contents of ${tk.x},${tk.y},${tk.z} (${tk.count} ${tk.item}): ${r.reason} ${JSON.stringify(r.detail || {}).slice(0, 200)}`);
    return r.ok ? { tk, ok: true } : { tk, ok: false, why: `set_contents: ${r.reason}` };
}

/** The crew's spawn bed or respawn anchor: not a blueprint cell, so a temporary block whose step is the whole build (taken away when nothing else is left). */
function fixture(job, name, c, item) { job.addTemp(c, 'fixture', name, item); job.ledger.observe(c, item); }

/**
 * The bot's step is over: it takes its own temporary blocks away before it does anything else (owner list 5 Large 1: "place it, then break it, immediately once it has served
 * its purpose"; no "still needed"). `next`: the next stance when it is on the column the bot stands on: that column serves the next step (the walk digs it down to that height).
 * The column under the feet is dug as the bot comes down; its other blocks within reach whose face it sees are dug from here; whatever is left (out of reach, out of sight, a
 * crew member on it, a fluid beside it) is the crew's untemp task at once, the bot's own first, with the reason. Seals, fills and scaffolds live by their own task, not by the step.
 * `label`: the step that begins. Returns the blocks dug.
 */
async function release(job, name, bot, mv, cancel, next = null, label = 'step') {
    const L = job.ledger;
    if (!L.of(name).some((e) => !e.released && !e.orphan)) { L.begin(name, label); return 0; }
    // (the column kept for the next stance is the one the bot stands ON: beside its pillar's top, with the next stance on the cell it stands on, the walk back was skipped and
    // the pillar dug from beside as far as it could be seen: 5 of 7 left standing, bt075b w3 "leaves a column of 5 at 62,26 ... walkBack null")
    const f0 = feet(bot), onOwn = !!(L.get({ x: f0.x, y: f0.y - 1, z: f0.z }) || {}).by && L.get({ x: f0.x, y: f0.y - 1, z: f0.z }).by === name;
    let sameCol = !!next && next.x === f0.x && next.z === f0.z && onOwn;
    // (the next stance on the bridge block's column while its pillar stands beside: the bot goes back onto the pillar, digs the bridge block and the pillar comes down with
    // it; the next stance's own column is put up anew. Kept, the pillar stood beside the new column: the largest class of columns left, b081w4/w5 118 / 146 blocks, b081x4 39)
    if (sameCol && typeof mv.ontoColumn === 'function' && (await mv.ontoColumn(() => true))) { sameCol = false; job.stats.ontoColumnRelease = (job.stats.ontoColumnRelease || 0) + 1; }
    const tr = Date.now();
    let wb = null, up = null;
    if (!sameCol) { wb = await mv.walkBack(cancel); up = await mv.unpillar(null, () => false, cancel); }
    if (!sameCol && !wb && !up && !cancel.cancelled && typeof mv.goto === 'function') { const r = await backOntoTall(job, name, bot, mv, cancel); if (r !== null) up = r; }
    const me = feet(bot), eye = eyeOf(bot.entity.position), P = require('./place'), world = P.botWorld(bot);
    const column = (e) => sameCol && e.x === me.x && e.z === me.z && e.y < me.y;
    const ownLife = (e) => e.how === 'seal' || e.how === 'fill' || e.how === 'scaffold' || e.how === 'fixture';
    let n = 0;
    // top-down: the lower blocks of a column left beside the bot come into sight as the ones over them go
    for (const e of L.of(name).sort((a, b) => b.y - a.y)) {
        if (cancel.cancelled) break;
        if (e.released || e.orphan || ownLife(e) || column(e)) continue;
        const c = { x: e.x, y: e.y, z: e.z }, h = seen(bot, c);
        if (h) L.check(c, h.name);
        if (!L.has(c) || e.state === 'pending') continue;
        if (e.x === me.x && e.z === me.z && e.y === me.y - 1) { L.fail(c, 'under its placer (no way down)'); continue; }
        // a column of its own deeper under the bot's feet than the landing takes back (move.js LEAN_DEPTH) is not dug from beside: its top dug, the rest stood out of everybody's
        // reach; whole, it is taken from its top as the bot comes down (the untemp task's descend, the placer's first)
        if (e.how === 'pillar') { let b0 = e.y; while ((L.get({ x: e.x, y: b0 - 1, z: e.z }) || {}).by === name) b0--; if (b0 < me.y - 1 - 4) { L.fail(c, 'a tall column: from its top'); continue; } }
        if (boxDist(eye, c) > job.o.reach) continue;
        if (underCrew(job, bot, c.x, c.y, c.z) || onRouteOfOther(job, name, c.x, c.y, c.z)) { L.fail(c, 'a crew member on it'); continue; }
        if (holdsFluid(bot, c.x, c.y, c.z)) { L.fail(c, 'holds a fluid back'); continue; }
        if (!P.clickable(world, c, me)) { L.fail(c, 'no face in sight'); continue; }
        if (await mv.dig(c)) { job.dropTemp(c); job.stats.untemp++; n++; } else L.fail(c, 'the dig failed');
    }
    const left = L.release(name, { stay: (e) => ownLife(e) || column(e), why: `${label} begins` });
    // a pillar of its own left standing when its step ends (it should have been the way down): where, how high, and what the bot did (the first 40 of the job)
    { const cols = new Map(); for (const e of left) if (e.how === 'pillar') { const ck = `${e.x},${e.z}`, c0 = cols.get(ck); if (!c0 || e.y > c0.top) cols.set(ck, { top: e.y, n: (c0 ? c0.n : 0) + 1, step: e.step, age: Math.round((Date.now() - e.at) / 1000) }); else c0.n++; }
      for (const [ck, c] of cols) if (c.n >= 2) { const lw = job.stats.columnsLeft || (job.stats.columnsLeft = {}), wk = wb === null && up === null ? 'the next stance on the column it stands on: this one beside it left' : (mv.unpillarWhy || (wb ? 'walked back, not all dug' : 'not beside or on it')); lw[wk] = (lw[wk] || 0) + c.n; } for (const [ck, c] of cols) if (c.n >= 2 && (job.leftLog = (job.leftLog || 0) + 1) <= 120) job.log(`[temps] ${name} leaves a column of ${c.n} at ${ck} (top ${c.top}, placed in step ${c.step} ${c.age} s ago) as ${label} begins, standing at ${me.x},${me.y},${me.z}; walkBack ${wb}${mv.walkBackWhy ? ` (${mv.walkBackWhy})` : ''} unpillar ${up}${mv.unpillarWhy ? ` (${mv.unpillarWhy})` : ''}; last moves ${(mv.trace || []).slice(-4).join(' | ')}`); }
    if (left.length) job._offerTemps(Date.now(), true);
    L.begin(name, label);
    job.time.walk += Date.now() - tr;
    return n;
}

/** A bot leaves the crew alive and connected (pause, stop): its own blocks go as at a step's end (release, LEAVE_MS). Returns the blocks dug, or null when it does not apply (dead, gone, nothing of its own). */
async function leaving(job, name, bot, mv) {
    if (!bot.entity || (bot._client && bot._client.ended) || !((bot.health || 0) > 0) || !job.ledger.of(name).some((e) => !e.orphan)) return null;
    try { const n = await release(job, name, bot, mv, within({ cancelled: false }, LEAVE_MS), null, 'leave'); job.stats.leaveRelease = (job.stats.leaveRelease || 0) + n; return n; }
    catch (e) { job.log(`${name}: release on leaving: ${e.message}`); return 0; }
}

/**
 * A column of its own taller than the landing takes back (move.js LEAN_DEPTH), whose top is near the bot (three cells, its height within one) when the step ends and walkBack did not
 * get onto it: a planned way onto its top (what is in the way dug, the plan's own rules), then the column dug down as the bot comes down. Such a column has no other way down: the
 * crew's untemp task for it needs a stance on its top, which only its placer standing there has (b081y4: Bd4d's 53-block pillar at 291,-40, walkBack 0 from the scaffold beside its
 * top; 'no stance for the first 1 (untemp 291,119,-40)' for 70 minutes; 45 of the 60 temporary blocks at the end). Returns the blocks dug, or null when there is no such column.
 */
async function backOntoTall(job, name, bot, mv, cancel) {
    const L = job.ledger, f = feet(bot), { LEAN_DEPTH } = require('./move'), tops = new Map();
    for (const e of L.of(name)) {
        if (e.how !== 'pillar' || e.released || e.orphan || e.state === 'pending') continue;
        const ck = `${e.x},${e.z}`, t = tops.get(ck); if (!t || e.y > t.y) tops.set(ck, { x: e.x, y: e.y, z: e.z });
    }
    let best = null;
    for (const t of tops.values()) {
        const d = Math.abs(t.x - f.x) + Math.abs(t.z - f.z);
        if (!d || d > 3 || Math.abs(t.y + 1 - f.y) > 1) continue;
        let h = 0; while (h < 64 && (L.get({ x: t.x, y: t.y - h, z: t.z }) || {}).by === name) h++;
        if (h > LEAN_DEPTH && (!best || d < best.d)) best = { ...t, d, h };
    }
    if (!best) return null;
    const to = { x: best.x, y: best.y + 1, z: best.z }, r = await mv.goto(to, { cancel, tries: 2, maxNodes: 3000, budgetMs: 1000 });
    job.stats.tallBack = job.stats.tallBack || { tried: 0, on: 0 }; job.stats.tallBack.tried++;
    const at = feet(bot);
    if (!r.ok || at.x !== to.x || at.z !== to.z) { job.log(`[temps] ${name} could not get back onto its column of ${best.h} at ${best.x},${best.z} (top ${best.y}) from ${f.x},${f.y},${f.z}: ${r.why || 'not there'}`); return 0; }
    job.stats.tallBack.on++;
    return mv.unpillar(null, () => false, cancel);
}

/**
 * Scaffolds whose block stands (or was parked: job._scaffoldServed) are dug at once from the stance that used them, when their face is in sight; otherwise they are the crew's
 * untemp tasks. A scaffold lives exactly as long as the block it was put there for (not "while any block beside it waits": owner list 5 Large 1).
 */
async function unscaffold(job, bot, mv) {
    const P = require('./place'), me = feet(bot), eye = eyeOf(bot.entity.position);
    let n = 0;
    for (const e of job.ledger.list((q) => q.how === 'scaffold' && q.released)) {
        const c = { x: e.x, y: e.y, z: e.z }, h = seen(bot, c);
        if (h) job.ledger.check(c, h.name);
        if (!job.ledger.has(c) || e.state === 'pending' || boxDist(eye, c) > job.o.reach) continue;
        if (me.x === c.x && me.z === c.z && me.y === c.y + 1) continue;          // not its own floor
        if (underCrew(job, bot, c.x, c.y, c.z) || onRouteOfOther(job, bot.username, c.x, c.y, c.z)) { job.ledger.fail(c, 'scaffold: a crew member on it'); continue; }
        if (holdsFluid(bot, c.x, c.y, c.z)) { job.ledger.fail(c, 'holds a fluid back'); continue; }
        if (!P.clickable(P.botWorld(bot), c, me)) continue;
        if (await mv.dig(c)) { job.dropTemp(c); if (job.scaffolds) job.scaffolds.delete(e.k); const t = job.tasks.get(e.k); if (t && t.after) { t.kind = t.after; delete t.after; } else if (t && (t.kind === 'clear' || t.kind === 'untemp')) job.tasks.delete(e.k); job.stats.untemp++; n++; }
        else job.ledger.fail(c, 'scaffold: the dig failed');
    }
    return n;
}

/** Would a block in cell c leave the bot's body (feet cell f, head f+1) without a way out: no side with both cells open, and nothing open over the head? */
function shutsIn(bot, c) { return shutsInAt(bot, feet(bot), c); }
/**
 * Would a block in cell c close the last way out of the space a crew member stands in (a hall of the build closed by its floor, walls and ceiling: b081i, a bot shut in a
 * region of 1 543 cells)? A flood over the cells a body can pass (no collision box) from the member's feet, with c solid, up to CLOSE_CELLS: a way out is a column outside the
 * box's footprint or a cell over the box's top. Exhausted without one: the block waits until nobody is inside (the root of what the dig-out (escape) repairs). Bots within 16.
 */
const CLOSE_CELLS = 3000;
function closesIn(job, bot, c) {
    const b = job.t.box, k = (x, y, z) => `${x},${y},${z}`, ck = k(c.x, c.y, c.z);
    const free = (x, y, z) => { if (x === c.x && y === c.y && z === c.z) return false; const h = seen(bot, { x, y, z }); return !!h && h.shape === 'empty' && !FLUID(h); };
    const out = (x, y, z) => x < b.x || x >= b.x + b.sx || z < b.z || z >= b.z + b.sz || y >= b.y + b.sy;
    const members = [feet(bot), ...crewAt(job, bot).map((q) => ({ x: Math.floor(q.x), y: Math.floor(q.y + 0.16), z: Math.floor(q.z) }))].filter((f) => Math.abs(f.x - c.x) <= 16 && Math.abs(f.z - c.z) <= 16 && Math.abs(f.y - c.y) <= 16 && !out(f.x, f.y, f.z));
    for (const f of members) {
        const seenSet = new Set([k(f.x, f.y, f.z)]), q = [[f.x, f.y, f.z]];
        let exit = false;
        for (let i = 0; i < q.length && !exit; i++) {
            if (q.length > CLOSE_CELLS) { exit = true; break; }          // large enough to count as open (a search that big finds its own way)
            const [x, y, z] = q[i];
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
                const X = x + dx, Y = y + dy, Z = z + dz, kk = k(X, Y, Z);
                if (seenSet.has(kk) || kk === ck) continue;
                if (out(X, Y, Z)) { exit = true; break; }
                // a cell a body can be in: free, with the one over or under it free too (a one-high gap is no way out)
                if (!free(X, Y, Z) || !(free(X, Y + 1, Z) || free(X, Y - 1, Z))) continue;
                seenSet.add(kk); q.push([X, Y, Z]);
            }
        }
        if (!exit) return true;
    }
    return false;
}
function shutsInAt(bot, f, c) {
    const at = (x, y, z) => (x === c.x && y === c.y && z === c.z) ? false : (() => { const b = bot.blockAt(new Vec3(x, y, z), false); return !!b && b.boundingBox === 'empty'; })();
    const near = Math.abs(c.x - f.x) <= 1 && Math.abs(c.z - f.z) <= 1 && c.y >= f.y && c.y <= f.y + 2;
    if (!near) return false;
    const up = at(f.x, f.y + 2, f.z) && at(f.x, f.y + 3, f.z);
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => at(f.x + dx, f.y, f.z + dz) && at(f.x + dx, f.y + 1, f.z + dz));
    return !up && !side;
}

/** Pour the lava (or water) bucket into cell L: aim at a full neighbour's face that the ray reaches through L (the server traces the bucket's ray itself). */
async function pour(job, bot, mv, L) {
    const r = job.t.recipeOf(L);
    if (!r || !(await mv.hold(r.item))) return false;
    const P = require('./place'), world = P.botWorld(bot), b = bot.entity.position, eye = [b.x, b.y + 1.62, b.z];
    for (const v of Object.values(V.VEC)) {
        const n = [L.x + v[0], L.y + v[1], L.z + v[2]], nb = world.block(...n);
        if (!P.full(nb)) continue;
        const hit = [n[0] + 0.5 - v[0] * 0.499, n[1] + 0.5 - v[1] * 0.499, n[2] + 0.5 - v[2] * 0.499];
        if (Math.hypot(hit[0] - eye[0], hit[1] - eye[1], hit[2] - eye[2]) > 4.4) continue;
        const ray = P.rayFirst(world, eye, hit);
        if (!ray || ray.unknown || ray.cell.join() !== n.join() || !ray.prev || ray.prev.join() !== [L.x, L.y, L.z].join()) continue;
        await mv.lookAtPoint(new Vec3(...hit));
        bot.activateItem(); await sleep(80); bot.deactivateItem();
        await sleep(400);
        return true;
    }
    return false;
}

async function unwedge(job, name, bot, mv) {
    const f = feet(bot), dug = [];
    job.stats.unwedged = (job.stats.unwedged || 0) + 1;
    for (const [dx, dy, dz] of [[0, 1, 0], [0, 2, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const c = { x: f.x + dx, y: f.y + dy, z: f.z + dz }, b = bot.blockAt(new Vec3(c.x, c.y, c.z), false);
        if (!b || b.boundingBox !== 'block' || UNBREAKABLE.test(b.name) || CONTAINER.test(b.name) || holdsFluid(bot, c.x, c.y, c.z)) continue;
        if (dy === 0 && dug.length >= 2) break;                    // the head's cells first; the sides at the feet only when that was not enough
        if (await mv.dig(c)) dug.push(`${b.name}@${c.x},${c.y},${c.z}`);
    }
    bot.setControlState('jump', true); await sleep(400); bot.setControlState('jump', false); await sleep(400);
    job.log(`${name}: wedged at ${f.x} ${f.y} ${f.z} (off the ground, no progress): dug ${dug.join(' ') || 'nothing'}; now ${bot.entity.onGround ? 'on the ground' : 'still off it'} at ${feet(bot).x} ${feet(bot).y} ${feet(bot).z}`);
    tell(job, name, bot, 'stuck', `wedged at ${f.x} ${f.y} ${f.z}: dug ${dug.length} cells round the head`);
}

/** A bot that cannot walk anywhere (closed in) breaks its way up and out, through whatever is in the way; the next survey puts built cells back. */
async function escape(job, name, bot, mv, cancel, pocket = null) {
    const f = feet(bot);
    let m2 = outMover(job, name, bot, mv, true);
    // out sideways to the nearest open cell three or more away at about the same height: never up to the top of the box (a 60-high box made every closed-in bot build a pillar
    // of 60 that the crew then climbed and tore down, for an hour: owner 2026-11-23); the plan's costs prefer walking and digging to pillaring
    job.stats.escapes++;
    // (out of a pocket: to a cell outside the cells it could reach, `pocket`)
    const goal = pocket ? (x, y, z) => !pocket.has(`${x},${y},${z}`) : (x, y, z) => Math.hypot(x - f.x, z - f.z) >= 3 && Math.abs(y - f.y) <= 2;
    let r = await m2.goto(f, { goal, cancel, maxNodes: 20000, lavaCost: COST_LAVA });
    if (!r.ok && !cancel.cancelled) { m2 = outMover(job, name, bot, mv, false); r = await m2.goto(f, { goal, cancel, maxNodes: 20000, lavaCost: COST_LAVA }); }
    job.log(`${name}: closed in at ${f.x} ${f.y} ${f.z}: ${r.ok ? 'out' : 'no way out (' + r.why + ')'}`);
    if (!r.ok) tell(job, name, bot, 'stuck', `closed in at ${f.x} ${f.y} ${f.z}, no way out (${String(r.why).slice(0, 80)})`);
    return r.ok;
}

/**
 * The mover of a way out (escape, evacuate) that may dig through the build. `strict`: a built block is dug only when the crew gets it back or the supply holds a spare;
 * otherwise any block. Every built block it digs is logged and counted (stats.digOut; job.lost for what is not got back: glass without Silk Touch is gone).
 */
function outMover(job, name, bot, mv, strict) {
    // a built block is dug on the way out only when the crew gets it back (recover.js: glass needs Silk Touch, obsidian a diamond pickaxe) or the supply holds a spare
    // (the owner's rule from TASK-073); a second try takes any block when the first finds no way, and what it costs is counted (job.lost, the progress line's stats.lostDigs)
    const built = (x, y, z, blk) => job.t.inside(x, y, z) && !job.t.isAir(job.t.idx(x, y, z)) && S.matches(job.t.at(x, y, z), seen(bot, { x, y, z }) || { name: blk.name, props: {} });
    const itemOf = (x, y, z) => { const r = job.t.recipeOf({ x, y, z, i: job.t.idx(x, y, z) }); return r && r.item; };
    const recoverable = (x, y, z, blk) => { const it = itemOf(x, y, z); return !it || RC.getBack(bot, blk.name, it).ok || job.spareOf(it) >= 1; };
    const looseOf = (strict) => ({ canDig: (x, y, z, blk, view = null) => !UNBREAKABLE.test(blk.name) && !CONTAINER.test(blk.name) && !holdsFluid(bot, x, y, z, view) && (!strict || !built(x, y, z, blk) || recoverable(x, y, z, blk)), temp: mv.rules.temp, onTemp: mv.rules.onTemp });
    {
        const m = new Mover(bot, { ...looseOf(strict), onUntemp: mv.rules.onUntemp }); m.mine = mv.mine;
        const dig0 = m.dig.bind(m);
        m.dig = async (c, o) => {
            const blk = bot.blockAt(new Vec3(c.x, c.y, c.z), false), isBuilt = !!blk && built(c.x, c.y, c.z, blk), it = isBuilt ? itemOf(c.x, c.y, c.z) : null;
            const back = isBuilt && it ? RC.getBack(bot, blk.name, it).ok : true;
            const ok = await dig0(c, o);
            if (ok && isBuilt) {
                const st = job.stats.digOut || (job.stats.digOut = { dug: 0, back: 0, lost: 0, names: {} }); st.dug++; st.names[S.bare(blk.name)] = (st.names[S.bare(blk.name)] || 0) + 1;
                if (back) st.back++; else { st.lost++; if (it) (job.lost || (job.lost = new Map())).set(it, ((job.lost && job.lost.get(it)) || 0) + 1); }
                job.log(`${name}: dug the built ${S.bare(blk.name)} at ${c.x},${c.y},${c.z} on the way out (${back ? 'got back' : `not got back: one of the ${job.spareOf(it) + 1} spare ${it}`})`);
            }
            return ok;
        };
        return m;
    }
}

/**
 * Off the site: a bot that has done nothing for EVACUATE_MS while there is work (stuck in a way nobody foresaw, owner 2026-11-23 problems 8-10) gives back its claims and walks out of
 * the box's footprint, breaking whatever is in the way (built cells too: the next survey puts them back), then rests a moment. One bot stopping never holds the crew.
 */
const EVACUATE_MS = 240000;
async function evacuate(job, name, bot, mv, cancel, why) {
    const f = feet(bot), b = job.t.box;
    job.leave(name); job.bots.set(name, { station: null, pos: f });
    job.stats.evacuations = (job.stats.evacuations || 0) + 1;
    job.log(`${name}: evacuated from ${f.x} ${f.y} ${f.z}: ${why}`);
    tell(job, name, bot, 'evacuate', `${why}; leaving the site from ${f.x} ${f.y} ${f.z}`, true);
    // (through the build only where the crew gets the block back or has a spare, then any block: it dug glass walls without a count, each pane gone for good: b081q5's
    // 58 failed evacuations in the stock-out tail, glass 59 short at the end)
    const out = (x, y, z) => (x < b.x - 1 || x > b.x + b.sx || z < b.z - 1 || z > b.z + b.sz);
    const nearest = { x: Math.min(Math.max(f.x, b.x - 3), b.x + b.sx + 2), y: f.y, z: Math.min(Math.max(f.z, b.z - 3), b.z + b.sz + 2) };
    let r = await outMover(job, name, bot, mv, true).goto(nearest, { goal: out, cancel, maxNodes: 30000, lavaCost: COST_LAVA });
    if (!r.ok && !cancel.cancelled) r = await outMover(job, name, bot, mv, false).goto(nearest, { goal: out, cancel, maxNodes: 30000, lavaCost: COST_LAVA });
    job.log(`${name}: evacuation ${r.ok ? 'done' : 'failed (' + r.why + ')'}`);
    await sleep(15000, 'other: after an evacuation');
    return r.ok;
}

/**
 * Why a bot is not working, said in the game's chat (the owner watches by eye, MiniHUD shows no reasons: owner 2026-11-23 problem 7). A state is said when it starts, and again every
 * two minutes while it lasts; work clears it. BUILD_CHAT=0 switches it off.
 */
function tell(job, name, bot, state, detail, force = false) {
    if (process.env.BUILD_CHAT === '0' || !bot || !bot.chat) return;
    const m = job.told || (job.told = new Map()), prev = m.get(name), now = Date.now();
    if (!force && prev && prev.state === state && now - prev.at < 120000) return;
    if (!force && prev && now - prev.at < 8000) return;
    m.set(name, { state, at: now });
    try { bot.chat(`[${state}] ${detail}`.replace(/[\n\r]/g, ' ').slice(0, 240)); } catch (_) { /* chat is a report only */ }
}
const untell = (job, name) => { if (job.told) job.told.delete(name); };

/**
 * The Nether's respawn point: one bot sets a respawn anchor down beside the materials chest and charges it with glowstone; every bot clicks it with an empty hand (its spawn is set
 * there). All survival actions with items from the chest. Without it a bot that died in the Nether woke in the Overworld and the crew was left behind there (owner 2026-11-23).
 */
const inNether = (bot) => /nether/.test(String(bot.game && bot.game.dimension));
async function anchor(job, name, bot, mv, cancel) {
    if (!inNether(bot) || !job.available || !job.available.has('respawn_anchor') || !job.sites[0]) return;
    if (job.spawnSet && job.spawnSet.has(name) && !lowAnchor(job, bot)) return;
    if (!job.anchorAt) {
        if (job.anchorBusy) return;                      // another bot sets it down; this one works meanwhile
        job.anchorBusy = name;
        try {
            await supplyTrip(job, name, bot, mv, { respawn_anchor: 1, glowstone: 8 }, within(cancel, 180000));
            if (!bot.inventory.items().some((i) => i.name === 'respawn_anchor')) { job.anchorFails = (job.anchorFails || 0) + 1; job.log(`${name}: no respawn anchor from the chest (${job.anchorFails})`); if (job.anchorFails >= 3) job.available.delete('respawn_anchor'); return; }
            const c = job.sites[0], v = mv.view(), me = feet(bot), spots = [];
            for (let r = 2; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, 1, -1]) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
                if (job.t.inside(q.x, q.y, q.z) || (job.depot || []).some((d) => Math.abs(d.x - q.x) + Math.abs(d.y - q.y) + Math.abs(d.z - q.z) <= 1) || job.sites.some((s0) => Math.abs(s0.x - q.x) <= 1 && Math.abs(s0.z - q.z) <= 1 && Math.abs(s0.y - q.y) <= 1)) continue;
                if (!v.free(q.x, q.y, q.z) || !v.free(q.x, q.y + 1, q.z) || !v.stands(q.x, q.y - 1, q.z) || (q.x === me.x && q.z === me.z)) continue;
                spots.push(q);
            }
            for (const q of spots.slice(0, 8)) {
                await mv.goto(q, { goal: (x, y, z) => Math.hypot(x + 0.5 - (q.x + 0.5), y + 1.62 - (q.y + 0.5), z + 0.5 - (q.z + 0.5)) <= 4 && Math.hypot(x - q.x, z - q.z) >= 1.5, cancel, maxNodes: 6000 });
                if ((await mv.placeItem('respawn_anchor', q)) === true) { job.anchorAt = q; fixture(job, name, q, 'respawn_anchor'); job.log(`${name}: respawn anchor set down at ${q.x} ${q.y} ${q.z}`); break; }
            }
            if (!job.anchorAt) { job.anchorFails = (job.anchorFails || 0) + 1; job.log(`${name}: no cell for the respawn anchor took it (${spots.length} tried)`); if (job.anchorFails >= 3) job.available.delete('respawn_anchor'); return; }
        } finally { job.anchorBusy = null; }
    }
    const a = job.anchorAt;
    const r = await mv.goto(a, { goal: (x, y, z) => Math.hypot(x + 0.5 - (a.x + 0.5), y + 1.62 - (a.y + 0.5), z + 0.5 - (a.z + 0.5)) <= 4 && Math.hypot(x - a.x, z - a.z) >= 1.5, cancel, maxNodes: 20000 });
    if (!r.ok) { job.log(`${name}: no way to the respawn anchor (${r.why})`); return; }
    if (charges(bot, a) < 4 && !bot.inventory.items().some((i) => i.name === 'glowstone')) await supplyTrip(job, name, bot, mv, { glowstone: 4 }, within(cancel, 120000));
    for (let i = 0; i < 4 && charges(bot, a) < 4 && (await mv.hold('glowstone')); i++) { await mv.click([a.x, a.y, a.z], 'up', [a.x + 0.5, a.y + 1, a.z + 0.5]); await sleep(150); }
    if (charges(bot, a) < 1) { job.log(`${name}: the respawn anchor has no charge`); return; }
    await mv.holdNothing();
    await mv.click([a.x, a.y, a.z], 'up', [a.x + 0.5, a.y + 1, a.z + 0.5]);
    (job.spawnSet || (job.spawnSet = new Set())).add(name);
    job.log(`${name}: spawn set at the respawn anchor (${charges(bot, a)} charges)`);
}
/**
 * The Overworld's respawn point: a bed (from the supply, not the blueprint's) set down beside the chest; every bot clicks it with an empty hand (by day that sets the spawn).
 * Without it a bot that died woke at the world's spawn, hundreds of blocks away, and stood at another crew's chest for the rest of the run (live 2026-11-23 ha11 w3).
 */
const SPAWN_BED = 'red_bed';
async function bedSpawn(job, name, bot, mv, cancel) {
    if (inNether(bot) || !job.available || !job.available.has(SPAWN_BED) || !job.sites[0]) return;
    if (!job.bedAt) {
        if (job.anchorBusy) return;
        job.anchorBusy = name;
        try {
            if (!bot.inventory.items().some((i) => i.name === SPAWN_BED)) await supplyTrip(job, name, bot, mv, { [SPAWN_BED]: 1 }, within(cancel, 180000));
            if (!bot.inventory.items().some((i) => i.name === SPAWN_BED)) { job.bedFails = (job.bedFails || 0) + 1; job.log(`${name}: no spawn bed from the chest (${job.bedFails})`); if (job.bedFails >= 6) job.available.delete(SPAWN_BED); return; }
            const c = job.sites[0], v = mv.view(), me = feet(bot), spots = [];
            // a cell and the one beside it (the head, where the bot looks) free and on a floor; the bot stands behind the foot, looking along the bed (a click from any side made
            // the bed's head point into rock: "no cell took the spawn bed" on most worlds, owner 2026-11-24)
            const DIR = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }, ok = (x, y, z) => v.free(x, y, z) && v.free(x, y + 1, z) && v.stands(x, y - 1, z) && !job.t.inside(x, y, z);
            for (let r = 2; r <= 8; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, 1, -1, 2, -2]) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
                if (!ok(q.x, q.y, q.z)) continue;
                for (const [facing, [fx, fz]] of Object.entries(DIR)) if (ok(q.x + fx, q.y, q.z + fz) && ok(q.x - fx, q.y, q.z - fz)) spots.push({ ...q, facing, back: { x: q.x - fx, y: q.y, z: q.z - fz } });
            }
            const why = [];
            for (const q of spots.slice(0, 10)) {
                const g = await mv.goto(q.back, { cancel, maxNodes: 6000, tries: 2 });
                if (!g.ok) { why.push(`no way behind ${q.x},${q.y},${q.z}`); continue; }
                let pr = await mv.placeItem(SPAWN_BED, q, { facing: q.facing });
                if (pr !== true && /no face in sight/.test(String(pr))) pr = await mv.placeItem(SPAWN_BED, q);          // (the click search found no look for that facing: any side, the head cell is free on every side here)
                if (pr === true) { job.bedAt = q; fixture(job, name, q, SPAWN_BED); job.log(`${name}: spawn bed set down at ${q.x} ${q.y} ${q.z} facing ${q.facing}`); break; }
                // a click on grass beside the cell puts the bed into the grass's cell: it stands, a cell off (the crew used up its beds "failing", live 2026-11-24 ha16)
                { let at = null; for (let dx = -3; dx <= 3 && !at; dx++) for (let dy = -1; dy <= 1 && !at; dy++) for (let dz = -3; dz <= 3 && !at; dz++) { const b = bot.blockAt(new Vec3(q.x + dx, q.y + dy, q.z + dz), false); if (b && b.name === SPAWN_BED) at = { x: q.x + dx, y: q.y + dy, z: q.z + dz }; }
                  if (at) { job.bedAt = at; fixture(job, name, at, SPAWN_BED); job.log(`${name}: spawn bed set down at ${at.x} ${at.y} ${at.z} (a cell off ${q.x},${q.y},${q.z})`); break; } }
                why.push(`${q.x},${q.y},${q.z}: ${pr}`);
            }
            if (!job.bedAt && why.length) job.log(`${name}: spawn bed not set down: ${why.slice(0, 4).join('; ')}`);
            if (!job.bedAt) { job.bedFails = (job.bedFails || 0) + 1; job.log(`${name}: no cell took the spawn bed (${spots.length} tried)`); if (job.bedFails >= 3) job.available.delete(SPAWN_BED); return; }
        } finally { job.anchorBusy = null; }
    }
    const a = job.bedAt;
    const r = await mv.goto(a, { goal: (x, y, z) => Math.hypot(x + 0.5 - (a.x + 0.5), y + 1.62 - (a.y + 0.5), z + 0.5 - (a.z + 0.5)) <= 4 && Math.hypot(x - a.x, z - a.z) >= 1.5, cancel, maxNodes: 20000 });
    if (!r.ok) { job.log(`${name}: no way to the spawn bed (${r.why})`); return; }
    const b = bot.blockAt(new Vec3(a.x, a.y, a.z), false);
    if (!b || !/_bed$/.test(b.name)) { job.log(`${name}: the spawn bed at ${a.x} ${a.y} ${a.z} is gone`); job.bedAt = null; return; }
    await mv.holdNothing();
    // counted only when the server says so (a click taken for done left a bot without a spawn point: it woke 248 blocks away, live 2026-11-24 ha13 w1)
    let said = false; const hear = (m) => { const t = String((m && (m.translate || (m.json && m.json.translate))) || m || ''); if (/set_spawn|respawn point set|spawn point set/i.test(t + ' ' + String(m && m.toString ? m.toString() : ''))) said = true; };
    bot.on('message', hear); bot.on('actionBar', hear);          // (the server says it over the hotbar)
    try { for (let k = 0; k < 3 && !said; k++) { await mv.click([a.x, a.y, a.z], 'up', [a.x + 0.5, a.y + 0.5625, a.z + 0.5]); for (let i = 0; i < 15 && !said; i++) await sleep(100); } }
    finally { bot.removeListener('message', hear); bot.removeListener('actionBar', hear); }
    if (!said) { job.log(`${name}: the bed was clicked, but the server did not say the spawn is set`); return; }
    (job.spawnSet || (job.spawnSet = new Set())).add(name);
    job.log(`${name}: spawn set at the bed`);
}

/** Is cell c one of the blocks under the body's corners (the floor the bot's box rests on)? */
function underBody(bot, c) {
    const p = bot.entity && bot.entity.position; if (!p) return false;
    const y = Math.floor(p.y + 0.01) - 1; if (c.y !== y) return false;
    for (const dx of [-0.299, 0.299]) for (const dz of [-0.299, 0.299]) if (Math.floor(p.x + dx) === c.x && Math.floor(p.z + dz) === c.z) return true;
    return false;
}
/** The crew's anchor stands, is in sight, and holds fewer than two charges (each respawn takes one: b081x5's fifth death woke in the Overworld). */
const lowAnchor = (job, bot) => { if (!job.anchorAt) return false; const c = charges(bot, job.anchorAt); return c >= 0 && c < 2; };
const charges = (bot, a) => { const b = bot.blockAt(new Vec3(a.x, a.y, a.z), false); return b && b.name === 'respawn_anchor' ? Number((b.getProperties() || {}).charges || 0) : -1; };

/**
 * What a trip fetches for `need` ({item: count}: the bot's area's whole bill and what the ready work asks for), the temporary block and tools. Plentiful items: all of it (the bot
 * carries everything its area needs and goes to the chest once, owner 2026-11-23 list 4 problem 4). Scarce items (the supply holds less than the crew still needs): the bot's
 * share of the supply by its share of the need, at least what the ready work asks (up to two): one bot took all 104 hoppers and seven waited (live 2026-11-23 fz9 w6).
 * Unstackable items (beds) at most nine at a time: 25 beds filled 25 slots of the pack.
 */
function needsFor(job, bot, need) {
    const have = SUP.carried(bot), out = {}, crew = job.crewNeeds ? job.crewNeeds() : {}, total = (it) => (job.supply && job.supply.totals[it]) || 0;
    for (const [it, n] of Object.entries(need)) {
        const sup = total(it), all = Math.max(crew[it] || 0, n);
        let cap = sup >= all ? n : Math.max(Math.floor(sup * n / Math.max(all, 1)), Math.min(n, 2));
        if (SUP.stackOf(bot, it) === 1) cap = Math.min(cap, 9);
        const want = cap - (have[it] || 0); if (want > 0) out[it] = want;
    }
    const temps = tempKinds().filter((t) => !job.t.items.has(t)).reduce((a, t) => a + (have[t] || 0), 0);
    if (job.tempItem && temps < 128) out[job.tempItem] = 320 - temps;
    // tools with a margin: a spare pickaxe in the pack, worn at a fifth of its life (bots dug on by hand when the only one broke mid-claim, owner 2026-11-23 V10)
    for (const tool of ['pickaxe', 'shovel', 'axe']) { const n = bot.inventory.items().filter((i) => i.name.endsWith('_' + tool) && !worn(bot, i)).length, want = tool === 'pickaxe' ? 2 : 1; if (n < want) { const best = job.supply && Object.keys(job.supply.totals).find((k) => k.endsWith('_' + tool)); if (best) out[best] = want - n; } }
    for (const k of Object.keys(out)) if ((job.outOf && job.outOf.get(k) || 0) > Date.now()) delete out[k];          // the chest ran out of it a while ago: not fetched again yet (tools too: the filter ran before they were added)
    return out;
}
function worn(bot, it) { const max = (bot.registry.itemsByName[it.name] || {}).maxDurability; if (!max) return false; const dmg = (it.components || []).find((c) => c && c.type === 'damage'); const d = dmg ? Number(dmg.data) : (it.durabilityUsed || 0); return max - d < Math.max(12, max * 0.2); }

/** One trip to the materials containers (one bot at a container at a time). */
async function supplyTrip(job, name, bot, mv, need, cancel) {
    const site = job.sites[0];
    if (!site) return false;
    if (!Object.keys(needsFor(job, bot, need)).length) {          // nothing it may fetch now (all out of stock): no walk to the chest for nothing
        const ks = Object.keys(need);
        if (ks.length && Date.now() - (job.noFetchAt || 0) > 60000) { job.noFetchAt = Date.now(); job.log(`${name}: nothing to fetch for ${ks.slice(0, 4).join(', ')}: ${ks.slice(0, 4).map((k) => `${k} out until ${job.outOf && job.outOf.get(k) ? new Date(job.outOf.get(k)).toISOString().slice(11, 19) : '-'}, supply ${(job.supply && job.supply.totals[k]) || 0}, carried ${SUP.carried(bot)[k] || 0}`).join('; ')}`); }
        // items no container holds any more: the tasks that need them are parked (they come back in the next round) and the window moves on (a few cells of snow and grass held
        // the crew idle, live 2026-11-23 fy1 w1)
        // (items no container holds any more are in other bots' packs: those bots place them; this bot's claims leave such cells alone, see `skip` in the claim)
        return false;
    }
    // the supply takes SUPPLY_PAR bots at a time (a chest opens for several players; one bot at a time made seven wait for each one's long trip: 402 waits of 90 s on one
    // world, live 2026-11-23 gh1 w3); the best record goes first, not the first to arrive (owner 2026-11-23 list 4 problem 6)
    if (!(await enterSupply(job, name, bot, mv, site, cancel))) { job.log(`${name}: no turn at the supply within 60 s (${[...job.gate.inside].join(', ')} at it)`); return false; }
    try {
        const r = await mv.goto(site, { goal: nearContainer(site), cancel, maxNodes: 40000 });
        if (!r.ok) {
            job.log(`${name}: no way to the materials at ${site.x} ${site.y} ${site.z} (${r.why})${r.region && Date.now() - (job.edgeAt || 0) > 60000 ? (job.edgeAt = Date.now(), `; edge ${edgeOf(mv, r.region)}`) : ''}`);
            // boxed in (the search found next to no cells): dig out round the head and out of it (bots stood boxed in by the build for the rest of the run, ha26 w4)
            if (r.nodes !== undefined && r.nodes <= 2) { await unwedge(job, name, bot, mv); await escape(job, name, bot, mv, cancel); }
            // shut in by the build (a hall closed by its floor, walls and ceiling: the search found every cell it can reach and none leads out, b081i: 'no more cells, 1 543
            // cells'): out of that pocket through the build, as a player digs out; the dug cells are the build's again at the next survey (escape digs, then the job surveys)
            else if (r.region && /no more cells/.test(String(r.why))) { const ok = await escape(job, name, bot, mv, cancel, r.region); if (ok && job.stage === 'place') { job.log(`${name}: dug out of a closed part of the build; the box is surveyed again`); job.stage = 'survey'; } }
            return false;
        }
        if (SUP.supplyBoxes(bot, job.t.items).length) await SUP.putBack(bot, site, job.t.items);          // boxes it carries (picked up somewhere) go back first
        const spot = () => boxSpot(job, bot, site, mv);
        await SUP.dropRubble(bot, keepRubble(job), { minFree: 12 });          // room in the pack first (a pack full of rubble brought nothing back)
        // what the ready work asks for, and what its sector needs over the next layers (each capped by the fair share in needsFor)
        // (while the pit clears the site: the kit only, not the area's materials: the pack is the pit's for its digging)
        const sn = job.sectorNeeds && !(job.pitPhase && !job.pitPhase.done) ? job.sectorNeeds(name) : {}, all = { ...sn };
        for (const [k, n] of Object.entries(need)) all[k] = Math.max(all[k] || 0, n);
        const wants = needsFor(job, bot, all);
        // a pack still full of the build's own blocks (none of them rubble to drop) takes nothing from the chest: what it carries that this trip does not ask for goes into the
        // chest first, for the bots whose cells need it (b081p: Bd4f came back with nothing 12 times in 40 min, its pack full)
        if (SUP.freeSlots(bot) < 6) {
            const names = [...new Set(bot.inventory.items().map((i) => i.name))].filter((n) => job.t.items.has(n) && !(n in wants) && !SUP.TOOL.test(n) && !SUP.SHULKER.test(n) && !tempKinds().includes(n));
            const locks = job.boxLocks || (job.boxLocks = new Map()), lk = `${site.x},${site.y},${site.z}`, h = locks.get(lk);
            if (names.length && !(h && h.by !== name && h.until > Date.now())) {
                locks.set(lk, { by: name, until: Date.now() + 30000 });
                try { const out = await SUP.deposit(bot, site, names); for (const k of Object.keys(out || {})) if (job.outOf) job.outOf.delete(k); job.stats.packDeposits = (job.stats.packDeposits || 0) + 1; job.log(`${name}: pack full (${SUP.freeSlots(bot)} free after): put ${JSON.stringify(out).slice(0, 160)} into the chest first`); }
                catch (e) { job.log(`${name}: pack full, deposit failed: ${e.message}`); }
                finally { if ((locks.get(lk) || {}).by === name) locks.delete(lk); }
            } else if (Date.now() - (job.fullLog || 0) > 60000) { job.fullLog = Date.now(); job.log(`${name}: pack full (${SUP.freeSlots(bot)} free), nothing it may put back: ${JSON.stringify(SUP.carried(bot)).slice(0, 200)}`); }
        }
        job.depot = job.depot || [];
        // every shulker box standing round the chest is the depot's, whether the list kept it or not: a box set down again elsewhere (or by a bot that left) dropped out of the
        // list and its stock with it, so the chest read 'out' of smooth stone while a box beside it held 16 stacks (b081p: Bd4f, 17 trips for nothing; chest -59,64,90, box -56,65,90)
        { const FV = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
          for (let dx = -6; dx <= 6; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -6; dz <= 6; dz++) {
              const x = site.x + dx, y = site.y + dy, z = site.z + dz, q = bot.blockAt(new Vec3(x, y, z), false);
              if (!q || !SUP.SHULKER.test(q.name) || job.depot.some((d) => d.x === x && d.y === y && d.z === z)) continue;
              const f = FV[(q.getProperties ? q.getProperties() : {}).facing] || FV.up;
              job.depot.push({ x, y, z, fx: f[0], fy: f[1], fz: f[2] }); job.stats.depotFound = (job.stats.depotFound || 0) + 1;
              job.log(`supply: a box at ${x},${y},${z} the depot list did not hold is the depot's again`);
          } }
        const res = await SUP.fetch(bot, site, wants, mv, spot, { log: job.log, depot: job.depot, locks: job.boxLocks || (job.boxLocks = new Map()), me: name, cancel, build: job.t.items });
        job.stats.trips++;
        job.log(`${name}: supply trip for ${JSON.stringify(wants).slice(0, 160)}: got ${JSON.stringify(res.got).slice(0, 200)}${Object.keys(res.short).length ? `; short ${JSON.stringify(res.short).slice(0, 200)}` : ''}`);
        // what it came back without, the chest has none of (left): not asked for again for ten minutes (a crew went every minute for nothing, live 2026-11-22 sF w3)
        // (three minutes, and only what every container was seen without: a misread chest marked the whole supply out for ten minutes and eight bots stood idle with 7 500 blocks
        // to place, owner 2026-11-23 problem 8)
        for (const k of res.absent || []) (job.outOf = job.outOf || new Map()).set(k, Date.now() + 180000);
        for (const k of Object.keys(res.got)) if (job.outOf) job.outOf.delete(k);
        if (Object.keys(res.short).length && !Object.keys(res.got).length) tell(job, name, bot, 'supply', `came back without ${Object.keys(res.short).slice(0, 4).join(', ')}${(res.absent || []).length ? ` (none left: ${res.absent.slice(0, 3).join(', ')})` : ''}`);
        // a tool the trip came back without is not asked for again for ten minutes (bots walked to the chest every minute for an axe it did not give, live 2026-11-22 sR2 w3)
        // (only when no container has any: a box another bot had open is not 'out', bots dug stone by hand for ten minutes, live 2026-11-23 ha2 w4)
        for (const k of Object.keys(wants)) if (SUP.TOOL.test(k) && !res.got[k] && (res.absent || []).includes(k)) (job.outOf = job.outOf || new Map()).set(k, Date.now() + 600000);
        if (!Object.keys(res.got).length) job.record(name).empty.push(Date.now());
        return Object.keys(res.got).length > 0;
    } catch (e) { job.log(`${name}: supply trip failed: ${e.message}`); return false; }
    finally { job.gate.inside.delete(name); }
}

const SUPPLY_PAR = Math.max(1, Number(process.env.BUILD_SUPPLY_PAR || 2));
/**
 * A turn at the supply: true when this bot may go (fewer than SUPPLY_PAR bots there, and no waiting bot with a better record ahead of it); false after 60 s (the bot works on
 * what it can meanwhile). Waiting bots stand away from the chest.
 */
async function enterSupply(job, name, bot, mv, site, cancel) {
    const g = job.gate || (job.gate = { inside: new Set(), wait: new Map() }), t0 = Date.now();
    g.wait.set(name, t0);
    let away = false;
    try {
        for (;;) {
            if (cancel.cancelled) return false;
            const order = [...g.wait.keys()].sort((a, b) => (job.merit(b) - job.merit(a)) || (g.wait.get(a) - g.wait.get(b)));
            if (order.indexOf(name) < SUPPLY_PAR - g.inside.size) { g.inside.add(name); return true; }
            if (Date.now() - t0 > 60000) return false;
            if (job.progressAt) job.progressAt.set(name, Date.now());          // waiting for a turn is not being stuck (the watchdog evacuated bots in line, live 2026-11-23 gh1 w3)
            if (!away) { away = true; tell(job, name, bot, 'wait', `a turn at the materials (${[...g.inside].join(', ')} there, ${g.wait.size} waiting)`); await mv.goto(site, { goal: (x, y, z) => Math.hypot(x - site.x, z - site.z) >= 5 && Math.hypot(x - site.x, z - site.z) <= 9, cancel, maxNodes: 15000, tries: 2 }); continue; }
            await mv.spread(crewAt(job, bot)); await sleep(500, 'wait: a turn at the materials');
        }
    } finally { g.wait.delete(name); }
}
/** A cancel token that is also cancelled `ms` from now. */
const LEAVE_MS = 30000;              // the release when a bot leaves the crew alive (pause, stop): as long as a step's end may take
const within = (cancel, ms) => { const end = Date.now() + ms; return { get cancelled() { return cancel.cancelled || Date.now() > end; } }; };
const nearContainer = (c) => (x, y, z) => Math.abs(x - c.x) <= 2 && Math.abs(z - c.z) <= 2 && y >= c.y - 1 && y <= c.y + 1 && !(Math.abs(x - c.x) <= 1 && z === c.z && y === c.y + 1) && !(x === c.x && z === c.z);
/** A free cell beside the container (air, on something solid, not the bot's own cells, outside the box) for a shulker box to stand in while it is unpacked. */
async function boxSpot(job, bot, c, mv) {
    const got = await boxSpot0(job, bot, c, mv);
    // reserved for this bot a moment (two bots at the supply at once chose the same cell)
    if (got) (job.spotRes || (job.spotRes = new Map())).set(`${got.x},${got.y},${got.z}`, { by: bot.username, until: Date.now() + 20000 });
    return got;
}
async function boxSpot0(job, bot, c, mv) {
    const first = pickBoxSpot(job, bot, c, false);
    if (first || !mv) return first;
    // none in reach from where it stands: a cell up to six from the chest, walked to (cramped Nether caves had nothing within four of the chest's side, live 2026-11-22 sF2 w4)
    for (const s0 of pickBoxSpot(job, bot, c, false, null, { far: true }).slice(0, 6)) {
        const v = mv.view(), near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]].flatMap(([dx, dz]) => [0, 1, -1].map((dy) => ({ x: s0.x + dx, y: s0.y + dy, z: s0.z + dz })))
            .filter((q) => v.fits(q.x, q.y, q.z) && v.stands(q.x, q.y - 1, q.z) && !(q.x === s0.x && q.z === s0.z));
        for (const q of near.slice(0, 3)) {
            const r = await mv.goto(q, { maxNodes: 8000 });
            if (!r.ok) continue;
            const got = pickBoxSpot(job, bot, c, false, s0);
            if (got) return got;
        }
    }
    // no free cell: a niche dug into natural rock or soil within reach (a chest on a cliff at height 149 had four boxes beside it and no room for a fifth, live 2026-11-22 prof2)
    const dig = pickBoxSpot(job, bot, c, true);
    const far = pickBoxSpot(job, bot, c, false, null, { far: true }).length, me = feet(bot);
    if (!dig) { job.log(`supply: no depot cell: none free in reach, ${far} free up to six away (walked to: none worked), no natural block to dig a niche into; the bot at ${me.x},${me.y},${me.z}, the chest at ${c.x},${c.y},${c.z}`); return null; }
    if (!(await mv.dig(dig))) { job.log(`supply: no depot cell: the niche at ${dig.x},${dig.y},${dig.z} did not dig`); return null; }
    const got = pickBoxSpot(job, bot, c, false, dig);
    if (!got) job.log(`supply: no depot cell: the niche at ${dig.x},${dig.y},${dig.z} was dug but is not usable`);
    return got;
}
const NATURAL = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|stone|deepslate|cobblestone|andesite|diorite|granite|tuff|calcite|gravel|sand|red_sand|sandstone|red_sandstone|terracotta|[a-z_]+_terracotta|netherrack|basalt|blackstone|soul_sand|soul_soil|crimson_nylium|warped_nylium|snow_block|packed_ice|moss_block)$/;
function pickBoxSpot(job, bot, c, digging, only = null, { far = false } = {}) {
    const v = new View(bot, { canDig: () => false }), me = feet(bot), out = [];
    // a box opens toward its facing: that cell must stay free; it is set down on the face of a solid block opposite to it (up on a floor, or sideways against a wall: on a
    // mountainside nearly no cell beside the chest had a floor and no box could be set down, live 2026-11-22 sX w2)
    const FACINGS = [['up', 0, 1, 0], ['north', 0, 0, -1], ['south', 0, 0, 1], ['west', -1, 0, 0], ['east', 1, 0, 0]];
    const isBox = (x, y, z) => (job.depot || []).some((q) => q.x === x && q.y === y && q.z === z);
    // the depot: two to four cells from the chest (the ring next to it stays free for the bots that open the chest)
    // (a cell picked from the far list and walked to is looked for out to six: at four it was never found again, "161 free up to six away (walked to: none worked)" on every
    // trip of a run, live 2026-11-23 gh1 w3)
    const res = job.spotRes || new Map(), mine = bot.username;
    for (let r = 2; r <= (far || only ? 6 : 4); r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of (far || only ? [0, 1, -1, 2, -2, 3] : [0, 1, -1, 2])) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const s = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        { const q = res.get(`${s.x},${s.y},${s.z}`); if (q && q.by !== mine && q.until > Date.now()) continue; }
        if (job.t.inside(s.x, s.y, s.z) || (s.x === me.x && s.z === me.z && (s.y === me.y || s.y === me.y + 1))) continue;
        if (job.sites.some((q) => Math.abs(q.x - s.x) <= 1 && q.z === s.z && q.y === s.y - 1)) continue;        // not on top of a chest (bots stand there)
        if (only && !(only.x === s.x && only.y === s.y && only.z === s.z)) continue;
        if (digging) { const q = v.raw(s.x, s.y, s.z); if (!q || !NATURAL.test(q.name) || job.sites.some((x) => x.x === s.x && x.y === s.y && x.z === s.z)) continue; }
        else if (!v.free(s.x, s.y, s.z)) continue;
        const d = Math.hypot(s.x + 0.5 - bot.entity.position.x, s.y + 0.5 - (bot.entity.position.y + 1.62), s.z + 0.5 - bot.entity.position.z);
        if (d > 4 && !far) continue;
        for (const [facing, fx, fy, fz] of FACINGS) {
            const front = { x: s.x + fx, y: s.y + fy, z: s.z + fz };
            if (!v.free(front.x, front.y, front.z) || isBox(front.x, front.y, front.z)) continue;          // its lid's cell free, and never another box's cell (a box on a box keeps the lower one shut)
            if ((job.depot || []).some((q) => q.x + (q.fx || 0) === s.x && q.y + (q.fy ?? 1) === s.y && q.z + (q.fz || 0) === s.z)) continue;     // not in another box's lid cell
            if (!v.stands(s.x - fx, s.y - fy, s.z - fz) && !(fy === 0 && v.kind(s.x - fx, s.y - fy, s.z - fz) === 'solid')) continue;            // the block it is set against
            out.push({ s: { ...s, facing, fx, fy, fz }, d: d + (facing === 'up' ? 0 : 0.5) });
        }
    }
    out.sort((a, b) => a.d - b.d);
    if (far) { const seen0 = new Set(); return out.map((o) => o.s).filter((q) => { const k = `${q.x},${q.y},${q.z}`; if (seen0.has(k)) return false; seen0.add(k); return true; }); }
    if (digging) { const P = require('./place'), world = P.botWorld(bot); for (const { s: c2 } of out) if (P.clickable(world, c2, me)) return c2; return null; }
    // only where a face is in sight from where the bot stands (the chest itself hides some)
    const P = require('./place'), world = P.botWorld(bot), name = (bot.inventory.items().find((i) => /shulker_box$/.test(i.name)) || {}).name || 'white_shulker_box';
    for (const { s: c2 } of out) { const want = { name, props: { facing: c2.facing } }; if (P.ways(world, c2, want, name, [me], { max: 1 }).length || P.ways(world, c2, want, name, [me], { max: 1, sneakAlways: true }).length) return c2; }
    return null;
}

/** Dig up to 96 natural blocks (dirt, stone, netherrack ...) outside the box near the chest, standing on the ground, never under the crew or beside a fluid: temporary blocks. */
const QUARRY = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|stone|cobblestone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate|netherrack|blackstone|basalt)$/;
async function quarry(job, name, bot, mv, cancel) {
    const b = job.t.box, c = job.sites[0] || feet(bot), v = mv.view(), out = [];
    const off = (x, z) => x < b.x - 3 || x > b.x + b.sx + 2 || z < b.z - 3 || z > b.z + b.sz + 2;
    for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) for (let dy = -3; dy <= 1; dy++) {
        const x = c.x + dx, y = c.y + dy, z = c.z + dz; if (!off(x, z) || Math.abs(dx) + Math.abs(dz) < 4) continue;
        const q = v.raw(x, y, z); if (!q || !QUARRY.test(q.name) || !v.free(x, y + 1, z) || holdsFluid(bot, x, y, z)) continue;
        out.push({ x, y, z, d: Math.hypot(dx, dz) });
    }
    out.sort((p, q) => p.d - q.d);
    let got = 0; const t0 = Date.now();
    for (const q of out) {
        if (got >= 96 || cancel.cancelled || Date.now() - t0 > 150000) break;
        if (underCrew(job, bot, q.x, q.y, q.z)) continue;
        const r = await mv.goto(q, { goal: (x, y, z) => Math.hypot(x + 0.5 - (q.x + 0.5), y + 1.62 - (q.y + 0.5), z + 0.5 - (q.z + 0.5)) <= 4 && !(x === q.x && z === q.z), cancel, maxNodes: 4000, tries: 1 });
        if (!r.ok) continue;
        if (await mv.dig(q)) { got++; await mv.goto(q, { maxNodes: 400, tries: 1, cancel }); }          // into the dug cell: the drop is picked up there
    }
    await sleep(800);
    job.log(`${name}: dug ${got} blocks of natural ground near the chest for temporary blocks (the chest has none)`);
    return got;
}

/** A waiting cell off the box (two or more outside its footprint), six to fourteen from the chest, standing, away from lava and from the other bots. */
async function bench(job, name, bot, mv, cancel) {
    const b = job.t.box, c = job.sites[0] || feet(bot), others = crewAt(job, bot), v = mv.view();
    const off = (x, z) => x < b.x - 2 || x > b.x + b.sx + 1 || z < b.z - 2 || z > b.z + b.sz + 1;
    // at about the chest's height (a Nether bench reached by a drop was a pit the bot could not leave, live 2026-11-23 ha2 w1)
    const goal = (x, y, z) => { const d = Math.hypot(x - c.x, z - c.z); return d >= 6 && d <= 14 && Math.abs(y - c.y) <= 2 && off(x, z) && !v.nearLava(x, y, z) && others.every((q) => Math.hypot(q.x - (x + 0.5), q.z - (z + 0.5)) >= 2.5); };
    const f = feet(bot);
    if (goal(f.x, f.y, f.z)) return true;
    const r = await mv.goto(c, { goal, cancel, maxNodes: 12000, tries: 2, maxDrop: 3 });
    job.log(`${name}: to the bench ${r.ok ? `at ${feet(bot).x} ${feet(bot).y} ${feet(bot).z}` : `failed (${String(r.why).slice(0, 80)})`}`);
    return r.ok;
}

/**
 * The loop of one bot until the build is done, the bot is gone or `cancel`. Returns { ended: 'finished' | 'cancelled' | 'disconnected' | 'wrong_mode' }.
 */
/**
 * The site's terrain by the pit (job.planPit): this bot works the pit job's units with the work layer (runWorker, the pit's own runUnit, nav moves, the action layer's mine)
 * until the pit is finished, then the build goes on. `work` comes from the service: { env(): the bot's work environment, opts: runWorker options (handlers, events) }.
 */
async function clearByPit(job, name, bot, mv, cancel, work) {
    const P = job.pitPhase;
    const env = work.env();
    if (!env) { job.pitDone('no work environment for the bots'); return null; }
    env.within = P.box; bot.__mineBox = P.box;
    (job.inPit || (job.inPit = new Set())).add(name);
    // a pit that has finished no unit for PIT_STALL_MS (the last units of a region retried by one bot while the crew waits: b081d, 2 239 of 2 304 units for 20 min, tree blocks
    // the pit could not reach) is wrapped up: what it left goes to the next round, then is parked; the crew does not wait for ever
    if (!P.watch) {
        P.seen = { done: -1, at: Date.now() };
        P.watch = setInterval(() => {
            if (P.done) { clearInterval(P.watch); return; }
            const g = P.impl.ledger.progress();
            // (every unit done: the pit's own end (its final sweep, the tree pass, its movement blocks) is running, and it is not cut short)
            if (g.done !== P.seen.done || g.finished) { P.seen = { done: g.done, at: Date.now() }; return; }
            if (Date.now() - P.seen.at > PIT_STALL_MS && P.impl.wrapUp) { job.log(`clearing by the pit: no unit finished for ${Math.round(PIT_STALL_MS / 60000)} min (${g.done} of ${g.total}, ${g.leased} leased): wrapped up`); P.stalled = true; P.impl.wrapUp(); clearInterval(P.watch); }
        }, 10000);
    }
    bot.__builderOwns = false;                    // the work layer's fall and breath reflexes are the pit's
    let res;
    // the worker's own steps as pause labels: its claim of a unit, the unit (digging and walking are actions), the back-off after a failure, the idle wait for a unit
    const ACT = { claim: 'cpu: pit claim', unit: 'other: pit unit', backoff: 'retry: pit back-off after a failed unit', recover: 'retry: pit recovery', idle: 'wait: pit, no unit to claim (layer gate, others)', check: 'other: pit layer check', sweep: 'other: pit final sweep', audit: 'cpu: pit audit', janitor: 'other: pit janitor', script: 'retry: pit script (tool, item)' };
    try { res = await runWorker(P.impl, name, env, { cancel, pollMs: 1000, ...(work.opts || {}), act: (a) => PZ.setSub(a ? ACT[a] || `other: pit ${a}` : null) }); }
    finally { PZ.setSub(null); bot.__mineBox = null; bot.__builderOwns = true; job.inPit.delete(name); }
    // the hand-over (bt075j: pumpkins of the pit's own movement left standing when its workers ended, unknown to the build's ledger, so never taken away): every block the work
    // layer still lists as this bot's around the box becomes an entry of the build's ledger, released (its step, the pit, is over), and leaves the work layer's list
    adoptWorkTemps(job, name, bot, P.box);
    // the pit's rubble out of the pack (the test worlds put every drop straight into it): the materials need the room
    try { await SUP.dropRubble(bot, keepRubble(job), { minFree: 40 }); } catch (_) { /* a full pack is dealt with before the next work too */ }
    // (this round's end only: a bot whose worker of an earlier round ended late marked the next round done, bt075j round 2 'done after 8 s: done 0, pending 2303')
    if (job.pitPhase === P && (res.ended === 'finished' || P.impl.ledger.finished())) job.pitDone(`${name}: ${res.ended}`);
    else if (!['died', 'disconnected', 'cancelled', 'wrong_dimension'].includes(res.ended)) {
        P.ends = (P.ends || 0) + 1; job.log(`${name}: pit worker ended ${res.ended}${res.last ? ` (${res.last})` : ''}; ${res.units} units, ${res.failed} failed`);
        if (P.ends > 6 * Math.max(1, job.bots.size)) job.pitDone(`${P.ends} worker ends without the pit finishing`);
        await sleep(3000, 'retry: pit worker ended');
    }
    return res;
}

/** The work layer's blocks of this bot that still stand around the box: into the build's ledger, released, and out of the work layer's list (clearByPit). Returns how many. */
function adoptWorkTemps(job, name, bot, box, margin = 24) {
    const reg = bot.__temps; if (!reg || !reg.list) return 0;
    const dim = require('../work/bot/temps').dimOf(bot);
    let n = 0;
    for (const r of reg.list((q) => q.by === name && q.dim === dim && q.x >= box.x0 - margin && q.x <= box.x1 + margin && q.z >= box.z0 - margin && q.z <= box.z1 + margin && q.y >= box.bottom - margin && q.y <= box.top + margin)) {
        const c = { x: r.x, y: r.y, z: r.z }, h = seen(bot, c);
        reg.remove(dim, c);
        if (!h || S.AIR.has(h.name) || FLUID(h)) continue;
        const e = job.ledger.intend(c, h.name, r.kind === 'bridge' ? 'bridge' : 'pillar', name);
        job.ledger.observe(c, h.name);
        const ee = job.ledger.get(c) || e;
        if (ee && !ee.released) { ee.released = { at: Date.now(), why: 'left by the pit' }; job.ledger.n.released++; }
        n++;
    }
    if (n) { job.log(`${name}: ${n} blocks of the pit's movement still standing are the build's to take away now`); job._offerTemps(Date.now(), true); }
    return n;
}

/**
 * A dead crew member's pack, picked up where it fell before it despawns (five minutes), as a player goes back for their things: the respawned bot itself, or after 20 s the
 * first other bot to come by its loop. Counted: what was dropped and what came back (stats.drops). The trip is given up after 3 minutes or 4.5 minutes after the death.
 */
async function recoverDrops(job, name, bot, mv, cancel) {
    const now = Date.now();
    for (const d of job.drops) {
        if (d.done) continue;
        if (now - d.at > 270000) { d.done = true; job.log(`drops: the pack of ${d.by} at ${d.x},${d.y},${d.z} was not picked up in time (${d.n} items)`); continue; }
        if (d.claimed && d.claimed !== name) continue;
        if (!d.claimed && d.by !== name && now - d.at < 20000) continue;
        d.claimed = name;
        const before = SUP.carried(bot), t0 = Date.now(), c = { x: d.x, y: d.y, z: d.z };
        job.log(`drops: ${name} goes for the pack of ${d.by} at ${c.x},${c.y},${c.z} (${d.n} items)`);
        try {
            await PZ.within('trip: a dead bot\'s pack', async () => {
                await mv.goto(c, { goal: (x, y, z) => Math.abs(x - c.x) <= 1 && Math.abs(z - c.z) <= 1 && Math.abs(y - c.y) <= 2, cancel, maxNodes: 30000, tries: 3 });
                // each stack lying within six cells: walked onto (the server hands an item to the body that touches it)
                for (let k = 0; k < 24 && !cancel.cancelled && Date.now() - t0 < 180000; k++) {
                    const p = bot.entity.position, lying = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(new Vec3(c.x + 0.5, c.y, c.z + 0.5)) < 6).sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
                    if (!lying) break;
                    const q = { x: Math.floor(lying.position.x), y: Math.floor(lying.position.y + 0.2), z: Math.floor(lying.position.z) };
                    await mv.goto(q, { goal: (x, y, z) => x === q.x && z === q.z && Math.abs(y - q.y) <= 1, cancel, maxNodes: 3000, tries: 1 });
                    await sleep(600, 'server: the pickup');
                }
            });
        } catch (e) { job.log(`drops: ${name}: ${e.message}`); }
        const after = SUP.carried(bot); let got = 0; for (const [k, n] of Object.entries(d.items)) got += Math.max(0, Math.min(n, (after[k] || 0) - (before[k] || 0)));
        d.done = true; job.stats.drops.recovered += got;
        job.log(`drops: ${name} picked up ${got} of the ${d.n} items ${d.by} dropped`);
        return;
    }
}

/**
 * The build's items lying on the site (items.js: a toss nobody picked up, a block that popped off its support, a stack dropped at the chest): the nearest bot with room walks
 * onto each before it despawns, as a player picks up what lies about (b081u4: 128 smooth stone of a hand-over and a stack at the chest despawned). A stack is left for 15 s to
 * whoever it was meant for; one bot per stack (60 s), given up after three failed walks. Counted: stats.ground (tried, picked).
 */
async function recoverGround(job, name, bot, mv, cancel) {
    const W = job.itemWatch; if (!W || !bot.entity || SUP.freeSlots(bot) < 2) return false;
    const now = Date.now(), p = bot.entity.position, claims = W.claims || (W.claims = new Map());
    let best = null;
    for (const r of W.recs.values()) {
        if (r.fate || !r.item || !job.t.items.has(r.item) || now - r.at < 15000 || now - r.at > 270000 || (r.tries || 0) >= 3) continue;
        const c = claims.get(r.id); if (c && c.by !== name && now - c.at < 60000) continue;
        const e = bot.entities[r.id] || r.ent; if (!e || !e.position) continue;
        const d = e.position.distanceTo(p); if (d > 48) continue;
        if (!best || d < best.d) best = { r, e, d };
    }
    if (!best) return false;
    const { r, e } = best, q = { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.2), z: Math.floor(e.position.z) }, n0 = SUP.carried(bot)[r.item] || 0;
    claims.set(r.id, { by: name, at: now }); r.tries = (r.tries || 0) + 1;
    const st = job.stats.ground || (job.stats.ground = { tried: 0, picked: 0 }); st.tried++;
    try {
        await PZ.within('trip: items on the ground', async () => {
            await mv.goto(q, { goal: (x, y, z) => x === q.x && z === q.z && Math.abs(y - q.y) <= 1, cancel, maxNodes: 8000, tries: 1 });
            for (let i = 0; i < 8 && !r.fate; i++) await sleep(150, 'server: the pickup');
        });
    } catch (err) { job.log(`${name}: items on the ground at ${q.x},${q.y},${q.z}: ${err.message}`); }
    const got = (SUP.carried(bot)[r.item] || 0) - n0;
    if (got > 0) st.picked += got;
    if ((job.groundLog = (job.groundLog || 0) + 1) <= 60) job.log(`${name}: ${r.count} ${r.item} lying at ${q.x},${q.y},${q.z} (${r.cause}${r.by ? ` by ${r.by}` : ''}): ${got > 0 ? `picked up ${got}` : r.fate ? `taken by ${r.fateBy || '?'}` : 'not reached'}`);
    return true;
}

/**
 * The build's material ledger per item: supplied = placed + in the crew's packs + in the chest and the depot boxes (as last read) + unaccounted (lying on the ground or lost:
 * despawned, burnt). Every item missing at the end has a named place (orchestrator 2026-11-27: b081q4 ran out of smooth stone, redstone and repeaters with the supply at +5 %).
 * `placed` counts the blueprint's cells of the item that are right (its cells less those still to place or parked). Items with something unaccounted, worst first.
 */
function materials(job) {
    const sup = (job.supply && job.supply.totals) || {}, out = [];
    const left = {}; for (const tk of job.tasks.values()) { if (tk.kind !== 'place') continue; const it = job._itemOf(tk); if (it) left[it] = (left[it] || 0) + 1; }
    if (job.parkedTk) for (const { tk } of job.parkedTk.values()) { if (tk.kind !== 'place') continue; const it = job._itemOf(tk); if (it) left[it] = (left[it] || 0) + 1; }
    const packs = {}; for (const p of (job.packs || new Map()).values()) for (const [k, n] of Object.entries(p)) packs[k] = (packs[k] || 0) + n;
    const store = {}; const site = (job.sites || [])[0]; if (site && site.holdsAll) for (const [k, n] of Object.entries(site.holdsAll)) store[k] = (store[k] || 0) + n;
    for (const c of job.depot || []) if (c.holds) for (const [k, n] of Object.entries(c.holds)) store[k] = (store[k] || 0) + n;
    const W = job.itemWatch, ground = W ? W.ground() : {}, gone = W ? W.despawned() : {}, sum = W ? W.summary() : {};
    for (const [it, need] of job.t.items) {
        if (!sup[it]) continue;
        const placed = Math.max(0, need - (left[it] || 0)), un = sup[it] - placed - (packs[it] || 0) - (store[it] || 0);
        // of the unaccounted: lying on the site now, despawned, and the rest that no item entity explains (placed outside the box, a cell the survey reads wrong)
        // (and dug out of the build on a way out without getting it back: glass without Silk Touch, outMover)
        const g = ground[it] || 0, d = gone[it] || 0, s = sum[it], dl = (job.lost && job.lost.get(it)) || 0;
        out.push({ it, supplied: sup[it], placed, packs: packs[it] || 0, store: store[it] || 0, unaccounted: un, ground: g, despawned: d, dugLost: dl, other: un - g - d - dl, needLeft: left[it] || 0, spawned: s ? s.spawned : {} });
    }
    return out.sort((a, b) => b.unaccounted - a.unaccounted);
}

/**
 * The build's items nobody has any more: every container was seen without it on the last trip that asked (job.outOf, cleared when a trip gets it or a bot puts it back), no
 * pack of the crew holds one and none lies on the site (items.js). Their cells are parked 'out of stock' (job.stock) so the place stage can end.
 */
function outOfStock(job) {
    const out = new Set(); if (!job.outOf) return out;
    const packs = {}; for (const p of (job.packs || new Map()).values()) for (const [k, n] of Object.entries(p)) packs[k] = (packs[k] || 0) + n;
    const ground = job.itemWatch ? job.itemWatch.ground() : {};
    // (and the chest and the depot hold none as last read, box contents included: a trip that did not get to a box reported torches 'absent' while the chest's boxes held all
    // 26, and the 24 torch cells were parked out of stock at minute 29, b081v4)
    const store = {}; const site = (job.sites || [])[0]; if (site && site.holdsAll) for (const [k, n] of Object.entries(site.holdsAll)) store[k] = (store[k] || 0) + n;
    for (const c of job.depot || []) if (c.holds) for (const [k, n] of Object.entries(c.holds)) store[k] = (store[k] || 0) + n;
    if (!site || !site.holdsAll) return out;          // the chest not read yet: nothing is out
    for (const it of job.t.items.keys()) if (job.outOf.has(it) && !(packs[it] > 0) && !(ground[it] > 0) && !(store[it] > 0) && !SUP.TOOL.test(it)) out.add(it);
    return out;
}

/** One bot of the crew, its pauses classified (pauses.js): the drive runs in the bot's own store. */
function drive(job, name, bot, opts = {}) {
    const stop = PZ.attach(bot, name);
    return PZ.run(name, () => drive0(job, name, bot, opts)).finally(stop);
}
async function drive0(job, name, bot, { cancel = { cancelled: false }, supplySites = [], pitWork = null } = {}) {
    if (bot.game && !['survival', 'creative'].includes(bot.game.gameMode)) return { ended: 'wrong_mode' };
    job.sites = supplySites;
    job.ownBlock = job.ownBlock || ((x, y, z) => !!ownBlockItem(job, x, y, z));
    if (!job.bots.has(name)) job.bots.set(name, { station: null, pos: feet(bot) });
    const mv = new Mover(bot, rules(job, bot), { log: job.log });
    if (PEER) { job.pool = job.pool || new Pool(job); job.pool.join(name, bot, mv); mv.between = () => job.pool.serve(name); }
    bot.__mine = mv.mine;          // its own temporary blocks (rules.doomed lets it stand on them)
    (job.moverRules || (job.moverRules = new Map())).set(name, mv.rules);          // the claim judges stances by these
    const onDeath = () => { const p = bot.entity && bot.entity.position, f = p ? feet(bot) : null, around = f ? [-1, 0, 1].map((dy) => (seen(bot, { x: f.x, y: f.y + dy, z: f.z }) || {}).name).join('/') : '?'; job.stats.deaths = (job.stats.deaths || 0) + 1; const gs = mv.guard && mv.guard.lastStop; job.log(`${name} died at ${f ? `${f.x},${f.y},${f.z}` : '?'} (${around}), stage ${job.stage}${gs ? `; fall guard last held it ${Math.round((Date.now() - gs.at) / 1000)} s ago at ${gs.x},${gs.y},${gs.z}` : ''}; last: ${mv.trace.join(' | ')}`); };
    bot.on('death', onDeath);
    // a dead bot's temporary blocks are the crew's at once (owner list 5 Large 1, point 4: nothing is orphaned); the respawned bot takes them like any other
    // the pack it dropped (keep_inventory off): where and what, for the crew to pick up before it despawns (recoverDrops; b081q4: Bd4g's full pack lay at the foot of its fall)
    let lastPack = {};
    const onDied = () => { job.orphanOf(name, 'died'); mv.mine.clear(); const p = bot.entity && bot.entity.position; if (p) { const n = Object.values(lastPack).reduce((a, k) => a + k, 0); (job.drops || (job.drops = [])).push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: Date.now(), by: name, items: { ...lastPack }, n, claimed: null, done: false }); const st = job.stats.drops || (job.stats.drops = { packs: 0, dropped: 0, recovered: 0 }); st.packs++; st.dropped += n; } };
    bot.on('death', onDied);
    // the server's word on every block change this bot sees: confirms or ends temporary blocks, whoever placed or broke them (temps.js)
    // a temporary block that comes into the world with no ledger entry (cause a of the end scan: 1 / 1 / 13 of the leftovers of build_t-w121-smoke, no code path known): the
    // nearest bot and its last moves, once per cell, the first 40 of the job (the bot within 5 of the cell logs it)
    const onBlock = (o, n) => {
        if (!n || !n.position) return;
        if (job.ledger.size) job.ledger.observe(n.position, n.name);
        const nm = String(n.name || ''); if (!tempKinds().includes(nm) || (o && o.name === nm) || job.ledger.get(n.position)) return;
        if ((job.pitPhase && !job.pitPhase.done) || (job.inPit && job.inPit.size)) return;          // the pit's movement blocks are the work layer's (src/work/bot/temps.js) until the hand-over
        const p = bot.entity && bot.entity.position; if (!p || Math.hypot(p.x - n.position.x - 0.5, p.y - n.position.y, p.z - n.position.z - 0.5) > 5) return;
        const k = `${n.position.x},${n.position.y},${n.position.z}`; job.unreg = job.unreg || new Map(); if (job.unreg.has(k)) return;
        job.unreg.set(k, Date.now()); if (job.unreg.size <= 40) job.log(`[temps] unregistered ${nm} at ${k} beside ${name} (was ${o ? o.name : '?'}; held ${bot.heldItem ? bot.heldItem.name : 'nothing'}); last moves ${mv.trace.slice(-4).join(' | ')}`);
    };
    bot.on('blockUpdate', onBlock);
    const unwatch = require('./machine').attach(job, bot, job.log);          // the build's pistons that fire and the cells they move (target zero)
    // every item entity on the site, why it appeared and where it went (items.js): the material ledger's ground and despawned columns
    const IW = job.itemWatch || (job.itemWatch = new (require('./items').ItemWatch)(job));
    const unitems = IW.attach(name, bot, { crew: (n) => job.bots.has(n), giver: (n) => !!job.pool && [...job.pool.reqs.values()].some((r) => r.to === n && (r.state === 'coming' || r.state === 'tossed')), free: () => SUP.freeSlots(bot) });
    // once a second: how many of its temporary blocks stand beyond the column it stands on (the owner's two-per-bot standard, temps.js sample)
    let looseLog = 0;
    const sampler = setInterval(() => { try { const W = job.itemWatch; if (W && Date.now() - (W.refAt || 0) >= 900) { W.refAt = Date.now(); W.refresh(); } } catch (_) { /* the next second */ } try { if (bot.inventory) { lastPack = SUP.carried(bot); (job.packs || (job.packs = new Map())).set(name, lastPack); } } catch (_) { /* the next second */ } try { if (bot.entity && job.ledger.size) { const f = feet(bot), n = job.ledger.sample(name, f); if (n > 2 && Date.now() - looseLog > 60000) { looseLog = Date.now(); job.log(`[temps] ${name} at ${f.x},${f.y},${f.z} holds ${n} beyond its column: ${job.ledger.lastLoose.join('; ')}; last moves ${mv.trace.slice(-3).join(' | ')}`); } } } catch (_) { /* a sample is only a count */ } }, 1000);
    // the step is over: the bot's own temporary blocks go before it does anything else (release)
    // a bot without any action for a minute (no packet, no step): once per pause, where it is, what it is in and its mover's last steps (b081k: 33 pauses of 70-360 s
    // in the mover's tick waits that no other line explained)
    let stallAt = 0;
    const stallWatch = setInterval(() => { try {
        const o = PZ.open(name); if (!o || o.ms < 60000) { stallAt = 0; return; }
        if (stallAt) return; stallAt = Date.now();
        const p = bot.entity && bot.entity.position;
        job.stats.stalls = (job.stats.stalls || 0) + 1;
        job.log(`[stall] ${name} no action for ${Math.round(o.ms / 1000)} s at ${p ? `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` : '?'} in ${o.stack.join(' > ') || '-'}${o.sub ? ` (${o.sub})` : ''}${o.fail ? `, after ${o.fail}` : ''}; controls ${['forward', 'back', 'left', 'right', 'jump', 'sneak'].filter((c) => bot.controlState && bot.controlState[c]).join('+') || 'none'}${mv.guard ? `; guard held ${mv.guard.stops}` : ''}; ${mv.trace.slice(-4).join(' | ')}`);
    } catch (_) { /* a report never breaks the drive */ } }, 15000);
    const settle = (next = null, label = 'step') => PZ.within('release', () => release(job, name, bot, mv, cancel, next, label));
    // the server dropped the spawn point (the bed broken or shut in): set again
    const onReset = () => { if (job.spawnSet) job.spawnSet.delete(name); if (job.anchorTry) job.anchorTry.delete(name); job.log(`${name}: the server reset its spawn point`); };
    bot.on('spawnReset', onReset);
    bot.__builderOwns = true;                // the fall and breath reflexes stay out of a builder's way (work/bot/reflex.js)
    let idle = 0, chain = null;
    // the watchdog: the last time this bot got something done (a task that held, a supply trip that brought something); EVACUATE_MS without while there is work: off the site
    const progress = () => { (job.progressAt || (job.progressAt = new Map())).set(name, Date.now()); };
    progress();
    try {
        while (!cancel.cancelled) {
            if (!job.done && job.stage !== 'settle' && job.stage !== 'survey' && job.tasks.size && Date.now() - job.progressAt.get(name) > EVACUATE_MS) {
                await settle(null, 'evacuate');
                await evacuate(job, name, bot, mv, cancel, `nothing done for ${Math.round((Date.now() - job.progressAt.get(name)) / 60000)} min`);
                progress();
                continue;
            }
            if (job.done) {
                await settle(null, 'done');
                // the depot's boxes back into the chest, by one bot (alone at the chest: a box it breaks drops into its own reach)
                if (job.depot && job.depot.length && !job.repacking && job.sites[0]) {
                    job.repacking = name;
                    try { await mv.goto(job.sites[0], { goal: nearContainer(job.sites[0]), cancel, maxNodes: 40000 }); const lost = await SUP.repack(bot, job.sites[0], job.depot, mv, { log: job.log, build: job.t.items }); job.log(`${name}: depot boxes put back into the chest${lost ? `, ${lost} not picked up` : ''}`); }
                    catch (e) { job.log(`${name}: repacking failed: ${e.message}`); }
                }
                return { ended: 'finished' };
            }
            if (!bot.entity || bot._client.ended) return { ended: 'disconnected' };
            // short of air: up to the surface first (the breath reflex is off for builders; four bots drowned retrying a one-cell step in water, live 2026-11-24 ha13 w3)
            // (only in water, and with a real pause after it: out of the water the call returned at once, the loop never gave the event loop a turn, the air level never
            // came back and the whole crew's process froze for minutes, live 2026-11-24 ha15 w4)
            if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < 12 && bot.entity && bot.entity.isInWater && Date.now() - ((job.surfAt && job.surfAt.get(name)) || 0) > 3000) { (job.surfAt || (job.surfAt = new Map())).set(name, Date.now()); job.log(`${name}: air ${bot.oxygenLevel}: to the surface`); await mv.surface(cancel); await sleep(300); continue; }
            // respawned in another dimension (a death in the Nether respawns in the Overworld): the job's cells are not in this world; the bot leaves the crew until a player brings it back
            // (it walked the Nether's coordinates in the Overworld for an hour, live 2026-11-22 sW w6)
            if (bot.game) { const d0 = (job.dims || (job.dims = new Map())).get(name); if (d0 === undefined) job.dims.set(name, bot.game.dimension); else if (d0 !== bot.game.dimension) { job.log(`${name} is in ${bot.game.dimension} now, not ${d0} (respawned after a death): it leaves the crew`); return { ended: 'wrong_dimension' }; } }
            // the supply: read once by one bot (the next one tries when a read fails)
            if (job.available === null) {
                job.supplyTried = job.supplyTried || new Set();
                if (!job.supplyReading && job.supplyTried.has(name) && [...job.bots.keys()].some((n) => !job.supplyTried.has(n))) { await sleep(500, 'wait: another bot reads the supply'); continue; }
                if (!job.supplyReading) {
                    await settle(null, 'supply read');
                    job.supplyTried.add(name);
                    job.supplyReading = SUP.readSupply(bot, supplySites, (s) => mv.goto(s, { goal: nearContainer(s), cancel, maxNodes: 40000 }), { log: job.log }).then((s) => {
                        if (!s.read.length) { job.log(`supply: ${name} could not read any container (${JSON.stringify(s.failed).slice(0, 300)})`); if ([...job.bots.keys()].every((n) => job.supplyTried.has(n))) job.supplyTried.clear(); job.supplyReading = null; return; }
                        job.supply = s; job.available = new Set(Object.keys(s.totals).filter((k) => s.totals[k] > 0));
                        job.tempItem = SUP.tempFrom(s.totals, new Set(job.t.items.keys()));
                        job.log(`supply read by ${name}: ${Object.keys(s.totals).length} item types; temporary block ${job.tempItem || 'NONE (pillars and bridges impossible)'}`);
                    }, (e) => { job.log(`supply read failed: ${e.message}`); job.supplyReading = null; });
                }
                await job.supplyReading; await sleep(200, 'wait: the supply read'); continue;
            }
            // (at most every two minutes per bot: without glowstone it went for it on every turn of the loop, 107 trips, live 2026-11-23 ha5 w1)
            if (!inNether(bot) && job.available.has(SPAWN_BED) && !(job.spawnSet && job.spawnSet.has(name)) && !job.anchorBusy && Date.now() - ((job.anchorTry && job.anchorTry.get(name)) || 0) > 120000) { (job.anchorTry || (job.anchorTry = new Map())).set(name, Date.now()); await settle(null, 'bed'); await bedSpawn(job, name, bot, mv, cancel); }
            // far from its site (it woke at the world's spawn after a death): it leaves the crew instead of working another crew's site (live 2026-11-23 ha11 w3)
            { const b0 = job.t.box, p = bot.entity.position, d = Math.hypot(p.x - (b0.x + b0.sx / 2), p.z - (b0.z + b0.sz / 2)); if (d > 200) { job.log(`${name} is ${Math.round(d)} blocks from the site (respawned far away): it leaves the crew`); return { ended: 'too_far' }; } }
            // (and whenever the anchor runs low, by the bot nearest to it, at most once a minute for the crew: nobody charged it again after the first four)
            if (inNether(bot) && job.available.has('respawn_anchor') && lowAnchor(job, bot) && !job.anchorBusy && Date.now() - (job.rechargeAt || 0) > 60000 && bot.entity.position.distanceTo(new Vec3(job.anchorAt.x, job.anchorAt.y, job.anchorAt.z)) < 32) { job.rechargeAt = Date.now(); job.log(`${name}: the respawn anchor holds ${charges(bot, job.anchorAt)} charges: charged again`); await settle(null, 'anchor'); await anchor(job, name, bot, mv, cancel); }
            if (inNether(bot) && job.available.has('respawn_anchor') && !(job.spawnSet && job.spawnSet.has(name)) && !job.anchorBusy && Date.now() - ((job.anchorTry && job.anchorTry.get(name)) || 0) > 120000) { (job.anchorTry || (job.anchorTry = new Map())).set(name, Date.now()); await settle(null, 'anchor'); await anchor(job, name, bot, mv, cancel); }
            if (job.drops && job.drops.some((d) => !d.done)) await recoverDrops(job, name, bot, mv, cancel);
            // the build's items lying about: picked up before they despawn (at most every 10 s per bot)
            if (job.itemWatch && job.stage !== 'survey' && Date.now() - ((job.groundAt && job.groundAt.get(name)) || 0) > 10000) { (job.groundAt || (job.groundAt = new Map())).set(name, Date.now()); if (await recoverGround(job, name, bot, mv, cancel)) continue; }
            if (job.exhausted()) { await PZ.within('cpu: survey', () => job.resurvey(bot, `${name}: stage ${job.stage} done`)); continue; }
            // the terrain first, by the pit (after the first survey, with the tools of the first trip in the pack)
            // (only with its tools and temporary blocks in the pack: the trip before the pit fetches those and nothing else; b081b: two bots went in with an empty pack after a
            // trip that brought nothing and ended their pit worker 22 times on missing_item; the others carried their whole area's materials into the pit)
            if (pitWork && job.stage !== 'survey' && !job.wrapping && job.planPit(bot) && !job.pitPhase.done) {
                const kit = needsFor(job, bot, {});
                if (!Object.keys(kit).length) {
                    await settle(null, 'pit');
                    const r = await PZ.within('pit', () => clearByPit(job, name, bot, mv, cancel, pitWork));
                    if (r && (r.ended === 'died' || r.ended === 'disconnected')) return { ended: r.ended };
                    progress(); continue;
                }
                if (job.lastTrip && Date.now() - (job.lastTrip.get(name) || 0) < 60000) { await sleep(3000, 'wait: tools and blocks for the pit'); continue; }
            }
            // the fall guard's count (ticks it held a body back from a fall) and the pool's, for the progress line
            if (mv.guard) {
                (job.guardStops || (job.guardStops = new Map())).set(name, mv.guard.stops); job.stats.guard = [...job.guardStops.values()].reduce((a, n) => a + n, 0);
                // a bot the guard held back for long (it keeps pushing at an edge its plan says it may cross): where, and what is under it, once a minute
                const gm = job.guardMin || (job.guardMin = new Map()), g0 = gm.get(name);
                if (!g0) gm.set(name, { at: Date.now(), n: mv.guard.stops });
                else if (Date.now() - g0.at > 60000) {
                    const d = mv.guard.stops - g0.n, ls = mv.guard.lastStop, p = bot.entity.position;
                    if (d > 200 && ls) { const col = (x, z) => [0, 1, 2, 3].map((k) => (seen(bot, { x, y: ls.y - k, z }) || {}).name || '?').join('/'); job.log(`[guard] ${name} held ${d} ticks in the last minute; last at ${ls.x},${ls.y},${ls.z} (under it ${col(ls.x, ls.z)}), the bot at ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} (under it ${col(Math.floor(p.x), Math.floor(p.z))}); ${mv.trace.slice(-2).join(' | ')}`); }
                    gm.set(name, { at: Date.now(), n: mv.guard.stops });
                }
            }
            // asked for items by a colleague on its way here: it waits for it a moment and throws them over (not off to another stance meanwhile)
            // the material ledger, every five minutes: supplied = placed + packs + chest/depot + unaccounted (lying or lost), per item, in the log and the progress line
            if (Date.now() - (job.matAt || 0) > 300000 && job.stage !== 'survey') { job.matAt = Date.now(); try { const m = materials(job); job.stats.unaccounted = Object.fromEntries(m.filter((r) => r.unaccounted > 0).slice(0, 8).map((r) => [r.it, r.unaccounted])); job.log(`[materials] supplied = placed + packs + store + unaccounted (ground / despawned / dug and not got back / other; dropped by cause): ${m.slice(0, 10).map((r) => `${r.it} ${r.supplied} = ${r.placed} + ${r.packs} + ${r.store} + ${r.unaccounted} (${r.ground}/${r.despawned}/${r.dugLost}/${r.other}; ${JSON.stringify(r.spawned)}) (to place ${r.needLeft})`).join('; ')}`); } catch (e) { job.log(`[materials] ${e.message}`); } }
            // items nobody has any more: their cells out of the stage (twice a minute)
            if (job.available && Date.now() - (job.stockAt || 0) > 30000 && job.stage !== 'survey') { job.stockAt = Date.now(); const out = outOfStock(job), r = job.stock(out); if (r.parked || r.back) job.log(`stock: ${r.parked} cells parked out of stock (${[...out].join(', ') || 'none'}), ${r.back} back`); job.stats.outOfStock = [...out].join(',') || undefined; }
            { const PL = require('./move').PLANS; job.stats.plans = `${PL.n} ${Math.round(PL.ms / 1000)}s failed ${PL.failed} flood-routes ${PL.flood} sinks ${PL.sinks}/${PL.sinks + PL.sinkFailed}`; }
            if (job.pool) { await PZ.within('wait: hand-over (giver)', () => job.pool.hold(name, cancel)); const ps = job.pool.status(); job.stats.pool = `${ps.served}/${ps.asked} ${ps.items}it`; }
            // tools and temporary blocks before the work needs them
            const base = needsFor(job, bot, {});
            // (not while the run wraps up: only the temporary blocks are work then, and each trip for a tool laid new ones on the way, bt075a w3: 262 put down in its first three minutes)
            if (Object.keys(base).length && job.stage !== 'settle' && !job.wrapping && !(job.lastTrip && Date.now() - job.lastTrip.get(name) < 60000)) { (job.lastTrip = job.lastTrip || new Map()).set(name, Date.now()); await settle(null, 'trip'); const tt = Date.now(); await PZ.within('trip', () => supplyTrip(job, name, bot, mv, {}, within(cancel, 180000))); job.time.trip += Date.now() - tt; continue; }
            // a handover: items the chest is out of that this bot carries and has not placed for two minutes go back into the chest for the bots that need them (four
            // bots each held what the others' cells needed and the chest was empty, live 2026-11-23 gd1 w1)
            // (every two minutes, and only stacks worth the walk: at 30 s, 151 hand-back walks were 40 % of the crew's time in the tail, ha29 w2)
            // (not with the shared pool: a colleague asks for what it needs and gets it thrown over, nothing goes back into the chest just in case)
            if (!job.pool && job.outOf && job.sites[0] && Date.now() - (job.handAt && job.handAt.get(name) || 0) > 120000) {
                (job.handAt || (job.handAt = new Map())).set(name, Date.now());
                const mine = (job.used && job.used.get(name)) || new Map(), inv = SUP.carried(bot);
                let sn = job.sectorNeeds ? job.sectorNeeds(name) : {};          // not what its own sector still needs (items went back and forth, 24 hand-backs in 28 min, gg1 w3)
                // in the tail only what the cells near it need: items kept for an area's cells nobody reaches left the chest empty while 277 of 304 ready cells waited for them (ha28 w1)
                { let left = 0; for (const t of job.tasks.values()) if (t.kind === 'place') left++; if (left < 2000) { const me = feet(bot); sn = {}; for (const t of job.tasks.values()) { if (t.kind !== 'place' || Math.abs(t.x - me.x) > 12 || Math.abs(t.z - me.z) > 12 || Math.abs(t.y - me.y) > 8) continue; const it = job._itemOf(t); if (it) sn[it] = (sn[it] || 0) + 1; } } }
                const give = [...job.outOf.entries()].filter(([it, t]) => t > Date.now() && inv[it] >= Math.min(8, SUP.stackOf(bot, it)) && !(sn[it] > 0) && Date.now() - (mine.get(it) || 0) > 120000).map(([it]) => it);
                if (give.length && (!job.gate || job.gate.inside.size < SUPPLY_PAR)) {
                    await settle(null, 'hand-back');
                    (job.gate || (job.gate = { inside: new Set(), wait: new Map() })).inside.add(name);
                    const th = Date.now();
                    try {
                        const r = await mv.goto(job.sites[0], { goal: nearContainer(job.sites[0]), cancel: within(cancel, 120000), maxNodes: 40000 });
                        if (r.ok) { const back = await SUP.deposit(bot, job.sites[0], give); for (const it of Object.keys(back)) job.outOf.delete(it); job.log(`${name}: handed back ${JSON.stringify(back)} for the others`); }
                    } catch (e) { job.log(`${name}: hand-back failed: ${e.message}`); } finally { job.gate.inside.delete(name); job.time.trip += Date.now() - th; }
                    continue;
                }
            }
            // nothing of the build while the pit clears the site (a bot that has not gone in yet waits for its trip)
            if (job.pitPhase && !job.pitPhase.done) { await sleep(2000, 'wait: the pit clears the site'); continue; }
            const have = SUP.carried(bot);
            // the cells it can reach from here, by the mover's own moves (job.claim offers stances among them); again after a move or 15 s
            { const f0 = feet(bot), fk = `${f0.x},${f0.y},${f0.z}`, F = job.floods && job.floods.get(name); if (!F || F.from !== fk || Date.now() - F.at > 30000) { const tf = Date.now(); (job.floods || (job.floods = new Map())).set(name, await PZ.within('cpu: flood', () => mv.flood())); job.time.claim += Date.now() - tf; } }
            // items this bot's last trip came back without are not asked for by it for a minute: it works on what it has instead of waiting (owner 2026-11-23 list 4 problem 5)
            { const t = mv.rules.temp(); (job.tempsOf || (job.tempsOf = new Map())).set(name, t ? have[t] || 0 : 0); }
            const mySkip = (job.noItem && job.noItem.get(name)) || new Map();
            const tc = Date.now(); const spareMemo = new Map(), peerHas = (it) => { if (!job.pool) return false; if (!spareMemo.has(it)) spareMemo.set(it, job.pool.canSpare(name, it)); return spareMemo.get(it); };
            // (an item the chest is out of that a colleague can spare is asked for, not left to the bots that carry it: they work elsewhere, ha28-ha30 tails)
            // the run goes on (job.claimNext: the next stance along the line of the last batch), else a full claim
            const cl = (chain && PZ.sync('claim next', () => job.claimNext(bot, name, chain, (it) => have[it] || 0))) || PZ.sync('claim', () => job.claim(bot, name, Date.now(), (it) => have[it] || 0, (it) => (!!job.outOf && (job.outOf.get(it) || 0) > Date.now() && !(have[it] > 0) && !peerHas(it)) || (mySkip.get(it) || 0) > Date.now())); const dc = Date.now() - tc; job.time.claim += dc; if (dc > 400) job.log(`${name}: claim took ${dc} ms (${job.lastClaimInfo || ''})`);
            { const w = !cl ? 'nothing' : cl.need ? `need ${Object.keys(cl.need).slice(0, 3).join('+')}` : cl.moveOff ? 'move off' : 'work'; const o = job.claimWhy || (job.claimWhy = {}); o[w] = (o[w] || 0) + 1;
              if (cl && cl.tasks) { job.claimTasks = (job.claimTasks || 0) + cl.tasks.length; job.claimTasksN = (job.claimTasksN || 0) + 1; }
              if (Date.now() - (job.claimWhyAt || 0) > 60000) { job.claimWhyAt = Date.now(); const ps = job.pstat; job.log(`claims in the last minute: ${JSON.stringify(o)}; ${job.claimTasksN ? (job.claimTasks / job.claimTasksN).toFixed(1) : 0} tasks per claim${ps && ps.n ? `; place claims ${ps.n}: ready ${(ps.ready / ps.n).toFixed(0)}, doable ${(ps.doable / ps.n).toFixed(0)}, batch ${(ps.batch / ps.n).toFixed(1)}, doable in reach of the stance ${(ps.reach / ps.n).toFixed(1)}, of them no click from it ${((ps.noWay || 0) / ps.n).toFixed(1)}` : ''}`); job.pstat = null; job.claimWhy = {}; job.claimTasks = 0; job.claimTasksN = 0; } }
            // the step before is over unless the claim's stance is on the column the bot stands on (that column is the next step's)
            await settle(cl && cl.station ? cl.station : null, cl && cl.station ? 'claim' : cl && cl.need ? 'supply' : 'other');
            if (cl && cl.moveOff) {
                const f = feet(bot), floor = (x, y, z) => job.tasks.get(`${x},${y - 1},${z}`);
                const r = await mv.goto(f, { goal: (x, y, z) => Math.hypot(x - f.x, z - f.z) >= 2 && !(floor(x, y, z) && ['clear', 'untemp'].includes(floor(x, y, z).kind)), cancel, maxNodes: 4000 });
                // no way off: the cell under it waits 20 s (an instant failure, repeated without a pause, spun 1 258 times a minute and froze every bot for 17 s, live 2026-11-23 fy1 w4)
                if (!r.ok) { job.cool.set(`${f.x},${f.y - 1},${f.z}`, Date.now() + 20000); PZ.failed('no way off the cell'); await sleep(500, 'retry: no way off the cell'); }
                continue;
            }
            // out of temporary blocks and the chest out of them too: dig natural ground near the chest for them (a survival player's way: blocks bridged and dug high up fall
            // to the ground and are lost, the chest ran out after 16 min, ha19)
            if (job.tempItem && !TB.only().length && (SUP.carried(bot)[job.tempItem] || 0) + SUP.TEMPS.filter((t) => t !== job.tempItem && !job.t.items.has(t)).reduce((a, t) => a + (SUP.carried(bot)[t] || 0), 0) < 32 && job.outOf && (job.outOf.get(job.tempItem) || 0) > Date.now() && Date.now() - ((job.quarryAt && job.quarryAt.get(name)) || 0) > 60000) {
                (job.quarryAt || (job.quarryAt = new Map())).set(name, Date.now());
                const tq = Date.now(); await PZ.within('quarry', () => quarry(job, name, bot, mv, cancel)); job.time.dig += Date.now() - tq; progress(); continue;
            }
            if (cl && cl.need) {
                // a colleague first when the chest is out of an item it can spare, or when it is much nearer than the chest
                if (job.pool) {
                    const now = Date.now(), out = Object.keys(cl.need).some((it) => job.outOf && (job.outOf.get(it) || 0) > now), site = job.sites[0], p = bot.entity.position;
                    const dChest = site ? Math.hypot(site.x - p.x, site.z - p.z) + Math.abs(site.y - p.y) * 2 : Infinity, best = job.pool.offers(name, cl.need)[0];
                    if (best && (out || best.dist < dChest * 0.6)) {
                        const tp = Date.now(); const r = await PZ.within('wait: hand-over (asker)', () => job.pool.ask(name, mv, cl.need, within(cancel, 130000))); job.time.peer = (job.time.peer || 0) + Date.now() - tp;
                        if (Object.keys(r.got).length) { progress(); continue; }
                    }
                }
                const tt = Date.now(); const got = await PZ.within('trip', () => supplyTrip(job, name, bot, mv, cl.need, within(cancel, 180000))); job.time.trip += Date.now() - tt;
                // a trip that brought nothing: those items are skipped by this bot for a minute (it does other work or waits off the site), never waited for in front of the chest
                if (!got) { const m = (job.noItem || (job.noItem = new Map())).get(name) || new Map(); for (const it of Object.keys(cl.need)) m.set(it, Date.now() + 60000); job.noItem.set(name, m); } else progress();
                continue;
            }
            // nothing for it in the pocket it is in: out of the pocket now (past lava at a cost, never into it), not after minutes of trying
            if (!cl && job.pocketed && job.pocketed.delete(name) && job.reachOf && job.reachOf.has(name) && job.reachOf.get(name).from === `${feet(bot).x},${feet(bot).y},${feet(bot).z}` && !((job.pocketBack && job.pocketBack.get(name) || 0) > Date.now())) {
                job.log(`${name}: nothing to do in the ${job.reachOf.get(name).cells.size} cells it can reach: out of the pocket`);
                const pocket = job.reachOf.get(name).cells; job.reachOf.delete(name);
                // a failed way out is not tried again for two minutes (306 tries in a row from one pocket, live 2026-11-23 fz3 w2); the evacuation watchdog has the rest
                if (!(await escape(job, name, bot, mv, cancel, pocket))) { (job.pocketBack || (job.pocketBack = new Map())).set(name, Date.now() + 120000); job.log(`${name}: the pocket's edge: ${edgeOf(mv, pocket)}`); }
                continue;
            }
            // stances the claim's model could not support: the planner is asked (pillars, turning bridges, built tops), then the claim runs again with its answers
            if (!cl && job.probes && job.probes.get(name) && job.probes.get(name).length) {
                const l = job.probes.get(name); job.probes.delete(name); const tq = Date.now(); let ok = 0;
                for (const f of l.slice(0, 3)) { const c = await PZ.within('cpu: probe', () => mv.canReach(f)); job.setReach(name, f, c); if (c !== null) ok++; }
                job.time.claim += Date.now() - tq; job.stats.probes = (job.stats.probes || 0) + l.length; job.stats.probesOk = (job.stats.probesOk || 0) + ok;
                continue;
            }
            if (!cl) {
                idle++; const ti = Date.now();
                if (idle > 25 && job.stage !== 'settle') { tell(job, name, bot, 'idle', job.nothingWhy || job.lastClaimInfo || 'no task found'); progress(); }        // idle with nothing to do is not stuck
                // nothing for it (its area done, the others full): it waits on the bench, off the box and away from the chest, out of everybody's way (owner 2026-11-23 list 4 problem 7)
                if (idle === 6 && job.stage !== 'settle' && !job.wrapping) { await PZ.within('wait: bench', () => bench(job, name, bot, mv, cancel)); job.floods && job.floods.delete(name); }
                else if (idle % 5 === 1 && !job.wrapping) await PZ.within('wait: step aside', () => mv.spread(crewAt(job, bot)));          // (not while wrapping up: a step aside laid blocks after the last was taken)
                // wrapping up and standing on a temporary block (its own or another's): off it, onto ground or the build, so that it can go (bt075d w2: the last block left was
                // "a crew member on it" when the wrap-up's time ran out)
                else if (job.wrapping && idle % 5 === 1) { const f = feet(bot); if (job.ledger.has({ x: f.x, y: f.y - 1, z: f.z })) await mv.goto(f, { goal: (x, y, z) => !job.ledger.has({ x, y: y - 1, z }) && Math.hypot(x - f.x, z - f.z) <= 6, cancel, maxNodes: 2000, tries: 1 }); }
                await sleep(job.stage === 'settle' ? 1000 : 400, job.stage === 'settle' ? 'other: settle' : `wait: nothing to claim (${String(job.nothingWhy || '').replace(/-?\d+/g, '#').slice(0, 40)})`); job.time.idle += Date.now() - ti; continue;
            }
            idle = 0;
            // a claim has three minutes (a walk or a dig that never ends does not hold the bot, its claims or its stance for good)
            // rubble out of a full pack just before the walk to the stance, thrown away from it, at most every 30 s (dropped where the bot then waited, it was picked up again
            // at once, over and over: owner 2026-11-23)
            if (SUP.freeSlots(bot) < 6 && Date.now() - (job.tossAt && job.tossAt.get(name) || 0) > 30000) {
                (job.tossAt || (job.tossAt = new Map())).set(name, Date.now());
                const p = bot.entity.position, dx = cl.station.x + 0.5 - p.x, dz = cl.station.z + 0.5 - p.z;
                try { await bot.look(Math.atan2(dx, dz), 0.3, true); } catch (_) { /* the look is a nicety */ }
                await SUP.dropRubble(bot, keepRubble(job));
            }
            chain = null;
            const res = await PZ.within('work', () => work(job, name, bot, mv, cl, within(cancel, 180000)));
            { const placed = res.filter((r) => r.ok && r.tk.kind === 'place').map((r) => r.tk); if (placed.length && process.env.BUILD_RUNS !== '0') chain = { station: cl.station, placed, dir: cl.run || null }; }
            { const bad = res.find((r) => !r.ok); if (bad && !res.some((r) => r.ok)) PZ.failed(`${bad.tk.kind}: ${bad.why}`); }
            if (res.some((r) => r.ok)) { progress(); untell(job, name); }
            if (process.env.BUILD_TRACE) { const by = {}; for (const r of res) { const k = `${r.tk.kind}:${r.ok ? 'ok' : String(r.why).replace(/-?\d+/g, '#').slice(0, 50)}`; by[k] = (by[k] || 0) + 1; } job.log(`[trace] ${name} at ${cl.station.x},${cl.station.y},${cl.station.z} (${cl.tasks.length} tasks): ${JSON.stringify(by)}`); }
            job.report(name, res);
        }
        // leaving the crew alive (the job paused or stopped): its step ends here, so its own blocks go first, as at the end of every step; left to the finally's orphaning, the
        // pillar it stood on and the blocks of its last claim had no placer and no taker (b081w4/x4/y4, b081w5/y5 at the pause after the wrap-up: 'under its placer (no way
        // down)' 1-3 and 'orphaned (left the crew), not tried yet' 2-15 per run)
        await leaving(job, name, bot, mv);
        return { ended: 'cancelled' };
    } finally { bot.removeListener('death', onDeath); bot.removeListener('death', onDied); bot.removeListener('blockUpdate', onBlock); job.orphanOf(name, 'left the crew'); clearInterval(sampler); clearInterval(stallWatch); unwatch(); unitems(); bot.removeListener('spawnReset', onReset); bot.__builderOwns = false; job.leave(name); if (job.pool) job.pool.leave(name); for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) bot.setControlState(k, false); }
}

module.exports = { underBody, lowAnchor, outOfStock, bodyIn, recoverGround, drive, work, holds, rules, pour, escape, needsFor, boxSpot, bench, release, leaving, unscaffold, touchesShape, planned, adoptWorkTemps, closesIn, recoverDrops, materials };

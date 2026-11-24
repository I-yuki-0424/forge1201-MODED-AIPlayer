'use strict';
// One SURVIVAL bot of the crew: fetch what it needs from the materials containers (shulker boxes unpacked by hand), claim a stance and the tasks it can do from there, walk
// (or pillar, bridge, dig) to it, do them with a vanilla client's inputs (a dig at survival speed with the right tool, a click on a face it sees, a bucket, flint and steel),
// read every cell back, report. Nothing is made from nothing, nothing is moved by the server.
const { Vec3 } = require('vec3');
const S = require('./state');
const V = require('./vanilla');
const { Mover, View, feet } = require('./move');
const { seen } = require('./world');
const { clicksFor, REPLACEABLE } = require('./survey');
const SUP = require('./supply');
const { FULL } = require('./job');

const COST_LAVA = 60;                // escapes and evacuations may pass beside lava (never into it) at this cost per cell
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
        temp: () => { const n = {}; for (const i of bot.inventory.items()) if (SUP.TEMPS.includes(i.name) && !job.t.items.has(i.name)) n[i.name] = (n[i.name] || 0) + i.count; let best = null; for (const [k, c] of Object.entries(n)) if (!best || c > n[best] || (c === n[best] && k === job.tempItem)) best = k; return best; },
        // another bot's temporary block (no drop lands on one: it may be gone when the bot arrives)
        othersTemp: (x, y, z) => { const k = `${x},${y},${z}`; const m = job.temps.get(k); return !!m && m.by !== bot.username; },
        mayDig: (x, y, z) => !underCrew(job, bot, x, y, z) && !onRouteOfOther(job, bot.username, x, y, z),
        // the item to climb or bridge with in cell (x, y, z) when the blueprint has a plain full block there and the bot carries it: the climb builds the structure
        buildBlock: (x, y, z) => { const it = ownBlockItem(job, x, y, z); if (!it) return null; return bot.inventory.items().some((i) => i.name === it) ? it : null; },
        // a block another bot is about to dig (its claim): not stood on by a plan
        // (only when that bot's stance is within reach of it: every block of the other bots' 64-task claims counted, and large parts of the ground dropped out of the plans:
        // 30 000-cell searches failed where a plan of 45 steps existed, probe 2026-11-24 ha18 w2)
        // (a temporary block due to be taken away is never stood on, whoever holds it: bots dropped onto such blocks as they went and fell 20, ha26 w3)
        doomed: (x, y, z) => { const k = `${x},${y},${z}`, t0 = job.tasks.get(k); if (t0 && t0.kind === 'untemp' && !(bot.__mine && bot.__mine.has(k))) return true; const by = job.claims.get(k); if (!by || by === bot.username) return false; const t = t0; if (!t || !(t.kind === 'clear' || t.kind === 'untemp')) return false; const o = job.bots.get(by), st = o && o.station && o.station[0]; return !!st && Math.abs(st.x - x) <= 5 && Math.abs(st.z - z) <= 5 && Math.abs(st.y - y) <= 6; },
        onRoute: (route) => { (job.routes || (job.routes = new Map())).set(bot.username, { floors: new Set(route.map((c) => `${c.x},${c.y - 1},${c.z}`)), until: Date.now() + 30000 }); },
        // only near this bot (four cells): a body farther away moves before the bot gets there; every body on the map made the most failed searches ('occupied', [diag] ha19)
        occupied: (x, y, z) => { const p = bot.entity.position; if (Math.abs(x + 0.5 - p.x) > 4 || Math.abs(z + 0.5 - p.z) > 4 || Math.abs(y - p.y) > 4) return false; return crewAt(job, bot).some((q) => Math.floor(q.x) === x && Math.floor(q.z) === z && Math.floor(q.y + 0.16) === y); },
        // cells no temporary block may go into: a depot box's lid cell, the cells over the chests and the respawn anchor (a pillar block on a box's lid shut it for good)
        noTemp: (x, y, z) => (job.depot || []).some((d) => d.x + (d.fx || 0) === x && d.y + (d.fy ?? 1) === y && d.z + (d.fz || 0) === z) || (job.sites || []).some((c) => Math.abs(c.x - x) <= 1 && Math.abs(c.z - z) <= 1 && y === c.y + 1) || (!!job.anchorAt && job.anchorAt.x === x && job.anchorAt.z === z && job.anchorAt.y + 1 === y),
        columnBusy: (x, z) => { const c = job.columns && job.columns.get(`${x},${z}`); return !!c && c.by !== bot.username && c.until > Date.now(); },
        onPillar: (c) => { (job.columns || (job.columns = new Map())).set(`${c.x},${c.z}`, { by: bot.username, until: Date.now() + 20000 }); },
        onTemp: (c, how) => { const b = seen(bot, c); job.addTemp(c, how || 'temp', bot.username, b ? b.name : null); },
        onUntemp: (c) => { job.dropTemp(c); job.stats.untemp++; },
    };
}

/**
 * What a bot keeps when it makes room: the blueprint's items and the supply's, and of the temporary kinds (dirt, cobblestone, netherrack ...) three stacks in all. Dirt is both the
 * supply's temporary block and the rubble of a hill: kept whole, 26 stacks of it filled the pack and every supply trip came back empty (live 2026-11-22 tr8).
 */
function keepRubble(job) {
    let temps = 320;          // five stacks (at three the crew threw away its blocks after clearing and stood at the chest without any: live 2026-11-23 ha11 w3)
    return (n, count) => {
        if (SUP.TEMPS.includes(n) && !job.t.items.has(n)) { if (temps <= 0) return false; temps -= count; return true; }
        return job.t.items.has(n) || job.available.has(n);
    };
}

/**
 * Does another bot of the crew stand on the block at (x, y, z), or on one of the two above it (live positions from the server, not those of the last claim)? Broken under it,
 * it falls (Nether crews fell 30-50 blocks off temporary blocks the clearing took away under them, live 2026-11-22 sJ2).
 */
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
    const r = await mv.goto(cl.station, { cancel, maxNodes: 30000 });
    job.time.walk += Date.now() - tw;
    if (!r.ok) {
        // a stance the bot cannot get to counts against its tasks (as 'skipped' they came back for ever: live 2026-11-22 sD w2, 22 tree tops for 40 minutes)
        for (const tk of cl.tasks) results.push({ tk, ok: false, why: `no way to the stance ${cl.station.x},${cl.station.y},${cl.station.z} (${r.why})` });
        // decided at once, not after a count of failures (owner 2026-11-23: retrying, then escaping upward, wasted most of the time): a search that found next to no cells means
        // the bot is closed in (it digs out sideways now); otherwise the stance is out of this bot's reach and is not offered to it again for three minutes
        const n = (job.noPath.get(name) || 0) + 1; job.noPath.set(name, n);
        job.log(`${name}: no way to ${cl.station.x} ${cl.station.y} ${cl.station.z} (${r.why}, ${n} in a row)`);
        job.avoid(name, cl.station);
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
    const here = feet(bot), at = (tk) => tk.way;
    const done = [];
    for (const tk of cl.tasks) {
        if (cancel.cancelled) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        // the stance moved (a pillar ends a cell off): the way is found again from where the bot stands
        let way = at(tk);
        if (here.x !== cl.station.x || here.y !== cl.station.y || here.z !== cl.station.z) way = job._way(require('./place').botWorld(bot), tk, here);
        const h = seen(bot, tk);
        if (!h || !way) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        { const me = feet(bot); if ((tk.kind === 'clear' || tk.kind === 'untemp') && tk.x === me.x && tk.z === me.z && tk.y === me.y - 1) { results.push({ tk, ok: false, why: 'skipped' }); continue; } }
        // a temporary block with a crew member anywhere above it in its column is not taken (a pillar dug out under a bot on its top: falls of 40 blocks, live 2026-11-23 fy3)
        if (tk.kind === 'untemp' && [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]].some(([dx, dy, dz]) => FLUID(seen(bot, { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz })))) { results.push({ tk, ok: false, why: 'skipped' }); continue; }          // it holds back a fluid now
        if (tk.kind === 'untemp' && crewAt(job, bot).concat([bot.entity.position]).some((q) => Math.floor(q.x) === tk.x && Math.floor(q.z) === tk.z && q.y > tk.y && q.y < tk.y + 90)) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        // lava within two of the cell or of the bot, now (it runs in through cells opened a moment ago, from a pool two or three away: seven deaths in clearing batches,
        // live 2026-11-23 gf1 w5/w6): the rest of the claim is dropped and the bot steps away from it
        if ((tk.kind === 'clear' || tk.kind === 'untemp') && (lavaWithin(bot, tk, 2) || lavaWithin(bot, feet(bot), 2))) {
            for (const rest of cl.tasks.slice(cl.tasks.indexOf(tk))) results.push({ tk: rest, ok: false, why: 'skipped' });
            const f0 = feet(bot); job.log(`${name}: lava near ${tk.x},${tk.y},${tk.z}: the claim is dropped`);
            await mv.goto(f0, { goal: (x, y, z) => Math.hypot(x - f0.x, z - f0.z) >= 3 && !lavaWithin(bot, { x, y, z }, 3), cancel, maxNodes: 4000, tries: 1 });
            break;
        }
        if (tk.kind === 'clear' || tk.kind === 'untemp') { if (S.AIR.has(h.name)) { results.push({ tk, ok: true }); continue; } if (underCrew(job, bot, tk.x, tk.y, tk.z) || onRouteOfOther(job, name, tk.x, tk.y, tk.z)) { results.push({ tk, ok: false, why: 'skipped' }); continue; } const td = Date.now(); await mv.dig(tk); job.time.dig += Date.now() - td; done.push(tk); continue; }
        if (tk.kind === 'seal' || tk.kind === 'fill' || tk.kind === 'scaffold') { if (!(await mv.hold(mv.rules.temp() || job.tempItem))) { results.push({ tk, ok: false, why: 'skipped' }); continue; } await click(mv, way); done.push(tk); continue; }
        if (tk.kind === 'fix') { await mv.holdNothing(); await mv.click([tk.x, tk.y, tk.z], way.click.face, way.click.hit); for (let k = 1; k < tk.clicks; k++) await mv.click([tk.x, tk.y, tk.z], way.click.face, way.click.hit); done.push(tk); continue; }
        if (tk.kind === 'ignite') { if (!(await mv.hold('flint_and_steel'))) { results.push({ tk, ok: false, why: 'skipped' }); continue; } await mv.click([way.light.x, way.light.y, way.light.z], 'up', way.click.hit); await sleep(300); done.push(tk); continue; }
        if (tk.kind === 'pour') { const ok = await pour(job, bot, mv, tk); results.push(ok ? holds(job, bot, tk) : { ok: false, why: 'no ray into the cell' }); continue; }
        if (tk.kind === 'place') {
            const rr = job.t.recipeOf(tk);
            if (S.matches(job.t.wantOf(tk), h)) { results.push({ tk, ok: true }); continue; }
            if (!(S.AIR.has(h.name) || REPLACEABLE.test(h.name) || h.name === 'water' || h.name === 'lava')) { await mv.dig(tk); }
            if (!(await mv.hold(rr.item))) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
            // never the block that leaves the bot's own cell without a way out (Bd4f set glass on all four sides on a piston, as the blueprint has it, and was shut in: owner
            // 2026-11-23); that block is placed from another stance
            if (shutsIn(bot, tk)) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
            const tp = Date.now(); await click(mv, way); job.time.place += Date.now() - tp;
            // clicks after the placement (note, delay, mode, open), counted from what the cell holds now
            await sleep(120);
            const now = seen(bot, tk), fx = now ? clicksFor(job.t.wantOf(tk), now) : null;
            if (fx) { const c = require('./place').clickable(require('./place').botWorld(bot), tk, feet(bot)); if (c) { await mv.holdNothing(); for (let k = 0; k < fx.clicks; k++) await mv.click([tk.x, tk.y, tk.z], c.face, c.hit); } }
            done.push(tk);
        }
    }
    await sleep(250);
    for (const tk of done) { const h = holds(job, bot, tk); results.push({ tk, ok: h.ok, why: h.why }); }
    await unscaffold(job, bot, mv);
    // its own pillar down at once, the stance's work done (owner 2026-11-23 V7: temporary blocks go as soon as they have served)
    // (unless placing is left around the stance: the next claim is from here or beside it, and the column would be built again)
    if (!job.workNear(feet(bot))) { const tu = Date.now(); await mv.unpillar(null, () => false, cancel); job.time.walk += Date.now() - tu; }
    return results;
}

/**
 * Scaffolds within reach whose blocks stand (no block to place beside them any more) are dug at once, from the stance that just used them: kept to the end they stood on the site
 * and made more work later (owner 2026-11-23 list 4 problem 8).
 */
async function unscaffold(job, bot, mv) {
    if (!job.scaffolds || !job.scaffolds.size) return 0;
    const p = bot.entity.position; let n = 0;
    for (const k of [...job.scaffolds]) {
        const [x, y, z] = k.split(',').map(Number);
        if (Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + 1.62), z + 0.5 - p.z) > 4.4) continue;
        if (job.t.inside(x, y, z) && !job.t.isAir(job.t.idx(x, y, z))) { job.scaffolds.delete(k); continue; }
        if ([[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => { const o = job.tasks.get(key(x + dx, y + dy, z + dz)); return o && o.kind === 'place'; })) continue;
        const h = seen(bot, { x, y, z });
        if (!h || S.AIR.has(h.name)) { job.scaffolds.delete(k); job.temps.delete(k); continue; }
        if (underCrew(job, bot, x, y, z) || onRouteOfOther(job, bot.username, x, y, z) || holdsFluid(bot, x, y, z)) continue;
        const me = feet(bot); if (me.x === x && me.z === z && me.y === y + 1) continue;          // not its own floor
        if (await mv.dig({ x, y, z })) { job.scaffolds.delete(k); job.dropTemp({ x, y, z }); const t = job.tasks.get(k); if (t && (t.kind === 'clear' || t.kind === 'untemp')) job.tasks.delete(k); job.stats.untemp++; n++; }
    }
    return n;
}

/** Would a block in cell c leave the bot's body (feet cell f, head f+1) without a way out: no side with both cells open, and nothing open over the head? */
function shutsIn(bot, c) {
    const f = feet(bot), at = (x, y, z) => (x === c.x && y === c.y && z === c.z) ? false : (() => { const b = bot.blockAt(new Vec3(x, y, z), false); return !!b && b.boundingBox === 'empty'; })();
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
    const f = feet(bot), b = job.t.box, loose = { canDig: (x, y, z, blk, view = null) => !UNBREAKABLE.test(blk.name) && !CONTAINER.test(blk.name) && !holdsFluid(bot, x, y, z, view), temp: mv.rules.temp, onTemp: mv.rules.onTemp };
    const m2 = new Mover(bot, { ...loose, onUntemp: mv.rules.onUntemp });
    m2.mine = mv.mine;
    // out sideways to the nearest open cell three or more away at about the same height: never up to the top of the box (a 60-high box made every closed-in bot build a pillar
    // of 60 that the crew then climbed and tore down, for an hour: owner 2026-11-23); the plan's costs prefer walking and digging to pillaring
    job.stats.escapes++;
    // (out of a pocket: to a cell outside the cells it could reach, `pocket`)
    const r = await m2.goto(f, { goal: pocket ? (x, y, z) => !pocket.has(`${x},${y},${z}`) : (x, y, z) => Math.hypot(x - f.x, z - f.z) >= 3 && Math.abs(y - f.y) <= 2, cancel, maxNodes: 20000, lavaCost: COST_LAVA });
    job.log(`${name}: closed in at ${f.x} ${f.y} ${f.z}: ${r.ok ? 'out' : 'no way out (' + r.why + ')'}`);
    if (!r.ok) tell(job, name, bot, 'stuck', `closed in at ${f.x} ${f.y} ${f.z}, no way out (${String(r.why).slice(0, 80)})`);
    return r.ok;
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
    const loose = { canDig: (x, y, z, blk, view = null) => !UNBREAKABLE.test(blk.name) && !CONTAINER.test(blk.name) && !holdsFluid(bot, x, y, z, view), temp: mv.rules.temp, onTemp: mv.rules.onTemp, onUntemp: mv.rules.onUntemp };
    const m2 = new Mover(bot, loose); m2.mine = mv.mine;
    const out = (x, y, z) => (x < b.x - 1 || x > b.x + b.sx || z < b.z - 1 || z > b.z + b.sz);
    const nearest = { x: Math.min(Math.max(f.x, b.x - 3), b.x + b.sx + 2), y: f.y, z: Math.min(Math.max(f.z, b.z - 3), b.z + b.sz + 2) };
    const r = await m2.goto(nearest, { goal: out, cancel, maxNodes: 30000, lavaCost: COST_LAVA });
    job.log(`${name}: evacuation ${r.ok ? 'done' : 'failed (' + r.why + ')'}`);
    await sleep(15000);
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
    if (job.spawnSet && job.spawnSet.has(name) && !(job.anchorAt && charges(bot, job.anchorAt) < 2 && bot.inventory.items().some((i) => i.name === 'glowstone'))) return;
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
                if ((await mv.placeItem('respawn_anchor', q)) === true) { job.anchorAt = q; job.log(`${name}: respawn anchor set down at ${q.x} ${q.y} ${q.z}`); break; }
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
                if (pr === true) { job.bedAt = q; job.log(`${name}: spawn bed set down at ${q.x} ${q.y} ${q.z} facing ${q.facing}`); break; }
                // a click on grass beside the cell puts the bed into the grass's cell: it stands, a cell off (the crew used up its beds "failing", live 2026-11-24 ha16)
                { let at = null; for (let dx = -3; dx <= 3 && !at; dx++) for (let dy = -1; dy <= 1 && !at; dy++) for (let dz = -3; dz <= 3 && !at; dz++) { const b = bot.blockAt(new Vec3(q.x + dx, q.y + dy, q.z + dz), false); if (b && b.name === SPAWN_BED) at = { x: q.x + dx, y: q.y + dy, z: q.z + dz }; }
                  if (at) { job.bedAt = at; job.log(`${name}: spawn bed set down at ${at.x} ${at.y} ${at.z} (a cell off ${q.x},${q.y},${q.z})`); break; } }
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
    const temps = SUP.TEMPS.filter((t) => !job.t.items.has(t)).reduce((a, t) => a + (have[t] || 0), 0);
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
        if (!r.ok) { job.log(`${name}: no way to the materials at ${site.x} ${site.y} ${site.z} (${r.why})${r.region && Date.now() - (job.edgeAt || 0) > 60000 ? (job.edgeAt = Date.now(), `; edge ${edgeOf(mv, r.region)}`) : ''}`); return false; }
        if (bot.inventory.items().some((i) => /shulker_box$/.test(i.name))) await SUP.putBack(bot, site);          // boxes it carries (picked up somewhere) go back first
        const spot = () => boxSpot(job, bot, site, mv);
        await SUP.dropRubble(bot, keepRubble(job), { minFree: 12 });          // room in the pack first (a pack full of rubble brought nothing back)
        // what the ready work asks for, and what its sector needs over the next layers (each capped by the fair share in needsFor)
        const sn = job.sectorNeeds ? job.sectorNeeds(name) : {}, all = { ...sn };
        for (const [k, n] of Object.entries(need)) all[k] = Math.max(all[k] || 0, n);
        const wants = needsFor(job, bot, all);
        job.depot = job.depot || [];
        const res = await SUP.fetch(bot, site, wants, mv, spot, { log: job.log, depot: job.depot, locks: job.boxLocks || (job.boxLocks = new Map()), me: name, cancel });
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
            await mv.spread(crewAt(job, bot)); await sleep(500);
        }
    } finally { g.wait.delete(name); }
}
/** A cancel token that is also cancelled `ms` from now. */
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
async function drive(job, name, bot, { cancel = { cancelled: false }, supplySites = [] } = {}) {
    if (bot.game && !['survival', 'creative'].includes(bot.game.gameMode)) return { ended: 'wrong_mode' };
    job.sites = supplySites;
    job.ownBlock = job.ownBlock || ((x, y, z) => !!ownBlockItem(job, x, y, z));
    if (!job.bots.has(name)) job.bots.set(name, { station: null, pos: feet(bot) });
    const mv = new Mover(bot, rules(job, bot), { log: job.log });
    bot.__mine = mv.mine;          // its own temporary blocks (rules.doomed lets it stand on them)
    (job.moverRules || (job.moverRules = new Map())).set(name, mv.rules);          // the claim judges stances by these
    const onDeath = () => { const p = bot.entity && bot.entity.position, f = p ? feet(bot) : null, around = f ? [-1, 0, 1].map((dy) => (seen(bot, { x: f.x, y: f.y + dy, z: f.z }) || {}).name).join('/') : '?'; job.stats.deaths = (job.stats.deaths || 0) + 1; job.log(`${name} died at ${f ? `${f.x},${f.y},${f.z}` : '?'} (${around}), stage ${job.stage}; last: ${mv.trace.join(' | ')}`); };
    bot.on('death', onDeath);
    // the server dropped the spawn point (the bed broken or shut in): set again
    const onReset = () => { if (job.spawnSet) job.spawnSet.delete(name); if (job.anchorTry) job.anchorTry.delete(name); job.log(`${name}: the server reset its spawn point`); };
    bot.on('spawnReset', onReset);
    bot.__builderOwns = true;                // the fall and breath reflexes stay out of a builder's way (work/bot/reflex.js)
    let idle = 0;
    // the watchdog: the last time this bot got something done (a task that held, a supply trip that brought something); EVACUATE_MS without while there is work: off the site
    const progress = () => { (job.progressAt || (job.progressAt = new Map())).set(name, Date.now()); };
    progress();
    try {
        while (!cancel.cancelled) {
            if (!job.done && job.stage !== 'settle' && job.stage !== 'survey' && job.tasks.size && Date.now() - job.progressAt.get(name) > EVACUATE_MS) {
                await evacuate(job, name, bot, mv, cancel, `nothing done for ${Math.round((Date.now() - job.progressAt.get(name)) / 60000)} min`);
                progress();
                continue;
            }
            if (job.done) {
                // the depot's boxes back into the chest, by one bot (alone at the chest: a box it breaks drops into its own reach)
                if (job.depot && job.depot.length && !job.repacking && job.sites[0]) {
                    job.repacking = name;
                    try { await mv.goto(job.sites[0], { goal: nearContainer(job.sites[0]), cancel, maxNodes: 40000 }); const lost = await SUP.repack(bot, job.sites[0], job.depot, mv, { log: job.log }); job.log(`${name}: depot boxes put back into the chest${lost ? `, ${lost} not picked up` : ''}`); }
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
                if (!job.supplyReading && job.supplyTried.has(name) && [...job.bots.keys()].some((n) => !job.supplyTried.has(n))) { await sleep(500); continue; }
                if (!job.supplyReading) {
                    job.supplyTried.add(name);
                    job.supplyReading = SUP.readSupply(bot, supplySites, (s) => mv.goto(s, { goal: nearContainer(s), cancel, maxNodes: 40000 }), { log: job.log }).then((s) => {
                        if (!s.read.length) { job.log(`supply: ${name} could not read any container (${JSON.stringify(s.failed).slice(0, 300)})`); if ([...job.bots.keys()].every((n) => job.supplyTried.has(n))) job.supplyTried.clear(); job.supplyReading = null; return; }
                        job.supply = s; job.available = new Set(Object.keys(s.totals).filter((k) => s.totals[k] > 0));
                        job.tempItem = SUP.tempFrom(s.totals, new Set(job.t.items.keys()));
                        job.log(`supply read by ${name}: ${Object.keys(s.totals).length} item types; temporary block ${job.tempItem || 'NONE (pillars and bridges impossible)'}`);
                    }, (e) => { job.log(`supply read failed: ${e.message}`); job.supplyReading = null; });
                }
                await job.supplyReading; await sleep(200); continue;
            }
            // (at most every two minutes per bot: without glowstone it went for it on every turn of the loop, 107 trips, live 2026-11-23 ha5 w1)
            if (!inNether(bot) && job.available.has(SPAWN_BED) && !(job.spawnSet && job.spawnSet.has(name)) && !job.anchorBusy && Date.now() - ((job.anchorTry && job.anchorTry.get(name)) || 0) > 120000) { (job.anchorTry || (job.anchorTry = new Map())).set(name, Date.now()); await bedSpawn(job, name, bot, mv, cancel); }
            // far from its site (it woke at the world's spawn after a death): it leaves the crew instead of working another crew's site (live 2026-11-23 ha11 w3)
            { const b0 = job.t.box, p = bot.entity.position, d = Math.hypot(p.x - (b0.x + b0.sx / 2), p.z - (b0.z + b0.sz / 2)); if (d > 200) { job.log(`${name} is ${Math.round(d)} blocks from the site (respawned far away): it leaves the crew`); return { ended: 'too_far' }; } }
            if (inNether(bot) && job.available.has('respawn_anchor') && !(job.spawnSet && job.spawnSet.has(name)) && !job.anchorBusy && Date.now() - ((job.anchorTry && job.anchorTry.get(name)) || 0) > 120000) { (job.anchorTry || (job.anchorTry = new Map())).set(name, Date.now()); await anchor(job, name, bot, mv, cancel); }
            if (job.exhausted()) { await job.resurvey(bot, `${name}: stage ${job.stage} done`); continue; }
            // tools and temporary blocks before the work needs them
            const base = needsFor(job, bot, {});
            if (Object.keys(base).length && job.stage !== 'settle' && !(job.lastTrip && Date.now() - job.lastTrip.get(name) < 60000)) { (job.lastTrip = job.lastTrip || new Map()).set(name, Date.now()); const tt = Date.now(); await supplyTrip(job, name, bot, mv, {}, within(cancel, 180000)); job.time.trip += Date.now() - tt; continue; }
            // a handover: items the chest is out of that this bot carries and has not placed for two minutes go back into the chest for the bots that need them (four
            // bots each held what the others' cells needed and the chest was empty, live 2026-11-23 gd1 w1)
            if (job.outOf && job.sites[0] && Date.now() - (job.handAt && job.handAt.get(name) || 0) > 60000) {
                (job.handAt || (job.handAt = new Map())).set(name, Date.now());
                const mine = (job.used && job.used.get(name)) || new Map(), inv = SUP.carried(bot);
                const sn = job.sectorNeeds ? job.sectorNeeds(name) : {};          // not what its own sector still needs (items went back and forth, 24 hand-backs in 28 min, gg1 w3)
                const give = [...job.outOf.entries()].filter(([it, t]) => t > Date.now() && inv[it] > 0 && !(sn[it] > 0) && Date.now() - (mine.get(it) || 0) > 120000).map(([it]) => it);
                if (give.length && (!job.gate || job.gate.inside.size < SUPPLY_PAR)) {
                    (job.gate || (job.gate = { inside: new Set(), wait: new Map() })).inside.add(name);
                    try {
                        const r = await mv.goto(job.sites[0], { goal: nearContainer(job.sites[0]), cancel: within(cancel, 120000), maxNodes: 40000 });
                        if (r.ok) { const back = await SUP.deposit(bot, job.sites[0], give); for (const it of Object.keys(back)) job.outOf.delete(it); job.log(`${name}: handed back ${JSON.stringify(back)} for the others`); }
                    } catch (e) { job.log(`${name}: hand-back failed: ${e.message}`); } finally { job.gate.inside.delete(name); }
                    continue;
                }
            }
            const have = SUP.carried(bot);
            // the cells it can reach from here, by the mover's own moves (job.claim offers stances among them); again after a move or 15 s
            { const f0 = feet(bot), fk = `${f0.x},${f0.y},${f0.z}`, F = job.floods && job.floods.get(name); if (!F || F.from !== fk || Date.now() - F.at > 30000) { const tf = Date.now(); (job.floods || (job.floods = new Map())).set(name, await mv.flood()); job.time.claim += Date.now() - tf; } }
            // items this bot's last trip came back without are not asked for by it for a minute: it works on what it has instead of waiting (owner 2026-11-23 list 4 problem 5)
            { const t = mv.rules.temp(); (job.tempsOf || (job.tempsOf = new Map())).set(name, t ? have[t] || 0 : 0); }
            const mySkip = (job.noItem && job.noItem.get(name)) || new Map();
            const tc = Date.now(); const cl = job.claim(bot, name, Date.now(), (it) => have[it] || 0, (it) => (!!job.outOf && (job.outOf.get(it) || 0) > Date.now() && !(have[it] > 0)) || (mySkip.get(it) || 0) > Date.now()); const dc = Date.now() - tc; job.time.claim += dc; if (dc > 400) job.log(`${name}: claim took ${dc} ms (${job.lastClaimInfo || ''})`);
            { const w = !cl ? 'nothing' : cl.need ? `need ${Object.keys(cl.need).slice(0, 3).join('+')}` : cl.moveOff ? 'move off' : 'work'; const o = job.claimWhy || (job.claimWhy = {}); o[w] = (o[w] || 0) + 1;
              if (cl && cl.tasks) { job.claimTasks = (job.claimTasks || 0) + cl.tasks.length; job.claimTasksN = (job.claimTasksN || 0) + 1; }
              if (Date.now() - (job.claimWhyAt || 0) > 60000) { job.claimWhyAt = Date.now(); const ps = job.pstat; job.log(`claims in the last minute: ${JSON.stringify(o)}; ${job.claimTasksN ? (job.claimTasks / job.claimTasksN).toFixed(1) : 0} tasks per claim${ps && ps.n ? `; place claims ${ps.n}: ready ${(ps.ready / ps.n).toFixed(0)}, doable ${(ps.doable / ps.n).toFixed(0)}, batch ${(ps.batch / ps.n).toFixed(1)}` : ''}`); job.pstat = null; job.claimWhy = {}; job.claimTasks = 0; job.claimTasksN = 0; } }
            if (cl && cl.moveOff) {
                const f = feet(bot), floor = (x, y, z) => job.tasks.get(`${x},${y - 1},${z}`);
                const r = await mv.goto(f, { goal: (x, y, z) => Math.hypot(x - f.x, z - f.z) >= 2 && !(floor(x, y, z) && ['clear', 'untemp'].includes(floor(x, y, z).kind)), cancel, maxNodes: 4000 });
                // no way off: the cell under it waits 20 s (an instant failure, repeated without a pause, spun 1 258 times a minute and froze every bot for 17 s, live 2026-11-23 fy1 w4)
                if (!r.ok) { job.cool.set(`${f.x},${f.y - 1},${f.z}`, Date.now() + 20000); await sleep(500); }
                continue;
            }
            // out of temporary blocks and the chest out of them too: dig natural ground near the chest for them (a survival player's way: blocks bridged and dug high up fall
            // to the ground and are lost, the chest ran out after 16 min, ha19)
            if (job.tempItem && (SUP.carried(bot)[job.tempItem] || 0) + SUP.TEMPS.filter((t) => t !== job.tempItem && !job.t.items.has(t)).reduce((a, t) => a + (SUP.carried(bot)[t] || 0), 0) < 32 && job.outOf && (job.outOf.get(job.tempItem) || 0) > Date.now() && Date.now() - ((job.quarryAt && job.quarryAt.get(name)) || 0) > 60000) {
                (job.quarryAt || (job.quarryAt = new Map())).set(name, Date.now());
                const tq = Date.now(); await quarry(job, name, bot, mv, cancel); job.time.dig += Date.now() - tq; progress(); continue;
            }
            if (cl && cl.need) {
                const tt = Date.now(); const got = await supplyTrip(job, name, bot, mv, cl.need, within(cancel, 180000)); job.time.trip += Date.now() - tt;
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
                for (const f of l.slice(0, 3)) { const c = await mv.canReach(f); job.setReach(name, f, c); if (c !== null) ok++; }
                job.time.claim += Date.now() - tq; job.stats.probes = (job.stats.probes || 0) + l.length; job.stats.probesOk = (job.stats.probesOk || 0) + ok;
                continue;
            }
            if (!cl) {
                idle++; const ti = Date.now();
                if (idle > 25 && job.stage !== 'settle') { tell(job, name, bot, 'idle', job.nothingWhy || job.lastClaimInfo || 'no task found'); progress(); }        // idle with nothing to do is not stuck
                // nothing for it (its area done, the others full): it waits on the bench, off the box and away from the chest, out of everybody's way (owner 2026-11-23 list 4 problem 7)
                if (idle === 6 && job.stage !== 'settle') { await bench(job, name, bot, mv, cancel); job.floods && job.floods.delete(name); }
                else if (idle % 5 === 1) await mv.spread(crewAt(job, bot));
                await sleep(job.stage === 'settle' ? 1000 : 400); job.time.idle += Date.now() - ti; continue;
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
            const res = await work(job, name, bot, mv, cl, within(cancel, 180000));
            if (res.some((r) => r.ok)) { progress(); untell(job, name); }
            if (process.env.BUILD_TRACE) { const by = {}; for (const r of res) { const k = `${r.tk.kind}:${r.ok ? 'ok' : String(r.why).replace(/-?\d+/g, '#').slice(0, 50)}`; by[k] = (by[k] || 0) + 1; } job.log(`[trace] ${name} at ${cl.station.x},${cl.station.y},${cl.station.z} (${cl.tasks.length} tasks): ${JSON.stringify(by)}`); }
            job.report(name, res);
        }
        return { ended: 'cancelled' };
    } finally { bot.removeListener('death', onDeath); bot.removeListener('spawnReset', onReset); bot.__builderOwns = false; job.leave(name); for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) bot.setControlState(k, false); }
}

module.exports = { drive, work, holds, rules, pour, escape, needsFor, boxSpot, bench };

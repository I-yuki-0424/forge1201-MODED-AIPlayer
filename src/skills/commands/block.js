'use strict';
// Commands on blocks: move_to, look_at, mine, place, activate. Each one walks (motion.js), aims the crosshair, and
// presses attack or use; success is the block change the server sends back, never the bot's own prediction.
const { SkillError } = require('../runner');
const { standable, swimmable, isInteractive, passable } = require('../world');
const { FACES, lookAngles, aimPoints, viewDir, raycast } = require('../geometry');
const { follow, cellGoal, reachGoal, approachUntil, approachBlock, aimAtBlock, clearOfEntities, feetCell, centre, hdist, same, AIM_REACH } = require('../motion');
const { holdItem, holdOrFail, count, resolveItemName } = require('./item');
const { collectDrops } = require('./entity');
const skillOpts = require('../options');
const fixtures = require('../fixtures');

// bubble_column and tall_seagrass are replaceable in the game (a block placed there replaces them) and are what a pit under water meets all the time: refusing them
// ended 124 of 364 failed units in 30 min as `invalid_target: cell holds bubble_column / tall_seagrass` (live pit 2026-11-09), and the unit was tried again for ever.
const REPLACEABLE = /^(air|cave_air|void_air|grass|tall_grass|fern|large_fern|dead_bush|snow|seagrass|tall_seagrass|bubble_column|vine|glow_lichen)$/;
const FLUID = /^(water|lava)$/;     // `place` with fluid:true may fill these (work/pit.js water rule)
const LOOK_RANGE = 64;

/** move_to {x, y, z}: stand in that cell (feet). */
async function moveTo(ctx, { x, y, z }) {
    const t = { x, y, z };
    const b = ctx.world.blockAt(x, y, z);
    if (!b) throw new SkillError('unreachable', { why: 'target chunk not loaded', target: t });
    if (!standable(ctx.world, x, y, z) && !swimmable(ctx.world, x, y, z)) throw new SkillError('invalid_target', { why: 'a player cannot stand there', target: t });          // a surface cell of open water counts: the planner swims to it
    const end = await follow(ctx, cellGoal(t, `cell ${x},${y},${z}`, { swim: !standable(ctx.world, x, y, z) }));
    const p = ctx.bot.entity.position;
    return { cell: end, pos: [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100) };
}

/** look_at {x, y, z} | {entity}: put the crosshair on the block or entity (any distance up to 64 blocks, no walking). */
async function lookAt(ctx, { x, y, z, entity }) {
    const bot = ctx.bot;
    if (entity !== undefined) {
        const ent = bot.entities[entity];
        if (!ent || ent === bot.entity) throw new SkillError('invalid_target', { entity });
        const p = ent.position, aim = { x: p.x, y: p.y + (ent.height || 1) / 2, z: p.z };
        await ctx.tick(lookAngles(ctx.body.eye(), aim));
        return { entity, name: ent.name };
    }
    const cell = { x, y, z };
    if (!ctx.world.blockAt(x, y, z)) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (!ctx.world.shapesAt(x, y, z).length) throw new SkillError('invalid_target', { why: 'nothing to look at in that cell', target: cell });
    const pts = aimPoints(ctx.body.eye(), cell, ctx.world.shapesAt, { reach: LOOK_RANGE, limit: 5 });
    for (const p of pts) {
        await ctx.tick(lookAngles(ctx.body.eye(), p.point));
        const e = bot.entity;
        const hit = raycast(ctx.body.eye(), viewDir(e.yaw, e.pitch), LOOK_RANGE, ctx.world.shapesAt);
        if (hit && same(hit, cell)) return { face: hit.face, dist: Math.round(hit.t * 100) / 100 };
    }
    throw new SkillError('not_visible', { target: cell, tried: pts.length });
}

/**
 * The tool in the inventory that breaks `block` fastest among those that harvest it (null = bare hand). With the work layer's
 * `retireWorn` option a nearly broken stack is not a candidate (a name counts while one of its stacks is fresh); `ignoreWear` asks
 * what the answer would be without that rule (to tell "no tool" from "only worn tools").
 */
function bestTool(bot, block, { ignoreWear = false } = {}) {
    const fresh = (i) => ignoreWear || !skillOpts.isWorn(bot, i);
    const names = [null, ...new Set(bot.inventory.items().filter(fresh).map((i) => i.name))];
    let best = null;
    for (const name of names) {
        const id = name ? bot.registry.itemsByName[name].id : null;
        if (block.harvestTools && !(id !== null && block.harvestTools[id])) continue;
        const ms = block.digTime(id, false, false, false, [], bot.entity.effects);
        if (!best || ms < best.ms) best = { name, ms };
    }
    return best;
}

/** Item name the block drops when harvested (first listed drop), or null. */
function dropOf(bot, block) {
    const d = (block.drops || [])[0];
    const id = d === undefined ? null : typeof d === 'object' ? (d.drop?.id ?? d.id) : d;
    return id === null || id === undefined ? null : bot.registry.items[id]?.name || null;
}

/** Blocks whose drop is worth nothing here and that a bare hand breaks anyway: never an ore (a hand would destroy the drop). Closed list. */
const HAND_OK = new Set(['cobweb']);
const BLIND_REACH = 5.0;     // the server refuses digs beyond 6 blocks from the eye; stay well inside

/** The face of the block at `c` that looks toward `eye` (protocol numbering). */
function faceToward(eye, c) {
    const d = [eye.x - (c.x + 0.5), eye.y - (c.y + 0.5), eye.z - (c.z + 0.5)], a = d.map(Math.abs), k = a.indexOf(Math.max(...a));
    return k === 1 ? (d[1] < 0 ? 0 : 1) : k === 2 ? (d[2] < 0 ? 2 : 3) : (d[0] < 0 ? 4 : 5);
}

/**
 * Why `mine` refuses to break the block `name` at `cell` for this bot, or null when it may. The one rule for every planner that breaks blocks on its way (NAV plans digs only where this
 * is null: a NAV plan through a leaf block above the pit's work area was refused by `mine` and planned again, unchanged, for 6 minutes, fg075c, seed 474407178230372896, 1.21.1).
 *   - owner rule: a box the bot did not place (and a tagged block) is a fixture. The bot may use what is inside, never break it.
 *   - a pit worker mines inside its pit only (`bot.__mineBox`, set by the work service while the bot works a pit; 2 cells of margin across, 3 up and down): not the End platform's
 *     obsidian at the entrance, not blocks "where it is in nobody's way" (owner 2026-11-11). Its own temporary blocks are the exception.
 */
function refusal(bot, cell, name) {
    const { x, y, z } = cell;
    const fixture = skillOpts.get(bot).fixture;
    if (fixture && !fixtures.isOwn(bot, cell) && fixture(name, x, y, z)) return { why: null };
    const mb = bot.__mineBox;
    if (mb && !(x >= mb.x0 - 2 && x <= mb.x1 + 2 && z >= mb.z0 - 2 && z <= mb.z1 + 2 && y <= mb.top + 3 && y >= mb.bottom - 3)) {
        const t = bot.__temps && bot.__temps.get(fixtures.dimOf(bot), cell);
        if (!(t && t.by === bot.username)) return { why: 'outside the work area' };
    }
    return null;
}

/** The name of another player whose feet stand on the top of `cell` (its footprint over the cell, the feet within a quarter block of the top), or null. */
function standerOn(bot, { x, y, z }) {
    for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || e.type !== 'player' || !e.position) continue;
        const p = e.position;
        if (p.x + 0.3 > x && p.x - 0.3 < x + 1 && p.z + 0.3 > z && p.z - 0.3 < z + 1 && Math.abs(p.y - (y + 1)) < 0.25) return e.username || 'player';
    }
    return null;
}

/**
 * mine {x, y, z, collect?, blind?}: break the block with the best tool at hand and pick up what it drops.
 * `collect: false` leaves the drop where it falls (the work layer sweeps a whole standing place and picks everything up once).
 * `blind: true` digs without a line of sight, within reach (the server checks only the distance): the block two below the feet of
 * a bot that pillars up. Work-layer options; neither is offered to the RL policy.
 */
async function mine(ctx, { x, y, z, collect = true, blind = false, hand = false }) {
    const bot = ctx.bot, cell = { x, y, z };
    const b0 = ctx.world.blockAt(x, y, z);
    if (!b0) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (/^(air|cave_air|void_air)$/.test(b0.name) || !b0.diggable || ['liquid', 'water'].includes(ctx.world.kindAt(x, y, z))) throw new SkillError('invalid_target', { block: b0.name, target: cell });
    const no = refusal(bot, cell, b0.name);
    if (no) throw new SkillError('protected', { block: b0.name, target: cell, ...(no.why ? { why: no.why } : {}) });
    // Never the block another player stands on: Bd5b's pit unit dug the pumpkin at 105,93,-4 under Bd5a, which waited on it for the layer gate, and Bd5a fell 21 blocks to its death
    // (081's b081x5, Nether, seed 5251586736446165203, 1.21.1). Not a fixture: nothing is left for good, the caller tries again once the player has moved.
    const on = standerOn(bot, cell);
    if (on) throw new SkillError('precondition_failed', { unmet: [{ need: 'no_player_on_it', player: on, cell }], block: b0.name, target: cell });
    // `hand` (work layer only, never in the action schema): break the block with whatever is in the hand when no tool fits. Slow, no drop that needs the tool,
    // but it takes away a block the bot placed itself (the pillar).
    // A worn-out tool still breaks a block of its own pillar in a moment; bare hands take 7 s per stone. A cobweb is broken by hand too (20 s, no string): only a sword or shears make it
    // drop, and a bot that waited for one stood still for good when no container held a sword and no iron was at hand (live pit 2026-11-09, 5 cobwebs left, 978 missing_tool records).
    const tool = bestTool(bot, b0) || (hand || HAND_OK.has(b0.name) ? (bestTool(bot, b0, { ignoreWear: true }) || { name: null }) : null);
    if (!tool) {
        const any = skillOpts.get(bot).retireWorn && bestTool(bot, b0, { ignoreWear: true });
        throw new SkillError('missing_tool', { block: b0.name, ...(any && any.name ? { worn: any.name } : {}) });
    }
    const drop = dropOf(bot, b0), before = drop ? count(bot, drop) : 0;
    const notWorn = (i) => !skillOpts.isWorn(bot, i);
    const gone = () => { const b = ctx.world.blockAt(x, y, z); return !!b && b.name !== b0.name; };
    const ticksNow = () => Math.ceil(bot.digTime(b0) / 50);     // after the tool is in hand
    if (blind) {
        const eye = ctx.body.eye(), d = Math.hypot(eye.x - (x + 0.5), eye.y - (y + 0.5), eye.z - (z + 0.5));
        if (d > BLIND_REACH) throw new SkillError('not_visible', { target: cell, why: 'too far to dig without a line of sight', dist: Math.round(d * 100) / 100 });
        if (tool.name) await holdOrFail(ctx, tool.name, notWorn);
        const face = faceToward(eye, cell), digTicks = ticksNow();
        ctx.phase('dig_blind', { block: b0.name, tool: tool.name, ticks: digTicks });
        const deadline = ctx.t + digTicks + 40;
        while (!gone() && ctx.t < deadline) await ctx.tick({ attack: true, cell: { x, y, z, face } });
        if (!gone()) throw new SkillError('not_confirmed', { why: 'blind dig did not break the block', block: b0.name });
    } else {
        // Never stand on the block being broken.
        await approachBlock(ctx, cell, { ok: (c) => !(c.x === x && c.z === z && c.y === y + 1) });
        if (tool.name) await holdOrFail(ctx, tool.name, notWorn);
        const digTicks = ticksNow();
        ctx.phase('dig', { block: b0.name, tool: tool.name, ticks: digTicks });
        for (let attempt = 0; !gone(); attempt++) {
            if (attempt >= 4) throw new SkillError('not_confirmed', { why: 'block still there after 4 dig attempts', block: b0.name });
            if (attempt) await approachBlock(ctx, cell, { ok: (c) => !(c.x === x && c.z === z && c.y === y + 1) });
            await aimAtBlock(ctx, cell);
            const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
            const deadline = ctx.t + digTicks + 30;
            while (!gone() && ctx.t < deadline) {
                const h = ctx.body.crosshair();
                if (!h || h.kind !== 'block' || !same(h.block.position, cell)) break;     // crosshair slipped off: aim again
                await ctx.tick({ attack: true, ...look });
            }
        }
    }
    await ctx.tick({});
    fixtures.unmark(bot, cell);                                     // an own box that was picked up again is no longer remembered
    if (bot.__temps) bot.__temps.remove(fixtures.dimOf(bot), cell);   // a block of the shared list of placed blocks that is broken (by anyone) is one set: both are gone
    // Success is the break the server confirmed. The drop is collected when it can be: many drops are random (leaves,
    // gravel, grass) or fall out of reach (a log felled from a tree top), and the server counts the block as mined either
    // way (run train3, Train6: every leaf/log on a tree top ended not_confirmed while the statistic rose).
    let missed = null;
    if (drop && collect) {
        try { await collectDrops(ctx, cell, drop, before); } catch (e) { if (e.reason !== 'not_confirmed' && e.reason !== 'unreachable' && e.reason !== 'stuck' && e.reason !== 'precondition_failed') throw e; missed = e.reason; }          // atomic: the drop out of pickup range is no failure of a block that is already broken (the router answered it as one: "no standing cell within reach of the target", the mining of every ore beyond arm's length failed)
    }
    return { block: b0.name, tool: tool.name, drop, got: drop ? count(bot, drop) - before : 0, ...(missed ? { drop_missed: missed } : {}) };
}

/** Cells (with the face toward `cell`) of solid neighbours a block can be placed against. */
function supports(w, cell) {
    const out = [];
    for (let f = 0; f < 6; f++) {
        const [dx, dy, dz] = FACES[f];
        const n = { x: cell.x - dx, y: cell.y - dy, z: cell.z - dz };
        if (w.kindAt(n.x, n.y, n.z) === 'solid') out.push({ cell: n, face: f, interactive: isInteractive(w.blockAt(n.x, n.y, n.z)?.name) });
    }
    return out.sort((a, b) => a.interactive - b.interactive);
}

/** The player's box at `pos` overlaps the cell. */
const overlaps = (pos, c) => pos.x + 0.3 > c.x && pos.x - 0.3 < c.x + 1 && pos.z + 0.3 > c.z && pos.z - 0.3 < c.z + 1 && pos.y + 1.8 > c.y && pos.y < c.y + 1;

/** place {x, y, z, item, fluid?}: place the block item into that cell, against any solid neighbour. `fluid` allows a cell of water or lava. */
async function place(ctx, { x, y, z, item, fluid = false, temp = null, recipe = null, block = null, blind = false }) {
    const bot = ctx.bot, w = ctx.world, cell = { x, y, z };
    if (!bot.registry.blocksByName[block || item]) throw new SkillError('invalid_args', { item, block, why: 'not a placeable block item' });
    const cur = w.blockAt(x, y, z);
    if (!cur) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (!REPLACEABLE.test(cur.name) && !(fluid && FLUID.test(cur.name))) throw new SkillError('invalid_target', { why: `cell holds ${cur.name}`, target: cell });
    if (count(bot, item) < 1) throw new SkillError('missing_item', { item });
    // Never on top of a chest, Ender chest or shulker box: it could not be opened any more (owner 2026-11-10). A water seal (`fluid`) is the one exception, a fluid must be stopped;
    // it is registered as temporary (`temp`) and taken away again when nothing flows any more (work/bot/temps.js).
    if (!fluid && fixtures.coversContainer(w, cell) && !(recipe && fixtures.isOwn(bot, { x, y: y - 1, z }))) throw new SkillError('protected', { why: 'a block there would cover a container', block: item, target: cell });
    if (recipe) return placeWithRecipe(ctx, { cell, item, expect: block || item, recipe, temp });
    const refs = supports(w, cell);
    if (!refs.length) throw new SkillError('invalid_target', { why: 'no solid neighbour to place against', target: cell });
    // `blind` (work layer, fluid seals): the click on a support face within reach from where the bot stands, no walk, no line of sight; the vanilla server checks the reach to the
    // clicked block only (under_probe: a block placed against the bottom face of the floor, 3/3 on 1.21.1). A water cell whose only supports are behind the block the bot is
    // about to dig had no stand cell with a view at all, and the pit stalled ('seal: no standing cell within reach', mine_b mb075g w3, TASK-075)
    if (blind) return placeBlind(ctx, { cell, item, refs, temp });
    const free = (c) => !(c.x === x && c.z === z && (c.y === y || c.y + 1 === y));
    const seen = () => {
        const out = refs.filter((r) => clearOfEntities(ctx, aimPoints(ctx.body.eye(), r.cell, w.shapesAt, { face: r.face, limit: 5, reach: AIM_REACH })).length);
        if (!out.length && refs.some((r) => aimPoints(ctx.body.eye(), r.cell, w.shapesAt, { face: r.face, limit: 1, reach: AIM_REACH }).length)) ctx.phase('entity_in_the_way');
        return out;
    };
    await approachUntil(ctx, (reach, ok2) => {
        const goals = refs.map((r) => reachGoal(w, r.cell, { face: r.face, reach }));
        return { isGoal: (c) => free(c) && ok2(c) && goals.some((g) => g.isGoal(c)), h: (c) => Math.min(...goals.map((g) => g.h(c))), label: 'reach placement face' };
    }, () => (seen().length ? true : null), cell);
    await holdOrFail(ctx, item, undefined, 'item_held');
    // Step to the centre of the own cell if the body pokes into the target cell (the server refuses to place into a player).
    let mid = centre(feetCell(bot.entity.position));
    if (overlaps(bot.entity.position, cell)) {
        ctx.phase('clear_cell');
        // The bot stands IN the target cell (the router's walk ends in the cell it was asked to reach): its own centre is the target's centre, stepping there clears nothing (acceptance world 4,
        // 2026-11-13: "stuck" at clear_cell, 239 s, every block of test 4). Step to a neighbouring cell that can be stood on.
        const f0 = feetCell(bot.entity.position);
        if (f0.x === x && f0.z === z) { const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => ({ x: f0.x + a, y: f0.y, z: f0.z + b })).find((c) => standable(w, c.x, c.y, c.z)); if (n) mid = centre(n); }
        await ctx.until(() => !overlaps(bot.entity.position, cell), 30, 'stuck',
            () => ({ forward: hdist(bot.entity.position, mid) > 0.08, yaw: Math.atan2(-(mid.x - bot.entity.position.x), -(mid.z - bot.entity.position.z)) }));
        await ctx.until(() => Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.03, 10, 'stuck');
    }
    const placed = () => w.blockAt(x, y, z)?.name === item;
    let tried = 0;
    for (const r of seen()) {
        const sneak = r.interactive;           // sneak-click places against chests, tables, ... instead of opening them
        ctx.phase('place', { against: r.cell, face: r.face, sneak });
        let hit;
        try { hit = await aimAtBlock(ctx, r.cell, { face: r.face, frame: { sneak } }); } catch (e) { if (e.reason === 'not_visible') continue; throw e; }
        const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak };
        // a temporary block is registered BEFORE the click: one the server applied after the confirmation window was in nobody's list (owner list 5 Large 1, cause a; the registry
        // forgets a cell that turns out empty when it next looks)
        if (temp && bot.__temps) bot.__temps.add({ dim: fixtures.dimOf(bot), x, y, z, item, kind: temp, by: bot.username });
        await ctx.tick({ ...look, use: true });
        await ctx.tick(look);
        try { await ctx.until(placed, 10, 'not_confirmed', look); fixtures.markPlaced(bot, item, cell); return { against: r.cell, face: hit.face }; } catch (e) { if (e.reason !== 'not_confirmed') throw e; }
        if (++tried >= 3) break;
    }
    throw new SkillError(tried ? 'not_confirmed' : 'not_visible', { target: cell, tried });
}

/** The blind click of `place {blind}`: the nearest support face within BLIND_REACH of the eye, clicked by the body's cell frame. */
async function placeBlind(ctx, { cell, item, refs, temp }) {
    const bot = ctx.bot, w = ctx.world, eye = ctx.body.eye(), { x, y, z } = cell;
    const faceMid = (r) => { const n = FACES[r.face]; return { x: r.cell.x + 0.5 + n[0] * 0.5, y: r.cell.y + 0.5 + n[1] * 0.5, z: r.cell.z + 0.5 + n[2] * 0.5 }; };
    const cands = refs.filter((r) => !r.interactive).map((r) => ({ r, d: Math.hypot(faceMid(r).x - eye.x, faceMid(r).y - eye.y, faceMid(r).z - eye.z) })).filter((o) => o.d <= BLIND_REACH - 0.5).sort((a, b) => a.d - b.d);
    if (!cands.length) throw new SkillError('unreachable', { why: 'no support face within reach for a blind click', target: cell });
    if (overlaps(bot.entity.position, cell)) throw new SkillError('precondition_failed', { unmet: [{ need: 'cell_free', cell }] });
    await holdOrFail(ctx, item, undefined, 'item_held');
    const placed = () => w.blockAt(x, y, z)?.name === item;
    for (const { r } of cands.slice(0, 3)) {
        const n = FACES[r.face], cursor = { x: n[0] > 0 ? 1 : n[0] < 0 ? 0 : 0.5, y: n[1] > 0 ? 1 : n[1] < 0 ? 0 : 0.5, z: n[2] > 0 ? 1 : n[2] < 0 ? 0 : 0.5 };
        ctx.phase('place_blind', { against: r.cell, face: r.face });
        if (temp && bot.__temps) bot.__temps.add({ dim: fixtures.dimOf(bot), x, y, z, item, kind: temp, by: bot.username });          // before the click
        await ctx.tick({ use: true, cell: { x: r.cell.x, y: r.cell.y, z: r.cell.z, face: r.face, cursor } });
        await ctx.tick({});
        try { await ctx.until(placed, 10, 'not_confirmed'); fixtures.markPlaced(bot, item, cell); return { against: r.cell, face: r.face, blind: true }; } catch (e) { if (e.reason !== 'not_confirmed') throw e; }
    }
    throw new SkillError('not_confirmed', { target: cell, blind: true });
}

/**
 * Place with an explicit recipe (src/work/jobs/orient.js): the click lands on the face `recipe.face` of the block `recipe.support` away from the cell, at height
 * `recipe.hy`, while the player looks along `recipe.yRot` / `recipe.pitch` (the look decides facing, rotation and half of most blocks). The server checks the reach
 * to the clicked block, not the line of sight (vanilla), so the click is blind (Body frame `cell`); only the walk to a spot within reach is needed.
 * `expect` is the block that must stand in the cell afterwards (an item may place another block: redstone -> redstone_wire).
 */
/** The jump of `placeWithRecipe`: look and click as the recipe says, at the top of a jump, into the cell the feet have just left (the support is the block under it); the bot lands on the new block. */
async function jumpPlace(ctx, { cell, sup, expect, recipe, item, temp }) {
    const bot = ctx.bot, w = ctx.world, { x, y, z } = cell;
    const n = FACES[recipe.face], cursor = { x: n[0] > 0 ? 1 : n[0] < 0 ? 0 : 0.5, y: n[1] > 0 ? 1 : n[1] < 0 ? 0 : (recipe.hy ?? 0.5), z: n[2] > 0 ? 1 : n[2] < 0 ? 0 : 0.5 };
    const look = { yaw: ((180 - recipe.yRot) * Math.PI) / 180, pitch: recipe.pitch === 'up' ? Math.PI / 2 : recipe.pitch === 'down' ? -Math.PI / 2 : 0 };
    const placed = () => w.blockAt(x, y, z)?.name === expect;
    if (!bot.entity.onGround) await ctx.until(() => bot.entity.onGround, 40, 'stuck');
    const mid = centre(cell);                                                        // centred first: a body 0.2 off the middle brushes the next column with its head when it jumps
    if (hdist(bot.entity.position, mid) > 0.15) await ctx.until(() => hdist(bot.entity.position, mid) <= 0.12, 25, 'stuck', () => ({ forward: hdist(bot.entity.position, mid) > 0.1, sneak: true, yaw: Math.atan2(-(mid.x - bot.entity.position.x), -(mid.z - bot.entity.position.z)) }));
    for (let attempt = 0; attempt < 2 && !placed(); attempt++) {
        ctx.phase('jump_place', { cell, against: sup });
        await ctx.tick({ ...look, jump: true });
        await ctx.until(() => bot.entity.position.y >= y + 1.002, 14, 'stuck', { ...look, jump: true });        // the placed block no longer touches the body
        if (temp && bot.__temps) bot.__temps.add({ dim: fixtures.dimOf(bot), x, y, z, item, kind: temp, by: bot.username });          // before the click (see above)
        await ctx.tick({ ...look, use: true, cell: { x: sup.x, y: sup.y, z: sup.z, face: recipe.face, cursor } });
        await ctx.tick(look);
        try { await ctx.until(placed, 12, 'not_confirmed', look); } catch (e) { if (!(e instanceof SkillError) || e.reason !== 'not_confirmed') throw e; await ctx.idle(10); }
        await ctx.until(() => bot.entity.onGround, 30, 'stuck', look);
    }
    if (!placed()) throw new SkillError('not_confirmed', { target: cell, jump: true, now: w.blockAt(x, y, z)?.name || null });
    fixtures.markPlaced(bot, expect, cell);
    return { against: sup, face: recipe.face, recipe: true, jump: true };
}

async function placeWithRecipe(ctx, { cell, item, expect, recipe, temp }) {
    const bot = ctx.bot, w = ctx.world, { x, y, z } = cell;
    const D = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }[recipe.support];
    if (!D) throw new SkillError('invalid_args', { why: 'bad recipe support', recipe });
    const sup = { x: x + D[0], y: y + D[1], z: z + D[2] }, sb = w.blockAt(sup.x, sup.y, sup.z);
    if (!sb || REPLACEABLE.test(sb.name) || FLUID.test(sb.name)) throw new SkillError('invalid_target', { why: 'the recipe support is not a block that can be clicked', support: sup, block: sb ? sb.name : null, target: cell });
    const sneak = !!recipe.sneak || isInteractive(sb.name);
    // The body stands IN the cell and the block goes on what is under the feet (the next block of a column or a tube built upward, where no neighbour cell is free to step to): the bot jumps,
    // places under its feet at the top of the jump and lands on the block, as a pillar does (owner 2026-11-18: "the bots stall because their own bodies keep them from placing").
    const f0 = feetCell(bot.entity.position);
    const jumpable = recipe.support === 'down' && f0.x === x && f0.y === y && f0.z === z && w.kindAt(x, y + 2, z) === 'air' && w.kindAt(x, y + 1, z) === 'air' && w.kindAt(x, y - 1, z) === 'solid';
    const free = (c) => (jumpable && c.x === x && c.y === y && c.z === z) || !(c.x === x && c.z === z && (c.y === y || c.y + 1 === y));
    const dist = (c) => Math.hypot(c.x + 0.5 - (sup.x + 0.5), c.y + 1.62 - (sup.y + 0.5), c.z + 0.5 - (sup.z + 0.5));
    await approachUntil(ctx, (reach, ok2) => ({ isGoal: (c) => free(c) && ok2(c) && dist(c) <= reach + 0.5, h: (c) => Math.max(0, dist(c) - reach), label: 'reach placement face' }), () => true, cell);
    await holdOrFail(ctx, item, undefined, 'item_held');
    let mid = centre(feetCell(bot.entity.position));
    if (jumpable && same(feetCell(bot.entity.position), cell)) return jumpPlace(ctx, { cell, sup, expect, recipe, item, temp });
    if (overlaps(bot.entity.position, cell)) {
        ctx.phase('clear_cell');
        const f0 = feetCell(bot.entity.position);
        if (f0.x === x && f0.z === z) { const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => ({ x: f0.x + a, y: f0.y, z: f0.z + b })).find((c) => standable(w, c.x, c.y, c.z)); if (n) mid = centre(n); }
        await ctx.until(() => !overlaps(bot.entity.position, cell), 30, 'stuck', () => ({ forward: hdist(bot.entity.position, mid) > 0.08, yaw: Math.atan2(-(mid.x - bot.entity.position.x), -(mid.z - bot.entity.position.z)) }));
        await ctx.until(() => Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.03, 10, 'stuck');
    }
    const n = FACES[recipe.face];                                               // normal of the clicked face; the cursor is on that face
    const cursor = { x: n[0] > 0 ? 1 : n[0] < 0 ? 0 : 0.5, y: n[1] > 0 ? 1 : n[1] < 0 ? 0 : (recipe.hy ?? 0.5), z: n[2] > 0 ? 1 : n[2] < 0 ? 0 : 0.5 };
    const look = { yaw: ((180 - recipe.yRot) * Math.PI) / 180, pitch: recipe.pitch === 'up' ? Math.PI / 2 : recipe.pitch === 'down' ? -Math.PI / 2 : 0, sneak };
    const placed = () => w.blockAt(x, y, z)?.name === expect;
    ctx.phase('place', { against: sup, face: recipe.face, hy: recipe.hy, yRot: recipe.yRot, pitch: recipe.pitch, sneak });
    for (let attempt = 0; attempt < 2; attempt++) {
        await ctx.tick(look); await ctx.tick(look);                             // the look reaches the server before the click (placement reads the player's rotation)
        if (temp && bot.__temps) bot.__temps.add({ dim: fixtures.dimOf(bot), x, y, z, item, kind: temp, by: bot.username });          // before the click (see above)
        await ctx.tick({ ...look, use: true, cell: { x: sup.x, y: sup.y, z: sup.z, face: recipe.face, cursor } });
        await ctx.tick(look);
        try { await ctx.until(placed, 10, 'not_confirmed', look); fixtures.markPlaced(bot, expect, cell); return { against: sup, face: recipe.face, recipe: true }; } catch (e) { if (e.reason !== 'not_confirmed') throw e; }
    }
    throw new SkillError('not_confirmed', { target: cell, recipe: { support: recipe.support, face: recipe.face, hy: recipe.hy, yRot: recipe.yRot, pitch: recipe.pitch }, now: w.blockAt(x, y, z)?.name || null });
}

/**
 * pour {x, y, z, item, waterlog?}: empty a water or lava bucket. Without `waterlog` the fluid source appears in the (empty) cell: the crosshair is put on a face of a
 * solid neighbour that borders the cell (the server takes the target from the real look ray, so this needs a line of sight, unlike `place` with a recipe). With `waterlog`
 * the bucket is used on the block in the cell itself (stairs, slabs, trapdoors ...): it becomes waterlogged, no water flows. Success = what the server sends back.
 */
async function pour(ctx, { x, y, z, item, waterlog = false }) {
    const bot = ctx.bot, w = ctx.world, cell = { x, y, z };
    if (!/^(water|lava)_bucket$/.test(item)) throw new SkillError('invalid_args', { item, why: 'pour needs a water or lava bucket' });
    const cur = w.blockAt(x, y, z);
    if (!cur) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (count(bot, item) < 1) throw new SkillError('missing_item', { item });
    const fluid = item.startsWith('lava') ? 'lava' : 'water';
    const done = () => { const b = w.blockAt(x, y, z); return !!b && (waterlog ? !!b.getProperties && String(b.getProperties().waterlogged) === 'true' : b.name === fluid); };
    if (done()) return { already: true };
    if (waterlog) {
        if (!cur.getProperties || !('waterlogged' in cur.getProperties())) throw new SkillError('invalid_target', { why: `${cur.name} cannot be waterlogged`, target: cell });
        if (fluid !== 'water') throw new SkillError('invalid_args', { why: 'only water waterlogs' });
        await approachBlock(ctx, cell);
        await holdOrFail(ctx, item, undefined, 'item_held');
        const hit = await aimAtBlock(ctx, cell, {});
        const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
        ctx.phase('pour', { block: cur.name, face: hit.face });
        await ctx.tick({ ...look, use: true }); await ctx.tick(look);
        await ctx.until(done, 20, 'not_confirmed', look);
        return { block: cur.name, waterlog: true };
    }
    if (!REPLACEABLE.test(cur.name) && !FLUID.test(cur.name)) throw new SkillError('invalid_target', { why: `cell holds ${cur.name}`, target: cell });
    const refs = supports(w, cell);
    if (!refs.length) throw new SkillError('invalid_target', { why: 'no solid neighbour to aim at', target: cell });
    const seen = () => refs.filter((r) => aimPoints(ctx.body.eye(), r.cell, w.shapesAt, { face: r.face, limit: 1, reach: AIM_REACH }).length);
    await approachUntil(ctx, (reach, ok2) => {
        const goals = refs.map((r) => reachGoal(w, r.cell, { face: r.face, reach }));
        return { isGoal: (c) => !(c.x === x && c.z === z && (c.y === y || c.y + 1 === y)) && ok2(c) && goals.some((g) => g.isGoal(c)), h: (c) => Math.min(...goals.map((g) => g.h(c))), label: 'reach pouring face' };
    }, () => (seen().length ? true : null), cell);
    await holdOrFail(ctx, item, undefined, 'item_held');
    let tried = 0;
    for (const r of seen()) {
        let hit;
        try { hit = await aimAtBlock(ctx, r.cell, { face: r.face, frame: { sneak: r.interactive } }); } catch (e) { if (e.reason === 'not_visible') continue; throw e; }
        const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak: r.interactive };
        ctx.phase('pour', { against: r.cell, face: hit.face });
        await ctx.tick({ ...look, use: true }); await ctx.tick(look);
        try { await ctx.until(done, 20, 'not_confirmed', look); return { against: r.cell, face: hit.face }; } catch (e) { if (e.reason !== 'not_confirmed') throw e; }
        if (++tried >= 3) break;
    }
    throw new SkillError(tried ? 'not_confirmed' : 'not_visible', { target: cell, tried });
}

/**
 * activate {x, y, z, item?, sneak?}: right-click an interactive block (lever, door, trapdoor, gate, chest, ...), optionally
 * holding `item` (a mod tool such as create:wrench) and sneaking. Success = the block's state changed or a screen opened.
 */
async function activate(ctx, { x, y, z, item, sneak = false, blind = false }) {
    const bot = ctx.bot, cell = { x, y, z };
    const b0 = ctx.world.blockAt(x, y, z);
    if (!b0) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    // A held tool can act on any block (a wrench rotates or picks up mod blocks); without one only interactive blocks react.
    if (!item && !isInteractive(b0.name)) throw new SkillError('invalid_target', { block: b0.name, why: 'not an interactive block (give item to use a tool on it)' });
    if (blind) {
        // The server checks the reach to the clicked block, not the line of sight (as in `place`): a trapdoor or a repeater inside the structure is opened or stepped from where the bot stands (work layer, polish pass).
        const eye = ctx.body.eye(), d = Math.hypot(eye.x - (x + 0.5), eye.y - (y + 0.5), eye.z - (z + 0.5));
        if (d > BLIND_REACH) throw new SkillError('not_visible', { target: cell, why: 'too far to use without a line of sight', dist: Math.round(d * 100) / 100 });
        const face = faceToward(eye, cell);
        ctx.phase('use_blind', { block: b0.name, face });
        await ctx.tick({ yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak: false });
        await ctx.tick({ yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak: false, use: true, cell: { x, y, z, face, cursor: { x: 0.5, y: 0.5, z: 0.5 } } });
        await ctx.until(() => ctx.world.blockAt(x, y, z)?.stateId !== b0.stateId, 12, 'not_confirmed', { yaw: bot.entity.yaw, pitch: bot.entity.pitch });
        const b1 = ctx.world.blockAt(x, y, z);
        return { block: b0.name, now: b1.name, from: b0.getProperties(), to: b1.getProperties(), window: null, blind: true };
    }
    await approachBlock(ctx, cell);
    if (item) await holdOrFail(ctx, resolveItemName(bot, item), undefined, 'item_held');
    const hit = await aimAtBlock(ctx, cell, { frame: { sneak } });
    const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak };
    ctx.phase('use', { block: b0.name, face: hit.face, item: item || null, sneak });
    await ctx.tick({ ...look, use: true });
    await ctx.until(() => ctx.world.blockAt(x, y, z)?.stateId !== b0.stateId || !!bot.currentWindow, 20, 'not_confirmed', look);
    const window = bot.currentWindow ? bot.currentWindow.type : null;
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    const b1 = ctx.world.blockAt(x, y, z);
    return { block: b0.name, now: b1.name, from: b0.getProperties(), to: b1.getProperties(), window };
}

const DIRS = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

/**
 * The cells `tunnel` clears (top first, so sand and gravel falling from above are dug again), the cell the feet end in, and
 * the cell that must carry them. dy 0: a 1x2 corridor step; -1: a stair step down (the head passes the cell above the
 * target); +1: a stair step up (head room above the bot for the jump).
 */
function tunnelCells(f, dir, dy) {
    const [dx, dz] = DIRS[dir], x = f.x + dx, z = f.z + dz;
    const to = { x, y: f.y + dy, z };
    const clear = dy === 0 ? [{ x, y: f.y + 1, z }, { x, y: f.y, z }]
        : dy < 0 ? [{ x, y: f.y + 1, z }, { x, y: f.y, z }, { x, y: f.y - 1, z }]
            : [{ x: f.x, y: f.y + 2, z: f.z }, { x, y: f.y + 2, z }, { x, y: f.y + 1, z }];
    return { to, clear, floor: { x, y: to.y - 1, z } };
}

/** Why a tunnel step cannot be dug from feet cell `f` (world only, no inventory), or null. Shared with the RL candidates. */
function tunnelProblem(w, f, dir, dy) {
    const { clear, floor } = tunnelCells(f, dir, dy);
    const fk = w.kindAt(floor.x, floor.y, floor.z);
    if (fk === 'unknown') return 'not loaded';
    if (fk !== 'solid') return 'no floor to stand on';
    const inClear = (c) => clear.some((q) => q.x === c.x && q.y === c.y && q.z === c.z);
    let solid = 0;
    for (const c of clear) {
        const k = w.kindAt(c.x, c.y, c.z);
        if (k === 'unknown') return 'not loaded';
        if (passable(k)) continue;
        if (k !== 'solid' && k !== 'partial') return `cell holds ${k}`;
        solid++;
        // Opening this cell must not let water or lava in: none of its other neighbours may hold a fluid.
        for (const [a, b, e] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const n = { x: c.x + a, y: c.y + b, z: c.z + e };
            if (inClear(n)) continue;
            const kn = w.kindAt(n.x, n.y, n.z);
            if (kn === 'water' || kn === 'liquid' || /lava/.test(w.nameAt ? w.nameAt(n.x, n.y, n.z) || '' : '')) return 'fluid behind';
        }
    }
    return solid ? null : 'nothing to dig (a walk)';
}

/** tunnel {dir, dy}: dig the neighbouring cells toward `dir` (level, one down or one up) and step into them. */
async function tunnel(ctx, { dir, dy }) {
    const w = ctx.world, f = feetCell(ctx.bot.entity.position);
    if (!standable(w, f.x, f.y, f.z)) throw new SkillError('invalid_target', { why: 'not standing on ground', at: f });
    const why = tunnelProblem(w, f, dir, dy);
    if (why) throw new SkillError('invalid_target', { why, dir, dy });
    const { to, clear } = tunnelCells(f, dir, dy);
    let mined = 0;
    const tools = [];
    for (const c of clear) {
        for (let n = 0; !passable(w.kindAt(c.x, c.y, c.z)); n++) {
            if (n >= 6) throw new SkillError('not_confirmed', { why: 'cell keeps filling (falling blocks)', cell: c });
            ctx.phase('tunnel_dig', { cell: c });
            tools.push((await mine(ctx, c)).tool || null);
            mined++;
            await ctx.idle(4);    // let sand or gravel above fall into the cell
        }
    }
    ctx.phase('tunnel_step', { to });
    const end = await follow(ctx, cellGoal(to, `tunnel ${dir} ${dy}`));
    return { to: end, mined, tools };
}

module.exports = { standerOn, BLIND_REACH, refusal, moveTo, lookAt, mine, place, pour, activate, tunnel, tunnelCells, tunnelProblem, bestTool, faceToward, dropOf, supports, overlaps, REPLACEABLE, DIRS };

'use strict';
// Commands on blocks: move_to, look_at, mine, place, activate. Each one walks (motion.js), aims the crosshair, and
// presses attack or use; success is the block change the server sends back, never the bot's own prediction.
const { SkillError } = require('../runner');
const { standable, isInteractive } = require('../world');
const { FACES, lookAngles, aimPoints, viewDir, raycast } = require('../geometry');
const { follow, cellGoal, reachGoal, approachBlock, aimAtBlock, feetCell, centre, hdist, same } = require('../motion');
const { holdItem, count } = require('./item');
const { collectDrops } = require('./entity');

const REPLACEABLE = /^(air|cave_air|void_air|grass|tall_grass|fern|large_fern|dead_bush|snow|seagrass|vine|glow_lichen)$/;
const LOOK_RANGE = 64;

/** move_to {x, y, z}: stand in that cell (feet). */
async function moveTo(ctx, { x, y, z }) {
    const t = { x, y, z };
    const b = ctx.world.blockAt(x, y, z);
    if (!b) throw new SkillError('unreachable', { why: 'target chunk not loaded', target: t });
    if (!standable(ctx.world, x, y, z)) throw new SkillError('invalid_target', { why: 'a player cannot stand there', target: t });
    const end = await follow(ctx, cellGoal(t, `cell ${x},${y},${z}`));
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

/** The tool in the inventory that breaks `block` fastest among those that harvest it (null = bare hand). */
function bestTool(bot, block) {
    const names = [null, ...new Set(bot.inventory.items().map((i) => i.name))];
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

/** mine {x, y, z}: break the block with the best tool at hand and pick up what it drops. */
async function mine(ctx, { x, y, z }) {
    const bot = ctx.bot, cell = { x, y, z };
    const b0 = ctx.world.blockAt(x, y, z);
    if (!b0) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (/^(air|cave_air|void_air)$/.test(b0.name) || !b0.diggable || ctx.world.kindAt(x, y, z) === 'liquid') throw new SkillError('invalid_target', { block: b0.name, target: cell });
    const tool = bestTool(bot, b0);
    if (!tool) throw new SkillError('missing_tool', { block: b0.name });
    const drop = dropOf(bot, b0), before = drop ? count(bot, drop) : 0;
    // Never stand on the block being broken.
    await approachBlock(ctx, cell, { ok: (c) => !(c.x === x && c.z === z && c.y === y + 1) });
    if (tool.name) await holdItem(ctx, tool.name);
    const gone = () => { const b = ctx.world.blockAt(x, y, z); return !!b && b.name !== b0.name; };
    const digTicks = Math.ceil(bot.digTime(b0) / 50);
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
    await ctx.tick({});
    if (drop) await collectDrops(ctx, cell, drop, before);
    return { block: b0.name, tool: tool.name, drop, got: drop ? count(bot, drop) - before : 0 };
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

/** place {x, y, z, item}: place the block item into that cell, against any solid neighbour. */
async function place(ctx, { x, y, z, item }) {
    const bot = ctx.bot, w = ctx.world, cell = { x, y, z };
    if (!bot.registry.blocksByName[item]) throw new SkillError('invalid_args', { item, why: 'not a placeable block item' });
    const cur = w.blockAt(x, y, z);
    if (!cur) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (!REPLACEABLE.test(cur.name)) throw new SkillError('invalid_target', { why: `cell holds ${cur.name}`, target: cell });
    if (count(bot, item) < 1) throw new SkillError('missing_item', { item });
    const refs = supports(w, cell);
    if (!refs.length) throw new SkillError('invalid_target', { why: 'no solid neighbour to place against', target: cell });
    const goals = refs.map((r) => reachGoal(w, r.cell, { face: r.face }));
    const free = (c) => !(c.x === x && c.z === z && (c.y === y || c.y + 1 === y));
    const goal = { isGoal: (c) => free(c) && goals.some((g) => g.isGoal(c)), h: (c) => Math.min(...goals.map((g) => g.h(c))), label: 'reach placement face' };
    const here = feetCell(bot.entity.position);
    if (!(bot.entity.onGround && goal.isGoal(here))) { ctx.phase('approach', { target: cell }); await follow(ctx, goal); }
    await holdItem(ctx, item);
    // Step to the centre of the own cell if the body pokes into the target cell (the server refuses to place into a player).
    const mid = centre(feetCell(bot.entity.position));
    if (overlaps(bot.entity.position, cell)) {
        ctx.phase('clear_cell');
        await ctx.until(() => !overlaps(bot.entity.position, cell), 30, 'stuck',
            () => ({ forward: hdist(bot.entity.position, mid) > 0.08, yaw: Math.atan2(-(mid.x - bot.entity.position.x), -(mid.z - bot.entity.position.z)) }));
        await ctx.until(() => Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.03, 10, 'stuck');
    }
    const placed = () => w.blockAt(x, y, z)?.name === item;
    let tried = 0;
    for (const r of refs) {
        const eye = ctx.body.eye();
        if (!aimPoints(eye, r.cell, w.shapesAt, { face: r.face, limit: 1 }).length) continue;
        const sneak = r.interactive;           // sneak-click places against chests, tables, ... instead of opening them
        ctx.phase('place', { against: r.cell, face: r.face, sneak });
        let hit;
        try { hit = await aimAtBlock(ctx, r.cell, { face: r.face, frame: { sneak } }); } catch (e) { if (e.reason === 'not_visible') continue; throw e; }
        const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch, sneak };
        await ctx.tick({ ...look, use: true });
        await ctx.tick(look);
        try { await ctx.until(placed, 10, 'not_confirmed', look); return { against: r.cell, face: hit.face }; } catch (e) { if (e.reason !== 'not_confirmed') throw e; }
        if (++tried >= 3) break;
    }
    throw new SkillError(tried ? 'not_confirmed' : 'not_visible', { target: cell, tried });
}

/** activate {x, y, z}: right-click an interactive block (lever, door, trapdoor, gate, ...). Success = its state changed. */
async function activate(ctx, { x, y, z }) {
    const bot = ctx.bot, cell = { x, y, z };
    const b0 = ctx.world.blockAt(x, y, z);
    if (!b0) throw new SkillError('unreachable', { why: 'target chunk not loaded' });
    if (!isInteractive(b0.name)) throw new SkillError('invalid_target', { block: b0.name });
    await approachBlock(ctx, cell);
    const hit = await aimAtBlock(ctx, cell);
    const look = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
    ctx.phase('use', { block: b0.name, face: hit.face });
    await ctx.tick({ ...look, use: true });
    await ctx.until(() => ctx.world.blockAt(x, y, z)?.stateId !== b0.stateId || !!bot.currentWindow, 20, 'not_confirmed', look);
    const window = bot.currentWindow ? bot.currentWindow.type : null;
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    const b1 = ctx.world.blockAt(x, y, z);
    return { block: b0.name, from: b0.getProperties(), to: b1.getProperties(), window };
}

module.exports = { moveTo, lookAt, mine, place, activate, bestTool, dropOf, supports, overlaps, REPLACEABLE };

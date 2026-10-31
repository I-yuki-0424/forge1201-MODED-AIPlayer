'use strict';
// Commands on entities: pickup (walk over a dropped item) and attack (chase a mob, swing when the weapon is charged).
const { SkillError } = require('../runner');
const { ENTITY_REACH, lookAngles, distToBox, entityBox } = require('../geometry');
const { follow, feetCell, centre, hdist, clearLine } = require('../motion');
const { holdItem, count } = require('./item');

// Attack damage and attacks per second of 1.20.1 melee weapons; anything else hits like a hand (1 damage, 4 per s).
const WEAPON = {
    wooden_sword: [4, 1.6], golden_sword: [4, 1.6], stone_sword: [5, 1.6], iron_sword: [6, 1.6], diamond_sword: [7, 1.6], netherite_sword: [8, 1.6],
    wooden_axe: [7, 0.8], golden_axe: [7, 1.0], stone_axe: [9, 0.8], iron_axe: [9, 0.9], diamond_axe: [9, 1.0], netherite_axe: [10, 1.0],
};
const HURT_TICKS = 10;   // a hit mob ignores further hits for this long

function bestWeapon(bot) {
    let best = { name: null, dmg: 1, speed: 4 };
    for (const i of bot.inventory.items()) {
        const w = WEAPON[i.name];
        if (w && w[0] * w[1] > best.dmg * best.speed) best = { name: i.name, dmg: w[0], speed: w[1] };
    }
    return { ...best, cooldown: Math.max(HURT_TICKS, Math.ceil(20 / best.speed)) };
}

const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const dropped = (e) => (e && e.name === 'item' && e.getDroppedItem ? e.getDroppedItem() : null);

/**
 * Walk onto the item entity `id` until `name` in the inventory exceeds `before`. Direct steering when the item is in
 * the open nearby, a planned path otherwise.
 */
async function pickupEntity(ctx, id, name, before) {
    const bot = ctx.bot, w = ctx.world;
    let close = 0;
    while (count(bot, name) <= before) {
        const ent = bot.entities[id];
        if (!ent) {
            await ctx.until(() => count(bot, name) > before, 10, 'target_lost');
            break;
        }
        const pos = bot.entity.position, ip = ent.position, cell = feetCell(pos);
        const d = hdist(pos, ip), dy = ip.y - pos.y;
        // Close by, or in the open: steer straight at it (jumping onto a block if it lies one block up).
        if (dy < 1.6 && dy > -1.5 && (d < 1.5 || (d < 8 && Math.abs(dy) < 1 && clearLine(w, pos, ip, cell.y)))) {
            if (d < 1.5 && ++close > 60) throw new SkillError('stuck', { why: 'next to the item for 3 s, not picked up', item: name, dy });
            await ctx.tick({ forward: d > 0.25, yaw: yawTo(pos, ip), jump: bot.entity.isCollidedHorizontally && bot.entity.onGround });
            continue;
        }
        const anchor = ip.clone();
        ctx.phase('go_to_item', { item: name, at: [anchor.x, anchor.y, anchor.z].map(Math.round) });
        await follow(ctx, {
            isGoal: (c) => hdist(centre(c), anchor) <= 1.0 && c.y <= anchor.y + 0.5 && c.y >= anchor.y - 1.5,
            h: (c) => Math.max(0, hdist(centre(c), anchor) - 1) + 0.5 * Math.abs(c.y - anchor.y),
            label: 'item', abort: () => !bot.entities[id] || count(bot, name) > before || bot.entities[id].position.distanceTo(anchor) > 1,
        });
    }
}

/** pickup {entity} | {item}: pick up that dropped item entity, or the nearest dropped stack of `item`. */
async function pickup(ctx, { entity, item }) {
    const bot = ctx.bot;
    let ent = entity !== undefined ? bot.entities[entity] : null;
    if (entity === undefined) {
        const me = bot.entity.position;
        ent = Object.values(bot.entities).filter((e) => dropped(e)?.name === item && e.position.distanceTo(me) < 48)
            .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    }
    const stack = dropped(ent);
    if (!stack) throw new SkillError('invalid_target', { entity, item, why: 'no such dropped item in view' });
    const before = count(bot, stack.name);
    ctx.phase('pickup', { item: stack.name, count: stack.count, entity: ent.id });
    await pickupEntity(ctx, ent.id, stack.name, before);
    return { item: stack.name, got: count(bot, stack.name) - before };
}

/** After breaking a block: wait for its drop to appear and pick it up. */
async function collectDrops(ctx, cell, name, before) {
    const bot = ctx.bot, mid = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
    const near = () => Object.values(bot.entities).filter((e) => dropped(e)?.name === name && e.position.distanceTo(mid) < 4)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    ctx.phase('collect_drop', { item: name });
    await ctx.until(() => count(bot, name) > before || near().length > 0, 30, 'not_confirmed');
    for (let i = 0; i < 3 && count(bot, name) <= before; i++) {
        const e = near()[0];
        if (!e) { await ctx.idle(5); continue; }
        await pickupEntity(ctx, e.id, name, before);
    }
    if (count(bot, name) <= before) throw new SkillError('not_confirmed', { why: 'drop not picked up', item: name });
}

/** attack {entity}: kill the mob, chasing it if it runs. Success = the server reports its death. */
async function attack(ctx, { entity }) {
    const bot = ctx.bot, w = ctx.world;
    const first = bot.entities[entity];
    if (!first || first === bot.entity || first.name === 'item' || first.type === 'player' || first.type === 'object') {
        throw new SkillError('invalid_target', { entity, name: first && first.name });
    }
    let dead = false;
    const onDead = (e) => { if (e.id === entity) dead = true; };
    bot.on('entityDead', onDead);
    try {
        const weapon = bestWeapon(bot);
        if (weapon.name) await holdItem(ctx, weapon.name);
        ctx.phase('fight', { target: first.name, weapon: weapon.name, cooldown: weapon.cooldown });
        let last = -1000, swings = 0;
        for (;;) {
            if (dead) return { target: first.name, weapon: weapon.name, swings };
            const ent = bot.entities[entity];
            if (!ent) {
                await ctx.until(() => dead, 5, 'target_lost');
                continue;
            }
            const eye = ctx.body.eye(), pos = bot.entity.position;
            const box = entityBox(ent.position, ent.width || 0.6, ent.height || 1.8);
            const d = distToBox(eye, box);
            const look = lookAngles(eye, { x: ent.position.x, y: ent.position.y + (ent.height || 1.8) * 0.5, z: ent.position.z });
            if (d <= ENTITY_REACH - 0.2) {
                const h = ctx.body.crosshair();
                const onTarget = h && h.kind === 'entity' && h.entity.id === entity;
                const swing = onTarget && ctx.t - last >= weapon.cooldown;
                if (swing) { last = ctx.t; swings++; }
                await ctx.tick({ ...look, attack: swing, forward: d > 1.8 });
                continue;
            }
            const cell = feetCell(pos);
            if (hdist(pos, ent.position) < 10 && Math.abs(ent.position.y - pos.y) < 1.2 && clearLine(w, pos, ent.position, cell.y)) {
                await ctx.tick({ ...look, forward: true, sprint: d > 4 && bot.food > 6, jump: bot.entity.isCollidedHorizontally && bot.entity.onGround });
                continue;
            }
            const anchor = ent.position.clone();
            ctx.phase('chase', { at: [anchor.x, anchor.y, anchor.z].map(Math.round) });
            await follow(ctx, {
                isGoal: (c) => hdist(centre(c), anchor) <= 2 && Math.abs(c.y - Math.floor(anchor.y + 1e-6)) <= 1,
                h: (c) => Math.max(0, hdist(centre(c), anchor) - 2) + 0.5 * Math.abs(c.y - anchor.y),
                label: 'chase',
                abort: () => dead || !bot.entities[entity] || bot.entities[entity].position.distanceTo(anchor) > 1.5
                    || distToBox(ctx.body.eye(), entityBox(bot.entities[entity].position, ent.width || 0.6, ent.height || 1.8)) <= ENTITY_REACH - 0.2,
            });
            ctx.phase('fight');
        }
    } finally {
        bot.removeListener('entityDead', onDead);
    }
}

module.exports = { pickup, attack, collectDrops, pickupEntity, bestWeapon };

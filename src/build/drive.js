'use strict';
// One bot of the crew: claim a station and its tasks, fly there, do them (grouped by the look they need: a change of look costs a tick), read every cell back, report. Also the
// first look into the materials containers, and the late work (pouring a fluid along a ray the server traces itself, lighting portals and fires).
const { Vec3 } = require('vec3');
const S = require('./state');
const R = require('./rules');
const fly = require('./fly');
const { Hand, seen, eyeOf, boxDist, sleep } = require('./act');
const { readSupply, sealFrom } = require('./supply');
const { REPLACEABLE, clicksFor } = require('./survey');

const PACE_MS = 30;                 // between two actions of one bot
const READ_MS = 300;                // after a batch, before the read-back
const NON_BLOCKING = /^(item|experience_orb|arrow|spectral_arrow|trident|snowball|egg|ender_pearl|potion|splash_potion|lingering_potion|fireball|small_fireball|dragon_fireball|wither_skull|area_effect_cloud|marker|interaction|block_display|item_display|text_display|lightning_bolt|falling_block|eye_of_ender|firework_rocket|fishing_bobber|leash_knot|painting|item_frame|glow_item_frame)$/;
const key = (x, y, z) => `${x},${y},${z}`;

/** Entities (other bots, animals) whose box overlaps cell c: a block cannot be placed there. */
function inCell(bot, c) {
    const out = [];
    for (const e of Object.values(bot.entities)) {
        if (!e || e === bot.entity || !e.position || NON_BLOCKING.test(e.name || '')) continue;
        const w = (e.width || 0.6) / 2, h = e.height || 1.8, p = e.position;
        if (p.x + w > c.x && p.x - w < c.x + 1 && p.z + w > c.z && p.z - w < c.z + 1 && p.y + h > c.y && p.y < c.y + 1) out.push(e);
    }
    const me = bot.entity.position;
    if (me.x + 0.3 > c.x && me.x - 0.3 < c.x + 1 && me.z + 0.3 > c.z && me.z - 0.3 < c.z + 1 && me.y + 1.8 > c.y && me.y < c.y + 1) out.push(bot.entity);
    return out;
}

/** Walk the ray from `a` to `b` cell by cell; returns the first cell holding something a bucket's ray stops at (not air, not a fluid) and the cell before it. */
function rayHit(bot, a, b) {
    const d = b.minus(a), len = d.norm(), dir = d.scaled(1 / len);
    let x = Math.floor(a.x), y = Math.floor(a.y), z = Math.floor(a.z), prev = null;
    const step = [Math.sign(dir.x), Math.sign(dir.y), Math.sign(dir.z)];
    const tDelta = [Math.abs(1 / dir.x), Math.abs(1 / dir.y), Math.abs(1 / dir.z)];
    const frac = (v, s) => (s > 0 ? Math.floor(v) + 1 - v : v - Math.floor(v));
    const tMax = [step[0] ? frac(a.x, step[0]) * tDelta[0] : Infinity, step[1] ? frac(a.y, step[1]) * tDelta[1] : Infinity, step[2] ? frac(a.z, step[2]) * tDelta[2] : Infinity];
    for (let t = 0; t <= len + 1e-6;) {
        const h = seen(bot, { x, y, z });
        if (h && !S.AIR.has(h.name) && h.name !== 'water' && h.name !== 'lava' && h.name !== 'bubble_column') return { cell: { x, y, z }, prev };
        prev = { x, y, z };
        const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
        t = tMax[k]; tMax[k] += tDelta[k];
        if (k === 0) x += step[0]; else if (k === 1) y += step[1]; else z += step[2];
    }
    return null;
}

/** A pour of fluid into cell L from an eye at `eye`: aim at the face of a solid neighbour that faces L, the ray entering L first. Returns {yaw, pitch} or null. */
function pourAim(bot, eye, L, reach) {
    for (const [d, v] of Object.entries(R.VEC)) {
        const n = { x: L.x + v[0], y: L.y + v[1], z: L.z + v[2] }, h = seen(bot, n);
        if (!h || S.AIR.has(h.name) || h.name === 'water' || h.name === 'lava' || h.shape === 'empty') continue;
        // the face of n toward L: its centre, a hair inside n
        const pt = new Vec3(n.x + 0.5 - v[0] * 0.499, n.y + 0.5 - v[1] * 0.499, n.z + 0.5 - v[2] * 0.499);
        if (pt.distanceTo(eye) > reach) continue;
        const hit = rayHit(bot, eye, pt);
        if (!hit || hit.cell.x !== n.x || hit.cell.y !== n.y || hit.cell.z !== n.z || !hit.prev || hit.prev.x !== L.x || hit.prev.y !== L.y || hit.prev.z !== L.z) continue;
        const dx = pt.x - eye.x, dy = pt.y - eye.y, dz = pt.z - eye.z;
        void d;
        return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
    }
    return null;
}

/** A station (feet cell) from which a pour into L works, near the bot. */
function pourStation(bot, L, blocked, reach) {
    for (let r = 0; r <= 4; r++) for (let dy = 4; dy >= -2; dy--) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const f = { x: L.x + dx, y: L.y + dy, z: L.z + dz };
        if (!fly.fits(bot, f.x, f.y, f.z, blocked)) continue;
        const eye = eyeOf({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 });
        const aim = pourAim(bot, eye, L, reach);
        if (aim) return { f, aim };
    }
    return null;
}

const UNBREAKABLE = /^(bedrock|barrier|end_portal_frame|end_portal|end_gateway|nether_portal|command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|reinforced_deepslate|light)$/;
const CONTAINER = /(chest|barrel|shulker_box|hopper|dropper|dispenser|furnace|smoker|crafter|_bed|lectern|brewing_stand|decorated_pot)$/;
/**
 * How a bot may fly through terrain (a tunnel): which cells it may break on the way and how. Never a block that belongs where it stands (a built cell of the box), never a container
 * or something unbreakable, never next to a fluid (it would run into the tunnel).
 */
function flight(job, bot, hand, { anything = false } = {}) {
    return {
        dig: async (c) => { hand.dig(c); await sleep(60); },
        canDig: (x, y, z) => {
            const h = seen(bot, { x, y, z });
            if (!h || S.AIR.has(h.name) || UNBREAKABLE.test(h.name) || CONTAINER.test(h.name) || h.name === 'water' || h.name === 'lava') return false;
            if (!anything && job.t.inside(x, y, z)) { const want = job.t.at(x, y, z); if (S.matches(want, h)) return false; }
            for (const v of Object.values(R.VEC)) { const n = seen(bot, { x: x + v[0], y: y + v[1], z: z + v[2] }); if (n && (n.name === 'water' || n.name === 'lava' || n.props.waterlogged === 'true')) return false; }
            return true;
        },
    };
}

/** Is cell c (task tk) right now? */
function holds(job, bot, tk) {
    const h = seen(bot, tk);
    if (!h) return { ok: false, why: 'not loaded' };
    if (tk.kind === 'seal' || tk.kind === 'fill') return h.name !== 'water' && h.name !== 'lava' && h.props.waterlogged !== 'true' && !/^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/.test(h.name) ? { ok: true } : { ok: false, why: `still ${h.name}` };
    if (tk.kind === 'clear') return S.AIR.has(h.name) ? { ok: true } : { ok: false, why: `still ${h.name}` };
    if (tk.kind === 'ignite' && tk.portal) { const p = seen(bot, tk.portal.at); return p && p.name === 'nether_portal' ? { ok: true } : { ok: false, why: `portal not lit (${p && p.name})` }; }
    const want = job.t.wantOf(tk);
    if (S.matches(want, h) || S.dynamicPair(want, h)) return { ok: true };
    return { ok: false, why: `got ${S.str(h.name, S.decidedProps(h.name, h.props))}` };
}

/** Do one claim. Returns the results for job.report. */
async function work(job, name, bot, hand, cl, cancel) {
    const results = [], done = new Set();
    const fr = await fly.flyTo(bot, cl.station, { cancel, ...flight(job, bot, hand) });
    hand.moved();
    if (!fr.ok) {
        for (const tk of cl.tasks) results.push({ tk, ok: false, why: 'skipped' });
        const n = (job.noPath.get(name) || 0) + 1; job.noPath.set(name, n);
        job.log(`${name}: no flight to ${cl.station.x} ${cl.station.y} ${cl.station.z} (${fr.reason}, ${n} in a row)`);
        if (n >= 3) await escape(job, name, bot, hand, cancel);
        return results;
    }
    job.noPath.set(name, 0);
    await sleep(60);
    const sent = new Set(), clicks = [], executed = [];
    let actions = 0;
    const pace = async () => { if (++actions % 2 === 0) await sleep(PACE_MS); };
    const left = new Set(cl.tasks);
    const now = Date.now();
    for (let round = 0; round < 8 && left.size && !cancel.cancelled; round++) {
        // what can go now (its dependencies stand or were just sent), grouped by aim
        const groups = new Map();
        for (const tk of left) {
            if (!job.ready(tk, bot, now, sent)) continue;
            const r = tk.kind === 'place' ? job.t.recipeOf(tk) : null;
            const aim = r ? Hand.aimKey(r) : 'any';
            (groups.get(aim) || groups.set(aim, []).get(aim)).push(tk);
        }
        if (!groups.size) break;
        for (const [aim, list] of groups) {
            if (cancel.cancelled) break;
            const r0 = list[0].kind === 'place' ? job.t.recipeOf(list[0]) : null;
            if (r0) await hand.aim(r0.look, r0.sneak);
            else if (aim === 'any' && hand.sneaking) await hand.aim(null, false);
            for (const tk of list) {
                left.delete(tk);
                const h = seen(bot, tk);
                if (!h) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
                if (boxDist(eyeOf(bot.entity.position), tk) > job.o.reach + 0.5) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
                if (tk.kind === 'clear') {
                    if (S.AIR.has(h.name)) { results.push({ tk, ok: true }); continue; }
                    hand.dig(tk); executed.push(tk); await pace(); continue;
                }
                if (tk.kind === 'seal' || tk.kind === 'fill') {
                    if (inCell(bot, tk).length) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
                    hand.hold(job.sealItem); hand.use(tk, 1, [0.5, 0.5, 0.5]); executed.push(tk); await pace(); continue;
                }
                if (tk.kind === 'fix') { clicks.push({ tk, n: tk.clicks, look: tk.look }); executed.push(tk); continue; }
                if (tk.kind === 'place') {
                    const r = job.t.recipeOf(tk);
                    if (!r) { results.push({ tk, ok: false, why: 'no recipe' }); continue; }
                    if (S.matches(job.t.wantOf(tk), h)) { results.push({ tk, ok: true }); continue; }
                    const blockers = inCell(bot, tk);
                    if (blockers.length) { if (blockers.some((e) => e.type !== 'player')) await shoo(bot, hand, blockers); results.push({ tk, ok: false, why: 'skipped' }); continue; }
                    if (!(S.AIR.has(h.name) || REPLACEABLE.test(h.name) || h.name === 'water' || h.name === 'lava')) { hand.dig(tk); await sleep(PACE_MS); hand.hold(r.item); }
                    hand.place(tk, r);
                    sent.add(tk.k); executed.push(tk); await pace();
                    if (r.clicks) clicks.push({ tk, n: r.clicks, look: r.clickLook });
                }
            }
        }
    }
    for (const tk of left) results.push({ tk, ok: false, why: 'skipped' });
    // clicks after every placement of the batch (an empty hand, no sneak; a fence gate opens away from the look)
    // how many: from what the cell holds now (power may have opened a trapdoor already, a note block may stand on its note), not from the recipe
    if (clicks.length) {
        await sleep(150);
        for (const c of clicks.sort((a, b) => String(a.look && a.look.h).localeCompare(String(b.look && b.look.h)))) {
            const h = seen(bot, c.tk), fx = h ? clicksFor(job.t.wantOf(c.tk), h) : null;
            if (!fx) continue;
            await hand.aim(fx.look || c.look || null, false);
            hand.click(c.tk, fx.clicks); await pace();
        }
    }
    await sleep(READ_MS);
    for (const tk of executed) { if (done.has(tk.k)) continue; done.add(tk.k); const h = holds(job, bot, tk); results.push({ tk, ok: h.ok, why: h.why }); }
    return results;
}

/** Animals in the way of a block: pushed away by hits (creative: a hit is a hit). */
async function shoo(bot, hand, ents) {
    hand.hold('diamond_sword');
    for (const e of ents) { if (e.type === 'player') continue; try { bot.attack(e); } catch (_) { /* gone */ } await sleep(60); }
}

/** The late work of one claim: pours and lightings, one at a time, each with its own station. */
async function late(job, name, bot, hand, cl, cancel) {
    const results = [];
    for (const tk of cl.tasks) {
        if (cancel.cancelled) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
        const r = tk.i >= 0 ? job.t.recipeOf(tk) : null;
        if (tk.kind === 'pour') {
            const st = pourStation(bot, tk, job.standBlocked(name), job.o.reach);
            if (!st) { results.push({ tk, ok: false, why: 'no ray into the cell' }); continue; }
            const fr = await fly.flyTo(bot, st.f, { cancel, ...flight(job, bot, hand) }); hand.moved();
            if (!fr.ok) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
            await sleep(80);
            const aim = pourAim(bot, eyeOf(bot.entity.position), tk, job.o.reach) || st.aim;
            hand.hold(r.item);
            await hand.useItem(aim.yaw, aim.pitch);
            await sleep(400);
            const h = holds(job, bot, tk); results.push({ tk, ok: h.ok, why: h.why });
            continue;
        }
        if (tk.kind === 'ignite') {
            const at = tk.portal ? tk.portal.light : { x: tk.x, y: tk.y - 1, z: tk.z };
            const fr = await fly.flyTo(bot, cl.station, { cancel, ...flight(job, bot, hand) }); hand.moved();
            if (!fr.ok) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
            await hand.aim({ h: 'north', v: 'down' }, false);
            hand.hold('flint_and_steel');
            hand.use(at, 1, [0.5, 0.99, 0.5]);
            await sleep(500);
            const h = holds(job, bot, tk); results.push({ tk, ok: h.ok, why: h.why });
        }
    }
    return results;
}

/** Hotbar items the bot brought (tools of a kit) go into free slots of the pack: the hand needs the hotbar. Creative slot packets, nothing is lost. */
function freeHotbar(bot, hand) {
    const inv = bot.inventory.slots;
    for (let i = 0; i < 9; i++) {
        const it = inv[36 + i]; if (!it) continue;
        let j = 9; while (j < 36 && inv[j]) j++;
        if (j >= 36) break;
        bot._client.write('set_creative_slot', { slot: j, item: hand.Item.toNotch(it) });
        bot._client.write('set_creative_slot', { slot: 36 + i, item: hand.Item.toNotch(null) });
        inv[j] = it; inv[36 + i] = null; hand.slots[i] = null;
    }
}

/**
 * The loop of one bot until the build is done, the bot is gone or `cancel`. `supplySites`: the materials containers ([{x,y,z}]).
 * Returns { ended: 'finished' | 'cancelled' | 'disconnected' | 'not_creative' }.
 */
async function drive(job, name, bot, { cancel = { cancelled: false }, supplySites = [] } = {}) {
    if (bot.game && bot.game.gameMode !== 'creative') return { ended: 'not_creative' };
    const hand = new Hand(bot);
    fly.takeOff(bot);
    freeHotbar(bot, hand);
    let idle = 0;
    try {
        while (!cancel.cancelled) {
            if (job.done) return { ended: 'finished' };
            if (!bot.entity || bot._client.ended) return { ended: 'disconnected' };
            if (bot.game && bot.game.gameMode !== 'creative') return { ended: 'not_creative' };
            if (job.available === null) {
                if (!job.supplyReading) {
                    job.supplyReading = readSupply(bot, supplySites, { cancel, log: job.log, fly: flight(job, bot, hand) }).then(async (s) => {
                        if (!s.read.length) { job.log(`supply: no container could be read (${JSON.stringify(s.failed).slice(0, 300)}); again in 10 s`); await sleep(10000); job.supplyReading = null; return; }
                        job.supply = s; job.available = new Set(Object.keys(s.totals).filter((k) => s.totals[k] > 0));
                        job.sealItem = sealFrom(s.totals) || job.sealItem;
                        job.log(`supply read by ${name}: ${Object.keys(s.totals).length} item types (${s.boxes} shulker boxes)${s.failed.length ? `, failed: ${JSON.stringify(s.failed)}` : ''}; seal block ${job.sealItem}`);
                    }, (e) => { job.log(`supply read failed: ${e.message}`); job.supplyReading = null; });
                }
                await job.supplyReading; await sleep(200); continue;
            }
            if (job.exhausted()) { await job.resurvey(bot, `${name}: stage ${job.stage} done`); continue; }
            const cl = job.claim(bot, name);
            if (!cl) {
                idle++;
                if (idle % 20 === 0) await stepAside(job, name, bot, hand, cancel);
                await sleep(job.stage === 'settle' ? 1000 : 250);
                continue;
            }
            idle = 0;
            const res = job.stage === 'late' ? await late(job, name, bot, hand, cl, cancel) : await work(job, name, bot, hand, cl, cancel);
            job.report(name, res);
        }
        return { ended: 'cancelled' };
    } finally { job.leave(name); if (hand.sneaking) bot.setControlState('sneak', false); fly.land(bot); }
}

/**
 * A bot that cannot fly anywhere (closed in: a block went into its cell, a room was finished around it) breaks its way to the nearest free cell above the work, through whatever is in
 * the way (built cells too: the next survey puts them back). The last resort; counted and logged.
 */
async function escape(job, name, bot, hand, cancel) {
    const blocked = job.standBlocked(name), f = fly.feet(bot), fl = flight(job, bot, hand, { anything: true });
    const goal = (x, y, z) => !blocked(x, y, z) && !blocked(x, y + 1, z) && fly.fits(bot, x, y, z) && y >= f.y;
    const route = fly.path(bot, f, { x: f.x, y: f.y + 8, z: f.z }, { goal, dig: fl.canDig, maxNodes: 20000 });
    job.stats.escapes = (job.stats.escapes || 0) + 1;
    job.log(`${name}: closed in at ${f.x} ${f.y} ${f.z}: ${route ? `breaking out (${route.length} cells)` : 'no way out found'}`);
    if (!route) return;
    // its own cells first (a block in the feet cell), then the way
    for (const y of [f.y, f.y + 1]) if (!fly.free(bot, f.x, y, f.z) && fl.canDig(f.x, y, f.z)) await fl.dig({ x: f.x, y, z: f.z });
    await fly.along(bot, route, cancel, fl.dig);
    hand.moved();
    job.noPath.set(name, 0);
}

/** An idle bot standing where blocks go soon moves up out of the way. */
async function stepAside(job, name, bot, hand, cancel) {
    const blocked = job.standBlocked(name), f = fly.feet(bot);
    if (!blocked(f.x, f.y, f.z) && !blocked(f.x, f.y + 1, f.z)) return;
    for (let dy = 1; dy <= 8; dy++) if (fly.fits(bot, f.x, f.y + dy, f.z, blocked)) { await fly.flyTo(bot, { x: f.x, y: f.y + dy, z: f.z }, { cancel, ...flight(job, bot, hand) }); hand.moved(); return; }
}

module.exports = { drive, work, late, holds, inCell, rayHit, pourAim, pourStation, flight };

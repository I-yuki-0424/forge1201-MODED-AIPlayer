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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNBREAKABLE = /^(bedrock|barrier|end_portal_frame|end_portal|end_gateway|nether_portal|command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|reinforced_deepslate|light)$/;
const CONTAINER = /(chest|barrel|shulker_box|hopper|dropper|dispenser|furnace|smoker|crafter|_bed|lectern|brewing_stand|decorated_pot)$/;
const FLUID = (h) => h && (h.name === 'water' || h.name === 'lava' || h.props.waterlogged === 'true');
const key = (x, y, z) => `${x},${y},${z}`;

/** The mover's rules for this job: what may be broken on the way (never a built cell of the box, a container, a supply site, next to a fluid), the temporary block. */
function rules(job, bot) {
    return {
        canDig: (x, y, z, b) => {
            if (UNBREAKABLE.test(b.name) || CONTAINER.test(b.name)) return false;
            if (job.t.inside(x, y, z)) { const want = job.t.at(x, y, z), h = seen(bot, { x, y, z }); if (h && S.matches(want, h)) return false; }
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (FLUID(seen(bot, { x: x + dx, y: y + dy, z: z + dz }))) return false;
            return true;
        },
        // the temporary block: the supply's, or rubble the bot dug up (dirt, cobblestone, netherrack: what a player builds scaffolds with)
        temp: () => { const inv = bot.inventory.items(); if (job.tempItem && inv.some((i) => i.name === job.tempItem)) return job.tempItem; const r = SUP.TEMPS.find((t) => !job.t.items.has(t) && inv.some((i) => i.name === t)); return r || null; },
        onTemp: (c) => { if (!job.t.inside(c.x, c.y, c.z)) job.temps.add(key(c.x, c.y, c.z)); },
    };
}

/** Is task tk's cell right now? */
function holds(job, bot, tk) {
    const h = seen(bot, tk);
    if (!h) return { ok: false, why: 'not loaded' };
    if (tk.kind === 'seal' || tk.kind === 'fill') return !FLUID(h) && !/^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/.test(h.name) ? { ok: true } : { ok: false, why: `still ${h.name}` };
    if (tk.kind === 'clear' || tk.kind === 'untemp') return S.AIR.has(h.name) ? { ok: true } : { ok: false, why: `still ${h.name}` };
    if (tk.kind === 'ignite' && tk.portal) { const p = seen(bot, tk.portal.at); return p && p.name === 'nether_portal' ? { ok: true } : { ok: false, why: `portal not lit (${p && p.name})` }; }
    const want = job.t.wantOf(tk);
    if (S.matches(want, h) || S.dynamicPair(want, h)) return { ok: true };
    return { ok: false, why: `got ${S.str(h.name, S.decidedProps(h.name, h.props))}` };
}

/** A click with the held item: look at the hit point (the server applies a look a tick after it arrives), then the use packet. */
async function click(mv, way) { await mv.click(way.n || way.at, way.face, way.hit, { sneak: !!way.sneak }); }

/** Do one claim from its stance. Returns results for job.report. */
async function work(job, name, bot, mv, cl, cancel) {
    const results = [];
    const tw = Date.now();
    const r = await mv.goto(cl.station, { cancel, maxNodes: 30000 });
    job.time.walk += Date.now() - tw;
    if (!r.ok) {
        // a stance the bot cannot get to counts against its tasks (as 'skipped' they came back for ever: live 2026-11-22 sD w2, 22 tree tops for 40 minutes)
        for (const tk of cl.tasks) results.push({ tk, ok: false, why: `no way to the stance ${cl.station.x},${cl.station.y},${cl.station.z} (${r.why})` });
        const n = (job.noPath.get(name) || 0) + 1; job.noPath.set(name, n);
        job.log(`${name}: no way to ${cl.station.x} ${cl.station.y} ${cl.station.z} (${r.why}, ${n} in a row)`);
        if (n >= 4) { job.noPath.set(name, 0); await escape(job, name, bot, mv, cancel); }
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
        if (tk.kind === 'clear' || tk.kind === 'untemp') { if (S.AIR.has(h.name)) { results.push({ tk, ok: true }); continue; } const td = Date.now(); await mv.dig(tk); job.time.dig += Date.now() - td; done.push(tk); continue; }
        if (tk.kind === 'seal' || tk.kind === 'fill') { if (!(await mv.hold(mv.rules.temp() || job.tempItem))) { results.push({ tk, ok: false, why: 'skipped' }); continue; } await click(mv, way); done.push(tk); continue; }
        if (tk.kind === 'fix') { await mv.holdNothing(); await mv.click([tk.x, tk.y, tk.z], way.click.face, way.click.hit); for (let k = 1; k < tk.clicks; k++) await mv.click([tk.x, tk.y, tk.z], way.click.face, way.click.hit); done.push(tk); continue; }
        if (tk.kind === 'ignite') { if (!(await mv.hold('flint_and_steel'))) { results.push({ tk, ok: false, why: 'skipped' }); continue; } await mv.click([way.light.x, way.light.y, way.light.z], 'up', way.click.hit); await sleep(300); done.push(tk); continue; }
        if (tk.kind === 'pour') { const ok = await pour(job, bot, mv, tk); results.push(ok ? holds(job, bot, tk) : { ok: false, why: 'no ray into the cell' }); continue; }
        if (tk.kind === 'place') {
            const rr = job.t.recipeOf(tk);
            if (S.matches(job.t.wantOf(tk), h)) { results.push({ tk, ok: true }); continue; }
            if (!(S.AIR.has(h.name) || REPLACEABLE.test(h.name) || h.name === 'water' || h.name === 'lava')) { await mv.dig(tk); }
            if (!(await mv.hold(rr.item))) { results.push({ tk, ok: false, why: 'skipped' }); continue; }
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
    return results;
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

/** A bot that cannot walk anywhere (closed in) breaks its way up and out, through whatever is in the way; the next survey puts built cells back. */
async function escape(job, name, bot, mv, cancel) {
    const f = feet(bot), b = job.t.box, loose = { canDig: (x, y, z, blk) => !UNBREAKABLE.test(blk.name) && !CONTAINER.test(blk.name), temp: mv.rules.temp, onTemp: mv.rules.onTemp };
    const m2 = new Mover(bot, loose);
    const top = Math.max(f.y + 2, b.y + b.sy + 1);
    job.stats.escapes++;
    const r = await m2.goto({ x: f.x, y: top, z: f.z }, { goal: (x, y, z) => y >= top || !job.t.inside(x, y - 1, z) && Math.hypot(x - f.x, z - f.z) > 3, cancel, maxNodes: 20000 });
    job.log(`${name}: closed in at ${f.x} ${f.y} ${f.z}: ${r.ok ? 'out' : 'no way out (' + r.why + ')'}`);
}

/** The crew's items: what the box needs (counted down by what stands), the temporary block, tools. */
function needsFor(job, bot, need) {
    const have = SUP.carried(bot), out = {};
    for (const [it, n] of Object.entries(need)) { const want = Math.min(n, 64 * 6) - (have[it] || 0); if (want > 0) out[it] = want; }
    const temps = SUP.TEMPS.filter((t) => !job.t.items.has(t)).reduce((a, t) => a + (have[t] || 0), 0);
    if (job.tempItem && temps < 64) out[job.tempItem] = 192 - temps;
    for (const k of Object.keys(out)) if ((job.outOf && job.outOf.get(k) || 0) > Date.now()) delete out[k];          // the chest ran out of it a while ago: not fetched again yet
    for (const tool of ['pickaxe', 'shovel', 'axe']) if (!bot.inventory.items().some((i) => i.name.endsWith('_' + tool) && !worn(bot, i))) { const best = job.supply && Object.keys(job.supply.totals).find((k) => k.endsWith('_' + tool)); if (best) out[best] = 1; }
    return out;
}
function worn(bot, it) { const max = (bot.registry.itemsByName[it.name] || {}).maxDurability; if (!max) return false; const dmg = (it.components || []).find((c) => c && c.type === 'damage'); const d = dmg ? Number(dmg.data) : (it.durabilityUsed || 0); return max - d < 12; }

/** One trip to the materials containers (one bot at a container at a time). */
async function supplyTrip(job, name, bot, mv, need, cancel) {
    const site = job.sites[0];
    if (!site) return false;
    // wait for the chest away from it (a box broken beside the chest drops as an item: a bot standing there picks it up and the box is gone from the supply)
    if (job.chestBusy && job.chestBusy !== name) {
        await mv.goto(site, { goal: (x, y, z) => Math.hypot(x - site.x, z - site.z) >= 5 && Math.hypot(x - site.x, z - site.z) <= 9, cancel, maxNodes: 15000 });
        while (job.chestBusy && job.chestBusy !== name && !cancel.cancelled) await sleep(500);
    }
    job.chestBusy = name;
    try {
        const r = await mv.goto(site, { goal: nearContainer(site), cancel, maxNodes: 40000 });
        if (!r.ok) { job.log(`${name}: no way to the materials at ${site.x} ${site.y} ${site.z} (${r.why})`); return false; }
        if (bot.inventory.items().some((i) => /shulker_box$/.test(i.name))) await SUP.putBack(bot, site);          // boxes it carries (picked up somewhere) go back first
        const spot = () => boxSpot(job, bot, site);
        await SUP.dropRubble(bot, (n) => job.available.has(n) || n === job.tempItem || (SUP.TEMPS.includes(n) && SUP.carried(bot)[n] <= 128), { minFree: 12 });          // room in the pack first (a pack full of rubble brought nothing back)
        const wants = needsFor(job, bot, need);
        job.depot = job.depot || [];
        const res = await SUP.fetch(bot, site, wants, mv, spot, { log: job.log, depot: job.depot });
        job.stats.trips++;
        job.log(`${name}: supply trip for ${JSON.stringify(wants).slice(0, 160)}: got ${JSON.stringify(res.got).slice(0, 200)}${Object.keys(res.short).length ? `; short ${JSON.stringify(res.short).slice(0, 200)}` : ''}`);
        // what it came back without, the chest has none of (left): not asked for again for ten minutes (a crew went every minute for nothing, live 2026-11-22 sF w3)
        for (const k of res.absent || []) (job.outOf = job.outOf || new Map()).set(k, Date.now() + 600000);
        return Object.keys(res.got).length > 0;
    } catch (e) { job.log(`${name}: supply trip failed: ${e.message}`); return false; }
    finally { job.chestBusy = null; }
}
const nearContainer = (c) => (x, y, z) => Math.abs(x - c.x) <= 2 && Math.abs(z - c.z) <= 2 && y >= c.y - 1 && y <= c.y + 1 && !(Math.abs(x - c.x) <= 1 && z === c.z && y === c.y + 1) && !(x === c.x && z === c.z);
/** A free cell beside the container (air, on something solid, not the bot's own cells, outside the box) for a shulker box to stand in while it is unpacked. */
function boxSpot(job, bot, c) {
    const v = new View(bot, { canDig: () => false }), me = feet(bot), out = [];
    // the depot: two to four cells from the chest (the ring next to it stays free for the bots that open the chest), never next to another depot box's top
    for (let r = 2; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, 1, -1]) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const s = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        if (job.t.inside(s.x, s.y, s.z) || (s.x === me.x && s.z === me.z)) continue;
        if (job.sites.some((q) => Math.abs(q.x - s.x) <= 1 && q.z === s.z && q.y === s.y - 1)) continue;        // not on top of a chest (bots stand there)
        if ((job.depot || []).some((q) => q.x === s.x && q.z === s.z && Math.abs(q.y - s.y) <= 2)) continue;          // never on or under another box (a box on a box keeps the lower one shut, live 2026-11-22)
        // air for the box and over it (a box opens upward), something solid under it, within reach of the bot
        if (!(v.free(s.x, s.y, s.z) && v.free(s.x, s.y + 1, s.z) && v.stands(s.x, s.y - 1, s.z))) continue;
        const d = Math.hypot(s.x + 0.5 - bot.entity.position.x, s.y + 0.5 - (bot.entity.position.y + 1.62), s.z + 0.5 - bot.entity.position.z);
        if (d <= 4) out.push({ s, d });
    }
    out.sort((a, b) => a.d - b.d);
    // only where a face is in sight from where the bot stands (the chest itself hides some)
    const P = require('./place'), world = P.botWorld(bot), name = (bot.inventory.items().find((i) => /shulker_box$/.test(i.name)) || {}).name || 'white_shulker_box';
    for (const { s: c2 } of out) if (P.ways(world, c2, { name, props: { facing: 'up' } }, name, [me], { max: 1 }).length || P.ways(world, c2, { name, props: { facing: 'up' } }, name, [me], { max: 1, sneakAlways: true }).length) return c2;
    return null;
}

/**
 * The loop of one bot until the build is done, the bot is gone or `cancel`. Returns { ended: 'finished' | 'cancelled' | 'disconnected' | 'wrong_mode' }.
 */
async function drive(job, name, bot, { cancel = { cancelled: false }, supplySites = [] } = {}) {
    if (bot.game && !['survival', 'creative'].includes(bot.game.gameMode)) return { ended: 'wrong_mode' };
    job.sites = supplySites;
    if (!job.bots.has(name)) job.bots.set(name, { station: null, pos: feet(bot) });
    const mv = new Mover(bot, rules(job, bot), { log: job.log });
    const onDeath = () => { const p = bot.entity && bot.entity.position, f = p ? feet(bot) : null, around = f ? [-1, 0, 1].map((dy) => (seen(bot, { x: f.x, y: f.y + dy, z: f.z }) || {}).name).join('/') : '?'; job.stats.deaths = (job.stats.deaths || 0) + 1; job.log(`${name} died at ${f ? `${f.x},${f.y},${f.z}` : '?'} (${around}), stage ${job.stage}`); };
    bot.on('death', onDeath);
    let idle = 0;
    try {
        while (!cancel.cancelled) {
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
            if (job.exhausted()) { await job.resurvey(bot, `${name}: stage ${job.stage} done`); continue; }
            await SUP.dropRubble(bot, (n) => job.available.has(n) || n === job.tempItem || (SUP.TEMPS.includes(n) && SUP.carried(bot)[n] <= 192));
            // tools and temporary blocks before the work needs them
            const base = needsFor(job, bot, {});
            if (Object.keys(base).length && job.stage !== 'settle' && !(job.lastTrip && Date.now() - job.lastTrip.get(name) < 60000)) { (job.lastTrip = job.lastTrip || new Map()).set(name, Date.now()); const tt = Date.now(); await supplyTrip(job, name, bot, mv, {}, cancel); job.time.trip += Date.now() - tt; continue; }
            const have = SUP.carried(bot);
            const tc = Date.now(); const cl = job.claim(bot, name, Date.now(), (it) => have[it] || 0); job.time.claim += Date.now() - tc;
            if (cl && cl.moveOff) {
                const f = feet(bot), floor = (x, y, z) => job.tasks.get(`${x},${y - 1},${z}`);
                await mv.goto(f, { goal: (x, y, z) => Math.hypot(x - f.x, z - f.z) >= 2 && !(floor(x, y, z) && ['clear', 'untemp'].includes(floor(x, y, z).kind)), cancel, maxNodes: 4000 });
                continue;
            }
            if (cl && cl.need) {
                // a trip that brought nothing is not repeated at once (the supply is short of it, or the chest is out of reach): a pause, other bots go meanwhile
                const back = (job.tripBack = job.tripBack || new Map()).get(name) || 0;
                if (Date.now() < back) { const ti = Date.now(); await sleep(1000); job.time.idle += Date.now() - ti; continue; }
                const tt = Date.now(); const got = await supplyTrip(job, name, bot, mv, cl.need, cancel); job.time.trip += Date.now() - tt;
                if (!got) job.tripBack.set(name, Date.now() + 30000);
                continue;
            }
            if (!cl) { idle++; const ti = Date.now(); await sleep(job.stage === 'settle' ? 1000 : 400); job.time.idle += Date.now() - ti; continue; }
            idle = 0;
            const res = await work(job, name, bot, mv, cl, cancel);
            if (process.env.BUILD_TRACE) { const by = {}; for (const r of res) { const k = `${r.tk.kind}:${r.ok ? 'ok' : String(r.why).replace(/-?\d+/g, '#').slice(0, 50)}`; by[k] = (by[k] || 0) + 1; } job.log(`[trace] ${name} at ${cl.station.x},${cl.station.y},${cl.station.z} (${cl.tasks.length} tasks): ${JSON.stringify(by)}`); }
            job.report(name, res);
        }
        return { ended: 'cancelled' };
    } finally { bot.removeListener('death', onDeath); job.leave(name); for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) bot.setControlState(k, false); }
}

module.exports = { drive, work, holds, rules, pour, escape, needsFor, boxSpot };

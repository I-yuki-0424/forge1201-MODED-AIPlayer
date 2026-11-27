'use strict';
// The crew's shared pool of materials: the chest and every bot's pack together. What a bot carries beyond what the cells near it need is the crew's, not its own: a bot whose
// ready work waits for an item asks the colleague that can spare it and is nearest, walks up to it, and the colleague throws the items over (a vanilla toss; the pickup is the
// server's). The chest is still the store for what nobody carries; no bot goes to it for an item a colleague nearby can hand over, and nothing goes back into it just in case.
// Owner 2026-11-24 instruction 1: in the tail the items were spread over eight packs and trips to the chest and hand-backs were about 40 % of bot time (ha30).
//
// One request at a time per bot and per giver. A request: { id, from, to, items: {item: n}, at, state: coming | tossed | done | failed, why, got }.
const { Vec3 } = require('vec3');
const { feet } = require('./move');
const SUP = require('./supply');

const sleep = (ms, label = 'wait: hand-over') => require('./pauses').sleep(ms, label);
const NEAR = { xz: 12, y: 8 };                  // the cells whose items a bot keeps for itself
// the giver throws when the asker stands this far from it (horizontally, about level): a toss thrown level flies about two and a half cells and lands at the asker's feet,
// out of the giver's own reach (from beside it the giver took its toss back, live 2026-11-25 hb6; aimed down from 2.3-3.2 it fell between the two, hb1)
const REACH = [1.8, 3.3];
const TTL = 120000;                             // a request not served in this time is dropped (the asker goes to the chest)
const MAX_DIST = 48;                            // no colleague further than this is asked (the walk is longer than a trip)

class Pool {
    constructor(job) { this.job = job; this.bots = new Map(); this.reqs = new Map(); this.seq = 0; this.cache = new Map(); this.stats = { asked: 0, served: 0, items: 0, failed: 0, ms: 0 }; }
    join(name, bot, mv = null) { this.bots.set(name, bot); (this.movers || (this.movers = new Map())).set(name, mv); }
    leave(name) { this.bots.delete(name); for (const r of this.reqs.values()) if (r.from === name || r.to === name) this.close(r, 'failed', `${name} left`); }

    /** What `name` keeps for itself: the items of the place tasks near it and of the tasks it has claimed ({item: count}), at most every 5 s. */
    keeps(name) {
        const hit = this.cache.get(name), now = Date.now();
        if (hit && now - hit.at < 5000) return hit.need;
        const bot = this.bots.get(name), job = this.job, need = {};
        if (bot && bot.entity) {
            const me = feet(bot);
            for (const tk of job.tasks.values()) {
                // (not for parked cells or cells that found no stance: items kept for an area's unreachable cells left 277 of 304 ready cells waiting, ha28 w1)
                if (tk.kind !== 'place' || (job.parked && job.parked.has(tk.k)) || (job.noStance && now - (job.noStance.get(tk.k) ?? now) > 15000)) continue;
                const mine = job.claims.get(tk.k) === name;
                if (!mine && (Math.abs(tk.x - me.x) > NEAR.xz || Math.abs(tk.z - me.z) > NEAR.xz || Math.abs(tk.y - me.y) > NEAR.y)) continue;
                const it = job._itemOf(tk); if (it) need[it] = (need[it] || 0) + 1;
            }
        }
        this.cache.set(name, { at: now, need });
        return need;
    }
    /** What `name` can give of item `it` now: carried beyond what it keeps. Never tools, shulker boxes or the crew's temporary blocks (the chest and the quarry have those). */
    spare(name, it) {
        const bot = this.bots.get(name);
        if (!bot || !bot.entity || SUP.TOOL.test(it) || SUP.SHULKER.test(it) || (SUP.TEMPS.includes(it) && !this.job.t.items.has(it))) return 0;
        const have = SUP.carried(bot)[it] || 0;
        return Math.max(0, have - (this.keeps(name)[it] || 0));
    }
    /** Can any colleague of `name` spare item `it` (for the claim: such cells are not left to others)? */
    canSpare(name, it) { for (const n of this.bots.keys()) if (n !== name && this.spare(n, it) > 0) return true; return false; }

    busy(name) { for (const r of this.reqs.values()) if ((r.to === name || r.from === name) && (r.state === 'coming' || r.state === 'tossed')) return r; return null; }

    /**
     * The best colleague to ask for `need` ({item: n}): the most of it spared, nearest (a climb counts double), within MAX_DIST, not busy, on its feet and out of water.
     * Returns [{ to, items, dist }] best first (the caller checks that it can walk there).
     */
    offers(name, need) {
        const me = this.bots.get(name);
        if (!me || !me.entity) return [];
        const p = me.entity.position, out = [];
        for (const [n, bot] of this.bots) {
            if (n === name || !bot.entity || this.busy(n) || bot.entity.isInWater || (this.job.gate && this.job.gate.inside.has(n))) continue;
            const q = bot.entity.position, dist = Math.hypot(q.x - p.x, q.z - p.z) + Math.abs(q.y - p.y) * 2;
            if (dist > MAX_DIST) continue;
            const items = {}; let amount = 0;
            for (const [it, want] of Object.entries(need)) { const s = Math.min(want, this.spare(n, it)); if (s > 0) { items[it] = s; amount += s; } }
            if (amount > 0) out.push({ to: n, items, amount, dist, score: amount / (1 + dist / 12) });
        }
        return out.sort((a, b) => b.score - a.score);
    }

    open(from, to, items) { const r = { id: ++this.seq, from, to, items, at: Date.now(), state: 'coming', got: {} }; this.reqs.set(r.id, r); this.stats.asked++; return r; }
    close(r, state, why = '') {
        if (r.state === 'done' || r.state === 'failed') return;
        r.state = state; r.why = why; r.end = Date.now();
        if (state === 'done') { this.stats.served++; this.stats.items += Object.values(r.got).reduce((a, n) => a + n, 0); } else this.stats.failed++;
        this.stats.ms += r.end - r.at;
        this.reqs.delete(r.id);
        this.job.log(`pool: ${r.from} <- ${r.to} ${JSON.stringify(r.items)}: ${state}${why ? ` (${why})` : ''}${Object.keys(r.got).length ? `, got ${JSON.stringify(r.got)}` : ''} in ${Math.round((r.end - r.at) / 1000)} s`);
    }
    /** The request addressed to `name` that waits for its toss, or null (expired ones are dropped). */
    forGiver(name) {
        for (const r of this.reqs.values()) {
            if (Date.now() - r.at > TTL) { this.close(r, 'failed', 'expired'); continue; }
            if (r.to === name && r.state === 'coming') return r;
        }
        return null;
    }

    /**
     * The giver's side, called between its moves and tasks: when the asker stands within reach, it looks at the asker's feet and throws the items (what it can still spare).
     * Returns true when it threw something.
     */
    async serve(name) {
        const r = this.forGiver(name);
        if (!r) return false;
        const bot = this.bots.get(name), asker = this.bots.get(r.from);
        if (!bot || !bot.entity) { this.close(r, 'failed', 'giver gone'); return false; }
        if (!asker || !asker.entity) { this.close(r, 'failed', 'asker gone'); return false; }
        const p = bot.entity.position, q = asker.entity.position;
        { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < REACH[0] || d > REACH[1] || Math.abs(q.y - p.y) > 1.2) return false;
          // the toss lands at the asker's feet or a cell beyond: both floors solid, or it falls (b081w4: Bd4a's 43 glass and 30 redstone, thrown to an asker on a stance in the
          // air, fell 38 cells and despawned); the asker is asked to stand on ground (it waits until the request's time is up, then goes to the chest)
          const solid = (x, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(q.y) - 1, Math.floor(z)), false); return !!b && b.boundingBox === 'block'; };
          if (!solid(q.x, q.z) || !solid(q.x + (q.x - p.x) / d, q.z + (q.z - p.z) / d)) { r.noFloor = (r.noFloor || 0) + 1; return false; } }
        // a third bot beside the asker picks the toss up as soon as the asker (items lay among the crew and eight bots took a share, live 2026-11-25 hb3): the giver waits a
        // few seconds for it to pass
        r.readyAt = r.readyAt || Date.now();
        if (Date.now() - r.readyAt < 8000) for (const [n, o] of this.bots) { if (n === name || n === r.from || !o.entity) continue; const w = o.entity.position; if (Math.hypot(w.x - q.x, w.z - q.z) < 1.8 && Math.abs(w.y - q.y) < 2) return false; }
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false);
        const e = p.offset(0, bot.entity.eyeHeight || 1.62, 0), t = q.offset(0, 1.1, 0);          // at the asker's body: about level
        try { await bot.look(Math.atan2(-(t.x - e.x), -(t.z - e.z)), Math.atan2(t.y - e.y, Math.hypot(t.x - e.x, t.z - e.z)), true); await sleep(120); } catch (_) { /* the look is a nicety */ }
        // the toss's own item entities (they spawn as it is thrown): for taking it back when the asker does not get it
        const spawned = new Map(), onSpawn = (e) => { if (e && e.name === 'item') spawned.set(String(e.id), Date.now()); };
        bot.on('entitySpawn', onSpawn);
        const sent = {}, c0 = SUP.carried(bot), a0 = SUP.carried(asker);
        // no more than the asker's pack takes now: a stack that does not fit lies where it lands (b081u4, native, 1.21.1: Bd4c asked for 100 smooth stone with three
        // slots free, got the sticky pistons, glass and trapdoors, and two stacks of smooth stone lay until they despawned)
        const fits = room(asker, r.items);
        for (const [it, n0] of Object.entries(r.items)) {
            const sp = this.spare(name, it), n = Math.min(n0, sp, fits[it] || 0);
            if (n <= 0) continue;
            try { const k = await throwOut(bot, it, n, sp); if (k > 0) sent[it] = k; } catch (err) { this.job.log(`pool: ${name} could not throw ${n} ${it}: ${err.message}`); }
        }
        if (!Object.keys(sent).length) { bot.removeListener('entitySpawn', onSpawn); this.close(r, 'failed', 'nothing left to spare'); return false; }
        await sleep(150);
        { const c1 = SUP.carried(bot), off = Object.keys(sent).filter((it) => (c0[it] || 0) - (c1[it] || 0) <= 0); if (off.length) this.job.log(`pool: ${name}'s toss of ${off.join(', ')} left its pack unchanged`); }
        r.state = 'tossed'; r.sent = sent; r.tossAt = Date.now(); r.tossFrom = p.clone();
        // standing still until the asker has it: the server gives a thrown stack to whoever touches it after two seconds, and a giver that walked on (between the moves of its
        // route) crossed its own toss and took it back (live 2026-11-25 hb7)
        const first = Object.keys(sent)[0];
        try {
            for (let i = 0; i < 18 && (SUP.carried(asker)[first] || 0) <= (a0[first] || 0); i++) await sleep(200);
            await sleep(400);
            // the asker did not get it within a few seconds: the giver takes its throw back (walks onto each stack of it that still lies about), so nothing of it is left on
            // the ground to despawn (b081q4: 6 of 116 hand-overs left their toss lying, nobody picked it up); the request fails and the asker may ask again or go to the chest
            if ((SUP.carried(asker)[first] || 0) <= (a0[first] || 0)) {
                // (its toss's stacks: the ones it saw spawn, and the ones the crew's item watch put down to its toss (b081u4: 'took 0 back' with two stacks lying beside it))
                const W = this.job.itemWatch, mv = this.movers && this.movers.get(name), mine = () => {
                    const out = new Map();
                    for (const e of Object.values(bot.entities)) if (e.name === 'item' && spawned.has(String(e.id)) && e.position.distanceTo(p) < 7) out.set(String(e.id), e);
                    if (W) for (const q of W.recs.values()) if (!q.fate && q.cause === 'toss' && q.by === name && q.at >= r.tossAt - 6000) { const e = bot.entities[q.id] || q.ent; if (e && e.position && e.position.distanceTo(bot.entity.position) < 10) out.set(q.id, e); }
                    return [...out.values()];
                };
                const c2 = SUP.carried(bot);
                for (let k = 0; k < 6 && mv && mine().length; k++) {
                    const e = mine().sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
                    const q = { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.2), z: Math.floor(e.position.z) };
                    try { await mv.goto(q, { goal: (x, y, z) => x === q.x && z === q.z && Math.abs(y - q.y) <= 1, maxNodes: 3000, tries: 1 }); } catch (_) { break; }
                    await sleep(600);
                }
                const c3 = SUP.carried(bot), back = Object.keys(sent).reduce((a, it) => a + Math.max(0, (c3[it] || 0) - (c2[it] || 0)), 0);
                this.stats.takenBack = (this.stats.takenBack || 0) + back;
                this.job.log(`pool: ${r.from} did not get ${name}'s toss: ${name} took ${back} back${mine().length ? `, ${mine().length} stacks still lying` : ''}`);
            }
        } finally { bot.removeListener('entitySpawn', onSpawn); }
        return true;
    }

    /** A giver asked for, waiting for its asker who is on the way and near (it does not walk off its cell meanwhile). At most `ms`. */
    async hold(name, cancel, ms = 15000) {
        let end = Date.now() + ms;
        for (;;) {
            const r = this.forGiver(name);
            if (!r || cancel.cancelled || Date.now() > end) return;
            const me = this.bots.get(name), asker = this.bots.get(r.from);
            if (!me || !me.entity || !asker || !asker.entity) return;
            // the asker found no way up to the giver (a giver at work on a pillar or a floor in the air has no cell two to three from it that the asker can reach: 26 of hb7's
            // requests failed so): the giver goes to the asker, who waits where it stands
            const mv = this.movers && this.movers.get(name);
            if (r.blocked && mv && !r.fetching) {
                r.fetching = true;
                const a = asker.entity.position, af = { x: Math.floor(a.x), y: Math.floor(a.y + 0.16), z: Math.floor(a.z) };
                this.job.log(`pool: ${name} goes to ${r.from}, who cannot get up to it`);
                const res = await mv.goto(af, { goal: near(af, mv.view()), cancel: { get cancelled() { return cancel.cancelled || r.state !== 'coming'; } }, maxNodes: 20000, tries: 3 });
                if (!res.ok) { this.close(r, 'failed', `neither could get to the other (${String(res.why).slice(0, 80)})`); return; }
                end = Date.now() + 10000;          // there: a moment to throw (a third bot beside the asker passes)
                continue;
            }
            if (!r.blocked && me.entity.position.distanceTo(asker.entity.position) > 14) return;          // still far: the giver works on, the asker catches up with it
            if (await this.serve(name)) return;
            await sleep(250);
        }
    }

    /**
     * The asker's side: ask the best colleague for `need`, walk up to it and pick the items up. `mv`: the asker's Mover. Returns { got: {item: n}, tried } (tried: false when
     * nobody could spare any of it or nobody could be reached; the caller goes to the chest).
     */
    async ask(name, mv, need, cancel, { log = this.job.log } = {}) {
        const bot = this.bots.get(name);
        if (!bot || !bot.entity || this.busy(name)) return { got: {}, tried: false };
        const offers = this.offers(name, need).slice(0, 3);
        let pick = null;
        for (const o of offers) {
            const g = this.bots.get(o.to).entity.position, gf = { x: Math.floor(g.x), y: Math.floor(g.y + 0.16), z: Math.floor(g.z) };
            const v = mv.view();
            if (near(gf, v)(feet(bot).x, feet(bot).y, feet(bot).z)) { pick = o; break; }
            if ((await mv.canReachGoal(near(gf, v), gf, { maxNodes: 6000, budgetMs: 600 })) !== null) { pick = o; break; }
        }
        if (!pick) return { got: {}, tried: false };
        const r = this.open(name, pick.to, pick.items), before = SUP.carried(bot), t0 = Date.now();
        // item entities lying about before the request are not the giver's toss; who picks the toss up is logged (the giver itself, a third bot, nobody)
        // the toss: item entities that appear when it is thrown, beside the giver (rubble lies about wherever the crew digs: the asker walked to that and others took the toss,
        // live 2026-11-25 hb4)
        const spawned = new Map(), takers = {};
        const onSpawn = (e) => { if (e && e.name === 'item') spawned.set(String(e.id), Date.now()); };
        const isToss = (e) => { const t = spawned.get(String(e.id)); return t !== undefined && r.tossAt && t >= r.tossAt - 1500 && t <= r.tossAt + 3000 && (!r.tossFrom || e.position.distanceTo(r.tossFrom) < 6); };
        const onCollect = (collector, collected) => { if (collected && collected.name === 'item' && isToss(collected) && collector) { const n = collector.username || collector.name || '?'; takers[n] = (takers[n] || 0) + 1; } };
        bot.on('entitySpawn', onSpawn); bot.on('playerCollect', onCollect);
        log(`pool: ${name} asks ${pick.to} for ${JSON.stringify(pick.items)} (${Math.round(pick.dist)} away)`);
        const got = () => { const now = SUP.carried(bot), o = {}; for (const it of Object.keys(r.items)) { const d = (now[it] || 0) - (before[it] || 0); if (d > 0) o[it] = d; } return o; };
        const full = () => Object.entries(r.items).every(([it, n]) => (got()[it] || 0) >= Math.min(n, (r.sent || {})[it] ?? n));
        try {
            // up to the giver (it may move between its stances: followed until the request's time is up; at four tries the asker gave up while the giver was on a pillar, hb4)
            for (let k = 0; k < 10 && r.state === 'coming' && !cancel.cancelled && Date.now() - t0 < TTL - 10000; k++) {
                const giver = this.bots.get(r.to);
                if (!giver || !giver.entity) { this.close(r, 'failed', 'giver gone'); break; }
                const g = giver.entity.position, gf = { x: Math.floor(g.x), y: Math.floor(g.y + 0.16), z: Math.floor(g.z) }, f = feet(bot), v = mv.view();
                if (near(gf, v)(f.x, f.y, f.z)) { for (let i = 0; i < 40 && r.state === 'coming' && !cancel.cancelled; i++) await sleep(250); continue; }
                const res = await mv.goto(gf, { goal: near(gf, v), cancel: { get cancelled() { return cancel.cancelled || r.state !== 'coming'; } }, maxNodes: 15000, tries: 2 });
                if (!res.ok && r.state === 'coming') {
                    log(`pool: ${name} on the way to ${r.to}: ${String(res.why).slice(0, 100)}; it waits for ${r.to} to come`);
                    // no way up to the giver: it comes to the asker (hold), the asker stays where it is until the toss or the request's time is up
                    r.blocked = true;
                    while (r.state === 'coming' && !cancel.cancelled && Date.now() - t0 < TTL) await sleep(250);
                    break;
                }
            }
            if (r.state === 'coming') { this.close(r, 'failed', cancel.cancelled ? 'cancelled' : 'did not meet'); return { got: {}, tried: true }; }
            if (r.state !== 'tossed') return { got: got(), tried: true };
            // the pickup: the server gives the items after two seconds to the nearest body; the asker stands on them by then (it walks onto each stack as it lands)
            for (let i = 0; i < 3 && !full(); i++) await sleep(250);
            for (let k = 0; k < 4 && !full() && !cancel.cancelled; k++) {
                const lying = Object.values(bot.entities).filter((e) => e.name === 'item' && isToss(e) && e.position.distanceTo(bot.entity.position) < 6).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
                if (!lying) break;
                const c = { x: Math.floor(lying.position.x), y: Math.floor(lying.position.y + 0.2), z: Math.floor(lying.position.z) }, f = feet(bot);
                if (f.x === c.x && f.z === c.z) { for (let i = 0; i < 12 && !full(); i++) await sleep(200); continue; }
                await mv.goto(c, { goal: (x, y, z) => Math.abs(x - c.x) <= 0 && Math.abs(z - c.z) <= 0 && Math.abs(y - c.y) <= 1, cancel, maxNodes: 3000, tries: 1 });
                for (let i = 0; i < 6 && !full(); i++) await sleep(200);
            }
            // the pack's count can come a moment after the pickup (10 of hc1's 32 failed hand-overs had the asker among the takers): looked at again for three seconds
            for (let i = 0; i < 15 && !Object.keys(got()).length; i++) await sleep(200);
            r.got = got();
            const who = Object.keys(takers).length ? `; picked up by ${JSON.stringify(takers)}` : '', left = Object.values(bot.entities).filter((e) => e.name === 'item' && isToss(e) && e.position.distanceTo(bot.entity.position) < 8).length;
            this.close(r, Object.keys(r.got).length ? 'done' : 'failed', Object.keys(r.got).length ? '' : `nothing picked up${who}${left ? `, ${left} item entities lying near` : ''}`);
            return { got: r.got, tried: true };
        } finally { bot.removeListener('entitySpawn', onSpawn); bot.removeListener('playerCollect', onCollect); if (r.state === 'coming' || r.state === 'tossed') this.close(r, 'failed', 'ended'); }
    }

    status() { return { ...this.stats, open: this.reqs.size }; }
}

/**
 * Throw `n` of item `it` (at most `spare`): whole stacks, each one item entity that lands at the asker's feet; a part of a stack goes item by item (one entity per item, spread
 * over the ground: 26 obsidian thrown that way were picked up by four bots, live 2026-11-25 hb2 w1), so only for up to 16 and only when no whole stack fits. Returns the count.
 */
async function throwOut(bot, it, n, spare) {
    let sent = 0;
    const stacks = bot.inventory.items().filter((i) => i.name === it).sort((a, b) => b.count - a.count);
    for (const st of stacks) {
        if (sent >= n) break;
        if (st.count > spare - sent) continue;
        await bot.tossStack(st); sent += st.count; await sleep(100);
    }
    if (sent < Math.min(n, 16)) {
        const k = Math.min(n - sent, 16), reg = bot.registry.itemsByName[it];
        if (reg && k > 0) { await bot.toss(reg.id, null, k); sent += k; }
    }
    return sent;
}

/** How many of each item fit into `bot`'s pack now, in the order given: its partial stacks topped up, then free slots (one kept free for what it digs). */
function room(bot, items) {
    let free = Math.max(0, SUP.freeSlots(bot) - 1); const out = {};
    for (const [it, n] of Object.entries(items)) {
        const st = SUP.stackOf(bot, it); let k = 0;
        for (const s of bot.inventory.items()) if (s.name === it && s.count < st) k += st - s.count;
        k = Math.min(n, k);
        while (k < n && free > 0) { k = Math.min(n, k + st); free--; }
        if (k > 0) out[it] = k;
    }
    return out;
}

/**
 * A cell for the asker: two to three cells from the giver (horizontally), at about its height, nothing between them at the height the toss flies (the cell half way, at the
 * giver's feet and head): the toss lands there.
 */
function near(gf, view = null) {
    return (x, y, z) => {
        const d = Math.hypot(x - gf.x, z - gf.z);
        if (d < 2 || d > 3.1 || Math.abs(y - gf.y) > 1) return false;
        if (!view) return true;
        const mx = Math.round((x + gf.x) / 2), mz = Math.round((z + gf.z) / 2);
        return view.free(mx, gf.y, mz) && view.free(mx, gf.y + 1, mz);
    };
}

module.exports = { room, Pool, near, REACH, TTL };

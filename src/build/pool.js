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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEAR = { xz: 12, y: 8 };                  // the cells whose items a bot keeps for itself
// the giver throws when the asker's feet are this close to its own: a toss aimed at the feet lands about a cell ahead (at 2.3-3.2 the items fell between the two and nobody
// picked them up, live 2026-11-25 hb1 w4)
const REACH = 2.2;
const TTL = 90000;                              // a request not served in this time is dropped (the asker goes to the chest)
const MAX_DIST = 48;                            // no colleague further than this is asked (the walk is longer than a trip)

class Pool {
    constructor(job) { this.job = job; this.bots = new Map(); this.reqs = new Map(); this.seq = 0; this.cache = new Map(); this.stats = { asked: 0, served: 0, items: 0, failed: 0, ms: 0 }; }
    join(name, bot) { this.bots.set(name, bot); }
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
        if (Math.hypot(q.x - p.x, q.z - p.z) > REACH || Math.abs(q.y - p.y) > 1.5) return false;
        // a third bot beside the asker picks the toss up as soon as the asker (items lay among the crew and eight bots took a share, live 2026-11-25 hb3): the giver waits a
        // few seconds for it to pass
        r.readyAt = r.readyAt || Date.now();
        if (Date.now() - r.readyAt < 8000) for (const [n, o] of this.bots) { if (n === name || n === r.from || !o.entity) continue; const w = o.entity.position; if (Math.hypot(w.x - q.x, w.z - q.z) < 1.8 && Math.abs(w.y - q.y) < 2) return false; }
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false);
        const e = p.offset(0, bot.entity.eyeHeight || 1.62, 0), t = q.offset(0, 0.2, 0);
        try { await bot.look(Math.atan2(-(t.x - e.x), -(t.z - e.z)), Math.atan2(t.y - e.y, Math.hypot(t.x - e.x, t.z - e.z)), true); await sleep(120); } catch (_) { /* the look is a nicety */ }
        const sent = {}, c0 = SUP.carried(bot);
        for (const [it, n0] of Object.entries(r.items)) {
            const sp = this.spare(name, it), n = Math.min(n0, sp);
            if (n <= 0) continue;
            try { const k = await throwOut(bot, it, n, sp); if (k > 0) sent[it] = k; } catch (err) { this.job.log(`pool: ${name} could not throw ${n} ${it}: ${err.message}`); }
        }
        if (!Object.keys(sent).length) { this.close(r, 'failed', 'nothing left to spare'); return false; }
        await sleep(150);
        { const c1 = SUP.carried(bot), off = Object.keys(sent).filter((it) => (c0[it] || 0) - (c1[it] || 0) <= 0); if (off.length) this.job.log(`pool: ${name}'s toss of ${off.join(', ')} left its pack unchanged`); }
        r.state = 'tossed'; r.sent = sent; r.tossAt = Date.now();
        return true;
    }

    /** A giver asked for, waiting for its asker who is on the way and near (it does not walk off its cell meanwhile). At most `ms`. */
    async hold(name, cancel, ms = 15000) {
        const end = Date.now() + ms;
        for (;;) {
            const r = this.forGiver(name);
            if (!r || cancel.cancelled || Date.now() > end) return;
            const me = this.bots.get(name), asker = this.bots.get(r.from);
            if (!me || !me.entity || !asker || !asker.entity) return;
            if (me.entity.position.distanceTo(asker.entity.position) > 14) return;          // still far: the giver works on, the asker catches up with it
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
            if (near(gf)(feet(bot).x, feet(bot).y, feet(bot).z)) { pick = o; break; }
            if ((await mv.canReachGoal(near(gf), gf, { maxNodes: 6000, budgetMs: 600 })) !== null) { pick = o; break; }
        }
        if (!pick) return { got: {}, tried: false };
        const r = this.open(name, pick.to, pick.items), before = SUP.carried(bot), t0 = Date.now();
        // item entities lying about before the request are not the giver's toss; who picks the toss up is logged (the giver itself, a third bot, nobody)
        // the toss: item entities that appear when it is thrown, beside the giver (rubble lies about wherever the crew digs: the asker walked to that and others took the toss,
        // live 2026-11-25 hb4)
        const spawned = new Map(), takers = {};
        const onSpawn = (e) => { if (e && e.name === 'item') spawned.set(String(e.id), Date.now()); };
        const isToss = (e) => { const t = spawned.get(String(e.id)), g = this.bots.get(r.to); return t !== undefined && r.tossAt && t >= r.tossAt - 1500 && t <= r.tossAt + 3000 && (!g || !g.entity || e.position.distanceTo(g.entity.position) < 5); };
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
                const g = giver.entity.position, gf = { x: Math.floor(g.x), y: Math.floor(g.y + 0.16), z: Math.floor(g.z) }, f = feet(bot);
                if (near(gf)(f.x, f.y, f.z)) { for (let i = 0; i < 40 && r.state === 'coming' && !cancel.cancelled; i++) await sleep(250); continue; }
                const res = await mv.goto(gf, { goal: near(gf), cancel: { get cancelled() { return cancel.cancelled || r.state !== 'coming'; } }, maxNodes: 15000, tries: 2 });
                if (!res.ok && r.state === 'coming') log(`pool: ${name} on the way to ${r.to}: ${String(res.why).slice(0, 100)}`);
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

/** A cell for the asker: beside the giver (the eight around it, not its own column), at about its height. */
function near(gf) { return (x, y, z) => Math.hypot(x - gf.x, z - gf.z) <= 1.5 && Math.abs(y - gf.y) <= 1 && !(x === gf.x && z === gf.z); }

module.exports = { Pool, near, REACH, TTL };

'use strict';
// The crew's item entities on the site: every dropped stack that appears near the build, why it appeared and where it went (TASK-20261125-081, orchestrator 2026-11-27: the
// supply stays at the blueprint's count + 5 %, so every item missing at the end needs a named place; b081q5 lost 23 of 81 repeaters with no death).
// On the test worlds a block a player breaks goes straight into the breaker's pack (simple-autopickup), so an item entity on the site is one of a few things, told apart at
// its spawn by what the crew did in the moment before:
//   toss      a bot threw it (the pool's hand-over when the bot is a giver of an open request, else rubble or a full pack's spill)
//   dig       a bot dug the cell it lies in and the drop did not go into the pack (a full pack)
//   death     a dead bot's pack
//   popped    a block of the site turned into air without a dig of the crew (lost its support, washed away by water, moved by a piston): the block and what changed beside it
//   unknown   none of these
// Its end: picked up (by whom), despawned (gone after about five minutes on the ground) or gone early (merged into a stack beside it, burnt, out of every bot's sight).
// One registry per job, fed by every bot of the crew (they see the same entity ids). ground(item) and despawned(item) feed the material ledger (drive.js materials).
const DESPAWN_MS = 280000;          // an item entity lives 6000 ticks (five minutes) on the ground; gone after this long without a pickup it despawned
const MARGIN = 24;                  // around the box: the foot of a fall, the chest beside the site
const key = (x, y, z) => `${x},${y},${z}`;

class ItemWatch {
    constructor(job, { now = () => Date.now(), log = null } = {}) {
        this.job = job; this.now = now; this.log = log || ((m) => job.log && job.log(m));
        this.recs = new Map();          // entity id -> { id, at, pos, item, count, cause, by, detail, seers: Set, fate, fateBy }
        this.tosses = [];               // { by, at, x, y, z, why }
        this.digs = new Map();          // cell key -> { by, at, free }
        this.gone = new Map();          // cell key -> { old, at }: a block of the box that turned into air
        this.byItem = new Map();        // item -> { spawned: {cause: n}, picked: {crew: n, other: n}, despawned: n, early: n }
        this.logged = 0;
    }

    near(p) { const b = this.job.t && this.job.t.box; if (!b || !p) return true; return p.x >= b.x - MARGIN && p.x <= b.x + b.sx + MARGIN && p.z >= b.z - MARGIN && p.z <= b.z + b.sz + MARGIN && p.y >= b.y - MARGIN - 40 && p.y <= b.y + b.sy + MARGIN; }
    _it(item) { let r = this.byItem.get(item); if (!r) { r = { spawned: {}, picked: { crew: 0, other: 0 }, despawned: 0, early: 0 }; this.byItem.set(item, r); } return r; }

    /** A bot threw something (bot.toss / tossStack): `why` hand-over or drop. */
    tossed(by, pos, why) { const t = this.now(); this.tosses.push({ by, at: t, x: pos.x, y: pos.y, z: pos.z, why }); while (this.tosses.length && t - this.tosses[0].at > 10000) this.tosses.shift(); }
    /** A bot of the crew digs cell c with `free` empty slots in its pack. */
    dug(by, c, free) { this.digs.set(key(c.x, c.y, c.z), { by, at: this.now(), free }); if (this.digs.size > 4000) { const t = this.now(); for (const [k, d] of this.digs) if (t - d.at > 10000) this.digs.delete(k); } }
    /** A block update: a cell of the box that had a block and has none now. */
    block(c, oldName, newName) {
        if (!c || !oldName || oldName === newName) return;
        if (!/air$/.test(newName || '') && newName !== 'water' && newName !== 'moving_piston') return;
        if (/air$/.test(oldName)) return;
        this.gone.set(key(c.x, c.y, c.z), { old: oldName, now: newName, at: this.now() });
        if (this.gone.size > 4000) { const t = this.now(); for (const [k, g] of this.gone) if (t - g.at > 10000) this.gone.delete(k); }
    }

    /** Why an item entity that appeared at p at time t is there (see the head of the file). */
    cause(p, t = this.now()) {
        const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
        for (const d of this.job.drops || []) if (Math.abs(t - d.at) < 3000 && Math.hypot(d.x - f.x, d.z - f.z) <= 3 && Math.abs(d.y - f.y) <= 3) return { cause: 'death', by: d.by };
        let toss = null;
        for (const s of this.tosses) { if (t - s.at > 2500 || t < s.at - 500) continue; const dd = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z); if (dd < 4 && (!toss || dd < toss.d)) toss = { ...s, d: dd }; }
        if (toss) return { cause: 'toss', by: toss.by, detail: toss.why };
        // the cell it lies in or the one under it (a drop spawns at the centre of the broken block and falls)
        for (let dy = 0; dy >= -2; dy--) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const k = key(f.x + dx, f.y + dy, f.z + dz), g = this.gone.get(k);
            if (!g || t - g.at > 1500) continue;
            const d = this.digs.get(k);
            if (d && t - d.at < 15000) return { cause: 'dig', by: d.by, detail: `${g.old} at ${k}, ${d.free} slots free` };
            // what changed beside it just before: its support or the block that held it
            const nb = [];
            for (const [ex, ey, ez] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
                const c = { x: f.x + dx + ex, y: f.y + dy + ey, z: f.z + dz + ez }, kk = key(c.x, c.y, c.z), gg = this.gone.get(kk);
                if (gg && t - gg.at < 3000) { const dd = this.digs.get(kk); nb.push(`${gg.old}->${gg.now} at ${kk}${dd && t - dd.at < 15000 ? ` dug by ${dd.by}` : ''}`); }
            }
            return { cause: 'popped', detail: `${g.old} at ${k}${g.now !== 'air' ? ` (now ${g.now})` : ''}; beside it ${nb.join(', ') || 'nothing changed'}` };
        }
        return { cause: 'unknown' };
    }

    /** An item entity a bot sees appear. */
    spawn(name, e) {
        if (!e || e.name !== 'item' || !e.position || !this.near(e.position)) return;
        const id = String(e.id); let r = this.recs.get(id);
        if (r) { r.seers.add(name); return; }
        const c = this.cause(e.position);
        r = { id, at: this.now(), pos: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }, item: null, count: 0, ...c, seers: new Set([name]), fate: null, ent: e };
        this.recs.set(id, r);
    }
    /** The stack's kind and count (the metadata comes after the spawn): read on every tick of `refresh`. */
    _resolve(r) {
        const e = r.ent; if (!e || !e.getDroppedItem) return;
        let it = null; try { it = e.getDroppedItem(); } catch (_) { it = null; }
        if (!it) return;
        const first = !r.item;
        r.item = it.name; r.count = it.count || 1;
        if (first) {
            const s = this._it(r.item); s.spawned[r.cause] = (s.spawned[r.cause] || 0) + r.count;
            const build = this.job.t && this.job.t.items && this.job.t.items.has(r.item);
            if (build && r.cause !== 'death' && this.logged < 300) { this.logged++; this.log(`[items] ${r.cause} ${r.count} ${r.item} at ${r.pos.x},${r.pos.y},${r.pos.z}${r.by ? ` by ${r.by}` : ''}${r.detail ? ` (${r.detail})` : ''}`); }
        }
    }
    refresh() { for (const r of this.recs.values()) if (!r.fate) this._resolve(r); }
    /** `collector` (a username or entity name) picked up entity id. */
    collect(id, collector, crew) {
        const r = this.recs.get(String(id)); if (!r || r.fate) return;
        this._resolve(r);
        r.fate = 'picked'; r.fateBy = collector;
        if (r.item) this._it(r.item).picked[crew ? 'crew' : 'other'] += r.count;
    }
    /** Bot `name` no longer sees entity id. */
    lost(name, id) {
        const r = this.recs.get(String(id)); if (!r || r.fate) return;
        r.seers.delete(name); if (r.seers.size) return;
        const age = this.now() - r.at;
        r.fate = age >= DESPAWN_MS ? 'despawned' : 'early';
        if (r.item) { const s = this._it(r.item); if (r.fate === 'despawned') s.despawned += r.count; else s.early += r.count; }
        if (r.fate === 'despawned' && r.item && this.job.t.items.has(r.item) && this.logged < 300) { this.logged++; this.log(`[items] despawned ${r.count} ${r.item} at ${r.pos.x},${r.pos.y},${r.pos.z} (${r.cause}${r.by ? ` by ${r.by}` : ''})`); }
        r.ent = null;
    }
    /** Items lying on the site now (stacks still seen by some bot), by item. */
    ground() { const o = {}; for (const r of this.recs.values()) if (!r.fate && r.item) o[r.item] = (o[r.item] || 0) + r.count; return o; }
    despawned() { const o = {}; for (const [it, s] of this.byItem) if (s.despawned) o[it] = s.despawned; return o; }
    /** Per item: what appeared on the ground by cause, what was picked up, what despawned. */
    summary(only = null) {
        const o = {};
        for (const [it, s] of this.byItem) { if (only && !only(it)) continue; o[it] = { ...s, ground: 0 }; }
        for (const [it, n] of Object.entries(this.ground())) if (o[it]) o[it].ground = n;
        return o;
    }

    /** Feed the watch from one bot: its entity events, block updates, digs and tosses. Returns a detach function. */
    attach(name, bot, { crew = () => false, giver = () => false, free = () => 99 } = {}) {
        const onSpawn = (e) => { try { this.spawn(name, e); } catch (_) { /* never breaks the drive */ } };
        const onGone = (e) => { try { if (e && e.name === 'item') this.lost(name, e.id); } catch (_) { /* idem */ } };
        const onCollect = (who, e) => { try { if (e && e.name === 'item') { const n = who && (who.username || who.name); this.collect(e.id, n || '?', !!n && crew(n)); } } catch (_) { /* idem */ } };
        const onBlock = (o, n) => { try { if (n && n.position && this.job.t.inside(n.position.x, n.position.y, n.position.z)) this.block(n.position, o && o.name, n.name); } catch (_) { /* idem */ } };
        bot.on('entitySpawn', onSpawn); bot.on('entityGone', onGone); bot.on('playerCollect', onCollect); bot.on('blockUpdate', onBlock);
        const dig0 = bot.dig, toss0 = bot.toss, tossStack0 = bot.tossStack;
        if (typeof dig0 === 'function') bot.dig = (b, ...a) => { try { if (b && b.position) this.dug(name, b.position, free()); } catch (_) { /* idem */ } return dig0.call(bot, b, ...a); };
        const pos = () => bot.entity && bot.entity.position ? bot.entity.position.offset(0, 1.3, 0) : null;
        if (typeof toss0 === 'function') bot.toss = (...a) => { try { const p = pos(); if (p) this.tossed(name, p, giver(name) ? 'hand-over' : 'drop'); } catch (_) { /* idem */ } return toss0.apply(bot, a); };
        if (typeof tossStack0 === 'function') bot.tossStack = (...a) => { try { const p = pos(); if (p) this.tossed(name, p, giver(name) ? 'hand-over' : 'drop'); } catch (_) { /* idem */ } return tossStack0.apply(bot, a); };
        return () => {
            bot.removeListener('entitySpawn', onSpawn); bot.removeListener('entityGone', onGone); bot.removeListener('playerCollect', onCollect); bot.removeListener('blockUpdate', onBlock);
            if (typeof dig0 === 'function') bot.dig = dig0; if (typeof toss0 === 'function') bot.toss = toss0; if (typeof tossStack0 === 'function') bot.tossStack = tossStack0;
        };
    }
}

module.exports = { ItemWatch, DESPAWN_MS };

'use strict';
// Stuck snapshots (owner 2026-11-27, TASK-20261127-084): when a log line says a bot is stuck, three pictures around it (scene.js, render.js) and the facts of the moment are
// written to <root>/<run>/<event>/ (top.png, along.png, across.png, event.json) and listed per cause in <root>/<run>/index.json, for the console's Stuck page.
//
// Fed by WorkService.note (one line there): every log line of the service and its jobs passes `observe`, which only matches a few patterns; the capture runs on the next turn
// of the event loop, the server's truth (RCON), the drawing and the PNG compression later, one event at a time, never on a bot's tick. At most one event per bot per
// `perBotMs`, at most `max` per run, at most `queue` waiting.
//
// Environment: STUCK_SNAPSHOTS 1 | 0 (default: on when /out exists, i.e. in a harness container), STUCK_DIR (default /out/stuck, else <data>/stuck), RUN (the run's name),
// STUCK_MAX (default 40), STUCK_ASSETS (the texture cache root; default WORK_ASSETS, /mc-assets, /out/mc-assets, /mnt/data/forgeaip/mc-assets).
const fs = require('fs');
const path = require('path');
const S = require('./scene');
const { picture } = require('./render');
const { encodeAsync } = require('./png');
const { Textures } = require('./textures');

const CAUSES = [
    ['guard', /\(repeated guard holds\)/],
    ['stall', /\[stall\] /],
    ['no_stance', /no way to the stance/],
    ['move_no_start', /\[move\] [A-Za-z0-9_]{1,16}: no start at/],
    ['no_progress', /\bno progress\b/],
    ['evacuate', /: evacuated from /],
    ['death', /\bdied\b/],
];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;            // a run's folder name (the console's route accepts exactly these)
const VIEWS = ['top', 'along', 'across'];
const GUARD_TICKS = 100;          // fall-guard stops (ticks held back) between two checks that count as a guard event: five seconds of a body held at an edge
const GUARD_CHECK_MS = 15000;

/** The cause of a log line, or null. */
function classify(msg) { for (const [c, re] of CAUSES) if (re.test(msg)) return c; return null; }

/** The bot a line is about: the longest of `names` that stands in it as a word. */
function botOf(msg, names) {
    let best = null;
    for (const n of names) { if (best && n.length <= best.length) continue; const i = msg.indexOf(n); if (i < 0) continue; const a = msg[i - 1], b = msg[i + n.length]; if ((!a || !/[A-Za-z0-9_]/.test(a)) && (!b || !/[A-Za-z0-9_]/.test(b))) best = n; }
    return best;
}

/** Positions the line itself gives: the bot's (stall, death, evacuation, a move's start) and a cell to mark (the stance it could not reach, where it died). */
function placesOf(cause, msg) {
    const num = '(-?\\d+(?:\\.\\d+)?)', m3 = (re) => { const m = re.exec(msg); return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null; };
    if (cause === 'stall') return { pos: m3(new RegExp(`no action for \\d+ s at ${num},${num},${num}`)) };
    if (cause === 'death') { const c = m3(new RegExp(`died at ${num},${num},${num}`)); return { cell: c, mark: c && { ...c, label: 'D' } }; }
    if (cause === 'evacuate') return { cell: m3(new RegExp(`evacuated from ${num} ${num} ${num}`)) };
    if (cause === 'move_no_start') { const c = m3(new RegExp(`no start at ${num},${num},${num}`)); return { cell: c, mark: c && { ...c, label: 'N' } }; }
    if (cause === 'no_stance') { const c = m3(new RegExp(`stance ${num},${num},${num}`)); return { mark: c && { ...c, label: 'S' } }; }
    return {};
}

/** The rate limit: one event per bot per `perBotMs`, `max` per run. Pure. */
class Limiter {
    constructor({ perBotMs = 120000, max = 40, now = Date.now } = {}) { this.perBotMs = perBotMs; this.max = max; this.now = now; this.last = new Map(); this.n = 0; this.refused = { bot: 0, cap: 0 }; }
    allow(bot) {
        const t = this.now(), l = this.last.get(bot);
        if (this.n >= this.max) { this.refused.cap++; return false; }
        if (l !== undefined && t - l < this.perBotMs) { this.refused.bot++; return false; }
        this.last.set(bot, t); this.n++; return true;
    }
}

const dayRun = () => `console-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const near = (p, c, r) => Math.abs(p.x - c.x) <= r + 1 && Math.abs(p.y - c.y) <= r + 1 && Math.abs(p.z - c.z) <= r + 1;
const dimOf = (bot) => { const d = String((bot.game && bot.game.dimension) || 'minecraft:overworld'); return d.includes(':') ? d : `minecraft:${d}`; };

class StuckWatch {
    /**
     * @param o { root, run, enabled, max, perBotMs, afterMs, queue, assets (texture cache root), now, write: false for tests (no files) }
     */
    constructor(o = {}) {
        this.o = { perBotMs: 120000, max: 40, afterMs: 5000, queue: 3, truthMs: 20000, ...o };
        { const r = String(this.o.run || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64); this.run = SAFE.test(r) ? r : dayRun(); }
        this.limit = new Limiter({ perBotMs: this.o.perBotMs, max: this.o.max, now: this.o.now || Date.now });
        this.pending = 0; this.dropped = 0; this.busy = Promise.resolve(); this.guardAt = 0; this.guardSeen = new Map(); this.textures = new Map(); this.events = [];
        this.seq = this._existing();
    }
    get dir() { return path.join(this.o.root, this.run); }
    _existing() { try { const ix = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); this.events = Array.isArray(ix.events) ? ix.events : []; return this.events.length; } catch (_) { return 0; } }

    /** A log entry ({ t, level, msg }) of `service`. Cheap: a few regex tests; the work is scheduled. */
    observe(service, e) {
        const msg = String(e && e.msg || '');
        let cause = classify(msg);
        if (!cause) { this._guards(service); return null; }
        const name = botOf(msg, [...service.bots.keys()]);
        if (!name || !this.limit.allow(name)) return null;
        if (this.pending >= this.o.queue) { this.dropped++; return null; }
        this.pending++;
        const ev = { cause, bot: name, line: msg, t: e.t || Date.now(), places: placesOf(cause, msg) };
        setImmediate(() => { let snap = null; try { snap = this._capture(service, ev); } catch (err) { snap = null; ev.error = String(err && err.message || err); }
            this.busy = this.busy.then(() => this._finish(service, ev, snap)).catch(() => {}).finally(() => { this.pending--; }); });
        return ev;
    }
    /** Repeated fall-guard holds: checked at most every 15 s, on the back of the log lines (no timer of its own). */
    _guards(service) {
        const t = Date.now(); if (t - this.guardAt < GUARD_CHECK_MS) return; this.guardAt = t;
        for (const rec of service.bots.values()) {
            const g = rec.bot && rec.bot.__fallGuard; if (!g) continue;
            const was = this.guardSeen.get(rec.name); this.guardSeen.set(rec.name, g.stops);
            if (was === undefined || g.stops - was < GUARD_TICKS || !g.lastStop || t - g.lastStop.at > GUARD_CHECK_MS) continue;
            this.observe(service, { t, msg: `[stuck] ${rec.name}: the fall guard held it back ${g.stops - was} ticks in ${Math.round(GUARD_CHECK_MS / 1000)} s, last at ${g.lastStop.x},${g.lastStop.y},${g.lastStop.z} (repeated guard holds)` });
        }
    }
    /** The facts of the moment, read at once (synchronous, on the turn after the log line). */
    _capture(service, ev) {
        const rec = service.bots.get(ev.bot), bot = rec && rec.bot;
        if (!bot || !bot.entity || typeof bot.blockAt !== 'function') { ev.error = 'the bot has no world (offline)'; return null; }
        const Vec3 = require('vec3').Vec3, e = bot.entity, now = Date.now(), pl = ev.places;
        const pos = pl.pos || (pl.cell && ev.cause === 'death' ? { x: pl.cell.x + 0.5, y: pl.cell.y, z: pl.cell.z + 0.5 } : { x: e.position.x, y: e.position.y, z: e.position.z });
        const c = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-3), z: Math.floor(pos.z) }, R = S.R;
        const temps = [];
        try { for (const t of service.temps.list()) if (near(t, c, R)) temps.push({ x: t.x, y: t.y, z: t.z, by: t.by, kind: t.kind }); } catch (_) { /* none */ }
        for (const j of service.jobs.values()) { const L = j.impl && j.impl.build && j.impl.build.ledger; if (!L || typeof L.list !== 'function') continue; for (const t of L.list()) if (near(t, c, R)) temps.push({ x: t.x, y: t.y, z: t.z, by: t.by, kind: t.how, state: t.state, job: j.id }); }
        const others = [];
        for (const o of service.bots.values()) { if (o.name === ev.bot || !o.bot || !o.bot.entity) continue; const p = o.bot.entity.position; if (near(p, c, R)) others.push({ name: o.name, x: p.x, y: p.y, z: p.z }); }
        const g = bot.__fallGuard, last = g && g.episodes && g.episodes[g.episodes.length - 1];
        const guard = g && g.lastStop && now - g.lastStop.at < 120000 ? { ...g.lastStop, ago: now - g.lastStop.at, stops: g.stops, ...(last ? { from: last.from, to: last.to, n: last.n, under: last.under, tag: last.tag } : {}) } : null;
        const route = rec.path && now - rec.path.at < 180000 ? rec.path.cells : [];
        const sc = S.capture((x, y, z) => bot.blockAt(new Vec3(x, y, z), false), pos, e.yaw, { path: route, temps, others, guard, mark: pl.mark || null, sneak: !!(bot.controlState && bot.controlState.sneak) });
        const facts = {
            pos, cell: c, yaw: e.yaw, pitch: e.pitch, onGround: !!e.onGround, health: bot.health, food: bot.food, dim: dimOf(bot), version: bot.version || null,
            controls: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].filter((k) => bot.controlState && bot.controlState[k]),
            phase: rec.phase || null, moveTag: bot.__moveTag || null, job: rec.job || null,
            guard: g ? { stops: g.stops, lastStop: g.lastStop, episodes: (g.episodes || []).slice(-4) } : null, route, temps, others,
            before: (service.log || []).filter((l) => l.t >= ev.t - 180000 && l.t <= ev.t && String(l.msg).includes(ev.bot)).slice(-30).map((l) => `${new Date(l.t).toISOString().slice(11, 19)} ${l.level} ${l.msg}`),
        };
        return { sc, facts, version: bot.version, rcon: service.o && service.o.rcon && typeof service.rcon === 'function' ? (cmd) => service.rcon(cmd) : null };
    }
    _textures(version) {
        const v = String(version || ''); if (this.textures.has(v)) return this.textures.get(v);
        const roots = [this.o.assets, process.env.STUCK_ASSETS, process.env.WORK_ASSETS, '/mc-assets', '/out/mc-assets', '/mnt/data/forgeaip/mc-assets'].filter(Boolean);
        const dir = /^\d{1,2}\.\d{1,3}(\.\d{1,3})?$/.test(v) ? roots.map((r) => path.join(r, v)).find((d) => fs.existsSync(path.join(d, 'models'))) : null;
        const t = new Textures(dir || null); this.textures.set(v, t); return t;
    }
    /** After the capture: the lines that followed, the server's truth, the pictures, the files. One event at a time. */
    async _finish(service, ev, snap) {
        const id = `${String(++this.seq).padStart(3, '0')}-${ev.cause}-${ev.bot}`, dir = path.join(this.dir, id);
        await new Promise((r) => { const tm = setTimeout(r, this.o.afterMs); if (tm.unref) tm.unref(); });
        const after = (service.log || []).filter((l) => l.t > ev.t && String(l.msg).includes(ev.bot)).slice(0, 20).map((l) => `${new Date(l.t).toISOString().slice(11, 19)} ${l.level} ${l.msg}`);
        const out = { id, run: this.run, bot: ev.bot, cause: ev.cause, t: ev.t, time: new Date(ev.t).toISOString(), line: ev.line, error: ev.error || null, ...(snap ? snap.facts : {}), after, images: [] };
        const t0 = Date.now();
        if (snap) {
            if (snap.rcon) { try { await S.truth(snap.sc, snap.rcon, { budgetMs: this.o.truthMs, dim: snap.facts.dim }); out.server = { checked: snap.sc.checked, unchecked: snap.sc.unchecked, diff: snap.sc.diff }; } catch (err) { out.server = { error: String(err && err.message || err) }; } }
            else out.server = { error: 'no RCON: the bot view only' };
            const tex = this._textures(snap.version);
            out.textures = tex.dir ? path.basename(tex.dir) : 'none (flat colours)';
            fs.mkdirSync(dir, { recursive: true });
            for (const w of VIEWS) {
                await new Promise((r) => setImmediate(r));                    // the bots' ticks run between the pictures
                const r = picture(snap.sc, w, tex);
                fs.writeFileSync(path.join(dir, `${w}.png`), await encodeAsync(r.w, r.h, r.data));
                out.images.push(`${w}.png`);
            }
            out.scene = { r: snap.sc.r, c: snap.sc.c, dir: snap.sc.dir, usualDepth: snap.sc.usualDepth || null };
        } else fs.mkdirSync(dir, { recursive: true });
        out.renderMs = Date.now() - t0;
        fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify(out, null, 1));
        this.events.push({ id, bot: ev.bot, cause: ev.cause, t: ev.t, pos: out.pos || null, line: ev.line.slice(0, 300), images: out.images.length, diff: out.server && out.server.diff ? Object.keys(out.server.diff).length : null });
        this._index();
        if (typeof service.note === 'function') service.note('debug', `[stuck] ${ev.bot} ${ev.cause}: snapshot ${this.run}/${id}`);
        return out;
    }
    _index() {
        const byCause = {}; for (const e of this.events) (byCause[e.cause] = byCause[e.cause] || []).push(e.id);
        const f = path.join(this.dir, 'index.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify({ run: this.run, updated: new Date().toISOString(), events: this.events, byCause, refused: this.limit.refused, dropped: this.dropped })); fs.renameSync(f + '.tmp', f);
    }
}

const watches = new WeakMap();
function enabled(env = process.env) { return env.STUCK_SNAPSHOTS === '1' || (env.STUCK_SNAPSHOTS !== '0' && fs.existsSync('/out')); }
/** The hook (WorkService.note): one watcher per service, made on its first line. Never throws. */
function observe(service, e) {
    try {
        if (!service || !service.bots) return null;
        let w = watches.get(service);
        if (w === undefined) {
            const env = process.env;
            w = enabled(env) ? new StuckWatch({ root: env.STUCK_DIR || (fs.existsSync('/out') ? '/out/stuck' : path.join((service.o && service.o.dataDir) || '.', 'stuck')), run: env.RUN, max: Number(env.STUCK_MAX) || 40 }) : null;
            watches.set(service, w);
        }
        return w ? w.observe(service, e) : null;
    } catch (_) { return null; }
}

module.exports = { observe, StuckWatch, Limiter, classify, botOf, placesOf, enabled, SAFE, VIEWS };

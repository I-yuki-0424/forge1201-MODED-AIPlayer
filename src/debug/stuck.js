'use strict';
// Snapshots of what the bots are doing (owner 2026-11-27, TASK-20261127-084), for the console's Snapshots page and the Nextcloud folder:
//   stuck events      a log line says a bot is stuck (stall, no way to the stance, no progress, no start, evacuation, death, repeated fall-guard holds): three pictures around it
//                     (scene.js, render.js: top, along, across; its own world beside the server's truth) and the facts of the moment
//   slow phenomena    not errors but time lost, read from the builders' pause records (build/pauses.js `open`): a plan or claim that keeps the thread for long (slow_plan), a bot
//                     that keeps trying again after a failure (retry), a long wait for another bot or the server (long_wait): the same three pictures
//   progress          every 10 min per running build: its box from above and from the side, done / left / parked / claimed, the bots (render.js progressPicture)
// Files: <root>/<run>/<event>/ (*.png, event.json), <root>/<run>/index.json (the events by kind), <root>/status.json (bytes used, the budget, what was pruned).
//
// Cost: `observe` (WorkService.note, one line there) only matches a few patterns; a 10 s timer (unref'd) reads the pause records and the builds; the capture runs on the next
// turn of the event loop, the server's truth (RCON, sequential), the drawing (one picture per turn) and the PNG compression (thread pool) after it, one event at a time, never
// on a bot's tick. Each kind has its own limit (one per bot or build per interval, a cap per run); at most `queue` waiting. A byte budget for the whole folder (default 2 GB):
// the oldest events go first. Pictures are indexed PNGs (256 colours).
//
// Environment: STUCK_SNAPSHOTS=1 / 0 turns it on / off (default: on in a harness container, i.e. where /out exists), STUCK_DIR (default /out/stuck, else <data>/stuck), RUN (the run's name),
// STUCK_BUDGET_MB (default 2048), STUCK_MAX (scales every kind's cap, default 1), STUCK_PROGRESS_MIN (default 10), STUCK_ASSETS (the texture cache root; default WORK_ASSETS,
// /mc-assets, /out/mc-assets, /mnt/data/forgeaip/mc-assets).
const fs = require('fs');
const path = require('path');
const S = require('./scene');
const { picture, progressPicture } = require('./render');
const { encodeIndexedAsync } = require('./png');
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
// per kind: one event per key (bot, build) per `every` ms, at most `max` per run
const LIMITS = {
    stall: { every: 120000, max: 40 }, no_stance: { every: 120000, max: 40 }, move_no_start: { every: 120000, max: 30 }, no_progress: { every: 120000, max: 30 },
    evacuate: { every: 120000, max: 30 }, death: { every: 60000, max: 40 }, guard: { every: 300000, max: 20 },
    slow_plan: { every: 300000, max: 20 }, retry: { every: 300000, max: 20 }, long_wait: { every: 300000, max: 20 }, progress: { every: 600000, max: 150 },
};
const KINDS = Object.keys(LIMITS);
// the pause records: how long a bot has gone without an action, and in what
const SLOW = [['slow_plan', 15000, (top) => /^cpu/.test(top)], ['retry', 20000, (top, o) => /^retry/.test(top) || !!o.fail], ['long_wait', 30000, (top) => /^(wait|server|other)/.test(top)]];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;            // a run's folder name (the console's route accepts exactly these)
const VIEWS = ['top', 'along', 'across'];
const GUARD_TICKS = 100;          // fall-guard stops (ticks held back) between two polls that count as a guard event: five seconds of a body held at an edge
const POLL_MS = 10000;

/** The kind of a log line, or null. */
function classify(msg) { for (const [c, re] of CAUSES) if (re.test(msg)) return c; return null; }

/** The kind of a bot's open pause ({ ms, stack, sub, fail } from pauses.js `open`), or null. */
function slowOf(o) {
    if (!o) return null;
    const top = String(o.sub || o.stack[o.stack.length - 1] || '');
    for (const [kind, ms, test] of SLOW) if (o.ms >= ms && test(top, o)) return kind;
    return null;
}

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

/** The limits: per kind, one event per key per `every` ms and `max` per run. Pure. */
class Limiter {
    constructor({ limits = LIMITS, scale = 1, now = Date.now } = {}) { this.limits = limits; this.scale = scale; this.now = now; this.last = new Map(); this.n = {}; this.refused = {}; }
    allow(kind, key) {
        const L = this.limits[kind]; if (!L) return false;
        const t = this.now(), k = `${kind}|${key}`, l = this.last.get(k), refuse = (why) => { this.refused[`${kind}:${why}`] = (this.refused[`${kind}:${why}`] || 0) + 1; return false; };
        if ((this.n[kind] || 0) >= Math.max(1, Math.round(L.max * this.scale))) return refuse('cap');
        if (l !== undefined && t - l < L.every) return refuse('interval');
        this.last.set(k, t); this.n[kind] = (this.n[kind] || 0) + 1; return true;
    }
}

/** Bytes in a folder tree (files only, no symlinks followed). */
function du(dir) { let n = 0; try { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, d.name); if (d.isDirectory()) n += du(f); else if (d.isFile()) n += fs.statSync(f).size; } } catch (_) { /* gone */ } return n; }

/**
 * Keep the folder `root` within `budget` bytes: whole events, oldest first (by the time in their name's run index, else the folder's mtime), across all runs; a run's index
 * forgets its pruned events, an empty run folder goes. Returns { bytes, pruned }.
 */
function prune(root, budget) {
    const evs = []; let bytes = 0;
    let runs = []; try { runs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE.test(d.name)).map((d) => d.name); } catch (_) { return { bytes: 0, pruned: 0 }; }
    for (const run of runs) {
        const rd = path.join(root, run);
        for (const d of fs.readdirSync(rd, { withFileTypes: true })) {
            const f = path.join(rd, d.name);
            if (d.isDirectory()) { const b = du(f); bytes += b; evs.push({ run, id: d.name, dir: f, bytes: b, t: fs.statSync(f).mtimeMs }); } else if (d.isFile()) bytes += fs.statSync(f).size;
        }
    }
    let pruned = 0; const touched = new Set();
    evs.sort((a, b) => a.t - b.t);
    for (const e of evs) { if (bytes <= budget) break; fs.rmSync(e.dir, { recursive: true, force: true }); bytes -= e.bytes; pruned++; touched.add(e.run); }
    for (const run of touched) {
        const f = path.join(root, run, 'index.json');
        try {
            const ix = JSON.parse(fs.readFileSync(f, 'utf8')), have = new Set(fs.readdirSync(path.join(root, run)));
            ix.events = (ix.events || []).filter((e) => have.has(e.id)); ix.byKind = byKind(ix.events); ix.pruned = (ix.pruned || 0) + 1;
            if (!ix.events.length) fs.rmSync(path.join(root, run), { recursive: true, force: true }); else { fs.writeFileSync(f + '.tmp', JSON.stringify(ix)); fs.renameSync(f + '.tmp', f); }
        } catch (_) { /* no index: nothing to update */ }
    }
    return { bytes, pruned };
}
const byKind = (events) => { const o = {}; for (const e of events) (o[e.cause] = o[e.cause] || []).push(e.id); return o; };

const dayRun = () => `console-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const near = (p, c, r) => Math.abs(p.x - c.x) <= r + 1 && Math.abs(p.y - c.y) <= r + 1 && Math.abs(p.z - c.z) <= r + 1;
const dimOf = (bot) => { const d = String((bot.game && bot.game.dimension) || 'minecraft:overworld'); return d.includes(':') ? d : `minecraft:${d}`; };
const stamp = (t) => new Date(t).toISOString().slice(11, 19);

class StuckWatch {
    /**
     * @param o { root, run, budget (bytes), scale (of every kind's cap), progressMs, afterMs, queue, truthMs, assets (texture cache root), pauses (build/pauses.js or null), now }
     */
    constructor(o = {}) {
        this.o = { afterMs: 5000, queue: 3, truthMs: 20000, budget: 2048 * 1024 * 1024, scale: 1, progressMs: 600000, ...o };
        { const r = String(this.o.run || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64); this.run = SAFE.test(r) ? r : dayRun(); }
        const limits = { ...LIMITS, progress: { ...LIMITS.progress, every: this.o.progressMs } };
        this.limit = new Limiter({ limits, scale: this.o.scale, now: this.o.now || Date.now });
        this.pending = 0; this.dropped = 0; this.busy = Promise.resolve(); this.guardSeen = new Map(); this.textures = new Map(); this.events = []; this.timer = null;
        this.bytes = null; this.pruned = 0;
        this.seq = this._existing();
    }
    get dir() { return path.join(this.o.root, this.run); }
    _existing() { try { const ix = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); this.events = Array.isArray(ix.events) ? ix.events : []; return Math.max(0, ...this.events.map((e) => parseInt(e.id, 10) || 0)); } catch (_) { return 0; } }

    /** A log entry ({ t, level, msg }) of `service`. Cheap: a few regex tests; the work is scheduled. Starts the poll on the first call. */
    observe(service, e) {
        if (!this.timer) { this.timer = setInterval(() => { try { this.poll(service); } catch (_) { /* a report never breaks the service */ } }, POLL_MS); if (this.timer.unref) this.timer.unref(); }
        const msg = String(e && e.msg || ''), cause = classify(msg);
        if (!cause) return null;
        const name = botOf(msg, [...service.bots.keys()]);
        return name ? this._event(service, { cause, bot: name, key: name, line: msg, t: e.t || Date.now(), places: placesOf(cause, msg) }) : null;
    }
    _event(service, ev) {
        if (!this.limit.allow(ev.cause, ev.key)) return null;
        if (this.pending >= this.o.queue) { this.dropped++; return null; }
        this.pending++;
        setImmediate(() => {
            let snap = null; try { snap = ev.cause === 'progress' ? this._progress(service, ev) : this._capture(service, ev); } catch (err) { snap = null; ev.error = String(err && err.message || err); }
            this.busy = this.busy.then(() => this._finish(service, ev, snap)).catch((err) => { if (typeof service.note === 'function') service.note('debug', `[stuck] ${ev.cause} ${ev.key}: ${err && err.message}`); }).finally(() => { this.pending--; });
        });
        return ev;
    }
    /** Every 10 s: repeated fall-guard holds, the slow phenomena of the pause records, a build's progress picture when its interval is over. */
    poll(service, { pauses = this.o.pauses === undefined ? optional('../build/pauses') : this.o.pauses } = {}) {
        const t = Date.now();
        for (const rec of service.bots.values()) {
            if (rec.removed || !rec.bot) continue;
            const g = rec.bot.__fallGuard;
            if (g) {
                const was = this.guardSeen.get(rec.name); this.guardSeen.set(rec.name, g.stops);
                if (was !== undefined && g.stops - was >= GUARD_TICKS && g.lastStop && t - g.lastStop.at < POLL_MS * 1.5) this._event(service, { cause: 'guard', bot: rec.name, key: rec.name, t, places: {}, line: `[stuck] ${rec.name}: the fall guard held it back ${g.stops - was} ticks in ${POLL_MS / 1000} s, last at ${g.lastStop.x},${g.lastStop.y},${g.lastStop.z} (repeated guard holds)` });
            }
            const o = pauses && typeof pauses.open === 'function' ? pauses.open(rec.name) : null, kind = slowOf(o);
            if (kind) this._event(service, { cause: kind, bot: rec.name, key: rec.name, t, places: {}, line: `[${kind}] ${rec.name} no action for ${Math.round(o.ms / 1000)} s in ${o.stack.join(' > ') || '-'}${o.sub ? ` (${o.sub})` : ''}${o.fail ? `, after ${o.fail}` : ''}` });
        }
        for (const j of service.jobs.values()) {
            const B = j.impl && j.impl.build;
            if (j.state !== 'running' || !B || !B.t || !B.t.box) continue;
            if (!this.limit.last.has(`progress|${j.id}`)) { this.limit.last.set(`progress|${j.id}`, t); continue; }          // the first picture one interval after the start
            this._event(service, { cause: 'progress', bot: null, key: String(j.id), job: j.id, t, places: {}, line: `[progress] ${j.id} ${j.name || ''}` });
        }
    }
    /** A build's state for its progress picture (synchronous: the maps are read at once). */
    _progress(service, ev) {
        const j = service.jobs.get(ev.job), B = j && j.impl && j.impl.build; if (!B) throw new Error('the build is gone');
        const box = B.t.box, top = {}, side = {}, add = (m, k, i) => { (m[k] || (m[k] = [0, 0, 0]))[i]++; };
        for (const [k, tk] of B.tasks) { add(top, `${tk.x},${tk.z}`, 0); add(side, `${tk.x},${tk.y}`, 0); if (B.claims.has(k)) { add(top, `${tk.x},${tk.z}`, 2); add(side, `${tk.x},${tk.y}`, 2); } }
        for (const k of B.parked.keys()) { const [x, y, z] = k.split(',').map(Number); if (![x, y, z].every(Number.isFinite)) continue; add(top, `${x},${z}`, 1); add(side, `${x},${y}`, 1); }
        const bots = [];
        for (const rec of service.bots.values()) if (rec.job === j.id && rec.bot && rec.bot.entity) { const p = rec.bot.entity.position; bots.push({ name: rec.name, x: p.x, y: p.y, z: p.z }); }
        const st = B.status(), temps = typeof B.ledger.list === 'function' ? B.ledger.list().map((e) => ({ x: e.x, y: e.y, z: e.z })) : [];
        const p = { job: j.id, stage: st.stage, right: st.right, total: st.total, box: { x: box.x, y: box.y, z: box.z, sx: box.sx, sy: box.sy, sz: box.sz }, top, side, bots, temps, work: st.work };
        return { progress: p, facts: { job: j.id, name: j.name || null, status: { stage: st.stage, right: st.right, total: st.total, work: st.work, claimed: st.claimed, parked: st.parked, stats: st.stats, time: st.time }, bots, before: [] } };
    }
    /** The facts of the moment around a bot, read at once (synchronous, on the turn after the log line). */
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
            moves: bot.__mover && Array.isArray(bot.__mover.trace) ? bot.__mover.trace.slice(-8) : [],          // the build mover's last steps (src/build/move.js note)
            guard: g ? { stops: g.stops, lastStop: g.lastStop, episodes: (g.episodes || []).slice(-4) } : null, route, temps, others,
            before: (service.log || []).filter((l) => l.t >= ev.t - 180000 && l.t <= ev.t && String(l.msg).includes(ev.bot)).slice(-30).map((l) => `${stamp(l.t)} ${l.level} ${l.msg}`),
        };
        return { sc, facts, version: bot.version, rcon: service.o && service.o.rcon && typeof service.rcon === 'function' ? (cmd) => service.rcon(cmd) : null };
    }
    _textures(version) {
        const v = String(version || ''); if (this.textures.has(v)) return this.textures.get(v);
        const roots = [this.o.assets, process.env.STUCK_ASSETS, process.env.WORK_ASSETS, '/mc-assets', '/out/mc-assets', '/mnt/data/forgeaip/mc-assets'].filter(Boolean);
        const dir = /^\d{1,2}\.\d{1,3}(\.\d{1,3})?$/.test(v) ? roots.map((r) => path.join(r, v)).find((d) => fs.existsSync(path.join(d, 'models'))) : null;
        const t = new Textures(dir || null); this.textures.set(v, t); return t;
    }
    async _png(dir, name, r, out) {
        const q = await encodeIndexedAsync(r.w, r.h, r.data);
        fs.writeFileSync(path.join(dir, name), q.png); out.images.push(name); out.bytes += q.png.length; if (q.lossy) out.lossy = true;
    }
    /** After the capture: the lines that followed, the server's truth, the pictures, the files, the budget. One event at a time. */
    async _finish(service, ev, snap) {
        const who = ev.bot || ev.key, id = `${String(++this.seq).padStart(3, '0')}-${ev.cause}-${String(who).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16)}`, dir = path.join(this.dir, id);
        if (ev.cause !== 'progress') await new Promise((r) => { const tm = setTimeout(r, this.o.afterMs); if (tm.unref) tm.unref(); });
        const after = ev.bot ? (service.log || []).filter((l) => l.t > ev.t && String(l.msg).includes(ev.bot)).slice(0, 20).map((l) => `${stamp(l.t)} ${l.level} ${l.msg}`) : [];
        const out = { id, run: this.run, kind: ev.cause, bot: ev.bot, t: ev.t, time: new Date(ev.t).toISOString(), line: ev.line, error: ev.error || null, ...(snap ? snap.facts : {}), after, images: [], bytes: 0 };
        const t0 = Date.now();
        fs.mkdirSync(dir, { recursive: true });
        if (snap && snap.progress) { await new Promise((r) => setImmediate(r)); await this._png(dir, 'progress.png', progressPicture(snap.progress), out); }
        else if (snap) {
            if (snap.rcon) {
                let n = 0; const rcon = (cmd) => { n++; return snap.rcon(cmd); }, t1 = Date.now();
                try { await S.truth(snap.sc, rcon, { budgetMs: this.o.truthMs, dim: snap.facts.dim }); out.server = { checked: snap.sc.checked, unchecked: snap.sc.unchecked, diff: snap.sc.diff }; } catch (err) { out.server = { error: String(err && err.message || err) }; }
                out.server.ms = Date.now() - t1; out.server.commands = n;
            }
            else out.server = { error: 'no RCON: the bot view only' };
            const tex = this._textures(snap.version);
            out.textures = tex.dir ? path.basename(tex.dir) : 'none (flat colours)';
            for (const w of VIEWS) {
                await new Promise((r) => setImmediate(r));                    // the bots' ticks run between the pictures
                await this._png(dir, `${w}.png`, picture(snap.sc, w, tex), out);
            }
            out.scene = { r: snap.sc.r, c: snap.sc.c, dir: snap.sc.dir, usualDepth: snap.sc.usualDepth || null };
        }
        out.renderMs = Date.now() - t0;
        fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify(out, null, 1));
        this.events.push({ id, cause: ev.cause, bot: ev.bot, job: ev.job || out.job || null, t: ev.t, pos: out.pos || null, line: String(ev.line).slice(0, 300), images: out.images, bytes: out.bytes, diff: out.server && out.server.diff ? Object.keys(out.server.diff).length : null });
        this._index();
        this._budget();
        if (typeof service.note === 'function') service.note('debug', `[stuck] ${who} ${ev.cause}: snapshot ${this.run}/${id} (${Math.round(out.bytes / 1024)} KB; folder ${(this.bytes / 1048576).toFixed(1)} of ${Math.round(this.o.budget / 1048576)} MB)`);
        return out;
    }
    _index() {
        const f = path.join(this.dir, 'index.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify({ run: this.run, updated: new Date().toISOString(), events: this.events, byKind: byKind(this.events), refused: this.limit.refused, dropped: this.dropped })); fs.renameSync(f + '.tmp', f);
    }
    /** The byte budget: a full count at the first event and every 50th, otherwise the last count plus what was written; over the budget, the oldest go. */
    _budget() {
        const last = this.events[this.events.length - 1];
        if (this.bytes === null || this.events.length % 50 === 0) this.bytes = du(this.o.root); else this.bytes += (last && last.bytes) || 0;
        if (this.bytes > this.o.budget) {
            const r = prune(this.o.root, this.o.budget * 0.9); this.bytes = r.bytes; this.pruned += r.pruned;
            if (r.pruned) { const have = new Set(fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []); this.events = this.events.filter((e) => have.has(e.id)); if (this.events.length) this._index(); }
        }
        const f = path.join(this.o.root, 'status.json');
        try { fs.writeFileSync(f + '.tmp', JSON.stringify({ updated: new Date().toISOString(), bytes: this.bytes, budget: this.o.budget, pruned: this.pruned, run: this.run })); fs.renameSync(f + '.tmp', f); } catch (_) { /* a status only */ }
    }
    stop() { clearInterval(this.timer); this.timer = null; }
}
function optional(m) { try { return require(m); } catch (_) { return null; } }

const watches = new WeakMap();
// On by default in harness runs (a container with /out: scripts/t26/run.sh), off elsewhere (the consoles); STUCK_SNAPSHOTS=1 / 0 forces it. Measured on test world 8
// (docs/implemented/STUCK-SNAPSHOTS-v1.md section 4): the server check 100-175 ms of RCON for 774-1477 commands per event, no rise of the server's ms per tick, 12-37 KB.
function enabled(env = process.env, harness = fs.existsSync('/out')) { return env.STUCK_SNAPSHOTS === '1' || (env.STUCK_SNAPSHOTS !== '0' && harness); }
/** The hook (WorkService.note): one watcher per service, made on its first line. Never throws. */
function observe(service, e) {
    try {
        if (!service || !service.bots) return null;
        let w = watches.get(service);
        if (w === undefined) {
            const env = process.env;
            w = enabled(env) ? new StuckWatch({
                root: env.STUCK_DIR || (fs.existsSync('/out') ? '/out/stuck' : path.join((service.o && service.o.dataDir) || '.', 'stuck')), run: env.RUN,
                budget: (Number(env.STUCK_BUDGET_MB) || 2048) * 1024 * 1024, scale: Number(env.STUCK_MAX) || 1, progressMs: (Number(env.STUCK_PROGRESS_MIN) || 10) * 60000,
            }) : null;
            watches.set(service, w);
        }
        return w ? w.observe(service, e) : null;
    } catch (_) { return null; }
}

module.exports = { observe, StuckWatch, Limiter, LIMITS, KINDS, classify, slowOf, botOf, placesOf, prune, du, enabled, SAFE, VIEWS };

'use strict';
// Where a builder's time between two actions goes (owner list 5 Large 3.3: "the bots stop for a few seconds every time: separate the cause"). An ACTION is what a player's hands
// and feet do: a dig (from its start to its end), a click (use on a block, use of an item, a window click, an attack), a tick in which the body moved. Everything between two
// actions is a pause; every pause of more than PAUSE_MS is classified by where its milliseconds went:
//   cpu      the JavaScript thread planned for this bot (its own claim, plan, flood) or was busy with another bot's (all bots of a crew share one thread: a 400 ms claim of one
//            stops all eight)
//   retry    the bot came out of a failure (a walk that found no way, a batch whose tasks failed) and is trying again
//   bot      waiting for another bot (a hand-over, nothing claimable while others hold the work, the bench, the chest's gate)
//   server   waiting for the server (the tick that applies a look, the block update after a click, a window to open, chunks)
//   other    any other named wait
// The bot's code says what it is doing by labels (`within(label, fn)`, nested); the bot is found by AsyncLocalStorage (each bot's drive runs in its own store), so a sleep deep in
// the mover is attributed without passing the bot down. Synchronous sections longer than BLOCK_MS that ran for one bot are charged to every other bot as `cpu other`.
const { AsyncLocalStorage } = require('async_hooks');

const PAUSE_MS = 500;
const BLOCK_MS = 40;
const ACTION_PACKETS = new Set(['block_dig', 'block_place', 'use_item', 'window_click', 'use_entity']);
const als = new AsyncLocalStorage();
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;          // ms, monotonic
const recs = new Map();                 // bot name -> record
const blocked = [];                     // [from, to, owner, label]: synchronous stretches of the thread (newest last, the last 120 s)
let running = null;                     // { owner, label, at }: the synchronous section running now

/** The class of a label. */
function classOf(label) {
    if (label.startsWith('cpu')) return 'cpu';
    if (label.startsWith('retry')) return 'retry';
    if (label.startsWith('wait')) return 'bot';
    if (label.startsWith('server')) return 'server';
    return 'other';
}

function rec(name) { return recs.get(name) || null; }

/** Charge the time since the last mark to the bot's current label, the thread's blocked stretches by other bots to 'cpu other'. */
function mark(r, t = now()) {
    const a = r.seg, b = t; r.seg = t;
    if (b <= a || r.active) return;
    let rest = b - a;
    for (let i = blocked.length - 1; i >= 0; i--) {
        const [f, to, owner, label] = blocked[i];
        if (to <= a) break;
        if (owner === r.name) continue;
        const o = Math.min(b, to) - Math.max(a, f);
        if (o > 0) { add(r, `cpu other: ${label}`, o); rest -= o; }
    }
    if (rest > 0) add(r, r.stack.length ? r.stack[r.stack.length - 1] : 'other: unlabelled', rest);
}
function add(r, label, ms) { r.parts.set(label, (r.parts.get(label) || 0) + ms); }

/** The bot acted: the pause since its last action is closed (and kept when long enough). */
function act(r, t = now()) {
    mark(r, t);
    const gap = t - r.last;
    if (gap > PAUSE_MS && r.parts.size) {
        const parts = [...r.parts.entries()].sort((x, y) => y[1] - x[1]);
        const byClass = {}; for (const [l, ms] of parts) byClass[classOf(l)] = (byClass[classOf(l)] || 0) + ms;
        let cls = Object.entries(byClass).sort((x, y) => y[1] - x[1])[0][0];
        if (r.afterFail && cls !== 'retry') cls = 'retry';
        const p = { bot: r.name, at: Date.now(), ms: Math.round(gap), cls, top: parts[0][0], fail: r.afterFail || null, parts: parts.slice(0, 4).map(([l, ms]) => [l, Math.round(ms)]) };
        S.add(p);
    }
    r.parts.clear(); r.afterFail = null; r.last = t;
}

/** Start tracking a bot (its packets and its body). Idempotent; `stop()` undoes it. */
function attach(bot, name) {
    if (recs.has(name)) return () => {};
    const r = { name, last: now(), seg: now(), stack: [], parts: new Map(), active: false, afterFail: null, pos: null };
    recs.set(name, r);
    const client = bot._client, write = client && client.write;
    if (write) client.write = function (pname, data) {
        try {
            if (ACTION_PACKETS.has(pname)) {
                if (pname === 'block_dig') { const st = data && data.status; if (st === 0) { act(r); r.active = true; } else if (st === 1 || st === 2) { r.active = false; r.seg = r.last = now(); r.parts.clear(); r.afterFail = null; } }
                else act(r);
            }
        } catch (_) { /* counting never breaks a packet */ }
        return write.apply(this, arguments);
    };
    const onTick = () => {
        const p = bot.entity && bot.entity.position; if (!p) return;
        const q = r.pos; r.pos = { x: p.x, y: p.y, z: p.z };
        if (q && Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.z - q.z) > 0.03) act(r);
    };
    bot.on('physicsTick', onTick);
    return () => { if (write) client.write = write; bot.removeListener('physicsTick', onTick); recs.delete(name); };
}

/** Run fn (sync or async) as this bot with the label on top of its stack. */
function within(label, fn) {
    const st = als.getStore(), r = st && rec(st.name);
    if (!r) return fn();
    mark(r); r.stack.push(label);
    const done = () => { mark(r); const i = r.stack.lastIndexOf(label); if (i >= 0) r.stack.splice(i, 1); };
    let out;
    try { out = fn(); } catch (e) { done(); throw e; }
    if (out && typeof out.then === 'function') return out.finally(done);
    done(); return out;
}

/** A synchronous section of this bot's CPU (a claim, a slice of a plan): charged to it, and to the others as a blocked thread when it is long. */
function sync(label, fn) {
    const st = als.getStore(), owner = st ? st.name : '?', t0 = now(), outer = running;
    running = { owner, label, at: t0 };
    try { return within(`cpu: ${label}`, fn); } finally {
        const t1 = now(); running = outer;
        if (t1 - t0 > BLOCK_MS) { blocked.push([t0, t1, owner, `${label} (${owner})`]); while (blocked.length > 4000 || (blocked.length && blocked[0][1] < t1 - 120000)) blocked.shift(); }
    }
}
/** A slice of synchronous work measured by the caller (from t0, performance ms of `now()`), e.g. one slice of the planner between two yields. */
function slice(label, t0) {
    const t1 = now(), st = als.getStore(), owner = st ? st.name : '?';
    if (t1 - t0 > BLOCK_MS) { blocked.push([t0, t1, owner, `${label} (${owner})`]); while (blocked.length > 4000 || (blocked.length && blocked[0][1] < t1 - 120000)) blocked.shift(); }
}

/** The bot's last step failed (why): the pause that follows is a retry. */
function failed(why) { const st = als.getStore(), r = st && rec(st.name); if (r) r.afterFail = String(why || 'failed').replace(/-?\d+/g, '#').slice(0, 60); }

/** Run the bot's whole drive in its store. */
function run(name, fn) { return als.run({ name }, fn); }

/** A sleep that says why: the label (`server: click`, `wait: idle`, `retry: no way` ...). */
const sleep = (ms, label = 'other: sleep') => within(label, () => new Promise((res) => setTimeout(res, ms)));

/** The table: pauses over PAUSE_MS since the start (or the last `reset`), by class and by label; `since` (ms epoch) for a window. */
const S = {
    list: [],
    add(p) { this.list.push(p); if (this.list.length > 200000) this.list.splice(0, 50000); },
    table({ since = 0 } = {}) {
        const l = this.list.filter((p) => p.at >= since), cls = {}, top = {}, fail = {};
        let ms = 0;
        for (const p of l) {
            ms += p.ms;
            const c = cls[p.cls] || (cls[p.cls] = { n: 0, s: 0 }); c.n++; c.s += p.ms / 1000;
            const k = `${p.cls}: ${p.top.replace(/\(.*\)$/, '').trim()}`; const tt = top[k] || (top[k] = { n: 0, s: 0 }); tt.n++; tt.s += p.ms / 1000;
            if (p.fail) fail[p.fail] = (fail[p.fail] || 0) + 1;
        }
        const r1 = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1].s - a[1].s).map(([k, v]) => [k, { n: v.n, s: Math.round(v.s) }]));
        return { pauses: l.length, seconds: Math.round(ms / 1000), byClass: r1(cls), byLabel: Object.fromEntries(Object.entries(r1(top)).slice(0, 14)), retryAfter: Object.fromEntries(Object.entries(fail).sort((a, b) => b[1] - a[1]).slice(0, 8)) };
    },
};

module.exports = { attach, within, sync, slice, failed, run, sleep, now, table: (o) => S.table(o), list: S.list, PAUSE_MS, classOf };

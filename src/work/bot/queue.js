'use strict';
// A line for one thing only one bot can use at a time (a bed, a chest). Owner 2026-11-09: 20 bots sent to one bed crowded on one block and the first one slept until morning;
// the same crowd stands at a chest. Bots take a place in line, are served one after another (first come, first served; the callers start in name order), and a bot that holds
// the front place too long, or that gives up, is taken out so that the ones behind it never wait for it. Pure (timers aside): the bot's walk is in the caller.
//
//   const gates = new Gates({ holdMs: 45000, waitMs: 240000 });
//   const t = await gates.enter('bed:10,64,3', 'Work4', { cancel });      // resolves when it is this bot's turn; t.evicted is set if the turn ran out
//   try { ...use it, watch t.cancel ... } finally { t.leave(); }
const sleepless = (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; };

class Gate {
    constructor(key, { holdMs, waitMs }, onIdle = null) { this.key = key; this.holdMs = holdMs; this.waitMs = waitMs; this.holder = null; this.line = []; this.onIdle = onIdle; }
    _idle() { if (!this.holder && !this.line.length && this.onIdle) this.onIdle(this); }

    /** Resolves with a ticket when it is the caller's turn; rejects with reason 'timeout' (waited too long) or 'cancelled'. */
    enter(who, { cancel = null, holdMs = this.holdMs, waitMs = this.waitMs, onTurn = null } = {}) {
        return new Promise((resolve, reject) => {
            const gate = this;
            const ticket = {
                who, key: this.key, evicted: false, left: false, since: 0, holdMs,
                /** A cancel token that also stops when this ticket's turn ran out: hand it to the command that runs under the ticket. */
                get cancelled() { return !!(cancel && cancel.cancelled) || ticket.evicted; },
                leave() { gate._leave(ticket); },
            };
            const w = { ticket, resolve, reject, cancel, onTurn, timer: null, poll: null };
            w.timer = sleepless(() => { gate._drop(w); reject(Object.assign(new Error(`waited ${Math.round(waitMs / 1000)} s in line for ${gate.key}`), { reason: 'timeout', place: 0 })); }, waitMs);
            if (cancel) w.poll = setInterval(() => { if (cancel.cancelled) { gate._drop(w); reject(Object.assign(new Error('cancelled in line'), { reason: 'cancelled' })); } }, 500);
            if (w.poll && w.poll.unref) w.poll.unref();
            this.line.push(w);
            this._next();
        });
    }

    _drop(w) { clearTimeout(w.timer); if (w.poll) clearInterval(w.poll); const i = this.line.indexOf(w); if (i >= 0) this.line.splice(i, 1); this._idle(); }

    _next() {
        if (this.holder || !this.line.length) return;
        const w = this.line.shift(); clearTimeout(w.timer); if (w.poll) clearInterval(w.poll);
        const t = w.ticket; t.since = Date.now(); this.holder = t;
        t.timer = sleepless(() => { if (this.holder === t) { t.evicted = true; this._leave(t); } }, t.holdMs);      // the front place runs out: the bot is out of the line, its command is cancelled (t.cancelled)
        if (w.onTurn) { try { w.onTurn(t); } catch (_) { /* a display callback must not break the line */ } }
        w.resolve(t);
    }

    _leave(t) {
        if (t.left) return; t.left = true; clearTimeout(t.timer);
        if (this.holder === t) this.holder = null;
        this._next(); this._idle();
    }

    /** Who is in line, front first: the holder, then the waiters. */
    snapshot() { return [...(this.holder ? [this.holder.who] : []), ...this.line.map((w) => w.ticket.who)]; }
    place(who) { return this.snapshot().indexOf(who); }
}

class Gates {
    constructor(o = {}) { this.o = { holdMs: 45000, waitMs: 240000, ...o }; this.gates = new Map(); }
    gate(key) { let g = this.gates.get(key); if (!g) this.gates.set(key, g = new Gate(key, this.o, (x) => { if (this.gates.get(key) === x) this.gates.delete(key); })); return g; }
    enter(key, who, opt) { return this.gate(key).enter(who, opt); }
    /** Lines with someone in them: for the page. */
    busy() { return [...this.gates.values()].map((g) => ({ key: g.key, line: g.snapshot() })).filter((g) => g.line.length); }
}

/** Natural order of bot names (Work2 before Work10): the order a crowd lines up in. */
const byName = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

module.exports = { Gate, Gates, byName };

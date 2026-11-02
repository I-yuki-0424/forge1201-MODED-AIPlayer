'use strict';
// Live view of the training bots for a human watcher (docs/proposed/RL-TRAINING-v2.md "Watching"): what each bot is doing
// now, what happened, success rates, and how far its choices are from a uniform pick among the candidates it was offered.
// The environment calls begin()/end() around every command and writes snapshot() to <root>/<base>.live.json once a second;
// tools/train-dash serves that file and a page that renders it. Pure apart from reading the attached bot objects.
const WINDOW = 200;   // steps per bot in the rolling statistics
const RECENT = 20;    // steps per bot listed one by one

const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

class LiveBoard {
    constructor({ run, base, window = WINDOW } = {}) {
        this.run = run; this.base = base; this.window = window; this.bots = new Map(); this.t0 = Date.now();
    }

    attach(envId, name, bot) {
        this.bots.set(envId, { name, bot, episode: 0, step: 0, cur: null, ring: [], total: { n: 0, ok: 0 },
            ep: { ret: 0, nights: 0, slept: 0, t0: Date.now() }, episodes: [], connected: true });
    }

    /** Where this bot's episodes start ({site, pos, shard}; null = a random site in its sector). */
    site(envId, start) { const b = this.bots.get(envId); if (b) b.start = start; }

    lost(envId, why) { const b = this.bots.get(envId); if (b) { b.connected = false; b.lostWhy = String(why).slice(0, 200); } }

    /** A command starts. offered: the candidate list's commands, in order. */
    begin(envId, { episode, step, cmd, label, index, offered }) {
        const b = this.bots.get(envId);
        if (!b) return;
        if (episode !== b.episode) { b.episode = episode; b.ep = { ret: 0, nights: 0, slept: 0, t0: Date.now() }; }
        b.step = step;
        b.cur = { cmd, label, index, offered, t: Date.now() };
    }

    /** The command ended. */
    end(envId, { ok, reason, ms, ticks, reward, nights = 0, slept = 0 }) {
        const b = this.bots.get(envId);
        if (!b || !b.cur) return;
        const p = b.bot && b.bot.entity && b.bot.entity.position;
        b.ring.push({ t: Date.now(), episode: b.episode, cmd: b.cur.cmd, label: b.cur.label, ok: !!ok, reason: ok ? 'ok' : reason, ms, ticks, reward: round(reward, 4),
            offered: b.cur.offered, pos: p ? [round(p.x, 1), round(p.y, 1), round(p.z, 1)] : null });
        if (b.ring.length > this.window) b.ring.shift();
        b.total.n++; if (ok) b.total.ok++;
        b.ep.ret += reward; b.ep.nights += nights; b.ep.slept += slept;
        b.cur = null;
    }

    episodeEnd(envId, rec) {
        const b = this.bots.get(envId);
        if (!b) return;
        b.episodes.push(rec);
        if (b.episodes.length > 10) b.episodes.shift();
    }

    /** Per-bot statistics over the rolling window. */
    static stats(ring, episode) {
        const n = ring.length, by = {}, reasons = {};
        let ok = 0;
        for (const s of ring) {
            ok += s.ok;
            const c = by[s.cmd] || (by[s.cmd] = { n: 0, ok: 0, offered_steps: 0, uniform: 0 });
            c.n++; c.ok += s.ok;
            if (!s.ok) reasons[`${s.cmd}:${s.reason}`] = (reasons[`${s.cmd}:${s.reason}`] || 0) + 1;
        }
        // Bias: the chosen share of a command against the share a uniform pick among the offered candidates would give.
        for (const s of ring) {
            const k = s.offered && s.offered.length;
            if (!k) continue;
            const cnt = {};
            for (const c of s.offered) cnt[c] = (cnt[c] || 0) + 1;
            for (const [c, m] of Object.entries(cnt)) {
                const e = by[c] || (by[c] = { n: 0, ok: 0, offered_steps: 0, uniform: 0 });
                e.offered_steps++; e.uniform += m / k;
            }
        }
        const cmds = Object.fromEntries(Object.entries(by).map(([c, e]) => [c, {
            n: e.n, share: n ? round(e.n / n) : 0, ok_rate: e.n ? round(e.ok / e.n) : null,
            offered: n ? round(e.offered_steps / n) : 0, uniform_share: n ? round(e.uniform / n) : 0,
            bias: e.uniform ? round(e.n / e.uniform, 2) : null,
        }]).sort((a, b) => b[1].n - a[1].n));
        const pos = ring.filter((s) => episode === undefined || s.episode === episode).map((s) => s.pos).filter(Boolean);   // this episode: resets teleport
        let spread = null;
        if (pos.length) spread = round(Math.max(...[0, 1, 2].map((i) => Math.max(...pos.map((q) => q[i])) - Math.min(...pos.map((q) => q[i])))), 1);
        const span = n > 1 ? (ring[n - 1].t - ring[0].t) / 1000 : 0;
        return { n, ok_rate: n ? round(ok / n) : null, cmds, reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)),
            spread, spread_n: pos.length, steps_per_min: span > 0 ? round((n - 1) / span * 60, 1) : null };
    }

    /** Warning signs the watcher asked for: repeated failure, one command dominating, not moving. */
    static warnings(st) {
        const w = [];
        if (st.n >= 50 && st.ok_rate !== null && st.ok_rate < 0.3) w.push(`fails ${Math.round((1 - st.ok_rate) * 100)}% of the last ${st.n} commands`);
        const top = Object.entries(st.cmds)[0];
        if (st.n >= 50 && top && top[1].share >= 0.7 && top[1].bias !== null && top[1].bias >= 2) w.push(`${top[0]} is ${Math.round(top[1].share * 100)}% of choices (${top[1].bias}x a uniform pick)`);
        if (st.spread_n >= 100 && st.spread !== null && st.spread < 3) w.push(`moved less than 3 blocks in the last ${st.spread_n} commands`);
        return w;
    }

    snapshot() {
        const bots = [];
        for (const [envId, b] of [...this.bots.entries()].sort((a, c) => a[0] - c[0])) {
            const bot = b.bot, e = bot && bot.entity, st = LiveBoard.stats(b.ring, b.episode);
            bots.push({
                env_id: envId, name: b.name, connected: b.connected, lost: b.lostWhy, start: b.start || null,
                episode: b.episode, step: b.step,
                now: b.cur ? { cmd: b.cur.cmd, label: b.cur.label, candidate: b.cur.index, of: b.cur.offered.length, for_s: round((Date.now() - b.cur.t) / 1000, 1) } : null,
                body: e ? { pos: [round(e.position.x, 1), round(e.position.y, 1), round(e.position.z, 1)], health: round(bot.health || 0, 1), food: bot.food,
                    dim: bot.game && bot.game.dimension, time: bot.time && bot.time.timeOfDay, sleeping: !!bot.isSleeping } : null,
                episode_now: { return: round(b.ep.ret, 3), nights: b.ep.nights, slept: b.ep.slept, wall_s: Math.round((Date.now() - b.ep.t0) / 1000) },
                total: { n: b.total.n, ok_rate: b.total.n ? round(b.total.ok / b.total.n) : null },
                window: st, warnings: LiveBoard.warnings(st),
                recent: b.ring.slice(-RECENT).reverse().map(({ offered, episode, ...s }) => s),
                episodes: b.episodes.slice().reverse(),
            });
        }
        return { v: 1, run: this.run, base: this.base, t: Date.now(), up_s: Math.round((Date.now() - this.t0) / 1000), window: this.window, bots };
    }

    /** Atomic write (tmp + rename), so a reader never sees half a file. */
    write(file) {
        const fs = require('fs');
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.snapshot()));
        fs.renameSync(tmp, file);
    }
}

module.exports = { LiveBoard, WINDOW, RECENT };

'use strict';
// Renders /live.json (the environment's live board) and /learner.json every 2 s. DOM built with textContent only.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const rate = (v) => el('span', v === null || v === undefined ? 'muted' : v >= 0.7 ? 'ok' : v >= 0.3 ? 'warn' : 'bad', pct(v));
const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m`; };
const clock = (t) => { if (t === undefined || t === null) return '–'; const h = (Math.floor(t / 1000) + 6) % 24, m = Math.floor((t % 1000) * 0.06); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${t >= 12542 && t < 23460 ? ' night' : ''}`; };

function kv(pairs) {
    const d = el('div', 'kv');
    for (const [k, v] of pairs) { const s = el('span'); s.append(el('span', 'muted', `${k} `)); s.append(v instanceof Node ? v : el('b', null, v)); d.append(s); }
    return d;
}

function table(head, rows, numeric = []) {
    const wrap = el('div', 'scroll'), t = el('table'), tr = el('tr');
    head.forEach((h, i) => tr.append(el('th', numeric.includes(i) ? 'num' : '', h)));
    t.append(tr);
    for (const r of rows) {
        const row = el('tr');
        r.forEach((c, i) => { const td = el('td', numeric.includes(i) ? 'num' : ''); if (c instanceof Node) td.append(c); else td.textContent = c; row.append(td); });
        t.append(row);
    }
    wrap.append(t);
    return wrap;
}

function bar(v, label) { const d = el('div', 'bar'), i = el('i'); i.style.width = `${Math.min(100, Math.round(v * 100))}%`; d.append(i, el('span', null, label)); return d; }

function botCard(b, now) {
    const card = el('article', `card${b.connected ? '' : ' lost'}`);
    const h = el('h2');
    h.append(el('span', null, `BOT #${b.env_id}`), el('span', 'muted', `${b.name} · episode ${b.episode} · step ${b.step}`));
    if (!b.connected) h.append(el('span', 'bad', `disconnected: ${b.lost || ''}`));
    card.append(h);

    const n = b.now;
    card.append(el('div', 'now', n ? `${n.cmd} ${n.label} — for ${n.for_s}s (candidate ${n.candidate} of ${n.of})` : 'between commands (waiting for the policy or resetting)'));

    const body = b.body || {};
    card.append(kv([['health', body.health ?? '–'], ['food', body.food ?? '–'], ['pos', body.pos ? body.pos.join(' ') : '–'],
        ['time', clock(body.time)], ['dim', (body.dim || '–').replace('minecraft:', '')], ...(body.sleeping ? [['', el('b', 'ok', 'sleeping')]] : [])]));
    const w = b.window;
    card.append(kv([['success all', rate(b.total.ok_rate)], [`last ${w.n}`, rate(w.ok_rate)], ['moved', w.spread === null ? '–' : `${w.spread} blocks`],
        ['pace', w.steps_per_min === null ? '–' : `${w.steps_per_min}/min`], ['episode return', b.episode_now.return],
        ['nights', `${b.episode_now.nights} (slept ${b.episode_now.slept})`], ['alive', ago(b.episode_now.wall_s * 1000)]]));
    for (const x of b.warnings) card.append(el('div', 'alert', x));

    card.append(el('h3', null, `commands, last ${w.n} (bias = chosen share / share of a uniform pick among the offered)`));
    card.append(table(['command', 'chosen', 'uniform', 'bias', 'success', 'offered'],
        Object.entries(w.cmds).map(([c, e]) => [c, bar(e.share, pct(e.share)), pct(e.uniform_share),
            el('span', e.bias !== null && (e.bias >= 2 || e.bias <= 0.5) ? 'warn' : '', e.bias === null ? '–' : `${e.bias}x`), rate(e.ok_rate), pct(e.offered)]), [2, 3, 4, 5]));
    const reasons = Object.entries(w.reasons);
    if (reasons.length) { card.append(el('h3', null, 'failures')); card.append(table(['command:reason', 'count'], reasons, [1])); }

    card.append(el('h3', null, 'what happened (newest first)'));
    card.append(table(['ago', 'command', 'result', 'ms', 'reward'], b.recent.map((s) => {
        const td = el('span', 'wrap'); td.textContent = `${s.cmd} ${s.label}`;
        return [ago(now - s.t), td, el('span', s.ok ? 'ok' : 'bad', s.reason), s.ms, s.reward];
    }), [3, 4]));
    if (b.episodes.length) {
        card.append(el('h3', null, 'last episodes'));
        card.append(table(['episode', 'return', 'nights', 'alive', 'end'], b.episodes.slice(0, 5).map((e) => [e.episode, e.return, `${e.nights} (${e.slept})`, ago(e.wall_s * 1000), e.terminated ? 'died' : 'cut']), [1]));
    }
    return card;
}

function spark(values) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 100 40'); svg.setAttribute('preserveAspectRatio', 'none');
    if (values.length > 1) {
        const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
        const pl = document.createElementNS(ns, 'polyline');
        pl.setAttribute('points', values.map((v, i) => `${(i / (values.length - 1) * 100).toFixed(2)},${(38 - (v - lo) / span * 36).toFixed(2)}`).join(' '));
        svg.append(pl);
    }
    return svg;
}

function learner(L) {
    const box = $('learner');
    box.replaceChildren();
    const ups = L.updates.filter((u) => u.event === 'update'), last = ups[ups.length - 1], model = L.updates.find((u) => u.event === 'model');
    const h = el('h2'); h.append(el('span', null, 'Learner'), el('span', 'muted', model ? `${model.name}, ${model.params_total} parameters` : ''));
    box.append(h);
    if (!last) { box.append(el('div', 'muted', 'no update yet (the first comes after 16 segments of 32 steps)')); return; }
    box.append(kv([['update', last.update], ['steps', last.total_steps], ['stage', last.stage], ['entropy', last.ent.toFixed(3)], ['kl', last.kl.toFixed(4)],
        ['clip', last.clipfrac.toFixed(3)], ['staleness', last.staleness_mean], ['reward/step', last.reward_mean.toFixed(4)]]));
    for (const s of L.updates.filter((u) => u.event === 'stage_switch')) box.append(el('div', 'alert', `stage switch to ${s.to}`));
    box.append(el('h3', null, `policy entropy over the last ${ups.length} updates (falling fast = choices collapsing)`), spark(ups.map((u) => u.ent)));
    box.append(el('h3', null, 'mean reward per step'), spark(ups.map((u) => u.reward_mean)));
    if (L.episodes.length) {
        box.append(el('h3', null, 'episodes (newest first)'));
        box.append(table(['bot', 'episode', 'steps', 'nights', 'return', 'invalid', 'end'], L.episodes.slice().reverse().slice(0, 12).map((e) =>
            [`#${e.env_id}`, e.episode, e.steps, `${e.nights} (${e.slept})`, e.return_stage, (e.terms && e.terms.invalid !== undefined) ? e.terms.invalid : '–', e.terminated ? 'died' : 'cut']), [2, 3, 4, 5]));
    }
}

async function tick() {
    try {
        const [lr, ll] = await Promise.all([fetch('/live.json', { cache: 'no-store' }), fetch('/learner.json', { cache: 'no-store' })]);
        if (lr.ok) {
            const live = await lr.json(), now = Date.now(), stale = now - live.t > 10000;
            $('run').replaceChildren(el('span', null, `run ${live.run} · up ${ago(live.up_s * 1000)} · ${live.bots.length} bots`), ...(stale ? [el('span', 'bad', ` · no update for ${ago(now - live.t)} (environment stopped?)`)] : []));
            const alerts = live.bots.filter((b) => b.warnings.length || !b.connected).map((b) => el('div', 'alert', `BOT #${b.env_id}: ${b.connected ? b.warnings.join('; ') : 'disconnected'}`));
            $('alerts').replaceChildren(...alerts);
            $('bots').replaceChildren(...live.bots.map((b) => botCard(b, live.t)));
        } else $('run').textContent = 'no live data yet (environment starting?)';
        if (ll.ok) learner(await ll.json());
    } catch (e) { $('run').textContent = `cannot reach the server: ${e.message}`; }
    setTimeout(tick, 2000);
}
tick();

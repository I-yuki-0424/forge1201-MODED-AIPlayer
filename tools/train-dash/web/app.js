'use strict';
// The watcher's page. Data arrives by push (/events, Server-Sent Events: `live` = every environment shard's board, `learner`,
// `goals` = the goal learner's provenance board: each bot's plan, why and how it was generated, its goal)
// as soon as the files change; polling every 2 s only if the stream cannot be opened. Rendering is asynchronous and partial:
// at most once per animation frame, only the cards whose data changed are rebuilt, nothing while the tab is hidden.
// DOM built with textContent only.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const rate = (v) => el('span', v === null || v === undefined ? 'muted' : v >= 0.7 ? 'ok' : v >= 0.3 ? 'warn' : 'bad', pct(v));
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m`; };
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

// A card has a head (what the bot does now: changes every push) and a body (statistics, history: changes when a command
// ends). Each part is rebuilt only when its own data changed.
function botHead(b, partners) {
    const f = document.createDocumentFragment(), h = el('h2');
    h.append(el('span', null, `BOT #${b.env_id}`), el('span', 'muted', `${b.name} · episode ${b.episode} · step ${b.step}`));
    if (b.start) h.append(el('span', 'muted', `group ${b.start.pair ?? b.start.shard}${b.start.pos ? ` · site ${b.start.site ?? '?'} (${b.start.pos.join(' ')})` : ''}${partners.length ? ` · pair of #${partners.join(', #')}` : ''}`));
    if (!b.connected) h.append(el('span', 'bad', `disconnected: ${b.lost || ''}`));
    const n = b.now, body = b.body || {};
    f.append(h, el('div', 'now', n ? `${n.cmd} ${n.label} — for ${n.for_s}s (candidate ${n.candidate} of ${n.of})` : 'between commands (waiting for the policy or resetting)'),
        kv([['health', body.health ?? '–'], ['food', body.food ?? '–'], ['pos', body.pos ? body.pos.join(' ') : '–'],
            ['time', clock(body.time)], ['dim', (body.dim || '–').replace('minecraft:', '')], ...(body.sleeping ? [['', el('b', 'ok', 'sleeping')]] : [])]));
    return f;
}

function botBody(b, now) {
    const f = document.createDocumentFragment(), w = b.window;
    f.append(kv([['success all', rate(b.total.ok_rate)], [`last ${w.n}`, rate(w.ok_rate)], ['moved', w.spread === null ? '–' : `${w.spread} blocks`],
        ['pace', w.steps_per_min === null ? '–' : `${w.steps_per_min}/min`], ['episode return', b.episode_now.return],
        ['days', `${b.episode_now.nights} (slept ${b.episode_now.slept})`], ['episode for', ago(b.episode_now.wall_s * 1000)]]));
    for (const x of b.warnings) f.append(el('div', 'alert', x));
    f.append(el('h3', null, `commands, last ${w.n} (bias = chosen share / share of a uniform pick among the offered)`));
    f.append(table(['command', 'chosen', 'uniform', 'bias', 'success', 'offered'],
        Object.entries(w.cmds).map(([c, e]) => [c, bar(e.share, pct(e.share)), pct(e.uniform_share),
            el('span', e.bias !== null && (e.bias >= 2 || e.bias <= 0.5) ? 'warn' : '', e.bias === null ? '–' : `${e.bias}x`), rate(e.ok_rate), pct(e.offered)]), [2, 3, 4, 5]));
    const reasons = Object.entries(w.reasons);
    if (reasons.length) { f.append(el('h3', null, 'failures')); f.append(table(['command:reason', 'count'], reasons, [1])); }
    f.append(el('h3', null, 'what happened (newest first)'));
    f.append(table(['ago', 'command', 'result', 'ms', 'reward'], b.recent.map((s) => {
        const td = el('span', 'wrap'); td.textContent = `${s.cmd} ${s.label}`;
        return [ago(now - s.t), td, el('span', s.ok ? 'ok' : 'bad', s.reason), s.ms, s.reward];
    }), [3, 4]));
    if (b.episodes.length) {
        f.append(el('h3', null, 'last episodes'));
        f.append(table(['episode', 'return', 'days', 'deaths', 'progress', 'wall'], b.episodes.slice(0, 5).map((e) => [e.episode, e.return, `${e.days ?? e.nights} (${e.slept})`,
            e.deaths ?? (e.terminated ? 1 : 0), e.progress ? e.progress.length : '–', ago(e.wall_s * 1000)]), [1, 3, 4]));
    }
    return f;
}

// What the learner generated for this bot and why (goals.json): the plan with its trigger, the reason its target was chosen,
// the beams and R(s, step) at generation, the goal now with its source and price, and how the last plans and goals ended.
function botGoal(g) {
    const f = document.createDocumentFragment();
    if (!g) { f.append(el('div', 'muted', 'no goal data (learner without goals, or not yet written)')); return f; }
    const pl = g.plan;
    f.append(el('h3', null, 'plan (batch-generated)'));
    if (pl) {
        f.append(el('div', 'now', `target ${pl.target}`),
            kv([['why this target', pl.why], ['generated because', pl.trigger], ['beam log-prob', pl.logp ?? '–'], ['age', `${pl.commands} commands`]]));
        f.append(table(['#', 'subgoal', 'R at generation', 'state'], pl.steps.map((st, i) => [i + 1, st.dim,
            st.r_at_start === null ? el('span', 'muted', '–') : el('span', st.r_at_start < 0.05 ? 'bad' : st.r_at_start < 0.3 ? 'warn' : 'ok', st.r_at_start.toFixed(3)),
            el('span', i < pl.k ? 'ok' : i === pl.k ? 'warn' : 'muted', i < pl.k ? 'reached' : i === pl.k ? 'now' : 'pending')]), [0, 2]));
        if (pl.beams && pl.beams.length > 1) f.append(el('div', 'muted wrap', `other beams: ${pl.beams.slice(1).map((b) => `[${b.steps.join(' → ')}] ${b.logp}`).join(' · ')}`));
    } else f.append(el('div', 'muted', 'none: the goal comes from the archive (exploration share) or plan generation gave up this episode'));
    const go = g.goal;
    f.append(el('h3', null, 'goal now'));
    if (go) {
        f.append(el('div', 'now', go.tokens.map((t) => `${t.dim} ${t.from} → ${t.to} (now ${t.now})`).join(' and ') + (go.context.length ? `, toward ${go.context.join(', ')}` : '')),
            kv([['from', go.src], ['p (reach)', go.p], ['bonus if reached', go.bonus_if_reached], ['repeat', go.repeat], ['age', `${go.age} of ${go.horizon}`]]));
    } else f.append(el('div', 'muted', 'none'));
    if (g.plans.length) {
        f.append(el('h3', null, 'last plans'));
        f.append(table(['target', 'generated because', 'reached', 'outcome'], g.plans.map((p) => {
            const o = el('span', p.outcome === 'completed' ? 'ok' : /infeasible|expired/.test(p.outcome) ? 'warn' : 'muted', p.outcome); o.title = p.steps.join(' → ');
            return [p.target, el('span', 'wrap', p.trigger), `${p.reached}/${p.steps.length}`, o];
        })));
    }
    if (g.goals.length) {
        f.append(el('h3', null, 'last goals'));
        f.append(table(['goal', 'from', 'p', 'outcome', 'bonus', 'cmds'], g.goals.map((x) => [x.goal.join(' + '), el('span', 'wrap', x.src), x.p,
            el('span', x.outcome === 'reached' ? 'ok' : 'muted', x.outcome), x.bonus, x.commands]), [2, 4, 5]));
    }
    return f;
}

const cards = new Map();   // env_id -> {card, head, goal, body, kHead, kGoal, kBody}
function renderBots(bots, now) {
    const keep = new Set();
    let prev = null;
    const bySite = new Map();
    const pairOf = (st) => st.pair ?? st.site;   // env v3.0: the group; before: the shared start site
    for (const b of bots) if (b.start) bySite.set(pairOf(b.start), [...(bySite.get(pairOf(b.start)) || []), b.env_id]);
    for (const b of bots) {
        keep.add(b.env_id);
        let c = cards.get(b.env_id);
        if (!c) { c = { card: el('article', 'card'), head: el('div'), goal: el('div'), body: el('div'), kHead: '', kGoal: '', kBody: '' }; c.card.append(c.head, c.goal, c.body); cards.set(b.env_id, c); }
        c.card.className = `card${b.connected ? '' : ' lost'}`;
        const partners = b.start ? (bySite.get(pairOf(b.start)) || []).filter((i) => i !== b.env_id) : [];
        const { now: n, body, ...rest } = b, kHead = JSON.stringify([b.name, b.episode, b.step, b.connected, n, body, b.start, partners]);
        const kBody = JSON.stringify([rest.window, rest.total, rest.episode_now, rest.warnings, rest.recent, rest.episodes]);
        const g = goalsDoc && goalsDoc.bots ? goalsDoc.bots[String(b.env_id)] : null;
        const { start: _s, ...gk } = g || {}, kGoal = JSON.stringify(gk);
        if (kHead !== c.kHead) { c.head.replaceChildren(botHead(b, partners)); c.kHead = kHead; }
        if (kGoal !== c.kGoal) { c.goal.replaceChildren(botGoal(g)); c.kGoal = kGoal; }
        if (kBody !== c.kBody) { c.body.replaceChildren(botBody(b, now)); c.kBody = kBody; }
        // Keep the cards in env_id order, moving only what is out of place.
        const want = prev ? prev.nextSibling : $('bots').firstChild;
        if (want !== c.card) $('bots').insertBefore(c.card, want);
        prev = c.card;
    }
    for (const [id, c] of cards) if (!keep.has(id)) { c.card.remove(); cards.delete(id); }
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
    const box = $('learner'), f = document.createDocumentFragment();
    const ups = L.updates.filter((u) => u.event === 'update'), last = ups[ups.length - 1], model = L.updates.find((u) => u.event === 'model');
    const h = el('h2'); h.append(el('span', null, 'Learner'), el('span', 'muted', model ? `${model.name}, ${model.params_total} parameters${model.population ? `, population ${model.population.length}` : ''}` : ''));
    f.append(h);
    if (!last) { f.append(el('div', 'muted', 'no update yet (the first comes after 16 segments of 32 steps)')); box.replaceChildren(f); return; }
    f.append(kv([['update', last.update], ['member', last.member ?? 0], ['steps', last.total_steps], ['stage', last.stage], ['entropy', last.ent.toFixed(3)], ['kl', last.kl.toFixed(4)],
        ['clip', last.clipfrac.toFixed(3)], ['staleness', last.staleness_mean], ['reward/step', last.reward_mean.toFixed(4)]]));
    for (const s of L.updates.filter((u) => u.event === 'stage_switch')) f.append(el('div', 'alert', `stage switch to ${s.to}`));
    f.append(el('h3', null, `policy entropy over the last ${ups.length} updates (falling fast = choices collapsing)`), spark(ups.map((u) => u.ent)));
    f.append(el('h3', null, 'mean reward per step'), spark(ups.map((u) => u.reward_mean)));
    const paired = L.episodes.filter((e) => e.pair !== undefined);
    if (paired.length) {
        // Pairs (env v3.0): the two bots of one group (one world), given the same goals. Their latest episodes side by side.
        const last = new Map();
        for (const e of paired) last.set(e.env_id, e);
        const groups = [...new Set(paired.map((e) => e.pair))].sort((a, b) => a - b);
        f.append(el('h3', null, 'pairs: latest episode of each bot of a group (task return · progress entries · deaths · days)'));
        f.append(table(['group', 'bot', 'partner'], groups.map((p) => {
            const es = [...last.values()].filter((e) => e.pair === p).sort((a, b) => a.env_id - b.env_id);
            const cell = (e) => (e ? `#${e.env_id}: ${e.return_task} · ${e.achievements} · ${e.deaths ?? '–'} · ${e.nights}` : '–');
            return [p, cell(es[0]), cell(es[1])];
        })));
    }
    if (L.episodes.length) {
        f.append(el('h3', null, 'episodes (newest first)'));
        f.append(table(['bot', 'episode', 'steps', 'days', 'deaths', 'progress', 'return', 'invalid'], L.episodes.slice().reverse().slice(0, 12).map((e) =>
            [`#${e.env_id}`, e.episode, e.steps, `${e.nights} (${e.slept})`, e.deaths ?? (e.terminated ? 'died' : '–'), e.achievements ?? '–',
                e.return_stage ?? e.return_task, (e.terms && e.terms.invalid !== undefined) ? e.terms.invalid : '–']), [2, 3, 4, 5, 6, 7]));
    }
    box.replaceChildren(f);
}

// ---- data in, frames out
let live = null, learn = null, goalsDoc = null, dirty = { live: false, learn: false }, frame = 0, rates = [];
function draw() {
    frame = 0;
    if (document.hidden) return;
    if (dirty.live && live) {
        dirty.live = false;
        const shards = live.shards || [live], now = Math.max(...shards.map((s) => s.t)), wall = Date.now();
        const bots = shards.flatMap((s) => s.bots).sort((a, b) => a.env_id - b.env_id);
        const stale = shards.filter((s) => wall - s.t > 10000);
        const steps = bots.reduce((n, b) => n + (b.total.n || 0), 0);
        rates.push([wall, steps]); rates = rates.filter(([t]) => wall - t <= 60000);
        const sps = rates.length > 1 && rates[rates.length - 1][0] > rates[0][0] ? (rates[rates.length - 1][1] - rates[0][1]) / ((rates[rates.length - 1][0] - rates[0][0]) / 1000) : null;
        $('run').replaceChildren(el('span', null, `${shards.length} shard${shards.length > 1 ? 's' : ''} · ${bots.length} bots · up ${ago(Math.max(...shards.map((s) => s.up_s)) * 1000)}${sps === null || sps < 0 ? '' : ` · ${sps.toFixed(1)} steps/s (${Math.round(sps * 3600).toLocaleString()}/h)`}`),
            ...(stale.length ? [el('span', 'bad', ` · ${stale.map((s) => s.run).join(', ')}: no update for ${ago(wall - Math.min(...stale.map((s) => s.t)))}`)] : []));
        $('alerts').replaceChildren(...bots.filter((b) => b.warnings.length || !b.connected).map((b) => el('div', 'alert', `BOT #${b.env_id}: ${b.connected ? b.warnings.join('; ') : 'disconnected'}`)));
        renderBots(bots, now);
    }
    if (dirty.learn && learn) { dirty.learn = false; learner(learn); }
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
const gotLive = (d) => { live = d; dirty.live = true; schedule(); };
const gotLearn = (d) => { learn = d; dirty.learn = true; schedule(); };
const gotGoals = (d) => { goalsDoc = d; dirty.live = true; schedule(); };   // drawn into the bot cards
document.addEventListener('visibilitychange', () => { if (!document.hidden) { dirty.live = dirty.learn = true; schedule(); } });

async function poll() {
    try {
        const [lr, ll, lg] = await Promise.all(['/live.json', '/learner.json', '/goals.json'].map((u) => fetch(u, { cache: 'no-store' })));
        if (lr.ok) gotLive(await lr.json()); else $('run').textContent = 'no live data yet (environment starting?)';
        if (ll.ok) gotLearn(await ll.json());
        if (lg.ok) gotGoals(await lg.json());
    } catch (e) { $('run').textContent = `cannot reach the server: ${e.message}`; }
    setTimeout(poll, 2000);
}

if (window.EventSource) {
    const es = new EventSource('/events');
    es.addEventListener('live', (e) => gotLive(JSON.parse(e.data)));
    es.addEventListener('learner', (e) => gotLearn(JSON.parse(e.data)));
    es.addEventListener('goals', (e) => gotGoals(JSON.parse(e.data)));
    let opened = false;
    es.onopen = () => { opened = true; };
    es.onerror = () => { if (!opened) { es.close(); poll(); } else $('run').append(el('span', 'warn', ' · reconnecting…')); };
} else poll();

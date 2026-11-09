'use strict';
// Small widgets shared by the pages: sparkline, stat tile, bar, activity text, map host, job row, bot table.
function spark(values, { color = '#5794f2', w = 150, hgt = 34 } = {}) {
    const c = h('canvas', { width: w, height: hgt, class: 'spark' }), x = c.getContext('2d');
    if (values.length > 1) {
        const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(1e-9, hi - lo), pts = values.map((v, i) => [i * (w - 2) / (values.length - 1) + 1, hgt - 3 - (hgt - 8) * (v - lo) / span]);
        x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.strokeStyle = color; x.lineWidth = 1.6; x.stroke();
        x.lineTo(w - 1, hgt); x.lineTo(1, hgt); x.closePath(); x.globalAlpha = 0.15; x.fillStyle = color; x.fill();
    }
    return c;
}
const tile = (label, value, sub, sp) => h('div', { class: 'tile' }, h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value', text: value }), h('div', { class: 'tile-sub muted small', text: sub || '' }), sp || null);
const bar = (pct, cls = '') => { const b = h('div', { class: `bar ${cls}` }, h('i')); b.firstChild.style.width = `${clamp(pct, 0, 100)}%`; return b; };
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
const progText = (p) => (p.queue ? `in line ${p.queue}/${p.of}` : p.turn ? 'at the bed' : `${p.got}/${p.want}`);       // gather: got/want; set_spawn: the place in the line at the bed
// What the bot is doing NOW (owner 2026-11-09: "it says Digging but it is standing still"): the worker's activity, not the action layer's last phase, which stays set for minutes.
// A phase is shown only while it is fresh; how long the bot has not moved is shown when it is 10 s or more.
const ACT_WORDS = { claim: 'taking a unit', unit: 'working a unit', janitor: 'upkeep (chest trip)', audit: 'checking the range', sweep: 'final sweep', rescue: 'water rescue', defend: 'fighting', recover: 'fixing a failure', backoff: 'pausing after a failure', idle: 'waiting for a unit (layer above not done, or units on hold)', script: 'script', line: 'waiting in line at a chest', lift: 'moved by the server', chest: 'at the chest' };
const actText = (a) => { if (!a) return ''; const name = a.sub ? a.sub.name : a.name, s = a.sub ? a.sub.s : a.s; return `${ACT_WORDS[name] || name} ${s}s${a.phase && !a.sub ? ` · ${a.phase}` : ''}${a.still >= 10 ? ` · not moving ${a.still}s` : ''}`; };
const botActivity = (b) => { const base = b.retired ? 'waiting' : b.working ? `job ${b.job}` : b.cmd && b.cmd.status === 'running' ? `${b.cmd.name}${b.cmd.progress ? ` ${progText(b.cmd.progress)}` : '…'}` : b.state === 'online' ? 'idle' : b.state; return base + (b.act && b.working ? ` · ${actText(b.act)}` : b.phase && (b.cmd && b.cmd.status === 'running') ? ` · ${b.phase.name} ${b.phase.s}s` : '') + (b.reflex ? ` · ⚡ reflex ${b.reflex.kind} (${b.reflex.s}s ago)` : '') + (b.moved ? ` · ⇢ moved by the server ${b.moved.dist} blocks (${b.moved.why}, ${b.moved.s}s ago)` : '') + (b.problem ? ` · ⚠ ${b.problem.reason || b.problem.kind}${b.problem.cell ? ` ${[].concat(b.problem.cell).join(' ')}` : ''} (${b.problem.s}s ago)` : ''); };
const posText = (p) => (p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` : '-');

function makeMap(canvasHost, o) {                       // canvas that follows the size of its container
    const cv = h('canvas', { class: 'map-canvas', width: 900, height: 420 }); canvasHost.append(cv);
    const mv = new MapView(cv, { state: getS, players: getPlayers, ...o });
    const fitSize = () => { const r = cv.getBoundingClientRect(); if (r.width > 10 && (Math.abs(cv.width - r.width) > 2 || Math.abs(cv.height - r.height) > 2)) { cv.width = Math.round(r.width); cv.height = Math.round(r.height); mv.redraw(); } };
    if (window.ResizeObserver) new ResizeObserver(fitSize).observe(cv);
    mv.fitSize = fitSize;
    return mv;
}
/** Dimension pulldown (owner 2026-11-10): the three vanilla ones, and "other" for the id of a mod dimension (a text field appears). `.get()` is the dimension; `onchange(dim)` fires on a change. */
function dimPicker(onchange) {
    const sel = h('select', { class: 'sel', 'aria-label': 'dimension' }, [...['overworld', 'nether', 'end'].map((d) => h('option', { value: d, text: d })), h('option', { value: '__other', text: 'other (mod dimension id)...' })]);
    const other = h('input', { class: 'wide hidden', maxlength: 70, placeholder: 'twilightforest:twilight_forest', autocomplete: 'off', 'aria-label': 'dimension id' });
    const get = () => (sel.value === '__other' ? other.value.trim() || 'overworld' : sel.value), fire = () => { if (onchange) onchange(get()); };
    sel.addEventListener('change', () => { other.classList.toggle('hidden', sel.value !== '__other'); if (sel.value === '__other') other.focus(); fire(); });
    other.addEventListener('change', fire);
    return { el: h('span', { class: 'row tight' }, sel, other), get, set(v) { const known = ['overworld', 'nether', 'end'].includes(v); sel.value = known ? v : '__other'; other.classList.toggle('hidden', known); if (!known) other.value = v; } };
}
/** "View from y": the layer a map looks down from (blank = the surface; the Nether starts at 70 because its roof is bedrock). `.set(y)` follows the map's own choice. */
function sliceControl(getMap) {
    const inp = h('input', { type: 'number', class: 'num', placeholder: 'surface', min: -64, max: 320, 'aria-label': 'view from y', title: 'The map looks down from this layer and shows the first block it meets (blank = the surface). In the Nether the surface is the bedrock roof, so it starts at y 70.' });
    let t = null; inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const mv = getMap(); if (mv) mv.setSlice(inp.value === '' ? null : Number(inp.value)); }, 450); });          // a pause after typing: every layer is a fresh read of the regions
    return { el: h('span', { class: 'row tight' }, h('span', { class: 'field-label', text: 'view from y' }), inp), set(y) { inp.value = y === null || y === undefined ? '' : y; } };
}
/** Buttons that make a selecting map easier to use: Select / Pan, Clear, Bigger. */
function selectTools(getMap, host) {
    const mode = h('button', { class: 'btn small', title: 'Select: drag draws the area (drag an edge or corner of it to resize). Pan: drag moves the map (right-drag or Ctrl-drag does that in either mode)' }, 'Select');
    const set = (m) => { const mv = getMap(); if (mv) mv.setMode(m); mode.textContent = m === 'select' ? 'Select' : 'Pan'; mode.classList.toggle('primary', m === 'pan'); mode.dataset.mode = m; };
    mode.dataset.mode = 'select'; mode.addEventListener('click', () => set(mode.dataset.mode === 'select' ? 'pan' : 'select'));
    const clear = h('button', { class: 'btn small', title: 'forget the selected area (Esc)', onclick: () => { const mv = getMap(); if (mv) mv.clearSel(); } }, 'Clear');
    const big = h('button', { class: 'btn small', title: 'make the map taller' }, 'Bigger');
    big.addEventListener('click', () => { const on = host.classList.toggle('big'); big.textContent = on ? 'Smaller' : 'Bigger'; const mv = getMap(); if (mv) setTimeout(() => mv.fitSize(), 50); });
    return [mode, clear, big];
}
function jobRow(j, { compact = false } = {}) {
    const p = j.progress, pct = p.total ? Math.round(100 * p.done / p.total) : 0;
    return h('div', { class: 'jobrow' }, h('div', { class: 'row tight' }, stateDot(j.state), h('strong', { text: `${j.id} ${j.name}` }), h('span', { class: 'muted small', text: `${j.kind}${j.spec && j.spec.method ? ' ' + j.spec.method : ''} · ${j.bots.length} bots${j.lanes ? ` · ${j.lanes} lanes` : ''}${j.spec && j.spec.method && j.spec.road === false ? ' · no road' : ''}` }), h('span', { class: 'grow' }), h('span', { class: 'mono small', text: `${pct}%` })),
        bar(pct, p.stuck ? 'stuck' : ''), compact ? null : h('div', { class: 'muted small', text: `${fmt(p.done)} / ${fmt(p.total)} rows${p.stuck ? ` · ${p.stuck} stuck` : ''}` }), j.blocked ? h('div', { class: 'warn small', text: j.blocked }) : null);
}

function botTable(bots, { compact = false, selection = null, onRow = null, filter = null } = {}) {
    const rows = bots.filter((b) => !filter || filter(b));
    const t = h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, selection ? h('th', { class: 'chk' }, h('input', { type: 'checkbox', checked: rows.length && rows.every((b) => selection.has(b.name)), onchange: (e) => { rows.forEach((b) => (e.target.checked ? selection.add(b.name) : selection.delete(b.name))); onRow && onRow(null); } })) : null, ...['Bot', 'State', 'Activity', 'Position', 'HP', 'Food', compact ? null : 'Pickaxes'].filter((x) => x !== null).map((x) => h('th', { text: x })))),
        h('tbody', {}, rows.length ? rows.map((b) => h('tr', { class: onRow ? 'clickable' : '', onclick: onRow ? (e) => { if (e.target.tagName !== 'INPUT') onRow(b.name); } : null },
            selection ? h('td', { class: 'chk' }, h('input', { type: 'checkbox', checked: selection.has(b.name), onchange: (e) => { if (e.target.checked) selection.add(b.name); else selection.delete(b.name); onRow && onRow(null); } })) : null,
            h('td', {}, h('strong', { text: b.name })), h('td', {}, stateDot(b.state), ' ', b.state), h('td', {}, botActivity(b), b.retired ? h('div', { class: 'warn small', text: b.retired }) : null, b.cmd && b.cmd.status !== 'running' && !b.working ? h('div', { class: `small ${b.cmd.status === 'ok' ? 'ok' : 'warn'}`, text: `${b.cmd.name}: ${b.cmd.status}${b.cmd.result && b.cmd.result.reason ? ' (' + b.cmd.result.reason + ')' : ''}` }) : null),
            h('td', { class: 'mono', text: posText(b.pos) }), h('td', { text: b.health ?? '-' }), h('td', { text: b.food ?? '-' }), compact ? null : h('td', { text: b.state === 'online' ? b.pickaxes : '-' }))) : [h('tr', {}, h('td', { colspan: 9, class: 'muted', text: 'No bots.' }))]));
    return t;
}

/**
 * Pick bots by number (owner 2026-11-09: "from number X to number Y, working in parallel"). Works on the bot chips of a page (a `.chip` per bot with a hidden checkbox, text
 * "Work7" or "Work7 (busy)"): Select ticks exactly the bots numbered from..to, Add keeps what is ticked, "idle only" leaves out bots that already have a job, None clears.
 * The page's own change handlers do the rest, so the picked set of every page (pit, build, place) follows.
 */
function botRangePicker(chipsEl) {
    const from = h('input', { type: 'number', class: 'num', min: 0, placeholder: 'from', 'aria-label': 'first bot number', title: 'the number in the bot name: Work7 is 7' });
    const to = h('input', { type: 'number', class: 'num', min: 0, placeholder: 'to', 'aria-label': 'last bot number' });
    const idle = h('input', { type: 'checkbox', checked: true });
    const chips = () => [...chipsEl.querySelectorAll('.chip')].map((c) => { const m = /^(.*?)(\d+)(\s*\(busy\))?$/.exec(c.textContent.trim()); return { c, cb: c.querySelector('input'), n: m ? Number(m[2]) : NaN, busy: !!(m && m[3]) }; });
    const set = (x, v) => { if (x.cb.checked !== v) { x.cb.checked = v; x.cb.dispatchEvent(new Event('change', { bubbles: true })); } };
    const apply = (keep) => {
        const a = num(from.value), b = num(to.value);
        if (Number.isNaN(a) || Number.isNaN(b)) return toast('give both numbers: from and to (Work7 is number 7)', true);
        const lo = Math.min(a, b), hi = Math.max(a, b); let n = 0;
        for (const x of chips()) { const hit = x.n >= lo && x.n <= hi && !(idle.checked && x.busy); if (hit) n++; set(x, hit || (keep && x.cb.checked)); }
        toast(n ? `${n} bot${n > 1 ? 's' : ''} ticked (numbers ${lo} to ${hi})` : `no ${idle.checked ? 'idle ' : ''}bot is numbered ${lo} to ${hi}`, !n);
    };
    return h('div', { class: 'row tight', title: 'pick the bots of this job by number' },
        h('span', { class: 'muted small', text: 'by number' }), from, h('span', { class: 'muted', text: '–' }), to,
        h('button', { class: 'btn small', onclick: () => apply(false) }, 'Select'), h('button', { class: 'btn small', onclick: () => apply(true) }, 'Add'),
        h('button', { class: 'btn small ghost', onclick: () => { for (const x of chips()) set(x, false); } }, 'None'),
        h('label', { class: 'check small' }, idle, ' idle only'));
}

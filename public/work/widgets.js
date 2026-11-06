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
const botActivity = (b) => { const base = b.retired ? 'waiting' : b.working ? `job ${b.job}` : b.cmd && b.cmd.status === 'running' ? `${b.cmd.name}${b.cmd.progress ? ` ${b.cmd.progress.got}/${b.cmd.progress.want}` : '…'}` : b.state === 'online' ? 'idle' : b.state; return base + (b.phase && (b.working || (b.cmd && b.cmd.status === 'running')) ? ` · ${b.phase.name} ${b.phase.s}s` : '') + (b.problem ? ` · ⚠ ${b.problem.reason || b.problem.kind}${b.problem.cell ? ` ${[].concat(b.problem.cell).join(' ')}` : ''} (${b.problem.s}s ago)` : ''); };
const posText = (p) => (p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` : '-');

function makeMap(canvasHost, o) {                       // canvas that follows the size of its container
    const cv = h('canvas', { class: 'map-canvas', width: 900, height: 420 }); canvasHost.append(cv);
    const mv = new MapView(cv, { state: getS, players: getPlayers, ...o });
    const fitSize = () => { const r = cv.getBoundingClientRect(); if (r.width > 10 && (Math.abs(cv.width - r.width) > 2 || Math.abs(cv.height - r.height) > 2)) { cv.width = Math.round(r.width); cv.height = Math.round(r.height); mv.redraw(); } };
    if (window.ResizeObserver) new ResizeObserver(fitSize).observe(cv);
    mv.fitSize = fitSize;
    return mv;
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

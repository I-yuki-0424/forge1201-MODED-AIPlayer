'use strict';
// Work console pages (served by src/work/console.js). Layout after Grafana (panels, stat tiles, sparklines) and the AWS instance
// console (filterable table with checkboxes, bulk actions, a detail pane with tabs below). State is polled every 2 s.
let S = null, players = [], currentPage = 'overview';
const pages = {}, HIST = { t: [], online: [], done: [] };
const getS = () => S, getPlayers = () => players;
const ACTIVE = ['running', 'paused', 'ready'];

// ------------------------------------------------------------------------------------------------ login, navigation, polling
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
window.addEventListener('work-login-required', showLogin);
async function boot() {
    try { const s = await api('GET', '/api/session'); session.csrf = s.csrf; } catch (_) { return showLogin(); }
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    if (!pages.overview) buildPages();
    await refreshAll(); show(location.hash.slice(1) in pages ? location.hash.slice(1) : 'overview');
}
$('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('POST', '/api/login', { token: $('#token').value }); session.csrf = r.csrf; $('#token').value = ''; $('#loginError').textContent = ''; boot(); }
    catch (err) { $('#loginError').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { try { await api('POST', '/api/logout', {}); } catch (_) { /* gone */ } session.csrf = null; showLogin(); });

const NAV = [['overview', 'Overview', 'grid'], ['map', 'Map', 'map'], ['bots', 'Bots', 'bot'], ['pits', 'Pits', 'layers'], ['structures', 'Structures', 'box'], ['jobs', 'Jobs', 'list'], ['inventory', 'Inventory', 'pack'], ['log', 'Log', 'log']];
function show(name) {
    currentPage = name; history.replaceState(null, '', `#${name}`);
    for (const [k, p] of Object.entries(pages)) p.el.classList.toggle('hidden', k !== name);
    $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
    $('#pagetitle').textContent = (NAV.find((n) => n[0] === name) || [])[1] || '';
    if (pages[name].onShow) pages[name].onShow();
    if (S && pages[name].update) pages[name].update(S);
}
async function refreshState() { try { S = await api('GET', '/api/state'); } catch (_) { return; } sample(); renderChrome(); }
async function refreshAll() { await refreshState(); const p = pages[currentPage]; if (p && p.update && S) p.update(S); }
window.refreshAll = refreshAll;
setInterval(() => { if (session.csrf) refreshAll(); }, 2000);
async function refreshPlayers() { if (!session.csrf || !S || !S.rcon) return; try { players = await api('GET', '/api/players'); } catch (_) { players = []; } if (S) renderChrome(); const p = pages[currentPage]; if (p && p.players) p.players(); }
setInterval(refreshPlayers, 6000);

function sample() {
    const now = Date.now(); if (HIST.t.length && now - HIST.t[HIST.t.length - 1] < 4500) return;
    const done = S.jobs.reduce((n, j) => n + j.progress.done, 0);
    HIST.t.push(now); HIST.online.push(S.bots.filter((b) => b.state === 'online').length); HIST.done.push(done);
    if (HIST.t.length > 90) for (const k of Object.keys(HIST)) HIST[k].shift();
}
function renderChrome() {
    const on = S.bots.filter((b) => b.state === 'online').length, run = S.jobs.filter((j) => j.state === 'running').length;
    $('#srv').textContent = `${S.server.host}:${S.server.port}`;
    $('#chips').replaceChildren(h('span', { class: 'chip-stat' }, stateDot(on ? 'online' : 'offline'), `${on}/${S.bots.length} bots`), h('span', { class: 'chip-stat' }, stateDot(run ? 'running' : 'paused'), `${run} running`),
        h('span', { class: 'chip-stat muted' }, `${players.filter((p) => !p.bot).length} players`), S.rcon ? null : h('span', { class: 'chip-stat warn', title: 'RCON_PASSWORD missing: positions, give, inventories and teleport are off' }, 'no RCON'));
}

// ------------------------------------------------------------------------------------------------ small widgets
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
const botActivity = (b) => (b.retired ? `waiting` : b.working ? `job ${b.job}` : b.cmd && b.cmd.status === 'running' ? `${b.cmd.name}${b.cmd.progress ? ` ${b.cmd.progress.got}/${b.cmd.progress.want}` : '…'}` : b.state === 'online' ? 'idle' : b.state);
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
    return h('div', { class: 'jobrow' }, h('div', { class: 'row tight' }, stateDot(j.state), h('strong', { text: `${j.id} ${j.name}` }), h('span', { class: 'muted small', text: `${j.kind} · ${j.bots.length} bots${j.lanes ? ` · ${j.lanes} lanes` : ''}` }), h('span', { class: 'grow' }), h('span', { class: 'mono small', text: `${pct}%` })),
        bar(pct, p.stuck ? 'stuck' : ''), compact ? null : h('div', { class: 'muted small', text: `${fmt(p.done)} / ${fmt(p.total)} rows${p.stuck ? ` · ${p.stuck} stuck` : ''}` }), j.blocked ? h('div', { class: 'warn small', text: j.blocked }) : null);
}

// ------------------------------------------------------------------------------------------------ pages
function buildPages() {
    $('#nav').replaceChildren(...NAV.map(([k, t, ic]) => h('button', { 'data-page': k, onclick: () => show(k) }, icon(ic, 18), h('span', { text: t }))));
    const host = $('#page');
    const add = (name, p) => { pages[name] = p; p.el.classList.add('page', 'hidden'); host.append(p.el); };
    add('overview', overviewPage()); add('map', mapPage()); add('bots', botsPage()); add('pits', pitsPage()); add('structures', structuresPage()); add('jobs', jobsPage()); add('inventory', inventoryPage()); add('log', logPage());
}

// ---- Overview
function overviewPage() {
    const tiles = h('div', { class: 'tiles' }), mapHost = h('div', { class: 'map-host small-map' }), jobsBox = h('div'), actBox = h('div', { class: 'feed' }), botsBox = h('div');
    let mv = null;
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-12' }, tiles),
        h('div', { class: 'span-8' }, panel('Map', mapHost, { actions: [h('button', { class: 'btn small', onclick: () => mv && mv.fit() }, 'Fit'), h('button', { class: 'btn small', onclick: () => show('map') }, 'Open')] })),
        h('div', { class: 'span-4' }, panel('Jobs', jobsBox), panel('Activity', actBox)),
        h('div', { class: 'span-12' }, panel('Bots', botsBox, { actions: h('button', { class: 'btn small', onclick: () => show('bots') }, 'Manage') })));
    return {
        el,
        onShow() { if (!mv) { mv = makeMap(mapHost, { layers: { jobs: true, bots: true, players: true } }); Tiles.loadIndex('overworld').then(() => { mv.fitSize(); mv.fit(); }); } else mv.fitSize(); },
        update(s) {
            const on = s.bots.filter((b) => b.state === 'online').length, jobs = s.jobs.filter((j) => ACTIVE.includes(j.state)), done = jobs.reduce((n, j) => n + j.progress.done, 0), total = jobs.reduce((n, j) => n + j.progress.total, 0);
            const rate = HIST.t.length > 3 ? Math.max(0, (HIST.done[HIST.done.length - 1] - HIST.done[0]) / ((HIST.t[HIST.t.length - 1] - HIST.t[0]) / 60000)) : 0;
            tiles.replaceChildren(
                tile('Bots online', `${on} / ${s.bots.length}`, `${s.bots.filter((b) => b.working).length} on jobs`, spark(HIST.online, { color: '#73bf69' })),
                tile('Players', String(players.filter((p) => !p.bot).length), players.filter((p) => !p.bot).map((p) => p.name).join(', ') || (s.rcon ? 'nobody online' : 'RCON off')),
                tile('Jobs running', String(s.jobs.filter((j) => j.state === 'running').length), `${jobs.length} open · ${s.jobs.length} total`),
                tile('Rows done', total ? `${Math.round(100 * done / total)} %` : '-', total ? `${fmt(done)} of ${fmt(total)}` : 'no open job', spark(HIST.done, { color: '#ff9830' })),
                tile('Throughput', `${rate.toFixed(rate < 10 ? 1 : 0)} rows/min`, 'over the last minutes'),
                tile('Console uptime', ago(Date.now() - s.uptime), s.map ? 'map: world files' : 'no map data'));
            jobsBox.replaceChildren(...(s.jobs.length ? [...s.jobs].reverse().slice(0, 6).map((j) => jobRow(j, { compact: true })) : [h('p', { class: 'muted', text: 'No jobs yet.' })]));
            actBox.replaceChildren(...[...s.log].reverse().slice(0, 9).map((e) => h('div', { class: `feed-line ${e.level}` }, h('span', { class: 'muted mono small', text: new Date(e.t).toLocaleTimeString() }), ' ', e.msg)));
            botsBox.replaceChildren(botTable(s.bots, { compact: true }));
        },
        players() { this.update(S); },
    };
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

// ---- Map
function mapPage() {
    const host = h('div', { class: 'map-host tall-map' }), side = h('div', { class: 'maplist' }), cursor = h('span', { class: 'mono muted', text: 'x, z' });
    const dimSel = h('select', { class: 'sel', onchange: () => { mv.setDim(dimSel.value); Tiles.loadIndex(dimSel.value).then(() => mv.fit()); } }, ['overworld', 'nether', 'end'].map((d) => h('option', { value: d, text: d })));
    const layers = { jobs: true, bots: true, players: true };
    const chk = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { layers[k] = e.target.checked; mv.redraw(); } }), label);
    let mv = null;
    const refresh = act(async () => { await api('POST', '/api/map/refresh', {}); await Tiles.loadIndex(dimSel.value, true); mv.redraw(); }, 'the server saved its chunks; the map follows what is on disk');
    const el = h('div', { class: 'grid-12' }, h('div', { class: 'span-12' }, h('div', { class: 'toolbar' }, h('span', { class: 'field-label', text: 'Dimension' }), dimSel, h('button', { class: 'btn', onclick: () => mv.fit() }, 'Fit'), h('button', { class: 'btn', title: 'save-all on the server, then reload the map from disk (the map shows saved chunks)', onclick: refresh }, icon('refresh', 14), ' Refresh from server'), chk('jobs', 'jobs'), chk('bots', 'bots'), chk('players', 'players'), h('span', { class: 'grow' }), cursor)),
        h('div', { class: 'span-9' }, panel('World', host)), h('div', { class: 'span-3' }, panel('Objects', side)));
    return {
        el,
        onShow() { if (!mv) { mv = makeMap(host, { layers, onHover: (w) => { cursor.textContent = `x ${w[0]}  z ${w[1]}  · chunk ${Math.floor(w[0] / 16)}, ${Math.floor(w[1] / 16)}`; } }); Tiles.loadIndex('overworld').then(() => { mv.fitSize(); mv.fit(); }); } else mv.fitSize(); },
        update(s) {
            const item = (label, p, kind) => h('div', { class: 'maprow', onclick: () => p && mv.centerOn(p.x, p.z, Math.max(mv.view.scale, 4)) }, h('span', { class: `dot ${kind}` }), h('span', { text: label }), h('span', { class: 'mono muted small', text: p ? `${Math.round(p.x)}, ${Math.round(p.z)}` : '' }));
            side.replaceChildren(h('div', { class: 'inv-section', text: 'Players' }), ...players.filter((p) => !p.bot).map((p) => item(p.name, p.pos, 'online')), ...(players.length ? [] : [h('div', { class: 'muted small', text: s.rcon ? 'nobody online' : 'RCON off' })]),
                h('div', { class: 'inv-section', text: 'Bots' }), ...s.bots.map((b) => item(b.name, b.pos, b.state)),
                h('div', { class: 'inv-section', text: 'Jobs' }), ...s.jobs.filter((j) => ACTIVE.includes(j.state)).map((j) => item(`${j.id} ${j.name}`, { x: (j.box.x0 + j.box.x1) / 2, z: (j.box.z0 + j.box.z1) / 2 }, j.kind === 'pit' ? 'paused' : 'ready')));
            if (mv) mv.redraw();
        },
        players() { this.update(S); },
    };
}

// ---- Bots (AWS-style: filter, bulk actions, table, detail pane with tabs)
function botsPage() {
    const selection = new Set(); let focus = null, tab = 'commands', filterText = '', stateFilter = '';
    const tableBox = h('div', { class: 'table-wrap' }), bulk = h('span', { class: 'row tight' }), detail = h('div', { class: 'detail-pane' });
    const filter = h('input', { class: 'search', placeholder: 'Filter bots', oninput: (e) => { filterText = e.target.value.toLowerCase(); render(); } });
    const stateSel = h('select', { class: 'sel', onchange: (e) => { stateFilter = e.target.value; render(); } }, [['', 'All states'], ['online', 'online'], ['offline', 'offline'], ['connecting', 'connecting']].map(([v, t]) => h('option', { value: v, text: t })));
    const addBots = () => {
        const name = h('input', { placeholder: 'Work1', maxlength: 16 }), prefix = h('input', { value: 'Work', maxlength: 13 }), count = h('input', { type: 'number', class: 'num', value: 4, min: 1, max: 24 });
        const m = modal('Add bots', [h('div', { class: 'row' }, field('One bot', name), h('button', { class: 'btn primary', onclick: act(async () => { await api('POST', '/api/bots', { name: name.value.trim() }); m.close(); }, 'bot added') }, 'Add')), h('div', { class: 'sep' }),
            h('div', { class: 'row' }, field('Name prefix', prefix), field('How many', count), h('button', { class: 'btn primary', onclick: act(async () => { const r = await api('POST', '/api/bots', { prefix: prefix.value.trim(), count: num(count.value) }); m.close(); return r; }, (r) => `${r.added.length} bots added`) }, 'Add batch')),
            h('p', { class: 'muted small', text: 'Bots log in under their own name (offline mode: the network is the access control) and start in survival with an empty inventory.' })]);
    };
    const bulkBtn = (label, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: fn }, label);
    const targets = () => {
        const online = S ? S.bots.filter((b) => b.state === 'online').map((b) => b.name) : [];
        return [{ value: 'all', label: `All bots (${online.length})`, names: online }, { value: 'selected', label: `Selected (${selection.size})`, names: [...selection] }, ...(S ? S.bots : []).map((b) => ({ value: `bot:${b.name}`, label: b.name, names: [b.name] }))];
    };
    const cmdPanel = CommandPanel({ targets, S: getS, players: getPlayers });
    const tabs = h('div', { class: 'tabs' }), tabBody = h('div', { class: 'tab-body' });
    let invPage = null;
    const TABS = [['commands', 'Commands'], ['summary', 'Summary'], ['inventory', 'Inventory'], ['history', 'History']];
    function renderTabs() {
        tabs.replaceChildren(...TABS.map(([k, t]) => h('button', { class: `tab${tab === k ? ' on' : ''}`, onclick: () => { tab = k; renderTabs(); } }, k === 'commands' ? t : `${t}${focus ? ': ' + focus : ''}`)));
        tabBody.replaceChildren();
        if (tab === 'commands') { cmdPanel.syncTargets(); tabBody.append(cmdPanel.el, statusTable()); return; }
        if (!focus) { tabBody.append(h('p', { class: 'muted', text: 'Click a bot in the table to see its details here.' })); return; }
        const b = S && S.bots.find((x) => x.name === focus); if (!b) { tabBody.append(h('p', { class: 'muted', text: `${focus} is gone.` })); return; }
        if (tab === 'summary') tabBody.append(summary(b));
        if (tab === 'inventory') { invPage = InventoryPage(getS, getPlayers); invPage.a.setTarget('bot', focus); const first = players.find((p) => !p.bot); invPage.b.setTarget('operator', first ? first.name : ''); tabBody.append(invPage.el); }
        if (tab === 'history') tabBody.append(historyView(b));
    }
    function statusTable() {
        const t = cmdPanel.el.querySelector('select') ? targets().find((x) => x.value === ($$('select', cmdPanel.el)[0] || {}).value) : null;
        const names = (t && t.names.length ? t.names : S ? S.bots.map((b) => b.name) : []).slice(0, 24);
        return h('div', { class: 'cmd-status' }, h('div', { class: 'inv-section', text: 'Latest command per bot' }), h('table', { class: 'tbl' }, h('tbody', {}, names.map((n) => { const b = S && S.bots.find((x) => x.name === n); const c = b && b.cmd; return h('tr', {}, h('td', { text: n }), h('td', {}, c ? [stateDot(c.status === 'running' ? 'running' : c.status === 'ok' ? 'online' : 'offline'), ` ${c.name} · ${c.status}${c.progress ? ` ${c.progress.got}/${c.progress.want}` : ''}${c.result && c.result.reason ? ' (' + c.result.reason + ')' : ''}`] : h('span', { class: 'muted', text: 'none yet' })), h('td', { class: 'muted small', text: c && c.result && c.result.detail ? c.result.detail.slice(0, 110) : '' })); }))));
    }
    function summary(b) {
        const kv = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
        return h('div', {}, h('dl', { class: 'kv' }, ...kv('State', [stateDot(b.state), ' ', b.state]), ...kv('Activity', botActivity(b)), ...kv('Job', b.job || '-'), ...kv('Position', posText(b.pos)), ...kv('Health / food', `${b.health ?? '-'} / ${b.food ?? '-'}`), ...kv('Pickaxes', String(b.pickaxes)), ...kv('Free slots', String(b.free ?? '-')), ...kv('Retired', b.retired || '-'), ...kv('Last error', b.error || '-')),
            h('div', { class: 'row' }, b.retired ? h('button', { class: 'btn', onclick: act(() => api('POST', `/api/bots/${b.name}/resume`, {}), 'resumed') }, 'Resume') : null, h('button', { class: 'btn danger', onclick: act(() => { if (!confirm(`Remove ${b.name}?`)) throw new Error('cancelled'); focus = null; selection.delete(b.name); return api('DELETE', `/api/bots/${b.name}`); }, 'removed') }, 'Remove bot')));
    }
    function historyView(b) {
        const box = h('div'); api('GET', `/api/bots/${b.name}`).then((d) => box.replaceChildren(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['When', 'Command', 'Result', 'Time'].map((x) => h('th', { text: x })))), h('tbody', {}, (d.history.length ? d.history : []).map((x) => h('tr', {}, h('td', { text: ago(x.at) + ' ago' }), h('td', { class: 'mono small', text: `${x.name} ${JSON.stringify(x.args)}` }), h('td', { text: `${x.status}${x.reason ? ' (' + x.reason + ')' : ''}` }), h('td', { text: `${(x.ms / 1000).toFixed(1)} s` })))), d.history.length ? null : h('p', { class: 'muted', text: 'No commands sent yet.' })))).catch((e) => box.append(h('p', { class: 'err-line', text: e.message })));
        return box;
    }
    function render() {
        if (!S) return;
        tableBox.replaceChildren(botTable(S.bots, { selection, filter: (b) => (!filterText || b.name.toLowerCase().includes(filterText)) && (!stateFilter || b.state === stateFilter), onRow: (n) => { if (n) { focus = n; if (tab === 'commands') tab = 'summary'; } renderTabs(); render(); } }));
        const sel = [...selection].filter((n) => S.bots.some((b) => b.name === n));
        bulk.replaceChildren(h('span', { class: 'muted small', text: sel.length ? `${sel.length} selected` : 'Select bots to act on several at once' }),
            sel.length ? [bulkBtn('Stop commands', act(() => api('POST', '/api/commands', { bots: sel, command: 'stop', args: {} }), 'stop sent')), bulkBtn('Resume', act(async () => { for (const n of sel) await api('POST', `/api/bots/${n}/resume`, {}); }, 'resumed')),
                bulkBtn('Remove', act(async () => { if (!confirm(`Remove ${sel.length} bots?`)) throw new Error('cancelled'); for (const n of sel) await api('DELETE', `/api/bots/${n}`); selection.clear(); }, 'removed'), 'danger')] : null);
    }
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-12' }, h('div', { class: 'toolbar' }, filter, stateSel, h('span', { class: 'grow' }), bulk, h('button', { class: 'btn primary', onclick: addBots }, icon('plus', 14), ' Add bots'))),
        h('div', { class: 'span-12' }, panel('Bots', tableBox)),
        h('div', { class: 'span-12' }, panel('Details', [tabs, tabBody], { cls: 'detail' })));
    let lastKey = '';
    return {
        el, onShow() { renderTabs(); },
        update(s) {
            render();
            const key = tab + focus + s.bots.map((b) => b.name + b.state).join(',');                     // rebuild the command form only when the roster changed
            if (tab === 'commands') { cmdPanel.syncTargets(); const st = $('.cmd-status', tabBody); if (st) st.replaceWith(statusTable()); }
            if (key !== lastKey && tab !== 'commands' && tab !== 'inventory') { lastKey = key; renderTabs(); } else lastKey = key;
            if (tab === 'inventory' && invPage) invPage.tick();
        },
        players() { if (tab === 'commands') cmdPanel.refreshItems(); },
    };
}

// ---- Pits (map range selection like a spreadsheet + coordinates)
function pitsPage() {
    const f = Object.fromEntries(['x0', 'x1', 'z0', 'z1', 'top', 'depth', 'bottom'].map((k) => [k, h('input', { type: 'number', class: 'num', 'aria-label': k })]));
    f.depth.value = 3;
    const lanesIn = h('input', { type: 'number', class: 'num', min: 1, max: 32, placeholder: 'auto', title: 'one X-Z range per bot, dug down to the bottom; auto = one per bot' }), info = h('div', { class: 'info-box' }), chips = h('span', { class: 'chips' }), host = h('div', { class: 'map-host tall-map' }), name = h('input', { placeholder: 'optional', maxlength: 60 });
    const depotKind = h('select', { class: 'sel' }, [['', 'none (surplus is dropped)'], ['chest', 'chest at x y z'], ['shulker', 'shulker box (placed by the bot)']].map(([v, t]) => h('option', { value: v, text: t }))), dx = h('input', { type: 'number', class: 'num', placeholder: 'x' }), dy = h('input', { type: 'number', class: 'num', placeholder: 'y' }), dz = h('input', { type: 'number', class: 'num', placeholder: 'z' });
    const picked = new Set(); let mv = null;
    const snap = h('input', { type: 'checkbox', checked: true, onchange: () => { if (mv) mv.snapMode = snap.checked; } });
    const box = () => { const v = ['x0', 'x1', 'z0', 'z1', 'top', 'depth'].map((k) => num(f[k].value)); if (v.some(Number.isNaN)) return null; const [x0, x1, z0, z1, top, depth] = v; return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), top, bottom: top - Math.max(1, depth) + 1 }; };
    function hbox() { const v = ['x0', 'x1', 'z0', 'z1'].map((k) => num(f[k].value)); return v.some(Number.isNaN) ? null : { x0: Math.min(v[0], v[1]), x1: Math.max(v[0], v[1]), z0: Math.min(v[2], v[3]), z1: Math.max(v[2], v[3]) }; }
    function sync(fromMap) {
        const hb = hbox(), b = box();
        if (mv && !fromMap) mv.setBox(hb);                                    // the selection on the map follows the numbers, even before top and depth are known
        if (!hb) { info.textContent = 'Select an area on the map (drag over chunks), or type coordinates.'; return; }
        const w = hb.x1 - hb.x0 + 1, d = hb.z1 - hb.z0 + 1, chunks = (Math.floor(hb.x1 / 16) - Math.floor(hb.x0 / 16) + 1) * (Math.floor(hb.z1 / 16) - Math.floor(hb.z0 / 16) + 1);
        if (!b) { info.replaceChildren(h('div', {}, h('strong', { text: `${w} × ${d}` }), ` · ${chunks} chunk${chunks > 1 ? 's' : ''} selected`), h('div', { class: 'warn small', text: 'Now the top y (Top = ground reads the terrain) and the depth.' })); return; }
        const l = b.top - b.bottom + 1, cells = w * d * l, bedrock = b.bottom < -59 ? ' · bedrock below y -59 is skipped' : '', n = Math.max(1, picked.size || (S ? S.bots.filter((x) => x.state === 'online' && !x.job).length : 1));
        info.replaceChildren(h('div', {}, h('strong', { text: `${w} × ${d} × ${l}` }), ` = ${fmt(cells)} blocks · y ${b.bottom}..${b.top}${bedrock} · ${chunks} chunk${chunks > 1 ? 's' : ''} touched`), h('div', { class: 'muted small', text: `About ${Math.max(1, Math.ceil(cells * 1.4 / n / 60))} min with ${n} bot${n > 1 ? 's' : ''} (about 1.4 s a block per bot, measured). Layers are dug top-down, a haul road stays along the edge.` }));
    }
    // depth and bottom y are two views of the same number
    const fromDepth = () => { const t = num(f.top.value), d = num(f.depth.value); if (!Number.isNaN(t) && !Number.isNaN(d)) f.bottom.value = t - Math.max(1, d) + 1; };
    const fromBottom = () => { const t = num(f.top.value), b = num(f.bottom.value); if (!Number.isNaN(t) && !Number.isNaN(b)) f.depth.value = Math.max(1, t - b + 1); };
    f.depth.addEventListener('input', fromDepth); f.top.addEventListener('input', fromDepth); f.bottom.addEventListener('input', fromBottom);
    const toBottom = (y) => () => { if (Number.isNaN(num(f.top.value))) return toast('set the top y first (Top = ground)', true); f.bottom.value = y; fromBottom(); sync(false); };
    for (const k of Object.keys(f)) f[k].addEventListener('input', () => sync(false));
    const fromSel = (b) => { f.x0.value = b.x0; f.x1.value = b.x1; f.z0.value = b.z0; f.z1.value = b.z1; sync(true); };
    const ground = act(async () => {
        const b = box() || (() => { throw new Error('select an area first'); })(); const ys = [];
        for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1], [(b.x0 + b.x1) >> 1, (b.z0 + b.z1) >> 1]]) { const r = await api('GET', `/api/surface?x=${x}&z=${z}`); if (r.y !== null) ys.push(r.y); }
        if (!ys.length) throw new Error('no bot has that terrain loaded: type the top y');
        f.top.value = Math.max(...ys); sync(false);
    }, 'top = the highest ground found (corners and centre)');
    const depot = () => { const k = depotKind.value; return !k ? undefined : k === 'chest' ? { kind: 'chest', x: num(dx.value), y: num(dy.value), z: num(dz.value) } : { kind: 'shulker' }; };
    const create = (start) => act(async () => { const b = box(); if (!b) throw new Error('select an area and give top and depth'); return api('POST', '/api/jobs/pit', { name: name.value.trim() || undefined, box: b, depot: depot(), bots: [...picked], lanes: Number.isInteger(num(lanesIn.value)) ? num(lanesIn.value) : undefined, start }); }, (r) => `job ${r.id} created${start ? ' and started' : ''}`);
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-8' }, panel('Select the area', [h('p', { class: 'muted small', text: 'Drag over the map to select chunks (like a spreadsheet range); hold Alt for single blocks; Shift-drag extends; right-drag or Ctrl-drag pans; wheel zooms. The numbers on the right follow the selection and can be edited for any area.' }), host],
            { actions: [h('label', { class: 'check' }, snap, 'snap to chunks'), h('button', { class: 'btn small', onclick: () => mv && mv.fit() }, 'Fit')] })),
        h('div', { class: 'span-4' }, panel('Pit', [
            h('div', { class: 'grid-form' }, field('x from', f.x0), field('x to', f.x1), field('z from', f.z0), field('z to', f.z1), field('top y', f.top), field('depth', f.depth), field('bottom y', f.bottom), field('quick', h('span', { class: 'row tight' }, h('button', { class: 'btn small', title: 'dig down to y -59: the lowest layer that is not bedrock', onclick: toBottom(-59) }, 'to y -59'), h('button', { class: 'btn small', title: 'the bottom of the world; bedrock cells are skipped', onclick: toBottom(-64) }, '-64')))),
            h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: ground }, 'Top = ground'), h('button', { class: 'btn small', title: 'selection around the operator (needs RCON)', onclick: act(async () => { const p = (await api('GET', '/api/players')).find((q) => !q.bot && q.pos); if (!p) throw new Error('no operator position'); const b = { x0: (p.pos.x >> 4) << 4, z0: (p.pos.z >> 4) << 4 }; fromSel({ x0: b.x0, x1: b.x0 + 15, z0: b.z0, z1: b.z0 + 15 }); f.top.value = p.pos.y - 1; sync(false); }, 'the chunk the operator stands in') }, 'Operator chunk')),
            info, field('Name', name), field('Lanes', lanesIn, 'one X-Z range per bot, each dug down to the bottom'), field('Depot', h('span', { class: 'row tight' }, depotKind, dx, dy, dz)), h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Bots (none ticked: every idle bot)' }), chips),
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: create(false) }, 'Create (paused)'), h('button', { class: 'btn primary', onclick: create(true) }, icon('play', 13), ' Create and start'))])));
    return {
        el,
        onShow() { if (!mv) { mv = makeMap(host, { select: true, onSelect: fromSel, layers: { jobs: true, bots: true, players: true } }); mv.snapMode = true; Tiles.loadIndex('overworld').then(() => { mv.fitSize(); mv.fit(); }); } else mv.fitSize(); sync(false); },
        update(s) {
            for (const n of [...picked]) if (!s.bots.some((b) => b.name === n)) picked.delete(n);
            chips.replaceChildren(...(s.bots.length ? s.bots.map((b) => h('label', { class: `chip${picked.has(b.name) ? '' : ' off'}` }, h('input', { type: 'checkbox', checked: picked.has(b.name), onchange: (e) => { e.target.checked ? picked.add(b.name) : picked.delete(b.name); sync(false); update2(); } }), `${b.name}${b.job ? ' (busy)' : ''}`)) : [h('span', { class: 'muted', text: 'no bots yet' })]));
            function update2() { el.querySelectorAll('.chips .chip').forEach((c) => { const n = c.textContent.replace(' (busy)', ''); c.classList.toggle('off', !picked.has(n)); }); }
            if (mv) mv.redraw();
        },
    };
}

// ---- Structures
function structuresPage() {
    let selected = null, detail = null, ops = [];
    const listBox = h('div', { class: 'list' }), detailBox = h('div'), editBox = h('div', { class: 'hidden' }), buildBox = h('div', { class: 'hidden' });
    const selBots = new Set();
    async function load() {
        let list; try { list = await api('GET', '/api/structures'); } catch (e) { return toast(e.message, true); }
        listBox.replaceChildren(...(list.length ? list.map((s) => h('div', { class: s.name === selected ? 'on' : '', onclick: () => select(s.name) }, h('span', { text: s.name }), h('span', { class: 'muted small', text: s.error ? 'unreadable' : `${s.size.join('×')} · ${fmt(s.blocks)}${s.unknown && s.unknown.length ? ' ⚠' : ''}` }))) : [h('div', { class: 'muted', text: 'Empty. Upload a structure .nbt (structure block or Create schematic) or generate a part.' })]));
        mergeWith.replaceChildren(...list.filter((s) => !s.error).map((s) => h('option', { value: s.name, text: s.name })));
        if (!selected && list.length && !list[0].error) await select(list[0].name);
    }
    detailBox.append(h('p', { class: 'muted', text: 'Select a structure from the library, upload a .nbt, or generate a part.' }));
    const upload = h('input', { type: 'file', accept: '.nbt', class: 'hidden', onchange: act(async () => { const f = upload.files[0]; if (!f) return; const nm = f.name.replace(/\.nbt$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+/, '').slice(0, 48) || 'structure'; const r = await api('POST', `/api/structures/${nm}${over.checked ? '?overwrite=1' : ''}`, undefined, await f.arrayBuffer()); upload.value = ''; await load(); await select(nm); return r; }, (r) => `uploaded ${r.name}: ${fmt(r.blocks)} blocks`, () => {}) });
    const over = h('input', { type: 'checkbox' });
    const gk = h('select', { class: 'sel' }, ['house', 'box', 'empty'].map((v) => h('option', { value: v, text: v }))), gw = h('input', { type: 'number', class: 'num', value: 7 }), gh = h('input', { type: 'number', class: 'num', value: 4 }), gd = h('input', { type: 'number', class: 'num', value: 7 }), gb = h('input', { value: 'oak_planks', size: 14 }), gn = h('input', { placeholder: 'name', size: 10 });
    const gen = act(async () => { const r = await api('POST', '/api/structures/generate', { kind: gk.value, as: gn.value.trim(), params: { w: num(gw.value), h: num(gh.value), d: num(gd.value), block: gb.value.trim() || undefined, wall: gb.value.trim() || undefined } }); await load(); await select(r.name); return r; }, (r) => `${r.name} created`, () => {});
    const mergeWith = h('select', { class: 'sel' });
    const opsBox = h('input', { readonly: true, class: 'wide mono' }), saveAs = h('input', { placeholder: 'new-name', size: 16 }), saveOver = h('input', { type: 'checkbox' });
    const push = (op) => { ops.push(op); opsBox.value = JSON.stringify(ops).slice(0, 400); };
    const inp = (ph, w = 'num') => h('input', { type: 'number', class: w, placeholder: ph });
    const [c0, c1, c2, c3, c4, c5] = ['x0', 'y0', 'z0', 'x1', 'y1', 'z1'].map((p) => inp(p));
    const repFrom = h('input', { placeholder: 'oak_planks', size: 16 }), repTo = h('input', { placeholder: 'spruce_planks', size: 16 }), rmNames = h('input', { placeholder: 'glass, torch', size: 20 });
    const [mx, my, mz] = [0, 0, 0].map((v, i) => h('input', { type: 'number', class: 'num', value: v, placeholder: 'xyz'[i] })), mrot = h('select', { class: 'sel' }, [0, 1, 2, 3].map((v) => h('option', { value: v, text: `${v * 90}°` })));
    const layerY = h('input', { type: 'range', min: 0, max: 0, value: 0 }), layerLbl = h('span', { class: 'mono', text: '0' }), hover = h('span', { class: 'muted small mono' }), layerCv = h('canvas', { class: 'layer-canvas' });
    async function drawLayer() {
        const y = Number(layerY.value); layerLbl.textContent = y; let L; try { L = await api('GET', `/api/structures/${selected}/layer/${y}`); } catch (_) { return; }
        const z = Math.max(4, Math.min(24, Math.floor(520 / Math.max(L.w, L.d)))); layerCv.width = L.w * z; layerCv.height = L.d * z; const c = layerCv.getContext('2d');
        c.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg'); c.fillRect(0, 0, layerCv.width, layerCv.height);
        const cols = L.palette.map(colorOfName); L.grid.forEach((s, i) => { if (s < 0) return; c.fillStyle = cols[s]; c.fillRect((i % L.w) * z, Math.floor(i / L.w) * z, z - 1, z - 1); });
        layerCv.onmousemove = (ev) => { const r = layerCv.getBoundingClientRect(), gx = Math.floor((ev.clientX - r.left) * layerCv.width / r.width / z), gz = Math.floor((ev.clientY - r.top) * layerCv.height / r.height / z), s = L.grid[gz * L.w + gx]; hover.textContent = `x ${gx} z ${gz}: ${s >= 0 ? L.palette[s] : 'empty'}`; };
    }
    layerY.addEventListener('input', drawLayer);
    async function select(name) {
        selected = name; ops = []; opsBox.value = '';
        try { detail = await api('GET', `/api/structures/${name}`); } catch (e) { return toast(e.message, true); }
        $$('.list > div', listBox).forEach((d) => d.classList.toggle('on', d.firstChild.textContent === name));
        layerY.max = detail.size[1] - 1; layerY.value = 0;
        detailBox.replaceChildren(h('div', { class: 'row' }, h('strong', { text: name }), h('span', { class: 'muted', text: `${detail.size.join(' × ')} (x, y, z) · ${fmt(detail.blocks)} blocks · ${detail.blockEntities} block entities${detail.mods.length ? ' · mods: ' + detail.mods.join(', ') : ''}` })),
            detail.unknown.length ? h('div', { class: 'warn', text: `Not in the bots' registry, will be skipped: ${detail.unknown.join(', ')}` }) : null,
            h('div', { class: 'small muted', text: detail.names.slice(0, 14).map((n) => `${n.name.replace('minecraft:', '')} ${fmt(n.n)}`).join(', ') + (detail.names.length > 14 ? ', …' : '') }),
            h('div', { class: 'row' }, h('label', {}, 'layer y ', layerY, layerLbl), hover), layerCv,
            h('div', { class: 'row' }, h('a', { href: `/api/structures/${name}/download`, download: `${name}.nbt` }, h('button', { class: 'btn small' }, 'Download .nbt')),
                h('button', { class: 'btn small danger', onclick: act(async () => { if (!confirm(`Delete ${name}?`)) throw new Error('cancelled'); await api('DELETE', `/api/structures/${name}`); selected = null; detail = null; detailBox.replaceChildren(); editBox.classList.add('hidden'); buildBox.classList.add('hidden'); await load(); }, 'deleted', () => {}) }, 'Delete')));
        saveAs.value = `${name}-2`; editBox.classList.remove('hidden'); buildBox.classList.remove('hidden'); drawLayer();
    }
    const btn = (t, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: fn }, t);
    const save = act(async () => { if (!ops.length) throw new Error('add at least one step'); const r = await api('POST', `/api/structures/${selected}/edit`, { ops, as: saveOver.checked ? undefined : saveAs.value.trim(), overwrite: saveOver.checked }); await load(); await select(r.name); return r; }, (r) => `saved ${r.name} (${r.size.join('×')})`, () => {});
    editBox.append(...[panel('Edit (steps run in order on a copy)', [
        h('p', { class: 'muted small', text: 'Block states survive; stored world positions inside block-entity data (Create contraptions) do not move.' }),
        h('div', { class: 'row' }, btn('Rotate ↻ 90°', () => push({ op: 'rotate', turns: 1 })), btn('↺ 90°', () => push({ op: 'rotate', turns: 3 })), btn('180°', () => push({ op: 'rotate', turns: 2 })), btn('Mirror x', () => push({ op: 'mirror', axis: 'x' })), btn('Mirror z', () => push({ op: 'mirror', axis: 'z' }))),
        h('div', { class: 'row' }, field('replace', repFrom), field('with', repTo), btn('Replace', () => { if (repFrom.value.trim() && repTo.value.trim()) push({ op: 'replace', from: repFrom.value.trim(), to: repTo.value.trim() }); })),
        h('div', { class: 'row' }, field('remove', rmNames), btn('Remove', () => { const n = rmNames.value.split(',').map((s) => s.trim()).filter(Boolean); if (n.length) push({ op: 'remove', names: n }); })),
        h('div', { class: 'row' }, field('crop', h('span', { class: 'row tight' }, c0, c1, c2, c3, c4, c5)), btn('Crop', () => { const v = [c0, c1, c2, c3, c4, c5].map((i) => num(i.value)); if (!v.some(Number.isNaN)) push({ op: 'crop', box: { x0: v[0], y0: v[1], z0: v[2], x1: v[3], y1: v[4], z1: v[5] } }); })),
        h('div', { class: 'row' }, field('add part', mergeWith), field('at', h('span', { class: 'row tight' }, mx, my, mz, mrot)), btn('Merge', () => { if (mergeWith.value) push({ op: 'merge', parts: [{ name: mergeWith.value, x: num(mx.value) || 0, y: num(my.value) || 0, z: num(mz.value) || 0, rotate: Number(mrot.value) }] }); })),
        h('div', { class: 'row' }, field('steps so far', opsBox), btn('Clear', () => { ops = []; opsBox.value = ''; }, 'ghost')),
        h('div', { class: 'row' }, field('save as', saveAs), h('label', { class: 'check' }, saveOver, 'overwrite'), h('button', { class: 'btn primary', onclick: save }, 'Save result'))])]);
    const bx = inp('x'), by = inp('y'), bz = inp('z'), brot = h('select', { class: 'sel' }, [0, 1, 2, 3].map((v) => h('option', { value: v, text: `${v * 90}°` }))), bmirror = h('input', { type: 'checkbox' }), bname = h('input', { placeholder: 'optional', maxlength: 60 }), bchips = h('span', { class: 'chips' });
    const buildCreate = (start) => act(async () => { const o = { x: num(bx.value), y: num(by.value), z: num(bz.value) }; if (Object.values(o).some(Number.isNaN)) throw new Error('set the origin'); const steps = []; if (bmirror.checked) steps.push({ op: 'mirror', axis: 'x' }); if (Number(brot.value)) steps.push({ op: 'rotate', turns: Number(brot.value) }); return api('POST', '/api/jobs/build', { structure: selected, origin: o, ops: steps, name: bname.value.trim() || undefined, bots: [...selBots], start }); }, (r) => `job ${r.id} created${start ? ' and started' : ''}`);
    buildBox.append(panel('Build', [
        h('div', { class: 'row' }, field('origin x', bx), field('y', by), field('z', bz), btn('Pick on map', async () => { const p = await pickPoint('Pick the origin (minimum corner)', getS, getPlayers); if (!p) return; bx.value = p.x; bz.value = p.z; try { const g = await api('GET', `/api/surface?x=${p.x}&z=${p.z}`); if (g.y !== null) by.value = g.y + 1; } catch (_) { /* y by hand */ } }), btn('= operator', act(async () => { const p = (await api('GET', '/api/players')).find((q) => !q.bot && q.pos); if (!p) throw new Error('no operator position'); bx.value = p.pos.x; by.value = p.pos.y; bz.value = p.pos.z; }, null, () => {}))),
        h('div', { class: 'row' }, field('rotate', brot), h('label', { class: 'check' }, bmirror, 'mirror x'), field('name', bname)),
        h('p', { class: 'muted small', text: 'The origin is the minimum corner (lowest x, y, z) at ground level: layer 0 is placed at y. y is the first free block above the ground.' }),
        h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Bots (none ticked: every idle bot)' }), bchips),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: buildCreate(false) }, 'Create (paused)'), h('button', { class: 'btn primary', onclick: buildCreate(true) }, icon('play', 13), ' Create and start'))]));
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-4' }, panel('Library', [listBox, h('div', { class: 'row' }, h('label', { class: 'btn small' }, 'Upload .nbt', upload), h('label', { class: 'check' }, over, 'overwrite')),
            h('details', {}, h('summary', { text: 'Generate a part' }), h('div', { class: 'row' }, gk, field('w', gw), field('h', gh), field('d', gd), field('block', gb), field('name', gn), btn('Generate', gen))) ])),
        h('div', { class: 'span-8' }, panel('Structure', detailBox), editBox, buildBox));
    return {
        el, onShow() { load(); },
        update(s) { for (const n of [...selBots]) if (!s.bots.some((b) => b.name === n)) selBots.delete(n); bchips.replaceChildren(...(s.bots.length ? s.bots.map((b) => h('label', { class: `chip${selBots.has(b.name) ? '' : ' off'}` }, h('input', { type: 'checkbox', checked: selBots.has(b.name), onchange: (e) => { e.target.checked ? selBots.add(b.name) : selBots.delete(b.name); e.target.closest('.chip').classList.toggle('off', !e.target.checked); } }), `${b.name}${b.job ? ' (busy)' : ''}`)) : [h('span', { class: 'muted', text: 'no bots yet' })])); },
    };
}

// ---- Jobs
function jobsPage() {
    const box = h('div'); let open = null, detail = null;
    async function loadDetail() { if (!open) return; try { detail = await api('GET', `/api/jobs/${open}`); } catch (_) { detail = null; } }
    setInterval(async () => { if (session.csrf && open && currentPage === 'jobs') { await loadDetail(); render(); } }, 4000);
    function render() {
        if (!S) return; box.replaceChildren();
        if (!S.jobs.length) box.append(panel('Jobs', h('p', { class: 'muted', text: 'No jobs. Select an area in Pits or build a structure.' })));
        for (const j of [...S.jobs].reverse()) {
            const p = j.progress, row = h('div', { class: 'row' });
            if (['ready', 'paused'].includes(j.state)) row.append(h('button', { class: 'btn primary small', onclick: act(() => api('POST', `/api/jobs/${j.id}/start`, {}), 'started') }, icon('play', 12), ' Start'));
            if (j.state === 'running') row.append(h('button', { class: 'btn small', onclick: act(() => api('POST', `/api/jobs/${j.id}/pause`, {}), 'paused') }, icon('pause', 12), ' Pause'));
            if (ACTIVE.includes(j.state)) {
                row.append(h('button', { class: 'btn small', onclick: act(() => api('POST', `/api/jobs/${j.id}/assign`, { bots: S.bots.filter((b) => b.state === 'online' && !b.job).map((b) => b.name) }), 'assigned') }, 'Add idle bots'));
                row.append(h('button', { class: 'btn small danger', onclick: act(() => { if (!confirm(`Cancel ${j.id}? Progress in the world stays.`)) throw new Error('cancelled'); return api('POST', `/api/jobs/${j.id}/cancel`, {}); }, 'cancelled') }, 'Cancel'));
            }
            if (p.stuck) row.append(h('button', { class: 'btn small', onclick: act(() => api('POST', `/api/jobs/${j.id}/repair`, {}), (r) => `${r.requeued} units queued again`) }, `Retry ${p.stuck} stuck`));
            if (j.kind === 'build' && S.rcon && ACTIVE.includes(j.state)) row.append(h('button', { class: 'btn small', title: 'give the bots the blocks this build needs', onclick: act(() => api('POST', `/api/jobs/${j.id}/supply`, {}), 'materials given') }, 'Give materials'));
            row.append(h('button', { class: 'btn small ghost', onclick: async () => { open = open === j.id ? null : j.id; detail = null; await loadDetail(); render(); } }, 'Details'));
            if (!['running', 'paused'].includes(j.state)) row.append(h('button', { class: 'btn small ghost danger', onclick: act(() => api('DELETE', `/api/jobs/${j.id}`), 'deleted') }, 'Delete'));
            const body = [jobRow(j), h('div', { class: 'muted small', text: `bots: ${j.bots.join(', ') || 'none'}${j.diff !== null && j.diff !== undefined ? ` · missing blocks after the run: ${j.diff}` : ''} · box ${j.box.x0},${j.box.z0} → ${j.box.x1},${j.box.z1} y ${j.box.y0}..${j.box.y1}` }),
                j.summary && j.summary.unsupported && j.summary.unsupported.length ? h('div', { class: 'warn small', text: `not placeable (not in the bots' registry): ${j.summary.unsupported.join(', ')}` }) : null,
                j.kind === 'build' && j.summary && j.summary.materials ? h('div', { class: 'small muted', text: 'needs: ' + Object.entries(j.summary.materials).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') }) : null, row];
            if (open === j.id && detail) { body.push(h('div', { class: 'small' }, 'Per bot: ' + Object.entries(detail.report.bots).map(([n, b]) => `${n} ${b.done} done / ${b.failed} failed / ${b.faults} own faults${b.alive ? '' : ' (left)'}`).join(' · '))); if (detail.report.stuck.length) body.push(h('div', { class: 'warn small', text: 'Stuck: ' + detail.report.stuck.slice(0, 12).map((s) => `${s.region} layer ${s.layer} row ${s.row} (${s.reason})`).join('; ') })); }
            box.append(panel(`${j.id} · ${j.kind}`, body, { actions: h('span', { class: `pill ${j.state}`, text: j.state }) }));
        }
    }
    return { el: h('div', {}, box), update() { render(); } };
}

// ---- Inventory
function inventoryPage() {
    let inv = null; const host = h('div');
    return {
        el: host,
        onShow() { if (!inv) { inv = InventoryPage(getS, getPlayers); host.append(inv.el); const first = players.find((p) => !p.bot), bot = S && S.bots.find((b) => b.state === 'online'); if (bot) inv.a.setTarget('bot', bot.name); if (first) inv.b.setTarget('operator', first.name); } inv.tick(); },
        update() { if (inv && currentPage === 'inventory') inv.tick(); },
        players() { if (inv) inv.tick(); },
    };
}

// ---- Log
function logPage() {
    const pre = h('pre', { class: 'logbox' });
    return { el: panel('Log', pre), update(s) { pre.textContent = [...s.log].reverse().map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.msg}`).join('\n'); } };
}

boot();

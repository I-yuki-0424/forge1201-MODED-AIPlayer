'use strict';
// Work console front end (served by src/work/console.js). No inline script, no innerHTML: every value from the server is set with
// textContent. State is polled (GET /api/state every 2 s); forms are static in index.html and only lists are re-rendered.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
}
const num = (id) => { const v = $(id).value; return v === '' ? NaN : Number(v); };
const fmt = (n) => Number(n).toLocaleString('en-US');

let csrf = null, S = null, players = [], selected = null, detail = null, ops = [], mapPick = null, view = { cx: 0, cz: 0, scale: 4 }, draft = {};
const selBots = { pit: new Set(), build: new Set() };

// ------------------------------------------------------------------------------------------------ api
async function api(method, url, body, raw) {
    const headers = {};
    if (csrf) headers['X-CSRF'] = csrf;
    let payload;
    if (raw !== undefined) { headers['Content-Type'] = 'application/octet-stream'; payload = raw; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('login required'); }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}
let toastTimer = null;
function toast(msg, bad = false) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 8000 : 3500);
}
const act = (fn, ok) => async (...a) => { try { const r = await fn(...a); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); await refresh(); return r; } catch (e) { toast(e.message, true); } };

// ------------------------------------------------------------------------------------------------ login, tabs
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
async function boot() {
    try { const s = await api('GET', '/api/session'); csrf = s.csrf; } catch (_) { return showLogin(); }
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    await refresh(); await loadStructures(); loopPlayers(); fit();
}
$('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('POST', '/api/login', { token: $('#token').value }); csrf = r.csrf; $('#token').value = ''; $('#loginError').textContent = ''; boot(); }
    catch (err) { $('#loginError').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { try { await api('POST', '/api/logout', {}); } catch (_) { /* gone */ } csrf = null; showLogin(); });
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'map') drawMap();
}));

// ------------------------------------------------------------------------------------------------ state
async function refresh() {
    try { S = await api('GET', '/api/state'); } catch (_) { return; }
    $('#srv').textContent = `${S.server.host}:${S.server.port}${S.rcon ? ' · RCON' : ' · no RCON'}`;
    const on = S.bots.filter((b) => b.state === 'online').length, run = S.jobs.filter((j) => j.state === 'running').length;
    $('#summary').textContent = `${on}/${S.bots.length} bots online · ${run} job${run === 1 ? '' : 's'} running`;
    $('#autoKit').checked = !!S.settings.autoKit; $('#autoKit').disabled = !S.rcon;
    renderBots(); renderChips('pitBots', 'pit'); renderChips('buildBots', 'build'); renderJobs(); renderLog(); drawMap();
    if (selected && detail) { /* keep the open structure */ }
}
setInterval(() => { if (csrf) refresh(); }, 2000);

// ------------------------------------------------------------------------------------------------ bots
function renderBots() {
    const tb = $('#botTable tbody'); tb.replaceChildren();
    if (!S.bots.length) tb.append(h('tr', {}, h('td', { colspan: 9, class: 'muted', text: 'No bots yet. Add some above.' })));
    for (const b of S.bots) {
        const p = b.pos ? `${Math.round(b.pos.x)}, ${Math.round(b.pos.y)}, ${Math.round(b.pos.z)}` : '-';
        tb.append(h('tr', {},
            h('td', { text: b.name }),
            h('td', {}, h('span', { class: `badge ${b.state}`, text: b.state }), b.working ? ' working' : '', b.retired ? h('div', { class: 'warn small', text: b.retired }) : '', b.error && b.state !== 'online' ? h('div', { class: 'muted small', text: b.error }) : ''),
            h('td', { text: b.job || '-' }), h('td', { class: 'nowrap', text: p }), h('td', { text: b.health ?? '-' }), h('td', { text: b.food ?? '-' }), h('td', { text: b.state === 'online' ? b.pickaxes : '-' }), h('td', { text: b.free ?? '-' }),
            h('td', { class: 'nowrap' },
                b.retired ? h('button', { text: 'Resume', title: 'clear the retirement and put the bot back to work', onclick: act(() => api('POST', `/api/bots/${b.name}/resume`, {}), 'resumed') }) : '', ' ',
                S.rcon ? h('button', { class: 'ghost', text: 'Kit', title: 'give what is missing (pickaxes, blocks, bread)', onclick: act(() => api('POST', `/api/bots/${b.name}/kit`, {}), (r) => r.given.length ? `gave ${r.given.join(', ')}` : 'already has the kit') }) : '',
                ' ', h('button', { class: 'danger ghost', text: 'Remove', onclick: act(() => { if (!confirm(`Remove ${b.name}?`)) throw new Error('cancelled'); return api('DELETE', `/api/bots/${b.name}`); }, 'removed') }))));
    }
}
$('#botAdd').addEventListener('click', act(() => api('POST', '/api/bots', { name: $('#botName').value.trim() }), 'bot added'));
$('#botBatch').addEventListener('click', act(() => api('POST', '/api/bots', { prefix: $('#botPrefix').value.trim(), count: num('#botCount') }), (r) => `${r.added.length} bots added`));
$('#autoKit').addEventListener('change', act(() => api('POST', '/api/settings', { autoKit: $('#autoKit').checked })));

function renderChips(id, key) {
    const box = $(`#${id}`), want = new Set(S.bots.map((b) => b.name));
    for (const n of [...selBots[key]]) if (!want.has(n)) selBots[key].delete(n);
    box.replaceChildren(...(S.bots.length ? S.bots.map((b) => {
        const busy = b.job && S.jobs.find((j) => j.id === b.job && ['running', 'paused', 'ready'].includes(j.state));
        return h('label', { class: `chip${selBots[key].has(b.name) ? '' : ' off'}`, title: busy ? `works on ${b.job}` : b.state },
            h('input', { type: 'checkbox', checked: selBots[key].has(b.name), onchange: (e) => { if (e.target.checked) selBots[key].add(b.name); else selBots[key].delete(b.name); renderChips(id, key); } }),
            `${b.name}${busy ? ' (busy)' : ''}`);
    }) : [h('span', { class: 'muted', text: 'none yet; with none ticked, every idle bot joins' })]));
}

// ------------------------------------------------------------------------------------------------ players, picking
async function loopPlayers() {
    const load = async () => {
        if (!csrf || !S || !S.rcon) { $('#pPlayerNote').textContent = S && !S.rcon ? 'RCON is off: type the coordinates' : ''; return; }
        try { players = await api('GET', '/api/players'); } catch (e) { players = []; $('#pPlayerNote').textContent = e.message; return; }
        const sel = $('#pPlayer'), keep = sel.value;
        sel.replaceChildren(...players.filter((p) => !p.bot).map((p) => h('option', { value: p.name, text: p.name })));
        if (keep && players.some((p) => p.name === keep)) sel.value = keep;
        $('#pPlayerNote').textContent = players.length ? '' : 'nobody online';
    };
    await load(); setInterval(load, 8000);
    $('#pPlayers').addEventListener('click', load); $('#mapplayers').addEventListener('click', load);
}
const me = () => { const p = players.find((q) => q.name === $('#pPlayer').value); if (!p || !p.pos) { toast('no position: is the player online?', true); return null; } return p; };
async function groundAt(x, z) { const r = await api('GET', `/api/surface?x=${x}&z=${z}`); return r.y; }

// ------------------------------------------------------------------------------------------------ pits
const pitBox = () => {
    const v = ['#pax', '#paz', '#pbx', '#pbz', '#ptop', '#pdepth'].map(num);
    if (v.some(Number.isNaN)) return null;
    const [ax, az, bx, bz, top, depth] = v;
    return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), z0: Math.min(az, bz), z1: Math.max(az, bz), top, bottom: top - Math.max(1, depth) + 1 };
};
function pitInfo() {
    const b = pitBox(); draft.pit = b;
    if (!b) { $('#pitInfo').textContent = ''; return drawMap(); }
    const w = b.x1 - b.x0 + 1, d = b.z1 - b.z0 + 1, l = b.top - b.bottom + 1, cells = w * d * l, n = Math.max(1, selBots.pit.size || S?.bots.filter((x) => x.state === 'online' && !x.job).length || 1);
    $('#pitInfo').textContent = `${w} × ${d} × ${l} = ${fmt(cells)} blocks, y ${b.bottom}..${b.top}. About ${Math.ceil(cells * 1.2 / n / 60)} min with ${n} bot${n > 1 ? 's' : ''} (about 1.2 s a block per bot, measured).`;
    drawMap();
}
['#pax', '#paz', '#pbx', '#pbz', '#ptop', '#pdepth'].forEach((id) => $(id).addEventListener('input', pitInfo));
$('#paMe').addEventListener('click', () => { const p = me(); if (p) { $('#pax').value = p.pos.x; $('#paz').value = p.pos.z; pitInfo(); } });
$('#pbMe').addEventListener('click', () => { const p = me(); if (p) { $('#pbx').value = p.pos.x; $('#pbz').value = p.pos.z; pitInfo(); } });
$('#paMap').addEventListener('click', () => pickOnMap('Corner A', (x, z) => { $('#pax').value = x; $('#paz').value = z; pitInfo(); }));
$('#pbMap').addEventListener('click', () => pickOnMap('Corner B', (x, z) => { $('#pbx').value = x; $('#pbz').value = z; pitInfo(); }));
$('#pSurface').addEventListener('click', act(async () => {
    const b = pitBox() || {}; const xs = [num('#pax'), num('#pbx')], zs = [num('#paz'), num('#pbz')];
    if ([...xs, ...zs].some(Number.isNaN)) throw new Error('set both corners first');
    const ys = []; for (const x of xs) for (const z of zs) { const y = await groundAt(x, z); if (y !== null) ys.push(y); }
    if (!ys.length) throw new Error('terrain not loaded near any bot: type the top y');
    $('#ptop').value = Math.max(...ys); pitInfo(); return b;
}, 'top set to the highest ground at the corners'));
const depotOf = () => {
    const k = $('#depotKind').value; if (!k) return undefined;
    return k === 'chest' ? { kind: 'chest', x: num('#dx'), y: num('#dy'), z: num('#dz') } : { kind: 'shulker' };
};
const createPit = (start) => act(async () => {
    const box = pitBox(); if (!box) throw new Error('fill in both corners, top and depth');
    return api('POST', '/api/jobs/pit', { name: $('#pitName').value.trim() || undefined, box, depot: depotOf(), bots: [...selBots.pit], start });
}, (r) => `job ${r.id} created${start ? ' and started' : ''}`);
$('#pitCreate').addEventListener('click', createPit(false)); $('#pitStart').addEventListener('click', createPit(true));

// ------------------------------------------------------------------------------------------------ jobs
function renderJobs() {
    const box = $('#jobList'); box.replaceChildren();
    if (!S.jobs.length) box.append(h('p', { class: 'muted', text: 'No jobs. Designate a pit or build a structure.' }));
    for (const j of [...S.jobs].reverse()) {
        const p = j.progress, pct = p.total ? Math.round(100 * p.done / p.total) : 0;
        const card = h('div', { class: 'card' },
            h('div', { class: 'row' }, h('strong', { text: `${j.id} · ${j.name}` }), h('span', { class: `badge ${j.state}`, text: j.state }), h('span', { class: 'muted', text: j.kind }),
                j.workers !== undefined && j.state === 'running' ? h('span', { class: j.workers ? 'muted' : 'warn', text: `${j.workers} working` }) : ''),
            h('div', { class: `bar${p.stuck ? ' stuck' : ''}` }, h('i')),
            h('div', { class: 'small muted', text: `${fmt(p.done)} / ${fmt(p.total)} rows (${pct} %)${p.stuck ? ` · ${p.stuck} stuck` : ''}${p.leased ? ` · ${p.leased} in progress` : ''} · bots: ${j.bots.join(', ') || 'none'}${j.diff !== null && j.diff !== undefined ? ` · missing blocks after the run: ${j.diff}` : ''}` }));
        card.querySelector('.bar > i').style.width = `${pct}%`;
        if (j.blocked) card.append(h('div', { class: 'warn', text: j.blocked }));
        if (j.summary && j.summary.unsupported && j.summary.unsupported.length) card.append(h('div', { class: 'warn small', text: `not placeable (not in the bots' registry): ${j.summary.unsupported.join(', ')}` }));
        const row = h('div', { class: 'row' });
        if (['ready', 'paused'].includes(j.state)) row.append(h('button', { class: 'primary', text: 'Start', onclick: act(() => api('POST', `/api/jobs/${j.id}/start`, {}), 'started') }));
        if (j.state === 'running') row.append(h('button', { text: 'Pause', onclick: act(() => api('POST', `/api/jobs/${j.id}/pause`, {}), 'paused') }));
        if (['running', 'paused', 'ready'].includes(j.state)) {
            row.append(h('button', { text: 'Add idle bots', onclick: act(() => api('POST', `/api/jobs/${j.id}/assign`, { bots: S.bots.filter((b) => b.state === 'online' && !b.job).map((b) => b.name) }), 'assigned') }));
            row.append(h('button', { class: 'danger', text: 'Cancel', onclick: act(() => { if (!confirm(`Cancel ${j.id}? Progress in the world stays.`)) throw new Error('cancelled'); return api('POST', `/api/jobs/${j.id}/cancel`, {}); }, 'cancelled') }));
        }
        if (p.stuck) row.append(h('button', { text: `Retry ${p.stuck} stuck`, onclick: act(() => api('POST', `/api/jobs/${j.id}/repair`, {}), (r) => `${r.requeued} units queued again`) }));
        if (j.kind === 'build' && S.rcon && ['running', 'paused', 'ready'].includes(j.state)) row.append(h('button', { class: 'ghost', title: 'give the bots the blocks this build needs', text: 'Give materials', onclick: act(() => api('POST', `/api/jobs/${j.id}/supply`, {}), 'materials given') }));
        row.append(h('button', { class: 'ghost', text: 'Details', onclick: () => showDetail(j.id, card) }));
        if (!['running', 'paused'].includes(j.state)) row.append(h('button', { class: 'ghost danger', text: 'Delete', onclick: act(() => api('DELETE', `/api/jobs/${j.id}`), 'deleted') }));
        card.append(row);
        if (j.kind === 'build' && j.summary && j.summary.materials) card.append(h('div', { class: 'small muted', text: 'needs: ' + Object.entries(j.summary.materials).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') }));
        card.append(h('div', { class: 'detail', 'data-job': j.id }));
        box.append(card);
        if (openDetail === j.id) fillDetail(card.querySelector('.detail'));
    }
}
let openDetail = null, lastDetail = null;
async function showDetail(id, card) {
    openDetail = openDetail === id ? null : id;
    if (openDetail) { try { lastDetail = await api('GET', `/api/jobs/${id}`); } catch (e) { toast(e.message, true); } }
    renderJobs();
}
function fillDetail(el) {
    const d = lastDetail; if (!d) return;
    el.append(h('div', { class: 'small', text: 'Per bot: ' + Object.entries(d.report.bots).map(([n, b]) => `${n} ${b.done} done / ${b.failed} failed / ${b.faults} own faults${b.alive ? '' : ' (left)'}`).join(' · ') }));
    if (d.report.stuck.length) el.append(h('div', { class: 'warn small', text: 'Stuck: ' + d.report.stuck.slice(0, 12).map((s) => `${s.region} layer ${s.layer} row ${s.row} (${s.reason})`).join('; ') }));
    el.append(h('div', { class: 'small muted', text: `${d.regions.length} regions; ${d.regions.filter((r) => r.done === r.n).length} complete` }));
}
setInterval(async () => { if (csrf && openDetail) { try { lastDetail = await api('GET', `/api/jobs/${openDetail}`); } catch (_) { /* gone */ } } }, 4000);

function renderLog() {
    $('#logBox').textContent = [...S.log].reverse().map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.msg}`).join('\n');
}

// ------------------------------------------------------------------------------------------------ structures
async function loadStructures() {
    let list; try { list = await api('GET', '/api/structures'); } catch (e) { return toast(e.message, true); }
    const box = $('#structList'); box.replaceChildren();
    if (!list.length) box.append(h('div', { class: 'muted', text: 'Empty. Upload a structure .nbt (structure block or Create schematic) or generate a part.' }));
    for (const s of list) box.append(h('div', { class: s.name === selected ? 'on' : '', onclick: () => selectStructure(s.name) },
        h('span', { text: s.name }), h('span', { class: 'muted small', text: s.error ? 'unreadable' : `${s.size.join('×')} · ${fmt(s.blocks)}${s.unknown && s.unknown.length ? ' ⚠' : ''}` })));
    $('#mergeWith').replaceChildren(...list.filter((s) => !s.error).map((s) => h('option', { value: s.name, text: s.name })));
}
$('#structUpload').addEventListener('change', act(async () => {
    const f = $('#structUpload').files[0]; if (!f) return;
    const name = f.name.replace(/\.nbt$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+/, '').slice(0, 48) || 'structure';
    const r = await api('POST', `/api/structures/${name}${$('#structOverwrite').checked ? '?overwrite=1' : ''}`, undefined, await f.arrayBuffer());
    $('#structUpload').value = ''; await loadStructures(); await selectStructure(name); return r;
}, (r) => `uploaded ${r.name}: ${fmt(r.blocks)} blocks`));
$('#genGo').addEventListener('click', act(async () => {
    const kind = $('#genKind').value, as = $('#gname').value.trim();
    const r = await api('POST', '/api/structures/generate', { kind, as, params: { w: num('#gw'), h: num('#gh'), d: num('#gd'), block: $('#gblock').value.trim() || undefined, wall: $('#gblock').value.trim() || undefined } });
    await loadStructures(); await selectStructure(r.name); return r;
}, (r) => `${r.name} created`));

const colorOf = (name) => { let x = 7; for (const c of name.replace(/\[.*/, '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${x % 360} ${45 + (x >> 8) % 35}% ${38 + (x >> 16) % 30}%)`; };
async function selectStructure(name) {
    selected = name; ops = []; $('#ops').value = '';
    try { detail = await api('GET', `/api/structures/${name}`); } catch (e) { return toast(e.message, true); }
    $$('#structList > div').forEach((d) => d.classList.toggle('on', d.firstChild.textContent === name));
    const box = $('#structDetail'); box.replaceChildren(h('h2', { text: name }),
        h('div', { text: `${detail.size.join(' × ')} (x, y, z) · ${fmt(detail.blocks)} blocks · ${detail.blockEntities} block entities${detail.mods.length ? ' · mods: ' + detail.mods.join(', ') : ''}` }),
        detail.unknown.length ? h('div', { class: 'warn', text: `Not in the bots' registry, will be skipped: ${detail.unknown.join(', ')}` }) : '',
        h('div', { class: 'small muted', text: detail.names.slice(0, 14).map((n) => `${n.name.replace('minecraft:', '')} ${fmt(n.n)}`).join(', ') + (detail.names.length > 14 ? ', …' : '') }),
        h('div', { class: 'row' }, h('label', {}, 'layer y ', h('input', { id: 'layerY', type: 'range', min: 0, max: detail.size[1] - 1, value: 0 }), h('span', { id: 'layerLbl', text: '0' })), h('span', { id: 'layerHover', class: 'muted small' })),
        h('canvas', { id: 'layerCanvas' }),
        h('div', { class: 'row' }, h('a', { href: `/api/structures/${name}/download`, download: `${name}.nbt` }, h('button', { class: 'ghost', text: 'Download .nbt' })),
            h('button', { class: 'ghost danger', text: 'Delete', onclick: act(async () => { if (!confirm(`Delete ${name}?`)) throw new Error('cancelled'); await api('DELETE', `/api/structures/${name}`); selected = null; detail = null; $('#structDetail').replaceChildren(h('h2', { text: 'Select a structure' })); $('#structEdit').classList.add('hidden'); $('#structBuild').classList.add('hidden'); await loadStructures(); }, 'deleted') })));
    $('#layerY').addEventListener('input', () => drawLayer()); drawLayer();
    $('#editName').textContent = name; $('#buildName').textContent = name; $('#saveAs').value = `${name}-2`;
    $('#structEdit').classList.remove('hidden'); $('#structBuild').classList.remove('hidden'); buildDraft();
}
async function drawLayer() {
    const y = Number($('#layerY').value); $('#layerLbl').textContent = y;
    let L; try { L = await api('GET', `/api/structures/${selected}/layer/${y}`); } catch (e) { return; }
    const cv = $('#layerCanvas'), z = Math.max(4, Math.min(24, Math.floor(560 / Math.max(L.w, L.d))));
    cv.width = L.w * z; cv.height = L.d * z; const c = cv.getContext('2d');
    c.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg'); c.fillRect(0, 0, cv.width, cv.height);
    const cols = L.palette.map(colorOf);
    L.grid.forEach((s, i) => { if (s < 0) return; c.fillStyle = cols[s]; c.fillRect((i % L.w) * z, Math.floor(i / L.w) * z, z - 1, z - 1); });
    cv.onmousemove = (ev) => { const r = cv.getBoundingClientRect(), gx = Math.floor((ev.clientX - r.left) * cv.width / r.width / z), gz = Math.floor((ev.clientY - r.top) * cv.height / r.height / z); const s = L.grid[gz * L.w + gx]; $('#layerHover').textContent = `x ${gx} z ${gz}: ${s >= 0 ? L.palette[s] : 'empty'}`; };
}

function pushOp(op) { ops.push(op); $('#ops').value = JSON.stringify(ops).slice(0, 300); }
$$('[data-op]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.op;
    pushOp(k.startsWith('rot') ? { op: 'rotate', turns: Number(k[3]) } : { op: 'mirror', axis: k[1] });
}));
$('#repGo').addEventListener('click', () => { if ($('#repFrom').value.trim() && $('#repTo').value.trim()) pushOp({ op: 'replace', from: $('#repFrom').value.trim(), to: $('#repTo').value.trim() }); });
$('#rmGo').addEventListener('click', () => { const names = $('#rmNames').value.split(',').map((s) => s.trim()).filter(Boolean); if (names.length) pushOp({ op: 'remove', names }); });
$('#cropGo').addEventListener('click', () => { const v = ['#cx0', '#cy0', '#cz0', '#cx1', '#cy1', '#cz1'].map(num); if (!v.some(Number.isNaN)) pushOp({ op: 'crop', box: { x0: v[0], y0: v[1], z0: v[2], x1: v[3], y1: v[4], z1: v[5] } }); });
$('#mergeGo').addEventListener('click', () => { const n = $('#mergeWith').value; if (n) pushOp({ op: 'merge', parts: [{ name: n, x: num('#mox') || 0, y: num('#moy') || 0, z: num('#moz') || 0, rotate: Number($('#mrot').value) }] }); });
$('#opsClear').addEventListener('click', () => { ops = []; $('#ops').value = ''; });
$('#saveGo').addEventListener('click', act(async () => {
    if (!ops.length) throw new Error('add at least one step');
    const as = $('#saveAs').value.trim(), over = $('#saveOver').checked;
    const r = await api('POST', `/api/structures/${selected}/edit`, { ops, as: over ? undefined : as, overwrite: over });
    await loadStructures(); await selectStructure(r.name); return r;
}, (r) => `saved ${r.name} (${r.size.join('×')})`));

const buildDraftBox = () => {
    if (!detail) return null; const o = [num('#bx'), num('#by'), num('#bz')]; if (o.some(Number.isNaN)) return null;
    const r = Number($('#brot').value) % 2; const w = r ? detail.size[2] : detail.size[0], d = r ? detail.size[0] : detail.size[2];
    return { x0: o[0], x1: o[0] + w - 1, z0: o[2], z1: o[2] + d - 1, y0: o[1], y1: o[1] + detail.size[1] - 1 };
};
function buildDraft() { draft.build = buildDraftBox(); const u = detail && detail.unknown.length; $('#buildWarn').textContent = u ? `Skipped (not in the bots' registry): ${detail.unknown.join(', ')}` : ''; drawMap(); }
['#bx', '#by', '#bz', '#brot'].forEach((id) => $(id).addEventListener('input', buildDraft));
$('#bMe').addEventListener('click', () => { const p = me(); if (p) { $('#bx').value = p.pos.x; $('#by').value = p.pos.y; $('#bz').value = p.pos.z; buildDraft(); } });
$('#bMap').addEventListener('click', () => pickOnMap('Origin', (x, z) => { $('#bx').value = x; $('#bz').value = z; buildDraft(); }));
$('#bGround').addEventListener('click', act(async () => { const y = await groundAt(num('#bx'), num('#bz')); if (y === null) throw new Error('terrain not loaded near any bot'); $('#by').value = y + 1; buildDraft(); }, 'y = first free block above the ground'));
const createBuild = (start) => act(async () => {
    const o = { x: num('#bx'), y: num('#by'), z: num('#bz') }; if (Object.values(o).some(Number.isNaN)) throw new Error('set the origin');
    const steps = []; if ($('#bmirror').checked) steps.push({ op: 'mirror', axis: 'x' }); if (Number($('#brot').value)) steps.push({ op: 'rotate', turns: Number($('#brot').value) });
    return api('POST', '/api/jobs/build', { structure: selected, origin: o, ops: steps, name: $('#buildJobName').value.trim() || undefined, bots: [...selBots.build], start });
}, (r) => `job ${r.id} created${start ? ' and started' : ''}`);
$('#buildCreate').addEventListener('click', createBuild(false)); $('#buildStart').addEventListener('click', createBuild(true));

// ------------------------------------------------------------------------------------------------ map
const cv = $('#map'), ctx = cv.getContext('2d');
const css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
let returnTab = null;
function pickOnMap(label, cb) {
    returnTab = ($$('#tabs button').find((b) => b.classList.contains('on')) || {}).dataset?.tab || null;
    mapPick = cb; $('#mappick').textContent = `click the map: ${label}`; $$('#tabs button')[0].click();
}
function fit() {
    const boxes = [...(S ? S.jobs.map((j) => j.box) : []), draft.pit, draft.build].filter(Boolean), pts = [...(S ? S.bots.filter((b) => b.pos).map((b) => b.pos) : []), ...players.filter((p) => p.pos).map((p) => p.pos)];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of boxes) { x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1); z0 = Math.min(z0, b.z0); z1 = Math.max(z1, b.z1); }
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    if (!isFinite(x0)) { x0 = -64; x1 = 64; z0 = -32; z1 = 32; }
    view.cx = (x0 + x1) / 2; view.cz = (z0 + z1) / 2; view.scale = Math.max(0.05, Math.min(24, 0.85 * Math.min(cv.width / Math.max(32, x1 - x0), cv.height / Math.max(32, z1 - z0)))); drawMap();
}
$('#mapfit').addEventListener('click', fit);
const toScreen = (x, z) => [cv.width / 2 + (x - view.cx) * view.scale, cv.height / 2 + (z - view.cz) * view.scale];
const toWorld = (px, pz) => [Math.floor((px - cv.width / 2) / view.scale + view.cx), Math.floor((pz - cv.height / 2) / view.scale + view.cz)];
function drawMap() {
    if ($('#tab-map').classList.contains('hidden')) return;
    const bg = css('--card'), line = css('--line'), ink = css('--muted');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
    const step = [1, 2, 5, 10, 16, 32, 64, 128, 256, 512, 1024].find((s) => s * view.scale >= 48) || 2048;
    ctx.strokeStyle = line; ctx.fillStyle = ink; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
    const [wx0, wz0] = toWorld(0, 0), [wx1, wz1] = toWorld(cv.width, cv.height);
    for (let x = Math.floor(wx0 / step) * step; x <= wx1; x += step) { const [sx] = toScreen(x, 0); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cv.height); ctx.stroke(); ctx.fillText(x, sx + 3, 12); }
    for (let z = Math.floor(wz0 / step) * step; z <= wz1; z += step) { const [, sz] = toScreen(0, z); ctx.beginPath(); ctx.moveTo(0, sz); ctx.lineTo(cv.width, sz); ctx.stroke(); ctx.fillText(z, 3, sz - 3); }
    const rect = (b, fill, stroke, dash, pct, label) => {
        const [ax, az] = toScreen(b.x0, b.z0), [bx, bz] = toScreen(b.x1 + 1, b.z1 + 1);
        ctx.setLineDash(dash ? [6, 4] : []); ctx.lineWidth = 2;
        ctx.fillStyle = fill; ctx.globalAlpha = 0.18; ctx.fillRect(ax, az, bx - ax, bz - az);
        if (pct) { ctx.globalAlpha = 0.45; ctx.fillRect(ax, az, (bx - ax) * pct, bz - az); }
        ctx.globalAlpha = 1; ctx.strokeStyle = stroke; ctx.strokeRect(ax, az, bx - ax, bz - az); ctx.setLineDash([]);
        if (label) { ctx.fillStyle = css('--ink'); ctx.fillText(label, ax + 4, az + 14); }
    };
    if (S) for (const j of S.jobs) if (['running', 'paused', 'ready'].includes(j.state)) rect(j.box, j.kind === 'pit' ? '#c47f1a' : '#7a4fd1', j.kind === 'pit' ? '#c47f1a' : '#7a4fd1', false, j.progress.total ? j.progress.done / j.progress.total : 0, `${j.id} ${j.name}`);
    if (draft.pit) rect(draft.pit, '#c47f1a', '#c47f1a', true, 0, 'draft pit');
    if (draft.build) rect(draft.build, '#7a4fd1', '#7a4fd1', true, 0, 'draft build');
    const dot = (p, color, label) => { const [sx, sz] = toScreen(p.x, p.z); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx, sz, 5, 0, 7); ctx.fill(); ctx.fillStyle = css('--ink'); ctx.fillText(label, sx + 8, sz + 4); };
    for (const p of players) if (p.pos && !p.bot) dot(p.pos, '#1a8f4c', p.name);
    if (S) for (const b of S.bots) if (b.pos) dot(b.pos, b.working ? '#2f6fed' : '#8aa4d6', b.name);
}
let drag = null;
cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: view.cx, cz: view.cz, moved: false }; });
cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect(), k = cv.width / r.width, [x, z] = toWorld((e.clientX - r.left) * k, (e.clientY - r.top) * k); $('#mapcursor').textContent = `x ${x}, z ${z}`;
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    view.cx = drag.cx - dx * k / view.scale; view.cz = drag.cz - dy * k / view.scale; drawMap();
});
cv.addEventListener('pointerup', (e) => {
    const r = cv.getBoundingClientRect(), k = cv.width / r.width;
    if (drag && !drag.moved && mapPick) { const [x, z] = toWorld((e.clientX - r.left) * k, (e.clientY - r.top) * k); const cb = mapPick; mapPick = null; $('#mappick').textContent = ''; cb(x, z); const back = $$('#tabs button').find((b) => b.dataset.tab === returnTab); if (back) back.click(); }
    drag = null;
});
cv.addEventListener('wheel', (e) => { e.preventDefault(); view.scale = Math.max(0.05, Math.min(40, view.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2))); drawMap(); }, { passive: false });

boot();

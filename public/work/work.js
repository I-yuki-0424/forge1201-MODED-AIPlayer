'use strict';
// Work console pages (served by src/work/console.js). Layout after Grafana (panels, stat tiles, sparklines) and the AWS instance
// console (filterable table with checkboxes, bulk actions, a detail pane with tabs below). State is polled every 2 s.
let S = null, players = [], currentPage = 'overview';
const pages = {}, HIST = { t: [], online: [], done: [] };
const getS = () => S, getPlayers = () => players;
const ACTIVE = ['running', 'paused', 'ready'];

// ------------------------------------------------------------------------------------------------ login, navigation, polling
function showLogin() {
    $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
    // A line the operator left for whoever signs in (data/notice.txt: "ready, join at ..."); plain text, no secrets in it.
    api('GET', '/api/notice').then((n) => { const el = $('#notice'); el.textContent = n.text || ''; el.classList.toggle('hidden', !n.text); }).catch(() => {});
}
window.addEventListener('work-login-required', showLogin);
// A link can carry the sign-in: `#token=<console token>` (the fragment is never sent to any server, and is removed from the address at once).
// For the in-game browser (WebDisplays minePad or screen), where typing a token is awkward: put the link in its client config once.
// `#kiosk` (remembered until `#kiosk=0`) switches to larger controls for a small screen in the game.
const FRAG = new URLSearchParams(location.hash.replace(/^#/, ''));
const FRAG_TOKEN = FRAG.get('token');
try { if (FRAG.has('kiosk')) localStorage.setItem('wc_kiosk', FRAG.get('kiosk') === '0' ? '' : '1'); document.body.classList.toggle('kiosk', !!localStorage.getItem('wc_kiosk')); } catch (_) { /* no storage: normal layout */ }
if (FRAG.has('token') || FRAG.has('kiosk')) history.replaceState(null, '', location.pathname + location.search);
async function boot() {
    try { const s = await api('GET', '/api/session'); session.csrf = s.csrf; } catch (_) {
        if (!FRAG_TOKEN || boot.triedFragment) return showLogin();
        boot.triedFragment = true;
        try { const r = await api('POST', '/api/login', { token: FRAG_TOKEN }); session.csrf = r.csrf; return boot(); } catch (_) { return showLogin(); }
    }
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

const NAV = [['overview', 'Overview', 'grid'], ['map', 'Map', 'map'], ['bots', 'Bots', 'bot'], ['pits', 'Pits', 'layers'], ['structures', 'Structures', 'box'], ['jobs', 'Jobs', 'list'], ['inventory', 'Inventory', 'pack'], ['tags', 'Tags', 'tag'], ['auto', 'Automation', 'target'], ['log', 'Log', 'log']];
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

// ------------------------------------------------------------------------------------------------ pages
function buildPages() {
    $('#nav').replaceChildren(...NAV.map(([k, t, ic]) => h('button', { 'data-page': k, onclick: () => show(k) }, icon(ic, 18), h('span', { text: t }))));
    const host = $('#page');
    const add = (name, p) => { pages[name] = p; p.el.classList.add('page', 'hidden'); host.append(p.el); };
    add('overview', overviewPage()); add('map', mapPage()); add('bots', botsPage()); add('pits', pitsPage()); add('structures', structuresPage()); add('jobs', jobsPage()); add('inventory', inventoryPage()); add('tags', tagsPage()); add('auto', automationPage()); add('log', logPage());
}

boot();

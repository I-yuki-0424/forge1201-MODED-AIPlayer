'use strict';
// UI check of the work console page under jsdom (no browser here: drawing on canvas is NOT checked). The page's scripts run for real against
// a stubbed fetch with canned API answers; the check clicks through the v5 parts and looks at the DOM and at the requests the page sends.
//   docker run --rm -v "$PWD":/w -w /w node:20-slim sh -c 'npm i --no-save --prefix /tmp/j jsdom >/dev/null 2>&1 && NODE_PATH=/tmp/j/node_modules node scripts/work/ui_check.js'
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const dir = path.join(__dirname, '../../public/work');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:3020/' });
const w = dom.window, sent = [];
let checks = 0; const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else { checks++; } };
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
w.ResizeObserver = class { observe() {} disconnect() {} };
const bots = [
    { name: 'Work1', state: 'online', job: 'j1', working: false, retired: null, pos: { x: 10, y: 140, z: 5 }, health: 20, food: 20, free: 20, pickaxes: 2, inPit: true, script: null, cmd: null,
        tools: [{ name: 'iron_pickaxe', left: 212, max: 250, worn: false }, { name: 'iron_pickaxe', left: 4, max: 250, worn: true }] },
    { name: 'Work2', state: 'online', job: null, working: false, retired: null, pos: { x: 0, y: 70, z: 0 }, health: 20, food: 20, free: 30, pickaxes: 0, inPit: false, script: null, cmd: null, tools: [] },
];
const state = { now: Date.now(), uptime: 1000, server: { host: 'h', port: 1 }, settings: { autoKit: false, retireWorn: true, discardWorn: true, scripts: true, display: { on: true, paths: true, lanes: true, tags: true } }, rcon: true, kit: {}, maxBots: 24, map: false, bots, log: [],
    jobs: [{ id: 'j1', kind: 'pit', name: 'cut', state: 'running', spec: { method: 'sweep', road: false, box: {} }, progress: { total: 10, done: 4, stuck: 0, leased: 1, pending: 5, regions: 2, regionsDone: 0 }, bots: ['Work1'], stuck: 0, workers: 1, lanes: 2, box: { x0: 0, z0: 0, x1: 9, z1: 9, y0: 1, y1: 3 }, blocked: null, diff: null }] };
const answers = {
    'GET /api/session': { ok: true, csrf: 'c' }, 'GET /api/state': state, 'GET /api/players': [{ name: 'Owner', bot: false, pos: { x: 3, y: 64, z: 4 } }],
    'GET /api/sites': { tags: { tools: 'x', ore: 'x', trash: 'x', food: 'x', blocks: 'x', any: 'x', free: 'x', furnace: 'x', other: 'x' }, purposes: { tools: 'x', ore: 'x', trash: 'x', food: 'x', blocks: 'x', any: 'x', free: 'x', furnace: 'x', other: 'x' }, colours: ['white', 'orange', 'blue', 'red'], migrated: [],
        sites: [{ name: 'main', x: 1, y: 64, z: 2, purpose: 'ore', tags: ['ore'], block: 'minecraft:chest' }, { name: 'furnace', x: 1, y: 64, z: 3, purpose: 'furnace', tags: ['furnace'], label: 'auto furnace', via: 'main', block: 'minecraft:furnace', end: { x: 1, y: 64, z: 2, path: ['furnace', 'main'] } },
            { name: 'tools-e', x: 4, y: 64, z: 2, purpose: 'tools', tags: ['tools'], ender: { left: 'blue', middle: 'white', right: 'white' }, block: 'enderstorage:ender_chest' }] },
    'GET /api/enderstorage': { available: true, colours: ['white', 'blue'], frequencies: [{ key: 'k', label: 'blue / white / white', left: 'blue', middle: 'white', right: 'white', size: 27, used: 2, items: [{ item: 'minecraft:diamond_pickaxe', count: 2 }], sites: [{ name: 'tools-e', purpose: 'tools', x: 4, y: 64, z: 2 }] }] },
    'GET /api/scripts': [{ name: 'replace-tool', builtIn: true, steps: [{ return: 'ok' }] }, { name: 'mine', builtIn: false, steps: [{ return: 'ok' }, { log: 'x' }] }],
    'GET /api/surface': { y: 64 }, 'GET /api/bots/Work1/containers': [{ x: 5, y: 64, z: 6, block: 'minecraft:chest' }],
    'POST /api/inventory': { kind: 'player', size: 36, slots: [{ slot: 0, id: 'minecraft:iron_pickaxe', count: 1, damage: 200, max: 250, left: 50, label: null, enchanted: false }, { slot: 1, id: 'minecraft:cobblestone', count: 64, damage: null }] },
};
w.fetch = async (url, o = {}) => {
    const m = (o.method || 'GET').toUpperCase(), u = String(url).split('?')[0]; sent.push([m, u, o.body ? JSON.parse(o.body) : null, String(url)]);
    let body = answers[`${m} ${u}`];
    if (body === undefined && m === 'POST' && u === '/api/scripts') body = { name: 'mine', steps: [] };
    if (body === undefined && m === 'POST') body = { ok: true, ended: 'ok', steps: 1, log: ['x'], how: 'pillar' };
    if (body === undefined && m === 'DELETE') body = { ok: true };
    if (body === undefined && m === 'GET' && /^\/api\/bots\/Work1$/.test(u)) body = { history: [] };
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body || { error: 'no canned answer for ' + u } };
};
const errors = []; w.addEventListener('error', (e) => errors.push(e.message));
// classic scripts in one context, as a browser runs them (top-level const/function are shared between the files)
const vm = require('vm'), ctx = dom.getInternalVMContext();
for (const f of ['blockcolor.js', 'ui.js', 'kiosk.js', 'map.js', 'widgets.js', 'cmd.js', 'inv.js', 'page_overview.js', 'page_map.js', 'page_bots.js', 'page_pits.js', 'page_place.js', 'page_structures.js', 'page_jobs.js', 'page_inventory.js', 'page_tags.js', 'page_auto.js', 'page_log.js', 'work.js']) new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }).runInContext(ctx);
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
(async () => {
    await tick(300);
    const nav = [...w.document.querySelectorAll('#nav button')].map((b) => b.textContent);
    ok(nav.includes('Automation'), `nav has Automation: ${nav}`);
    // ---- Automation page
    click(w.document.querySelector('#nav button[data-page="auto"]')); await tick(300);
    const page = w.document.querySelector('#page .page:not(.hidden)');
    const boxes = [...page.querySelectorAll('.setting input')];
    ok(boxes.length === 16 && boxes[0].checked && boxes[1].checked && boxes[2].checked && !boxes[3].checked, `the settings (retireWorn, discardWorn, scripts on, auto-kit off) and four display switches: ${boxes.length}`);
    { const reach = page.querySelector('input[aria-label="chest reach in chunks"]'), tp = page.querySelector('select[aria-label="server moves"]'); ok(reach && Number(reach.value) === 50 && reach.max === '200', 'the chest reach field (chunks, 50 by default)'); ok(tp && tp.value === 'off' && [...tp.options].map((o) => o.value).join() === 'off,near,any', 'server moves: off by default'); }
    ok(page.textContent.includes('Try stuck units again by itself'), 'the setting for the automatic retry of stuck units is on the page');
    boxes[0].checked = false; boxes[0].dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
    ok(sent.some((s) => s[1] === '/api/settings' && s[2] && s[2].retireWorn === false), 'switching retireWorn off posts the setting');
    const dsp = boxes.slice(boxes.length - 4); dsp[1].checked = false; dsp[1].dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
    ok(sent.some((s) => s[1] === '/api/settings' && s[2] && s[2].display && s[2].display.paths === false), 'a display layer is switched through the settings route');
    // ---- The game's web view has no confirm() and no native select lists: the page asks in its own box and draws its own lists
    { let confirmCalled = false; w.confirm = () => { confirmCalled = true; return false; };
      click(w.document.querySelector('#nav button[data-page="tags"]')); await tick(300);
      const tpg = w.document.querySelector('#page .page:not(.hidden)'), rm = [...tpg.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
      const before = sent.length; click(rm); await tick(100);
      ok(!confirmCalled && w.document.querySelector('.modal-back') && /Remove main/.test(w.document.querySelector('.modal-back').textContent), 'Remove asks in a box of the page, not with confirm()');
      ok(sent.length === before, 'and sends nothing until it is answered');
      click([...w.document.querySelectorAll('.modal-back button')].find((b) => b.textContent === 'No')); await tick(100);
      ok(!w.document.querySelector('.modal-back') && sent.length === before, 'No closes it and nothing is deleted');
      click(rm); await tick(100); click([...w.document.querySelectorAll('.modal-back button')].find((b) => b.textContent === 'Yes')); await tick(200);
      ok(sent.some((x) => x[0] === 'DELETE' && x[1] === '/api/sites/main'), 'Yes deletes (the request is sent)');
      w.document.body.classList.add('kiosk'); w.installKiosk();
      const sel = tpg.querySelector('select[aria-label="purpose"]'), mdown = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }); sel.dispatchEvent(mdown); await tick(50);
      ok(mdown.defaultPrevented && w.document.querySelector('.modal-back') && [...w.document.querySelectorAll('.modal-back button')].some((b) => b.textContent.startsWith('trash')), 'in the kiosk a select opens a list drawn by the page');
      click([...w.document.querySelectorAll('.modal-back button')].find((b) => b.textContent.startsWith('trash'))); await tick(100);
      ok(sel.value === 'trash' && !w.document.querySelector('.modal-back'), 'choosing sets the select and closes the list');
      w.document.body.classList.remove('kiosk'); }
    // ---- Map tiles: a region the server saved again keeps its old picture while the new one loads (it was drawn black: the chunk of a working bot flickered)
    { const T = w.eval('Tiles'), fake = { fake: 'canvas' };
      T.tiles.set('overworld/s/9/9', { canvas: fake, mtime: 1 });                          // key: dimension / layer ('s' = surface) / region
      const got = T.get('overworld', null, 9, 9, 2);
      ok(got && got.canvas === fake && T.tiles.get('overworld/s/9/9').canvas === fake, 'a tile whose file changed is still drawn from the old picture');
      ok(T.get('overworld', null, 9, 9, 2).canvas === fake && T.waiting.filter((j) => j.key === 'overworld/s/9/9').length <= 1, 'and asked for only once while loading');
      T.tiles.delete('overworld/s/9/9'); T.waiting.length = 0;
      T.tiles.set('nether/70/0/0', { canvas: fake, mtime: 1 }); ok(T.get('nether', 70, 0, 0, 1).canvas === fake && !T.tiles.has('nether/s/0/0'), 'a layer view of the Nether is a tile of its own (not the surface one)'); T.tiles.delete('nether/70/0/0'); }
    // ---- Tags page (tagged blocks, links)
    click(w.document.querySelector('#nav button[data-page="tags"]')); await tick(300);
    const tp = w.document.querySelector('#page .page:not(.hidden)');
    ok(tp.textContent.includes('main') && tp.querySelectorAll('.pill.tag-ore').length === 1, 'the tagged block is listed with its tags');
    ok(tp.textContent.includes('→ main'), 'a machine shows its link');
    const nameIn = tp.querySelector('input[placeholder="smelter"]'); nameIn.value = 'rock';
    const nums = [...tp.querySelectorAll('input.num[aria-label]')]; ['3', '64', '9'].forEach((v, i) => { nums[i].value = v; });
    const purposeSel = tp.querySelector('select[aria-label="purpose"]'); purposeSel.value = 'trash';
    const saveBtn = () => [...tp.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    click(saveBtn()); await tick();
    ok(sent.some((s) => s[0] === 'POST' && s[1] === '/api/sites' && s[2].name === 'rock' && s[2].x === 3 && s[2].purpose === 'trash'), 'a block is saved with name, coordinates and purpose');
    purposeSel.value = 'other'; nameIn.value = 'lone'; const before = sent.length; click(saveBtn()); await tick();
    ok(sent.length === before, 'nothing to say about the block (purpose other, no label or link): checked in the page, nothing is sent');
    ok(tp.textContent.includes('blue / white / white') && tp.textContent.includes('2 minecraft:diamond_pickaxe'.replace('minecraft:', '')) && tp.textContent.includes('tools-e: tools'), 'the Ender Storage table shows the colours, what is inside and what the chest is used for');
    const label = tp.querySelector('input[placeholder^="free text"]'); label.value = '自動かまど'; const viaSel = tp.querySelector('select[aria-label="link to"]'); viaSel.value = 'main';
    click(saveBtn()); await tick();
    ok(sent.some((s) => s[0] === 'POST' && s[1] === '/api/sites' && s[2].name === 'lone' && s[2].label === '自動かまど' && s[2].via === 'main'), 'a label and a link are sent');
    // ---- back to Automation: scripts
    click(w.document.querySelector('#nav button[data-page="auto"]')); await tick(200);
    ok(page.textContent.includes('replace-tool') && page.textContent.includes('built in'), 'scripts are listed, built-in marked');
    const ta = page.querySelector('textarea'); ok(JSON.parse(ta.value).name === 'my-script', 'the editor starts with a template that is valid JSON');
    ta.value = '{ not json'; click([...page.querySelectorAll('button')].find((b) => b.textContent === 'Validate and save')); await tick();
    ok(!sent.some((s) => s[1] === '/api/scripts' && s[0] === 'POST'), 'invalid JSON is refused in the page, nothing is sent');
    ta.value = JSON.stringify({ name: 'mine', steps: [{ return: 'ok' }] }); click([...page.querySelectorAll('button')].find((b) => b.textContent === 'Validate and save')); await tick();
    ok(sent.some((s) => s[0] === 'POST' && s[1] === '/api/scripts' && s[2].name === 'mine'), 'a script is sent to be validated and stored');
    // ---- Pits form: depot rank and the tools chest
    click(w.document.querySelector('#nav button[data-page="pits"]')); await tick(200);
    const pitsPg = w.document.querySelector('#page .page:not(.hidden)');
    const rank = [...pitsPg.querySelectorAll('select')].find((q) => [...q.options].some((o) => o.value === '40'));
    ok(rank && rank.value === '10', 'the depot rank is offered, no stone or dirt by default');
    ok(pitsPg.textContent.includes('also the tools chest'), 'and the switch for the tools chest');
    // ---- Pits form
    click(w.document.querySelector('#nav button[data-page="pits"]')); await tick(200);
    const pits = w.document.querySelector('#page .page:not(.hidden)');
    const sel = [...pits.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'sweep'));
    ok(sel && sel.value === 'sweep', 'the pit form offers the method, sweep by default');
    ok(pits.textContent.includes('keep a haul road'), 'and the haul road switch');
    // ---- Pits form (2026-11-10): the dimension is a pulldown, the Nether looks down from a layer, the selection has a Select / Pan switch, Clear and Bigger
    {
      const dsel = [...pits.querySelectorAll('select')].find((q) => [...q.options].some((o) => o.value === 'nether') && [...q.options].some((o) => o.value === '__other'));
      ok(dsel && dsel.value === 'overworld' && [...dsel.options].map((o) => o.value).join() === 'overworld,nether,end,__other', 'the dimension is a pulldown: overworld, nether, end, other');
      const idInput = pits.querySelector('input[aria-label="dimension id"]'); ok(idInput && idInput.classList.contains('hidden'), 'the id field of a mod dimension is hidden until "other" is chosen');
      const layerIn = pits.querySelector('input[aria-label="view from y"]'); ok(layerIn && layerIn.value === '', 'the view starts at the surface (blank)');
      const reqs = sent.length; dsel.value = 'nether'; dsel.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(200);
      ok(sent.slice(reqs).some((x) => /\/api\/map\/regions\?dim=nether/.test(x[3])), 'choosing the Nether asks for the regions of the Nether');
      ok(layerIn.value === '70', 'and the map looks down from y 70 (the Nether has a bedrock roof)');
      dsel.value = '__other'; dsel.dispatchEvent(new w.Event('change', { bubbles: true })); ok(!idInput.classList.contains('hidden'), '"other" shows the id field');
      idInput.value = 'twilightforest:twilight_forest'; idInput.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(100);
      ok(sent.some((x) => /dim=twilightforest%3Atwilight_forest/.test(x[3])), 'and the id is sent URL-encoded');
      dsel.value = 'overworld'; dsel.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(100); ok(layerIn.value === '', 'back in the overworld the view is the surface again');
      const mode = [...pits.querySelectorAll('button')].find((b) => b.textContent === 'Select'); ok(!!mode, 'a Select / Pan switch is there');
      click(mode); ok(mode.textContent === 'Pan', 'it switches to Pan'); click(mode); ok(mode.textContent === 'Select', 'and back');
      ok([...pits.querySelectorAll('button')].some((b) => b.textContent === 'Clear') && [...pits.querySelectorAll('button')].some((b) => b.textContent === 'Bigger'), 'Clear and Bigger are there');
      const x0 = pits.querySelector('input[aria-label="x0"]'), x1 = pits.querySelector('input[aria-label="x1"]'); x0.value = '10'; x1.value = '40'; x0.dispatchEvent(new w.Event('input', { bubbles: true }));
      click([...pits.querySelectorAll('button')].find((b) => b.textContent === 'Clear')); await tick(100); ok(x0.value === '' && x1.value === '', 'Clear empties the selection and the numbers that follow it');
    }
    // ---- The selection on a map: drag a box, drag an edge to resize it (the other sides stay), Pan mode moves the map instead, Clear forgets it
    {
      const cv = w.document.createElement('canvas'); cv.width = 800; cv.height = 600; cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }); cv.setPointerCapture = () => {};
      let got; const MV = w.eval('MapView'), mv = new MV(cv, { select: true, onSelect: (b) => { got = b; } }); mv.view = { cx: 0, cz: 0, scale: 2 }; mv.snapMode = true;
      const ev = (type, x, y, o = {}) => cv.dispatchEvent(new w.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...o }));
      ev('pointerdown', 400, 300); ev('pointermove', 494, 394); ev('pointerup', 494, 394);
      ok(got && got.x0 === 0 && got.x1 === 47 && got.z0 === 0 && got.z1 === 47, `a drag selects whole chunks: ${JSON.stringify(got)}`);
      ev('pointerdown', 496, 340); ev('pointermove', 528, 340); ev('pointerup', 528, 340);
      ok(got.x0 === 0 && got.x1 === 79 && got.z0 === 0 && got.z1 === 47, `dragging the right edge moves only that edge: ${JSON.stringify(got)}`);
      ev('pointerdown', 400, 300); ev('pointermove', 380, 280); ev('pointerup', 380, 280);
      ok(got.x0 === -16 && got.z0 === -16 && got.x1 === 79 && got.z1 === 47, `dragging a corner moves both its edges: ${JSON.stringify(got)}`);
      mv.setMode('pan'); const c0 = mv.view.cx; ev('pointerdown', 300, 300); ev('pointermove', 340, 300); ev('pointerup', 340, 300);
      ok(mv.view.cx < c0 && got.x0 === -16, 'in Pan mode a drag moves the map and leaves the selection alone'); mv.setMode('select');
      mv.setBox({ x0: 5, x1: 20, z0: 5, z1: 20 }); ev('pointerdown', 100, 100); ev('pointermove', 140, 140); ev('pointerup', 140, 140);
      ok(mv.fixed === null && got.x0 !== 5, 'a new drag after typed numbers replaces the typed box (it used to stay drawn)');
      mv.clearSel(); ok(got === null && !mv.sel, 'Clear forgets the selection');
    }
    // ---- Bots: tools with durability, leave pit
    click(w.document.querySelector('#nav button[data-page="bots"]')); await tick(200);
    const botsPage = w.document.querySelector('#page .page:not(.hidden)');
    const row = [...botsPage.querySelectorAll('table tbody tr')].find((r) => r.textContent.includes('Work1')); click(row); await tick(200);
    ok(botsPage.textContent.includes('212/250') && botsPage.querySelector('.tool.worn'), 'the summary lists tools with durability, the worn one marked');
    const leave = [...botsPage.querySelectorAll('button')].find((b) => b.textContent === 'Leave pit'); ok(!!leave, 'a bot in its pit has Leave pit');
    if (leave) { click(leave); await tick(); ok(sent.some((s) => s[0] === 'POST' && s[1] === '/api/bots/Work1/leave'), 'Leave pit posts to the bot'); }
    // ---- Jobs show the method
    click(w.document.querySelector('#nav button[data-page="jobs"]')); await tick(200);
    ok(w.document.querySelector('#page .page:not(.hidden)').textContent.includes('pit sweep'), 'the job row says pit sweep');
    // ---- Inventory slot durability bar
    click(w.document.querySelector('#nav button[data-page="inventory"]')); await tick(200);
    const inv = w.document.querySelector('#page .page:not(.hidden)');
    const sel2 = [...inv.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'bot')); sel2.value = 'bot'; sel2.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(100);
    const who = [...inv.querySelectorAll('.invpane select')].find((s) => [...s.options].some((o) => o.value === 'Work1')); if (who) { who.value = 'Work1'; who.dispatchEvent(new w.Event('change', { bubbles: true })); } await tick(300);
    const bar = inv.querySelector('.slot-dur .dur-fill'); ok(!!bar && /width:20%/.test(bar.getAttribute('style')), `the pickaxe slot shows a durability bar (20 % left): ${bar && bar.getAttribute('style')}`);
    ok(inv.querySelectorAll('.slot.full').length >= 2 && inv.querySelectorAll('.slot-dur').length === 1, 'only damageable items get a bar');
    ok(errors.length === 0, `no page errors: ${errors.join('; ')}`);
    console.log(`ui check: ${checks} ok${process.exitCode ? ', FAILED' : ''}`);
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });

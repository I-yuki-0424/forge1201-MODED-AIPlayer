'use strict';
// Headless-browser check of TASK-20261125-077 (owner list 5 Small 3, WORK-CONSOLE-v1 v24) against a DISPOSABLE console on a test world (never a production console).
// Test code. Runs in the Playwright image (mcr.microsoft.com/playwright:v1.49.1-noble) on the world's docker network; `playwright` from NODE_PATH.
//   BASE=http://t077-console:3020 OUT=/out/t077 BOT=W8a node scripts/work/browser_check_t077.js
// World changes (items, a teleport, a placed square) are made by the caller over RCON: the script writes OUT/need-<step> and waits for OUT/done-<step>.
// Writes OUT/c_*.png and OUT/browser-check.json (one entry per check: ok, what was seen).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://t077-console:3020', OUT = process.env.OUT || '/out/t077', BOT = process.env.BOT || 'W8a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; let PAGE = null;
const check = (name, ok, seen) => { results.push({ name, ok: !!ok, seen }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${JSON.stringify(seen)}`); };
const save = () => fs.writeFileSync(path.join(OUT, 'browser-check.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 1));

/** A raw request (no browser): status, headers, body. */
function req(method, p, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(p, BASE), data = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
            const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch) }));
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
}
/** Ask the caller for a world change and wait until it says done. */
async function need(step, what) {
    fs.writeFileSync(path.join(OUT, `need-${step}`), what); console.log(`NEED ${step}: ${what}`);
    for (let i = 0; i < 600 && !fs.existsSync(path.join(OUT, `done-${step}`)); i++) await sleep(500);
    if (!fs.existsSync(path.join(OUT, `done-${step}`))) throw new Error(`no done-${step}`);
}

async function security() {
    const page = await req('GET', '/');
    const csp = page.headers['content-security-policy'] || '';
    check('sec: page served with strict CSP', page.status === 200 && /default-src 'none'|default-src 'self'/.test(csp) && /img-src 'self'/.test(csp) && !/unsafe-inline/.test(csp.split(';').find((d) => d.trim().startsWith('script-src')) || ''), { status: page.status, csp });
    const st = await req('GET', '/api/state');
    check('sec: /api/state without a session is refused', st.status === 401, { status: st.status });
    const tex0 = await req('GET', '/api/assets/tex/block/stone.png');
    check('sec: a texture without a session is refused', tex0.status === 401, { status: tex0.status });
    for (const [h, v] of [['x-forwarded-for', '1.2.3.4'], ['cf-connecting-ip', '1.2.3.4'], ['cf-access-jwt-assertion', 'a.b.c']]) {
        const r = await req('GET', '/api/session', { headers: { [h]: v } });
        check(`sec: a session through a proxy header (${h}) without Access is refused`, r.status === 403, { status: r.status });
    }
    const host = await req('GET', '/api/session', { headers: { host: 'evil.example' } });
    check('sec: a foreign Host (DNS rebinding) is refused', host.status === 421, { status: host.status });
    // a session the way the page gets one (network: the console has no token)
    const s = await req('GET', '/api/session'), cookie = String((s.headers['set-cookie'] || [''])[0]).split(';')[0], csrf = JSON.parse(s.body).csrf;
    check('sec: session cookie HttpOnly SameSite=Strict', /HttpOnly/.test(s.headers['set-cookie']) && /SameSite=Strict/.test(s.headers['set-cookie']), { cookie: String(s.headers['set-cookie']).replace(/=[0-9a-f]{64}/, '=<sid>') });
    const H = { cookie };
    const nocsrf = await req('POST', '/api/bots', { headers: H, body: { name: BOT } });
    check('sec: a POST without the CSRF header is refused', nocsrf.status === 403, { status: nocsrf.status });
    const xorig = await req('POST', '/api/bots', { headers: { ...H, 'x-csrf': csrf, origin: 'http://evil.example' }, body: { name: BOT } });
    check('sec: a cross-origin POST is refused', xorig.status === 403, { status: xorig.status });
    const badCount = await req('POST', '/api/bots', { headers: { ...H, 'x-csrf': csrf }, body: { count: 99 } });
    check('sec: closed validation (bot count 99)', badCount.status === 400, { status: badCount.status, body: badCount.body.toString().slice(0, 80) });
    // the texture routes: a closed set of paths
    const tex = await req('GET', '/api/assets/tex/block/stone.png', { headers: H });
    check('sec: texture with the session: same-origin PNG', tex.status === 200 && tex.headers['content-type'] === 'image/png' && tex.headers['cross-origin-resource-policy'] === 'same-origin' && tex.body.slice(1, 4).toString() === 'PNG', { status: tex.status, type: tex.headers['content-type'], corp: tex.headers['cross-origin-resource-policy'], bytes: tex.body.length });
    const odd = [];
    for (const p of ['/api/assets/tex/block/..%2f..%2fetc%2fpasswd.png', '/api/assets/tex/block/STONE.png', '/api/assets/tex/models/block/stone.png', '/api/assets/tex/block/stone.json', '/api/assets/tex/block/a/b/c.png', '/api/assets/lang/en_us.json', '/api/assets/icons?ids=../x', `/api/assets/icons?ids=${Array.from({ length: 129 }, (_, i) => `minecraft:a${i}`).join(',')}`, '/api/assets/icons']) {
        const r = await req('GET', p, { headers: H }); odd.push([p.slice(0, 60), r.status]);
    }
    check('sec: texture/icon paths outside the closed set answer 400/404', odd.every(([, c]) => c === 400 || c === 404), odd);
    const add = await req('POST', '/api/bots', { headers: { ...H, 'x-csrf': csrf }, body: { name: BOT } });
    check('setup: bot added through the API (session + CSRF)', add.status === 200 || (add.status === 409 && /exists/.test(add.body)), { status: add.status, body: add.body.toString().slice(0, 120) });
    const set = await req('POST', '/api/settings', { headers: { ...H, 'x-csrf': csrf }, body: { mapSave: 30 } });
    check('setup: map saves every 30 s', set.status === 200, { status: set.status });
}

const visible = (page, sel) => page.locator(`${sel} >> visible=true`).first();
async function show(page, name) {                                       // the app reads the hash only when it boots: a click on the navigation like a person
    if (!page.url().startsWith(BASE)) { await page.goto(`${BASE}/#${name}`); await page.waitForSelector('#app:not(.hidden)'); }
    await page.click(`#nav button[data-page="${name}"]`); await sleep(2500);
}
/** Pixels of the visible map canvas, compared with the copy taken by snap(). */
const snap = (page) => page.evaluate(() => { const c = [...document.querySelectorAll('canvas.map-canvas')].find((x) => x.offsetParent); window.__snap = c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(); return [c.width, c.height]; });
const diff = (page) => page.evaluate(() => { const c = [...document.querySelectorAll('canvas.map-canvas')].find((x) => x.offsetParent), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, a = window.__snap; let n = 0; if (!a || a.length !== d.length) return -1; for (let i = 0; i < d.length; i += 4) if (a[i] !== d[i] || a[i + 1] !== d[i + 1] || a[i + 2] !== d[i + 2]) n++; return n; });

async function ui() {
    const browser = await chromium.launch(), ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } }), page = await ctx.newPage(); PAGE = page;
    const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await show(page, 'bots');
    for (let i = 0; i < 60; i++) { const on = await page.evaluate((b) => S && S.bots.some((x) => x.name === b && x.state === 'online'), BOT); if (on) break; await sleep(1000); }
    await need('items', `give ${BOT} damaged tools, smooth stone and slab, glass, pane, redstone, water bucket`);
    await sleep(3000);

    // ---- inventory: icons, names, durability
    await show(page, 'inventory'); await sleep(3000);
    const slots = await page.evaluate(() => [...document.querySelectorAll('.slot.full')].filter((s) => s.offsetParent).map((s) => ({ title: s.title.split('\n')[0], icon: !!s.querySelector('canvas.slot-icon'), name: (s.querySelector('.slot-name') || {}).textContent || '' })));
    const t = (re) => slots.find((s) => re.test(s.title));
    const pick = page.locator('.slot.full[title^="Iron Pickaxe"] >> visible=true').first(); if (await pick.count()) await pick.hover();
    await sleep(500); await page.screenshot({ path: path.join(OUT, 'c_inventory.png') });
    check('inventory: smooth stone and its slab are two items with their own names', t(/^Smooth Stone ×/) && t(/^Smooth Stone Slab/), { stone: (t(/^Smooth Stone ×/) || {}).title, slab: (t(/^Smooth Stone Slab/) || {}).title });
    check('inventory: durability in words for the damaged pickaxe', t(/Iron Pickaxe.*150 of 250/), (t(/Iron Pickaxe/) || {}).title);
    // icon pixels: the canvas is drawn (not blank) for every slot that has a picture
    const drawn = await page.evaluate(() => [...document.querySelectorAll('.slot.full canvas.slot-icon')].filter((c) => c.offsetParent).map((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return [c.parentElement.title.split(' ×')[0], n]; }));
    check('inventory: icons drawn from the client jar', drawn.filter(([, n]) => n > 50).length >= Math.max(1, drawn.length - 1), drawn);
    // durability bar pixels: the bar row (y 13..14 of 16, scaled 3x = 39..44) has the green-to-red colour only under damaged tools
    const bars = await page.evaluate(() => [...document.querySelectorAll('.slot.full canvas.slot-icon')].filter((c) => c.offsetParent).map((c) => { const k = c.width / 16, d = c.getContext('2d').getImageData(Math.round(2 * k), Math.round(13 * k), Math.round(13 * k), 1).data; let col = 0, blk = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; if (d[i] + d[i + 1] + d[i + 2] < 30) blk++; else if (Math.max(d[i], d[i + 1]) > 200 && d[i + 2] < 60) col++; } return [c.parentElement.title.split(' ·')[0], col, blk]; }));
    const bar = (re) => (bars.find(([n]) => re.test(n)) || [null, 0, 0]);
    check('inventory: durability bar as the game draws it (pickaxe 150/250 -> 8 px of 13 at 3x = 24, sword 361/1561 -> 3 px = 9, new axe none)',
        Math.abs(bar(/Iron Pickaxe/)[1] - 24) <= 3 && Math.abs(bar(/Diamond Sword/)[1] - 9) <= 3 && bar(/Iron Axe/)[1] === 0, bars);
    await page.evaluate(() => { const s = [...document.querySelectorAll('.slot.full')].find((x) => x.offsetParent && /Smooth Stone Slab/.test(x.title)); if (s) s.dispatchEvent(new MouseEvent('mouseenter')); });
    const crop = await page.evaluate(() => { const s = [...document.querySelectorAll('.slot.full')].filter((x) => x.offsetParent && /^(Smooth Stone|Iron Pickaxe|Diamond Sword|Iron Axe|Glass)/.test(x.title)); const r = s.map((x) => x.getBoundingClientRect()); if (!r.length) return null; const x0 = Math.min(...r.map((q) => q.left)), y0 = Math.min(...r.map((q) => q.top)), x1 = Math.max(...r.map((q) => q.right)), y1 = Math.max(...r.map((q) => q.bottom)); return { x: x0 - 4, y: y0 - 4, width: x1 - x0 + 8, height: y1 - y0 + 40 }; });
    if (crop) await page.screenshot({ path: path.join(OUT, 'c_inventory_zoom.png'), clip: crop });

    // ---- Pit: Top = ground, no chest selection, its map follows the world
    await show(page, 'pits');
    const bp = await page.evaluate((b) => S.bots.find((x) => x.name === b).pos, BOT), cx = Math.floor(bp.x / 16) * 16, cz = Math.floor(bp.z / 16) * 16;
    for (const [k, v] of [['x0', cx], ['x1', cx + 15], ['z0', cz], ['z1', cz + 15]]) await visible(page, `input[aria-label="${k}"]`).fill(String(v));
    await visible(page, 'input[aria-label="top"]').fill('');
    await visible(page, 'button:has-text("Top = ground")').click(); await sleep(3000);
    const top = await visible(page, 'input[aria-label="top"]').inputValue();
    await need('ground', `answer the highest ground of x ${cx}..${cx + 15} z ${cz}..${cz + 15} into OUT/ground.txt`);
    const truth = Number(fs.readFileSync(path.join(OUT, 'ground.txt'), 'utf8').trim());
    await page.screenshot({ path: path.join(OUT, 'c_pits_ground.png') });
    check('pit: Top = ground on a fresh area equals the server', Number(top) === truth, { area: [cx, cz], page: top, server: truth });
    const pitText = await page.evaluate(() => [...document.querySelectorAll('.field-label, label, .inv-section')].filter((e) => e.offsetParent).map((e) => e.textContent.trim()).join(' | '));
    check('pit: no depot chest / tools chest selection; tagged containers and the carried container shown', !/depot|tools chest|chest at/i.test(pitText) && /carried container/i.test(pitText) && /storage and tools/i.test(pitText), pitText.slice(0, 400));
    await visible(page, 'select[aria-label="server saves for the map"]').scrollIntoViewIfNeeded();
    // control: the map stands still while nothing changes (tiles loaded, no save pending), then the world changes and the map must follow without a visit to the Map page
    await sleep(8000); await snap(page); await sleep(8000); const still = await diff(page);
    await snap(page); await page.screenshot({ path: path.join(OUT, 'c_pits_map_before.png') });
    await need('change', `tp ${BOT} 24 blocks east and set a 9x9 snow-block square west of the area (white on the map)`);
    const t0 = Date.now(); let moved = bp, white = 0, tDot = null, tSquare = null;
    for (let i = 0; i < 80 && !(tDot && tSquare); i++) {
        await sleep(1000); moved = await page.evaluate((b) => S.bots.find((x) => x.name === b).pos, BOT);
        if (!tDot && moved && moved.x - bp.x > 20) tDot = Date.now() - t0;
        white = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas.map-canvas')].find((x) => x.offsetParent), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, a = window.__snap; let n = 0; for (let k = 0; k < d.length; k += 4) if ((a[k] !== d[k] || a[k + 1] !== d[k + 1] || a[k + 2] !== d[k + 2]) && d[k] > 200 && d[k + 1] > 200 && d[k + 2] > 200) n++; return n; });
        if (!tSquare && white > 2000) tSquare = Date.now() - t0;
    }
    await sleep(2500); await page.screenshot({ path: path.join(OUT, 'c_pits_map_after.png') });
    check('pit: its map redraws without the Map page (control: 0 pixels change in 8 s when nothing happens; then the bot dot moves and the white snow-block square appears after the 30 s save)', still === 0 && tDot !== null && tSquare !== null,
        { stillPixels: still, botFrom: bp, botTo: moved, dotSeenAfterMs: tDot, newWhitePixels: white, squareSeenAfterMs: tSquare });

    // ---- per-page memory: set choices, reload, read them back
    await show(page, 'place');
    await visible(page, 'button:has-text("Room walls")').click();
    for (const [k, v] of [['x0', cx + 2], ['x1', cx + 9], ['z0', cz + 3], ['z1', cz + 8], ['y', 70], ['height', 4]]) await visible(page, `input[aria-label="${k}"]`).fill(String(v));
    await visible(page, 'input[list="place-blocks"]').fill('glass');
    await visible(page, `label.chip:has-text("${BOT}")`).click();
    await sleep(800);
    await show(page, 'bots');
    await visible(page, `tr:has-text("${BOT}") td.chk input`).check();
    await visible(page, `tr:has-text("${BOT}") strong`).click(); await sleep(500);
    await visible(page, 'button.tab:has-text("Inventory")').click(); await sleep(500);
    await visible(page, 'input.search').fill(BOT.slice(0, 2));
    await sleep(800);
    await show(page, 'map');
    const keptMap = () => page.evaluate(() => JSON.parse(localStorage.getItem('wc_keep_map.map') || 'null'));
    for (let i = 0; i < 30 && !(await keptMap()); i++) await sleep(500);              // the first drawing (after the tile index) keeps the fitted view
    const mapFitted = await keptMap();
    const mapBox = await visible(page, 'canvas.map-canvas').boundingBox();
    await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -100); await sleep(150); }
    await sleep(1500);
    const mapBefore = await keptMap();
    await page.reload(); await page.waitForSelector('#app:not(.hidden)'); await sleep(3000);
    const mapAfter = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas.map-canvas')].find((x) => x.offsetParent); const mv = [...MAPS].find((m) => m.cv === c); return mv ? { cx: mv.view.cx, cz: mv.view.cz, scale: mv.view.scale } : null; });
    await page.screenshot({ path: path.join(OUT, 'c_map_after_reload.png') });
    check('memory: Map page view (centre, zoom) after a reload', mapFitted && mapBefore && mapAfter && Math.abs(mapBefore.scale / mapFitted.scale - 1.953125) < 1e-3 && Math.abs(mapAfter.scale - mapBefore.scale) < 1e-6 && Math.abs(mapAfter.cx - mapBefore.cx) < 1e-6, { fitted: mapFitted, keptAfterZoom: mapBefore, shownAfterReload: mapAfter });
    await show(page, 'place');
    const placeVals = await page.evaluate(() => Object.fromEntries(['x0', 'x1', 'z0', 'z1', 'y', 'height'].map((k) => [k, ([...document.querySelectorAll(`input[aria-label="${k}"]`)].find((e) => e.offsetParent) || {}).value])));
    const placeBlock = await visible(page, 'input[list="place-blocks"]').inputValue(), placeKind = await page.evaluate(() => ([...document.querySelectorAll('button.btn.primary')].find((b) => b.offsetParent && /Floor|Wall|Room walls|Solid block/.test(b.textContent)) || {}).textContent);
    const placeChip = await page.evaluate((b) => { const l = [...document.querySelectorAll('label.chip')].find((x) => x.offsetParent && x.textContent.startsWith(b)); return !!l && l.querySelector('input').checked && !l.classList.contains('off'); }, BOT);
    await page.screenshot({ path: path.join(OUT, 'c_place_after_reload.png') });
    check('memory: Place page (kind, area, level, height, block, ticked bot) after a reload', placeKind === 'Room walls' && placeVals.x0 === String(cx + 2) && placeVals.z1 === String(cz + 8) && placeVals.y === '70' && placeVals.height === '4' && placeBlock === 'glass' && placeChip, { placeKind, placeVals, placeBlock, placeChip });
    await show(page, 'bots');
    const botsVals = { ticked: await visible(page, `tr:has-text("${BOT}") td.chk input`).isChecked(), tab: await page.evaluate(() => ([...document.querySelectorAll('button.tab.on')].find((b) => b.offsetParent) || {}).textContent), filter: await visible(page, 'input.search').inputValue() };
    await page.screenshot({ path: path.join(OUT, 'c_bots_after_reload.png') });
    check('memory: Bots page (ticked bot, bot in the detail pane, its tab, the filter) after a reload', botsVals.ticked && botsVals.tab === `Inventory: ${BOT}` && botsVals.filter === BOT.slice(0, 2), botsVals);
    await show(page, 'pits');
    const pitVals = await page.evaluate(() => Object.fromEntries(['x0', 'x1', 'z0', 'z1', 'top'].map((k) => [k, ([...document.querySelectorAll(`input[aria-label="${k}"]`)].find((e) => e.offsetParent) || {}).value])));
    await page.screenshot({ path: path.join(OUT, 'c_pits_after_reload.png') });
    check('memory: Pit page area and top after a reload', pitVals.x0 === String(cx) && pitVals.z1 === String(cz + 15) && pitVals.top === String(top), pitVals);
    check('page: no script errors', errors.length === 0, errors.slice(0, 10));
    await browser.close();
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of fs.readdirSync(OUT)) if (/^(need|done)-/.test(f)) fs.unlinkSync(path.join(OUT, f));
    try { await security(); await ui(); } catch (e) { check('run', false, String(e && e.stack || e)); if (PAGE) await PAGE.screenshot({ path: path.join(OUT, 'c_failed.png') }).catch(() => {}); }
    save();
    console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
})();

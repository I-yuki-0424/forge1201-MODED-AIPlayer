'use strict';
// Pits page (range selection on the map like a spreadsheet, plus coordinates).
// Storage and tools (owner 2026-11-25, list 5 Small 3: "tools are supplied and stored by tags, but Pit still has half-finished chest selections"): the bots store what they dig
// and take tools from the containers tagged on the Tags page; this page only shows them. The old per-job "chest at x y z" depot and its "also the tools chest" box are gone
// (a tagged chest does both, for every job). What tags cannot say stays: a container the bots CARRY (a shulker box or an Ender Storage chest, placed where they work) and
// what it takes.
function pitsPage() {
    const f = Object.fromEntries(['x0', 'x1', 'z0', 'z1', 'top', 'depth', 'bottom'].map((k) => [k, h('input', { type: 'number', class: 'num', 'aria-label': k })]));
    f.depth.value = 3;
    const lanesIn = h('input', { type: 'number', class: 'num', min: 1, max: 32, placeholder: 'auto', title: 'one X-Z range per bot, dug down to the bottom; auto = one per bot' }), info = h('div', { class: 'info-box' }), chips = h('span', { class: 'chips' }), host = h('div', { class: 'map-host tall-map' }), name = h('input', { placeholder: 'optional', maxlength: 60 });
    const carry = h('select', { class: 'sel', title: 'a container the bots take along and place where they work, for what they dig (the tagged containers are used either way)' }, [['', 'none: the tagged containers only'], ['shulker', 'a shulker box (carried, placed by the bot)'], ['ender', 'an Ender Storage chest (carried, placed by the bot)']].map(([v, t]) => h('option', { value: v, text: t })));
    // The carried container's rank (janitor values: stone 5, coal 40, raw iron 70, diamond 100): what is worth less is thrown away instead of stored.
    const rankSel = h('select', { class: 'sel', title: 'what the carried container takes; the rest is thrown away (never anything worth 60 or more)' }, [['0', 'store everything'], ['10', 'no stone, dirt, gravel, sand (value 10 and up)'], ['40', 'ores, coal, wood (40 and up)'], ['60', 'valuable only (60 and up)']].map(([v, t]) => h('option', { value: v, text: t })));
    rankSel.value = '10';
    const rankField = field('It takes', rankSel), sitesBox = h('div', { class: 'muted small' });
    const methodSel = h('select', { class: 'sel', title: 'expert: the learned station planner decides where to stand, two layers at a time (default). sweep: stand in the middle of a 5x5 tile and dig everything in reach, then move on. rows: the first method, cell by cell' }, [['expert', 'expert (learned stations, two layers at a time)'], ['sweep', 'sweep (stand, dig all in reach, move on)'], ['rows', 'rows (cell by cell)']].map(([v, t]) => h('option', { value: v, text: t }))), roadBox = h('input', { type: 'checkbox', title: 'keep a one-wide staircase along the edge so that a late or respawned bot can walk down (a sweep job leaves by pillar and needs none)' });
    const picked = new KeptSet('pits.bots'); let mv = null;
    // The dimension of the job (a pulldown: overworld, nether, end, or "other" for a dimension id such as twilightforest:twilight_forest): the map shows it when the world folder has it; the bots are taken there before they start.
    const slice = sliceControl(() => mv);
    const dimPick = dimPicker((d) => { if (mv) { mv.setDim(d); Tiles.loadIndex(d).then(() => mv.fit()); } });
    const dimNow = () => dimPick.get();
    const snap = h('input', { type: 'checkbox', checked: true, onchange: () => { if (mv) mv.snapMode = snap.checked; } });
    Keep.fields('pits', { ...f, lanes: lanesIn, name, carry, rank: rankSel, method: methodSel, road: roadBox, snap });
    const box = () => { const v = ['x0', 'x1', 'z0', 'z1', 'top', 'depth'].map((k) => num(f[k].value)); if (v.some(Number.isNaN)) return null; const [x0, x1, z0, z1, top, depth] = v; return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), top, bottom: top - Math.max(1, depth) + 1 }; };
    function hbox() { const v = ['x0', 'x1', 'z0', 'z1'].map((k) => num(f[k].value)); return v.some(Number.isNaN) ? null : { x0: Math.min(v[0], v[1]), x1: Math.max(v[0], v[1]), z0: Math.min(v[2], v[3]), z1: Math.max(v[2], v[3]) }; }
    function sync(fromMap) {
        const hb = hbox(), b = box();
        rankField.classList.toggle('hidden', !carry.value);
        if (mv && !fromMap) mv.setBox(hb);                                    // the selection on the map follows the numbers, even before top and depth are known
        if (!hb) { info.textContent = 'Select an area on the map (drag over chunks), or type coordinates.'; return; }
        const w = hb.x1 - hb.x0 + 1, d = hb.z1 - hb.z0 + 1, chunks = (Math.floor(hb.x1 / 16) - Math.floor(hb.x0 / 16) + 1) * (Math.floor(hb.z1 / 16) - Math.floor(hb.z0 / 16) + 1);
        if (!b) { info.replaceChildren(h('div', {}, h('strong', { text: `${w} × ${d}` }), ` · ${chunks} chunk${chunks > 1 ? 's' : ''} selected`), h('div', { class: 'warn small', text: 'Now the top y (Top = ground reads the terrain) and the depth.' })); return; }
        const l = b.top - b.bottom + 1, cells = w * d * l, bedrock = b.bottom < -59 ? ' · bedrock below y -59 is skipped' : '', n = Math.max(1, [...picked].filter((x) => S && S.bots.some((y) => y.name === x)).length || (S ? S.bots.filter((x) => x.state === 'online' && !x.job).length : 1));
        info.replaceChildren(h('div', {}, h('strong', { text: `${w} × ${d} × ${l}` }), ` = ${fmt(cells)} blocks · y ${b.bottom}..${b.top}${bedrock} · ${chunks} chunk${chunks > 1 ? 's' : ''} touched`), h('div', { class: 'muted small', text: `About ${Math.max(1, Math.ceil(cells * 1.4 / n / 60))} min with ${n} bot${n > 1 ? 's' : ''} (about 1.4 s a block per bot, measured). Layers are dug top-down, a haul road stays along the edge.` }));
    }
    carry.addEventListener('change', () => sync(false));
    // depth and bottom y are two views of the same number
    const fromDepth = () => { const t = num(f.top.value), d = num(f.depth.value); if (!Number.isNaN(t) && !Number.isNaN(d)) f.bottom.value = t - Math.max(1, d) + 1; };
    const fromBottom = () => { const t = num(f.top.value), b = num(f.bottom.value); if (!Number.isNaN(t) && !Number.isNaN(b)) f.depth.value = Math.max(1, t - b + 1); };
    f.depth.addEventListener('input', fromDepth); f.top.addEventListener('input', fromDepth); f.bottom.addEventListener('input', fromBottom);
    const save = (...ks) => { for (const k of ks) f[k].dispatchEvent(new Event('change')); };      // values set by code are kept too
    const toBottom = (y) => () => { if (Number.isNaN(num(f.top.value))) return toast('set the top y first (Top = ground)', true); f.bottom.value = y; fromBottom(); save('bottom', 'depth'); sync(false); };
    for (const k of Object.keys(f)) f[k].addEventListener('input', () => sync(false));
    f.top.addEventListener('input', () => { const t = num(f.top.value); if (mv && mv.top !== null && !Number.isNaN(t)) { mv.setSlice(t); slice.set(mv.top); } });          // a layer view follows the pit's top: you see what is about to be dug
    const fromSel = (b) => { if (!b) { for (const k of ['x0', 'x1', 'z0', 'z1']) f[k].value = ''; save('x0', 'x1', 'z0', 'z1'); return sync(true); } f.x0.value = b.x0; f.x1.value = b.x1; f.z0.value = b.z0; f.z1.value = b.z1; save('x0', 'x1', 'z0', 'z1'); sync(true); };
    // Top = ground needs only the area: it used to ask for the whole box (top and depth included), so on a fresh selection it always answered "select an area first"
    const ground = act(async () => {
        const b = hbox(); if (!b) throw new Error('select an area first');
        f.top.value = await groundTop(b, dimNow()); fromDepth(); save('top', 'bottom'); sync(false);
    }, 'top = the highest ground in the area');
    const depot = () => (carry.value === 'ender' ? { kind: 'shulker', item: 'enderstorage:ender_chest', minValue: Number(rankSel.value) } : carry.value === 'shulker' ? { kind: 'shulker', minValue: Number(rankSel.value) } : undefined);
    async function loadSites() {
        let sites = []; try { sites = (await api('GET', '/api/sites')).sites || []; } catch (_) { return; }
        const by = {}; for (const s of sites) if (s.purpose) (by[s.purpose] = by[s.purpose] || []).push(s.name);
        const line = Object.entries(by).map(([p, ns]) => `${p}: ${ns.join(', ')}`).join(' · ');
        sitesBox.replaceChildren(line ? `Tagged containers the bots use: ${line}. ` : 'No container is tagged yet: without one the bots throw cheap items away and keep the rest. ', h('a', { href: '#tags', onclick: (e) => { e.preventDefault(); show('tags'); } }, 'Tags page'));
    }
    const create = (start) => act(async () => { const b = box(); if (!b) throw new Error('select an area and give top and depth'); return api('POST', '/api/jobs/pit', { name: name.value.trim() || undefined, dim: dimNow(), box: b, depot: depot(), bots: [...picked].filter((n) => S && S.bots.some((x) => x.name === n)), lanes: Number.isInteger(num(lanesIn.value)) ? num(lanesIn.value) : undefined, method: methodSel.value, road: roadBox.checked, start }); }, (r) => `job ${r.id} created${start ? ' and started' : ''}`);
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-8' }, panel('Select the area', [h('p', { class: 'muted small', text: 'Drag over the map to select chunks (like a spreadsheet range); hold Alt for single blocks; Shift-drag extends; right-drag or Ctrl-drag pans; wheel zooms. The numbers on the right follow the selection and can be edited for any area.' }), host],
            { actions: [dimPick.el, slice.el, h('label', { class: 'check' }, snap, 'snap to chunks'), ...selectTools(() => mv, host), h('button', { class: 'btn small', onclick: () => mv && mv.fit() }, 'Fit'), ...mapTools(() => mv)] })),
        h('div', { class: 'span-4' }, panel('Pit', [
            h('div', { class: 'grid-form' }, field('x from', f.x0), field('x to', f.x1), field('z from', f.z0), field('z to', f.z1), field('top y', f.top), field('depth', f.depth), field('bottom y', f.bottom), field('quick', h('span', { class: 'row tight' }, h('button', { class: 'btn small', title: 'dig down to y -59: the lowest layer that is not bedrock', onclick: toBottom(-59) }, 'to y -59'), h('button', { class: 'btn small', title: 'the bottom of the world; bedrock cells are skipped', onclick: toBottom(-64) }, '-64')))),
            h('div', { class: 'row' }, h('button', { class: 'btn small', title: 'the highest ground in the selected area, read from the bots that have it loaded, else from the saved world', onclick: ground }, 'Top = ground'), h('button', { class: 'btn small', title: 'selection around the operator (needs RCON)', onclick: act(async () => { const p = (await api('GET', '/api/players')).find((q) => !q.bot && q.pos); if (!p) throw new Error('no operator position'); const b = { x0: (p.pos.x >> 4) << 4, z0: (p.pos.z >> 4) << 4 }; fromSel({ x0: b.x0, x1: b.x0 + 15, z0: b.z0, z1: b.z0 + 15 }); f.top.value = p.pos.y - 1; fromDepth(); save('top', 'bottom'); sync(false); }, 'the chunk the operator stands in') }, 'Operator chunk')),
            field('Dimension', dimPick.el, 'a pit in the Nether or the End: the bots are taken there first, and the heights are those of that dimension'), info, field('Name', name), field('Lanes', lanesIn, 'one X-Z range per bot, each dug down to the bottom'), field('Method', methodSel), h('label', { class: 'check' }, roadBox, ' keep a haul road (bots can walk in; off = bots leave by pillar)'),
            field('Storage and tools', sitesBox), field('Carried container', carry), rankField, h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Bots (none ticked: every idle bot)' }), chips, botRangePicker(chips)),
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: create(false) }, 'Create (paused)'), h('button', { class: 'btn primary', onclick: create(true) }, icon('play', 13), ' Create and start'))])));
    return {
        el,
        onShow() {
            if (!mv) { slice.set(null); mv = makeMap(host, { select: true, keep: 'pits', onSelect: fromSel, onSlice: (y) => slice.set(y), layers: { jobs: true, bots: true, players: true } }); mv.snapMode = snap.checked; showMap(mv, dimPick, slice).then(() => sync(false)); } else mv.fitSize();
            sync(false); loadSites();
        },
        update(s) {
            chips.replaceChildren(...(s.bots.length ? s.bots.map((b) => h('label', { class: `chip${picked.has(b.name) ? '' : ' off'}` }, h('input', { type: 'checkbox', checked: picked.has(b.name), onchange: (e) => { e.target.checked ? picked.add(b.name) : picked.delete(b.name); sync(false); update2(); } }), `${b.name}${b.job ? ' (busy)' : ''}`)) : [h('span', { class: 'muted', text: 'no bots yet' })]));
            function update2() { el.querySelectorAll('.chips .chip').forEach((c) => { const n = c.textContent.replace(' (busy)', ''); c.classList.toggle('off', !picked.has(n)); }); }
        },
    };
}

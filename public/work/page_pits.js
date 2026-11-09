'use strict';
// Pits page (range selection on the map like a spreadsheet, plus coordinates).
function pitsPage() {
    const f = Object.fromEntries(['x0', 'x1', 'z0', 'z1', 'top', 'depth', 'bottom'].map((k) => [k, h('input', { type: 'number', class: 'num', 'aria-label': k })]));
    f.depth.value = 3;
    const lanesIn = h('input', { type: 'number', class: 'num', min: 1, max: 32, placeholder: 'auto', title: 'one X-Z range per bot, dug down to the bottom; auto = one per bot' }), info = h('div', { class: 'info-box' }), chips = h('span', { class: 'chips' }), host = h('div', { class: 'map-host tall-map' }), name = h('input', { placeholder: 'optional', maxlength: 60 });
    const depotKind = h('select', { class: 'sel' }, [['', 'none (surplus is dropped)'], ['chest', 'chest at x y z'], ['shulker', 'shulker box (placed by the bot)'], ['ender', 'Ender Storage chest (carried, placed by the bot)']].map(([v, t]) => h('option', { value: v, text: t }))), dx = h('input', { type: 'number', class: 'num', placeholder: 'x' }), dy = h('input', { type: 'number', class: 'num', placeholder: 'y' }), dz = h('input', { type: 'number', class: 'num', placeholder: 'z' });
    // The depot's rank (janitor values: stone 5, coal 40, raw iron 70, diamond 100): what is worth less is thrown away instead of stored.
    const rankSel = h('select', { class: 'sel', title: 'what the depot takes; the rest is thrown away (never anything worth 60 or more)' }, [['0', 'store everything'], ['10', 'no stone, dirt, gravel, sand (value 10 and up)'], ['40', 'ores, coal, wood (40 and up)'], ['60', 'valuable only (60 and up)']].map(([v, t]) => h('option', { value: v, text: t })));
    rankSel.value = '10';
    const toolsBox = h('input', { type: 'checkbox', title: 'tag the depot chest as a tools chest too: bots that run out of a tool take a usable one from it' });
    const methodSel = h('select', { class: 'sel', title: 'sweep: stand in the middle of a tile and dig everything in reach, then move on (default). rows: the first method, cell by cell' }, [['sweep', 'sweep (stand, dig all in reach, move on)'], ['rows', 'rows (cell by cell)']].map(([v, t]) => h('option', { value: v, text: t }))), roadBox = h('input', { type: 'checkbox', title: 'keep a one-wide staircase along the edge so that a late or respawned bot can walk down (a sweep job leaves by pillar and needs none)' });
    const picked = new Set(); let mv = null;
    // The dimension of the job (a pulldown: overworld, nether, end, or "other" for a dimension id such as twilightforest:twilight_forest): the map shows it when the world folder has it; the bots are taken there before they start.
    const slice = sliceControl(() => mv);
    const dimPick = dimPicker((d) => { if (mv) { mv.setDim(d); Tiles.loadIndex(d).then(() => mv.fit()); } });
    const dimNow = () => dimPick.get();
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
    f.top.addEventListener('input', () => { const t = num(f.top.value); if (mv && mv.top !== null && !Number.isNaN(t)) { mv.setSlice(t); slice.set(mv.top); } });          // a layer view follows the pit's top: you see what is about to be dug
    const fromSel = (b) => { if (!b) { for (const k of ['x0', 'x1', 'z0', 'z1']) f[k].value = ''; return sync(true); } f.x0.value = b.x0; f.x1.value = b.x1; f.z0.value = b.z0; f.z1.value = b.z1; sync(true); };
    const ground = act(async () => {
        const b = box() || (() => { throw new Error('select an area first'); })(); const ys = [];
        for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1], [(b.x0 + b.x1) >> 1, (b.z0 + b.z1) >> 1]]) { const r = await api('GET', `/api/surface?x=${x}&z=${z}`); if (r.y !== null) ys.push(r.y); }
        if (!ys.length) throw new Error('no bot has that terrain loaded: type the top y');
        f.top.value = Math.max(...ys); sync(false);
    }, 'top = the highest ground found (corners and centre)');
    const depot = () => { const k = depotKind.value; return !k ? undefined : k === 'chest' ? { kind: 'chest', x: num(dx.value), y: num(dy.value), z: num(dz.value), minValue: Number(rankSel.value) } : k === 'ender' ? { kind: 'shulker', item: 'enderstorage:ender_chest', minValue: Number(rankSel.value) } : { kind: 'shulker', minValue: Number(rankSel.value) }; };
    // "also the tools chest": the depot block gets the purpose `tools` (a new tagged block `depot` when nothing is tagged there)
    async function tagDepotAsTools(d) {
        if (!toolsBox.checked || !d || d.kind !== 'chest') return;
        const sites = (await api('GET', '/api/sites')).sites, at = sites.find((q) => q.x === d.x && q.y === d.y && q.z === d.z);
        const body = at ? { ...at, purpose: 'tools' } : { name: 'depot', x: d.x, y: d.y, z: d.z, purpose: 'tools' };
        delete body.block; delete body.end; delete body.broken; delete body.tags;
        await api('POST', '/api/sites', body);
    }
    const create = (start) => act(async () => { const b = box(); if (!b) throw new Error('select an area and give top and depth'); const d = depot(); await tagDepotAsTools(d); return api('POST', '/api/jobs/pit', { name: name.value.trim() || undefined, dim: dimNow(), box: b, depot: d, bots: [...picked], lanes: Number.isInteger(num(lanesIn.value)) ? num(lanesIn.value) : undefined, method: methodSel.value, road: roadBox.checked, start }); }, (r) => `job ${r.id} created${start ? ' and started' : ''}`);
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-8' }, panel('Select the area', [h('p', { class: 'muted small', text: 'Drag over the map to select chunks (like a spreadsheet range); hold Alt for single blocks; Shift-drag extends; right-drag or Ctrl-drag pans; wheel zooms. The numbers on the right follow the selection and can be edited for any area.' }), host],
            { actions: [dimPick.el, slice.el, h('label', { class: 'check' }, snap, 'snap to chunks'), ...selectTools(() => mv, host), h('button', { class: 'btn small', onclick: () => mv && mv.fit() }, 'Fit')] })),
        h('div', { class: 'span-4' }, panel('Pit', [
            h('div', { class: 'grid-form' }, field('x from', f.x0), field('x to', f.x1), field('z from', f.z0), field('z to', f.z1), field('top y', f.top), field('depth', f.depth), field('bottom y', f.bottom), field('quick', h('span', { class: 'row tight' }, h('button', { class: 'btn small', title: 'dig down to y -59: the lowest layer that is not bedrock', onclick: toBottom(-59) }, 'to y -59'), h('button', { class: 'btn small', title: 'the bottom of the world; bedrock cells are skipped', onclick: toBottom(-64) }, '-64')))),
            h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: ground }, 'Top = ground'), h('button', { class: 'btn small', title: 'selection around the operator (needs RCON)', onclick: act(async () => { const p = (await api('GET', '/api/players')).find((q) => !q.bot && q.pos); if (!p) throw new Error('no operator position'); const b = { x0: (p.pos.x >> 4) << 4, z0: (p.pos.z >> 4) << 4 }; fromSel({ x0: b.x0, x1: b.x0 + 15, z0: b.z0, z1: b.z0 + 15 }); f.top.value = p.pos.y - 1; sync(false); }, 'the chunk the operator stands in') }, 'Operator chunk')),
            field('Dimension', dimPick.el, 'a pit in the Nether or the End: the bots are taken there first, and the heights are those of that dimension'), info, field('Name', name), field('Lanes', lanesIn, 'one X-Z range per bot, each dug down to the bottom'), field('Method', methodSel), h('label', { class: 'check' }, roadBox, ' keep a haul road (bots can walk in; off = bots leave by pillar)'), field('Depot', h('span', { class: 'row tight' }, depotKind, dx, dy, dz)), field('Depot takes', rankSel), h('label', { class: 'check' }, toolsBox, ' the depot chest is also the tools chest'), h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Bots (none ticked: every idle bot)' }), chips, botRangePicker(chips)),
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: create(false) }, 'Create (paused)'), h('button', { class: 'btn primary', onclick: create(true) }, icon('play', 13), ' Create and start'))])));
    return {
        el,
        onShow() { if (!mv) { slice.set(null); mv = makeMap(host, { select: true, onSelect: fromSel, onSlice: (y) => slice.set(y), layers: { jobs: true, bots: true, players: true } }); mv.snapMode = true; Tiles.loadIndex('overworld').then(() => { mv.fitSize(); mv.fit(); }); } else mv.fitSize(); sync(false); },
        update(s) {
            for (const n of [...picked]) if (!s.bots.some((b) => b.name === n)) picked.delete(n);
            chips.replaceChildren(...(s.bots.length ? s.bots.map((b) => h('label', { class: `chip${picked.has(b.name) ? '' : ' off'}` }, h('input', { type: 'checkbox', checked: picked.has(b.name), onchange: (e) => { e.target.checked ? picked.add(b.name) : picked.delete(b.name); sync(false); update2(); } }), `${b.name}${b.job ? ' (busy)' : ''}`)) : [h('span', { class: 'muted', text: 'no bots yet' })]));
            function update2() { el.querySelectorAll('.chips .chip').forEach((c) => { const n = c.textContent.replace(' (busy)', ''); c.classList.toggle('off', !picked.has(n)); }); }
            if (mv) mv.redraw();
        },
    };
}

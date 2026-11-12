'use strict';
// Place page (owner 2026-11-09): one block type laid as a floor, a wall, or the four walls of a room, picked on the map like a pit.
// A wall is the hard one to picture, so the page says in words what it will make, draws it on the map (start and end marked) and as a side view with the numbers at its ends.
function placePage() {
    const KINDS = [
        ['floor', 'Floor', 'One layer over the whole rectangle you drag. Level y is the height of the blocks.'],
        ['wall', 'Wall', 'A straight line: drag from where it starts to where it ends. It runs along the longer direction; the blocks stand on level y and rise by the height.'],
        ['room', 'Room walls', 'The four walls around the rectangle you drag; the inside stays open. Lay a floor separately.'],
        ['fill', 'Solid block', 'Every cell of the rectangle you drag, from level y up by the height (up to 256): the backfill of a pit.'],
    ];
    const COMMON = ['cobblestone', 'stone', 'stone_bricks', 'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks', 'bricks', 'sandstone', 'smooth_stone', 'glass', 'dirt', 'oak_log', 'deepslate_bricks', 'white_concrete', 'create:andesite_casing'];
    const f = Object.fromEntries(['x0', 'z0', 'x1', 'z1', 'y', 'height'].map((k) => [k, h('input', { type: 'number', class: 'num', 'aria-label': k })]));
    f.height.value = 3;
    const block = h('input', { value: 'cobblestone', list: 'place-blocks', class: 'wide', placeholder: 'cobblestone or create:andesite_casing', autocomplete: 'off' }), blocks = h('datalist', { id: 'place-blocks' }, COMMON.map((n) => h('option', { value: n })));
    const name = h('input', { placeholder: 'optional', maxlength: 60 }), info = h('div', { class: 'info-box' }), explain = h('div', { class: 'muted small' }), chips = h('span', { class: 'chips' }), host = h('div', { class: 'map-host tall-map' });
    const side = h('canvas', { class: 'layer-canvas', width: 360, height: 120 }), sideNote = h('div', { class: 'muted small' }), sideBox = h('div', { class: 'hidden' }, h('div', { class: 'inv-section', text: 'Side view (as seen from the front)' }), side, sideNote);
    const slice = sliceControl(() => mv);
    const dimPick = dimPicker((d) => { if (mv) { mv.setDim(d); Tiles.loadIndex(d).then(() => mv.fit()); } preview(); });
    const dimNow = () => dimPick.get();
    const picked = new Set(); let kind = 'wall', mv = null, last = null, timer = 0, seq = 0;
    const kindBtns = KINDS.map(([k, t]) => h('button', { class: 'btn', type: 'button', onclick: () => setKind(k) }, t));
    function setKind(k) {
        kind = k; kindBtns.forEach((b, i) => b.classList.toggle('primary', KINDS[i][0] === k));
        explain.textContent = KINDS.find((x) => x[0] === k)[2];
        f.height.disabled = k === 'floor'; if (mv) mv.snapMode = false;
        preview();
    }
    const spec = () => {
        const v = ['x0', 'z0', 'x1', 'z1', 'y'].map((k) => num(f[k].value));
        if (v.some(Number.isNaN)) return null;
        const [x0, z0, x1, z1, y] = v, s = { kind, block: block.value.trim(), x0, z0, x1, z1, y, dim: dimNow() };
        if (kind !== 'floor') { const hh = num(f.height.value); if (Number.isNaN(hh)) return null; s.height = hh; }
        if (kind === 'wall' && x0 !== x1 && z0 !== z1) { if (Math.abs(x1 - x0) >= Math.abs(z1 - z0)) s.z1 = z0; else s.x1 = x0; }          // the line follows the longer direction (the page says so)
        return s;
    };
    function drawSide(p) {
        const cv = side, c = cv.getContext('2d'), len = p.kind === 'wall' ? Math.max(p.size[0], p.size[2]) : p.size[0], hgt = p.size[1];
        const z = Math.max(2, Math.min(24, Math.floor(340 / len), Math.floor(140 / hgt))); cv.width = Math.min(360, len * z + 20); cv.height = hgt * z + 26;
        c.clearRect(0, 0, cv.width, cv.height);
        c.fillStyle = colorOfName(p.block); for (let i = 0; i < len; i++) for (let j = 0; j < hgt; j++) c.fillRect(10 + i * z, 4 + (hgt - 1 - j) * z, Math.max(1, z - 1), Math.max(1, z - 1));
        c.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted'); c.fillRect(4, 4 + hgt * z, cv.width - 8, 2);
        c.font = '11px ui-monospace, monospace';
        const a = p.kind === 'wall' && p.along === 'z' ? ['z', p.origin.z, p.origin.z + p.size[2] - 1] : ['x', p.origin.x, p.origin.x + p.size[0] - 1];
        c.fillText(`${a[0]} ${a[1]}`, 4, cv.height - 6); const t = `${a[0]} ${a[2]}`; c.fillText(t, cv.width - 6 - c.measureText(t).width, cv.height - 6);
        sideNote.textContent = `${len} long × ${hgt} high; the line under it is the ground (y ${p.origin.y - 1}); the first block sits at y ${p.origin.y}, the top one at y ${p.origin.y + hgt - 1}.${p.kind === 'room' ? ' Shown: the front wall; the other three look the same from their side.' : ''}`;
    }
    function drawMap(p) {
        if (!mv) return;
        mv.draft = p && p.ok ? p.boxes.map((b, i) => ({ box: b, color: '#5ad17a', label: i === 0 ? p.kind : '' })) : [];
        if (p && p.ok && p.kind === 'wall') mv.marks = [{ x: p.origin.x + 0.5, z: p.origin.z + 0.5, label: 'start' }, { x: p.origin.x + p.size[0] - 0.5, z: p.origin.z + p.size[2] - 0.5, label: 'end' }]; else if (mv) mv.marks = [];
        mv.redraw();
    }
    async function preview() {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const s = spec(), my = ++seq;
            if (!s) { last = null; info.replaceChildren(h('div', { class: 'muted', text: 'Drag on the map to choose the place (hold Alt is not needed: this page selects single blocks), then set the level y.' })); sideBox.classList.add('hidden'); drawMap(null); return; }
            let p; try { p = await api('POST', '/api/layout/preview', s); } catch (e) { p = { ok: false, why: e.message }; }
            if (my !== seq) return;
            last = p.ok ? { ...p, spec: s } : null;
            if (!p.ok) { info.replaceChildren(h('div', { class: 'warn', text: p.why })); sideBox.classList.add('hidden'); drawMap(null); return; }
            const wallNote = kind === 'wall' && (num(f.x0.value) !== num(f.x1.value) && num(f.z0.value) !== num(f.z1.value)) ? 'The numbers are not in a line, so the wall follows the longer direction (the other end is taken from "from").' : '';
            info.replaceChildren(h('div', {}, h('strong', { text: `${fmt(p.count)} blocks` }), ` of ${p.block} (${p.stacks} stack${p.stacks > 1 ? 's' : ''}) · ${p.describe}`), p.known ? null : h('div', { class: 'warn small', text: p.why }), wallNote ? h('div', { class: 'muted small', text: wallNote }) : null,
                h('div', { class: 'muted small', text: 'Bots put what they lack in their pack from the containers (tagged), place the rows bottom-up, and build a temporary stair where they cannot reach; it is taken away again.' }));
            sideBox.classList.toggle('hidden', kind === 'floor'); if (kind !== 'floor') drawSide(p);
            drawMap(p);
        }, 200);
    }
    for (const k of Object.keys(f)) f[k].addEventListener('input', preview);
    block.addEventListener('input', preview);
    // The map gives a box of two corners; a wall is the line from where the drag began to where it ended (along the longer direction).
    const fromSel = (b) => {
        if (!b) return;
        const a = mv && mv.sel && mv.sel.anchor ? mv.sel.anchor : [b.x0, b.z0], e = mv && mv.sel ? [mv.sel.x, mv.sel.z] : [b.x1, b.z1];
        if (kind === 'wall') { const alongX = Math.abs(e[0] - a[0]) >= Math.abs(e[1] - a[1]); f.x0.value = a[0]; f.z0.value = a[1]; f.x1.value = alongX ? e[0] : a[0]; f.z1.value = alongX ? a[1] : e[1]; }
        else { f.x0.value = b.x0; f.x1.value = b.x1; f.z0.value = b.z0; f.z1.value = b.z1; }
        if (mv) { mv.sel = null; mv.fixed = null; }                          // the preview draws the result; the blue rectangle would only confuse for a wall
        preview();
    };
    const groundY = async () => {
        const s = ['x0', 'z0', 'x1', 'z1'].map((k) => num(f[k].value)); if (s.some(Number.isNaN)) throw new Error('choose the place first');
        const ys = [];
        for (const [x, z] of [[s[0], s[1]], [s[2], s[3]], [(s[0] + s[2]) >> 1, (s[1] + s[3]) >> 1]]) { const r = await api('GET', `/api/surface?x=${x}&z=${z}`); if (r.y !== null) ys.push(r.y); }
        if (!ys.length) throw new Error('no bot has that terrain loaded: type the level y');
        return Math.max(...ys);
    };
    const onGround = act(async () => { f.y.value = (await groundY()) + 1; preview(); }, 'level y = one above the highest ground found');
    const replaceTop = act(async () => { f.y.value = await groundY(); preview(); }, 'level y = the highest ground block (it is replaced)');
    const create = (start) => act(async () => {
        const s = spec(); if (!s) throw new Error('choose the place and the level y'); if (!last || !last.ok) throw new Error(last ? last.why : 'the layout is not valid yet');
        return api('POST', '/api/jobs/layout', { ...s, name: name.value.trim() || undefined, bots: [...picked], start });
    }, (r) => `job ${r.id} created${start ? ' and started' : ''}`);
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-8' }, panel('Choose the place', [h('p', { class: 'muted small', text: 'Drag over the map (single blocks). Right-drag or Ctrl-drag pans; the wheel zooms. For a wall drag along the line it should follow; the green marks show start and end. The numbers on the right can be typed too.' }), host], { actions: [h('button', { class: 'btn small', onclick: () => mv && mv.fit() }, 'Fit')] })),
        h('div', { class: 'span-4' }, panel('Place blocks', [
            h('div', { class: 'row tight' }, kindBtns), explain,
            h('div', { class: 'grid-form' }, field('x from', f.x0), field('x to', f.x1), field('z from', f.z0), field('z to', f.z1), field('level y', f.y), field('height', f.height)),
            h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: onGround }, 'On the ground'), h('button', { class: 'btn small', onclick: replaceTop }, 'Replace the top layer')),
            field('Dimension', h('span', { class: 'row tight' }, dimPick.el, slice.el), 'the heights allowed are those of the dimension; the bots are taken there before they start'), field('Block', block, 'any block the bots can place; mod blocks by their full name'), blocks, info, sideBox, field('Name', name), h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Bots (none ticked: every idle bot)' }), chips, botRangePicker(chips)),
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: create(false) }, 'Create (paused)'), h('button', { class: 'btn primary', onclick: create(true) }, icon('play', 13), ' Create and start'))])));
    setKind('wall');
    return {
        el,
        onShow() {
            if (!mv) { mv = makeMap(host, { select: true, onSelect: fromSel, onSlice: (y) => slice.set(y), layers: { jobs: true, bots: true, players: true } }); mv.snapMode = false; Tiles.loadIndex('overworld').then(() => { mv.fitSize(); mv.fit(); }); } else mv.fitSize();
            preview();
        },
        update(s) {
            for (const n of [...picked]) if (!s.bots.some((b) => b.name === n)) picked.delete(n);
            chips.replaceChildren(...(s.bots.length ? s.bots.map((b) => h('label', { class: `chip${picked.has(b.name) ? '' : ' off'}` }, h('input', { type: 'checkbox', checked: picked.has(b.name), onchange: (e) => { e.target.checked ? picked.add(b.name) : picked.delete(b.name); e.target.parentElement.classList.toggle('off', !e.target.checked); } }), `${b.name}${b.job ? ' (busy)' : ''}`)) : [h('span', { class: 'muted', text: 'no bots yet' })]));
            if (mv) mv.redraw();
        },
    };
}

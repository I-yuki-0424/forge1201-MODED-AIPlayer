'use strict';
// Structures page (library, editor, layers, builds).
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
                h('button', { class: 'btn small danger', onclick: act(async () => { if (!(await ask(`Delete ${name}?`))) throw new Error('cancelled'); await api('DELETE', `/api/structures/${name}`); selected = null; detail = null; detailBox.replaceChildren(); editBox.classList.add('hidden'); buildBox.classList.add('hidden'); await load(); }, 'deleted', () => {}) }, 'Delete')));
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

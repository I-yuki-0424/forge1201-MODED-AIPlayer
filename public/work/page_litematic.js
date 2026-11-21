'use strict';
// Litematica page (owner 2026-11-21): the placements the server shares through Syncmatica, what one needs against what the material containers hold (loose and inside shulker boxes),
// and the build job. Everything is built with the DOM helpers of ui.js (textContent only); the server validates.
function litematicPage() {
    let list = [], sel = null, check = null, stock = null, busy = false;
    const selBots = new Set(), listBox = h('div', { class: 'list' }), infoBox = h('div'), checkBox = h('div'), stockBox = h('div'), bchips = h('span', { class: 'chips' });
    const ox = h('input', { type: 'number', class: 'num', placeholder: 'x' }), oy = h('input', { type: 'number', class: 'num', placeholder: 'y' }), oz = h('input', { type: 'number', class: 'num', placeholder: 'z' });
    const bname = h('input', { placeholder: 'optional', maxlength: 40 });
    const origin = () => { const v = [ox, oy, oz].map((i) => num(i.value)); if (v.every(Number.isNaN)) return undefined; if (v.some(Number.isNaN)) throw new Error('give x, y and z of the origin, or leave all three empty (the placement as Litematica shows it)'); return { x: v[0], y: v[1], z: v[2] }; };
    const spec = (start) => { const o = origin(); return { placement: sel.id, ...(o ? { origin: o } : {}), name: bname.value.trim() || undefined, bots: [...selBots], start }; };

    async function load() {
        try { list = await api('GET', '/api/litematic/placements'); } catch (e) { list = []; listBox.replaceChildren(h('div', { class: 'warn', text: e.message })); return; }
        if (sel && !list.some((p) => p.id === sel.id)) { sel = null; infoBox.replaceChildren(); }
        listBox.replaceChildren(...(list.length ? list.map((p) => h('div', { class: sel && sel.id === p.id ? 'on' : '', onclick: () => select(p) }, h('span', { text: p.name || p.fileName }),
            h('span', { class: 'muted small', text: `${p.dimension.replace('minecraft:', '')} · ${p.pos ? `${p.pos.x} ${p.pos.y} ${p.pos.z}` : '?'}${p.owner ? ' · ' + p.owner : ''}` })))
            : [h('div', { class: 'muted', text: 'The server shares no placement. In Litematica: load the schematic, create a placement, then Syncmatica "share" it (the bots see it after a few seconds).' })]));
    }
    function select(p) {
        sel = p; check = null; checkBox.replaceChildren();
        $$('.list > div', listBox).forEach((d) => d.classList.toggle('on', d.firstChild.textContent === (p.name || p.fileName)));
        infoBox.replaceChildren(h('div', { class: 'row' }, h('strong', { text: p.name || p.fileName }), h('span', { class: 'muted', text: `${p.dimension.replace('minecraft:', '')} · at ${p.pos ? `${p.pos.x} ${p.pos.y} ${p.pos.z}` : '?'} · rotation ${p.rotation} · mirror ${p.mirror} · ${p.subRegions} sub-region${p.subRegions === 1 ? '' : 's'}` })),
            h('p', { class: 'muted small', text: `file ${p.fileName} · owner ${p.owner || '?'} · last changed by ${p.lastModifiedBy || '?'}` }));
        run(false);
    }
    const rows = (c) => c.rows.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Material', 'Needed', 'In chests', 'In shulker boxes', 'Short'].map((x) => h('th', { text: x })))),
        h('tbody', {}, c.rows.map((r) => h('tr', {}, h('td', { class: 'mono', text: r.item }), h('td', { text: fmt(r.need) }), h('td', { text: fmt(r.loose) }), h('td', { text: fmt(r.boxed) }), h('td', { class: r.short ? 'warn' : 'muted', text: r.short ? fmt(r.short) : 'ok' }))))) : h('p', { class: 'muted', text: 'This placement needs no materials.' });
    async function run(showErr) {
        if (!sel || busy) return; busy = true;
        checkBox.replaceChildren(h('p', { class: 'muted', text: 'Downloading the placement and reading the containers …' }));
        try {
            const o = origin(); check = await api('POST', '/api/litematic/check', { placement: sel.id, ...(o ? { origin: o } : {}) });
            const p = check.preview;
            checkBox.replaceChildren(h('div', { class: 'row' }, h('span', { text: `${fmt(p.count)} blocks · size ${p.size.join('×')} · origin ${p.origin.x} ${p.origin.y} ${p.origin.z} · ${p.dim}` }),
                check.short ? h('span', { class: 'warn', text: `${check.short} material${check.short > 1 ? 's' : ''} short in the tagged containers` }) : h('span', { class: 'ok', text: 'every material is in the tagged containers' })),
                p.unsupported && p.unsupported.length ? h('div', { class: 'warn small', text: `not placeable (not in the bots' registry): ${p.unsupported.join(', ')}` }) : null,
                p.ignoredSubRegions && p.ignoredSubRegions.length ? h('div', { class: 'muted small', text: `sub-regions left out: ${p.ignoredSubRegions.join(', ')}` }) : null,
                h('div', { class: 'table-wrap' }, rows(check)));
        } catch (e) { checkBox.replaceChildren(h('div', { class: 'warn', text: e.message })); if (showErr) toast(e.message, true); }
        busy = false;
    }
    async function loadStock() {
        try { stock = await api('GET', '/api/litematic/stock'); } catch (e) { stockBox.replaceChildren(h('div', { class: 'warn', text: e.message })); return; }
        stockBox.replaceChildren(stock.sources.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Tag', 'Purpose', 'Position', 'Shulker boxes', 'Holds'].map((x) => h('th', { text: x })))),
            h('tbody', {}, stock.sources.map((s) => { const all = Object.entries(s.items).map(([k, v]) => [k, v.loose + v.boxed]).sort((a, b) => b[1] - a[1]); return h('tr', {}, h('td', {}, h('strong', { text: s.name })), h('td', {}, h('span', { class: `pill tag-${s.purpose}`, text: s.purpose })), h('td', { class: 'mono', text: `${s.x} ${s.y} ${s.z}${s.double ? ' (double chest)' : ''}` }), h('td', { text: String(s.boxes) }),
                h('td', { class: 'small', text: all.slice(0, 10).map(([k, n]) => `${k} ${fmt(n)}`).join(', ') + (all.length > 10 ? ` … (+${all.length - 10})` : '') || 'empty' })); })))
            : h('p', { class: 'warn', text: 'No container is tagged as a material source. Tag the chest on the Tags page (purpose materials, tools or free: bots take from these; any is insert-only).' }));
    }
    const create = (start) => act(async () => { if (!sel) throw new Error('choose a placement'); return api('POST', '/api/jobs/litematic', spec(start)); }, (r) => `job ${r.id} created${start ? ' and started' : ' (paused)'}: see Jobs`);
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-4' }, panel('Shared placements', h('div', { class: 'stack' }, listBox, h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: act(load, null, () => {}) }, 'Refresh list'))))),
        h('div', { class: 'span-8' }, panel('Placement', h('div', { class: 'stack' }, infoBox, checkBox)),
            panel('Build', h('div', { class: 'stack' },
                h('div', { class: 'row' }, field('origin x', ox), field('y', oy), field('z', oz), field('name', bname), h('button', { class: 'btn small', onclick: act(() => run(true), null, () => {}) }, 'Check materials')),
                h('p', { class: 'muted small', text: 'Origin empty = the placement as Litematica shows it (its position, rotation and mirror). Filled = the minimum corner of the built structure moves there.' }),
                h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Bots (none ticked: every idle bot)' }), bchips, botRangePicker(bchips)),
                h('div', { class: 'row' }, h('button', { class: 'btn', onclick: create(false) }, 'Create (paused)'), h('button', { class: 'btn primary', onclick: create(true) }, icon('play', 13), ' Create and start')))),
            panel('Material containers', h('div', { class: 'stack' }, stockBox,
                h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: act(loadStock, null, () => {}) }, 'Read the containers'), h('button', { class: 'btn small ghost', onclick: () => show('tags') }, 'Tags page')),
                h('p', { class: 'muted small', text: 'Bots take materials from tagged containers (purpose materials, tools or free) and out of shulker boxes inside them: a box is lifted out, set down beside the chest and stays there as a source for the run.' })))));
    return {
        el, onShow() { load(); loadStock(); },
        update(s) { for (const n of [...selBots]) if (!s.bots.some((b) => b.name === n)) selBots.delete(n); bchips.replaceChildren(...(s.bots.length ? s.bots.map((b) => h('label', { class: `chip${selBots.has(b.name) ? '' : ' off'}` }, h('input', { type: 'checkbox', checked: selBots.has(b.name), onchange: (e) => { e.target.checked ? selBots.add(b.name) : selBots.delete(b.name); e.target.closest('.chip').classList.toggle('off', !e.target.checked); } }), `${b.name}${b.job ? ' (busy)' : ''}`)) : [h('span', { class: 'muted', text: 'no bots yet' })])); },
    };
}

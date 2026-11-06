'use strict';
// The Tags page: blocks named by coordinates ("this block is XX, that one is YY"), with a label, functional tags and, for a machine, a LINK
// to the container that feeds it (like a symbolic link: commands on the machine's coordinates run on the container). The server validates;
// everything here is built with the DOM helpers of ui.js (textContent only).

function tagsPage() {
    let data = { tags: {}, sites: [] };
    const tableBox = h('div', { class: 'table-wrap' }), tagBox = h('div', { class: 'row' });
    const name = h('input', { placeholder: 'smelter', maxlength: 24, 'aria-label': 'name' }), label = h('input', { placeholder: 'free text, e.g. auto furnace', maxlength: 40, 'aria-label': 'label' });
    const xyz = ['x', 'y', 'z'].map((k) => h('input', { type: 'number', class: 'num', placeholder: k, 'aria-label': k }));
    const via = h('select', { class: 'sel', 'aria-label': 'link to' });
    const near = h('select', { class: 'sel', title: 'containers a bot has loaded around it' }, h('option', { value: '', text: 'block near a bot…' }));
    let tagChecks = {};

    async function load() { try { data = await api('GET', '/api/sites'); } catch (_) { return; } render(); }
    function render() {
        const known = Object.keys(data.tags);
        if (Object.keys(tagChecks).join() !== known.join()) {
            tagChecks = Object.fromEntries(known.map((t) => [t, h('input', { type: 'checkbox' })]));
            tagBox.replaceChildren(...known.map((t) => h('label', { class: 'chip', title: data.tags[t] }, tagChecks[t], ` ${t}`)));
        }
        const keep = via.value;
        via.replaceChildren(h('option', { value: '', text: 'no link' }), ...data.sites.filter((s) => !s.tags.includes('machine') && !s.via).map((s) => h('option', { value: s.name, text: `→ ${s.name}${s.label ? ` (${s.label})` : ''}` })));
        via.value = keep;
        const rows = data.sites.map((s) => h('tr', {},
            h('td', {}, h('strong', { text: s.name })), h('td', { text: s.label || '' }), h('td', { class: 'mono', text: (s.block || '?').replace('minecraft:', '') }),
            h('td', { class: 'mono', text: `${s.x} ${s.y} ${s.z}` }),
            h('td', {}, s.tags.map((t) => h('span', { class: `pill tag-${t}`, title: data.tags[t] || t, text: t }))),
            h('td', {}, s.via ? h('span', { class: s.broken ? 'warn mono' : 'mono', title: s.broken || (s.end ? `commands run at ${s.end.x} ${s.end.y} ${s.end.z}` : ''), text: s.broken ? `→ ${s.via} (${s.broken})` : `→ ${s.via}` }) : ''),
            h('td', {}, h('span', { class: 'row tight' }, h('button', { class: 'btn small', onclick: () => edit(s) }, 'Edit'),
                h('button', { class: 'btn small ghost danger', onclick: act(() => { if (!confirm(`Remove ${s.name}?`)) throw new Error('cancelled'); return api('DELETE', `/api/sites/${s.name}`); }, 'tag removed', load) }, 'Remove')))));
        tableBox.replaceChildren(rows.length
            ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Name', 'Label', 'Block', 'Position', 'Tags', 'Link', ''].map((x) => h('th', { text: x })))), h('tbody', {}, rows))
            : h('p', { class: 'muted', text: 'Nothing tagged yet. Without tags the upkeep uses the job depot or throws cheap items away.' }));
    }
    function edit(s) {
        name.value = s.name; label.value = s.label || ''; [s.x, s.y, s.z].forEach((v, i) => { xyz[i].value = v; }); via.value = s.via || '';
        for (const [t, b] of Object.entries(tagChecks)) b.checked = s.tags.includes(t);
        name.focus();
    }
    near.addEventListener('focus', async () => {
        const S = getS(), bots = S ? S.bots.filter((b) => b.state === 'online') : []; if (!bots.length) return;
        try {
            const list = await api('GET', `/api/bots/${bots[0].name}/containers`);
            near.replaceChildren(h('option', { value: '', text: `near ${bots[0].name} (${list.length})` }), ...list.map((c) => h('option', { value: `${c.x},${c.y},${c.z}`, text: `${(c.block || 'container').replace('minecraft:', '')} ${c.x} ${c.y} ${c.z}${c.site ? ` = ${c.site}` : ''}` })));
        } catch (_) { /* no list: type the coordinates */ }
    });
    near.addEventListener('change', () => { if (near.value) near.value.split(',').forEach((v, i) => { xyz[i].value = v; }); });
    const save = act(async () => {
        const tags = Object.entries(tagChecks).filter(([, b]) => b.checked).map(([t]) => t), p = xyz.map((i) => num(i.value));
        if (!name.value.trim()) throw new Error('give the block a name'); if (p.some(Number.isNaN)) throw new Error('give x, y and z');
        if (!tags.length && !label.value.trim() && !via.value) throw new Error('tick a tag, write a label or choose a link');
        const body = { name: name.value.trim(), x: p[0], y: p[1], z: p[2], tags };
        if (label.value.trim()) body.label = label.value.trim(); if (via.value) body.via = via.value;
        return api('POST', '/api/sites', body);
    }, (r) => `${r.name} saved`, load);
    const here = act(async () => {
        const p = (await api('GET', '/api/players')).find((q) => !q.bot && q.pos); if (!p) throw new Error('no operator online (needs RCON)');
        ['x', 'y', 'z'].forEach((k, i) => { xyz[i].value = Math.floor(p.pos[k]); });
    }, 'position of the operator (stand next to the block, adjust y if needed)', () => {});
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-12' }, panel('Tagged blocks', h('div', { class: 'stack' }, tableBox))),
        h('div', { class: 'span-12' }, panel('Tag a block', h('div', { class: 'stack' },
            h('div', { class: 'row' }, field('Name', name), field('Label', label), field('x y z', h('span', { class: 'row tight' }, xyz)), field('', h('span', { class: 'row tight' }, near, h('button', { class: 'btn small', onclick: here }, 'My position')))),
            tagBox,
            h('div', { class: 'row' }, field('Link to (container)', via), h('button', { class: 'btn primary', onclick: save }, 'Save')),
            h('p', { class: 'muted small', text: 'Tags say what a chest is for: ore, junk, storage ... tell the upkeep where each kind of item goes; tools is where bots may take tools. A label is any text you like. ' +
                'A LINK makes a block a symbolic link to a container: for an automatic furnace with a chest and hopper beside it, tag the chest (say ore), tag the furnace as machine and link it to the chest. ' +
                'Then deposit and withdraw at the furnace (its coordinates, or on the Commands form the "tagged" button) put items into the chest and take the results out of it.' })))));
    // From the in-game Tag Tool (#goto=tags&x&y&z): the block's coordinates are filled in; a block that is tagged already opens for editing
    async function prefill() {
        if (typeof PREFILL === 'undefined' || !PREFILL || PREFILL.page !== 'tags' || [PREFILL.x, PREFILL.y, PREFILL.z].some(Number.isNaN)) return;
        const p = PREFILL; PREFILL.page = null;
        const at = data.sites.find((q) => q.x === p.x && q.y === p.y && q.z === p.z);
        if (at) edit(at); else { [p.x, p.y, p.z].forEach((v, i) => { xyz[i].value = v; }); name.value = ''; name.focus(); }
        toast(at ? `${at.name} is tagged: edit it` : `tag the block at ${p.x} ${p.y} ${p.z}`);
    }
    return { el, async onShow() { await load(); await prefill(); } };
}

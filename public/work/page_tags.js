'use strict';
// The Tags page: blocks named by coordinates ("this block is XX, that one is YY"), each with a label, ONE purpose chosen from a pulldown (what the block
// is for: tools, ore, trash, anything ...), for a furnace/machine a LINK to the container that feeds it (like a symbolic link: commands on the machine's
// coordinates run on the container) and, for an Ender Storage chest, its three colours. Below: every Ender Storage frequency the world has saved, what is
// in it and which tagged blocks use it. The server validates; everything here is built with the DOM helpers of ui.js (textContent only).

function tagsPage() {
    let data = { tags: {}, purposes: {}, sites: [], colours: [] }, ender = { frequencies: [], available: false };
    const tableBox = h('div', { class: 'table-wrap' }), tagBox = h('div', { class: 'row' });
    const name = h('input', { placeholder: 'smelter', maxlength: 24, 'aria-label': 'name' }), label = h('input', { placeholder: 'free text, e.g. auto furnace', maxlength: 40, 'aria-label': 'label' });
    const xyz = ['x', 'y', 'z'].map((k) => h('input', { type: 'number', class: 'num', placeholder: k, 'aria-label': k }));
    const via = h('select', { class: 'sel', 'aria-label': 'link to' });
    const near = h('select', { class: 'sel', title: 'containers a bot has loaded around it' }, h('option', { value: '', text: 'block near a bot…' }));
    const purpose = h('select', { class: 'sel', 'aria-label': 'purpose' });
    const useEnder = h('input', { type: 'checkbox', 'aria-label': 'Ender Storage chest' });
    const col = ['left', 'middle', 'right'].map((k) => h('select', { class: 'sel', 'aria-label': `${k} colour` }));
    const owner = h('input', { placeholder: 'owner UUID (private chest only)', maxlength: 36, 'aria-label': 'owner UUID' });
    const dimSel = h('select', { class: 'sel', 'aria-label': 'dimension of a portal' }, ['overworld', 'nether', 'end'].map((d) => h('option', { value: d, text: d })));
    const twinSel = h('select', { class: 'sel', 'aria-label': 'portal on the other side' });
    const leadsSel = h('select', { class: 'sel', 'aria-label': 'dimension the portal leads to' }, [['', 'not said (use the twin)'], ['overworld', 'overworld'], ['nether', 'nether'], ['end', 'end']].map(([v, t]) => h('option', { value: v, text: t })));
    const enderBox = h('div', { class: 'table-wrap' });
    let known = '';

    async function load() {
        try { data = await api('GET', '/api/sites'); } catch (_) { return; }
        try { ender = await api('GET', '/api/enderstorage'); } catch (_) { ender = { frequencies: [], available: false }; }
        render();
    }
    function render() {
        const names = Object.keys(data.purposes || data.tags);
        if (names.join() !== known) {                       // the pulldowns are built once from what the server offers
            known = names.join(); const keep = purpose.value;
            purpose.replaceChildren(...names.map((t) => h('option', { value: t, text: `${t} — ${(data.purposes || data.tags)[t]}` })));
            purpose.value = names.includes(keep) ? keep : 'other';
            for (const c of col) c.replaceChildren(...(data.colours || []).map((n) => h('option', { value: n, text: n.replace('_', ' ') })));
        }
        tagBox.replaceChildren(h('span', { class: 'muted small', text: (data.purposes || data.tags)[purpose.value] || '' }));
        const keep = via.value;
        via.replaceChildren(h('option', { value: '', text: 'no link' }), ...data.sites.filter((s) => s.purpose !== 'furnace' && !s.via).map((s) => h('option', { value: s.name, text: `→ ${s.name}${s.label ? ` (${s.label})` : ''}` })));
        via.value = keep;
        const tk = twinSel.value;
        twinSel.replaceChildren(h('option', { value: '', text: 'no twin' }), ...data.sites.filter((s) => s.purpose === 'portal').map((s) => h('option', { value: s.name, text: `↔ ${s.name} (${s.dim || 'overworld'})` })));
        twinSel.value = tk;
        const rows = data.sites.map((s) => h('tr', {},
            h('td', {}, h('strong', { text: s.name })), h('td', { text: s.label || '' }), h('td', { class: s.missing ? 'warn mono' : 'mono', title: s.missing ? 'a bot sees air here: the coordinates are wrong, or the block was taken away' : '', text: s.missing ? '⚠ air' : (s.block || '?').replace('minecraft:', '') }),
            h('td', { class: 'mono', text: `${s.x} ${s.y} ${s.z}` }),
            h('td', {}, h('span', { class: `pill tag-${s.purpose}`, title: (data.purposes || data.tags)[s.purpose] || s.purpose, text: s.purpose }),
                s.purpose === 'portal' ? h('span', { class: 'pill tag-portal', title: 'stands in this dimension; leads to its twin on the other side, or to the dimension after the arrow', text: `${s.dim || 'overworld'}${s.twin ? ` ↔ ${s.twin}` : ''}${s.leads ? ` → ${s.leads}` : ''}` }) : '',
                s.ender ? h('span', { class: 'pill ender', title: 'Ender Storage frequency', text: `${s.ender.left} / ${s.ender.middle} / ${s.ender.right}${s.ender.owner ? ' (private)' : ''}` }) : ''),
            h('td', {}, s.via ? h('span', { class: s.broken ? 'warn mono' : 'mono', title: s.broken || (s.end ? `commands run at ${s.end.x} ${s.end.y} ${s.end.z}` : ''), text: s.broken ? `→ ${s.via} (${s.broken})` : `→ ${s.via}` }) : ''),
            h('td', {}, h('span', { class: 'row tight' }, h('button', { class: 'btn small', onclick: () => edit(s) }, 'Edit'),
                h('button', { class: 'btn small ghost danger', onclick: act(async () => { if (!(await ask(`Remove ${s.name}?`))) throw new Error('cancelled'); return api('DELETE', `/api/sites/${s.name}`); }, 'tag removed', load) }, 'Remove')))));
        tableBox.replaceChildren(rows.length
            ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Name', 'Label', 'Block', 'Position', 'Tags', 'Link', ''].map((x) => h('th', { text: x })))), h('tbody', {}, rows))
            : h('p', { class: 'muted', text: 'Nothing tagged yet. Without tags the upkeep uses the job depot or throws cheap items away.' }));
        const migrated = (data.migrated || []).map((m) => `${m.name}: ${m.was.join(' + ')} → ${m.now}`);
        const fr = ender.frequencies.map((f) => h('tr', {},
            h('td', {}, h('span', { class: 'pill ender', text: f.label })),
            h('td', { class: 'mono', text: f.size ? `${f.used}/${f.size}` : '' }),
            h('td', { text: f.items.length ? f.items.slice(0, 4).map((i) => `${i.count} ${i.item.replace('minecraft:', '')}`).join(', ') + (f.items.length > 4 ? ` … (+${f.items.length - 4})` : '') : 'empty' }),
            h('td', {}, f.sites.length ? f.sites.map((q) => h('span', { class: `pill tag-${q.purpose}`, title: `${q.name} at ${q.x} ${q.y} ${q.z}`, text: `${q.name}: ${q.purpose}` })) : h('span', { class: 'muted', text: 'no tagged chest' }))));
        enderBox.replaceChildren(...(migrated.length ? [h('p', { class: 'warn small', text: `Old tags were reduced to one purpose: ${migrated.join('; ')}. Check them.` })] : []),
            fr.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Colours (left / middle / right)', 'Slots', 'Inside', 'Used for'].map((x) => h('th', { text: x })))), h('tbody', {}, fr))
                : h('p', { class: 'muted', text: ender.available ? 'No Ender Storage frequency has been saved in this world yet.' : 'The world folder is not mounted (WORK_WORLD): the contents cannot be shown, tagged chests are listed.' }));
    }
    function edit(s) {
        name.value = s.name; label.value = s.label || ''; [s.x, s.y, s.z].forEach((v, i) => { xyz[i].value = v; }); via.value = s.via || '';
        purpose.value = s.purpose || 'other'; useEnder.checked = !!s.ender; dimSel.value = s.dim || 'overworld'; twinSel.value = s.twin || ''; leadsSel.value = s.leads || '';
        if (s.ender) { col[0].value = s.ender.left; col[1].value = s.ender.middle; col[2].value = s.ender.right; owner.value = s.ender.owner || ''; } else owner.value = '';
        tagBox.replaceChildren(h('span', { class: 'muted small', text: (data.purposes || data.tags)[purpose.value] || '' }));
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
    purpose.addEventListener('change', () => tagBox.replaceChildren(h('span', { class: 'muted small', text: (data.purposes || data.tags)[purpose.value] || '' })));
    const save = act(async () => {
        const p = xyz.map((i) => num(i.value));
        if (!name.value.trim()) throw new Error('give the block a name'); if (p.some(Number.isNaN)) throw new Error('give x, y and z');
        if (purpose.value === 'other' && !label.value.trim() && !via.value && !useEnder.checked) throw new Error('choose a purpose, write a label or choose a link');
        const body = { name: name.value.trim(), x: p[0], y: p[1], z: p[2], purpose: purpose.value };
        if (label.value.trim()) body.label = label.value.trim(); if (via.value) body.via = via.value;
        if (purpose.value === 'portal') { body.dim = dimSel.value; if (twinSel.value) body.twin = twinSel.value; if (leadsSel.value) body.leads = leadsSel.value; }
        if (useEnder.checked) body.ender = { left: col[0].value, middle: col[1].value, right: col[2].value, ...(owner.value.trim() ? { owner: owner.value.trim() } : {}) };
        return api('POST', '/api/sites', body);
    }, (r) => `${r.name} saved`, load);
    const here = act(async () => {
        const p = (await api('GET', '/api/players')).find((q) => !q.bot && q.pos); if (!p) throw new Error('no operator online (needs RCON)');
        ['x', 'y', 'z'].forEach((k, i) => { xyz[i].value = Math.floor(p.pos[k]); });
    }, 'position of the operator (stand next to the block, adjust y if needed)', () => {});
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-12' }, panel('Tagged blocks', h('div', { class: 'stack' }, tableBox))),
        h('div', { class: 'span-12' }, panel('Ender Storage: colours and what they are used for', enderBox)),
        h('div', { class: 'span-12' }, panel('Tag a block', h('div', { class: 'stack' },
            h('div', { class: 'row' }, field('Name', name), field('Label', label), field('x y z', h('span', { class: 'row tight' }, xyz)), field('', h('span', { class: 'row tight' }, near, h('button', { class: 'btn small', onclick: here }, 'My position')))),
            h('div', { class: 'row' }, field('Purpose', purpose), tagBox),
            h('div', { class: 'row' }, field('Portal stands in (the dimension the block is in)', dimSel), field('leads to (an End portal has no twin)', leadsSel), field('or: twin gate (other side)', twinSel)),
            h('div', { class: 'row' }, field('Ender Storage chest', h('span', { class: 'row tight' }, useEnder, ' colours', ...col, owner))),
            h('div', { class: 'row' }, field('Link to (container)', via), h('button', { class: 'btn primary', onclick: save }, 'Save')),
            h('p', { class: 'muted small', text: 'The purpose says what a block is for: ore, trash, any ... tell the upkeep where each kind of item goes; tools is where bots may take tools; free is a chest whose contents bots may use at will. A label is any text you like. ' +
                'Ender Storage: tick the box and choose the three colours of a chest that stands there (a chest you did not place is left standing by the bots: they only use what is in it). A private chest also needs its owner\'s UUID. ' +
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

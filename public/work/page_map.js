'use strict';
// Map page.
function mapPage() {
    const host = h('div', { class: 'map-host tall-map' }), side = h('div', { class: 'maplist' }), cursor = h('span', { class: 'mono muted', text: 'x, z' });
    const dimSel = h('select', { class: 'sel', onchange: () => { mv.setDim(dimSel.value); Tiles.loadIndex(dimSel.value).then(() => mv.fit()); } }, ['overworld', 'nether', 'end'].map((d) => h('option', { value: d, text: d })));
    const layers = { jobs: true, bots: true, players: true };
    const chk = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { layers[k] = e.target.checked; mv.redraw(); } }), label);
    let mv = null;
    const refresh = act(async () => { await api('POST', '/api/map/refresh', {}); await Tiles.loadIndex(dimSel.value, true); mv.redraw(); }, 'the server saved its chunks; the map follows what is on disk');
    const el = h('div', { class: 'grid-12' }, h('div', { class: 'span-12' }, h('div', { class: 'toolbar' }, h('span', { class: 'field-label', text: 'Dimension' }), dimSel, h('button', { class: 'btn', onclick: () => mv.fit() }, 'Fit'), h('button', { class: 'btn', title: 'save-all on the server, then reload the map from disk (the map shows saved chunks)', onclick: refresh }, icon('refresh', 14), ' Refresh from server'), chk('jobs', 'jobs'), chk('bots', 'bots'), chk('players', 'players'), h('span', { class: 'grow' }), cursor)),
        h('div', { class: 'span-9' }, panel('World', host)), h('div', { class: 'span-3' }, panel('Objects', side)));
    return {
        el,
        onShow() { if (!mv) { mv = makeMap(host, { layers, onHover: (w) => { cursor.textContent = `x ${w[0]}  z ${w[1]}  · chunk ${Math.floor(w[0] / 16)}, ${Math.floor(w[1] / 16)}`; } }); Tiles.loadIndex('overworld').then(() => { mv.fitSize(); mv.fit(); }); } else mv.fitSize(); },
        update(s) {
            const item = (label, p, kind) => h('div', { class: 'maprow', onclick: () => p && mv.centerOn(p.x, p.z, Math.max(mv.view.scale, 4)) }, h('span', { class: `dot ${kind}` }), h('span', { text: label }), h('span', { class: 'mono muted small', text: p ? `${Math.round(p.x)}, ${Math.round(p.z)}` : '' }));
            side.replaceChildren(h('div', { class: 'inv-section', text: 'Players' }), ...players.filter((p) => !p.bot).map((p) => item(p.name, p.pos, 'online')), ...(players.length ? [] : [h('div', { class: 'muted small', text: s.rcon ? 'nobody online' : 'RCON off' })]),
                h('div', { class: 'inv-section', text: 'Bots' }), ...s.bots.map((b) => item(b.name, b.pos, b.state)),
                h('div', { class: 'inv-section', text: 'Jobs' }), ...s.jobs.filter((j) => ACTIVE.includes(j.state)).map((j) => item(`${j.id} ${j.name}`, { x: (j.box.x0 + j.box.x1) / 2, z: (j.box.z0 + j.box.z1) / 2 }, j.kind === 'pit' ? 'paused' : 'ready')));
            if (mv) mv.redraw();
        },
        players() { this.update(S); },
    };
}

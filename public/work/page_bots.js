'use strict';
// Bots page (AWS-style: filter, bulk actions, table, detail pane with tabs).
function botsPage() {
    const selection = new Set(); let focus = null, tab = 'commands', filterText = '', stateFilter = '';
    const tableBox = h('div', { class: 'table-wrap' }), bulk = h('span', { class: 'row tight' }), detail = h('div', { class: 'detail-pane' });
    const filter = h('input', { class: 'search', placeholder: 'Filter bots', oninput: (e) => { filterText = e.target.value.toLowerCase(); render(); } });
    const stateSel = h('select', { class: 'sel', onchange: (e) => { stateFilter = e.target.value; render(); } }, [['', 'All states'], ['online', 'online'], ['offline', 'offline'], ['connecting', 'connecting']].map(([v, t]) => h('option', { value: v, text: t })));
    const addBots = () => {
        const name = h('input', { placeholder: 'Work1', maxlength: 16 }), prefix = h('input', { value: 'Work', maxlength: 13 }), count = h('input', { type: 'number', class: 'num', value: 4, min: 1, max: 24 });
        const m = modal('Add bots', [h('div', { class: 'row' }, field('One bot', name), h('button', { class: 'btn primary', onclick: act(async () => { await api('POST', '/api/bots', { name: name.value.trim() }); m.close(); }, 'bot added') }, 'Add')), h('div', { class: 'sep' }),
            h('div', { class: 'row' }, field('Name prefix', prefix), field('How many', count), h('button', { class: 'btn primary', onclick: act(async () => { const r = await api('POST', '/api/bots', { prefix: prefix.value.trim(), count: num(count.value) }); m.close(); return r; }, (r) => `${r.added.length} bots added`) }, 'Add batch')),
            h('p', { class: 'muted small', text: 'Bots log in under their own name (offline mode: the network is the access control) and start in survival with an empty inventory.' })]);
    };
    const bulkBtn = (label, fn, cls = '') => h('button', { class: `btn small ${cls}`, onclick: fn }, label);
    const targets = () => {
        const online = S ? S.bots.filter((b) => b.state === 'online').map((b) => b.name) : [];
        return [{ value: 'all', label: `All bots (${online.length})`, names: online }, { value: 'selected', label: `Selected (${selection.size})`, names: [...selection] }, ...(S ? S.bots : []).map((b) => ({ value: `bot:${b.name}`, label: b.name, names: [b.name] }))];
    };
    const cmdPanel = CommandPanel({ targets, S: getS, players: getPlayers });
    const tabs = h('div', { class: 'tabs' }), tabBody = h('div', { class: 'tab-body' });
    let invPage = null;
    const TABS = [['commands', 'Commands'], ['summary', 'Summary'], ['inventory', 'Inventory'], ['history', 'History']];
    function renderTabs() {
        tabs.replaceChildren(...TABS.map(([k, t]) => h('button', { class: `tab${tab === k ? ' on' : ''}`, onclick: () => { tab = k; renderTabs(); } }, k === 'commands' ? t : `${t}${focus ? ': ' + focus : ''}`)));
        tabBody.replaceChildren();
        if (tab === 'commands') { cmdPanel.syncTargets(); tabBody.append(cmdPanel.el, statusTable()); return; }
        if (!focus) { tabBody.append(h('p', { class: 'muted', text: 'Click a bot in the table to see its details here.' })); return; }
        const b = S && S.bots.find((x) => x.name === focus); if (!b) { tabBody.append(h('p', { class: 'muted', text: `${focus} is gone.` })); return; }
        if (tab === 'summary') tabBody.append(summary(b));
        if (tab === 'inventory') { invPage = InventoryPage(getS, getPlayers); invPage.a.setTarget('bot', focus); const first = players.find((p) => !p.bot); invPage.b.setTarget('operator', first ? first.name : ''); tabBody.append(invPage.el); }
        if (tab === 'history') tabBody.append(historyView(b));
    }
    function statusTable() {
        const t = cmdPanel.el.querySelector('select') ? targets().find((x) => x.value === ($$('select', cmdPanel.el)[0] || {}).value) : null;
        const names = (t && t.names.length ? t.names : S ? S.bots.map((b) => b.name) : []).slice(0, 24);
        return h('div', { class: 'cmd-status' }, h('div', { class: 'inv-section', text: 'Latest command per bot' }), h('table', { class: 'tbl' }, h('tbody', {}, names.map((n) => { const b = S && S.bots.find((x) => x.name === n); const c = b && b.cmd; return h('tr', {}, h('td', { text: n }), h('td', {}, c ? [stateDot(c.status === 'running' ? 'running' : c.status === 'ok' ? 'online' : 'offline'), ` ${c.name} · ${c.status}${c.progress ? ` ${c.progress.got}/${c.progress.want}` : ''}${c.result && c.result.reason ? ' (' + c.result.reason + ')' : ''}`] : h('span', { class: 'muted', text: 'none yet' })), h('td', { class: 'muted small', text: c && c.result && c.result.detail ? c.result.detail.slice(0, 110) : '' })); }))));
    }
    function summary(b) {
        const kv = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
        return h('div', {}, h('dl', { class: 'kv' }, ...kv('State', [stateDot(b.state), ' ', b.state]), ...kv('Activity', botActivity(b)), ...kv('Job', b.job || '-'), ...kv('Position', posText(b.pos)), ...kv('Health / food', `${b.health ?? '-'} / ${b.food ?? '-'}`), ...kv('Tools', toolList(b)), ...kv('Script', b.script || '-'), ...kv('Free slots', String(b.free ?? '-')), ...kv('Retired', b.retired || '-'), ...kv('Last error', b.error || '-')),
            h('div', { class: 'row' }, b.retired ? h('button', { class: 'btn', onclick: act(() => api('POST', `/api/bots/${b.name}/resume`, {}), 'resumed') }, 'Resume') : null, b.inPit ? h('button', { class: 'btn', title: 'bring the bot out of its pit: walk if a road allows, else dig to the edge, stack blocks up, step out (pause the job first)', onclick: act(() => api('POST', `/api/bots/${b.name}/leave`, {}), (r) => r.ok ? `${b.name} is out (${r.how})` : `${b.name}: ${r.reason}`) }, 'Leave pit') : null, h('button', { class: 'btn danger', onclick: act(() => { if (!confirm(`Remove ${b.name}?`)) throw new Error('cancelled'); focus = null; selection.delete(b.name); return api('DELETE', `/api/bots/${b.name}`); }, 'removed') }, 'Remove bot')));
    }
    function historyView(b) {
        const box = h('div'); api('GET', `/api/bots/${b.name}`).then((d) => box.replaceChildren(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['When', 'Command', 'Result', 'Time'].map((x) => h('th', { text: x })))), h('tbody', {}, (d.history.length ? d.history : []).map((x) => h('tr', {}, h('td', { text: ago(x.at) + ' ago' }), h('td', { class: 'mono small', text: `${x.name} ${JSON.stringify(x.args)}` }), h('td', { text: `${x.status}${x.reason ? ' (' + x.reason + ')' : ''}` }), h('td', { text: `${(x.ms / 1000).toFixed(1)} s` })))), d.history.length ? null : h('p', { class: 'muted', text: 'No commands sent yet.' })))).catch((e) => box.append(h('p', { class: 'err-line', text: e.message })));
        return box;
    }
    function render() {
        if (!S) return;
        tableBox.replaceChildren(botTable(S.bots, { selection, filter: (b) => (!filterText || b.name.toLowerCase().includes(filterText)) && (!stateFilter || b.state === stateFilter), onRow: (n) => { if (n) { focus = n; if (tab === 'commands') tab = 'summary'; } renderTabs(); render(); } }));
        const sel = [...selection].filter((n) => S.bots.some((b) => b.name === n));
        bulk.replaceChildren(h('span', { class: 'muted small', text: sel.length ? `${sel.length} selected` : 'Select bots to act on several at once' }),
            sel.length ? [bulkBtn('Leave pit', act(async () => { for (const n of sel) { const b = S.bots.find((x) => x.name === n); if (b && b.inPit) await api('POST', `/api/bots/${n}/leave`, {}); } }, 'bots left the pit'), 'small'), bulkBtn('Stop commands', act(() => api('POST', '/api/commands', { bots: sel, command: 'stop', args: {} }), 'stop sent')), bulkBtn('Resume', act(async () => { for (const n of sel) await api('POST', `/api/bots/${n}/resume`, {}); }, 'resumed')),
                bulkBtn('Remove', act(async () => { if (!confirm(`Remove ${sel.length} bots?`)) throw new Error('cancelled'); for (const n of sel) await api('DELETE', `/api/bots/${n}`); selection.clear(); }, 'removed'), 'danger')] : null);
    }
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-12' }, h('div', { class: 'toolbar' }, filter, stateSel, h('span', { class: 'grow' }), bulk, h('button', { class: 'btn primary', onclick: addBots }, icon('plus', 14), ' Add bots'))),
        h('div', { class: 'span-12' }, panel('Bots', tableBox)),
        h('div', { class: 'span-12' }, panel('Details', [tabs, tabBody], { cls: 'detail' })));
    let lastKey = '';
    return {
        el, onShow() { renderTabs(); },
        update(s) {
            render();
            const key = tab + focus + s.bots.map((b) => b.name + b.state).join(',');                     // rebuild the command form only when the roster changed
            if (tab === 'commands') { cmdPanel.syncTargets(); const st = $('.cmd-status', tabBody); if (st) st.replaceWith(statusTable()); }
            if (key !== lastKey && tab !== 'commands' && tab !== 'inventory') { lastKey = key; renderTabs(); } else lastKey = key;
            if (tab === 'inventory' && invPage) invPage.tick();
        },
        players() { if (tab === 'commands') cmdPanel.refreshItems(); },
    };
}

/** Tools of a bot with their durability: `iron pickaxe 212/250`, worn ones (passed over by the retireWorn rule) in red. */
function toolList(b) {
    if (!b.tools || !b.tools.length) return h('span', { class: 'muted', text: 'none' });
    return h('span', { class: 'toollist' }, b.tools.map((t) => h('span', { class: `tool${t.worn ? ' worn' : ''}`, title: t.worn ? 'worn: not used while "Retire worn tools" is on' : '' }, `${t.name.replace(/_/g, ' ')} `, h('span', { class: 'mono', text: `${t.left}/${t.max}` }), durBar(t.left, t.max))));
}
function durBar(left, max) { const f = clamp(left / max, 0, 1); return h('span', { class: 'dur' }, h('span', { class: 'dur-fill', style: `width:${Math.round(f * 100)}%;background:hsl(${Math.round(f * 120)} 70% 45%)` })); }

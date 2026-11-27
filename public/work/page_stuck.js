'use strict';
// Snapshots page (TASK-20261127-084): the pictures src/debug/stuck.js wrote when a bot got stuck, lost time, or a build's interval was over, one run at a time, grouped by
// kind. Each event: when, which bot, the log line, its pictures (click one: the event's facts, the lines around it, the pictures at full size). Read-only; everything from the
// files is shown with textContent (the log lines carry whatever the bots and the server wrote).
const SNAP_KINDS = {
    stall: 'no action for a minute', no_stance: 'no way to the stance', move_no_start: 'the planner found no start', no_progress: 'no progress', evacuate: 'evacuated from the site',
    death: 'died', guard: 'held at an edge by the fall guard, again and again', slow_plan: 'a plan kept the thread for long', retry: 'trying again after a failure for long',
    long_wait: 'a long wait for another bot or the server', progress: 'a build, every 10 minutes',
};
function stuckPage() {
    const runSel = h('select', { class: 'sel', 'aria-label': 'run', onchange: () => { Keep.set('stuck.run', runSel.value); loadRun(); } });
    const kindSel = h('select', { class: 'sel', 'aria-label': 'kind', onchange: () => { Keep.set('stuck.kind', kindSel.value); render(); } });
    const status = h('span', { class: 'muted small' }), box = h('div', { class: 'stack' });
    let runs = [], index = null;
    const img = (run, id, view, cls = 'snap-thumb') => h('img', { class: cls, src: `/api/stuck/img/${encodeURIComponent(run)}/${encodeURIComponent(id)}/${view}.png`, alt: `${view} of ${id}`, loading: 'lazy' });
    async function loadRuns() {
        let r; try { r = await api('GET', '/api/stuck/runs'); } catch (_) { return; }
        runs = r.runs || [];
        const st = r.status;
        status.textContent = !r.available ? 'no snapshot folder on this console (WORK_STUCK_DIR)' : st ? `folder ${(st.bytes / 1048576).toFixed(1)} MB of ${Math.round(st.budget / 1048576)} MB${st.pruned ? `, ${st.pruned} old events pruned` : ''}` : '';
        const keep = runSel.value || Keep.get('stuck.run');
        runSel.replaceChildren(...runs.map((x) => h('option', { value: x.run, text: `${x.run} — ${x.events} events (${Object.entries(x.byKind).map(([k, n]) => `${k} ${n}`).join(', ')})` })));
        if (runs.some((x) => x.run === keep)) runSel.value = keep;
        await loadRun();
    }
    async function loadRun() {
        if (!runSel.value) { index = null; return render(); }
        try { index = await api('GET', `/api/stuck/run/${encodeURIComponent(runSel.value)}`); } catch (_) { index = null; }
        const kinds = Object.keys((index && index.byKind) || {}), keep = kindSel.value || Keep.get('stuck.kind') || '';
        kindSel.replaceChildren(h('option', { value: '', text: 'every kind' }), ...kinds.map((k) => h('option', { value: k, text: `${k} (${index.byKind[k].length})` })));
        kindSel.value = kinds.includes(keep) ? keep : '';
        render();
    }
    function render() {
        box.replaceChildren();
        if (!index) { box.append(panel('Snapshots', h('p', { class: 'muted', text: runs.length ? 'Choose a run.' : 'No snapshots yet. They are written while a harness run or a console has STUCK_SNAPSHOTS on.' }))); return; }
        const groups = {};
        for (const e of index.events) if (!kindSel.value || e.cause === kindSel.value) (groups[e.cause] = groups[e.cause] || []).push(e);
        for (const [kind, evs] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
            const cards = [...evs].reverse().map((e) => h('div', { class: 'snap-card' },
                h('div', { class: 'row tight' }, h('strong', { text: e.bot || e.job || '' }), h('span', { class: 'muted small mono', text: new Date(e.t).toLocaleString() }), e.diff ? h('span', { class: 'pill warn', title: 'cells where the bot\'s world and the server disagree', text: `${e.diff} differ` }) : null),
                h('div', { class: 'small mono snap-line', text: e.line }),
                h('div', { class: 'row tight' }, ...(e.images || []).map((f) => { const v = f.replace(/\.png$/, ''); const im = img(index.run, e.id, v); im.addEventListener('click', () => openEvent(index.run, e.id)); return im; }))));
            box.append(panel(`${kind} — ${SNAP_KINDS[kind] || ''} (${evs.length})`, h('div', { class: 'snap-grid' }, cards)));
        }
    }
    async function openEvent(run, id) {
        let ev; try { ev = await api('GET', `/api/stuck/event/${encodeURIComponent(run)}/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); return; }
        const facts = [
            ['when', ev.time], ['kind', ev.kind], ['bot', ev.bot || ''], ['position', ev.pos ? `${ev.pos.x.toFixed(2)} ${ev.pos.y.toFixed(3)} ${ev.pos.z.toFixed(2)}` : ''], ['facing', ev.scene ? ev.scene.dir : ''],
            ['on the ground', ev.onGround === undefined ? '' : String(ev.onGround)], ['health / food', ev.health === undefined ? '' : `${ev.health} / ${ev.food}`], ['controls', (ev.controls || []).join(' ')],
            ['phase', ev.phase ? ev.phase.name : ''], ['fall guard', ev.guard ? `${ev.guard.stops} stops${ev.guard.lastStop ? `, last at ${ev.guard.lastStop.x} ${ev.guard.lastStop.y} ${ev.guard.lastStop.z}` : ''}` : ''],
            ['server truth', ev.server ? (ev.server.error || `${ev.server.checked} cells checked, ${Object.keys(ev.server.diff || {}).length} differ${ev.server.unchecked ? `, ${ev.server.unchecked} not checked` : ''}`) : ''],
            ['textures', ev.textures || ''], ['size', `${Math.round((ev.bytes || 0) / 1024)} KB, drawn in ${ev.renderMs} ms`], ['error', ev.error || ''],
        ].filter(([, v]) => v);
        const diffs = Object.entries((ev.server && ev.server.diff) || {}).map(([k, v]) => `${k} ${v}`);
        modal(`${ev.kind}: ${ev.bot || ev.job || ''} (${ev.id})`, h('div', { class: 'stack' },
            h('div', { class: 'small mono snap-line', text: ev.line }),
            h('table', { class: 'tbl' }, h('tbody', {}, facts.map(([k, v]) => h('tr', {}, h('td', { class: 'muted', text: k }), h('td', { class: 'mono', text: String(v) }))))),
            ...(ev.images || []).map((f) => img(run, id, f.replace(/\.png$/, ''), 'snap-full')),
            diffs.length ? h('pre', { class: 'logbox', text: `bot's world vs server:\n${diffs.slice(0, 80).join('\n')}` }) : null,
            h('pre', { class: 'logbox', text: ['before:', ...(ev.before || []), '', `>> ${ev.line}`, '', 'after:', ...(ev.after || [])].join('\n') }),
            ev.status ? h('pre', { class: 'logbox', text: JSON.stringify(ev.status, null, 1) }) : null), { wide: true });
    }
    return { el: panel('Snapshots', h('div', { class: 'stack' }, h('div', { class: 'row' }, field('Run', runSel), field('Kind', kindSel), h('button', { class: 'btn small', onclick: loadRuns }, 'Reload'), status), box)), onShow: loadRuns };
}

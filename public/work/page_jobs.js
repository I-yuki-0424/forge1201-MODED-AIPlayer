'use strict';
// Jobs page.
function jobsPage() {
    const box = h('div'); let open = null, detail = null;
    async function loadDetail() { if (!open) return; try { detail = await api('GET', `/api/jobs/${open}`); } catch (_) { detail = null; } }
    setInterval(async () => { if (session.csrf && open && currentPage === 'jobs') { await loadDetail(); render(); } }, 4000);
    function render() {
        if (!S) return; box.replaceChildren();
        if (!S.jobs.length) box.append(panel('Jobs', h('p', { class: 'muted', text: 'No jobs. Select an area in Pits or build a structure.' })));
        for (const j of [...S.jobs].reverse()) {
            const p = j.progress, row = h('div', { class: 'row' });
            if (['ready', 'paused'].includes(j.state)) row.append(h('button', { class: 'btn primary small', onclick: act(() => api('POST', `/api/jobs/${j.id}/start`, {}), 'started') }, icon('play', 12), ' Start'));
            if (j.state === 'running') row.append(h('button', { class: 'btn small', onclick: act(() => api('POST', `/api/jobs/${j.id}/pause`, {}), 'paused') }, icon('pause', 12), ' Pause'));
            if (ACTIVE.includes(j.state)) {
                row.append(h('button', { class: 'btn small', onclick: act(() => api('POST', `/api/jobs/${j.id}/assign`, { bots: S.bots.filter((b) => b.state === 'online' && !b.job).map((b) => b.name) }), 'assigned') }, 'Add idle bots'));
                row.append(h('button', { class: 'btn small danger', onclick: act(async () => { if (!(await ask(`Cancel ${j.id}? Progress in the world stays.`))) throw new Error('cancelled'); return api('POST', `/api/jobs/${j.id}/cancel`, {}); }, 'cancelled') }, 'Cancel'));
            }
            if (p.stuck) row.append(h('button', { class: 'btn small', onclick: act(() => api('POST', `/api/jobs/${j.id}/repair`, {}), (r) => `${r.requeued} units queued again`) }, `Retry ${p.stuck} stuck`));
            if (j.kind === 'build' && S.rcon && ACTIVE.includes(j.state)) row.append(h('button', { class: 'btn small', title: 'give the bots the blocks this build needs', onclick: act(() => api('POST', `/api/jobs/${j.id}/supply`, {}), 'materials given') }, 'Give materials'));
            row.append(h('button', { class: 'btn small ghost', onclick: async () => { open = open === j.id ? null : j.id; detail = null; await loadDetail(); render(); } }, 'Details'));
            if (!['running', 'paused'].includes(j.state)) row.append(h('button', { class: 'btn small ghost danger', onclick: act(() => api('DELETE', `/api/jobs/${j.id}`), 'deleted') }, 'Delete'));
            const body = [jobRow(j), h('div', { class: 'muted small', text: `bots: ${j.bots.join(', ') || 'none'}${j.diff !== null && j.diff !== undefined ? ` · missing blocks after the run: ${j.diff}` : ''} · box ${j.box.x0},${j.box.z0} → ${j.box.x1},${j.box.z1} y ${j.box.y0}..${j.box.y1}` }),
                j.summary && j.summary.unsupported && j.summary.unsupported.length ? h('div', { class: 'warn small', text: `not placeable (not in the bots' registry): ${j.summary.unsupported.join(', ')}` }) : null,
                j.kind === 'build' && j.summary && j.summary.materials ? h('div', { class: 'small muted', text: 'needs: ' + Object.entries(j.summary.materials).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') }) : null, row];
            if (open === j.id && detail) { body.push(h('div', { class: 'small' }, 'Per bot: ' + Object.entries(detail.report.bots).map(([n, b]) => `${n} ${b.done} done / ${b.failed} failed / ${b.faults} own faults${b.alive ? '' : ' (left)'}`).join(' · '))); if (detail.report.stuck.length) body.push(h('div', { class: 'warn small', text: 'Stuck: ' + detail.report.stuck.slice(0, 12).map((s) => `${s.region} layer ${s.layer} row ${s.row} (${s.reason})`).join('; ') })); }
            box.append(panel(`${j.id} · ${j.kind}`, body, { actions: h('span', { class: `pill ${j.state}`, text: j.state }) }));
        }
    }
    return { el: h('div', {}, box), update() { render(); } };
}

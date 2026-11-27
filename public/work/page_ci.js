'use strict';
// CI page (TASK-20261125-080): the live regression suite's history (scripts/ci/regress.sh on test world 9, recorded by scripts/ci/history.js), newest first: per run the commit,
// per test the server-graded verdict, trials and seconds, and the change against the previous run of main BOTH ways (worse in red, better in green). Click a run: every test with its
// seed, speed, failures and what it was before. Read-only; everything from the files is shown with textContent.
function ciPage() {
    const status = h('span', { class: 'muted small' }), box = h('div', { class: 'stack' });
    const when = (s) => (s ? new Date(s * 1000).toLocaleString() : '');
    const mark = (r, t) => (r.worse || []).includes(`${t.name}/${t.kind}`) ? 'error' : (r.better || []).includes(`${t.name}/${t.kind}`) ? 'ok' : '';
    const cell = (t) => (t.verdict === 'pass' || t.verdict === 'fail' ? `${t.k}/${t.n}${t.sec ? ` ${t.sec}s` : ''}` : t.verdict.replace('_', ' '));
    async function load() {
        let r; try { r = await api('GET', '/api/ci/runs'); } catch (_) { return; }
        const runs = r.runs || [];
        status.textContent = !r.available ? 'no CI folder on this console (WORK_CI_DIR)' : `${runs.length} runs`;
        box.replaceChildren();
        if (!runs.length) { box.append(panel('CI', h('p', { class: 'muted', text: 'No CI run recorded yet.' }))); return; }
        const names = []; for (const x of runs) for (const t of x.tests || []) { const k = `${t.name}/${t.kind}`; if (!names.includes(k)) names.push(k); }
        const head = h('tr', {}, h('th', { text: 'run' }), h('th', { text: 'commit' }), h('th', { text: 'passed' }), ...names.map((k) => h('th', { class: 'small', text: k.replace('/fixed', '') })));
        const rows = runs.map((x) => h('tr', { class: 'clickable', onclick: () => openRun(x.id) },
            h('td', { class: 'mono small', text: `${x.id}${x.label ? ` [${x.label}]` : ''}` }),
            h('td', { class: 'small', title: x.subject || '', text: `${(x.sha || '').slice(0, 8)} ${(x.subject || '').slice(0, 48)}` }),
            h('td', { text: `${x.pass}/${x.ran}` }),
            ...names.map((k) => { const t = (x.tests || []).find((q) => `${q.name}/${q.kind}` === k); return h('td', { class: `small mono ${t ? mark(x, t) : ''}`, text: t ? `${t.verdict === 'pass' ? '✓' : t.verdict === 'fail' ? '✗' : '–'} ${cell(t)}` : '' }); })));
        box.append(panel('Runs (red: worse than the run before, green: better)', h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' }, h('thead', {}, head), h('tbody', {}, rows)))));
    }
    async function openRun(id) {
        let r; try { r = await api('GET', `/api/ci/run/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); return; }
        const rows = (r.tests || []).map((t) => {
            const c = t.change;
            return h('tr', {},
                h('td', { class: mark(r, t), text: t.verdict }), h('td', { text: t.name }), h('td', { class: 'small', text: t.kind }), h('td', { class: 'mono small', text: t.seed }), h('td', { text: t.speed ? `x${t.speed}` : '' }),
                h('td', { text: cell(t) }),
                h('td', { class: 'small', text: c ? `rate ${c.rate}, time ${c.time} (was ${c.was.k ?? '-'}/${c.was.n ?? '-'} ${c.was.verdict}${c.was.sec ? ` ${c.was.sec}s` : ''})${c.sameSeed ? '' : ' other seed'}` : 'no baseline' }));
        });
        const fails = (r.tests || []).filter((t) => (t.fails || []).length).map((t) => `${t.name} (${t.kind}):\n  ${t.fails.join('\n  ')}`);
        modal(`CI run ${r.id}`, h('div', { class: 'stack' },
            h('div', { class: 'small', text: `${r.sha} "${r.subject}" (${r.ref}${r.label ? `, ${r.label}` : ''}) on ${r.profile}, test world 9, ${when(r.started)} - ${when(r.ended)}; baseline ${r.baseline || 'none'}` }),
            h('div', { class: 'small', text: `worse: ${(r.worse || []).join(', ') || 'none'} · better: ${(r.better || []).join(', ') || 'none'}` }),
            h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...['verdict', 'test', 'kind', 'seed', 'speed', 'trials / time', 'against the run before'].map((x) => h('th', { text: x })))), h('tbody', {}, rows)),
            fails.length ? h('pre', { class: 'logbox', text: fails.join('\n\n') }) : null), { wide: true });
    }
    return { el: panel('CI', h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: load }, 'Reload'), status), box)), onShow: load };
}

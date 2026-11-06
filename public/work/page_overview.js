'use strict';
// Overview page: tiles, map, jobs, activity feed, bots.
function overviewPage() {
    const tiles = h('div', { class: 'tiles' }), mapHost = h('div', { class: 'map-host small-map' }), jobsBox = h('div'), actBox = h('div', { class: 'feed' }), botsBox = h('div');
    let mv = null;
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-12' }, tiles),
        h('div', { class: 'span-8' }, panel('Map', mapHost, { actions: [h('button', { class: 'btn small', onclick: () => mv && mv.fit() }, 'Fit'), h('button', { class: 'btn small', onclick: () => show('map') }, 'Open')] })),
        h('div', { class: 'span-4' }, panel('Jobs', jobsBox), panel('Activity', actBox)),
        h('div', { class: 'span-12' }, panel('Bots', botsBox, { actions: h('button', { class: 'btn small', onclick: () => show('bots') }, 'Manage') })));
    return {
        el,
        onShow() { if (!mv) { mv = makeMap(mapHost, { layers: { jobs: true, bots: true, players: true } }); Tiles.loadIndex('overworld').then(() => { mv.fitSize(); mv.fit(); }); } else mv.fitSize(); },
        update(s) {
            const on = s.bots.filter((b) => b.state === 'online').length, jobs = s.jobs.filter((j) => ACTIVE.includes(j.state)), done = jobs.reduce((n, j) => n + j.progress.done, 0), total = jobs.reduce((n, j) => n + j.progress.total, 0);
            const rate = HIST.t.length > 3 ? Math.max(0, (HIST.done[HIST.done.length - 1] - HIST.done[0]) / ((HIST.t[HIST.t.length - 1] - HIST.t[0]) / 60000)) : 0;
            tiles.replaceChildren(
                tile('Bots online', `${on} / ${s.bots.length}`, `${s.bots.filter((b) => b.working).length} on jobs`, spark(HIST.online, { color: '#73bf69' })),
                tile('Players', String(players.filter((p) => !p.bot).length), players.filter((p) => !p.bot).map((p) => p.name).join(', ') || (s.rcon ? 'nobody online' : 'RCON off')),
                tile('Jobs running', String(s.jobs.filter((j) => j.state === 'running').length), `${jobs.length} open · ${s.jobs.length} total`),
                tile('Rows done', total ? `${Math.round(100 * done / total)} %` : '-', total ? `${fmt(done)} of ${fmt(total)}` : 'no open job', spark(HIST.done, { color: '#ff9830' })),
                tile('Throughput', `${rate.toFixed(rate < 10 ? 1 : 0)} rows/min`, 'over the last minutes'),
                tile('Console uptime', ago(Date.now() - s.uptime), s.map ? 'map: world files' : 'no map data'));
            jobsBox.replaceChildren(...(s.jobs.length ? [...s.jobs].reverse().slice(0, 6).map((j) => jobRow(j, { compact: true })) : [h('p', { class: 'muted', text: 'No jobs yet.' })]));
            actBox.replaceChildren(...[...s.log].reverse().slice(0, 9).map((e) => h('div', { class: `feed-line ${e.level}` }, h('span', { class: 'muted mono small', text: new Date(e.t).toLocaleTimeString() }), ' ', e.msg)));
            botsBox.replaceChildren(botTable(s.bots, { compact: true }));
        },
        players() { this.update(S); },
    };
}

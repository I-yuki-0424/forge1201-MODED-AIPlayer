'use strict';
// Routes: status, log, problems, players, terrain, settings, sites (tagged blocks) and scripts.
const { json } = require('../http');

module.exports = (service) => async (req, url, m, p) => {
    let a;
    if (m === 'GET' && p === '/api/state') return service.status();
    if (m === 'GET' && p === '/api/log') return service.log.slice(-Number(url.searchParams.get('n') || 200));
    if (m === 'GET' && p === '/api/problems') return service.problemsView(Number(url.searchParams.get('n') || 100));
    if (m === 'GET' && p === '/api/players') return service.players();
    if (m === 'GET' && p === '/api/surface') return service.surface(Number(url.searchParams.get('x')), Number(url.searchParams.get('z')));
    if (m === 'POST' && p === '/api/settings') return service.setSettings(await json(req));
    // sites (tagged blocks by coordinates) and scripts
    if (m === 'GET' && p === '/api/sites') return service.listSites();
    if (m === 'GET' && p === '/api/enderstorage') return service.enderStorage();
    if (m === 'POST' && p === '/api/sites') return service.addSite(await json(req));
    if ((a = /^\/api\/sites\/([a-z0-9][a-z0-9_-]{0,23})$/.exec(p)) && m === 'DELETE') return service.removeSite(a[1]);
    if (m === 'GET' && p === '/api/scripts') return service.listScripts();
    if (m === 'POST' && p === '/api/scripts') return service.putScript(await json(req));
    if ((a = /^\/api\/scripts\/([a-z0-9][a-z0-9_-]{0,31})$/.exec(p)) && m === 'DELETE') return service.deleteScript(a[1]);
    if ((a = /^\/api\/scripts\/([a-z0-9][a-z0-9_-]{0,31})\/run$/.exec(p)) && m === 'POST') { const b = await json(req); return service.runScript(String(b.bot), a[1]); }
};

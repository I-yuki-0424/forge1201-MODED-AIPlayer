'use strict';
// Routes: jobs (pit, build) and their actions.
const { json } = require('../http');
const { Problem } = require('../../service');

module.exports = (service) => async (req, url, m, p) => {
    let a;
    if (m === 'POST' && p === '/api/jobs/pit') return service.createPit(await json(req));
    if (m === 'POST' && p === '/api/jobs/build') return service.createBuild(await json(req));
    if (m === 'POST' && p === '/api/range/check') return service.checkRange(await json(req));
    if (m === 'GET' && p === '/api/dimensions') return service.dimensionsList();
    if (m === 'POST' && p === '/api/layout/preview') return service.previewLayout(await json(req));
    if (m === 'POST' && p === '/api/jobs/layout') return service.createLayout(await json(req));
    if ((a = /^\/api\/jobs\/(j\d{1,9})(?:\/(start|pause|cancel|repair|supply|assign|unassign))?$/.exec(p))) {
        const id = a[1], act = a[2];
        if (m === 'GET' && !act) return service.jobDetail(id);
        if (m === 'DELETE' && !act) { service.deleteJob(id); return { ok: true }; }
        if (m === 'POST') {
            if (act === 'start') return service.startJob(id);
            if (act === 'pause') return service.pauseJob(id);
            if (act === 'cancel') return service.cancelJob(id);
            if (act === 'repair') return service.repairJob(id);
            const b = await json(req);
            if (act === 'supply') return service.supply(id, b.bot ? String(b.bot) : null);
            if (act === 'assign') { if (!Array.isArray(b.bots)) throw new Problem('bots must be a list'); return service.assign(id, b.bots.map(String)); }
            if (act === 'unassign') return service.unassign(id, String(b.bot));
        }
    }
};

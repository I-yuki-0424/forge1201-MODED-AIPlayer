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
            // A list of names, or a range by number ({range: {from, to}}: Work3 is number 3), or both.
            const named = () => [...(Array.isArray(b.bots) ? b.bots.map(String) : []), ...(b.range ? service.botsInRange(b.range.from, b.range.to) : [])];
            if (act === 'assign') { const names = named(); if (!names.length) throw new Problem('bots must be a list, or a range {from, to}'); return service.assign(id, [...new Set(names)]); }
            if (act === 'unassign') { if (b.range) return service.unassignMany(id, service.botsInRange(b.range.from, b.range.to)); return service.unassign(id, String(b.bot)); }
        }
    }
};

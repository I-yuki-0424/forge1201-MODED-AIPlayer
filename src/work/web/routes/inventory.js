'use strict';
// Routes: inventories (read, move a stack, move all) and the map.
const { json } = require('../http');

module.exports = (service) => async (req, url, m, p) => {
    if (m === 'POST' && p === '/api/inventory') { const b = await json(req); return service.inventory(b.target); }
    if (m === 'POST' && p === '/api/inventory/move') { const b = await json(req); return service.moveStack({ src: b.src, srcSlot: b.srcSlot, dst: b.dst, dstSlot: b.dstSlot ?? null }); }
    if (m === 'POST' && p === '/api/inventory/moveall') { const b = await json(req); return service.moveAllStacks({ src: b.src, dst: b.dst }); }
    if (m === 'GET' && p === '/api/map/regions') return service.mapIndex(url.searchParams.get('dim') || 'overworld');
    if (m === 'GET' && p === '/api/map/region') {
        const top = url.searchParams.get('top');
        const r = await service.mapRegion(url.searchParams.get('dim') || 'overworld', Number(url.searchParams.get('rx')), Number(url.searchParams.get('rz')), top === null || top === '' ? null : Number(top));
        return { rx: r.rx, rz: r.rz, mtime: r.mtime, chunks: r.chunks, names: r.names, idx: r.idx ? r.idx.toString('base64') : null, h: r.h ? r.h.toString('base64') : null };
    }
    if (m === 'POST' && p === '/api/map/refresh') return service.mapRefresh();
};

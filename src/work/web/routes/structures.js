'use strict';
// Routes: the structure library (list, generate, download, edit, upload, layers).
const { json, readBody, MAX_UPLOAD, Raw } = require('../http');

module.exports = (service) => async (req, url, m, p) => {
    let a;
    if (m === 'GET' && p === '/api/structures') return service.listStructures();
    if (m === 'POST' && p === '/api/structures/generate') { const b = await json(req); return service.generate(String(b.kind), b.params || {}, String(b.as)); }
    if ((a = /^\/api\/structures\/([a-z0-9][a-z0-9_-]{0,47})(?:\/(download|edit|layer\/(\d{1,3})))?$/.exec(p))) {
        const name = a[1], sub = a[2];
        if (m === 'GET' && !sub) return service.structureDetail(name);
        if (m === 'GET' && sub === 'download') return new Raw(service.structureFile(name), 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${name}.nbt"` });
        if (m === 'GET' && a[3] !== undefined) return service.structureLayer(name, Number(a[3]));
        if (m === 'POST' && sub === 'edit') { const b = await json(req); return service.editStructure(name, b.ops, b.as ? String(b.as) : null, { overwrite: b.overwrite === true }); }
        if (m === 'POST' && !sub) {                                                       // upload: the raw .nbt as the body
            const buf = await readBody(req, MAX_UPLOAD);
            return service.putStructure(name, buf, { overwrite: url.searchParams.get('overwrite') === '1' });
        }
        if (m === 'DELETE' && !sub) { service.deleteStructure(name); return { ok: true }; }
    }
};

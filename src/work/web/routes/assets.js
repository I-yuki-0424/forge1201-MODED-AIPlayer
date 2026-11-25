'use strict';
// Routes: the game's own pictures and names for the inventory (assets/store.js). Same session as every route; textures are PNG files of a closed set of paths, served
// same-origin (the CSP's img-src 'self'), cached by the browser for a day.
const { Raw } = require('../http');
const { Problem } = require('../../service');

const ID = /^[a-z0-9_.-]{1,32}:[a-z0-9_/.-]{1,64}$/;
const TEX = /^\/api\/assets\/tex\/((?:block|item)\/[a-z0-9_]{1,64}(?:\/[a-z0-9_]{1,64})?)\.png$/;

module.exports = (service, { assets = null } = {}) => async (req, url, m, p) => {
    if (m !== 'GET' || !p.startsWith('/api/assets/')) return undefined;
    if (p === '/api/assets/status') return assets ? assets.status() : { version: null, ready: false, fetching: false, error: 'the console has no asset folder (WORK_ASSETS)' };
    if (!assets) throw new Problem('the console has no asset folder (WORK_ASSETS)', 503);
    if (p === '/api/assets/icons') {
        const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
        if (!ids.length || ids.length > 128 || !ids.every((i) => ID.test(i))) throw new Problem('ids: 1 to 128 item ids (namespace:name), comma separated');
        return assets.icons(ids);
    }
    const t = TEX.exec(p);
    if (t) {
        const png = assets.texture(t[1]);
        if (!png) throw new Problem('no such texture', 404);
        return new Raw(png, 'image/png', { 'Cache-Control': 'private, max-age=86400' });
    }
    return undefined;
};

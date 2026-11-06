'use strict';
// Routes: the roster, one-off commands, bot detail, what is near a bot.
const { json } = require('../http');
const { Problem, BOT_NAME } = require('../../service');

module.exports = (service) => async (req, url, m, p) => {
    let a;
    if (m === 'POST' && p === '/api/bots') {
        const b = await json(req), added = [];
        if (b.name !== undefined) added.push(service.addBot(String(b.name)));
        else {
            const count = Number(b.count), prefix = String(b.prefix || 'Work');
            if (!Number.isInteger(count) || count < 1 || count > 24) throw new Problem('count is 1..24');
            let n = 1; const taken = (x) => service.bots.has(x);
            while (added.length < count && n < 1000) { const name = `${prefix}${n++}`; if (!BOT_NAME.test(name)) throw new Problem('prefix: letters, digits, _ (max 13)'); if (!taken(name)) added.push(service.addBot(name)); }
        }
        return { added };
    }
    if ((a = /^\/api\/bots\/([A-Za-z0-9_]{3,16})(?:\/(kit|resume|leave))?$/.exec(p))) {
        if (m === 'DELETE' && !a[2]) { service.removeBot(a[1]); return { ok: true }; }
        if (m === 'POST' && a[2] === 'kit') return service.kitBot(a[1]);
        if (m === 'POST' && a[2] === 'resume') return service.resumeBot(a[1]);
        if (m === 'POST' && a[2] === 'leave') return service.leavePit(a[1]);
    }
    if (m === 'GET' && p === '/api/commands/catalog') return service.catalog();
    if (m === 'POST' && p === '/api/commands') { const b = await json(req); return service.runCommand({ bots: b.bots, command: String(b.command), args: b.args || {} }); }
    if ((a = /^\/api\/bots\/([A-Za-z0-9_]{3,16})\/(entities|containers|find)$/.exec(p)) && m === 'GET') {
        const radius = Number(url.searchParams.get('radius')) || (a[2] === 'containers' ? 24 : 32);
        return a[2] === 'entities' ? service.nearbyEntities(a[1], radius) : a[2] === 'find' ? service.survey(a[1], String(url.searchParams.get('target') || ''), radius) : service.containersNear(a[1], radius);
    }
    if ((a = /^\/api\/bots\/([A-Za-z0-9_]{3,16})$/.exec(p)) && m === 'GET') return service.botDetail(a[1]);
};

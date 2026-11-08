'use strict';
// Ender Storage as the operator sees it: every frequency the world has saved (colours, what is inside) next to the tagged blocks that use it and what each
// is for. Read-only on the world folder (WORK_WORLD); the items themselves are moved by deposit / withdraw on a chest block (world/enderstorage.js).
// A part of WorkService (index.js copies these methods onto it).
const es = require('../world/enderstorage');

class EnderPart {
    /**
     * { colours, available, savedAt, frequencies: [{key, left, middle, right, owner?, label, size, used, items, sites: [{name, purpose, x, y, z}]}] }.
     * Frequencies that only a tagged block names (nothing saved in them yet) are listed with used 0.
     */
    async enderStorage() {
        const store = await es.readStore(this.o.worldDir || null);
        const byKey = new Map();
        for (const f of (store && store.frequencies) || []) byKey.set(f.key, { ...f, label: es.label(f), sites: [] });
        for (const s of this.sites.list()) {
            if (!s.ender) continue;
            const key = es.keyOf(s.ender);
            if (!byKey.has(key)) byKey.set(key, { key, type: 'item', ...s.ender, label: es.label(s.ender), size: 27, used: 0, items: [], sites: [] });
            byKey.get(key).sites.push({ name: s.name, purpose: s.purpose, x: s.x, y: s.y, z: s.z });
        }
        return { colours: es.COLOURS, available: !!store, savedAt: store ? Math.floor(store.mtimeMs) : null, frequencies: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)) };
    }
}

module.exports = { EnderPart };

'use strict';
// What an item looks like in an inventory, from the game's own models (assets/minecraft/models, read from the client jar by assets/store.js), as a small spec the page draws
// (public/work/icons.js): a flat item (its layers, as the game draws item/generated models) or a block item (its elements and faces, drawn as the game's GUI view of a block).
// Pure: `readModel('item/stone')` returns the parsed JSON or null.
//   spec = { kind: 'flat', layers: [{ tex, tint }] }
//        | { kind: 'block', elements: [{ from, to, rotation?, faces: { up|down|north|south|east|west: { tex, uv?, rotation?, tint } } }] }
//        | { kind: 'none' }                       (a model drawn by code in the game: chests, beds, banners, shields; or no model)

const MAX_DEPTH = 12;

/** Colours of tinted faces in an inventory (the game's item colours with no biome: default grass, foliage, the fixed birch and spruce leaves, water, leather). */
function tintOf(id, index) {
    if (index === undefined || index === null || index < 0) return null;
    const n = String(id).replace(/^minecraft:/, '');
    if (/^(birch_leaves)$/.test(n)) return 0x80a755;
    if (/^(spruce_leaves)$/.test(n)) return 0x619961;
    if (/^(lily_pad)$/.test(n)) return 0x208030;
    if (/leaves$|^vine$/.test(n)) return 0x48b518;
    if (/^(grass_block|short_grass|grass|tall_grass|fern|large_fern|sugar_cane|pink_petals)$/.test(n)) return 0x91bd59;
    if (/^leather_(helmet|chestplate|leggings|boots|horse_armor)$|^wolf_armor$/.test(n)) return index === 0 ? 0xa06540 : null;
    return null;            // (no water rule: /water/ matched water_bucket and painted the whole bucket blue; no item model tints water)
}

const texPath = (t) => { const s = String(t).replace(/^minecraft:/, ''); return /^(block|item)\/[a-z0-9_/]{1,80}$/.test(s) && !s.includes('..') ? s : null; };

/** Follow the parent chain of model `path`: the merged textures (the child's win), the first elements found, and where the chain ended (generated / entity / a model). */
function chain(path, readModel) {
    const textures = {}; let elements = null, end = null, p = path;
    for (let d = 0; d < MAX_DEPTH && p; d++) {
        const name = String(p).replace(/^minecraft:/, '');
        if (name === 'builtin/generated') { end = 'generated'; break; }
        if (name === 'builtin/entity') { end = 'entity'; break; }
        const m = readModel(name);
        if (!m) { end = end || 'missing'; break; }
        for (const [k, v] of Object.entries(m.textures || {})) if (!(k in textures)) textures[k] = v;
        if (!elements && Array.isArray(m.elements)) elements = m.elements;
        p = m.parent || null;
        if (!p) end = 'model';
    }
    const resolve = (ref) => { let r = ref; for (let i = 0; i < 8 && typeof r === 'string' && r.startsWith('#'); i++) r = textures[r.slice(1)]; return typeof r === 'string' ? texPath(r) : null; };
    return { textures, elements, end, resolve };
}

/**
 * 1.21.4 and later name an item's model in items/<id>.json ({ model: { type: 'minecraft:model', model: 'minecraft:block/x', tints } }, or a select / condition / range_dispatch
 * of such models: the fallback, else the first case, is what an inventory shows by default); block items have no models/item file there any more. Returns
 * { path, tints } or null.
 */
function fromItemDef(def) {
    let m = def && def.model;
    for (let i = 0; i < 6 && m && m.type !== 'minecraft:model' && m.type !== 'model'; i++) m = m.fallback || (m.cases && m.cases[0] && m.cases[0].model) || m.on_false || (m.entries && m.entries[0] && m.entries[0].model) || null;
    if (!m || typeof m.model !== 'string') return null;
    const tints = (m.tints || []).map((t) => (t && /constant$/.test(t.type) && Number.isInteger(t.value) ? t.value & 0xffffff : t && /grass$/.test(t.type) ? 0x91bd59 : t && /foliage$/.test(t.type) ? 0x48b518 : t && /dye$/.test(t.type) && Number.isInteger(t.default) ? t.default & 0xffffff : null));
    return { path: m.model.replace(/^minecraft:/, ''), tints };
}

/** The spec of item `id` (minecraft:smooth_stone_slab). Mod items have no model here: kind none. `readItemDef('x')` reads items/x.json (1.21.4+), or is null. */
function itemSpec(id, readModel, readItemDef = null) {
    const m = /^(?:minecraft:)?([a-z0-9_]{1,64})$/.exec(String(id));
    if (!m) return { kind: 'none' };
    const def = readItemDef ? fromItemDef(readItemDef(m[1])) : null;
    if (def) { const s = specOf(id, chain(def.path, readModel)); if (def.tints.length) tintSpec(s, def.tints); return s; }
    return specOf(id, chain(`item/${m[1]}`, readModel));
}
/** Apply the tints of an item definition (tintindex -> colour) to a spec. */
function tintSpec(s, tints) {
    if (s.kind === 'flat') s.layers.forEach((l, i) => { if (tints[i] !== undefined && tints[i] !== null) l.tint = tints[i]; });
    if (s.kind === 'block') for (const e of s.elements) for (const f of Object.values(e.faces)) if (f.tintindex !== undefined && tints[f.tintindex] !== undefined) f.tint = tints[f.tintindex];
}
function specOf(id, c) {
    if (c.end === 'generated' || (!c.elements && c.textures.layer0)) {
        const layers = [];
        for (let i = 0; i < 8 && c.textures[`layer${i}`]; i++) { const tex = c.resolve(`#layer${i}`); if (tex) layers.push({ tex, tint: tintOf(id, i) }); }
        return layers.length ? { kind: 'flat', layers } : { kind: 'none' };
    }
    if (c.elements) {
        const elements = c.elements.slice(0, 64).map((e) => {
            const faces = {};
            for (const [dir, f] of Object.entries(e.faces || {})) {
                const tex = c.resolve(f.texture); if (!tex) continue;
                faces[dir] = { tex, ...(Array.isArray(f.uv) ? { uv: f.uv } : {}), ...(f.rotation ? { rotation: f.rotation } : {}), ...(f.tintindex !== undefined ? { tintindex: f.tintindex } : {}), tint: f.tintindex !== undefined ? tintOf(id, f.tintindex) : null };
            }
            return { from: e.from, to: e.to, ...(e.rotation ? { rotation: e.rotation } : {}), faces };
        }).filter((e) => Array.isArray(e.from) && Array.isArray(e.to) && Object.keys(e.faces).length);
        if (elements.length) return { kind: 'block', elements };
    }
    // drawn by code in the game (chest, bed, banner, shield, skull, shulker box): the model's particle texture as a cube, so it is at least the right material
    const particle = c.resolve('#particle');
    if (particle) { const face = { tex: particle, tint: null }; return { kind: 'block', approx: true, elements: [{ from: [1, 0, 1], to: [15, 14, 15], faces: { up: face, north: face, south: face, east: face, west: face, down: face } }] }; }
    return { kind: 'none' };
}

/** The game's English name of an item: item.minecraft.x, else block.minecraft.x, from lang/en_us.json. */
function nameOf(id, lang) {
    const n = String(id).replace(/^minecraft:/, '');
    return (lang && (lang[`item.minecraft.${n}`] || lang[`block.minecraft.${n}`])) || null;
}

module.exports = { itemSpec, nameOf, tintOf, chain, texPath, fromItemDef };

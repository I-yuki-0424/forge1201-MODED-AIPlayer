'use strict';
// The game's block textures for the stuck pictures: the asset cache of the work console (src/work/web/assets/store.js, /mnt/data/forgeaip/mc-assets/<version>), the block's
// model followed to its top or side texture (models.js chain), the first frame of an animated strip, grass and leaves tinted as in an inventory, water blue. A block without a
// model or texture (a mod block, no cache) gets a flat colour from its name, so a picture is never empty.
const fs = require('fs');
const path = require('path');
const { decode } = require('./png');
const { chain, tintOf } = require('../work/web/assets/models');

const NAME = /^[a-z0-9_]{1,64}$/;
const UP = ['top', 'up', 'end', 'all', 'texture', 'side', 'particle', 'cross', 'plant', 'fan', 'rail', 'pane'];
const SIDE = ['side', 'all', 'texture', 'front', 'north', 'cross', 'plant', 'edge', 'pane', 'particle', 'top', 'end'];
const MODELS = (n) => [n, `${n}_bottom`, `${n}_floor`, `${n}_0`, `${n}_side`, `${n}_post`, `${n}_inventory`, `${n}_stage0`, `${n}_noside`, `${n}_single`, `${n}_dot`, `${n}_on`, `${n}_off`];

/** Colour of a name with no picture (a stable hash, mid saturation and light), RGB. */
function hashColor(name) {
    let x = 7; for (const c of String(name)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
    const hue = (x % 360) / 360, s = 0.4 + ((x >> 8) % 30) / 100, l = 0.34 + ((x >> 16) % 24) / 100;
    const f = (n) => { const k = (n + hue * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
}

class Textures {
    /** @param dir  the version's folder of the asset cache (…/mc-assets/1.21.1), or null (flat colours only) */
    constructor(dir) { this.dir = dir && fs.existsSync(path.join(dir, 'models')) ? dir : null; this.cache = new Map(); this.models = new Map(); }

    _model(name) {
        if (this.models.has(name)) return this.models.get(name);
        let m = null;
        if (this.dir && /^block\/[a-z0-9_]{1,80}$/.test(name)) { try { m = JSON.parse(fs.readFileSync(path.join(this.dir, 'models', `${name}.json`), 'utf8')); } catch (_) { m = null; } }
        this.models.set(name, m); return m;
    }
    _png(tex) {
        if (!this.dir || !/^block\/[a-z0-9_]{1,80}$/.test(tex)) return null;
        try {
            const p = decode(fs.readFileSync(path.join(this.dir, 'textures', `${tex}.png`))), w = p.width;
            if (w > 64) return null;
            return { w, h: Math.min(p.height, w), data: p.data.subarray(0, w * Math.min(p.height, w) * 4) };          // an animated strip: its first frame
        } catch (_) { return null; }
    }
    /** The texture the game shows on `face` ('up' | 'side') of block `name` (bare id): { w, h, data RGBA } , or { w: 1, h: 1, data } of a flat colour. */
    get(name, face = 'side') {
        const bare = String(name || '').replace(/^minecraft:/, ''), k = `${bare}|${face}`;
        if (this.cache.has(k)) return this.cache.get(k);
        let t = null;
        if (NAME.test(bare)) {
            for (const mn of MODELS(bare)) {
                const c = chain(`block/${mn}`, (p) => this._model(p));
                if (c.end === 'missing' && !Object.keys(c.textures).length) continue;
                for (const ref of face === 'up' ? UP : SIDE) { const tex = c.resolve(`#${ref}`); if (tex && (t = this._png(tex))) break; }
                if (t) break;
            }
            if (!t) for (const tn of face === 'up' ? [`${bare}_top`, bare, `${bare}_still`] : [`${bare}_side`, bare, `${bare}_still`, `${bare}_front`]) if ((t = this._png(`block/${tn}`))) break;
        }
        if (t) {
            const tint = /^water$|^bubble_column$/.test(bare) ? 0x3f76e4 : tintOf(bare, 0);
            if (tint !== null && tint !== undefined && (face === 'up' || !/^grass_block$/.test(bare))) {
                const d = new Uint8Array(t.data), r = (tint >> 16) & 255, g = (tint >> 8) & 255, b = tint & 255;
                for (let i = 0; i < d.length; i += 4) { d[i] = d[i] * r / 255; d[i + 1] = d[i + 1] * g / 255; d[i + 2] = d[i + 2] * b / 255; }
                t = { ...t, data: d };
            }
        } else { const [r, g, b] = hashColor(bare); t = { w: 1, h: 1, data: new Uint8Array([r, g, b, 255]), flat: true }; }
        this.cache.set(k, t); return t;
    }
}

module.exports = { Textures, hashColor };

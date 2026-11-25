'use strict';
// Item icons for the inventory, drawn from the game's own models and textures (served by the console: /api/assets/*, from the client jar of the server's version),
// as the game draws them in a slot (owner 2026-11-25, list 5 Small 3): a flat item is its texture layers; a block item is its model's elements seen from the GUI view
// (rotation 30 deg about X after 225 deg about Y, scale 0.625, as models/block/block.json says), faces shaded and tinted; the durability bar is the game's: shown only
// when the item is damaged, 13 px at most, width round(13 - 13 * damage / max), colour HSV((1 - damage / max) / 3, 1, 1), on a 13 x 2 black bar at (2, 13).
// The pure parts (projection, faces, the bar) also load in Node for the tests.
(function (root) {
    const DEG = Math.PI / 180, RY = 225 * DEG, RX = 30 * DEG, SCALE = 0.625;

    /** Minecraft's Mth.hsvToRgb: h in 0..1 -> 0xRRGGBB. */
    function hsvToRgb(h, s, v) {
        const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6), p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][(i + 6) % 6];
        return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
    }
    /** The game's durability bar of a stack: null when it is not shown (not damaged, or no maximum); else { width (0..13 px), rgb }. */
    function durability(damage, max) {
        if (!(max > 0) || !(damage > 0)) return null;
        const f = Math.min(1, damage / max);
        return { width: Math.max(0, Math.min(13, Math.round(13 - 13 * f))), rgb: hsvToRgb(Math.max(0, (1 - f) / 3), 1, 1) };
    }

    /** A model point (0..16 per axis) in the slot's 16 x 16 pixels: [x, y, depth] (larger depth = nearer the viewer). */
    function project(p) {
        const x = p[0] - 8, y = p[1] - 8, z = p[2] - 8;
        const x1 = Math.cos(RY) * x + Math.sin(RY) * z, z1 = -Math.sin(RY) * x + Math.cos(RY) * z;
        const y2 = Math.cos(RX) * y - Math.sin(RX) * z1, z2 = Math.sin(RX) * y + Math.cos(RX) * z1;
        return [8 + SCALE * x1, 8 - SCALE * y2, SCALE * z2];
    }
    const NORMAL = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
    const SHADE = { up: 1, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };
    /** Does face `dir` (of an element turned by `rot`, if any) look at the viewer in the GUI view (its normal has a positive depth)? */
    const facesViewer = (dir, rot = null) => { const n = NORMAL[dir], o = turn([8, 8, 8], rot), a = turn([8 + n[0], 8 + n[1], 8 + n[2]], rot); return project(a)[2] - project(o)[2] > 1e-6; };

    /** The four corners of a face of the box from..to, in texture order: top-left, top-right, bottom-right, bottom-left (as the game maps a face's uv). */
    function corners(from, to, dir) {
        const [x0, y0, z0] = from, [x1, y1, z1] = to;
        switch (dir) {
            case 'up': return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
            case 'down': return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
            case 'north': return [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]];
            case 'south': return [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]];
            case 'west': return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
            case 'east': return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
            default: return null;
        }
    }
    /** The uv a face uses when its model gives none (the game's default: the face's own extent on the 16 x 16 texture). */
    function defaultUv(from, to, dir) {
        const [x0, y0, z0] = from, [x1, y1, z1] = to;
        return { up: [x0, z0, x1, z1], down: [x0, 16 - z1, x1, 16 - z0], north: [16 - x1, 16 - y1, 16 - x0, 16 - y0], south: [x0, 16 - y1, x1, 16 - y0], west: [z0, 16 - y1, z1, 16 - y0], east: [16 - z1, 16 - y1, 16 - z0, 16 - y0] }[dir];
    }
    /** Turn a point about an element's rotation {origin, axis, angle}. */
    function turn(p, r) {
        if (!r || !r.angle) return p;
        const a = r.angle * DEG, c = Math.cos(a), s = Math.sin(a), o = r.origin || [8, 8, 8], v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
        const w = r.axis === 'x' ? [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]] : r.axis === 'y' ? [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]] : [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
        return [w[0] + o[0], w[1] + o[1], w[2] + o[2]];
    }
    /**
     * The faces of a block spec to draw, far to near: [{ dir, tex, tint, shade, pts: [TL, TR, BL] in slot pixels, uv: [u0, v0, u1, v1] }]. Only faces that look at the viewer
     * (the game culls the others); a face's own rotation turns which corner its texture starts at.
     */
    function blockFaces(spec) {
        const out = [];
        for (const e of spec.elements || []) for (const [dir, f] of Object.entries(e.faces || {})) {
            if (!NORMAL[dir] || !facesViewer(dir, e.rotation)) continue;
            let c = corners(e.from, e.to, dir).map((p) => turn(p, e.rotation));
            const k = ((f.rotation || 0) / 90) & 3; c = [...c.slice(k), ...c.slice(0, k)];
            const s = c.map(project), depth = (s[0][2] + s[1][2] + s[2][2] + s[3][2]) / 4;
            out.push({ dir, tex: f.tex, tint: f.tint ?? null, shade: SHADE[dir], pts: [s[0], s[1], s[3]], uv: f.uv || defaultUv(e.from, e.to, dir), depth });
        }
        return out.sort((a, b) => a.depth - b.depth);
    }

    const api = { hsvToRgb, durability, project, corners, defaultUv, blockFaces, facesViewer };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

    // ---------------------------------------------------------------- browser: fetch specs and textures, draw into a canvas
    const specs = new Map(), images = new Map(); let waiting = new Set(), timer = 0, status = null;
    const listeners = new Set();
    async function flush() {
        timer = 0; const ids = [...waiting]; waiting = new Set();
        for (let i = 0; i < ids.length; i += 100) {
            const part = ids.slice(i, i + 100);
            try {
                const r = await window.api('GET', `/api/assets/icons?ids=${encodeURIComponent(part.join(','))}`);
                if (!r.ready) { for (const id of part) specs.delete(id); setTimeout(() => { for (const id of part) want(id); }, 5000); continue; }
                for (const id of part) specs.set(id, r.icons[id] || { kind: 'none' });
            } catch (_) { for (const id of part) specs.set(id, { kind: 'none', failed: true }); }
        }
        listeners.forEach((f) => f());
    }
    function want(id) { if (specs.has(id)) return; specs.set(id, null); waiting.add(id); if (!timer) timer = setTimeout(flush, 30); }
    function image(tex) {
        let im = images.get(tex);
        if (!im) { im = new Image(); im.onload = () => listeners.forEach((f) => f()); im.src = `/api/assets/tex/${tex}.png`; images.set(tex, im); }
        return im.complete && im.naturalWidth ? im : null;
    }
    /** A 16 x 16 frame of a texture (the first frame of an animated one), tinted and shaded, as a canvas; null until the image has loaded. */
    function frame(tex, tint, shade = 1) {
        const im = image(tex); if (!im) return null;
        const w = im.naturalWidth, c = document.createElement('canvas'); c.width = c.height = w;
        const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(im, 0, 0, w, w, 0, 0, w, w);
        const mul = (rgb) => { x.globalCompositeOperation = 'multiply'; x.fillStyle = `#${rgb.toString(16).padStart(6, '0')}`; x.fillRect(0, 0, w, w); x.globalCompositeOperation = 'destination-in'; x.drawImage(im, 0, 0, w, w, 0, 0, w, w); x.globalCompositeOperation = 'source-over'; };
        if (tint !== null && tint !== undefined) mul(tint);
        if (shade < 1) { const g = Math.round(255 * shade); mul((g << 16) | (g << 8) | g); }
        return c;
    }
    /** Draw item `it` ({id, damage, max}) into canvas `cv` (a multiple of 16 px). Returns false while its spec or a texture is still loading (it is drawn again then). */
    function draw(cv, it) {
        const x = cv.getContext('2d'), k = cv.width / 16, spec = specs.get(it.id);
        x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height); x.imageSmoothingEnabled = false;
        if (spec === undefined) want(it.id);
        let ok = !!spec;
        if (spec && spec.kind === 'flat') for (const l of spec.layers) { const f = frame(l.tex, l.tint); if (!f) { ok = false; continue; } x.drawImage(f, 0, 0, f.width, f.width, 0, 0, cv.width, cv.height); }
        if (spec && spec.kind === 'block') for (const f of blockFaces(spec)) {
            const t = frame(f.tex, f.tint, f.shade); if (!t) { ok = false; continue; }
            const u = t.width / 16, [a, b, d] = f.pts, [u0, v0, u1, v1] = f.uv;
            // the unit square -> the face's parallelogram; a mirrored uv (u1 < u0) runs the other way along the same edge
            x.setTransform(k * (b[0] - a[0]), k * (b[1] - a[1]), k * (d[0] - a[0]), k * (d[1] - a[1]), k * a[0], k * a[1]);
            const sx = Math.min(u0, u1) * u, sy = Math.min(v0, v1) * u, sw = Math.max(1e-3, Math.abs(u1 - u0) * u), sh = Math.max(1e-3, Math.abs(v1 - v0) * u);
            if (u1 < u0 || v1 < v0) { x.translate(u1 < u0 ? 1 : 0, v1 < v0 ? 1 : 0); x.scale(u1 < u0 ? -1 : 1, v1 < v0 ? -1 : 1); }
            x.drawImage(t, sx, sy, sw, sh, -0.01, -0.01, 1.02, 1.02);          // a hair larger: no seams between faces
            x.setTransform(1, 0, 0, 1, 0, 0);
        }
        const bar = durability(it.damage, it.max);
        if (bar) { x.fillStyle = '#000'; x.fillRect(2 * k, 13 * k, 13 * k, 2 * k); x.fillStyle = `#${bar.rgb.toString(16).padStart(6, '0')}`; x.fillRect(2 * k, 13 * k, bar.width * k, k); }
        return ok;
    }
    root.Icons = { ...api, draw, want, spec: (id) => specs.get(id) || null, onChange: (f) => listeners.add(f), offChange: (f) => listeners.delete(f) };
})(typeof window !== 'undefined' ? window : globalThis);

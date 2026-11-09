'use strict';
// Map component: a top-down view of the world drawn from the server's region files (/api/map/*), with job boxes, bots, players and
// a range selection like a spreadsheet's (drag over chunks; hold Alt for single blocks). One instance per canvas; tiles are shared.
const Tiles = {
    index: new Map(),               // dim -> [{rx, rz, mtime}]
    tiles: new Map(),               // "dim/top/rx/rz" (top: 's' = surface, or the y the view looks down from) -> { canvas, mtime } | { loading: true } | { empty: true }
    waiting: [], active: 0, listeners: new Set(),
    async loadIndex(dim, force = false) {
        if (this.index.has(dim) && !force) return this.index.get(dim);
        let list = [];
        try { list = (await api('GET', `/api/map/regions?dim=${encodeURIComponent(dim)}`)).regions; } catch (e) { list = []; this.error = e.message; }
        this.index.set(dim, list);
        if (force) for (const k of [...this.tiles.keys()]) if (k.startsWith(dim + '/')) this.tiles.delete(k);
        return list;
    },
    /** Re-read the region list now and then (the server saves its chunks every few minutes): changed regions are fetched again as they are drawn, the old picture stays until then. */
    startPolling(ms = 15000) {
        if (this.timer) return;
        this.timer = setInterval(async () => {
            if (document.hidden) return;
            for (const dim of [...this.index.keys()]) {
                try {
                    const list = (await api('GET', `/api/map/regions?dim=${encodeURIComponent(dim)}`)).regions, old = this.index.get(dim) || [];
                    const same = list.length === old.length && list.every((r, i) => r.rx === old[i].rx && r.rz === old[i].rz && r.mtime === old[i].mtime);
                    if (!same) { this.index.set(dim, list); this.listeners.forEach((f) => f()); }
                } catch (_) { /* the next tick tries again */ }
            }
        }, ms);
    },
    get(dim, top, rx, rz, mtime) {
        const key = `${dim}/${top === null ? 's' : top}/${rx}/${rz}`, t = this.tiles.get(key);
        if (t && ((t.loading && t.want === mtime) || (!t.loading && t.mtime === mtime))) return t;
        // The stale picture stays until the new one is ready. It used to be replaced by an empty entry here, so a region the server had just saved was drawn black until the
        // reload arrived (the chunk the bot works in flickered between black and map every time it was saved).
        this.tiles.set(key, { loading: true, want: mtime, canvas: t && t.canvas, mtime: t && t.mtime });
        this.waiting.push({ key, dim, top, rx, rz }); this.pump();
        return t && t.canvas ? t : null;
    },
    pump() {
        while (this.active < 3 && this.waiting.length) {
            const job = this.waiting.shift(); this.active++;
            api('GET', `/api/map/region?dim=${encodeURIComponent(job.dim)}&rx=${job.rx}&rz=${job.rz}${job.top === null ? '' : `&top=${job.top}`}`).then((r) => {
                if (!r.idx) { this.tiles.set(job.key, { empty: true, mtime: r.mtime }); return; }
                const bin = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                const c = document.createElement('canvas'); c.width = c.height = 512;
                const img = new ImageData(512, 512); BlockColor.paintRegion(r.names, bin(r.idx), bin(r.h), img.data, 512);
                c.getContext('2d').putImageData(img, 0, 0);
                this.tiles.set(job.key, { canvas: c, mtime: r.mtime });
            }).catch(() => { const old = this.tiles.get(job.key); this.tiles.set(job.key, old && old.canvas ? { canvas: old.canvas, mtime: old.mtime } : { empty: true, mtime: -1 }); }).finally(() => { this.active--; this.listeners.forEach((f) => f()); this.pump(); });
        }
    },
};

Tiles.startPolling();

/** The short dimension name of a game id (`minecraft:the_nether` -> nether). */
const dimShort = (v) => { const s = String(v || 'overworld').replace(/^minecraft:/, ''); return s === 'the_nether' ? 'nether' : s === 'the_end' ? 'end' : s; };
/** The Nether has a bedrock roof: from above it is one black square. Its map looks down from a layer instead (cave level); every other dimension shows its surface. */
const DEFAULT_SLICE = { nether: 70 };

class MapView {
    /**
     * @param canvas  the <canvas>
     * @param o       { state: () => S, players: () => [...], select: false (range selection), onSelect(box), onPick(x, z), layers: {jobs, bots, players} }
     */
    constructor(canvas, o = {}) {
        this.cv = canvas; this.o = o; this.ctx = canvas.getContext('2d');
        this.dim = 'overworld'; this.top = null; this.mode = 'select'; this.view = { cx: 0, cz: 0, scale: 2 }; this.sel = null; this.hover = null; this.draft = []; this.snap = true;
        this.drag = null; this.raf = 0; this.picking = null;
        Tiles.listeners.add(() => this.redraw());
        const pt = (e) => { const r = canvas.getBoundingClientRect(), k = canvas.width / r.width; return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; };
        canvas.addEventListener('pointerdown', (e) => {
            canvas.setPointerCapture(e.pointerId);
            const [px, pz] = pt(e), w = this.toWorld(px, pz), pan = !this.o.select || e.button !== 0 || e.ctrlKey || this.spaceDown || this.mode === 'pan';
            this.drag = { px, pz, cx: this.view.cx, cz: this.view.cz, pan, moved: false, anchor: w, alt: e.altKey };
            if (this.o.select && !pan) {
                const edge = this.sel && !e.shiftKey ? this.edgeAt(px, pz) : null, b = edge ? this.shown() : null;
                this.selecting = true;
                if (edge) {                                                     // grab an edge or corner of the selection and move it: the opposite side stays
                    const a = this.drag.anchor = [edge.l ? b.x1 : b.x0, edge.t ? b.z1 : b.z0];
                    this.lock = { x: !edge.l && !edge.r ? b.x1 : null, z: !edge.t && !edge.b ? b.z1 : null };
                    this.fixed = null; this.sel = { anchor: a, x: this.lock.x ?? w[0], z: this.lock.z ?? w[1] }; this.snap = this.snapMode !== false && !e.altKey; this.redraw();
                } else {
                    this.lock = null; this.fixed = null;                       // a typed box (setBox) no longer stands for the selection once a new one is dragged
                    if (e.shiftKey && this.sel) this.drag.anchor = this.sel.anchor; else this.sel = null;
                    this.updateSel(w, e.altKey);
                }
            }
        });
        canvas.addEventListener('pointermove', (e) => {
            const [px, pz] = pt(e), w = this.toWorld(px, pz); this.hover = w;
            if (!this.drag) { const ed = this.o.select && this.mode !== 'pan' && this.sel ? this.edgeAt(px, pz) : null; canvas.style.cursor = ed ? (ed.l && ed.t) || (ed.r && ed.b) ? 'nwse-resize' : (ed.r && ed.t) || (ed.l && ed.b) ? 'nesw-resize' : ed.l || ed.r ? 'ew-resize' : 'ns-resize' : this.o.select && this.mode !== 'pan' ? 'crosshair' : ''; }
            if (this.o.onHover) this.o.onHover(w, this.surfaceName(w));
            if (this.drag) {
                if (Math.abs(px - this.drag.px) + Math.abs(pz - this.drag.pz) > 4) this.drag.moved = true;
                if (this.drag.pan) { this.view.cx = this.drag.cx - (px - this.drag.px) / this.view.scale; this.view.cz = this.drag.cz - (pz - this.drag.pz) / this.view.scale; }
                else if (this.selecting) this.updateSel(w, e.altKey || this.drag.alt);
            }
            this.redraw();
        });
        canvas.addEventListener('pointerup', (e) => {
            const d = this.drag; this.drag = null;
            if (!d) return;
            if (this.selecting) { this.selecting = false; if (this.sel && this.o.onSelect) this.o.onSelect(this.box()); }
            else if (!d.moved && this.picking) { const [px, pz] = pt(e), w = this.toWorld(px, pz), f = this.picking; this.picking = null; canvas.classList.remove('picking'); f(w[0], w[1]); }
            else if (!d.moved && this.o.onPick) { const [px, pz] = pt(e), w = this.toWorld(px, pz); this.o.onPick(w[0], w[1]); }
            this.redraw();
        });
        canvas.addEventListener('pointerleave', () => { this.hover = null; this.redraw(); });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault(); const [px, pz] = pt(e), before = this.toWorld(px, pz, true);
            this.view.scale = clamp(this.view.scale * (e.deltaY < 0 ? 1.25 : 0.8), 0.08, 48);
            const after = this.toWorld(px, pz, true); this.view.cx += before[0] - after[0]; this.view.cz += before[1] - after[1]; this.redraw();
        }, { passive: false });
        window.addEventListener('keydown', (e) => { if (e.code === 'Space' && document.activeElement === document.body) this.spaceDown = true; });
        window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && this.o.select && this.sel && !this.selecting && this.cv.offsetParent !== null && /^(BODY|CANVAS)$/.test(document.activeElement.tagName)) this.clearSel(); });
        window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
    }

    toWorld(px, pz, exact = false) { const x = (px - this.cv.width / 2) / this.view.scale + this.view.cx, z = (pz - this.cv.height / 2) / this.view.scale + this.view.cz; return exact ? [x, z] : [Math.floor(x), Math.floor(z)]; }
    toScreen(x, z) { return [this.cv.width / 2 + (x - this.view.cx) * this.view.scale, this.cv.height / 2 + (z - this.view.cz) * this.view.scale]; }

    updateSel(w, alt) {
        const a = this.drag.anchor; this.snap = this.snapMode !== false && !alt;
        const k = this.lock || {};
        this.sel = { anchor: a, x: k.x ?? w[0], z: k.z ?? w[1] };
        this.redraw();
    }
    /** The selection as it is drawn: a box typed in the fields while nothing is being dragged, else the dragged one. */
    shown() { return this.fixed && !this.selecting ? this.fixed : this.box(); }
    /** Which edges of the selection the pointer (canvas pixels) is on: {l, r, t, b} or null. */
    edgeAt(px, pz) {
        const b = this.shown(); if (!b) return null;
        const [ax, az] = this.toScreen(b.x0, b.z0), [bx, bz] = this.toScreen(b.x1 + 1, b.z1 + 1), tol = Math.max(6, Math.min(12, (bx - ax) / 5, (bz - az) / 5));
        if (px < ax - tol || px > bx + tol || pz < az - tol || pz > bz + tol) return null;
        const e = { l: Math.abs(px - ax) <= tol, r: Math.abs(px - bx) <= tol, t: Math.abs(pz - az) <= tol, b: Math.abs(pz - bz) <= tol };
        if (e.l && e.r) e.r = false; if (e.t && e.b) e.b = false;
        return e.l || e.r || e.t || e.b ? e : null;
    }
    clearSel() { this.sel = null; this.fixed = null; this.selecting = false; this.redraw(); if (this.o.onSelect) this.o.onSelect(null); }
    setMode(m) { this.mode = m; this.cv.style.cursor = ''; }
    /** The selected box {x0,z0,x1,z1}; chunk-aligned unless Alt was held. */
    box() {
        const s = this.sel; if (!s) return null;
        const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
        if (this.snap) { const c = (v) => Math.floor(v / 16); return { x0: lo(c(s.anchor[0]), c(s.x)) * 16, x1: hi(c(s.anchor[0]), c(s.x)) * 16 + 15, z0: lo(c(s.anchor[1]), c(s.z)) * 16, z1: hi(c(s.anchor[1]), c(s.z)) * 16 + 15 }; }
        return { x0: lo(s.anchor[0], s.x), x1: hi(s.anchor[0], s.x), z0: lo(s.anchor[1], s.z), z1: hi(s.anchor[1], s.z) };
    }
    /** Show a box typed elsewhere (coordinate fields) as the selection. */
    setBox(b) { this.sel = b ? { anchor: [b.x0, b.z0], x: b.x1, z: b.z1, fixed: b } : null; this.fixed = b; this.redraw(); }
    pick(f) { this.picking = f; this.cv.classList.add('picking'); }
    setDim(d) { this.dim = d; this.top = DEFAULT_SLICE[dimShort(d)] ?? null; if (this.o.onSlice) this.o.onSlice(this.top); Tiles.loadIndex(d).then(() => this.redraw()); }
    /** Look down from layer y (null = the surface). */
    setSlice(y) { y = y === null || y === undefined || Number.isNaN(y) ? null : Math.max(-64, Math.min(320, Math.round(y))); if (y === this.top) return; this.top = y; this.redraw(); }

    surfaceName(w) {
        const rx = Math.floor(w[0] / 512), rz = Math.floor(w[1] / 512), t = Tiles.tiles.get(`${this.dim}/${this.top === null ? 's' : this.top}/${rx}/${rz}`);
        return t && t.canvas ? 'loaded' : null;
    }

    fit(extra = []) {
        const S = this.o.state ? this.o.state() : null, here = (d) => dimShort(d) === dimShort(this.dim);
        const boxes = [...(S ? S.jobs.filter((j) => ['running', 'paused', 'ready'].includes(j.state) && here(j.spec && j.spec.dim)).map((j) => j.box) : []), ...extra];
        const pts = [...(S ? S.bots.filter((b) => b.pos && here(b.dim)).map((b) => b.pos) : []), ...((this.o.players && this.o.players()) || []).filter((p) => p.pos && here(p.dimension)).map((p) => p.pos)];
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const b of boxes) { x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1 + 1); z0 = Math.min(z0, b.z0); z1 = Math.max(z1, b.z1 + 1); }
        for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
        if (!isFinite(x0)) {                                    // nothing placed in this dimension: the explored area nearest to the origin (the End's outer islands are thousands of blocks away)
            const near = [...(Tiles.index.get(this.dim) || [])].sort((a, b) => Math.hypot(a.rx + 0.5, a.rz + 0.5) - Math.hypot(b.rx + 0.5, b.rz + 0.5)).slice(0, 6);
            for (const r of near) { x0 = Math.min(x0, r.rx * 512); x1 = Math.max(x1, r.rx * 512 + 512); z0 = Math.min(z0, r.rz * 512); z1 = Math.max(z1, r.rz * 512 + 512); }
        }
        if (!isFinite(x0)) { x0 = -128; x1 = 128; z0 = -64; z1 = 64; }
        this.view.cx = (x0 + x1) / 2; this.view.cz = (z0 + z1) / 2;
        this.view.scale = clamp(0.88 * Math.min(this.cv.width / Math.max(48, x1 - x0), this.cv.height / Math.max(48, z1 - z0)), 0.08, 24);
        this.redraw();
    }
    centerOn(x, z, scale) { this.view.cx = x; this.view.cz = z; if (scale) this.view.scale = scale; this.redraw(); }
    redraw() { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }

    draw() {
        const { cv, ctx, view } = this, css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
        if (cv.clientWidth && Math.abs(cv.width / cv.clientWidth - 1) > 0.02 && !this.fixedSize) { /* canvas pixel size follows the layout */ }
        ctx.fillStyle = css('--map-bg') || '#0b0c0e'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.imageSmoothingEnabled = false;
        const [wx0, wz0] = this.toWorld(0, 0), [wx1, wz1] = this.toWorld(cv.width, cv.height);
        for (const r of Tiles.index.get(this.dim) || []) {
            if (r.rx * 512 > wx1 || r.rx * 512 + 512 < wx0 || r.rz * 512 > wz1 || r.rz * 512 + 512 < wz0) continue;
            const t = Tiles.get(this.dim, this.top, r.rx, r.rz, r.mtime); if (!t || !t.canvas) continue;
            const [sx, sz] = this.toScreen(r.rx * 512, r.rz * 512), s = 512 * view.scale;
            ctx.drawImage(t.canvas, Math.floor(sx), Math.floor(sz), Math.ceil(s) + 1, Math.ceil(s) + 1);
        }
        // grid: chunks when zoomed in, blocks when very close, otherwise a coordinate grid
        const ink = css('--muted') || '#888', line = css('--grid') || 'rgba(255,255,255,.12)';
        ctx.font = '11px ui-monospace, monospace'; ctx.lineWidth = 1;
        const step = view.scale >= 3 ? 16 : [32, 64, 128, 256, 512, 1024, 2048, 4096].find((s) => s * view.scale >= 70) || 8192;
        ctx.strokeStyle = line; ctx.fillStyle = ink;
        if (view.scale >= 12) { ctx.save(); ctx.globalAlpha = 0.35; for (let x = wx0; x <= wx1; x++) { const [sx] = this.toScreen(x, 0); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cv.height); ctx.stroke(); } for (let z = wz0; z <= wz1; z++) { const [, sz] = this.toScreen(0, z); ctx.beginPath(); ctx.moveTo(0, sz); ctx.lineTo(cv.width, sz); ctx.stroke(); } ctx.restore(); }
        for (let x = Math.floor(wx0 / step) * step; x <= wx1; x += step) { const [sx] = this.toScreen(x, 0); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cv.height); ctx.stroke(); if (step >= 32 || view.scale >= 6) ctx.fillText(x, sx + 3, 12); }
        for (let z = Math.floor(wz0 / step) * step; z <= wz1; z += step) { const [, sz] = this.toScreen(0, z); ctx.beginPath(); ctx.moveTo(0, sz); ctx.lineTo(cv.width, sz); ctx.stroke(); if (step >= 32 || view.scale >= 6) ctx.fillText(z, 3, sz - 3); }
        // world origin
        const [ox, oz] = this.toScreen(0, 0); ctx.strokeStyle = 'rgba(255,200,0,.6)'; ctx.beginPath(); ctx.moveTo(ox - 6, oz); ctx.lineTo(ox + 6, oz); ctx.moveTo(ox, oz - 6); ctx.lineTo(ox, oz + 6); ctx.stroke();
        const L = this.o.layers || { jobs: true, bots: true, players: true }, S = this.o.state ? this.o.state() : null;
        const rect = (b, color, { dash = false, pct = 0, label = '', alpha = 0.18 } = {}) => {
            const [ax, az] = this.toScreen(b.x0, b.z0), [bx, bz] = this.toScreen(b.x1 + 1, b.z1 + 1);
            ctx.save(); ctx.setLineDash(dash ? [6, 4] : []); ctx.lineWidth = 2; ctx.fillStyle = color; ctx.strokeStyle = color;
            ctx.globalAlpha = alpha; ctx.fillRect(ax, az, bx - ax, bz - az);
            if (pct) { ctx.globalAlpha = 0.5; ctx.fillRect(ax, az, (bx - ax) * pct, bz - az); }
            ctx.globalAlpha = 1; ctx.strokeRect(ax, az, bx - ax, bz - az);
            if (label) { ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillText(label, ax + 4, az + 14); }
            ctx.restore();
        };
        const here = (d) => dimShort(d) === dimShort(this.dim);
        if (S && L.jobs) for (const j of S.jobs) if (['running', 'paused', 'ready'].includes(j.state) && here(j.spec && j.spec.dim)) rect(j.box, j.kind === 'pit' ? '#ff9830' : '#b877d9', { pct: j.progress.total ? j.progress.done / j.progress.total : 0, label: `${j.id} ${j.name}` });
        for (const d of this.draft) if (d) rect(d.box, d.color || '#5794f2', { dash: true, label: d.label || '' });
        if (this.sel) {
            const b = this.shown();
            if (b) {
                rect(b, '#5794f2', { alpha: 0.28, label: `${b.x1 - b.x0 + 1} × ${b.z1 - b.z0 + 1}${this.snap && !this.fixed ? ` (${(b.x1 - b.x0 + 1) / 16} × ${(b.z1 - b.z0 + 1) / 16} chunks)` : ''}` });
            }
        }
        const dot = (p, color, label, r = 5) => { const [sx, sz] = this.toScreen(p.x, p.z); ctx.fillStyle = color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sz, r, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.save(); ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillText(label, sx + 8, sz + 4); ctx.restore(); };
        if (L.players) for (const p of (this.o.players && this.o.players()) || []) if (p.pos && !p.bot && here(p.dimension)) dot(p.pos, '#73bf69', p.name, 6);
        for (const m of this.marks || []) dot({ x: m.x, z: m.z }, '#5ad17a', m.label, 6);                 // start / end of a wall (the Place page)
        if (S && L.bots) for (const b of S.bots) if (b.pos && here(b.dim)) dot(b.pos, b.working || (b.cmd && b.cmd.status === 'running') ? '#5794f2' : '#8ab8ff', b.name);
        if (this.hover && this.o.select && !this.selecting) { const c = (v) => Math.floor(v / 16) * 16, hx = this.snap ? c(this.hover[0]) : this.hover[0], hz = this.snap ? c(this.hover[1]) : this.hover[1]; const [ax, az] = this.toScreen(hx, hz), s = (this.snap ? 16 : 1) * view.scale; ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1; ctx.strokeRect(ax, az, s, s); }
        if (this.top !== null) { ctx.fillStyle = ink; ctx.font = '12px system-ui'; ctx.fillText(`looking down from y ${this.top}`, cv.width - 150, 16); }
        if (!(Tiles.index.get(this.dim) || []).length) { ctx.fillStyle = ink; ctx.font = '13px system-ui'; ctx.fillText(Tiles.error ? `No map data: ${Tiles.error}` : 'No map data yet (the server writes chunks to disk when it saves; press Refresh)', 16, cv.height - 16); }
    }
}

/** A modal with a map to click on: resolves with {x, z} (or null when closed). */
function pickPoint(title, S, players) {
    return new Promise((resolve) => {
        const cv = h('canvas', { width: 1000, height: 600, class: 'map-canvas picking' }); let done = false;
        const mv = new MapView(cv, { state: () => S(), players, onPick: (x, z) => { done = true; m.close(); resolve({ x, z }); } });
        const m = modal(title, [h('p', { class: 'muted', text: 'Click a spot. Drag to pan, wheel to zoom.' }), cv], { wide: true, onClose: () => { if (!done) resolve(null); } });
        Tiles.loadIndex('overworld').then(() => { mv.fit(); });
    });
}

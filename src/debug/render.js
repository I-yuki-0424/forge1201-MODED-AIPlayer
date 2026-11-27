'use strict';
// Draws a scene (scene.js) as three pictures: 'top' (looking down at the feet level, north up), 'along' (a vertical slice along the facing, the bot looking right) and 'across'
// (a vertical slice across it, seen from behind the bot). Each picture: the bot's own world on the left, the server's truth on the right (when the scene has one). Blocks are
// drawn at their collision shape (a bottom slab half high, a bed 9/16, an open trapdoor a thin wall) with the game's texture; fluids tinted; passable blocks faint; unloaded
// cells grey with '?'. Pure: a scene and a Textures in, an RGBA raster out (png.js writes it).
const { drawText, textWidth } = require('./font');
const { cellAt } = require('./scene');

const C = 32;                                 // pixels per cell
const PAD = { l: 26, t: 16, b: 14, gap: 10 };
const LEGEND = 40;
const SKY = [214, 228, 240], SKY_SERVER = [222, 232, 226], UNKNOWN = [120, 120, 120];
const COL = {
    body: [230, 0, 200], eye: [255, 255, 255], route: [240, 200, 0], goal: [255, 170, 0], temp: [255, 110, 0], other: [0, 200, 230], guard: [230, 20, 20], mark: [200, 0, 0],
    ghost: [230, 20, 20], missing: [255, 120, 0], state: [150, 60, 220], diffOther: [230, 20, 20], grid: [0, 0, 0], text: [20, 20, 20], water: [40, 90, 230], lava: [255, 110, 0],
};

class Raster {
    constructor(w, h, bg = [255, 255, 255]) { this.w = w; this.h = h; this.data = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { this.data[i * 4] = bg[0]; this.data[i * 4 + 1] = bg[1]; this.data[i * 4 + 2] = bg[2]; this.data[i * 4 + 3] = 255; } }
    set(x, y, [r, g, b], a = 1) {
        x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const i = (y * this.w + x) * 4, d = this.data;
        if (a >= 1) { d[i] = r; d[i + 1] = g; d[i + 2] = b; return; }
        d[i] = d[i] + (r - d[i]) * a; d[i + 1] = d[i + 1] + (g - d[i + 1]) * a; d[i + 2] = d[i + 2] + (b - d[i + 2]) * a;
    }
    get(x, y) { const i = (y * this.w + x) * 4; return [this.data[i], this.data[i + 1], this.data[i + 2]]; }
    rect(x0, y0, x1, y1, col, a = 1) { for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) this.set(x, y, col, a); }
    box(x0, y0, x1, y1, col, t = 2, a = 1) { this.rect(x0, y0, x1, y0 + t, col, a); this.rect(x0, y1 - t, x1, y1, col, a); this.rect(x0, y0 + t, x0 + t, y1 - t, col, a); this.rect(x1 - t, y0 + t, x1, y1 - t, col, a); }
    line(x0, y0, x1, y1, col, t = 2, a = 1) {
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
        for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n; this.rect(x - t / 2, y - t / 2, x + t / 2, y + t / 2, col, a); }
    }
    text(x, y, s, col, scale = 1) { drawText((px, py) => this.set(px, py, col), x, y, s, scale); }
    /** Copy `src` (a Raster) with its top left at (x, y). */
    paste(src, x, y) { for (let j = 0; j < src.h; j++) { const o = ((y + j) * this.w + x) * 4; if (y + j < 0 || y + j >= this.h) continue; this.data.set(src.data.subarray(j * src.w * 4, (j + 1) * src.w * 4), o); } }
}

/** Fill the pixel rectangle [x0,x1) x [y0,y1) of a cell with texture `t`, sampled by the cell-relative position (u, v in 0..1 of the whole cell, v down). */
function texFill(r, cx, cy, x0, y0, x1, y1, t, a = 1, shade = 1) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const u = Math.min(t.w - 1, Math.max(0, Math.floor((x - cx) / C * t.w))), v = Math.min(t.h - 1, Math.max(0, Math.floor((y - cy) / C * t.h))), i = (v * t.w + u) * 4;
        const al = t.data[i + 3] / 255; if (al < 0.1) continue;
        r.set(x, y, [t.data[i] * shade, t.data[i + 1] * shade, t.data[i + 2] * shade], a * al);
    }
}
function hatch(r, x0, y0, col, a = 0.8, step = 6) { for (let d = 0; d < 2 * C; d += step) for (let i = 0; i < C; i++) { const x = x0 + i, y = y0 + d - i; if (y >= y0 && y < y0 + C) { r.set(x, y, col, a); r.set(x + 1, y, col, a); } } }
const isAir = (cell) => !!cell && /^(air|cave_air|void_air)$/.test(cell.n);

/** The axes of a picture: horizontal = the world axis and its sign; the fixed coordinate of the plane. */
function axes(sc, which) {
    const { f, c } = sc;
    if (which === 'along') return { ax: f.fx ? 'x' : 'z', s: f.fx || f.fz, fixed: f.fx ? { z: c.z } : { x: c.x } };
    const rx = -f.fz, rz = f.fx;
    return { ax: rx ? 'x' : 'z', s: rx || rz, fixed: rx ? { z: c.z } : { x: c.x } };
}

/**
 * One panel (N x N cells, no margins) of `view` ('bot' | 'server') for picture `which`. Returns { r: Raster, toPx(x, y, z) -> [px, py] }.
 */
function panel(sc, which, view, tex) {
    const N = 2 * sc.r + 1, R = sc.r, c = sc.c, r = new Raster(N * C, N * C, view === 'server' ? SKY_SERVER : SKY);
    const diffOf = (x, y, z) => (view === 'server' && sc.diff ? sc.diff[`${x},${y},${z}`] || null : null);
    const marks = [];
    if (which === 'top') {
        const toPx = (x, y, z) => [(x - c.x + R) * C, (z - c.z + R) * C];
        const gone = (x, y, z) => diffOf(x, y, z) === 'ghost';
        // per column: the first block under the feet level (d cells down; under null = not loaded, undefined = nothing within R)
        const below = (x, z) => { for (let d = 1; d <= R; d++) { const u = cellAt(sc, x, c.y - d, z); if (u === undefined) return { d: R, under: undefined }; if (u === null || (!isAir(u) && !gone(x, c.y - d, z))) return { d, under: u }; } return { d: R, under: undefined }; };
        const cols = []; const freq = new Map();
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const b = below(c.x - R + i, c.z - R + j); cols.push(b); if (b.under) freq.set(b.d, (freq.get(b.d) || 0) + 1); }
        const usual = [...freq].sort((a, b) => b[1] - a[1])[0];
        sc.usualDepth = usual ? usual[0] : null;          // written in the title; only the columns that differ from it carry their depth
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
            const x = c.x - R + i, z = c.z - R + j, X = i * C, Y = j * C;
            const feet = cellAt(sc, x, c.y, z), head = cellAt(sc, x, c.y + 1, z);
            if (feet === null) { r.rect(X, Y, X + C, Y + C, UNKNOWN); r.text(X + 12, Y + 11, '?', [255, 255, 255], 2); continue; }
            const covered = feet && !gone(x, c.y, z) && feet.s.some((q) => q[0] <= 0.01 && q[2] <= 0.01 && q[3] >= 0.99 && q[5] >= 0.99);
            let seen = 0;                                   // how far down the picture shows this column
            if (!covered) {
                const { d, under } = cols[i * N + j]; seen = d;
                if (under === null) r.rect(X, Y, X + C, Y + C, UNKNOWN, 0.6);
                else if (under) {
                    drawTop(r, X, Y, under, tex, Math.max(0.45, 0.9 - 0.07 * d));
                    if (d >= 2 && d !== sc.usualDepth) { const l = `-${d}`; r.rect(X + C - 4 - textWidth(l, 1), Y + C - 9, X + C - 1, Y + C - 1, [255, 255, 255], 0.8); r.text(X + C - 2 - textWidth(l, 1), Y + C - 7, l, COL.text); }
                } else { r.rect(X, Y, X + C, Y + C, [40, 40, 60], 0.35); r.text(X + C - 2 - textWidth(`<-${R}`), Y + C - 7, `<-${R}`, [255, 255, 255]); }
            }
            if (feet && !isAir(feet) && !gone(x, c.y, z)) drawTop(r, X, Y, feet, tex, 1, true);
            if (head && (head.s.length || head.f) && !gone(x, c.y + 1, z)) { r.box(X + 3, Y + 3, X + C - 3, Y + C - 3, [30, 30, 30], 2, 0.8); r.line(X + 3, Y + 3, X + C - 3, Y + C - 3, [30, 30, 30], 1, 0.6); }
            let d = null; for (let dy = -seen; dy <= 1 && !d; dy++) d = diffOf(x, c.y + dy, z);
            if (d) marks.push([X, Y, d]);
        }
        finishCells(r, marks, N);
        return { r, toPx };
    }
    const { ax, s, fixed } = axes(sc, which), ca = c[ax];
    const toPx = (x, y, z) => { const p = ax === 'x' ? x : z; return [s > 0 ? (p - ca + R) * C : (ca + R + 1 - p) * C, (c.y + R + 1 - y) * C]; };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const a = s > 0 ? ca - R + i : ca + R - i, y = c.y + R - j, X = i * C, Y = j * C;
        const x = ax === 'x' ? a : fixed.x, z = ax === 'z' ? a : fixed.z, cell = cellAt(sc, x, y, z);
        if (cell === null) { r.rect(X, Y, X + C, Y + C, UNKNOWN); r.text(X + 12, Y + 11, '?', [255, 255, 255], 2); continue; }
        const d = diffOf(x, y, z);
        if (cell && !isAir(cell) && d !== 'ghost') drawSide(r, X, Y, cell, ax, s, tex);
        if (d) marks.push([X, Y, d]);
    }
    finishCells(r, marks, N);
    return { r, toPx };
}

/** A block seen from above: each shape's x/z extent with the up texture; a partial height is written in sixteenths in the corner. */
function drawTop(r, X, Y, cell, tex, shade = 1, label = false) {
    const t = tex.get(cell.n, 'up');
    if (!cell.s.length) { texFill(r, X, Y, X, Y, X + C, Y + C, t, cell.f ? 0.75 : 0.45, shade); if (cell.f) r.rect(X, Y, X + C, Y + C, COL[cell.f], 0.35); return; }
    for (const q of cell.s) texFill(r, X, Y, X + q[0] * C, Y + q[2] * C, X + q[3] * C, Y + q[5] * C, t, 1, shade);
    if (cell.f) r.rect(X, Y, X + C, Y + C, COL[cell.f], 0.3);
    const top = Math.max(...cell.s.map((q) => q[4]));
    if (label && top < 0.99) { const l = String(Math.round(top * 16)); r.rect(X + 1, Y + 1, X + 3 + textWidth(l, 2), Y + 13, [255, 255, 255], 0.85); r.text(X + 2, Y + 2, l, COL.text, 2); }
}
/** A block in a vertical slice: each shape's extent along the slice's axis and its height, with the side texture. */
function drawSide(r, X, Y, cell, ax, s, tex) {
    const t = tex.get(cell.n, 'side');
    if (!cell.s.length) { texFill(r, X, Y, X, Y, X + C, Y + C, t, cell.f ? 0.7 : 0.4); if (cell.f) { r.rect(X, Y, X + C, Y + C, COL[cell.f], 0.35); r.line(X + 4, Y + 8, X + 12, Y + 5, [255, 255, 255], 1, 0.7); r.line(X + 12, Y + 5, X + 20, Y + 8, [255, 255, 255], 1, 0.7); } return; }
    for (const q of cell.s) {
        const a0 = ax === 'x' ? q[0] : q[2], a1 = ax === 'x' ? q[3] : q[5], u0 = s > 0 ? a0 : 1 - a1, u1 = s > 0 ? a1 : 1 - a0;
        texFill(r, X, Y, X + u0 * C, Y + (1 - q[4]) * C, X + u1 * C, Y + (1 - q[1]) * C, t);
    }
    if (cell.f) r.rect(X, Y, X + C, Y + C, COL[cell.f], 0.3);
}
/** Grid lines and the server's differences (ghost: an X; missing: hatched orange; state: hatched purple; other: hatched red). */
function finishCells(r, marks, N) {
    for (let i = 1; i < N; i++) { r.rect(i * C, 0, i * C + 1, N * C, COL.grid, 0.12); r.rect(0, i * C, N * C, i * C + 1, COL.grid, 0.12); }
    for (const [X, Y, d] of marks) {
        if (d === 'ghost') { r.line(X + 3, Y + 3, X + C - 3, Y + C - 3, COL.ghost, 3); r.line(X + C - 3, Y + 3, X + 3, Y + C - 3, COL.ghost, 3); }
        else hatch(r, X, Y, d === 'missing' ? COL.missing : d === 'state' ? COL.state : COL.diffOther);
        r.box(X, Y, X + C, Y + C, d === 'missing' ? COL.missing : d === 'state' ? COL.state : COL.ghost, 2);
    }
}

/** The overlays on a panel: route, target, temporary blocks, other bots, the guard's last hold, the cell named by the log, the bot's body (last, on top). */
function overlays(sc, which, p) {
    const { r, toPx } = p, o = sc.over, c = sc.c;
    const near = (x, y, z, d = 1.5) => {
        if (which === 'top') return Math.abs(y - c.y) <= d + 0.5;
        const { ax } = axes(sc, which), w = ax === 'x' ? z - (c.z + 0.5) : x - (c.x + 0.5);
        return Math.abs(w) <= d;
    };
    const cellBox = (x, y, z, col, t = 2, a = 1) => {
        const [ax0, ay0] = toPx(x, y + 1, z), [ax1, ay1] = toPx(x + 1, y, z + 1);
        if (which === 'top') r.box(Math.min(ax0, ax1), Math.min(ay0, ay1), Math.max(ax0, ax1), Math.max(ay0, ay1), col, t, a);
        else { const [bx0] = toPx(x, y, z), [bx1] = toPx(x + 1, y, z + 1); r.box(Math.min(bx0, bx1), ay0, Math.max(bx0, bx1), ay1, col, t, a); }
        return [Math.min(ax0, ax1), Math.min(ay0, ay1)];
    };
    for (const t of o.temps || []) if (near(t.x + 0.5, t.y, t.z + 0.5, 0.6)) { const [X, Y] = cellBox(t.x, t.y, t.z, COL.temp, 2); r.text(X + 3, Y + 3, 'T', COL.temp, 2); }
    const path = (o.path || []).filter((q) => Array.isArray(q) && q.length === 3);
    for (let i = 0; i < path.length; i++) {
        const [x, y, z] = path[i], pt = toPx(x + 0.5, y + 0.15, z + 0.5), on = near(x + 0.5, y, z + 0.5, 0.6);
        if (i) { const [a, b, cc] = path[i - 1], q = toPx(a + 0.5, b + 0.15, cc + 0.5); r.line(q[0], q[1], pt[0], pt[1], COL.route, 2, on ? 1 : 0.4); }
        r.rect(pt[0] - 3, pt[1] - 3, pt[0] + 3, pt[1] + 3, COL.route, on ? 1 : 0.4);
    }
    if (path.length) { const [x, y, z] = path[path.length - 1]; if (near(x + 0.5, y, z + 0.5, 2.5)) { const [X, Y] = cellBox(x, y, z, COL.goal, 3); r.text(X + C - 10, Y + 3, 'G', COL.goal, 2); } }
    if (o.mark && Number.isFinite(o.mark.x)) { const m = o.mark; if (near(m.x + 0.5, m.y, m.z + 0.5, 2.5)) { const [X, Y] = cellBox(m.x, m.y, m.z, COL.mark, 3); r.text(X + 3, Y + C - 13, String(m.label || 'S').slice(0, 1), COL.mark, 2); } }
    const g = o.guard;
    if (g && Number.isFinite(g.x)) {
        if (near(g.x + 0.5, g.y, g.z + 0.5, 2.5)) { const [X0, Y0] = toPx(g.x + 0.5, g.y + 0.5, g.z + 0.5); r.line(X0 - 9, Y0 - 9, X0 + 9, Y0 + 9, COL.guard, 3); r.line(X0 + 9, Y0 - 9, X0 - 9, Y0 + 9, COL.guard, 3); }
        if (Array.isArray(g.from) && Array.isArray(g.to)) { const a = toPx(...g.from), b = toPx(...g.to); r.line(a[0], a[1], b[0], b[1], COL.guard, 2); r.rect(b[0] - 3, b[1] - 3, b[0] + 3, b[1] + 3, COL.guard); }
    }
    const body = (x, y, z, col, hgt = 1.8) => {
        if (which === 'top') { const [a0, b0] = toPx(x - 0.3, y, z - 0.3), [a1, b1] = toPx(x + 0.3, y, z + 0.3); r.box(a0, b0, a1, b1, col, 2); return; }
        const [a0, b0] = toPx(x - 0.3, y + hgt, z - 0.3), [a1, b1] = toPx(x + 0.3, y, z + 0.3);
        r.box(Math.min(a0, a1), b0, Math.max(a0, a1), b1, col, 2);
    };
    for (const b of o.others || []) if (near(b.x, b.y, b.z, 1.5)) body(b.x, b.y, b.z, COL.other);
    const P = sc.pos, h = o.sneak ? 1.5 : 1.8;
    body(P.x, P.y, P.z, COL.body, h);
    // the eye and the look: a dot at eye height (vertical slices), an arrow of the facing (top)
    if (which === 'top') { const [a, b] = toPx(P.x, P.y, P.z); r.line(a, b, a + sc.f.fx * C * 0.9, b + sc.f.fz * C * 0.9, COL.body, 3); }
    else { const [a, b] = toPx(P.x, P.y + (o.sneak ? 1.27 : 1.62), P.z); r.rect(a - 2, b - 2, a + 3, b + 3, COL.eye); r.box(a - 3, b - 3, a + 4, b + 4, COL.body, 1); }
}

const TITLE = { top: (sc) => `TOP AT FEET Y ${sc.c.y} (NORTH UP)${sc.usualDepth ? `, FLOOR MOSTLY ${sc.usualDepth} DOWN` : ''}`, along: (sc) => `ALONG THE FACING (${sc.dir.toUpperCase()} TO THE RIGHT)`, across: (sc) => `ACROSS THE FACING (FROM BEHIND, ${sc.dir.toUpperCase()} INTO THE PAGE)` };

/** Picture `which` of scene `sc`: the bot's panel, and the server's beside it when the scene has a truth (sc.diff). Returns a Raster. */
function picture(sc, which, tex) {
    const N = 2 * sc.r + 1, W = N * C, views = sc.diff ? ['bot', 'server'] : ['bot'];
    const out = new Raster(PAD.l + views.length * (W + PAD.gap), PAD.t + W + PAD.b + LEGEND, [250, 250, 250]);
    views.forEach((v, k) => {
        const p = panel(sc, which, v, tex); overlays(sc, which, p);
        const ox = PAD.l + k * (W + PAD.gap);
        out.paste(p.r, ox, PAD.t);
        const head = v === 'bot' ? `BOT VIEW: ${TITLE[which](sc)}` : `SERVER (RCON): ${Object.keys(sc.diff).length} CELLS DIFFER${sc.unchecked ? `, ${sc.unchecked} NOT CHECKED` : ''}`;
        out.text(ox, 4, head, COL.text);
        axisLabels(out, sc, which, ox, k === 0);
    });
    legend(out, sc, PAD.t + W + PAD.b + 2);
    return out;
}
function axisLabels(out, sc, which, ox, left) {
    const N = 2 * sc.r + 1, R = sc.r, c = sc.c, W = N * C, y0 = PAD.t + W + 3;
    const { ax, s } = which === 'top' ? { ax: 'x', s: 1 } : axes(sc, which);
    for (let i = 0; i < N; i += 2) { const v = (which === 'top' ? c.x - R + i : s > 0 ? c[ax] - R + i : c[ax] + R - i); const t = String(v); out.text(ox + i * C + (C - textWidth(t)) / 2, y0, t, COL.text); }
    out.text(ox + W - textWidth(ax.toUpperCase() + (s > 0 ? '+' : '-')), y0 + 6, ax.toUpperCase() + (s > 0 ? '+' : '-'), [90, 90, 90]);
    if (!left) return;
    for (let j = 0; j < N; j += 2) { const v = which === 'top' ? c.z - R + j : c.y + R - j; const t = String(v); out.text(Math.max(0, ox - 2 - textWidth(t)), PAD.t + j * C + C / 2 - 2, t, COL.text); }
    out.text(1, PAD.t - 7, which === 'top' ? 'Z' : 'Y', [90, 90, 90]);
}
function legend(out, sc, y) {
    const items = [['BODY', COL.body], ['ROUTE', COL.route], ['G GOAL', COL.goal], ['T TEMP', COL.temp], ['OTHER BOT', COL.other], ['X GUARD HOLD', COL.guard], [`${(sc.over.mark && sc.over.mark.label) || 'S'} LOG CELL`, COL.mark]];
    if (sc.diff) items.push(['X GHOST (SERVER AIR)', COL.ghost], ['MISSING (SERVER BLOCK)', COL.missing], ['STATE DIFFERS', COL.state]);
    let x = PAD.l, row = 0;
    for (const [t, col] of items) {
        const w = 12 + textWidth(t) + 14;
        if (x + w > out.w) { x = PAD.l; row++; }
        out.rect(x, y + row * 12, x + 9, y + row * 12 + 7, col); out.text(x + 12, y + row * 12 + 1, t, COL.text); x += w;
    }
    out.text(PAD.l, y + (row + 1) * 12, 'NUMBER IN A CELL: TOP OF A PARTIAL BLOCK IN 16THS. DARK: FLOOR UNDER THE FEET. BOX: BLOCK AT HEAD LEVEL', [90, 90, 90]);
}

module.exports = { picture, panel, overlays, Raster, C, PAD, SKY, SKY_SERVER, COL, axes };

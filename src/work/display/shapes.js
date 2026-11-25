'use strict';
// Shapes for the in-game display (display/overlay.js): REAL lines, not particles (owner 2026-11-11: the particles were faint and did not show in other dimensions).
// A line piece is one `block_display` entity: a thin box of a bright, fully lit block, stretched and rotated by its transformation. Pure functions, no game access.
//   piece = { a: [x, y, z], b: [x, y, z], t: thickness, c: colour index into PALETTE, glow?: true }   (a solid line from a to b)
// A dashed line is a list of such pieces with gaps between them. A piece is keyed by WHAT it shows (idKey), so the overlay summons a thing once, updates it in place while it
// changes (updateCommands) and kills it only when it is no longer valid.

/** Colours: [block, glow colour as an integer 0xRRGGBB]. Concrete blocks: opaque, never textured differently by light; a bot or a lane takes colour `i % PALETTE.length`. */
const PALETTE = Object.freeze([
    ['red_concrete', 0xff4040], ['light_blue_concrete', 0x40a0ff], ['lime_concrete', 0x50ff58], ['yellow_concrete', 0xffd930],
    ['magenta_concrete', 0xd966ff], ['cyan_concrete', 0x33ffe6], ['orange_concrete', 0xff8c26], ['white_concrete', 0xffffff],
]);
const T_PATH = 0.16, T_RANGE = 0.12, T_TAG = 0.1, T_MARK = 0.6;
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
const vec = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

/** Unit quaternion [x, y, z, w] that turns +Z onto the direction d (a unit vector). */
function quatZTo(d) {
    const [x, y, z] = d;
    if (z < -0.999999) return [1, 0, 0, 0];                       // a half turn about X
    const qx = -y, qy = x, qw = 1 + z, n = Math.hypot(qx, qy, qw);
    return [qx / n, qy / n, 0, qw / n];
}
/** Rotate v by the unit quaternion q = [x, y, z, w]. */
function rotate(q, v) {
    const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/** One solid piece from a to b. */
const piece = (a, b, t, c, glow = false) => ({ a: vec(a), b: vec(b), t, c, glow });

/** A dashed line a -> b: dashes of `dash` blocks with `gap` blocks between, the last dash ends exactly at b. */
function dashed(a, b, { dash = 1.5, gap = 1, t = T_RANGE, c = 0, glow = false } = {}) {
    const A = vec(a), B = vec(b), len = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]), out = [];
    if (len < 1e-6) return out;
    const n = Math.max(1, Math.round((len + gap) / (dash + gap))), d = (len - (n - 1) * gap) / n;       // n dashes of length d, n-1 gaps
    for (let i = 0; i < n; i++) {
        const s = i * (d + gap) / len, e = Math.min(1, (i * (d + gap) + d) / len);
        out.push(piece([A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s, A[2] + (B[2] - A[2]) * s], [A[0] + (B[0] - A[0]) * e, A[1] + (B[1] - A[1]) * e, A[2] + (B[2] - A[2]) * e], t, c, glow));
    }
    return out;
}

/** The dashed outline of the X-Z rectangle of a block box {x0, x1, z0, z1} at height y (block edges: x1 + 1 is the far face). */
function rectDashed(box, y, o) {
    const x0 = box.x0, x1 = box.x1 + 1, z0 = box.z0, z1 = box.z1 + 1;
    return [...dashed([x0, y, z0], [x1, y, z0], o), ...dashed([x1, y, z0], [x1, y, z1], o), ...dashed([x1, y, z1], [x0, y, z1], o), ...dashed([x0, y, z1], [x0, y, z0], o)];
}

/** Four dashed corner posts of a box between heights y0 and y1. */
function postsDashed(box, y0, y1, o) {
    const out = [];
    for (const x of [box.x0, box.x1 + 1]) for (const z of [box.z0, box.z1 + 1]) out.push(...dashed([x, y0, z], [x, y1, z], o));
    return out;
}

/** Merge a polyline of points into runs: consecutive steps in the same direction become one segment. Returns [[a, b], ...]. */
function runs(points) {
    const out = [];
    let start = null, dir = null;
    for (let i = 1; i < points.length; i++) {
        const p = points[i - 1], q = points[i], d = [Math.sign(q[0] - p[0]), Math.sign(q[1] - p[1]), Math.sign(q[2] - p[2])];
        if (start && d[0] === dir[0] && d[1] === dir[1] && d[2] === dir[2]) { out[out.length - 1][1] = q; continue; }
        start = p; dir = d; out.push([p, q]);
    }
    return out;
}

/**
 * The key of a drawn thing: WHAT it shows (a run of a bot's path, a dash of a lane, the column of a tag), never where it is, so the same thing keeps its entity while it
 * changes and is updated in place (owner 2026-11-25: the old geometry key killed and summoned a path's first piece every time the bot passed a cell, and redrew a whole
 * claim outline whenever the claim grew). An entity tag: letters, digits, `.`, `_`, `+`, `-`.
 */
function idKey(dim, identity) {
    let a = 0x811c9dc5, b = 5381;
    for (const ch of String(identity)) { const c = ch.charCodeAt(0); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = (Math.imul(b, 33) + c) >>> 0; }
    return `k${dimCode(dim)}_${a.toString(36)}${b.toString(36)}`;
}
/** How a piece looks (geometry, colour, glow, thickness): a change of it is an update of the entity. */
function sigOf(p) {
    const f = (v) => Math.round(v * 20).toString(36);
    return `${p.a.map(f).join('.')}_${p.b.map(f).join('.')}_${p.c}${p.glow ? 'g' : ''}_${Math.round(p.t * 100)}`;
}
function dimCode(dim) { let h = 0; for (const ch of String(dim)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h.toString(36); }

const ANCHOR_R = 16;                         // an entity keeps its position while the line it draws starts this close to it; its transformation carries the rest

/** The look of a piece as NBT, for an entity standing at `anchor` (the line runs a -> b in world coordinates). */
function lookNbt(p, anchor) {
    const [ax, ay, az] = p.a, d = [p.b[0] - ax, p.b[1] - ay, p.b[2] - az], len = Math.hypot(d[0], d[1], d[2]) || 1e-6, u = d.map((v) => v / len);
    const q = quatZTo(u), off = rotate(q, [-p.t / 2, -p.t / 2, 0]);          // the unit cube's corner is its origin: shift it so that the line runs through a -> b
    const tr = [off[0] + ax - anchor[0], off[1] + ay - anchor[1], off[2] + az - anchor[2]];
    const [block, rgb] = PALETTE[((p.c % PALETTE.length) + PALETTE.length) % PALETTE.length];
    const f = (v) => `${round(v, 4)}f`;
    return `block_state:{Name:"minecraft:${block}"},${p.glow ? `Glowing:1b,glow_color_override:${rgb},` : 'Glowing:0b,'}`
        + `transformation:{translation:[${tr.map(f).join(',')}],left_rotation:[${q.map(f).join(',')}],scale:[${f(p.t)},${f(p.t)},${f(len)}],right_rotation:[0f,0f,0f,1f]}`;
}
const at3 = (v) => v.map((x) => x.toFixed(3)).join(' ');       // with a decimal point: whole numbers would be moved to the block's centre

/** The `summon` command of a piece, run in dimension `rconDim` (an id such as minecraft:the_nether), carrying tags `base`, the key tag and the run's epoch tag. It stands at p.a. */
function summonCommand(rconDim, p, key, epoch, base = 'aipd') {
    return `execute in ${rconDim} run summon block_display ${at3(p.a)} {Tags:["${base}","${key}","${epoch}"],brightness:{sky:15,block:15},view_range:3f,shadow_radius:0f,${lookNbt(p, p.a)}}`;
}
/**
 * Change a drawn piece in place: one `data merge` of its look while the new line starts within ANCHOR_R of where the entity stands, else a `tp` to the new start first.
 * Nothing is removed or added, so a client gets one metadata update and never sees the line vanish and come back. Returns { commands, anchor }.
 */
function updateCommands(rconDim, p, key, anchor) {
    const sel = `@e[type=block_display,tag=${key},limit=1]`, near = !!anchor && Math.hypot(p.a[0] - anchor[0], p.a[1] - anchor[1], p.a[2] - anchor[2]) <= ANCHOR_R;
    const to = near ? anchor : p.a.slice(), commands = [];
    if (!near) commands.push(`execute in ${rconDim} run tp ${sel} ${at3(to)}`);
    commands.push(`execute in ${rconDim} run data merge entity ${sel} {${lookNbt(p, to)}}`);
    return { commands, anchor: to };
}
const killCommand = (rconDim, key) => `execute in ${rconDim} run kill @e[type=block_display,tag=${key}]`;
const killAllCommand = (rconDim, base = 'aipd') => `execute in ${rconDim} run kill @e[type=block_display,tag=${base}]`;
/** Everything of an earlier run (another epoch) in a dimension. */
const killStaleCommand = (rconDim, epoch, base = 'aipd') => `execute in ${rconDim} run kill @e[type=block_display,tag=${base},tag=!${epoch}]`;

module.exports = { PALETTE, T_PATH, T_RANGE, T_TAG, T_MARK, quatZTo, rotate, piece, dashed, rectDashed, postsDashed, runs, idKey, sigOf, ANCHOR_R, summonCommand, updateCommands, killCommand, killAllCommand, killStaleCommand };

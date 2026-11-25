'use strict';
// Vanilla's arithmetic where it is not plain double maths (TASK-20261125-076): the 65536-entry sine table of Mth.sin / Mth.cos, Java's float rounding
// (Math.fround) and float-to-int casts. Movement keeps a float wherever the game declares one, so a tick computed here equals the game's to the last bit
// where the formula is the same.
const f = Math.fround;
const SIN = new Float32Array(65536);
for (let i = 0; i < 65536; i++) SIN[i] = Math.sin((i * Math.PI * 2) / 65536);

const F_TABLE = f(10430.378);
const F_QUARTER = f(16384);
const D_TABLE = 10430.378350470453;
// Java's (int) of a float or double: truncation toward zero, saturating (the index is masked afterwards, so only the low bits matter for in-range values)
const toInt = (v) => (Number.isFinite(v) ? Math.trunc(v) | 0 : 0);

/** Mth.sin of a float (up to 1.21.1) or of a double (1.21.2+: index from (long)(d * 10430.378350470453)). */
// (long) x & 65535 for a double: the residue of the truncated value modulo 65536 (two's complement masking of a negative long is the same residue)
const mask16 = (t) => ((t % 65536) + 65536) % 65536;
function sin(v, dbl = false) { return dbl ? SIN[mask16(Math.trunc(v * D_TABLE))] : SIN[toInt(f(f(v) * F_TABLE)) & 65535]; }
function cos(v, dbl = false) { return dbl ? SIN[mask16(Math.trunc(v * D_TABLE + 16384))] : SIN[toInt(f(f(f(v) * F_TABLE) + F_QUARTER)) & 65535]; }

const DEG = f(f(Math.PI) / 180);         // (float)Math.PI / 180.0F as the game writes it
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const floor = Math.floor;

module.exports = { f, sin, cos, DEG, clamp, floor, toInt };

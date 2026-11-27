'use strict';
// A 3x5 pixel font for the labels on the stuck pictures (coordinates, panel titles): upper case, digits and a few signs; lower case is drawn as upper case.
// Each glyph: five rows, each a 3-bit number (4 = left pixel, 1 = right pixel).
const G = {
    '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 3, 1, 7], '4': [5, 5, 7, 1, 1], '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
    A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2],
    K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
    U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
    ' ': [0, 0, 0, 0, 0], '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], ',': [0, 0, 0, 2, 4], ':': [0, 2, 0, 2, 0], '/': [1, 1, 2, 4, 4], '+': [0, 2, 7, 2, 0], '?': [6, 1, 2, 0, 2],
    '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4], '<': [1, 2, 4, 2, 1], '>': [4, 2, 1, 2, 4], '=': [0, 7, 0, 7, 0], '_': [0, 0, 0, 0, 7], '|': [2, 2, 2, 2, 2], '#': [5, 7, 5, 7, 5], '%': [5, 1, 2, 4, 5],
};

/** Width in pixels of `text` at `scale` (4 px per glyph including the gap). */
const textWidth = (text, scale = 1) => String(text).length * 4 * scale - scale;

/** Draw `text` with its top left at (x, y); `px(x, y)` sets one pixel. */
function drawText(px, x, y, text, scale = 1) {
    let cx = x;
    for (const ch of String(text).toUpperCase()) {
        const g = G[ch] || G['?'];
        for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r] & (4 >> c)) for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) px(cx + c * scale + sx, y + r * scale + sy);
        cx += 4 * scale;
    }
}

module.exports = { drawText, textWidth, GLYPHS: G };

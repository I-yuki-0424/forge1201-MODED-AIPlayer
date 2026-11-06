'use strict';
// Parser for the text form of NBT that `/data get` prints (SNBT): {k: 1b, s: "x", l: [1, 2], a: [I; 1, 2]}. Numbers lose their suffix
// (a long becomes a Number: fine for slots, counts and coordinates), strings unquote, compounds become objects, lists arrays.
const MAX_DEPTH = 40, MAX_LEN = 2_000_000;

function parse(text) {
    if (typeof text !== 'string' || text.length > MAX_LEN) throw new Error('snbt: input too long');
    let i = 0;
    const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    const fail = (m) => { throw new Error(`snbt: ${m} at ${i}`); };
    function str(q) {
        let out = ''; i++;
        while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; out += text[i++]; }
        if (text[i] !== q) fail('unterminated string');
        i++; return out;
    }
    function bare() {
        const m = /^[^\s,\]}:=\[{"']+/.exec(text.slice(i, i + 256));
        if (!m) fail('unexpected character');
        i += m[0].length; return m[0];
    }
    function value(depth) {
        if (depth > MAX_DEPTH) fail('too deep');
        ws(); const c = text[i];
        if (c === '{') {
            i++; const o = {}; ws();
            if (text[i] === '}') { i++; return o; }
            for (;;) {
                ws(); const k = text[i] === '"' || text[i] === "'" ? str(text[i]) : bare(); ws();
                if (text[i] !== ':') fail('expected :'); i++;
                o[k] = value(depth + 1); ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === '}') { i++; return o; }
                fail('expected , or }');
            }
        }
        if (c === '[') {
            i++; ws();
            const m = /^[BIL];/.exec(text.slice(i, i + 2)); if (m) i += 2;          // typed array header
            const a = []; ws();
            if (text[i] === ']') { i++; return a; }
            for (;;) {
                a.push(value(depth + 1)); ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === ']') { i++; return a; }
                fail('expected , or ]');
            }
        }
        if (c === '"' || c === "'") return str(c);
        const w = bare();
        if (w === 'true') return true; if (w === 'false') return false;
        const n = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)[bBsSlLfFdD]?$/.exec(w);
        return n ? Number(n[1]) : w;
    }
    const v = value(0); ws();
    if (i < text.length) fail('trailing text');
    return v;
}

/** The SNBT part of a `data get` reply ("<who> has the following entity data: <snbt>"); throws with the server's message otherwise. */
function fromReply(reply) {
    const t = String(reply).replace(/\x1b\[[0-9;]*m/g, '').trim();
    const m = /(?:entity data|block data|storage data|data): ([\s\S]*)$/.exec(t);
    if (!m) throw new Error(t.slice(0, 160) || 'empty reply');
    return parse(m[1]);
}

module.exports = { parse, fromReply };

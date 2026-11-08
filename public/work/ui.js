'use strict';
// Shared helpers of the work console page: DOM builder (textContent only, never innerHTML), API client, toast, modal, icons.
// append / replaceChildren turn null and false into the text "null"/"false": conditional children are common here, so drop them.
for (const m of ['append', 'prepend', 'replaceChildren']) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(2).filter((x) => x !== null && x !== undefined && x !== false)); };
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (n) => Number(n).toLocaleString('en-US');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'value') e.value = v; else if (k === 'checked') e.checked = !!v;
        else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(2)) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
}
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const c of kids) e.append(c);
    return e;
}
const ICONS = {                       // 24x24 stroke icons (shapes after the Feather set)
    grid: [['rect', { x: 3, y: 3, width: 7, height: 7 }], ['rect', { x: 14, y: 3, width: 7, height: 7 }], ['rect', { x: 14, y: 14, width: 7, height: 7 }], ['rect', { x: 3, y: 14, width: 7, height: 7 }]],
    map: [['polygon', { points: '1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6' }], ['line', { x1: 8, y1: 2, x2: 8, y2: 18 }], ['line', { x1: 16, y1: 6, x2: 16, y2: 22 }]],
    bot: [['rect', { x: 4, y: 7, width: 16, height: 13, rx: 2 }], ['line', { x1: 12, y1: 3, x2: 12, y2: 7 }], ['circle', { cx: 9, cy: 13, r: 1 }], ['circle', { cx: 15, cy: 13, r: 1 }]],
    layers: [['polygon', { points: '12 2 2 7 12 12 22 7 12 2' }], ['polyline', { points: '2 17 12 22 22 17' }], ['polyline', { points: '2 12 12 17 22 12' }]],
    box: [['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }], ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }], ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }]],
    list: [['line', { x1: 8, y1: 6, x2: 21, y2: 6 }], ['line', { x1: 8, y1: 12, x2: 21, y2: 12 }], ['line', { x1: 8, y1: 18, x2: 21, y2: 18 }], ['line', { x1: 3, y1: 6, x2: 3.01, y2: 6 }], ['line', { x1: 3, y1: 12, x2: 3.01, y2: 12 }], ['line', { x1: 3, y1: 18, x2: 3.01, y2: 18 }]],
    pack: [['rect', { x: 3, y: 7, width: 18, height: 13, rx: 2 }], ['path', { d: 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }], ['line', { x1: 3, y1: 13, x2: 21, y2: 13 }]],
    term: [['polyline', { points: '4 17 10 11 4 5' }], ['line', { x1: 12, y1: 19, x2: 20, y2: 19 }]],
    log: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }], ['line', { x1: 8, y1: 13, x2: 16, y2: 13 }], ['line', { x1: 8, y1: 17, x2: 16, y2: 17 }]],
    plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
    refresh: [['polyline', { points: '23 4 23 10 17 10' }], ['path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }]],
    x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    play: [['polygon', { points: '5 3 19 12 5 21 5 3' }]],
    pause: [['rect', { x: 6, y: 4, width: 4, height: 16 }], ['rect', { x: 14, y: 4, width: 4, height: 16 }]],
    tag: [['path', { d: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z' }], ['line', { x1: 7, y1: 7, x2: 7.01, y2: 7 }]],
    eye: [['path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    target: [['circle', { cx: 12, cy: 12, r: 10 }], ['circle', { cx: 12, cy: 12, r: 6 }], ['circle', { cx: 12, cy: 12, r: 2 }]],
};
function icon(name, size = 16) {
    const s = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [t, a] of ICONS[name] || []) s.append(svg(t, a));
    return s;
}

// ---- API
const session = { csrf: null };
async function api(method, url, body, raw) {
    const headers = {};
    if (session.csrf) headers['X-CSRF'] = session.csrf;
    let payload;
    if (raw !== undefined) { headers['Content-Type'] = 'application/octet-stream'; payload = raw; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== '/api/login' && url !== '/api/session') { window.dispatchEvent(new Event('work-login-required')); throw new Error('login required'); }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

// ---- toast
let toastTimer = null;
function toast(msg, bad = false) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 9000 : 3500);
}
/** Wrap an async handler: errors become toasts, success an optional toast; the page refreshes afterwards. */
const act = (fn, ok, after) => async (...a) => {
    try { const r = await fn(...a); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); if (after) await after(r); else if (window.refreshAll) await window.refreshAll(); return r; }
    catch (e) { if (e.message !== 'cancelled') toast(e.message, true); }
};

// ---- modal
function modal(title, body, { wide = false, onClose = null } = {}) {
    const close = () => { back.remove(); if (onClose) onClose(); };
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } },
        h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog' },
            h('div', { class: 'panel-head' }, h('span', { class: 'panel-title', text: title }), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, icon('x'))),
            h('div', { class: 'modal-body' }, body)));
    document.body.append(back);
    return { close, el: back };
}

/**
 * Ask yes or no in a box of the page: resolves true or false. The browser's own confirm() does not show in the game's web view (MCEF has no dialogs), so a button that
 * asked for it never did anything (owner 2026-11-09: "Remove does nothing"). Escape or a click outside answers no.
 */
function ask(message, { yes = 'Yes', no = 'No', danger = true } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
        const m = modal('Please confirm', h('div', { class: 'stack' },
            h('p', { text: message }),
            h('div', { class: 'row' }, h('button', { class: `btn${danger ? ' danger' : ' primary'}`, onclick: () => finish(true) }, yes), h('button', { class: 'btn', onclick: () => finish(false) }, no))), { onClose: () => finish(false) });
        const key = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', key); finish(false); } };
        document.addEventListener('keydown', key);
    });
}

/** A modal list to pick one of {value, text}; resolves with the value, or null when closed. */
function choose(title, options) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { done = true; m.close(); resolve(v); };
        const list = h('div', { class: 'stack' }, options.map((o) => h('button', { class: 'btn', type: 'button', onclick: () => finish(o.value) }, o.text)));
        const m = modal(title, list, { onClose: () => { if (!done) resolve(null); } });
    });
}

const stateDot = (state) => h('span', { class: `dot ${state}`, title: state });
const pill = (text, kind = '') => h('span', { class: `pill ${kind || text}`, text });

/** A panel with a header (title, optional right-side actions) and a body. */
function panel(title, body, { actions = null, cls = '' } = {}) {
    return h('section', { class: `panel ${cls}` }, h('div', { class: 'panel-head' }, h('span', { class: 'panel-title', text: title }), h('span', { class: 'panel-actions' }, actions)), h('div', { class: 'panel-body' }, body));
}
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
const num = (v) => { const n = Number(v); return v === '' || v === null || v === undefined || Number.isNaN(n) ? NaN : n; };

const colorOfName = (name) => { let x = 7; for (const c of String(name).replace(/\[.*/, '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${x % 360} ${40 + (x >> 8) % 30}% ${34 + (x >> 16) % 24}%)`; };

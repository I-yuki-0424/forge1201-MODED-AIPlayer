'use strict';
// The in-game web view (F12, MCEF) draws the page off screen: the browser's own pop-ups (the list of a <select>, the suggestions of an <input list>) are separate native
// windows that it never shows. They appeared as white boxes, and a list opened once stayed open (owner 2026-11-09). In the kiosk layout the lists are drawn by the page:
// pressing a <select> opens the same choose() box that the page uses elsewhere, and the suggestion lists are left out (the field still takes typed text).
// Not needed, and not loaded, in a normal browser: work.js calls it only for the kiosk layout.
function installKiosk() {
    const open = (sel) => {
        const label = (sel.getAttribute('aria-label') || (sel.closest('label') && sel.closest('label').textContent) || 'Choose').trim().slice(0, 60);
        choose(label, [...sel.options].map((o) => ({ value: o.value, text: o.text || o.value || '(none)' }))).then((v) => {
            if (v === null || v === sel.value) return;
            sel.value = v;
            sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };
    document.addEventListener('mousedown', (e) => {
        const s = e.target && e.target.closest ? e.target.closest('select') : null;
        if (!s || s.disabled) return;
        e.preventDefault(); s.blur(); open(s);
    }, true);
    document.addEventListener('keydown', (e) => {
        const s = e.target;
        if (s && s.tagName === 'SELECT' && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(s); }
    }, true);
    const strip = (root) => { if (root.querySelectorAll) root.querySelectorAll('input[list]').forEach((i) => i.removeAttribute('list')); };
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(strip))).observe(document.body, { childList: true, subtree: true });
    strip(document);
}

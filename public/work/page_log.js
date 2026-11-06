'use strict';
// Log page.
function logPage() {
    const pre = h('pre', { class: 'logbox' });
    return { el: panel('Log', pre), update(s) { pre.textContent = [...s.log].reverse().map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.level.padEnd(5)} ${e.msg}`).join('\n'); } };
}

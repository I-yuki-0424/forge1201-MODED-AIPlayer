'use strict';
// The Automation page: settings of the work layer, scripts (small JSON programs for the bots) and the problem log. Tagged blocks: page_tags.js. Everything is built with the DOM helpers of ui.js (textContent only); the server validates.

// A routine (run with "Repeat until stopped"): take nine iron nuggets from the chest named nugget-chest, make an ingot at the crafting table tagged nugget-table, and with nine
// ingots make a block and put it back into the chest. Tag the two blocks on the Tags page first (any purpose; the chest 'any', the table 'other').
const ROUTINE_TEMPLATE = {
    name: 'nuggets-to-blocks',
    steps: [
        { if: { not: { has: { item: 'iron_nugget', min: 9 } } }, then: [{ take: { item: 'iron_nugget', count: 9, from: 'nugget-chest' }, optional: true }] },
        { if: { has: { item: 'iron_nugget', min: 9 } }, then: [{ cmd: 'craft', args: { item: 'iron_ingot', count: 1 }, at: 'nugget-table' }] },
        { if: { has: { item: 'iron_ingot', min: 9 } }, then: [
            { cmd: 'craft', args: { item: 'iron_block', count: 1 }, at: 'nugget-table' },
            { cmd: 'deposit', args: { item: 'iron_block', count: 1 }, at: 'nugget-chest' },
        ] },
        { return: 'ok' },
    ],
};
const SCRIPT_TEMPLATE = {
    name: 'my-script',
    steps: [
        { if: { tool: 'pickaxe' }, then: [{ log: 'already have a pickaxe' }, { return: 'ok' }] },
        { take_tool: { class: 'pickaxe', from: 'tools' }, optional: true },
        { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        { return: 'fail' },
    ],
};

function SettingsPanel(getS) {
    const rows = [
        ['retireWorn', 'Retire worn tools', 'A tool with at most 8 uses (or 6 %) left counts as no tool; the next one is used. Off = tools are used until they break. Which materials this applies to: the policy below.'],
        ['discardWorn', 'Use up tools and throw them away', 'A tool that is worn out (the Retire worn rule: 8 uses or 6 % left) is thrown away through the server (that exact stack, a good one of the same kind stays); replacements are taken from the tools chest, which hands out usable ones only.'],
        ['scripts', 'Recovery scripts', 'A bot without a usable tool runs the script replace-tool (take one from the tools chest, else craft one) before it waits.'],
        ['autoKit', 'Auto-kit (RCON)', 'A bot that runs out of something is given exactly that, or the kit, by the server.'],
        ['defend', 'Defend itself', 'A bot that is hurt while it works kills the mob next to it, then goes on. Only what attacks it, never every mob in sight.'],
        ['reflex', 'Reflexes', 'A bot that falls 5 blocks or more puts water on the ground below with a water bucket (and takes it up again), or a block under its feet against the wall; one in lava drinks a fire resistance potion or walks out. The task stops for that moment and the work goes on. Experimental.'],
        ['glow', 'Glow on problems (RCON)', 'A bot that hits a problem glows in the game (visible through blocks, from above) until its next finished unit.'],
        ['directPickup', 'Mined blocks into the inventory (RCON + server script)', 'Drops of blocks a bot breaks go straight into its inventory (server script forgeaip_direct_pickup.js). Off = drops lie on the ground.'],
    ];
    const boxes = {};
    // What happens to a tool that is nearly worn out, per material (owner 2026-11-08): iron and below are used until they break; diamond and netherite are stopped just
    // before and kept in a chest. Only while "Retire worn tools" is on.
    const tiers = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'], pol = {};
    const polRow = h('div', { class: 'row' }, tiers.map((t) => {
        pol[t] = h('select', { class: 'sel', 'aria-label': `${t} tools`, onchange: act(() => api('POST', '/api/settings', { toolPolicy: { [t]: pol[t].value } }), () => `${t} tools: ${pol[t].value === 'keep' ? 'stopped before they break, kept' : 'used until they break'}`) },
            [['use_up', 'use until broken'], ['keep', 'stop before, keep']].map(([v, x]) => h('option', { value: v, text: x })));
        return h('label', { class: 'field' }, h('span', { class: 'field-label', text: t }), pol[t]);
    }));
    // Server moves (RCON tp): the work layer puts a stuck bot on a standable cell, and nothing used to say so (owner 2026-11-08: "moves as if teleporting"). Every one is in the log and
    // in the bot's row now; this limits the ones made to get out of trouble (a layer change or a way out of the pit is always allowed).
    const tpSel = h('select', { class: 'sel', 'aria-label': 'server moves', onchange: act(() => api('POST', '/api/settings', { teleport: tpSel.value }), () => `server moves for recovery: ${tpSel.value}`) },
        [['near', 'near only (16 blocks across, 6 up or down)'], ['off', 'never'], ['any', 'as far as it takes']].map(([v, t]) => h('option', { value: v, text: t })));
    const el = h('div', { class: 'stack' }, rows.map(([k, label, hint]) => {
        boxes[k] = h('input', { type: 'checkbox', onchange: act(() => api('POST', '/api/settings', { [k]: boxes[k].checked }), () => `${label}: ${boxes[k].checked ? 'on' : 'off'}`) });
        return h('label', { class: 'check setting' }, boxes[k], h('span', {}, h('strong', { text: label }), h('div', { class: 'muted small', text: hint })));
    }), h('div', { class: 'setting' }, h('span', {}, h('strong', { text: 'Server moves for recovery (RCON)' }), h('div', { class: 'muted small', text: 'A bot that is stuck can be put on a standable cell by the server (that looked like teleporting). Each such move is in the log and in the bot\'s row. Moves that a job needs (another layer, out of the pit) are not limited.' }), tpSel)), h('div', { class: 'setting' }, h('span', {}, h('strong', { text: 'Tool durability policy' }), h('div', { class: 'muted small', text: 'Per material, while "Retire worn tools" is on: use until it breaks (a replacement is fetched or crafted when it is gone), or stop using it just before it breaks and keep it in a chest to be mended.' }), polRow)));
    return { el, update(s) {
        for (const [k] of rows) if (document.activeElement !== boxes[k]) boxes[k].checked = !!(s.settings && s.settings[k]);
        if (document.activeElement !== tpSel) tpSel.value = (s.settings && s.settings.teleport) || 'near';
        for (const t of tiers) if (document.activeElement !== pol[t]) pol[t].value = (s.settings && s.settings.toolPolicy && s.settings.toolPolicy[t]) || 'use_up';
    } };
}

/** The in-game display (particles only the operator sees): one switch for all and one per layer. */
function DisplayPanel() {
    const rows = [
        ['on', 'Show in the game', 'Particles drawn in the world for every player on the server who is not a bot (they are tagged aip_see). Nothing is installed on the PC.'],
        ['paths', 'Walking paths', 'The way each bot is about to walk, in the bot\'s colour, ending in a large mark.'],
        ['lanes', 'Mining divisions', 'Each pit lane outlined at the rim and at the layer it is digging now, joined by corner posts; build jobs as a box.'],
        ['tags', 'Tagged blocks', 'A short column over every tagged block, and a dotted line from a machine to the container it is linked to.'],
    ];
    const boxes = {};
    const el = h('div', { class: 'stack' }, rows.map(([k, label, hint]) => {
        boxes[k] = h('input', { type: 'checkbox', onchange: act(() => api('POST', '/api/settings', { display: { [k]: boxes[k].checked } }), () => `${label}: ${boxes[k].checked ? 'on' : 'off'}`) });
        return h('label', { class: 'check setting' }, boxes[k], h('span', {}, h('strong', { text: label }), h('div', { class: 'muted small', text: hint })));
    }));
    return { el, update(s) { for (const [k] of rows) if (document.activeElement !== boxes[k]) boxes[k].checked = !!(s.settings && s.settings.display && s.settings.display[k]); } };
}

function ScriptsPanel(getS) {
    let list = [], current = null;
    const listBox = h('div', { class: 'table-wrap' }), editor = h('textarea', { class: 'code', rows: 16, spellcheck: false, 'aria-label': 'script JSON' }), result = h('pre', { class: 'code-out small' });
    const botSel = h('select', { class: 'sel' }, h('option', { value: '', text: 'run on bot…' }));
    editor.value = JSON.stringify(SCRIPT_TEMPLATE, null, 2);
    async function load() { try { list = await api('GET', '/api/scripts'); } catch (_) { return; } render(); }
    const open = (sc) => { current = sc.name; editor.value = JSON.stringify({ name: sc.builtIn ? `${sc.name}-copy` : sc.name, steps: sc.steps }, null, 2); render(); };
    function render() {
        listBox.replaceChildren(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Script', 'Steps', ''].map((x) => h('th', { text: x })))),
            h('tbody', {}, list.map((sc) => h('tr', { class: current === sc.name ? 'on' : '' }, h('td', {}, h('strong', { text: sc.name }), sc.builtIn ? h('span', { class: 'pill', text: 'built in' }) : null), h('td', { text: String(sc.steps.length) }),
                h('td', {}, h('span', { class: 'row tight' }, h('button', { class: 'btn small', onclick: () => open(sc) }, sc.builtIn ? 'Copy to editor' : 'Edit'),
                    sc.builtIn ? null : h('button', { class: 'btn small ghost danger', onclick: act(() => { if (!confirm(`Delete script ${sc.name}?`)) throw new Error('cancelled'); return api('DELETE', `/api/scripts/${sc.name}`); }, 'script deleted', load) }, 'Delete'))))))));
    }
    const parse = () => { try { return JSON.parse(editor.value); } catch (e) { throw new Error(`not valid JSON: ${e.message}`); } };
    const save = act(async () => { const r = await api('POST', '/api/scripts', parse()); current = r.name; return r; }, (r) => `script ${r.name} saved (validated)`, load);
    const repeat = h('input', { type: 'checkbox', 'aria-label': 'repeat until stopped' });
    const run = act(async () => {
        const b = botSel.value; if (!b) throw new Error('choose a bot to run it on'); const name = current || (parse().name);
        if (!list.some((s) => s.name === name)) throw new Error('save the script first');
        if (repeat.checked) { const q = await api('POST', `/api/scripts/${name}/run`, { bot: b, repeat: true }); result.textContent = `routine ${name} started on ${b}: it repeats until you press Stop on the Bots page (or five rounds in a row fail)`; return { ok: true, ended: 'started', steps: 0, log: [], routine: q }; }
        const r = await api('POST', `/api/scripts/${name}/run`, { bot: b });
        result.textContent = `${r.ended} after ${r.steps} steps${r.reason ? ` (${r.reason})` : ''}\n${(r.log || []).join('\n')}`; return r;
    }, (r) => (r.ended === 'started' ? 'routine started' : `script ${r.ok ? 'finished' : 'ended: ' + r.ended}`), () => {});
    const el = h('div', { class: 'stack' }, listBox,
        h('div', { class: 'sep' }), editor,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Validate and save'), botSel, h('button', { class: 'btn', onclick: run }, icon('play', 12), ' Run'), h('label', { class: 'check' }, repeat, ' repeat until stopped'),
            h('button', { class: 'btn small ghost', onclick: () => { editor.value = JSON.stringify(SCRIPT_TEMPLATE, null, 2); current = null; render(); } }, 'New from template'),
            h('button', { class: 'btn small ghost', onclick: () => { editor.value = JSON.stringify(ROUTINE_TEMPLATE, null, 2); current = null; render(); } }, 'Routine example')),
        result,
        h('details', { class: 'small muted' }, h('summary', { text: 'Grammar' }), h('pre', { class: 'code-out small', text:
            'steps: [ STEP, ... ]\n' +
            'STEP  { "cmd": "craft", "args": {...}, "at": "<tagged block name or purpose>", "table": true, "optional": true }   one action command (or "pillar")\n' +
            '      { "if": COND, "then": [...], "else": [...] }\n' +
            '      { "take": { "item": "iron_ingot", "count": 3, "from": "ore" } }      withdraw from the nearest site with that tag\n' +
            '      { "take_tool": { "class": "pickaxe", "from": "tools" } }\n' +
            '      { "put_away": true } { "station": "crafting_table" } { "release_station": true } { "leave_pit": true }\n' +
            '      { "return": "ok" | "fail" } { "log": "text" }\n' +
            'COND  { "has": "item" | {"item":..,"min":n} } { "tool": "pickaxe" } { "can_craft": "stick" } { "site": "tools" }\n' +
            '      { "free_slots": n } { "all": [..] } { "any": [..] } { "not": COND }\n' +
            'Unknown keys, commands outside the action layer, nesting deeper than 6 and more than 200 steps are refused.' })));
    return { el, load, syncBots(s) { const keep = botSel.value, names = s.bots.filter((b) => b.state === 'online' && !b.working).map((b) => b.name); if (botSel.dataset.n !== names.join(',')) { botSel.dataset.n = names.join(','); botSel.replaceChildren(h('option', { value: '', text: 'run on bot…' }), ...names.map((n) => h('option', { value: n, text: n }))); botSel.value = keep; } } };
}

/** Bots that hit a problem: the recent ones with where they stood and what they faced, and what the problems have in common. */
function ProblemsPanel() {
    const body = h('div', { class: 'stack' });
    async function load() {
        let d; try { d = await api('GET', '/api/problems?n=40'); } catch (_) { return; }
        const common = Object.entries(d.common.factors).map(([f, v]) => h('div', { class: 'small' }, h('strong', { text: `${f}: ` }), h('span', { class: 'mono', text: v.slice(0, 4).map((x) => `${x.value} ×${x.count}`).join('   ') })));
        const rows = d.recent.slice().reverse().slice(0, 25).map((r) => h('tr', {}, h('td', { class: 'mono', text: new Date(r.t).toLocaleTimeString() }), h('td', { text: r.bot }), h('td', { text: r.kind }),
            h('td', { text: [r.reason, r.stage].filter(Boolean).join(' / ') }), h('td', { class: 'mono', text: r.cell ? r.cell.join(' ') : '' }), h('td', { text: r.heading || '' }), h('td', { text: [r.below, r.ahead].filter(Boolean).join(' | ') })));
        body.replaceChildren(
            h('p', { class: 'muted small', text: d.glowing.length ? `Glowing now: ${d.glowing.join(', ')}` : 'Nobody glows now.' }),
            common.length ? h('div', {}, h('div', { class: 'muted small', text: `Common factors in ${d.common.total} problems (seen at least twice):` }), ...common) : h('p', { class: 'muted small', text: 'No pattern yet.' }),
            rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Time', 'Bot', 'Kind', 'Reason', 'Cell', 'Facing', 'Below | ahead'].map((x) => h('th', { text: x })))), h('tbody', {}, rows))) : h('p', { class: 'muted', text: 'No problems recorded.' }));
    }
    return { el: body, load };
}

function automationPage() {
    const settings = SettingsPanel(getS), display = DisplayPanel(), scripts = ScriptsPanel(getS), problems = ProblemsPanel();
    const el = h('div', { class: 'grid-12' },
        h('div', { class: 'span-6' }, panel('Settings', settings.el)),
        h('div', { class: 'span-6' }, panel('In-game display', display.el)),
        h('div', { class: 'span-12' }, panel('Scripts', scripts.el)),
        h('div', { class: 'span-12' }, panel('Problem bots', problems.el)));
    return { el, onShow() { scripts.load(); problems.load(); }, update(s) { settings.update(s); display.update(s); scripts.syncBots(s); } };
}

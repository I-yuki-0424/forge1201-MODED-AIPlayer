'use strict';
// Command panel: pick bots (all / selected / one), pick a command from a grouped dropdown, fill a form that is generated from the
// server's catalog (/api/commands/catalog): coordinates with "operator / bot / map" helpers, nearby-entity and item dropdowns, direction
// and slope selects. Nobody has to remember a syntax. Used on the Bots page (batch) and in a bot's detail pane (one bot).
let CATALOG = null;
async function loadCatalog() { if (!CATALOG) CATALOG = await api('GET', '/api/commands/catalog'); return CATALOG; }

const DIRS = ['north', 'south', 'east', 'west'];
const DESTS = [['hand', 'main hand'], ['off_hand', 'off hand'], ['head', 'head'], ['chest', 'chest'], ['legs', 'legs'], ['feet', 'feet']];
const COMMON = ['cobblestone', 'dirt', 'oak_planks', 'stone', 'iron_pickaxe', 'diamond_pickaxe', 'bread', 'torch', 'crafting_table', 'furnace', 'chest', 'stick', 'coal', 'oak_log', 'iron_ingot', 'raw_iron'];

/**
 * @param o { targets: () => [{ value, label, names }], S: () => state, players: () => [..], fixed: bool (no target dropdown) }
 */
function CommandPanel(o) {
    const targetSel = h('select', { class: 'sel', 'aria-label': 'Target bots' }), cmdSel = h('select', { class: 'sel wide', 'aria-label': 'Command' });
    const doc = h('div', { class: 'muted small cmd-doc' }), fields = h('div', { class: 'cmd-fields' }), result = h('div', { class: 'cmd-result' });
    const items = h('datalist', { id: `items-${Math.random().toString(36).slice(2, 7)}` });
    let spec = null, inputs = {}, entityRefresh = null;

    const names = () => { const t = o.targets().find((x) => x.value === targetSel.value) || o.targets()[0]; return t ? t.names : []; };
    const single = () => (names().length === 1 ? names()[0] : null);

    async function refreshItems() {
        items.replaceChildren(...COMMON.map((n) => h('option', { value: n })));
        const b = single(); if (!b) return;
        try { const inv = await api('POST', '/api/inventory', { target: { type: 'entity', name: b } }); items.replaceChildren(...[...new Set([...inv.slots.map((s) => s.id.replace(/^minecraft:/, '')), ...COMMON])].map((n) => h('option', { value: n }))); } catch (_) { /* keep the common list */ }
    }

    function posRow(argNames, optional) {
        const xs = Object.fromEntries(argNames.map((n) => [n, h('input', { type: 'number', class: 'num', placeholder: n, 'aria-label': n })]));
        Object.assign(inputs, xs);
        const set = (p) => { if (p) { xs.x.value = Math.floor(p.x); if (xs.y) xs.y.value = Math.floor(p.y); xs.z.value = Math.floor(p.z); } };
        const botPos = () => { const b = single(), bot = b && o.S().bots.find((x) => x.name === b); return bot && bot.pos; };
        const row = h('div', { class: 'row tight' }, argNames.map((n) => xs[n]),
            h('button', { class: 'btn small', type: 'button', title: 'position of the operator (a player on the server)', onclick: act(async () => { const p = (await api('GET', '/api/players')).find((q) => !q.bot && q.pos); if (!p) throw new Error('no operator position (is the player online?)'); set(p.pos); }, null, () => {}) }, 'operator'),
            h('button', { class: 'btn small', type: 'button', title: 'a tagged block (Tags page): a machine linked to a container is handled through its container', onclick: act(async () => {
                const l = (await api('GET', '/api/sites')).sites; if (!l.length) throw new Error('nothing is tagged yet (Tags page)');
                const pick = await choose('Tagged block', l.map((q) => ({ value: q.name, text: `${q.name}${q.label ? ` (${q.label})` : ''}${q.via ? ` → ${q.via}` : ''}  ${q.x} ${q.y} ${q.z}` })));
                const q = l.find((x) => x.name === pick); if (q) set(q);
            }, null, () => {}) }, 'tagged'),
            h('button', { class: 'btn small', type: 'button', title: 'position of the chosen bot', onclick: () => { const p = botPos(); if (p) set(p); else toast('choose one bot first', true); } }, 'bot'),
            h('button', { class: 'btn small', type: 'button', title: 'click a spot on the map', onclick: async () => { const p = await pickPoint('Pick a position', o.S, o.players); if (!p) return; xs.x.value = p.x; xs.z.value = p.z; if (xs.y) { try { const g = await api('GET', `/api/surface?x=${p.x}&z=${p.z}`); if (g.y !== null) xs.y.value = g.y + 1; } catch (_) { /* y by hand */ } } } }, 'map'));
        return row;
    }

    function buildFields() {
        fields.replaceChildren(); inputs = {}; entityRefresh = null;
        if (!spec) return;
        const args = spec.args, byName = Object.fromEntries(args.map((a) => [a.name, a]));
        const hasXYZ = ['x', 'y', 'z'].every((k) => byName[k]);
        if (hasXYZ) fields.append(field(spec.name === 'teleport' ? 'Coordinates (instead of a player)' : 'Position', posRow(['x', 'y', 'z']), spec.args.some((a) => a.name === 'x' && a.optional) ? 'optional' : 'feet level for y'));
        for (const a of args) {
            if (hasXYZ && ['x', 'y', 'z'].includes(a.name)) continue;
            let el;
            if (a.type === 'dir') el = h('select', { class: 'sel' }, DIRS.map((d) => h('option', { value: d, text: d })));
            else if (a.type === 'dy') el = h('select', { class: 'sel' }, [[0, 'level'], [-1, 'down (stair)'], [1, 'up (stair)']].map(([v, t]) => h('option', { value: v, text: t })));
            else if (a.type === 'dest') el = h('select', { class: 'sel' }, DESTS.map(([v, t]) => h('option', { value: v, text: t })));
            else if (a.type === 'bool') el = h('input', { type: 'checkbox' });
            else if (a.type === 'count') el = h('input', { type: 'number', class: 'num', min: 1, max: 2304, value: a.optional ? '' : 1, placeholder: a.optional ? 'all' : '1' });
            else if (a.type === 'int') el = h('input', { type: 'number', class: 'num' });
            else if (a.type === 'text') el = h('input', { type: 'text', class: 'wide', maxlength: 100, placeholder: 'text' });
            else if (a.type === 'player') { el = h('select', { class: 'sel' }, [h('option', { value: '', text: a.optional ? '(none)' : '' }), ...(o.players() || []).filter((p) => !p.bot).map((p) => h('option', { value: p.name, text: p.name }))]); }
            else if (a.type === 'entity') {
                el = h('select', { class: 'sel wide' }, h('option', { value: '', text: 'load nearby…' }));
                entityRefresh = act(async () => { const b = single(); if (!b) throw new Error('choose one bot to list what is near it'); const list = await api('GET', `/api/bots/${b}/entities`); el.replaceChildren(h('option', { value: '', text: a.optional ? '(none)' : 'pick one' }), ...list.map((e) => h('option', { value: e.id, text: `#${e.id} ${e.username || e.item || e.type} · ${e.dist} m · ${e.pos.x} ${e.pos.y} ${e.pos.z}` }))); }, null, () => {});
            } else { el = h('input', { type: 'text', class: 'wide', list: items.id, placeholder: a.type === 'item' ? 'oak_planks or create:cogwheel' : 'item (bare name)', autocomplete: 'off' }); }
            inputs[a.name] = el;
            const extra = a.type === 'entity' ? h('button', { class: 'btn small', type: 'button', onclick: entityRefresh }, icon('refresh', 13)) : null;
            fields.append(field(`${a.hint || a.name}${a.optional ? '' : ' *'}`, h('span', { class: 'row tight' }, el, extra)));
        }
        if (spec.name === 'gather') {
            const out = h('div', { class: 'muted small' });
            items.append(...['iron_ore', 'coal_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'cobblestone', 'sand', 'gravel', 'clay', 'raw_iron', 'raw_copper', 'coal', 'diamond', 'sugar_cane', 'kelp'].map((n) => h('option', { value: n })));
            fields.append(h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', title: 'what is around the chosen bot (needs exactly one bot as the target)', onclick: act(async () => {
                const b = single(); if (!b) throw new Error('choose one bot to look around it');
                const r = await api('GET', `/api/bots/${b}/find?target=${encodeURIComponent(inputs.target.value.trim())}&radius=${Number(inputs.radius.value) || 32}`);
                out.textContent = !r.ok ? r.why : `${r.total} found (${r.exposed} reachable, ${r.inReach} within reach of where ${b} stands) · blocks: ${r.blocks.join(', ')}${r.nearest.length ? ' · nearest: ' + r.nearest.slice(0, 4).map((c) => `${c.x} ${c.y} ${c.z} (${c.dist} m)`).join('; ') : ''}`;
            }, null, () => {}) }, icon('target', 13), ' Find around the bot'), out));
        }
        if (spec.oneOf) fields.append(h('p', { class: 'hint', text: `Give exactly one of: ${spec.oneOf.map((g) => g.join(' + ')).join(' or ')}.` }));
        if (spec.allOrNone) fields.append(h('p', { class: 'hint', text: `${spec.allOrNone.join(', ')}: all three or none.` }));
        if (spec.args.some((a) => a.type === 'entity') && single()) entityRefresh();
    }

    function readArgs() {
        const out = {};
        for (const a of spec.args) {
            const el = inputs[a.name]; if (!el) continue;
            let v;
            if (a.type === 'bool') v = el.checked || undefined;
            else { v = el.value; if (v === '' || v === undefined) continue; if (['int', 'count', 'dy', 'entity'].includes(a.type)) v = Number(v); }
            if (v !== undefined) out[a.name] = v;
        }
        return out;
    }

    const send = act(async () => {
        if (!spec) throw new Error('pick a command');
        const t = o.targets().find((x) => x.value === targetSel.value) || o.targets()[0];
        if (!t || !t.names.length) throw new Error('no bot to send to');
        const r = await api('POST', '/api/commands', { bots: t.value === 'all' ? 'all' : t.names, command: spec.name, args: readArgs() });
        result.replaceChildren(h('div', { class: 'ok-line', text: `Started on ${r.started.length}: ${r.started.join(', ') || '-'}` }), ...r.refused.map((x) => h('div', { class: 'err-line', text: `${x.name}: ${x.why}` })));
        if (!r.started.length) toast(r.refused[0] ? `${r.refused[0].name}: ${r.refused[0].why}` : 'nothing started', true);
        return r;
    });

    function syncTargets(keep = true) {
        const prev = targetSel.value, opts = o.targets();
        targetSel.replaceChildren(...opts.map((t) => h('option', { value: t.value, text: t.label })));
        if (keep && opts.some((t) => t.value === prev)) targetSel.value = prev;
    }
    function setCommand(name) { spec = (CATALOG || []).find((c) => c.name === name) || null; cmdSel.value = name; doc.textContent = spec ? spec.doc : ''; buildFields(); }

    const root = h('div', { class: 'cmdpanel' },
        h('div', { class: 'row' }, o.fixed ? null : field('Send to', targetSel), field('Command', cmdSel),
            h('span', { class: 'row tight cmd-quick' }, h('button', { class: 'btn', type: 'button', title: 'cancel what the bots are doing', onclick: () => { setCommand('stop'); send(); } }, 'Stop'), h('button', { class: 'btn', type: 'button', title: 'walk to the operator', onclick: () => { setCommand('come'); send(); } }, 'Come to me'))),
        doc, fields, items,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: send }, icon('play', 13), ' Send'), h('span', { class: 'muted small', text: 'Bots working on a job refuse commands: pause the job or take them off it.' })), result);
    targetSel.addEventListener('change', () => { refreshItems(); if (spec && spec.args.some((a) => a.type === 'entity') && single()) entityRefresh && entityRefresh(); });
    cmdSel.addEventListener('change', () => setCommand(cmdSel.value));

    loadCatalog().then((c) => {
        const groups = [...new Set(c.map((x) => x.group))];
        cmdSel.replaceChildren(...groups.map((g) => h('optgroup', { label: g }, c.filter((x) => x.group === g).map((x) => h('option', { value: x.name, text: x.name.replace(/_/g, ' ') })))));
        syncTargets(false); setCommand('move_to'); refreshItems();
    }).catch((e) => toast(e.message, true));
    return { el: root, syncTargets, setCommand, refreshItems };
}

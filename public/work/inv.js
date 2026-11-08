'use strict';
// Inventory GUI: two panes (operator, a bot, or a container block), slot grids with drag and drop between them. Moves run on the server
// as `item replace ... from ...` (the stack keeps its NBT), so items go straight from a chest into the operator's inventory and back.
const PANES = new Map();             // id -> pane (drop targets look up their source here)
let paneSeq = 0;

function slotTile(pane, slot, item, label) {
    const tile = h('div', { class: `slot${item ? ' full' : ''}`, 'data-slot': slot, title: item ? `${item.id}${item.label ? ' "' + item.label + '"' : ''} ×${item.count}${item.damage ? ' (damage ' + item.damage + ')' : ''}${item.enchanted ? ' enchanted' : ''}${item.nbt ? '\n' + item.nbt : ''}` : label || `slot ${slot}`, draggable: item ? 'true' : null });
    if (item) {
        const short = item.id.replace(/^[^:]*:/, '').replace(/_/g, ' ');
        tile.style.background = colorOfName(item.id);
        tile.append(h('span', { class: 'slot-name', text: short.length > 11 ? short.slice(0, 10) + '…' : short }), item.count > 1 ? h('span', { class: 'slot-count', text: item.count }) : null, item.enchanted ? h('span', { class: 'slot-ench' }) : null);
        if (item.max) {                               // tools: how much is left (the bar is green when new, red when nearly broken)
            const f = Math.max(0, Math.min(1, (item.max - (item.damage || 0)) / item.max));
            tile.append(h('span', { class: 'dur slot-dur', title: `${item.max - (item.damage || 0)} of ${item.max} uses left` }, h('span', { class: 'dur-fill', style: `width:${Math.round(f * 100)}%;background:hsl(${Math.round(f * 120)} 70% 45%)` })));
        }
        tile.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ pane: pane.id, slot })); e.dataTransfer.effectAllowed = 'move'; pane.dragging = true; });
        tile.addEventListener('dragend', () => { pane.dragging = false; });
        tile.addEventListener('dblclick', () => pane.quick(slot));
    } else if (label) tile.append(h('span', { class: 'slot-tag', text: label }));
    tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('over'); });
    tile.addEventListener('dragleave', () => tile.classList.remove('over'));
    tile.addEventListener('drop', async (e) => {
        e.preventDefault(); tile.classList.remove('over');
        let d; try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) { return; }
        const src = PANES.get(d.pane); if (!src || !src.target()) return;
        if (src === pane && d.slot === slot) return;
        await pane.receive(src, d.slot, slot);
    });
    return tile;
}

/** One pane. `o`: { S, players, other: () => pane | null, kind, onChange } */
function InvPane(o) {
    const id = ++paneSeq, kindSel = h('select', { class: 'sel' }, [['operator', 'Operator (player)'], ['bot', 'Bot'], ['container', 'Container (chest, barrel, ...)']].map(([v, t]) => h('option', { value: v, text: t })));
    const who = h('span', { class: 'row tight' }), grid = h('div', { class: 'invgrid' }), status = h('div', { class: 'muted small inv-status' });
    const cx = h('input', { type: 'number', class: 'num', placeholder: 'x' }), cy = h('input', { type: 'number', class: 'num', placeholder: 'y' }), cz = h('input', { type: 'number', class: 'num', placeholder: 'z' });
    const near = h('select', { class: 'sel', title: 'containers the bot has loaded around it' }, h('option', { value: '', text: 'find near a bot…' }));
    let data = null, tgt = null, loading = false;
    kindSel.value = o.kind || 'operator';
    const pane = { id, el: null, dragging: false };

    pane.target = () => tgt;
    function readTarget() {
        if (kindSel.value === 'operator') { const sel = $('select', who); tgt = sel && sel.value ? { type: 'entity', name: sel.value } : null; }
        else if (kindSel.value === 'bot') { const sel = $('select', who); tgt = sel && sel.value ? { type: 'entity', name: sel.value } : null; }
        else { const v = [cx, cy, cz].map((i) => num(i.value)); tgt = v.some(Number.isNaN) ? null : { type: 'block', x: v[0], y: v[1], z: v[2] }; }
        return tgt;
    }
    function buildWho() {
        const k = kindSel.value; who.replaceChildren();
        if (k === 'operator') who.append(h('select', { class: 'sel', onchange: () => pane.load() }, [h('option', { value: '', text: 'choose player' }), ...(o.players() || []).filter((p) => !p.bot).map((p) => h('option', { value: p.name, text: p.name }))]));
        else if (k === 'bot') who.append(h('select', { class: 'sel', onchange: () => pane.load() }, [h('option', { value: '', text: 'choose bot' }), ...o.S().bots.filter((b) => b.state === 'online').map((b) => h('option', { value: b.name, text: b.name }))]));
        else who.append(cx, cy, cz, h('button', { class: 'btn small', onclick: () => pane.load() }, 'Load'), near);
    }
    pane.setTarget = (kind, nameOrBlock) => {
        kindSel.value = kind; buildWho();
        if (kind === 'container') { cx.value = nameOrBlock.x; cy.value = nameOrBlock.y; cz.value = nameOrBlock.z; } else { const sel = $('select', who); if (sel) { if (![...sel.options].some((x) => x.value === nameOrBlock)) sel.append(h('option', { value: nameOrBlock, text: nameOrBlock })); sel.value = nameOrBlock; } }
        return pane.load();
    };
    pane.syncOptions = () => {                      // players and bots come and go: rebuild the list only when it changed (an open dropdown must stay open)
        if (kindSel.value === 'container') return;
        const names = (kindSel.value === 'operator' ? (o.players() || []).filter((p) => !p.bot).map((p) => p.name) : o.S().bots.filter((b) => b.state === 'online').map((b) => b.name)).join(',');
        if (who.dataset.names === names) return;
        const sel = $('select', who), keep = sel && sel.value; buildWho(); who.dataset.names = names;
        const n = $('select', who); if (keep && n) { if (![...n.options].some((x) => x.value === keep)) n.append(h('option', { value: keep, text: keep })); n.value = keep; }
    };
    pane.load = async () => {
        if (loading || pane.dragging) return;
        if (!readTarget()) { data = null; render(); status.textContent = ''; return; }
        loading = true;
        try { data = await api('POST', '/api/inventory', { target: tgt }); status.textContent = data.kind === 'container' ? `${data.id.replace('minecraft:', '')} · ${data.slots.length} of ${data.size} slots used${data.note ? ` · ${data.note}` : ''}` : `${data.slots.length} stacks`; }
        catch (e) { data = null; status.textContent = e.message; }
        finally { loading = false; }
        render();
    };
    function render() {
        grid.replaceChildren();
        if (!data) return;
        const by = new Map(data.slots.map((s) => [s.slot, s]));
        const row = (slots, cls, labels = {}) => h('div', { class: `invrow ${cls || ''}` }, slots.map((n) => slotTile(pane, n, by.get(n), labels[n])));
        if (data.kind === 'player') {
            grid.append(h('div', { class: 'inv-section', text: 'Armour and off hand' }), row([103, 102, 101, 100, -106], 'armor', { 103: 'head', 102: 'chest', 101: 'legs', 100: 'feet', '-106': 'off' }),
                h('div', { class: 'inv-section', text: 'Inventory' }), ...[0, 1, 2].map((r) => row([...Array(9).keys()].map((c) => 9 + r * 9 + c))),
                h('div', { class: 'inv-section', text: 'Hotbar' }), row([...Array(9).keys()]));
        } else {
            grid.append(h('div', { class: 'inv-section', text: 'Contents' }), ...Array.from({ length: Math.ceil(data.size / 9) }, (_, r) => row([...Array(Math.min(9, data.size - r * 9)).keys()].map((c) => r * 9 + c))));
        }
    }
    pane.quick = async (slot) => { const other = o.other(); if (!other || !other.target()) return toast('choose what is in the other pane first', true); await pane.send(slot, other, null); };
    pane.send = async (slot, dstPane, dstSlot) => {
        try { const r = await api('POST', '/api/inventory/move', { src: tgt, srcSlot: slot, dst: dstPane.target(), dstSlot }); toast(`moved ${r.moved.count} ${r.moved.id.replace('minecraft:', '')}`); }
        catch (e) { toast(e.message, true); }
        await Promise.all([pane.load(), dstPane === pane ? null : dstPane.load()]);
    };
    pane.receive = async (srcPane, srcSlot, dstSlot) => { await srcPane.send(srcSlot, pane, dstSlot); };
    pane.moveAll = async () => {
        const other = o.other(); if (!tgt || !other || !other.target()) return toast('choose both sides first', true);
        try { const r = await api('POST', '/api/inventory/moveall', { src: tgt, dst: other.target() }); toast(`moved ${r.moved.length} stacks${r.stopped ? ` (stopped: ${r.stopped})` : ''}`, !!r.stopped); } catch (e) { toast(e.message, true); }
        await Promise.all([pane.load(), other.load()]);
    };

    near.addEventListener('focus', async () => {
        const bots = o.S().bots.filter((b) => b.state === 'online'); if (!bots.length) return;
        try { const list = await api('GET', `/api/bots/${bots[0].name}/containers`); near.replaceChildren(h('option', { value: '', text: `near ${bots[0].name} (${list.length})` }), ...list.map((c) => h('option', { value: `${c.x},${c.y},${c.z}`, text: `${c.block.replace('minecraft:', '')} ${c.x} ${c.y} ${c.z}` }))); } catch (e) { toast(e.message, true); }
    });
    near.addEventListener('change', () => { if (near.value) { const [x, y, z] = near.value.split(',').map(Number); cx.value = x; cy.value = y; cz.value = z; pane.load(); } });
    kindSel.addEventListener('change', () => { buildWho(); tgt = null; data = null; render(); status.textContent = ''; pane.load(); });
    buildWho();
    pane.el = h('div', { class: 'invpane' }, h('div', { class: 'row' }, kindSel, who), status, grid);
    PANES.set(id, pane);
    return pane;
}

/** The Inventory page: two panes and the buttons between them. */
function InventoryPage(S, players) {
    let a, b;
    a = InvPane({ S, players, kind: 'container', other: () => b });
    b = InvPane({ S, players, kind: 'operator', other: () => a });
    const el = h('div', { class: 'inv-page' },
        h('p', { class: 'muted', text: 'Drag a stack to a free slot of the other side, or double-click it to move it to the first free slot. Nothing is created: stacks move (with their NBT) and the source slot is cleared.' }),
        h('div', { class: 'inv-two' }, panel('Left', a.el, { actions: h('button', { class: 'btn small', onclick: () => a.moveAll() }, 'Move all →') }), panel('Right', b.el, { actions: h('button', { class: 'btn small', onclick: () => b.moveAll() }, '← Move all') })));
    const tick = () => { [a, b].forEach((p) => { p.syncOptions(); p.load(); }); };
    return { el, a, b, tick };
}

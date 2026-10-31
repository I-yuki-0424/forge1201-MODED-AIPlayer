'use strict';
// Exact mod blocks and items for a Forge 1.20.1 server (TASK-20261031-020), replacing the heuristic byte scan of
// src/dynamic_registry_injector.js for the action layer.
//
// Two sources, both exact:
//   1. the FML3 registry sync (handshake disc 3, one S2CRegistry per registry): name -> numeric id of every block and
//      item, decoded field by field (Forge HandshakeMessages.S2CRegistry + ForgeRegistry.Snapshot.getPacketData);
//   2. the dump table of the mod set (modpack/<pack>.registry.json, written on a disposable server by
//      tools/registry-dump): per mod block its state count, properties, collision boxes and digging data.
// Forge assigns block-state ids by walking the block registry in id order (GameData.BlockCallbacks.onBake), so the ids
// from (1) and the state counts from (2) give every state id, even if the ids differ from the dump server's.
const fs = require('fs');
const path = require('path');

const DEFAULT_TABLE = path.join(__dirname, '..', '..', 'modpack', 'forgeaip-create.registry.json');

function varint(buf, at) {
    let v = 0, shift = 0, b;
    do {
        if (at.i >= buf.length) throw new Error('registry sync: truncated varint');
        b = buf[at.i++];
        v |= (b & 0x7f) << shift;
        shift += 7;
        if (shift > 35) throw new Error('registry sync: varint too long');
    } while (b & 0x80);
    return v >>> 0;
}

function utf(buf, at) {
    const n = varint(buf, at);
    if (at.i + n > buf.length) throw new Error('registry sync: truncated string');
    const s = buf.toString('utf8', at.i, at.i + n);
    at.i += n;
    return s;
}

/** Map registry name -> Map(entry name -> id), from the disc-3 payloads (each starting with the byte 3). */
function parseRegistrySync(payloads) {
    const out = new Map();
    for (const p of payloads) {
        const at = { i: 1 };
        const name = utf(p, at);
        const ids = new Map();
        if (p[at.i++]) {                                   // hasSnapshot
            for (let n = varint(p, at); n > 0; n--) ids.set(utf(p, at), varint(p, at));
        }
        out.set(name, ids);
    }
    return out;
}

const isVanilla = (name) => name.startsWith('minecraft:');
const short = (name) => name.replace(/^minecraft:/, '');

/** True when the server registers blocks or items beyond minecraft (and Forge's own). */
function hasContentMods(sync) {
    for (const reg of ['minecraft:block', 'minecraft:item']) {
        for (const name of (sync.get(reg) || new Map()).keys()) if (!isVanilla(name) && !name.startsWith('forge:')) return true;
    }
    return false;
}

function loadTable(file = process.env.BOT_MOD_TABLE || DEFAULT_TABLE) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

const PICKAXE_TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden'];
const TIER_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };

/** prismarine harvestTools: {itemId: true} for tools of `kind` at or above `tier`. */
function harvestTools(registry, kind, tier) {
    const need = TIER_RANK[tier || 'wooden'];
    const tools = {};
    for (const t of PICKAXE_TIERS) {
        const it = registry.itemsByName[`${t}_${kind}`];
        if (it && TIER_RANK[t] >= need) tools[it.id] = true;
    }
    return tools;
}

/**
 * prismarine-registry hands every bot the same cached minecraft-data maps: give this registry its own copies of the
 * maps install() writes, so one bot's server cannot change what another bot in the process sees.
 */
function own(registry) {
    if (registry._ownMaps) return;
    for (const k of ['blocks', 'blocksByName', 'blocksByStateId', 'items', 'itemsByName']) {
        registry[k] = Array.isArray(registry[k]) ? registry[k].slice() : { ...registry[k] };
    }
    for (const k of ['blocksArray', 'itemsArray']) if (registry[k]) registry[k] = registry[k].slice();
    if (registry.blockCollisionShapes) {
        registry.blockCollisionShapes = { blocks: { ...registry.blockCollisionShapes.blocks }, shapes: { ...registry.blockCollisionShapes.shapes } };
    }
    Object.defineProperty(registry, '_ownMaps', { value: true });
}

/**
 * Install the server's mod blocks and items into a prismarine registry. Returns a summary for one log line:
 * {blocks, states, items, missing: [mod blocks the table does not describe], error?}. Vanilla entries are only checked,
 * never changed; on any disagreement nothing is installed and `error` says why.
 */
function install(registry, sync, table) {
    const blocks = [...(sync.get('minecraft:block') || new Map())].sort((a, b) => a[1] - b[1]);
    const items = [...(sync.get('minecraft:item') || new Map())];
    const desc = new Map(((table && table.blocks) || []).map((b) => [b.name, b]));
    const shapes = (table && table.shapes) || [];
    const summary = { blocks: 0, states: 0, items: 0, missing: [] };
    if (!blocks.length) return { ...summary, error: 'no block registry in the handshake' };

    // Walk the block registry in id order, counting states; vanilla blocks must sit where minecraft-data has them.
    const plan = [];
    let next = 0;
    for (const [name, id] of blocks) {
        if (isVanilla(name)) {
            const v = registry.blocksByName[short(name)];
            if (!v) return { ...summary, error: `vanilla block ${name} unknown to minecraft-data` };
            if (v.minStateId !== next) return { ...summary, error: `${name} at state ${next}, minecraft-data says ${v.minStateId}` };
            next = v.maxStateId + 1;
            continue;
        }
        const d = desc.get(name);
        if (!d) { summary.missing.push(name); continue; }
        plan.push({ name, id, min: next, count: d.states, d });
        next += d.states;
    }
    // A block the table does not describe has an unknown state count, so every later state id would be a guess:
    // install no blocks then (items stay exact).
    if (summary.missing.length) {
        summary.error = `${summary.missing.length} mod blocks not in the table (first ${summary.missing[0]}); rebuild it: scripts/world/registry-dump.sh`;
        plan.length = 0;
    }

    own(registry);
    for (const { name, id, min, count, d } of plan) {
        const stateShapes = Array.from({ length: count }, (_, i) => shapes[Array.isArray(d.shape) ? d.shape[i] : d.shape] || []);
        const block = {
            id, name, displayName: name.split(':')[1].replace(/_/g, ' '),
            hardness: d.hardness, resistance: d.resistance, stackSize: 64, diggable: d.hardness >= 0,
            material: d.tool ? `mineable/${d.tool}` : 'default',
            transparent: d.transparent, emitLight: d.light, filterLight: d.transparent ? 0 : 15,
            defaultState: min + d.defaultState, minStateId: min, maxStateId: min + count - 1,
            states: d.properties.map((p) => ({ name: p.name, type: p.type, num_values: p.values.length, ...(p.type === 'bool' ? {} : { values: p.values }) })),
            drops: [], boundingBox: stateShapes[d.defaultState].length ? 'block' : 'empty',
            shapes: stateShapes[d.defaultState], stateShapes, modBlock: true,
        };
        if (d.requiresTool && d.tool) block.harvestTools = harvestTools(registry, d.tool, d.tier);
        // Also where prismarine-block's set-up reads shapes from, so a later Block class (another bot) keeps them.
        if (registry.blockCollisionShapes) {
            const col = registry.blockCollisionShapes;
            col.blocks[name] = Array.from({ length: count }, (_, i) => {
                const k = `mod${Array.isArray(d.shape) ? d.shape[i] : d.shape}`;
                col.shapes[k] = col.shapes[k] || stateShapes[i];
                return k;
            });
        }
        registry.blocks[id] = block;
        registry.blocksByName[name] = block;
        for (let s = min; s < min + count; s++) registry.blocksByStateId[s] = block;
        if (registry.blocksArray) registry.blocksArray.push(block);
        summary.blocks++; summary.states += count;
    }

    const stack = new Map(((table && table.items) || []).map((i) => [i.name, i.stackSize]));
    for (const [name, id] of items) {
        if (isVanilla(name)) {
            const v = registry.itemsByName[short(name)];
            if (v && v.id !== id) return { ...summary, error: `vanilla item ${name} has id ${id}, minecraft-data says ${v.id}` };
            continue;
        }
        const item = { id, name, displayName: name.split(':')[1].replace(/_/g, ' '), stackSize: stack.get(name) || 64, modItem: true };
        registry.items[id] = item;
        registry.itemsByName[name] = item;
        if (registry.itemsArray) registry.itemsArray.push(item);
        summary.items++;
    }
    // Block drops: the block's own item (mod blocks drop themselves unless a loot table says otherwise).
    for (const { name, d } of plan) {
        const it = d.item && registry.itemsByName[d.item];
        if (it) registry.blocksByName[name].drops = [it.id];
    }
    if (!summary.missing.length && table && table.blockStates !== undefined && next !== table.blockStates) summary.note = `server has ${next} block states, the table's server had ${table.blockStates}`;
    return summary;
}

module.exports = { parseRegistrySync, hasContentMods, loadTable, install, DEFAULT_TABLE };

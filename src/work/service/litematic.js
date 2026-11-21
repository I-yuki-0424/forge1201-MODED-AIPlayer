'use strict';
// The Litematica page's service side (owner 2026-11-21): what a shared placement needs (without making a job), what the material containers hold (loose and inside shulker boxes), and the
// difference. A part of WorkService (index.js copies these methods onto it). The build job itself is `createBuildFromPlacement` in jobs.js.
const bp = require('../jobs/blueprint');
const build = require('../jobs/build');
const snbt = require('../world/snbt');
const { Problem, need, int } = require('./common');

const SHULKER = /(^|_)shulker_box$/;
const bare = (id) => String(id).replace(/^minecraft:/, '');
const passed = (reply) => /Test passed/i.test(String(reply).replace(/\x1b\[[0-9;]*m/g, ''));

/** The stacks inside a shulker box item read from `data get`: [{ id, count }] (with `slot` when `slots`); the 26.1 `minecraft:container` component, a stack without a count is one. */
function boxContents(stack, slots = false) {
    const inner = (stack.components && stack.components['minecraft:container']) || [], out = [];
    for (const e of Array.isArray(inner) ? inner : []) { const it = e && e.item; if (it && it.id) out.push({ id: bare(it.id), count: Number(it.count) || 1, ...(slots ? { slot: Number(e.slot) || 0 } : {}) }); }
    return out;
}

class LitematicPart {
    /** The placement as the plan sees it: { name, size, origin, dim, count, materials, unsupported, skipped, ignoredSubRegions }. spec: { placement, bot?, origin? }. Nothing is created. */
    async litematicPreview(spec) {
        need(spec && typeof spec === 'object' && typeof spec.placement === 'string', 'spec.placement (a Syncmatica placement id) missing');
        const c = this._syncClient(spec.bot), p = c.placements.get(spec.placement);
        need(p, `no placement ${String(spec.placement).slice(0, 40)} in the list`, 404);
        const key = `${p.id}:${p.hash}`, cache = this._litCache || (this._litCache = new Map());
        let hit = cache.get(key);
        if (!hit || Date.now() - hit.at > 120000) {
            let file; try { file = await c.fetch(p.id); } catch (e) { throw new Problem(`the download failed: ${e.message}`); }
            let placed; try { const L = require('../jobs/litematic'); placed = L.place(L.parse(file), p, { keepAir: false }); } catch (e) { throw new Problem(`not a usable litematic: ${e.message}`); }
            hit = { at: Date.now(), placed }; cache.set(key, hit); for (const [k, v] of cache) if (Date.now() - v.at > 600000) cache.delete(k);
        }
        const o = spec.origin, origin = o ? { x: int(o.x, 'origin.x'), y: int(o.y, 'origin.y'), z: int(o.z, 'origin.z') } : hit.placed.origin;
        let plan; try { plan = build.planBuild(bp.cells(hit.placed.bp), origin, { known: this.known, zones: 1, mode: 'area', tile: 64 }); } catch (e) { throw new Problem(e.message); }
        return { name: p.name || p.fileName, size: hit.placed.bp.size, origin, dim: String(p.dimension || 'minecraft:overworld').replace(/^minecraft:/, '').replace('the_', ''), count: plan.count,
            materials: plan.materials || this._materials(plan), unsupported: plan.unsupported, skipped: plan.skipped, ignoredSubRegions: hit.placed.ignored };
    }

    /** The other half of a double chest (the tagged half is one block, the window shows both), or null. */
    async _chestPartner(x, y, z) {
        const t = async (px, pz, st) => passed(await this.rcon(`execute if block ${px} ${y} ${pz} minecraft:chest${st}`));
        if (!(await t(x, z, '')) || (await t(x, z, '[type=single]'))) return null;
        for (const f of ['north', 'south']) if (await t(x, z, `[facing=${f}]`)) { for (const dx of [1, -1]) if (await t(x + dx, z, `[facing=${f}]`) && !(await t(x + dx, z, '[type=single]'))) return { x: x + dx, y, z }; return null; }
        for (const f of ['east', 'west']) if (await t(x, z, `[facing=${f}]`)) { for (const dz of [1, -1]) if (await t(x, z + dz, `[facing=${f}]`) && !(await t(x, z + dz, '[type=single]'))) return { x, y, z: z + dz }; return null; }
        return null;
    }

    /** The raw stacks of one container block, one request each: [{ Slot, id, count, components? }] (an RCON reply is at most 4096 bytes, `data get` takes no `Items[].id`). */
    async _readItems(x, y, z) {
        const at = `${x} ${y} ${z}`, items = [];
        for (let i = 0; i < 54; i++) {
            let reply; try { reply = await this.rcon(`data get block ${at} Items[${i}]`); } catch (e) { throw new Problem(`reading the container at ${at}: ${String(e.message).slice(0, 120)}`); }
            if (/no elements|Found no|does not have|has no/i.test(String(reply))) break;                                      // past the last stack (or an empty container)
            try { items.push(snbt.fromReply(reply)); } catch (e) { throw new Problem(`reading the container at ${at}, stack ${i}: ${String(e.message).slice(0, 120)}`); }
        }
        return items;
    }

    /** One container block's items: { loose: {item: n}, boxed: {item: n}, boxes: n }, shulker boxes counted by what they hold (their `container` component). */
    async _readStock(x, y, z) {
        const out = { loose: {}, boxed: {}, boxes: 0 };
        for (const s of await this._readItems(x, y, z)) {
            const id = bare(s.id), n = Number(s.count) || 1;
            if (SHULKER.test(id)) {
                out.boxes++;
                for (const e of boxContents(s)) out.boxed[e.id] = (out.boxed[e.id] || 0) + e.count;
            } else out.loose[id] = (out.loose[id] || 0) + n;
        }
        return out;
    }

    /**
     * Unpack the shulker boxes of the tagged containers into plain barrels beside them (owner 2026-11-21: the bots lifted boxes out of the chest themselves and the build died of it: boxes leaked
     * into packs, were scattered 85 blocks out, and the crew starved with the materials in somebody's pack). An OPERATOR action over RCON, like "Give materials": every box's contents go into a
     * barrel on a grid two cells apart near the chest (open on every side), the barrel is tagged `materials` with what it holds in its label (the supply goes straight to the right one), and the
     * box is taken out of the chest. Returns { staged, sites: [names], left: boxes without room }.
     */
    async stageMaterials() {
        need(this.o.rcon, 'unpacking needs RCON (RCON_PASSWORD)', 503);
        if (this._staging) throw new Problem('unpacking is already running', 409);
        this._staging = true;
        try {
            const sources = this.sites.list().filter((q) => this.sites.withdrawable(q) && ['tools', 'materials', 'free'].includes(q.purpose)), boxes = [];
            for (const s of sources) {
                const part = await this._chestPartner(s.x, s.y, s.z);
                for (const h of [{ x: s.x, y: s.y, z: s.z }, ...(part ? [part] : [])]) for (const it of await this._readItems(h.x, h.y, h.z)) if (SHULKER.test(bare(it.id))) boxes.push({ at: h, slot: Number(it.Slot) || 0, contents: boxContents(it, true), anchor: s });
            }
            need(boxes.length, 'no shulker box in the tagged containers (tag the chest first: purpose materials, tools or free)', 409);
            need(boxes.length <= 120, 'more than 120 shulker boxes: unpack in parts');
            const t = async (x, y, z, st) => passed(await this.rcon(`execute if block ${x} ${y} ${z} ${st}`));
            const taken = new Set(), names = new Set(this.sites.list().map((q) => q.name)), sites = []; let n = 0, left = 0;
            const cellFor = async (a) => {
                const cand = []; for (let dx = -12; dx <= 12; dx += 2) for (let dz = -12; dz <= 12; dz += 2) if (Math.abs(dx) + Math.abs(dz) >= 4) cand.push([dx, dz]);
                cand.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]));
                for (const [dx, dz] of cand) for (const y of [a.y, a.y + 1, a.y - 1]) {
                    const x = a.x + dx, z = a.z + dz, k = `${x},${z}`; if (taken.has(k)) continue;
                    if (await t(x, y, z, 'minecraft:air') && await t(x, y + 1, z, 'minecraft:air') && !(await t(x, y - 1, z, '#minecraft:replaceable'))) { taken.add(k); return { x, y, z }; }
                }
                return null;
            };
            for (const b of boxes) {
                const cell = await cellFor(b.anchor); if (!cell) { left++; continue; }
                let name; do { n++; name = `mat${n}`; } while (names.has(name)); names.add(name);
                await this.rcon(`setblock ${cell.x} ${cell.y} ${cell.z} minecraft:barrel[facing=up] replace`);
                for (const c of b.contents) await this.rcon(`item replace block ${cell.x} ${cell.y} ${cell.z} container.${c.slot} with minecraft:${c.id} ${c.count}`);
                await this.rcon(`item replace block ${b.at.x} ${b.at.y} ${b.at.z} container.${b.slot} with minecraft:air`);           // the box leaves the chest: nothing is in two places
                let label = ''; for (const k of new Set(b.contents.map((c) => c.id))) { if ((label + ' ' + k).trim().length > 40) break; label = (label + ' ' + k).trim(); }          // what the barrel holds, as many kinds as fit (the supply reads it)
                b.cell = cell; b.name = name; b.label = label || "empty"; sites.push(b);
            }
            await new Promise((r) => setTimeout(r, 1500));                                                    // the bots' view of the new barrels
            const done = [];
            for (const b of sites) {
                const rec = { name: b.name, x: b.cell.x, y: b.cell.y, z: b.cell.z, purpose: 'materials', label: b.label };
                try { this.addSite(rec); } catch (_) { await new Promise((r) => setTimeout(r, 1500)); this.addSite(rec); }
                done.push(b.name);
            }
            this.note('info', `unpacked ${done.length} shulker boxes into barrels (${done[0]} ...)${left ? `, ${left} without room` : ''}`);
            return { staged: done.length, sites: done, left };
        } finally { this._staging = false; }
    }

    /**
     * What the containers bots may take from hold (every tagged container of purpose tools / materials / free / ore ...; `any` is insert-only), loose and inside shulker boxes, and the total.
     * { sources: [{ name, purpose, label, x, y, z, block, boxes, items }], total: { item: { loose, boxed } } }. Needs RCON.
     */
    async materialStock() {
        need(this.o.rcon, 'reading the containers needs RCON (RCON_PASSWORD)', 503);
        const sources = [], total = {};
        for (const s of this.sites.list().filter((q) => this.sites.withdrawable(q) && ['tools', 'materials', 'free', 'ore', 'blocks'].includes(q.purpose))) {
            const part = await this._chestPartner(s.x, s.y, s.z), halves = [{ x: s.x, y: s.y, z: s.z }, ...(part ? [part] : [])], sum = { loose: {}, boxed: {}, boxes: 0 };
            for (const h of halves) { const r = await this._readStock(h.x, h.y, h.z); sum.boxes += r.boxes; for (const k of ['loose', 'boxed']) for (const [it, n] of Object.entries(r[k])) sum[k][it] = (sum[k][it] || 0) + n; }
            const items = {}; for (const k of ['loose', 'boxed']) for (const [it, n] of Object.entries(sum[k])) { (items[it] = items[it] || { loose: 0, boxed: 0 })[k] = n; (total[it] = total[it] || { loose: 0, boxed: 0 })[k] += n; }
            sources.push({ name: s.name, purpose: s.purpose, label: s.label || '', x: s.x, y: s.y, z: s.z, block: this._blockName(s.x, s.y, s.z), double: !!part, boxes: sum.boxes, items });
        }
        return { sources, total };
    }

    /** What the placement needs against what the containers hold: { preview, rows: [{ item, need, loose, boxed, have, short }], short: n kinds }. Bots take the cell's block item (a bed is `white_bed`, water is a bucket). */
    async materialCheck(spec) {
        const preview = await this.litematicPreview(spec), stock = await this.materialStock();
        const rows = Object.entries(preview.materials).sort((a, b) => b[1] - a[1]).map(([item, n]) => {
            const t = stock.total[item] || { loose: 0, boxed: 0 }, have = t.loose + t.boxed;
            return { item, need: n, loose: t.loose, boxed: t.boxed, have, short: Math.max(0, n - have) };
        });
        return { preview: { ...preview, materials: undefined }, rows, short: rows.filter((r) => r.short > 0).length, sources: stock.sources.map((s) => ({ name: s.name, purpose: s.purpose, x: s.x, y: s.y, z: s.z, boxes: s.boxes, double: s.double })) };
    }
}

module.exports = { LitematicPart };

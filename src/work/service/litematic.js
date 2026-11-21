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

    /** One container block's items: { loose: {item: n}, boxed: {item: n}, boxes: n }, shulker boxes counted by what they hold (their `container` component). */
    async _readStock(x, y, z) {
        const out = { loose: {}, boxed: {}, boxes: 0 };
        // One reply of RCON is at most 4096 bytes and `Items` of a chest of shulker boxes is far more (live 2026-11-21: the chest read as empty), and `data get` takes no `Items[].id`:
        // one stack per request, Items[0], Items[1] ... until the server finds no element (a stack with 27 kinds inside a shulker box is about 1.5 KB).
        const at = `${x} ${y} ${z}`, items = [];
        for (let i = 0; i < 54; i++) {
            let reply; try { reply = await this.rcon(`data get block ${at} Items[${i}]`); } catch (e) { throw new Problem(`reading the container at ${at}: ${String(e.message).slice(0, 120)}`); }
            if (/no elements|Found no|does not have|has no/i.test(String(reply))) break;                                      // past the last stack (or an empty container)
            try { items.push(snbt.fromReply(reply)); } catch (e) { throw new Problem(`reading the container at ${at}, stack ${i}: ${String(e.message).slice(0, 120)}`); }
        }
        for (const s of items) {
            const id = bare(s.id), n = Number(s.count) || 1;
            if (SHULKER.test(id)) {
                out.boxes++;
                const inner = (s.components && s.components['minecraft:container']) || [];
                for (const e of Array.isArray(inner) ? inner : []) { const it = e && e.item; if (it && it.id) { const k = bare(it.id); out.boxed[k] = (out.boxed[k] || 0) + (Number(it.count) || 1); } }
            } else out.loose[id] = (out.loose[id] || 0) + n;
        }
        return out;
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

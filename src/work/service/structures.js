'use strict';
// The structure library: stored .nbt files, edits, generated parts.
// A part of WorkService (index.js copies these methods onto it).
const fs = require('fs');
const path = require('path');
const bp = require('../jobs/blueprint');
const build = require('../jobs/build');
const { Problem, need, STRUCT_NAME } = require('./common');

class StructuresPart {
    _file(name) { need(typeof name === 'string' && STRUCT_NAME.test(name), 'structure name: a-z 0-9 _ - (max 48)'); return path.join(this.o.dataDir, 'structures', `${name}.nbt`); }

    async getStructure(name) {
        const f = this._file(name);
        need(fs.existsSync(f), `no structure ${name}`, 404);
        return bp.read(fs.readFileSync(f));
    }
    structureFile(name) { const f = this._file(name); need(fs.existsSync(f), `no structure ${name}`, 404); return fs.readFileSync(f); }

    async putStructure(name, buf, { overwrite = false } = {}) {
        const f = this._file(name);
        need(overwrite || !fs.existsSync(f), `structure ${name} exists`, 409);
        const b = await bp.read(buf).catch((e) => { throw new Problem(e.message); });
        fs.writeFileSync(f, bp.write(b));                                                // normalised: gzip, our palette order
        this._dirty();
        return this._structView(name, b);
    }
    deleteStructure(name) { const f = this._file(name); need(fs.existsSync(f), `no structure ${name}`, 404); fs.rmSync(f); this._dirty(); }

    async _ops(b, ops) { try { return await bp.applyOps(b, ops, (n) => this.getStructure(n)); } catch (e) { throw e instanceof Problem ? e : new Problem(e.message); } }

    /** Apply edit steps to a stored structure; `as` stores the result under a new name (or the same one with overwrite). */
    async editStructure(name, ops, as, { overwrite = false } = {}) {
        const b = await this._ops(await this.getStructure(name), ops);
        const out = as || name;
        need(overwrite || out !== name, 'give a new name (as) or allow overwrite');
        return this.putStructure(out, bp.write(b), { overwrite: true });
    }
    /** Generated parts: a plain house, or an empty canvas to fill and merge. */
    async generate(kind, p, as) {
        try { return await this._generate(kind, p, as); } catch (e) { throw e instanceof Problem ? e : new Problem(e.message); }
    }
    async _generate(kind, p, as) {
        let b;
        if (kind === 'house') b = bp.fromCells(build.house({ w: p.w | 0 || 7, d: p.d | 0 || 7, h: p.h | 0 || 4, wall: p.wall || 'oak_planks', floor: p.floor || 'cobblestone', glass: p.glass || 'glass', door: p.door || 'oak_door' }));
        else if (kind === 'empty') b = bp.empty(p.w | 0, p.h | 0, p.d | 0);
        else if (kind === 'box') { b = bp.fill(bp.empty(p.w | 0, p.h | 0, p.d | 0), { x0: 0, y0: 0, z0: 0, x1: (p.w | 0) - 1, y1: (p.h | 0) - 1, z1: (p.d | 0) - 1 }, p.block || 'stone'); }
        else throw new Problem('kind is house, box or empty');
        return this.putStructure(as, bp.write(b));
    }
    _structView(name, b) { return { name, ...bp.stats(b, this.known ? (n) => this.known(n) : null) }; }
    async listStructures() {
        const out = [];
        for (const f of fs.readdirSync(path.join(this.o.dataDir, 'structures')).filter((x) => x.endsWith('.nbt')).sort()) {
            const name = f.slice(0, -4);
            if (!STRUCT_NAME.test(name)) continue;
            try { const s = this._structView(name, await bp.read(fs.readFileSync(path.join(this.o.dataDir, 'structures', f)))); out.push({ ...s, names: s.names.slice(0, 12) }); } catch (e) { out.push({ name, error: e.message }); }
        }
        return out;
    }
    async structureDetail(name) { return this._structView(name, await this.getStructure(name)); }
    async structureLayer(name, y) { const b = await this.getStructure(name); try { return bp.layer(b, y); } catch (e) { throw new Problem(e.message); } }
}

module.exports = { StructuresPart };

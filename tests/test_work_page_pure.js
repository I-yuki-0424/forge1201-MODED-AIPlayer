// The console page's pure parts (owner list 5 Small 3, TASK-20261125-077): what a page keeps for the next visit (ui.js Keep, KeptSet), the highest ground of an area
// (widgets.js groundTop through /api/surface), and the saved-world column the server reads for it when no bot has the chunk (world/column.js).
// The page scripts are plain browser scripts: they are run here in a vm with the few browser objects they touch at load time.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const nbt = require('prismarine-nbt');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ok ${name}`); }

/** A browser-ish context with localStorage (or one that throws, like a web view without storage) and the page scripts loaded. */
function page(files, { storage = true, api = null } = {}) {
    const store = new Map();
    const localStorage = { getItem: (k) => { if (!storage) throw new Error('denied'); return store.has(k) ? store.get(k) : null; }, setItem: (k, v) => { if (!storage) throw new Error('denied'); store.set(k, String(v)); } };
    class Element { append() {} prepend() {} replaceChildren() {} }
    const ctx = { localStorage, Element, console, setTimeout, clearTimeout, setInterval: () => 0, URL, window: {}, document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}) } };
    vm.createContext(ctx);
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'work', f), 'utf8'), ctx, { filename: f });
    if (api) vm.runInContext('api = __api', Object.assign(ctx, { __api: api }));
    return { ctx, store, run: (code) => vm.runInContext(code, ctx) };
}

(async () => {
    await test('Keep: a value comes back; a KeptSet keeps its members; without storage nothing breaks and nothing is kept', () => {
        const p = page(['ui.js']);
        p.run("Keep.set('pits.x0', '12'); Keep.set('bots.focus', 'Work3')");
        assert.strictEqual(p.run("Keep.get('pits.x0')"), '12'); assert.strictEqual(p.run("Keep.get('nothing', 'd')"), 'd');
        p.run("var s = new KeptSet('pits.bots'); s.add('Work1'); s.add('Work2'); s.delete('Work1')");
        assert.deepStrictEqual(JSON.parse(p.store.get('wc_keep_pits.bots')), ['Work2']);
        assert.strictEqual(p.run("JSON.stringify([...new KeptSet('pits.bots')])"), '["Work2"]', 'a new page load finds the ticked bots again');
        const q = page(['ui.js'], { storage: false });
        q.run("Keep.set('a', 1); var t = new KeptSet('b'); t.add('x')");
        assert.strictEqual(q.run("Keep.get('a', 'none')"), 'none'); assert.strictEqual(q.run('t.size'), 1, 'the set still works in memory');
    });

    await test('Keep.fields: a field gets its last value back (a select only to an option it has) and saves every change', () => {
        const p = page(['ui.js']);
        const listeners = {}, input = { type: 'number', value: '', tagName: 'INPUT', addEventListener: (e, f) => { listeners[e] = f; } };
        const sel = { type: 'select-one', value: 'expert', tagName: 'SELECT', options: [{ value: 'expert' }, { value: 'sweep' }], addEventListener() {} };
        const box = { type: 'checkbox', checked: false, tagName: 'INPUT', addEventListener() {} };
        p.store.set('wc_keep_pits.top', '"70"'); p.store.set('wc_keep_pits.method', '"gone"'); p.store.set('wc_keep_pits.road', 'true');
        p.ctx.__els = { top: input, method: sel, road: box }; p.run('Keep.fields("pits", __els)');
        assert.strictEqual(input.value, '70'); assert.strictEqual(sel.value, 'expert', 'an option the page no longer has is not forced in'); assert.strictEqual(box.checked, true);
        input.value = '64'; listeners.change(); assert.strictEqual(p.store.get('wc_keep_pits.top'), '"64"');
    });

    await test('groundTop: the highest answer over a grid of the area, in the dimension asked; no answer at all is an error with the reasons', async () => {
        const asked = [];
        const api = async (m, u) => { asked.push(u); const q = new URL(u, 'http://x').searchParams, x = Number(q.get('x')); return x > 105 ? { y: null, why: 'chunk not loaded' } : { y: 60 + (x - 100), block: 'stone' }; };
        const p = page(['ui.js', 'blockcolor.js', 'map.js', 'widgets.js'], { api });
        assert.strictEqual(await p.run("groundTop({ x0: 100, x1: 108, z0: 0, z1: 8 }, 'nether')"), 64, 'x 100..104 answer (grid 100, 102, 104, 106, 108); the highest is at x 104');
        assert.ok(asked.length >= 9 && asked.length <= 25 && asked.every((u) => u.includes('&dim=nether')), asked.join(' '));
        p.ctx.__api = async () => ({ y: null, why: 'no bot has that chunk loaded' }); p.run('api = __api');
        await assert.rejects(p.run("groundTop({ x0: 0, x1: 0, z0: 0, z1: 0 }, 'overworld')"), /no ground found \(no bot has that chunk loaded\)/);
    });

    await test('column: the top ground block of a saved chunk, past leaves, plants and water; null where nothing was generated', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcol-'));
        const longs = (entries, bits) => {                       // palette indices of 4096 blocks -> [hi, lo] longs, as prismarine-nbt reads them
            const per = Math.floor(64 / bits), out = [];
            for (let i = 0; i < 4096; i += per) { let hi = 0, lo = 0; for (let k = 0; k < per && i + k < 4096; k++) { const v = BigInt(entries[i + k] || 0) << BigInt(k * bits); lo = Number((BigInt(lo >>> 0) | (v & 0xffffffffn)) & 0xffffffffn) | 0; hi = Number((BigInt(hi >>> 0) | (v >> 32n)) & 0xffffffffn) | 0; } out.push([hi, lo]); }
            return out;
        };
        const sec = (y, palette, entries) => ({ Y: nbt.byte(y), block_states: nbt.comp({ palette: nbt.list(nbt.comp(palette.map((n) => ({ Name: nbt.string(n) })))), ...(entries ? { data: nbt.longArray(longs(entries, 4)) } : {}) }) });
        const top = new Array(4096).fill(0); const at = (x, y, z) => (y * 16 + z) * 16 + x;
        top[at(3, 0, 5)] = 1; top[at(3, 1, 5)] = 2; top[at(3, 2, 5)] = 3;           // at x 3 z 5 of section 5: dirt at y 80, then grass and leaves above it
        top[at(7, 0, 7)] = 4;                                                        // water at y 80 on x 7 z 7
        const chunk = nbt.comp({ sections: nbt.list(nbt.comp([sec(4, ['minecraft:stone']), sec(5, ['minecraft:air', 'minecraft:dirt', 'minecraft:short_grass', 'minecraft:oak_leaves', 'minecraft:water'], top)])) });
        const raw = zlib.deflateSync(nbt.writeUncompressed(chunk, 'big')), body = Buffer.alloc(5 + raw.length); body.writeInt32BE(raw.length + 1, 0); body[4] = 2; raw.copy(body, 5);
        const sectors = Math.ceil(body.length / 4096), file = Buffer.alloc(8192 + sectors * 4096); body.copy(file, 8192);
        const idx = (1 & 31) + (2 & 31) * 32; file.writeUIntBE(2, idx * 4, 3); file[idx * 4 + 3] = sectors;      // chunk (1, 2) of region 0,0
        fs.writeFileSync(path.join(dir, 'r.0.0.mca'), file);
        const col = require('../src/work/world/column');
        assert.deepStrictEqual(col.topAt(dir, 16 + 3, 32 + 5), { y: 80, block: 'minecraft:dirt' }, 'dirt under grass and leaves');
        assert.deepStrictEqual(col.topAt(dir, 16 + 7, 32 + 7), { y: 79, block: 'minecraft:stone' }, 'the bed under water');
        assert.deepStrictEqual(col.topAt(dir, 16, 32), { y: 79, block: 'minecraft:stone' });
        assert.strictEqual(col.topAt(dir, 0, 0), null, 'a chunk that was never saved'); assert.strictEqual(col.topAt(dir, 5000, 5000), null, 'no region file');
        assert.ok(col.ground('minecraft:grass_block') && col.ground('minecraft:snow_block') && !col.ground('minecraft:snow') && !col.ground('minecraft:spruce_log') && !col.ground('minecraft:poppy'));
    });

    console.log(`test_work_page_pure: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });

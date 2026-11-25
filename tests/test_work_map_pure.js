// The map store keeps the last complete picture of a region when a read catches the server in the middle of saving it (black squares otherwise).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MapStore } = require('../src/work/world/maps');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

(async () => {
    await test('region: fewer chunks than before (a file being written) is read again; still short and just written = the last complete picture; later complete = the new one', async () => {
        const w = fs.mkdtempSync(path.join(os.tmpdir(), 'map-')); fs.mkdirSync(path.join(w, 'region'));
        const file = path.join(w, 'region', 'r.0.0.mca'); fs.writeFileSync(file, Buffer.alloc(16));
        const store = new MapStore(w); assert.ok(store.available);
        const script = [];                                                           // what the worker answers, in order
        const pic = (chunks, tag) => ({ names: [tag], idx: new Uint8Array([chunks]), h: new Uint8Array([chunks]), chunks });
        let calls = 0;
        store._worker = () => ({ postMessage: ({ id }) => { calls++; const r = script.shift(); setImmediate(() => store.pending.get(id).resolve({ id, ...r })); } });
        const bump = () => { const t = new Date(Date.now() + (bump.n = (bump.n || 0) + 1) * 1000); fs.utimesSync(file, t, t); };
        script.push(pic(5, 'full')); const a = await store.region('overworld', 0, 0); assert.strictEqual(a.chunks, 5);
        bump(); script.push(pic(3, 'torn'), pic(3, 'torn'));                         // torn twice, file just written
        const b = await store.region('overworld', 0, 0); assert.strictEqual(b.chunks, 5, 'the complete picture stays'); assert.strictEqual(b.names[0], 'full'); assert.strictEqual(calls, 3, 'read, read again');
        bump(); script.push(pic(3, 'torn'), pic(5, 'full2'));                        // torn once, the second read is complete
        const c = await store.region('overworld', 0, 0); assert.strictEqual(c.names[0], 'full2'); assert.strictEqual(c.chunks, 5);
        bump(); script.push(pic(7, 'more'));                                         // the world grew
        const d = await store.region('overworld', 0, 0); assert.strictEqual(d.chunks, 7); assert.strictEqual(calls, 6);
        store.close(); fs.rmSync(w, { recursive: true });
    });
    await test('world layouts: the classic one (1.21.1: region, DIM-1/region) and the one of 26.x (dimensions/minecraft/<dim>/region) are both read, no symlinked view needed', () => {
        const w = fs.mkdtempSync(path.join(os.tmpdir(), 'map-'));
        for (const d of ['overworld', 'the_nether', 'the_end']) { fs.mkdirSync(path.join(w, 'dimensions', 'minecraft', d, 'region'), { recursive: true }); fs.writeFileSync(path.join(w, 'dimensions', 'minecraft', d, 'region', 'r.1.2.mca'), Buffer.alloc(9000)); }
        const s26 = new MapStore(w); assert.ok(s26.available, '26.x layout is a world');
        for (const d of ['overworld', 'nether', 'end']) assert.deepStrictEqual(s26.index(d).map((r) => [r.rx, r.rz]), [[1, 2]], d);
        const c = fs.mkdtempSync(path.join(os.tmpdir(), 'map-'));
        fs.mkdirSync(path.join(c, 'region')); fs.mkdirSync(path.join(c, 'DIM-1', 'region'), { recursive: true });
        fs.writeFileSync(path.join(c, 'region', 'r.0.0.mca'), Buffer.alloc(9000)); fs.writeFileSync(path.join(c, 'DIM-1', 'region', 'r.-1.0.mca'), Buffer.alloc(9000));
        const s121 = new MapStore(c); assert.ok(s121.available, 'classic layout is a world');
        assert.deepStrictEqual(s121.index('overworld').map((r) => [r.rx, r.rz]), [[0, 0]]);
        assert.deepStrictEqual(s121.index('nether').map((r) => [r.rx, r.rz]), [[-1, 0]]);
        assert.deepStrictEqual(s121.index('end'), [], 'a dimension never visited: no regions');
        assert.ok(!new MapStore(fs.mkdtempSync(path.join(os.tmpdir(), 'map-'))).available, 'an empty folder is no world');
        fs.rmSync(w, { recursive: true }); fs.rmSync(c, { recursive: true });
    });
    console.log('\nwork map: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

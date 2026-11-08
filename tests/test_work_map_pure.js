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
    console.log('\nwork map: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

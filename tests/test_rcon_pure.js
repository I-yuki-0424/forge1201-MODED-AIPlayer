'use strict';
// The RCON client against a local fake of the vanilla server: replies split into parts of 4096 characters, one packet read per request, "Unknown request" for other types.
const net = require('net');
const assert = require('assert');
const { Rcon, encode, decode } = require('../src/rl/rcon');

function fakeServer(reply) {
    const srv = net.createServer((sock) => {
        let rest = Buffer.alloc(0);
        sock.on('data', (d) => {
            // vanilla reads one packet per read; two packets in one read = a broken stream (it closes)
            const [packets, r] = decode(Buffer.concat([rest, d])); rest = r;
            if (packets.length > 1) { sock.destroy(); return; }
            for (const p of packets) {
                if (p.type === 3) { sock.write(encode(p.id, 2, '')); continue; }
                if (p.type === 2) { const text = reply(p.body); for (let i = 0; i < Math.max(1, text.length); i += 4096) sock.write(encode(p.id, 0, text.slice(i, i + 4096))); continue; }
                sock.write(encode(p.id, 0, `Unknown request ${p.type.toString(16)}`));
            }
        });
    });
    return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv)));
}

(async () => {
    let passed = 0;
    const long = 'x'.repeat(4096) + '"' + 'y'.repeat(9000) + '"', exact = 'z'.repeat(4096);
    const srv = await fakeServer((cmd) => (cmd === 'long' ? long : cmd === 'exact' ? exact : `echo ${cmd}`));
    const r = new Rcon({ host: '127.0.0.1', port: srv.address().port, password: 'p', timeoutMs: 3000 });
    await r.connect();
    assert.strictEqual(await r.command('a'), 'echo a'); passed++;
    assert.strictEqual(await r.command('long'), long, 'a reply over several packets comes back whole'); passed++;
    assert.strictEqual(await r.command('exact'), exact, 'a reply of exactly one full packet ends at the marker'); passed++;
    for (let i = 0; i < 20; i++) assert.strictEqual(await r.command(i % 2 ? 'long' : `c${i}`), i % 2 ? long : `echo c${i}`);
    passed++;                                                                                   // the stream stays in step (the connection was closed after long replies, 2026-11-22)
    r.close(); srv.close();
    console.log(`test_rcon_pure: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });

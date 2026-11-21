'use strict';
// The Syncmatica client's wire format (src/transport/syncmatica.js). The golden packets were captured from a real Syncmatica 0.3.20 server on Fabric 26.1.2
// (fabric26-survival-op, 2026-11-17, the owner's shared placement "easy-ironfarm"), so the codec is checked against the mod, not against itself.
const assert = require('assert');
const sm = require('../src/transport/syncmatica');
const FEATURES = new Set(sm.FEATURES);

// register_version / feature_request / confirm_user as the server sent them
const REGISTER_VERSION = '1b73796e636d61746963613a72656769737465725f76657273696f6e06302e332e3230';
const FEATURE_REQUEST = '1a73796e636d61746963613a666561747572655f72657175657374';
const CONFIRM_USER = '1773796e636d61746963613a636f6e6669726d5f75736572000000018452b188941f487aa5dbc4c2a9cbf32217656173792d69726f6e6661726d2e6c6974656d617469631552a91f5d863592bcb08d688ffa424c0d656173792d69726f6e6661726d734c8e1006c737ad99716f79965693a106536569615f59734c8e1006c737ad99716f79965693a106536569615f59079f2700004fc0000f7041136d696e6563726166743a6f766572776f726c64000000000000000000000000';

{   // decode
    const a = sm.decode(Buffer.from(REGISTER_VERSION, 'hex')); assert.strictEqual(a.type, 'register_version'); assert.strictEqual(new sm.Reader(a.body).utf(), '0.3.20');
    assert.strictEqual(sm.decode(Buffer.from(FEATURE_REQUEST, 'hex')).type, 'feature_request');
    const c = sm.decode(Buffer.from(CONFIRM_USER, 'hex')); assert.strictEqual(c.type, 'confirm_user');
    const r = new sm.Reader(c.body); assert.strictEqual(r.int(), 1);
    const p = sm.readMetadata(r, FEATURES);
    assert.strictEqual(r.left(), 0, 'the metadata is read to its last byte');
    assert.deepStrictEqual({ ...p }, { id: '8452b188-941f-487a-a5db-c4c2a9cbf322', fileName: 'easy-ironfarm.litematic', hash: '1552a91f-5d86-3592-bcb0-8d688ffa424c', name: 'easy-ironfarm',
        owner: '734c8e10-06c7-37ad-9971-6f79965693a1', ownerName: 'Seia_Y', lastModifiedBy: '734c8e10-06c7-37ad-9971-6f79965693a1', lastModifiedName: 'Seia_Y', litematicVersion: 7, dataVersion: 5023,
        pos: { x: 319, y: 65, z: 247 }, dimension: 'minecraft:overworld', rotation: 'NONE', mirror: 'NONE', subRegions: [] });
    // and the writer produces the very same bytes
    assert.strictEqual(sm.writeMetadata(p, FEATURES).toString('hex'), CONFIRM_USER.slice(CONFIRM_USER.indexOf('8452b188')));
    assert.strictEqual(sm.encode('register_version', new sm.Writer().utf('0.3.20').done()).toString('hex'), REGISTER_VERSION);
}
{   // block positions: signed, packed 26/26/12
    for (const p of [{ x: 0, y: 0, z: 0 }, { x: 319, y: 65, z: 247 }, { x: -1, y: -64, z: -1 }, { x: -30000000, y: 2047, z: 29999999 }, { x: 5, y: -2048, z: -7 }]) assert.deepStrictEqual(sm.unpackPos(sm.packPos(p)), p);
}
{   // hash: UUID.nameUUIDFromBytes(md5(file)) of the downloaded file of that placement (a fixed pattern here; the live probe checked it against the server)
    const h = sm.hashOf(Buffer.from('hello')); assert.match(h, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}
{   // a full session against a scripted server: handshake, list, download in chunks with acks, hash check, then a share
    const sent = []; const c = new sm.SyncmaticaClient({}, { send: (b) => sent.push(sm.decode(b)) });
    c.receive(Buffer.from(REGISTER_VERSION, 'hex')); assert.strictEqual(sent.pop().type, 'register_version');
    c.receive(Buffer.from(FEATURE_REQUEST, 'hex')); const f = sent.pop(); assert.strictEqual(f.type, 'feature'); assert.ok(new sm.Reader(f.body).utf().split('\n').includes('CORE_EX'));
    let ready = 0; c.on('ready', () => ready++);
    c.receive(Buffer.from(CONFIRM_USER, 'hex')); assert.strictEqual(ready, 1); assert.strictEqual(c.placements.size, 1);
    const id = [...c.placements.keys()][0], file = Buffer.alloc(40000, 7);
    c.placements.get(id).hash = sm.hashOf(file);
    const p = c.fetch(id); assert.strictEqual(sent.pop().type, 'request_download');
    for (let o = 0; o < file.length; o += sm.CHUNK) {
        const part = file.subarray(o, o + sm.CHUNK);
        c.receive(sm.encode('send_litematic', new sm.Writer().uuid(id).int(part.length).bytes(part).done()));
        assert.strictEqual(sent.pop().type, 'received_litematic');
    }
    c.receive(sm.encode('finished_litematic', new sm.Writer().uuid(id).done()));
    p.then((got) => { assert.ok(got.equals(file)); return null; }).then(() => {
        // wrong hash is refused
        c.placements.get(id).hash = '00000000-0000-3000-8000-000000000000';
        const q = c.fetch(id); sent.pop();
        c.receive(sm.encode('send_litematic', new sm.Writer().uuid(id).int(3).bytes(Buffer.from([1, 2, 3])).done())); sent.pop();
        c.receive(sm.encode('finished_litematic', new sm.Writer().uuid(id).done()));
        return q.then(() => assert.fail('a hash mismatch must reject'), (e) => assert.match(e.message, /hash mismatch/));
    }).then(() => {
        // share: metadata out, the server asks for the file, chunks go out one per ack, then the finish
        const data = Buffer.alloc(sm.CHUNK + 10, 9);
        const s = c.share({ file: data, name: 'x', pos: { x: 1, y: 2, z: 3 }, owner: '00000000-0000-0000-0000-000000000001', ownerName: 'Bot' });
        const m = sent.pop(); assert.strictEqual(m.type, 'register_metadata');
        const meta = sm.readMetadata(new sm.Reader(m.body), FEATURES); assert.strictEqual(meta.hash, sm.hashOf(data)); assert.deepStrictEqual(meta.pos, { x: 1, y: 2, z: 3 });
        c.receive(sm.encode('request_download', new sm.Writer().uuid(meta.id).done()));
        const c1 = sent.pop(); assert.strictEqual(c1.type, 'send_litematic'); assert.strictEqual(new sm.Reader(c1.body.subarray(16)).int(), sm.CHUNK);
        c.receive(sm.encode('received_litematic', new sm.Writer().uuid(meta.id).done()));
        const c2 = sent.pop(); assert.strictEqual(new sm.Reader(c2.body.subarray(16)).int(), 10);
        c.receive(sm.encode('received_litematic', new sm.Writer().uuid(meta.id).done()));
        assert.strictEqual(sent.pop().type, 'finished_litematic');
        return s;
    }).then(() => {
        // garbage never throws out of receive()
        c.receive(Buffer.from([1, 2, 3])); c.receive(sm.encode('modify', Buffer.from([0]))); c.receive(Buffer.alloc(0));
        console.log('syncmatica client: ok');
    }).catch((e) => { console.error(e); process.exit(1); });
}

// the service side: list and build from a placement (stubs for the bot and for _buildFrom)
(async () => {
    const { JobsPart } = require('../src/work/service/jobs');
    const fs = require('fs'), path = require('path');
    const file = fs.readFileSync(path.join(__dirname, 'fixtures/easy-ironfarm-fixd.litematic'));
    const c = new sm.SyncmaticaClient({}, { send: () => {} });
    c.ready = true;
    c.placements.set('p1', { id: 'p1', name: 'easy-ironfarm', fileName: 'easy-ironfarm.litematic', ownerName: 'Seia_Y', lastModifiedName: 'Seia_Y', pos: { x: 100, y: 70, z: 200 }, dimension: 'minecraft:overworld', rotation: 'NONE', mirror: 'NONE', subRegions: [], hash: sm.hashOf(file) });
    c.fetch = async () => file;
    let got = null;
    const svc = Object.assign(Object.create(JobsPart.prototype), { bots: new Map([['B', { bot: { syncmatica: c } }]]), _dimSpec: () => ({ dim: 'overworld' }), _buildFrom: async (bp, origin, spec, st, extra) => { got = { bp, origin, spec, extra }; return { id: 'j1' }; } });
    const list = svc.syncPlacements('B'); assert.strictEqual(list.length, 1); assert.strictEqual(list[0].owner, 'Seia_Y');
    assert.throws(() => svc.syncPlacements('nobody'), /no Syncmatica list/);
    await svc.createBuildFromPlacement({ placement: 'p1', bots: ['B'], start: true });
    assert.deepStrictEqual(got.origin, { x: 100 - 22, y: 70 - 1, z: 200 - 20 }, 'the box minimum is the placement origin plus the region offset');
    assert.strictEqual(got.spec.tile, 64); assert.deepStrictEqual(got.bp.size, [45, 23, 46]);
    await assert.rejects(svc.createBuildFromPlacement({ placement: 'nope' }), /no placement/);
    // the new builder (construct) for a creative crew: the file and the placement go through unchanged; its target box starts at the same corner
    let cons = null;
    svc.createConstruct = (sp) => { cons = sp; return { id: 'j2' }; };
    await svc.createBuildFromPlacement({ placement: 'p1', bots: ['B'], start: true, builder: 'construct' });
    assert.deepStrictEqual(cons.placement, { pos: { x: 100, y: 70, z: 200 }, rotation: 'NONE', mirror: 'NONE' });
    const { targetOf } = require('../src/work/service/construct');
    const tb = targetOf(cons.file, cons.placement).target.box;
    assert.deepStrictEqual({ x: tb.x, y: tb.y, z: tb.z }, { x: 100 - 22, y: 70 - 1, z: 200 - 20 });
    svc.bots.get('B').bot.game = { gameMode: 'creative' }; assert.strictEqual(svc._builderFor({ bots: ['B'] }), 'construct');
    svc.bots.get('B').bot.game = { gameMode: 'survival' }; assert.strictEqual(svc._builderFor({ bots: ['B'] }), 'legacy');
    console.log('syncmatica service: ok');
})().catch((e) => { console.error(e); process.exit(1); });

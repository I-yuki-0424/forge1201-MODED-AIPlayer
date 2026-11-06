// Console backend features without a server: SNBT parsing of `data get` replies, inventory reads and moves through a fake console,
// the region reader on a synthetic Anvil file, Cloudflare Access JWT verification (own RSA key), per-bot commands, and the new routes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const nbt = require('prismarine-nbt');
require('../src/transport/forge_bot').applyProtocolBypasses();
const snbt = require('../src/work/world/snbt');
const inv = require('../src/work/operator/inventory');
const { readRegion } = require('../src/work/world/mca');
const { Access } = require('../src/work/web/access');
const { WorkService } = require('../src/work/service');
const { createConsole, loadToken } = require('../src/work/console');
const { catalog } = require('../src/work/operator/catalog');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } }
const rejects = (p, status, re) => assert.rejects(Promise.resolve(p), (e) => { if (status) assert.strictEqual(e.status, status, `${e.status}: ${e.message}`); if (re) assert.match(e.message, re); return true; });

/** A console that knows two players (one is a bot) and one chest: just enough of `data get` and `item replace`. */
function fakeServer() {
    const ents = { Seia_Y: [{ Slot: 0, id: 'minecraft:diamond_pickaxe', Count: 1, tag: { Damage: 12 } }, { Slot: 9, id: 'minecraft:cobblestone', Count: 64 }], Bot1: [] };
    const chest = [{ Slot: 0, id: 'minecraft:oak_log', Count: 32 }, { Slot: 5, id: 'minecraft:iron_ingot', Count: 7, tag: { display: { Name: '{"text":"Special"}' } } }];
    const log = [];
    const slotOf = (n) => (/^hotbar\.(\d)$/.test(n) ? +RegExp.$1 : /^inventory\.(\d+)$/.test(n) ? +RegExp.$1 + 9 : /^container\.(\d+)$/.test(n) ? +RegExp.$1 : null);
    const list = (ref) => (ref.startsWith('entity ') ? ents[ref.slice(7)] : ref === 'block 10 64 20' ? chest : null);
    const fmt = (v) => (typeof v === 'string' && /^-?\d+b$/.test(v) ? v : typeof v === 'string' ? JSON.stringify(v).replace(/^"|"$/g, '"') : Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${k}: ${fmt(x)}`).join(', ')}}` : String(v));
    const run = async (cmd) => {
        log.push(cmd);
        let m;
        if ((m = /^data get entity (\w+) Inventory$/.exec(cmd))) return ents[m[1]] ? `${m[1]} has the following entity data: ${fmt(ents[m[1]].map((s) => ({ Slot: `${s.Slot}b`, id: s.id, Count: `${s.Count}b`, ...(s.tag ? { tag: s.tag } : {}) })))}` : 'No entity was found';
        if ((m = /^data get block (-?\d+) (-?\d+) (-?\d+) id$/.exec(cmd))) return +m[1] === 10 && +m[2] === 64 && +m[3] === 20 ? 'Block at 10, 64, 20 has the following block data: "minecraft:chest"' : 'The target block is not a block entity';
        if ((m = /^data get block 10 64 20 Items$/.exec(cmd))) return `Block at 10, 64, 20 has the following block data: ${fmt(chest.map((s) => ({ Slot: `${s.Slot}b`, id: s.id, Count: `${s.Count}b`, ...(s.tag ? { tag: s.tag } : {}) })))}`;
        if ((m = /^item replace (entity \w+|block -?\d+ -?\d+ -?\d+) (\S+) from (entity \w+|block -?\d+ -?\d+ -?\d+) (\S+)$/.exec(cmd))) {
            const [, d, ds, s, ss] = m, src = list(s), dst = list(d), si = slotOf(ss), di = slotOf(ds);
            const item = src && src.find((x) => x.Slot === si); if (!item || !dst) return 'Could not set the slot';
            dst.push({ ...item, Slot: di }); return `Replaced a slot on ${d} with ${item.id}`;
        }
        if ((m = /^item replace (entity \w+|block -?\d+ -?\d+ -?\d+) (\S+) with minecraft:air$/.exec(cmd))) {
            const l = list(m[1]), i = l.findIndex((x) => x.Slot === slotOf(m[2]) && !x.moved); if (i >= 0) l.splice(i, 1); return `Replaced a slot on ${m[1]} with Air`;
        }
        return `Unknown command ${cmd}`;
    };
    return { run, ents, chest, log };
}

(async () => {
    await test('SNBT: types, strings, nested compounds, typed arrays, refusals', () => {
        assert.deepStrictEqual(snbt.parse('{a: 1b, b: -2s, c: 3, d: 4L, e: 1.5f, f: 2.0d, g: true, h: "x\\"y", i: \'it\', j: [1, 2], k: [I; 1, 2], l: {m: {}}, "q r": 1}'), { a: 1, b: -2, c: 3, d: 4, e: 1.5, f: 2, g: true, h: 'x"y', i: 'it', j: [1, 2], k: [1, 2], l: { m: {} }, 'q r': 1 });
        assert.deepStrictEqual(snbt.fromReply('\x1b[0mSeia_Y has the following entity data: [{Slot: 0b}]'), [{ Slot: 0 }]);
        assert.throws(() => snbt.fromReply('No entity was found'), /No entity/);
        assert.throws(() => snbt.parse('{a: [1, 2'), /snbt/); assert.throws(() => snbt.parse('{a: 1} extra'), /trailing/);
        assert.throws(() => snbt.parse('['.repeat(60)), /too deep/);
    });

    await test('inventory: read a player and a container, quick move into a free slot, move to a chosen slot, refuse an occupied one, take all', async () => {
        const s = fakeServer();
        const me = await inv.read(s.run, { type: 'entity', name: 'Seia_Y' });
        assert.deepStrictEqual(me.slots.map((x) => [x.slot, x.id, x.count]), [[0, 'minecraft:diamond_pickaxe', 1], [9, 'minecraft:cobblestone', 64]]); assert.strictEqual(me.slots[0].damage, 12);
        const ch = await inv.read(s.run, { type: 'block', x: 10, y: 64, z: 20 });
        assert.strictEqual(ch.kind, 'container'); assert.strictEqual(ch.size, 27); assert.strictEqual(ch.slots[1].label, 'Special');
        const r = await inv.move(s.run, { type: 'block', x: 10, y: 64, z: 20 }, 5, { type: 'entity', name: 'Seia_Y' });
        assert.deepStrictEqual(r.moved, { id: 'minecraft:iron_ingot', count: 7 }); assert.strictEqual(r.to, 1);                       // first free slot of the player: hotbar 1
        assert.ok(s.log.some((c) => c === 'item replace entity Seia_Y hotbar.1 from block 10 64 20 container.5'));
        assert.ok(s.log.some((c) => c === 'item replace block 10 64 20 container.5 with minecraft:air'));
        await inv.move(s.run, { type: 'entity', name: 'Seia_Y' }, 9, { type: 'block', x: 10, y: 64, z: 20 }, 13);
        assert.ok(s.log.some((c) => c === 'item replace block 10 64 20 container.13 from entity Seia_Y inventory.0'));
        await assert.rejects(inv.move(s.run, { type: 'block', x: 10, y: 64, z: 20 }, 0, { type: 'entity', name: 'Seia_Y' }, 0), /occupied/);
        await assert.rejects(inv.move(s.run, { type: 'block', x: 10, y: 64, z: 20 }, 22, { type: 'entity', name: 'Bot1' }), /empty/);
        const all = await inv.moveAll(s.run, { type: 'block', x: 10, y: 64, z: 20 }, { type: 'entity', name: 'Bot1' });
        assert.ok(all.moved.length >= 2 && !all.stopped, JSON.stringify(all));
        for (const bad of [{ type: 'entity', name: 'a b; op x' }, { type: 'block', x: 1.5, y: 0, z: 0 }, { type: 'block', x: 'a', y: 0, z: 0 }, null]) await assert.rejects(inv.read(s.run, bad), /target|integer/);
        assert.throws(() => inv.slotName({ type: 'entity', name: 'A' }, 77), /no such player slot/);
        assert.strictEqual(inv.slotName({ type: 'entity', name: 'A' }, 103), 'armor.head'); assert.strictEqual(inv.slotName({ type: 'entity', name: 'A' }, -106), 'weapon.offhand');
    });

    await test('region reader: a synthetic Anvil file gives the top block per column, biomes of height and palette indexes', () => {
        // One chunk (0,0): section Y=0 holds stone below y=5 and water at y=5 for x<8; MOTION_BLOCKING height says y=5 (value 6 + minY 0 ... world minY 0 here).
        const bits = 4, per = Math.floor(64 / bits), idxs = new Array(4096).fill(0);
        for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) idxs[(y * 16 + z) * 16 + x] = y < 5 ? 0 : y === 5 ? (x < 8 ? 1 : 0) : 2;
        const longs = []; for (let l = 0; l * per < 4096; l++) { let v = 0n; for (let k = 0; k < per && l * per + k < 4096; k++) v |= BigInt(idxs[l * per + k]) << BigInt(k * bits); longs.push([Number((v >> 32n) & 0xffffffffn) | 0, Number(v & 0xffffffffn) | 0]); }
        const hb = 5, hper = Math.floor(64 / hb), hl = []; for (let l = 0; l * hper < 256; l++) { let v = 0n; for (let k = 0; k < hper && l * hper + k < 256; k++) v |= 6n << BigInt(k * hb); hl.push([Number((v >> 32n) & 0xffffffffn) | 0, Number(v & 0xffffffffn) | 0]); }
        const tag = nbt.comp({
            Status: nbt.string('minecraft:full'), yPos: nbt.int(0), xPos: nbt.int(0), zPos: nbt.int(0),
            Heightmaps: nbt.comp({ MOTION_BLOCKING: nbt.longArray(hl) }),
            sections: nbt.list(nbt.comp([{ Y: nbt.byte(0), block_states: nbt.comp({ palette: nbt.list(nbt.comp([{ Name: nbt.string('minecraft:stone') }, { Name: nbt.string('minecraft:water') }, { Name: nbt.string('minecraft:air') }])), data: nbt.longArray(longs) }) }])),
        }, '');
        const body = zlib.deflateSync(nbt.writeUncompressed(tag, 'big')), hdr = Buffer.alloc(8192), chunk = Buffer.alloc(Math.ceil((body.length + 5) / 4096) * 4096);
        chunk.writeInt32BE(body.length + 1, 0); chunk[4] = 2; body.copy(chunk, 5); hdr.writeUIntBE((2 << 8) | (chunk.length / 4096), 0, 4);
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mca-')), 'r.0.0.mca'); fs.writeFileSync(f, Buffer.concat([hdr, chunk]));
        const r = readRegion(f);
        assert.strictEqual(r.chunks, 1); assert.strictEqual(r.skipped, 0);
        const at = (x, z) => r.names[r.idx[z * 512 + x] - 1];
        assert.strictEqual(at(0, 0), 'minecraft:water'); assert.strictEqual(at(7, 3), 'minecraft:water'); assert.strictEqual(at(8, 0), 'minecraft:stone'); assert.strictEqual(r.idx[20 * 512 + 20], 0, 'other chunks stay unknown');
        assert.strictEqual(r.h[0], (5 + 64) >> 1);
        const good = fs.readFileSync(f); fs.writeFileSync(f, Buffer.alloc(100)); assert.strictEqual(readRegion(f).chunks, 0);               // a truncated file is not an error
        fs.writeFileSync(f, good);
    });

    await test('Cloudflare Access: signature, issuer, audience, expiry and e-mail are all checked', async () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
        let now = 1_800_000_000_000, fetched = 0;
        const acc = new Access({ team: 'team.cloudflareaccess.com', aud: 'AUD1', emails: ['Owner@Example.com'] }, { getKeys: async () => { fetched++; return { keys: [jwk] }; }, now: () => now });
        const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
        const sign = (claims, kid = 'k1', key = privateKey) => { const h = b64u({ alg: 'RS256', kid }), b = b64u(claims), s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), key).toString('base64url'); return `${h}.${b}.${s}`; };
        const good = { iss: 'https://team.cloudflareaccess.com', aud: ['AUD1'], email: 'owner@example.com', exp: now / 1000 + 3600 };
        assert.deepStrictEqual(await acc.verify(sign(good)), { email: 'owner@example.com' });
        assert.strictEqual(fetched, 1);
        for (const [what, tok] of [['expired', sign({ ...good, exp: now / 1000 - 1 })], ['wrong audience', sign({ ...good, aud: ['x'] })], ['wrong issuer', sign({ ...good, iss: 'https://evil.cloudflareaccess.com' })], ['other e-mail', sign({ ...good, email: 'mallory@example.com' })],
            ['no e-mail', sign({ ...good, email: undefined })], ['bad signature', sign(good, 'k1', crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)], ['unknown key id', sign(good, 'nope')], ['garbage', 'a.b.c'], ['alg none', `${b64u({ alg: 'none', kid: 'k1' })}.${b64u(good)}.`], ['empty', ''], [undefined, undefined]]) {
            if (what) assert.strictEqual(await acc.verify(tok), null, what);
        }
        assert.strictEqual(fetched, 1, 'an unknown key id refreshes the keys at most once a minute');
    });

    // ---- service and routes
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfeat-')), srv = fakeServer(), worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-'));
    fs.mkdirSync(path.join(worldDir, 'region'));
    fs.copyFileSync(path.join(os.tmpdir(), fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('mca-')).pop(), 'r.0.0.mca'), path.join(worldDir, 'region', 'r.0.0.mca'));
    const chats = [], calls = [];
    const factory = (name) => {
        const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: { x: 1, y: 70, z: 2, distanceTo: () => 3 } }, entities: { 7: { id: 7, name: 'zombie', type: 'hostile', position: { x: 4, y: 70, z: 4, distanceTo: () => 5.5 } } }, health: 20, food: 20,
            inventory: { items: () => [], slots: [], emptySlotCount: () => 30 }, findBlocks: () => [{ x: 10, y: 64, z: 20 }], blockAt: () => ({ name: 'chest' }), chat: (t) => chats.push([name, t]), quit() {} }); setTimeout(() => b.emit('spawn'), 5); return b;
    };
    const svc = new WorkService({ dataDir: dir, worldDir, factory, envFactory: () => ({}), rcon: { command: async (c) => (c === 'list' ? 'There are 1 of a max of 20 players online: Seia_Y' : c.includes('Pos') ? 'x has the following entity data: [100.5d, 70.0d, 200.5d]' : c.includes('Dimension') ? 'has: "minecraft:overworld"' : c.startsWith('tp ') ? 'Teleported Bot1 to Seia_Y' : srv.run(c)) } });
    svc.addBot('Bot1'); svc.addBot('Bot2'); await until(() => svc.status().bots.every((b) => b.state === 'online'));

    await test('catalog: every action-layer command is there with typed arguments; meta commands marked', () => {
        const c = catalog(), by = Object.fromEntries(c.map((x) => [x.name, x]));
        for (const n of ['move_to', 'mine', 'place', 'tunnel', 'activate', 'equip', 'toss', 'craft', 'deposit', 'withdraw', 'attack', 'eat', 'smelt', 'pickup', 'look_at', 'come', 'say', 'teleport', 'stop']) assert.ok(by[n], n);
        assert.deepStrictEqual(by.tunnel.args.map((a) => [a.name, a.type]), [['dir', 'dir'], ['dy', 'dy']]);
        assert.ok(by.craft.allOrNone && by.look_at.oneOf);
        assert.ok(by.say.meta && by.teleport.rcon);
    });

    await test('commands: to one bot, to all; arguments validated; busy and unknown refused; say refuses slash commands; teleport uses the server console', async () => {
        const skillsPath = require.resolve('../src/skills'); const skills = require('../src/skills'); const orig = skills.execute; const seen = [];
        skills.execute = async (bot, name, args, opts) => { seen.push([bot.username, name, args]); await sleep(60); return { ok: true, reason: null }; };
        try {
            const r = await svc.runCommand({ bots: ['Bot1'], command: 'move_to', args: { x: 1, y: 70, z: 2 } });
            assert.deepStrictEqual(r.started, ['Bot1']); assert.strictEqual(svc.status().bots.find((b) => b.name === 'Bot1').cmd.status, 'running');
            const busy = await svc.runCommand({ bots: ['Bot1'], command: 'mine', args: { x: 1, y: 2, z: 3 } }); assert.match(busy.refused[0].why, /busy/);
            await until(() => svc.status().bots.find((b) => b.name === 'Bot1').cmd.status === 'ok');
            const all = await svc.runCommand({ bots: 'all', command: 'tunnel', args: { dir: 'north', dy: 0 } }); assert.deepStrictEqual(all.started.sort(), ['Bot1', 'Bot2']);
            await until(() => svc.status().bots.every((b) => b.cmd && b.cmd.status === 'ok'));
            assert.deepStrictEqual(seen.map((s) => s[1]), ['move_to', 'tunnel', 'tunnel']);
            const bad = await svc.runCommand({ bots: ['Bot2'], command: 'tunnel', args: { dir: 'up', dy: 3 } }); assert.strictEqual(bad.started.length, 0); assert.match(bad.refused[0].why, /dir|dy|valid/);
            await rejects(svc.runCommand({ bots: ['Bot2'], command: 'rm -rf', args: {} }), 400, /unknown command/);
            const missing = await svc.runCommand({ bots: ['Nope1'], command: 'stop' }); assert.match(missing.refused[0].why, /no such bot/);
            await svc.runCommand({ bots: ['Bot1'], command: 'say', args: { text: 'hello' } }); await until(() => chats.length === 1); assert.deepStrictEqual(chats[0], ['Bot1', 'hello']);
            const slash = await svc.runCommand({ bots: ['Bot1'], command: 'say', args: { text: '/op me' } }); assert.match(slash.refused[0].why, /must not start/);
            const tp = await svc.runCommand({ bots: ['Bot2'], command: 'teleport', args: { player: 'Seia_Y' } }); assert.deepStrictEqual(tp.started, ['Bot2']);
            await until(() => svc.status().bots.find((b) => b.name === 'Bot2').cmd.status === 'ok');
            const tpBad = await svc.runCommand({ bots: ['Bot2'], command: 'teleport', args: { player: 'a b; op x' } }); assert.strictEqual(tpBad.started.length, 0);
            await svc.runCommand({ bots: ['Bot1'], command: 'come', args: {} }); await until(() => seen.some((s) => s[1] === 'move_to' && s[2].x === 100));
        } finally { skills.execute = orig; void skillsPath; }
        const d = svc.botDetail('Bot1'); assert.ok(d.history.length >= 3);
        assert.deepStrictEqual(svc.nearbyEntities('Bot1').map((e) => [e.id, e.type]), [[7, 'zombie']]);
        assert.deepStrictEqual(svc.containersNear('Bot1'), [{ x: 10, y: 64, z: 20, block: 'chest' }]);
    });

    await test('gather: validated, runs as one command with progress, the survey route answers', async () => {
        const g = require('../src/work/jobs/gather'), orig = { gather: g.gather, survey: g.survey }, seen = [];
        g.gather = async (bot, args, o) => { seen.push([bot.username, args]); o.onProgress({ got: 2, want: args.count, mined: 2 }); await sleep(60); o.onProgress({ got: args.count, want: args.count, mined: args.count }); return { ok: true, reason: null, detail: { got: args.count } }; };
        g.survey = (bot, target, radius) => ({ ok: true, blocks: [target], total: 3, radius });
        try {
            for (const bad of [{ target: 'Iron Ore' }, { target: 'iron_ore', count: 0 }, { target: 'iron_ore', count: 5000 }, { target: 'iron_ore', radius: 100 }, {}, { target: 'x;y' }]) {
                const r = await svc.runCommand({ bots: ['Bot2'], command: 'gather', args: bad }); assert.strictEqual(r.started.length, 0, JSON.stringify(bad)); assert.ok(r.refused[0].why.length > 3);
            }
            const ok = await svc.runCommand({ bots: ['Bot2'], command: 'gather', args: { target: 'raw_iron', count: 4 } }); assert.deepStrictEqual(ok.started, ['Bot2']);
            await until(() => { const c = svc.status().bots.find((b) => b.name === 'Bot2').cmd; return c && c.progress && c.progress.got === 2; });
            await until(() => svc.status().bots.find((b) => b.name === 'Bot2').cmd.status === 'ok');
            assert.deepStrictEqual(seen[0], ['Bot2', { target: 'raw_iron', count: 4, radius: 32 }]);
            assert.deepStrictEqual(svc.survey('Bot2', 'iron_ore', 40), { ok: true, blocks: ['iron_ore'], total: 3, radius: 40 });
            assert.throws(() => svc.survey('Bot2', 'a b', 40), /target/); assert.throws(() => svc.survey('Bot2', 'iron_ore', 5000), /radius/);
        } finally { Object.assign(g, orig); }
    });

    await test('service inventory + map: read, move through the service, map index and region from a real file', async () => {
        const chest = { type: 'block', x: 10, y: 64, z: 20 };
        assert.strictEqual((await svc.inventory(chest)).slots.length, 2);
        const m = await svc.moveStack({ src: chest, srcSlot: 0, dst: { type: 'entity', name: 'Bot1' } }); assert.strictEqual(m.moved.count, 32);
        await rejects(svc.moveStack({ src: chest, srcSlot: 0, dst: { type: 'entity', name: 'Bot1' } }), 409, /empty/);
        await rejects(svc.inventory({ type: 'entity', name: 'x y' }), 400);
        const idx = svc.mapIndex('overworld'); assert.deepStrictEqual(idx.regions.map((r) => [r.rx, r.rz]), [[0, 0]]);
        const reg = await svc.mapRegion('overworld', 0, 0); assert.strictEqual(reg.chunks, 1); assert.ok(reg.names.includes('minecraft:water'));
        const again = await svc.mapRegion('overworld', 0, 0); assert.strictEqual(again, reg, 'cached by modification time');
        assert.strictEqual((await svc.mapRegion('overworld', 5, 5)).idx, null);
        await rejects(svc.mapRegion('moon', 0, 0), 400); await rejects(svc.mapRegion('overworld', 1.5, 0), 400);
        assert.strictEqual(svc.mapIndex('nether').regions.length, 0);
    });

    await test('routes: gzip, commands, inventory, map, Access gate on the public host, session without a token for a valid Access user', async () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
        const access = new Access({ team: 't.cloudflareaccess.com', aud: 'A1', emails: ['owner@example.com'] }, { getKeys: async () => ({ keys: [jwk] }) });
        const jwt = (email) => { const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'), h = e({ alg: 'RS256', kid: 'k1' }), b = e({ iss: 'https://t.cloudflareaccess.com', aud: ['A1'], email, exp: Date.now() / 1000 + 600 }); return `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey).toString('base64url')}`; };
        const token = loadToken(path.join(dir, 'tok'));
        const { server } = createConsole({ service: svc, token, access, publicHost: 'bots.example.com' });
        await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
        const call = (method, url, { body, headers = {}, cookie, csrf } = {}) => new Promise((resolve, reject) => {
            const data = body !== undefined ? JSON.stringify(body) : null;
            const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF': csrf } : {}), ...headers } }, (res) => {
                const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { let buf = Buffer.concat(ch); if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf); let j = null; try { j = JSON.parse(buf.toString()); } catch (_) { /* html */ } resolve({ status: res.statusCode, json: j, headers: res.headers, text: buf.toString() }); });
            }); req.on('error', reject); if (data) req.write(data); req.end();
        });
        const pub = { Host: 'bots.example.com' };
        assert.strictEqual((await call('GET', '/', { headers: pub })).status, 403, 'public host without Access');
        assert.strictEqual((await call('GET', '/api/state', { headers: { ...pub, 'Cf-Access-Jwt-Assertion': jwt('mallory@example.com') } })).status, 403, 'wrong e-mail');
        const page = await call('GET', '/', { headers: { ...pub, 'Cf-Access-Jwt-Assertion': jwt('owner@example.com') } }); assert.strictEqual(page.status, 200);
        assert.strictEqual((await call('GET', '/api/state', { headers: { ...pub, 'Cf-Access-Jwt-Assertion': jwt('owner@example.com') } })).status, 401, 'Access alone is not a session until /api/session');
        const s = await call('GET', '/api/session', { headers: { ...pub, 'Cf-Access-Jwt-Assertion': jwt('owner@example.com') } });
        assert.strictEqual(s.status, 200); assert.strictEqual(s.json.via, 'access');
        const cookie = s.headers['set-cookie'][0].split(';')[0], csrf = s.json.csrf, H = { headers: pub, cookie, csrf };
        const withJwt = { ...H, headers: { ...pub, 'Cf-Access-Jwt-Assertion': jwt('owner@example.com') } };
        assert.strictEqual((await call('GET', '/api/state', withJwt)).status, 200);
        assert.strictEqual((await call('GET', '/api/session', { headers: { Host: `127.0.0.1:${port}` } })).status, 401, 'local host: still needs the token');
        // everything below over the local host with a token session
        const login = await call('POST', '/api/login', { body: { token } }); const L = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.json.csrf };
        const cat = await call('GET', '/api/commands/catalog', L); assert.ok(cat.json.length >= 19);
        const run = await call('POST', '/api/commands', { body: { bots: ['Bot1'], command: 'stop' }, ...L }); assert.strictEqual(run.status, 200);
        assert.strictEqual((await call('POST', '/api/commands', { body: { bots: ['Bot1'], command: 'nope' }, ...L })).status, 400);
        assert.strictEqual((await call('POST', '/api/commands', { body: { bots: 'everyone', command: 'stop' }, ...L })).status, 400);
        const iv = await call('POST', '/api/inventory', { body: { target: { type: 'block', x: 10, y: 64, z: 20 } }, ...L }); assert.strictEqual(iv.status, 200);
        assert.strictEqual((await call('POST', '/api/inventory/move', { body: { src: { type: 'block', x: 10, y: 64, z: 20 }, srcSlot: 99, dst: { type: 'entity', name: 'Bot2' } }, ...L })).status, 409);
        const big = await call('GET', '/api/map/region?dim=overworld&rx=0&ry=0&rz=0', { ...L, headers: { 'Accept-Encoding': 'gzip' } }); assert.strictEqual(big.status, 200); assert.ok(big.json.idx.length > 1000); assert.strictEqual(big.headers['content-encoding'], 'gzip');
        assert.strictEqual((await call('GET', '/api/map/region?dim=overworld&rx=abc&rz=0', L)).status, 400);
        assert.strictEqual((await call('GET', '/api/map/regions?dim=end', L)).json.regions.length, 0);
        assert.strictEqual((await call('GET', '/api/bots/Bot1/entities', L)).json.length, 1);
        assert.strictEqual((await call('GET', '/api/bots/Nope1', L)).status, 404);
        assert.strictEqual((await call('POST', '/api/map/refresh', L)).status, 200);
        server.close();
    });
    await svc.stop();
    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

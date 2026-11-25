'use strict';
// The Forge and Fabric transports are separate modules and the platform switch picks between them (src/transport/platform.js).
const assert = require('assert');
const keep = { ...process.env };
const set = (o) => { for (const k of ['MC_PLATFORM', 'MC_FORGE', 'MC_VERSION']) delete process.env[k]; Object.assign(process.env, o); };
const { platform, gameVersion } = require('../src/transport/platform');

set({}); assert.strictEqual(platform(), 'forge'); assert.strictEqual(gameVersion(), '1.20.1');
set({ MC_VERSION: '26.1' }); assert.strictEqual(platform(), 'fabric'); assert.strictEqual(gameVersion(), '26.1');
set({ MC_FORGE: '0' }); assert.strictEqual(platform(), 'fabric');
set({ MC_PLATFORM: 'fabric' }); assert.strictEqual(platform(), 'fabric'); assert.strictEqual(gameVersion(), false, 'no version assumed: mineflayer asks the server');
set({ MC_PLATFORM: 'fabric', MC_VERSION: '1.21.1' }); assert.strictEqual(gameVersion(), '1.21.1');
set({ MC_PLATFORM: 'fabric', MC_VERSION: '1.20.1' }); assert.strictEqual(gameVersion(), '1.20.1');
set({ MC_PLATFORM: 'forge', MC_VERSION: '26.1' }); assert.strictEqual(platform(), 'forge'); assert.strictEqual(gameVersion(), '1.20.1');
set({ MC_PLATFORM: 'bedrock' }); assert.throws(() => platform(), /MC_PLATFORM/);

// The Fabric module carries none of Forge's workarounds, and loading it patches nothing process-global.
const fs = require('fs'), path = require('path');
const fabric = fs.readFileSync(path.join(__dirname, '../src/transport/fabric_bot.js'), 'utf8');
for (const w of ['FML3', 'restBuffer', 'ForgeHandshake', 'applyProtocolBypasses', 'hardenClientChatParsers', 'DynamicRegistryInjector']) assert.ok(!fabric.replace(/\/\/.*$/gm, '').includes(w), `fabric_bot.js mentions ${w}`);
set({ MC_PLATFORM: 'fabric' });
const nbt = require('prismarine-nbt'), before = nbt.protos.big.read;
require('../src/transport/fabric_bot'); require('../src/transport');
assert.strictEqual(nbt.protos.big.read, before, 'loading the Fabric transport must not patch the NBT reader');
const t = require('../src/transport');
assert.strictEqual(t.impl(), require('../src/transport/fabric_bot'));
set({ MC_PLATFORM: 'forge' }); assert.strictEqual(t.impl(), require('../src/transport/forge_bot'));
// The enchantment shapes of the item-component versions (1.21.1 and 26.1 both) come out as mineflayer's list.
const { normEnchants } = require('../src/transport/fabric_bot');
const reg = { enchantments: { 7: { name: 'efficiency' } } };
assert.deepStrictEqual(normEnchants({ enchantments: [{ id: 7, level: 5 }] }, reg), [{ name: 'efficiency', lvl: 5 }]);
assert.deepStrictEqual(normEnchants({ levels: { 'minecraft:efficiency': 3 } }, reg), [{ name: 'efficiency', lvl: 3 }]);
assert.deepStrictEqual(normEnchants([{ name: 'efficiency', lvl: 2 }], reg), [{ name: 'efficiency', lvl: 2 }]);
assert.deepStrictEqual(normEnchants(undefined, reg), []);
Object.assign(process.env, keep);
console.log('transport platform: ok');

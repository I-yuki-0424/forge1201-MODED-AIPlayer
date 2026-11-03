'use strict';
// DamageLog: damage events from a 1.20 server become rows with the type name, the attacker and the amount; deaths carry the
// translation key. Pure: a fake bot with an EventEmitter client.
const assert = require('assert');
const { EventEmitter } = require('events');
const nbt = require('prismarine-nbt');
const { DamageLog, damageTypeNames, deathKey } = require('../src/rl/damage_log');

const codec = nbt.comp({ 'minecraft:damage_type': nbt.comp({ type: nbt.string('minecraft:damage_type'),
    value: nbt.list(nbt.comp([{ name: nbt.string('minecraft:arrow'), id: nbt.int(2), element: nbt.comp({}) }, { name: nbt.string('minecraft:mob_attack'), id: nbt.int(30), element: nbt.comp({}) }])) }) });
assert.strictEqual(damageTypeNames(codec)[30], 'mob_attack');
assert.deepStrictEqual(damageTypeNames(undefined), []);

const bot = Object.assign(new EventEmitter(), { _client: new EventEmitter(), health: 20, entity: { id: 7, position: { distanceTo: () => 2.04 } },
    entities: { 11: { name: 'zombie', position: { distanceTo: () => 1.5 } }, 12: { name: 'arrow', position: { distanceTo: () => 1.5 } }, 13: { name: 'skeleton', position: { distanceTo: () => 9.96 } } } });
bot.entity.position.distanceTo = () => 0;
const log = new DamageLog(bot);
bot._client.emit('login', { dimensionCodec: codec });
bot.emit('physicsTick');
bot._client.emit('damage_event', { entityId: 7, sourceTypeId: 30, sourceCauseId: 12, sourceDirectId: 0 });     // zombie (id 11 + 1)
bot.health = 17; bot.emit('health');
bot._client.emit('damage_event', { entityId: 99, sourceTypeId: 30, sourceCauseId: 12, sourceDirectId: 0 });     // someone else
bot._client.emit('damage_event', { entityId: 7, sourceTypeId: 2, sourceCauseId: 14, sourceDirectId: 13 });      // skeleton's arrow
bot.health = 14.5; bot.emit('health');
bot.health = 14; bot.emit('health');                                                                              // no hit event: starvation-like loss
bot.health = 20; bot.emit('health');                                                                              // regeneration is not damage
bot.health = 17.5; bot.emit('health');                                                                           // health packet BEFORE the damage event ...
bot._client.emit('damage_event', { entityId: 7, sourceTypeId: 30, sourceCauseId: 12, sourceDirectId: 0 });     // ... explained by it afterwards
bot.health = 20; bot.emit('health');
bot._client.emit('death_combat_event', { playerId: 7, message: JSON.stringify({ translate: 'death.attack.mob', with: [{ text: 'Train0' }, { text: 'Zombie' }] }) });
const rows = log.take();
assert.deepStrictEqual(rows.map((r) => [r.k, r.src, r.by, r.direct, r.d]), [
    ['hit', 'mob_attack', 'zombie', undefined, 3], ['hit', 'arrow', 'skeleton', 'arrow', 2.5], ['loss', undefined, undefined, undefined, 0.5], ['hit', 'mob_attack', 'zombie', undefined, 2.5], ['death', undefined, undefined, undefined, undefined]]);
assert.strictEqual(rows[4].msg, 'death.attack.mob:Zombie');
assert.deepStrictEqual(log.take(), []);
assert.strictEqual(deathKey('{"translate":"death.fell.accident.generic","with":[{"text":"Train0"}]}'), 'death.fell.accident.generic');
console.log('damage log: ok');

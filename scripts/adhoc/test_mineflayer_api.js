const assert = require('assert');

const registry = require('prismarine-registry')('1.20.1');
const Item = require('prismarine-item')('1.20.1');
const diamondPickaxeId = registry.itemsByName.diamond_pickaxe.id;
const testItem = new Item(diamondPickaxeId, 1);
console.log("Max Durability:", testItem.maxDurability);

// Simulate use
testItem.durabilityUsed = 100;
console.log("Durability Used:", testItem.durabilityUsed);

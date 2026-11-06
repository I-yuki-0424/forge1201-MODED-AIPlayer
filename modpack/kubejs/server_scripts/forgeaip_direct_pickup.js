// forgeaip: drops of blocks that tagged players (the pure bots) break go straight into their inventory (owner 2026-11-06, 2-1).
// Why a script and not another mod: KubeJS is on the play server already, and a server script needs nothing on the owner's client.
// The block is broken by the game as usual (tool wear, enchantments, loot tables, statistics, mod blocks); only the item
// entities that appear in the same tick next to the broken block are handed to the player instead of being spawned.
// Who: players with the tag `aip_direct` (the work console tags its bots, `tag <name> add|remove aip_direct`; the "Mined blocks
// into the inventory" switch on the Automation page). A full inventory leaves the surplus on the ground (give() drops it).
const AIP_TAG = 'aip_direct'
const aipBroken = []      // the last blocks tagged players broke: { who, t: game time, x, y, z }

BlockEvents.broken(event => {
  const p = event.player
  if (!p || !p.tags.contains(AIP_TAG)) return
  aipBroken.push({ who: String(p.username), t: event.level.time, x: event.block.x, y: event.block.y, z: event.block.z })
  if (aipBroken.length > 32) aipBroken.shift()
})

EntityEvents.spawned('minecraft:item', event => {
  if (aipBroken.length === 0) return
  const e = event.entity
  const now = event.level.time
  // the newest break first: several blocks can break in one tick (vein miners), the drop belongs to the nearest one
  let best = null, bestD = 99
  for (let i = aipBroken.length - 1; i >= 0; i--) {
    const b = aipBroken[i]
    if (now - b.t > 2) break
    const d = Math.abs(e.x - (b.x + 0.5)) + Math.abs(e.y - (b.y + 0.5)) + Math.abs(e.z - (b.z + 0.5))
    if (d < bestD) { bestD = d; best = b }
  }
  if (!best || bestD > 3) return
  const player = event.server.getPlayer(best.who)
  if (!player) return
  player.give(e.item)
  event.cancel()
})

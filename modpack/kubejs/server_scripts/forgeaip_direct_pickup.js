// forgeaip: drops of blocks that tagged players (the pure bots) break go straight into their inventory (owner 2026-11-06, 2-1).
// Why a script and not another mod: KubeJS is on the play server already, and a server script needs nothing on the owner's client.
// The block is broken by the game as usual (tool wear, enchantments, loot tables, statistics, mod blocks); only the item
// entities that appear in the same tick next to the broken block are handed to the player instead of being spawned.
// Who: players with the tag `aip_direct` (the work console tags its bots, `tag <name> add|remove aip_direct`; the "Mined blocks
// into the inventory" switch on the Automation page). A full inventory leaves the surplus on the ground (give() drops it).
const AIP_TAG = 'aip_direct'
const aipRecent = {}      // player name -> [{ t: game time, x, y, z }] of the last blocks they broke

BlockEvents.broken(event => {
  const p = event.player
  if (!p || !p.tags.contains(AIP_TAG)) return
  const list = aipRecent[p.username] || (aipRecent[p.username] = [])
  list.push({ t: event.level.time, x: event.block.x, y: event.block.y, z: event.block.z })
  if (list.length > 24) list.shift()
})

EntityEvents.spawned('minecraft:item', event => {
  const e = event.entity
  const now = event.level.time
  for (const name in aipRecent) {
    const list = aipRecent[name]
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      if (now - b.t > 2 || Math.abs(e.x - (b.x + 0.5)) > 1.6 || Math.abs(e.y - (b.y + 0.5)) > 1.6 || Math.abs(e.z - (b.z + 0.5)) > 1.6) continue
      const player = event.server.getPlayer(name)
      if (!player) continue
      player.give(e.item)
      event.cancel()
      return
    }
  }
})

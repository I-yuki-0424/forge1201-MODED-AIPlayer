// forgeaip: more block reach for every player, so that lag does not undo a break or a placement (owner 2026-11-09: "desync in block placing and breaking").
// Why: the server accepts a break or a placement only when the player's position IT knows is within block reach (forge:block_reach, 4.5, and one block of margin) of the block.
// With a slow link the position the server knows trails the client's, and the block "comes back" (a ghost block). Everybody who joins here is trusted, so the reach is raised by 3
// (7.5; the margin makes it 8.5). A server script needs nothing on the owner's client. Only the base value of the attribute is set (it is saved with the player and kept over a death),
// and again at every login and respawn, so that a player created before this script existed gets it too.
const AIP_BLOCK_REACH = 7.5

function aipReach(event) {
  const p = event.player
  if (!p) return
  event.server.runCommandSilent('attribute ' + p.username + ' forge:block_reach base set ' + AIP_BLOCK_REACH)
}
PlayerEvents.loggedIn(aipReach)
PlayerEvents.respawned(aipReach)

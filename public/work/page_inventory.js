'use strict';
// Inventory page.
function inventoryPage() {
    let inv = null; const host = h('div');
    return {
        el: host,
        onShow() { if (!inv) { inv = InventoryPage(getS, getPlayers); host.append(inv.el); const first = players.find((p) => !p.bot), bot = S && S.bots.find((b) => b.state === 'online'); if (bot) inv.a.setTarget('bot', bot.name); if (first) inv.b.setTarget('operator', first.name); } inv.tick(); },
        update() { if (inv && currentPage === 'inventory') inv.tick(); },
        players() { if (inv) inv.tick(); },
    };
}

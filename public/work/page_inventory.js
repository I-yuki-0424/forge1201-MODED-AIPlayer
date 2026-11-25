'use strict';
// Inventory page: two panes; each shows again what it showed last time (Keep), else a bot on the left and the operator on the right.
function inventoryPage() {
    let inv = null; const host = h('div');
    return {
        el: host,
        onShow() {
            if (!inv) {
                inv = InventoryPage(getS, getPlayers, 'inventory'); host.append(inv.el);
                const first = players.find((p) => !p.bot), bot = S && S.bots.find((b) => b.state === 'online');
                if (!inv.a.restore() && bot) inv.a.setTarget('bot', bot.name);
                if (!inv.b.restore() && first) inv.b.setTarget('operator', first.name);
            }
            inv.tick();
        },
        update() { if (inv && currentPage === 'inventory') inv.tick(); },
        players() { if (inv) inv.tick(); },
    };
}

'use strict';
// Trading with a villager (owner 2026-11-09; WIP: "do not aim for perfection in one go"). Two verbs: `trades` (open the nearest villager, read what it offers, close) and `trade`
// (buy a chosen trade a number of times). The trade is chosen by what the operator specifies: its index in the list, or the item it gives (`get`), the item it takes (`give`) and a
// price limit (`maxPrice`, in units of the first payment). Nothing is traded that the operator did not name; a trade that is sold out or not affordable is a failure with the reason.
// The window is Mineflayer's (`bot.openVillager`, `villager.trade`); `fromBot` adapts a bot, the tests use a fake `deps`.
// Known limits, not solved yet: a villager that walks away while the window is open, a trade list that changes after a restock (it is read again at every call), bots queueing at one
// villager (no line like containers have), the wandering trader (opened like a villager, not looked for), modded villagers (their entity type is not `villager`).
const OPEN_MS = 8000;
const bare = (n) => String(n || '').replace(/^minecraft:/, '');
const nm = (i) => (i && i.name ? bare(i.name) : null);

/** One trade of Mineflayer's list as plain data: what it takes, what it gives, the price now, how many uses are left. */
function describe(t, index) {
    const first = { item: nm(t.inputItem1), count: t.realPrice !== undefined ? t.realPrice : (t.inputItem1 && t.inputItem1.count) || 0 };
    const second = t.hasItem2 && t.inputItem2 ? { item: nm(t.inputItem2), count: t.inputItem2.count } : null;
    const left = Math.max(0, (t.maximumNbTradeUses || 0) - (t.nbTradeUses || 0));
    return { index, give: [first, ...(second ? [second] : [])], get: { item: nm(t.outputItem), count: (t.outputItem && t.outputItem.count) || 1 }, uses: t.nbTradeUses || 0, max: t.maximumNbTradeUses || 0, left: t.tradeDisabled ? 0 : left };
}

/**
 * The trade the operator means. `want`: { index?, get?, give?, maxPrice? }. With an index that one (and it must match get / give when those are also given); else the cheapest open
 * trade that matches. Returns { ok: true, trade: describe() } or { ok: false, reason, detail }.
 */
function select(list, want = {}) {
    const get = want.get ? bare(want.get) : null, give = want.give ? bare(want.give) : null;
    const matches = (d) => (!get || d.get.item === get) && (!give || d.give.some((g) => g.item === give)) && (want.maxPrice === undefined || d.give[0].count <= want.maxPrice);
    if (want.index !== undefined) {
        const d = list[want.index];
        if (!d) return { ok: false, reason: 'invalid_target', detail: { why: `there is no trade ${want.index} (the villager offers ${list.length})` } };
        if (!matches(d)) return { ok: false, reason: 'invalid_target', detail: { why: `trade ${want.index} is not what was asked for`, trade: d } };
        return { ok: true, trade: d };
    }
    if (!get && !give) return { ok: false, reason: 'invalid_args', detail: { why: 'name the trade: its index, or the item it gives (get) or takes (give)' } };
    const open = list.filter((d) => matches(d) && d.left > 0).sort((a, b) => a.give[0].count - b.give[0].count || a.index - b.index);
    if (open.length) return { ok: true, trade: open[0] };
    const sold = list.filter(matches);
    return { ok: false, reason: 'invalid_target', detail: { why: sold.length ? 'that trade is sold out (the villager restocks at its workstation)' : 'the villager offers no such trade', offers: list.slice(0, 8).map((d) => `${d.index}: ${d.give.map((g) => `${g.count} ${g.item}`).join(' + ')} -> ${d.get.count} ${d.get.item}`) } };
}

/** How many times the bot can use the trade now: stock, what it carries of each payment. */
const affordable = (d, have) => Math.min(d.left, ...d.give.map((g) => (g.count > 0 ? Math.floor(have(g.item) / g.count) : Infinity)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAP = [[/not enough item/i, 'missing_item'], [/trade blocked|sold out/i, 'invalid_target'], [/timed? ?out|timeout/i, 'timeout']];
const reasonOf = (e) => (MAP.find(([re]) => re.test(String(e && e.message))) || [null, 'not_confirmed'])[1];

/**
 * Open a villager and (unless `spec.list`) buy. `deps`: { villagers() -> [{id, dist}] nearest first, approach(v) -> {ok, reason?, detail?}, open(v) -> {trades, trade(i, n), close()},
 * have(item) -> count, pause?(ms) }. `spec`: { entity?: id, list?: bool, get?, give?, index?, maxPrice?, count = 1 }.
 * Returns { ok, reason, detail } like a command. `detail.trades` is the list (for `trades`), or `detail.bought` for `trade`.
 */
async function run(deps, spec = {}) {
    const count = spec.count === undefined ? 1 : spec.count;
    if (!spec.list && !(Number.isInteger(count) && count >= 1 && count <= 64)) return { ok: false, reason: 'invalid_args', detail: { why: 'count: 1..64 uses of the trade' } };
    const all = deps.villagers(), v = spec.entity !== undefined ? all.find((x) => x.id === spec.entity) : all[0];
    if (!v) return { ok: false, reason: 'invalid_target', detail: { why: spec.entity !== undefined ? `no villager #${spec.entity} near the bot` : 'no villager near the bot (32 blocks)' } };
    const a = await deps.approach(v);
    if (!a.ok) return { ok: false, reason: a.reason || 'unreachable', detail: { ...(a.detail || {}), stage: 'approach', villager: v.id } };
    let win;
    try { win = await deps.open(v); } catch (e) { return { ok: false, reason: /timed? ?out/i.test(String(e.message)) ? 'timeout' : 'not_confirmed', detail: { why: `the villager window did not open (${String(e.message).slice(0, 80)})`, stage: 'open', villager: v.id } }; }
    try {
        const list = (win.trades || []).map((t, i) => describe(t, i));
        if (spec.list) return { ok: true, reason: null, detail: { villager: v.id, trades: list } };
        const s = select(list, spec);
        if (!s.ok) return { ok: false, reason: s.reason, detail: { ...s.detail, villager: v.id } };
        const d = s.trade, n = Math.min(count, affordable(d, deps.have));
        if (n < 1) return d.left < 1 ? { ok: false, reason: 'invalid_target', detail: { why: 'sold out', trade: d, villager: v.id } }
            : { ok: false, reason: 'missing_item', detail: { item: (d.give.find((g) => deps.have(g.item) < g.count) || d.give[0]).item, need: d.give.map((g) => `${g.count} ${g.item}`).join(' + '), trade: d.index, villager: v.id } };
        const before = deps.have(d.get.item);
        try { await win.trade(d.index, n); } catch (e) { return { ok: false, reason: reasonOf(e), detail: { why: String(e.message).slice(0, 100), trade: d.index, stage: 'trade', villager: v.id } }; }
        return { ok: true, reason: null, detail: { villager: v.id, bought: { trade: d.index, uses: n, item: d.get.item, items: n * d.get.count, spent: d.give.map((g) => `${g.count * n} ${g.item}`) }, before, short: n < count ? `only ${n} of ${count}: ${d.left < count ? 'stock' : 'payment'} ran out` : undefined } };
    } finally { try { await win.close(); } catch (_) { /* the window is gone with the villager */ } if (deps.pause) await deps.pause(200); }
}

/** After the window is closed: did the items arrive? (the inventory catches up on close). Returns the same result, failed with `not_confirmed` when they did not. */
function confirm(res, have) {
    if (!res.ok || !res.detail.bought) return res;
    const b = res.detail.bought, got = have(b.item) - res.detail.before;
    return got >= b.items ? { ...res, detail: { ...res.detail, bought: { ...b, got } } } : { ok: false, reason: 'not_confirmed', detail: { ...res.detail, why: `the trade ran but ${got} of ${b.items} ${b.item} arrived` } };
}

/** The deps for a real bot. `env`: exec(name, args) (the action layer), w (world model), here(). Villagers within `radius`, nearest first. */
function fromBot(bot, env, { radius = 32 } = {}) {
    const type = bot.registry.entitiesByName.villager;
    const have = (item) => bot.inventory.items().reduce((n, i) => n + (bare(i.name) === item ? i.count : 0), 0);
    return {
        have,
        pause: sleep,
        villagers: () => Object.values(bot.entities || {}).filter((e) => e && e.position && (e.name === 'villager' || (type && e.entityType === type.id)) && e.position.distanceTo(bot.entity.position) <= radius)
            .map((e) => ({ id: e.id, dist: e.position.distanceTo(bot.entity.position), pos: e.position })).sort((a, b) => a.dist - b.dist),
        approach: async (v) => {
            const e = bot.entities[v.id]; if (!e) return { ok: false, reason: 'target_lost' };
            if (e.position.distanceTo(bot.entity.position) <= 3) { await bot.lookAt(e.position.offset(0, 1.5, 0)); return { ok: true }; }
            const p = { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }, cells = [];
            for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1, -1]) {
                const c = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
                if ((dx || dz) && env.w.kindAt(c.x, c.y, c.z) === 'air' && env.w.kindAt(c.x, c.y + 1, c.z) === 'air' && env.w.kindAt(c.x, c.y - 1, c.z) === 'solid') { cells.push({ ...c, d: Math.hypot(dx, dz) }); break; }
            }
            cells.sort((a, b) => a.d - b.d);
            let last = { ok: false, reason: 'unreachable', detail: { why: 'no free cell beside the villager' } };
            for (const c of cells.slice(0, 3)) { last = await env.exec('move_to', { x: c.x, y: c.y, z: c.z }); if (last.ok) break; }
            if (last.ok && bot.entities[v.id]) await bot.lookAt(bot.entities[v.id].position.offset(0, 1.5, 0));
            return last;
        },
        open: async (v) => {
            const e = bot.entities[v.id]; if (!e) throw new Error('the villager is gone');
            let timer; const win = await Promise.race([bot.openVillager(e), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout opening the villager')), OPEN_MS); })]).finally(() => clearTimeout(timer));
            return { trades: win.trades || [], trade: (i, n) => win.trade(i, n), close: () => win.close() };
        },
    };
}

/** Run `spec` on a bot and confirm the items arrived. */
async function trade(bot, env, spec) {
    const deps = fromBot(bot, env), r = await run(deps, spec);
    return confirm(r, deps.have);
}

module.exports = { run, select, describe, affordable, confirm, fromBot, trade };

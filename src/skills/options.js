'use strict';
// Per-bot switches for the pure-bot work layer (src/work). RL bots never set them, so every default is the old behaviour and the RL
// action space, observation and benchmarks are untouched (docs/proposed/WORKERS-v1.md, "worn tools").

const DEFAULTS = Object.freeze({
    retireWorn: false,        // treat a nearly broken tool as unusable (the next harvesting tool is taken; none left = missing_tool, worn)
    wornReserve: 0.06,        // ... when no more than this share of its durability is left,
    wornMin: 8,
    fixture: null,            // (blockName, x, y, z) -> true for a block that must not be broken (src/skills/fixtures.js); null = nothing is protected
    planNodes: 20000,         // the most cells one path search may expand (the work layer lowers it: a search for a cell nobody can reach used to burn the whole budget)               // ... or at most this many uses, whichever is more
});

const get = (bot) => bot.__skillOpts || DEFAULTS;
function configure(bot, o) {
    const next = { ...get(bot) };
    for (const k of Object.keys(DEFAULTS)) if (o && o[k] !== undefined) next[k] = o[k];
    bot.__skillOpts = Object.freeze(next);
    return bot.__skillOpts;
}

/** Uses left of a damageable item (null = it does not wear out). */
function usesLeft(item) {
    const max = item && item.maxDurability;
    return max ? max - (item.durabilityUsed || 0) : null;
}

/** Is this stack worn out under the bot's current options? Always false while `retireWorn` is off. */
function isWorn(bot, item) {
    const o = get(bot);
    if (!o.retireWorn) return false;
    const left = usesLeft(item);
    return left !== null && left <= Math.max(o.wornMin, Math.ceil(item.maxDurability * o.wornReserve));
}

module.exports = { DEFAULTS, get, configure, usesLeft, isWorn };

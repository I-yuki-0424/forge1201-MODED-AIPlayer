'use strict';
// RL-MOVE-v3, the world as the policy knows it: the bot's own world model (src/skills/world.js `kindAt`) turned into the simulator's cell codes (spec.CODE), with the shared list of placed
// blocks (work/bot/temps.js) telling the bot's own temporary blocks (OWN: may be taken away) from other bots' (OTHER: never stand on, never break) and from the blocks that stay (ROCK).
// `env` needs: w, here(), and optionally bot (username, game, inventory, registry), within (the pit box {x0, x1, z0, z1, top, bottom}), spots() (other bots: [{name, x, y, z}]).
const { CODE: C } = require('./spec');
const tempblocks = require('../../work/bot/tempblocks');

const OWN_KINDS = new Set(['pillar', 'scaffold', 'bridge', 'reflex']);                  // movement blocks: the placer takes them away again
const NEVER = /^(bedrock|barrier|end_portal_frame|end_portal|nether_portal|end_gateway|command_block|structure_block|jigsaw|reinforced_deepslate)$/;
const strip = (n) => String(n || '').replace(/^minecraft:/, '');
const dimOf = (bot) => { const d = String((bot && bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, ''); return d === 'the_nether' ? 'nether' : d === 'the_end' ? 'end' : d; };

/** A view for one decision (cells are cached while it lives). */
function makeView(env) {
    const w = env.w, bot = env.bot || null, temps = bot && bot.__temps, dim = dimOf(bot), me = bot && bot.username, box = env.within || null;
    const cache = new Map();
    const fixtures = bot ? require('../../skills/fixtures') : null;
    const raw = (x, y, z) => {
        const k = w.kindAt(x, y, z);
        switch (k) {
            case 'air': case 'climb': return C.AIR;
            case 'water': case 'liquid': return C.WATER;
            case 'danger': return C.LAVA;
            case 'partial': return C.PART;
            case 'solid': {
                const rec = temps && temps.get(dim, { x, y, z });
                if (rec) return rec.by === me && OWN_KINDS.has(rec.kind) ? C.OWN : rec.by && rec.by !== me && OWN_KINDS.has(rec.kind) ? C.OTHER : C.ROCK;
                const n = strip(w.nameAt && w.nameAt(x, y, z));
                if (NEVER.test(n) || (fixtures && fixtures.isBox && fixtures.isBox(n))) return C.ROCK;
                return C.SOLID;
            }
            default: return C.ROCK;                                                   // not loaded
        }
    };
    const spots = env.spots ? env.spots() : [];
    const bots = spots.filter((s) => s.name !== me).map((s) => ({ x: Math.floor(s.x), y: Math.floor(s.y), z: Math.floor(s.z) }));
    return {
        bots,
        code(x, y, z) { const key = `${x},${y},${z}`; let c = cache.get(key); if (c === undefined) { c = raw(x, y, z); cache.set(key, c); } return c; },
        inBox: (x, y, z) => !!box && x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1 && y <= box.top && y >= box.bottom,
    };
}

/** How many blocks the pack holds that a bridge or a pillar may use (the same rule as the action layer's choice of a block). */
function packCount(bot) {
    if (!bot) return 0;
    const held = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const names = new Set(tempblocks.order(held, bot.registry, { valueOf: require('../../work/bot/janitor').valueOf }));
    return held.reduce((n, i) => n + (names.has(strip(i.name)) ? i.count : 0), 0);
}

module.exports = { makeView, packCount, OWN_KINDS };

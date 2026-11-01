'use strict';
// Skill-level action space and observation for RL v2 (docs/proposed/RL-TRAINING-v2.md).
// One RL step = one command of the action layer (src/skills) on a target the bot can perceive. Each step the environment
// lists up to K concrete candidates ("mine the nearest iron_ore at x y z", "attack zombie #812", "craft stone_pickaxe",
// "wait"); the policy answers with the index of one (DPOD wire form: one `select` component `candidate`, n = K).
// Candidates are built only from client-side state (loaded blocks, entity list, inventory, recipe book), never from the
// server. The enumeration is generic (nearest of each kind), not a plan: which candidate leads anywhere is for the learner.
const Vec3 = require('vec3');
const { kindOf, standable, fromBot, isInteractive } = require('../skills/world');
const { categoryOf, CATEGORIES } = require('./observation');
const { fuelValue } = require('../skills/commands/gui');
const { REASONS } = require('../skills/runner');
const { PROGRESS_DIM } = require('./crafter_reward');

const K = 48;
// Command kinds the policy can choose. 0 = padding.
const CMDS = ['pad', 'move_to', 'mine', 'attack', 'pickup', 'craft', 'smelt', 'place', 'activate', 'equip', 'eat', 'wait'];
const CMD = Object.fromEntries(CMDS.map((c, i) => [c, i]));
const QUOTA = { move_to: 12, mine: 11, attack: 4, pickup: 2, craft: 6, smelt: 2, place: 3, activate: 2, equip: 2, eat: 2, wait: 1 };
const WAIT_TICKS = 40;
const REASON_LIST = ['ok', ...Object.keys(REASONS)];
const CAND_F = 8;   // dx dy dz dist (/16, clipped), count/64, in_reach, is_night, held
const GRID_R = 4, GRID_Y0 = -2, GRID_Y1 = 2;
const GRID_N = (2 * GRID_R + 1) ** 2 * (GRID_Y1 - GRID_Y0 + 1);
const INV_N = 36, ENT_N = 8, ENT_R = 16, ENT_F = 5, SELF_N = 20;
// Furnace inputs a player sees in the furnace recipe book (vanilla 1.20.1, the common ones).
const SMELTABLE = new Set(['raw_iron', 'raw_gold', 'raw_copper', 'iron_ore', 'gold_ore', 'copper_ore', 'deepslate_iron_ore',
    'deepslate_gold_ore', 'sand', 'red_sand', 'cobblestone', 'cobbled_deepslate', 'clay_ball', 'netherrack', 'ancient_debris',
    'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato', 'kelp', 'cactus', 'oak_log', 'spruce_log',
    'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'wet_sponge', 'create:raw_zinc', 'create:crushed_raw_iron']);
const PLACEABLE = /^(crafting_table|furnace|chest|torch|.*_bed|cobblestone|cobbled_deepslate|dirt|.*_planks|netherrack|stone|sand|gravel|oak_log|spruce_log|birch_log)$/;
const ARMOR = /_(helmet|chestplate|leggings|boots)$/;
const ARMOR_DEST = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' };

/** Stable name -> index tables (index 0 = none). Items: minecraft-data names + the mod set's items; entities likewise. */
function vocab(mcData, table) {
    const items = [...new Set([...mcData.itemsArray.map((i) => i.name), ...((table && table.items) || []).map((i) => i.name.replace(/^minecraft:/, ''))])].sort();
    const entities = [...new Set(mcData.entitiesArray.map((e) => e.name))].sort();
    return { items: ['none', ...items], entities: ['none', ...entities] };
}

const f = (name, shape, dtype) => ({ name, shape, dtype });
function obsSpec() {
    return {
        fields: [
            f('grid', [GRID_N], 'int'), f('self', [SELF_N], 'float'),
            f('inv_item', [INV_N], 'int'), f('inv_count', [INV_N], 'float'),
            f('ent_type', [ENT_N], 'int'), f('ent_feat', [ENT_N, ENT_F], 'float'),
            f('progress', [PROGRESS_DIM], 'float'),
            f('cand_cmd', [K], 'int'), f('cand_item', [K], 'int'), f('cand_ent', [K], 'int'), f('cand_feat', [K, CAND_F], 'float'), f('cand_mask', [K], 'bool'),
            f('last_reason', [], 'int'), f('dt_ticks', [], 'float'),
        ],
    };
}

function actionSpec() {
    return { name: 'skills_v1', version: 1, ticks_per_step: 1, components: [{ kind: 'select', name: 'candidate', n: K }], rules: [] };
}

const r = (x) => Math.round(x * 1e4) / 1e4;
const clip = (x) => Math.max(-1, Math.min(1, x));
const isNight = (bot) => !!bot.time && bot.time.timeOfDay >= 12542 && bot.time.timeOfDay < 23460;
const isMob = (e) => e && e !== undefined && e.type !== 'player' && e.name !== 'item' && /mob|hostile|animal|passive|water_creature|ambient/.test(e.type || '');

class SkillSpace {
    constructor(bot, voc) {
        this.bot = bot; this.voc = voc;
        this.itemIx = new Map(voc.items.map((n, i) => [n, i])); this.entIx = new Map(voc.entities.map((n, i) => [n, i]));
        this.recipeCache = { key: null, out: [] };
    }
    item(name) { return this.itemIx.get(String(name).replace(/^minecraft:/, '')) || 0; }
    ent(name) { return this.entIx.get(name) || 0; }

    observe(progress, last) {
        const bot = this.bot, e = bot.entity, p = e.position;
        const fx = Math.floor(p.x), fy = Math.floor(p.y + 0.2), fz = Math.floor(p.z);
        const grid = [];
        for (let dy = GRID_Y0; dy <= GRID_Y1; dy++) for (let dz = -GRID_R; dz <= GRID_R; dz++) for (let dx = -GRID_R; dx <= GRID_R; dx++) {
            grid.push(categoryOf(bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz))));
        }
        const slots = bot.inventory.slots.slice(9, 45);
        const t = bot.time ? bot.time.timeOfDay / 24000 : 0;
        const dim = String(bot.game && bot.game.dimension || '');
        const armor = [5, 6, 7, 8].filter((s) => bot.inventory.slots[s]).length;
        const self = [bot.health / 20, bot.food / 20, (bot.foodSaturation || 0) / 20, Math.min((bot.experience && bot.experience.level) || 0, 30) / 30,
            armor / 4, (bot.oxygenLevel ?? 20) / 20, e.onGround ? 1 : 0, e.isInWater ? 1 : 0, e.isInLava ? 1 : 0, bot.isSleeping ? 1 : 0,
            Math.sin(2 * Math.PI * t), Math.cos(2 * Math.PI * t), isNight(bot) ? 1 : 0, bot.isRaining ? 1 : 0,
            /overworld/.test(dim) ? 1 : 0, /nether/.test(dim) ? 1 : 0, /end/.test(dim) ? 1 : 0, clip(p.y / 128),
            Math.sin(e.yaw), Math.cos(e.yaw)].map(r);
        const near = Object.values(bot.entities).filter((x) => x !== e && x.position && x.position.distanceTo(p) <= ENT_R)
            .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p)).slice(0, ENT_N);
        const entType = [], entFeat = [];
        for (let i = 0; i < ENT_N; i++) {
            const x = near[i];
            entType.push(x ? this.ent(x.name) : 0);
            entFeat.push(x ? [clip((x.position.x - p.x) / 16), clip((x.position.y - p.y) / 16), clip((x.position.z - p.z) / 16),
                x.position.distanceTo(p) / ENT_R, x.type === 'player' ? 1 : 0].map(r) : [0, 0, 0, 0, 0]);
        }
        this.cands = this.candidates();
        const pad = (arr, n, z) => arr.concat(Array.from({ length: n - arr.length }, () => (typeof z === 'function' ? z() : z)));
        return {
            grid, self,
            inv_item: slots.map((s) => (s ? this.item(s.name) : 0)), inv_count: slots.map((s) => (s ? r(s.count / 64) : 0)),
            ent_type: entType, ent_feat: entFeat,
            progress: progress.map(r),
            cand_cmd: pad(this.cands.map((c) => CMD[c.cmd]), K, 0), cand_item: pad(this.cands.map((c) => c.item), K, 0),
            cand_ent: pad(this.cands.map((c) => c.ent), K, 0), cand_feat: pad(this.cands.map((c) => c.feat), K, () => new Array(CAND_F).fill(0)),
            cand_mask: pad(this.cands.map(() => true), K, false),
            last_reason: REASON_LIST.indexOf(last.reason) < 0 ? 0 : REASON_LIST.indexOf(last.reason), dt_ticks: last.ticks,
        };
    }

    feat(pos, count = 0, held = false) {
        const p = this.bot.entity.position;
        if (!pos) return [0, 0, 0, 0, r(count / 64), 1, isNight(this.bot) ? 1 : 0, held ? 1 : 0];
        const d = pos.distanceTo(p);
        return [clip((pos.x - p.x) / 16), clip((pos.y - p.y) / 16), clip((pos.z - p.z) / 16), Math.min(d / 16, 1), r(count / 64),
            d <= 4.5 ? 1 : 0, isNight(this.bot) ? 1 : 0, held ? 1 : 0].map(r);
    }

    /** Up to K candidates, each {cmd, args, item, ent, feat}. Always contains 'wait'. */
    candidates() {
        const bot = this.bot, p = bot.entity.position, w = fromBot(bot);
        const fx = Math.floor(p.x), fy = Math.floor(p.y + 0.2), fz = Math.floor(p.z);
        const out = [];
        const add = (cmd, list) => { for (const c of list.slice(0, QUOTA[cmd])) out.push({ cmd, ...c }); };
        const inv = bot.inventory.items();

        // move_to: 8 headings x near (6) + 4 headings far (16); the standable cell nearest to the bot's height in that column.
        const moves = [];
        const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
        for (const [d, list] of [[6, dirs], [16, dirs.filter((_, i) => i % 2 === 0)]]) {
            for (const [ux, uz] of list) {
                const x = fx + Math.round(ux * d / Math.hypot(ux, uz)), z = fz + Math.round(uz * d / Math.hypot(ux, uz));
                for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
                    if (standable(w, x, fy + dy, z)) { moves.push({ args: { x, y: fy + dy, z }, item: 0, ent: 0, feat: this.feat(new Vec3(x + 0.5, fy + dy, z + 0.5)) }); break; }
                }
            }
        }
        add('move_to', moves);

        // mine: per block type the nearest exposed block within 5, and the nearest at head height or above (so a bot in a pit
        // is always offered the wall block that makes a step out). Never the block under the feet: digging straight down made
        // the pits that trapped run 1's and run 2's bots (move_to unreachable, the only dirt offered was the one underfoot).
        const best = new Map(), up = new Map();
        for (let dy = -3; dy <= 4; dy++) for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
            if (dx === 0 && dz === 0 && dy < 0) continue;
            const b = bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz), false);
            if (!b || b.name === 'bedrock' || /air$|^water$|^lava$|^fire$/.test(b.name) || b.diggable === false) continue;
            const k = kindOf(b);
            if (k !== 'solid' && k !== 'partial') continue;
            const exposed = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, c, e]) => w.kindAt(fx + dx + a, fy + dy + c, fz + dz + e) === 'air');
            if (!exposed) continue;
            const d = dx * dx + dy * dy + dz * dz;
            if (!best.has(b.name) || best.get(b.name).d > d) best.set(b.name, { d, pos: b.position });
            if (dy >= 1 && (!up.has(b.name) || up.get(b.name).d > d)) up.set(b.name, { d, pos: b.position });
        }
        const mines = [...best.entries()].map(([name, v]) => ({ name, ...v }));
        for (const [name, v] of up) if (!best.get(name).pos.equals(v.pos)) mines.push({ name, ...v, d: v.d + 0.5 });
        add('mine', mines.sort((a, b) => a.d - b.d).map((v) => ({ args: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, item: this.item(v.name), ent: 0, feat: this.feat(v.pos.offset(0.5, 0.5, 0.5)) })));

        // attack: nearest mob of each type within 16; pickup: nearest dropped stacks within 12.
        const ents = Object.values(bot.entities).filter((x) => x !== bot.entity && x.position).map((x) => ({ x, d: x.position.distanceTo(p) })).sort((a, b) => a.d - b.d);
        const seen = new Set(), atk = [];
        for (const { x, d } of ents) if (d <= 16 && isMob(x) && !seen.has(x.name)) { seen.add(x.name); atk.push({ args: { entity: x.id }, item: 0, ent: this.ent(x.name), feat: this.feat(x.position) }); }
        add('attack', atk);
        add('pickup', ents.filter(({ x, d }) => d <= 12 && x.name === 'item').map(({ x }) => {
            const it = x.getDroppedItem && x.getDroppedItem();
            return { args: { entity: x.id }, item: it ? this.item(it.name) : 0, ent: this.ent('item'), feat: this.feat(x.position, it ? it.count : 0) };
        }));

        // craft: results the recipe book shows as craftable now (2x2, or 3x3 with a crafting table within 16 blocks).
        add('craft', this.craftable().map((name) => ({ args: { item: name, count: 1 }, item: this.item(name), ent: 0, feat: this.feat(null, 1) })));

        // smelt: furnace-book inputs held, when a furnace is near and some other fuel is held.
        const furnace = bot.findBlock({ matching: (b) => /^(furnace|smoker|blast_furnace)$/.test(b.name), maxDistance: 16 });
        if (furnace) {
            add('smelt', inv.filter((i) => SMELTABLE.has(i.name) && inv.some((j) => j.name !== i.name && fuelValue(j.name) > 0))
                .filter((i, n, a) => a.findIndex((j) => j.name === i.name) === n)
                .map((i) => ({ args: { item: i.name, count: 1 }, item: this.item(i.name), ent: 0, feat: this.feat(furnace.position, i.count) })));
        }

        // place: each placeable item held, in the nearest free supported cell next to the bot (not its own cells).
        const spots = [];
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]) {
            const x = fx + dx, z = fz + dz;
            if (w.kindAt(x, fy, z) === 'air' && w.kindAt(x, fy - 1, z) === 'solid') spots.push(new Vec3(x, fy, z));
        }
        add('place', spots.length ? inv.filter((i) => PLACEABLE.test(i.name)).filter((i, n, a) => a.findIndex((j) => j.name === i.name) === n)
            .map((i) => ({ args: { x: spots[0].x, y: spots[0].y, z: spots[0].z, item: i.name }, item: this.item(i.name), ent: 0, feat: this.feat(spots[0].offset(0.5, 0, 0.5), i.count) })) : []);

        // activate: nearest beds and other interactive blocks within 8 (a bed at night = sleep).
        const act = bot.findBlocks({ matching: (b) => isInteractive(b.name) && !/chest|barrel|crafting_table|furnace|smoker|shulker/.test(b.name), maxDistance: 8, count: 4 })
            .map((v) => bot.blockAt(v)).filter(Boolean).sort((a, b) => (/_bed$/.test(b.name) - /_bed$/.test(a.name)));
        add('activate', act.map((b) => ({ args: { x: b.position.x, y: b.position.y, z: b.position.z }, item: this.item(b.name), ent: 0, feat: this.feat(b.position.offset(0.5, 0.5, 0.5)) })));

        // equip: armour pieces held but not worn; eat: foods held when not full.
        add('equip', inv.filter((i) => ARMOR.test(i.name)).map((i) => ({ args: { item: i.name, dest: ARMOR_DEST[i.name.split('_').pop()] }, item: this.item(i.name), ent: 0, feat: this.feat(null, i.count) })));
        if (bot.food < 20) {
            const foods = bot.registry.foodsByName || {};
            add('eat', inv.filter((i) => foods[i.name]).filter((i, n, a) => a.findIndex((j) => j.name === i.name) === n)
                .map((i) => ({ args: { item: i.name }, item: this.item(i.name), ent: 0, feat: this.feat(null, i.count) })));
        }
        out.push({ cmd: 'wait', args: { ticks: WAIT_TICKS }, item: 0, ent: 0, feat: this.feat(null) });
        return out.slice(0, K);
    }

    /** Names of items craftable from the inventory now; cached per inventory content and table presence. */
    craftable() {
        const bot = this.bot;
        const table = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 16 });
        const key = bot.inventory.items().map((i) => `${i.type}:${i.count}`).sort().join(',') + (table ? '+t' : '');
        if (this.recipeCache.key === key) return this.recipeCache.out;
        const out = [];
        for (const id of Object.keys(bot.registry.recipes || {})) {
            if (bot.recipesFor(Number(id), null, 1, table || null).length) out.push(bot.registry.items[id].name);
        }
        // Prefer results not held yet, then a stable order, so the quota does not always show the same planks.
        const held = new Set(bot.inventory.items().map((i) => i.name));
        out.sort((a, b) => (held.has(a) - held.has(b)) || a.localeCompare(b));
        this.recipeCache = { key, out };
        return out;
    }
}

module.exports = { SkillSpace, vocab, obsSpec, actionSpec, K, CMDS, CMD, QUOTA, WAIT_TICKS, REASON_LIST, GRID_N, INV_N, ENT_N, CAND_F, SELF_N, CATEGORIES };

'use strict';
// Performance test of the command layer (src/skills) against the live Forge server (test code, not runtime).
// Every command runs `--reps` times (default 10) in a seeded random order, each time on a freshly rebuilt arena with
// random targets. Each trial is graded from the SERVER's state over RCON (blocks, inventory, position, food, entities),
// never from what the bot reports; the bot's own verdict is recorded next to it so disagreements show up.
//
//   scripts/rl/up.sh
//   (cd docker/rl-server && docker compose --profile env run --rm -T --entrypoint node rl-env scripts/skills/bench.js --run-id b1 --seed 1)
//   python3 scripts/skills/report.py exchange/b1         # per-command table, failures with their traces
// Options: --reps N, --only a,b, --seed S, --clutter 1 (random walls, steps, pits, raised stations, decoy mobs around every
// scenario), --control noop (negative control: the command is replaced by 20 idle ticks; every grade must then fail),
// --trials 129,130 (replay only those trial indices of the seeded order: a trial's world depends only on seed and index).
//
// Output (exchange/<run-id>/): trials.jsonl (one line per trial), traces/<n>.json (per-tick trace of every trial),
// summary.json. The arena is 2 x ARENA_R + 1 blocks wide at --origin-x (default -512), away from the RL arenas.
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const { createForgeBot, attachForgeHandshake } = require('../../src/transport/forge_bot');
const { Rcon } = require('../../src/rl/rcon');
const { mulberry32 } = require('../../src/rl/run_env');
const { execute, COMMANDS } = require('../../src/skills');

const BOT = process.env.SKILL_BOT_NAME || 'SkillBot';
const GY = Number(process.env.RL_GROUND_Y ?? -61);        // top solid layer of the flat world
const ARENA_R = 14;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const o = { root: '/exchange', runId: null, seed: 1, reps: 10, only: null, originX: -512, originZ: 0, clutter: false, control: null, trials: null };
    for (let i = 0; i < argv.length; i += 2) {
        const k = argv[i], v = argv[i + 1];
        const map = { '--root': ['root'], '--run-id': ['runId'], '--seed': ['seed', Number], '--reps': ['reps', Number],
            '--only': ['only', (s) => s.split(',')], '--origin-x': ['originX', Number], '--origin-z': ['originZ', Number],
            '--clutter': ['clutter', (s) => s === '1'], '--trials': ['trials', (s) => s.split(',').map(Number)], '--control': ['control', (s) => { if (s !== 'noop') throw new Error('--control noop'); return s; }] };
        if (!map[k] || v === undefined) throw new Error(`bad argument ${k}`);
        o[map[k][0]] = map[k][1] ? map[k][1](v) : v;
    }
    if (!o.runId) throw new Error('--run-id is required');
    for (const c of o.only || []) if (!COMMANDS[c]) throw new Error(`unknown command ${c}`);
    return o;
}

// ---------------------------------------------------------------- server side (RCON): build and grade
class Server {
    constructor(rcon) { this.rcon = rcon; }
    async cmd(c) { return (await this.rcon.command(c)).replace(/\x1b\[[0-9;]*m/g, '').trim(); }
    async must(c) {
        const out = await this.cmd(c);
        // "Could not set the block" / "No blocks were filled": the cell already holds that block, which is what was asked.
        if (/^(Could not set the block|No blocks were filled)/.test(out)) return out;
        if (/^(Unknown|Incorrect|Expected|Could not|That position|Invalid|Unable)/i.test(out)) throw new Error(`rcon "${c}": ${out}`);
        return out;
    }
    async test(c) { return /^Test passed/.test(await this.cmd(`execute if ${c}`)); }
    async count(item) { const m = /Found (\d+) matching/.exec(await this.cmd(`clear ${BOT} minecraft:${item} 0`)); return m ? Number(m[1]) : 0; }
    async nums(what) { return (/data: \[(.*)\]/.exec(await this.cmd(`data get entity ${BOT} ${what}`)) || [, ''])[1].split(',').map(parseFloat); }
    async num(what) { return parseFloat((/data: (-?[\d.]+)/.exec(await this.cmd(`data get entity ${BOT} ${what}`)) || [])[1]); }
    async blockIs(c, name) { return this.test(`block ${c.x} ${c.y} ${c.z} minecraft:${name}`); }
    async container(c, item) {
        const out = await this.cmd(`data get block ${c.x} ${c.y} ${c.z} Items`);
        let n = 0;
        for (const m of out.matchAll(/\{([^{}]*)\}/g)) if (m[1].includes(`"minecraft:${item}"`)) n += Number((/Count: (\d+)b/.exec(m[1]) || [, 0])[1]);
        return n;
    }
}

// ---------------------------------------------------------------- scenarios: random target + server-side grade
const pick = (rng, a) => a[Math.floor(rng() * a.length)];
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const key = (c) => `${c.x},${c.y},${c.z}`;

/** A random cell at horizontal distance [dmin, dmax] from the origin cell, inside the arena, not in `used`. */
function spot(rng, A, dmin, dmax, used) {
    for (let i = 0; i < 200; i++) {
        const d = dmin + rng() * (dmax - dmin), a = rng() * 2 * Math.PI;
        const c = { x: A.cx + Math.round(d * Math.cos(a)), y: GY + 1, z: A.cz + Math.round(d * Math.sin(a)) };
        if (Math.abs(c.x - A.cx) > ARENA_R - 2 || Math.abs(c.z - A.cz) > ARENA_R - 2) continue;
        if (Math.hypot(c.x - A.cx, c.z - A.cz) < dmin - 0.5 || used.has(`${c.x},${c.z}`)) continue;
        used.add(`${c.x},${c.z}`);
        return c;
    }
    throw new Error('no free spot');
}

const NEAR = [2, 7];      // stations, containers, blocks to act on
const FAR = [4, 12];      // walking targets, mobs, items

const SCENARIOS = {
    async move_to(S, rng, A) {
        const used = new Set([`${A.cx},${A.cz}`]);
        const t = spot(rng, A, ...FAR, used);
        const builds = [];
        for (let i = int(rng, 0, 3); i > 0; i--) {                       // 2-high walls, 3..6 long
            const s = spot(rng, A, 2, 10, new Set(used)), len = int(rng, 3, 6), alongX = rng() < 0.5;
            const e = alongX ? { x: s.x + len - 1, z: s.z } : { x: s.x, z: s.z + len - 1 };
            builds.push(`fill ${s.x} ${GY + 1} ${s.z} ${e.x} ${GY + 2} ${e.z} minecraft:stone`);
        }
        for (let i = int(rng, 0, 4); i > 0; i--) { const s = spot(rng, A, 1, 12, new Set(used)); builds.push(`setblock ${s.x} ${GY + 1} ${s.z} minecraft:cobblestone`); }
        for (let i = int(rng, 0, 2); i > 0; i--) { const s = spot(rng, A, 2, 12, new Set(used)); builds.push(`fill ${s.x} ${GY} ${s.z} ${s.x + 1} ${GY} ${s.z + 1} minecraft:air`); }
        const raised = rng() < 0.3;
        for (const b of builds) await S.must(b);
        // Keep the start and the target clear, the target optionally on a one-block step.
        await S.must(`fill ${A.cx} ${GY + 1} ${A.cz} ${A.cx} ${GY + 3} ${A.cz} minecraft:air`);
        await S.must(`setblock ${A.cx} ${GY} ${A.cz} minecraft:grass_block`);
        const ty = raised ? GY + 2 : GY + 1;
        await S.must(`fill ${t.x} ${ty} ${t.z} ${t.x} ${ty + 2} ${t.z} minecraft:air`);
        await S.must(`setblock ${t.x} ${ty - 1} ${t.z} minecraft:${raised ? 'oak_planks' : 'grass_block'}`);
        const target = { x: t.x, y: ty, z: t.z };
        return {
            args: target, scenario: { walls: builds.length, raised }, ready: (bot) => bot.blockAt(new Vec3(t.x, ty - 1, t.z))?.name === (raised ? 'oak_planks' : 'grass_block'),
            async grade() {
                const [x, y, z] = await S.nums('Pos');
                return { ok: Math.floor(x) === t.x && Math.floor(z) === t.z && Math.abs(y - ty) < 0.6, measured: { pos: [x, y, z] } };
            },
        };
    },

    async look_at(S, rng, A) {
        const name = pick(rng, ['stone', 'oak_log', 'gold_block', 'bricks', 'lever']);
        const far = rng() < 0.3;
        let c;
        do { c = { x: A.cx + int(rng, far ? -10 : -4, far ? 10 : 4), y: GY + int(rng, 1, 4), z: A.cz + int(rng, far ? -10 : -4, far ? 10 : 4) }; }
        while (Math.abs(c.x - A.cx) + Math.abs(c.z - A.cz) < 2);
        if (name === 'lever') c.y = GY + 1;
        await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:${name === 'lever' ? 'lever[face=floor,facing=north]' : name}`);
        return {
            keep: lineCells({ x: A.cx, z: A.cz }, c),
            args: c, scenario: { block: name, far }, ready: (bot) => bot.blockAt(new Vec3(c.x, c.y, c.z))?.name === name,
            async grade() {
                // Ray from the server's eye position along the server's rotation must enter the target cell before the ground.
                const [x, y, z] = await S.nums('Pos'), [yawN, pitchN] = await S.nums('Rotation');
                const yaw = Math.PI - (yawN * Math.PI) / 180, pitch = (-pitchN * Math.PI) / 180;
                const o = { x, y: y + 1.62, z }, d = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
                const box = name === 'lever' ? [0.25, 0, 0.25, 0.75, 0.4, 0.75] : [0, 0, 0, 1, 1, 1];
                let tin = 0, tout = 64;
                for (const [k, i] of [['x', 0], ['y', 1], ['z', 2]]) {
                    const lo = c[k] + box[i], hi = c[k] + box[i + 3];
                    if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo || o[k] > hi) tout = -1; continue; }
                    const t1 = (lo - o[k]) / d[k], t2 = (hi - o[k]) / d[k];
                    tin = Math.max(tin, Math.min(t1, t2)); tout = Math.min(tout, Math.max(t1, t2));
                }
                const tGround = d.y < 0 ? (GY + 1 - o.y) / d.y : Infinity;
                return { ok: tin <= tout && tin <= tGround + 1e-6, measured: { pos: [x, y, z], rot: [yawN, pitchN], t_hit: tin, t_ground: tGround } };
            },
        };
    },

    async mine(S, rng, A) {
        const kinds = [['dirt', 'dirt', null], ['grass_block', 'dirt', null], ['stone', 'cobblestone', 'wooden_pickaxe'], ['cobblestone', 'cobblestone', 'wooden_pickaxe'],
            ['oak_log', 'oak_log', null], ['birch_planks', 'birch_planks', null], ['sand', 'sand', null], ['coal_ore', 'coal', 'wooden_pickaxe'],
            ['iron_ore', 'raw_iron', 'stone_pickaxe'], ['clay', 'clay_ball', null]];
        const [name, drop, tool] = pick(rng, kinds);
        const c = spot(rng, A, ...NEAR, new Set([`${A.cx},${A.cz}`]));
        const where = name === 'sand' ? pick(rng, ['ground', 'floor']) : pick(rng, ['ground', 'floor', 'head', 'high', 'walled']);
        c.y = { ground: GY + 1, floor: GY, head: GY + 2, high: GY + 3, walled: GY + 1 }[where];
        await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:${name}`);
        if (where === 'walled') {                                         // stone on up to 3 sides, one side and the top open
            const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => rng() - 0.5).slice(0, int(rng, 1, 3));
            for (const [dx, dz] of sides) await S.must(`fill ${c.x + dx} ${c.y} ${c.z + dz} ${c.x + dx} ${c.y + 1} ${c.z + dz} minecraft:stone`);
        }
        if (where === 'head' || where === 'high') await S.must(`fill ${c.x} ${GY + 1} ${c.z} ${c.x} ${c.y - 1} ${c.z} minecraft:air`);
        const give = [];
        if (tool) give.push(rng() < 0.5 && tool === 'wooden_pickaxe' ? 'stone_pickaxe' : tool);
        if (rng() < 0.5) give.push(pick(rng, ['wooden_shovel', 'wooden_axe', 'stick', 'torch']));
        for (const g of give) await S.must(`give ${BOT} minecraft:${g} 1`);
        const before = await S.count(drop);
        return {
            pre: async () => ({ valid: await S.blockIs(c, name) }),
            args: c, scenario: { block: name, where, give }, ready: (bot) => bot.blockAt(new Vec3(c.x, c.y, c.z))?.name === name && give.every((g) => bot.inventory.items().some((i) => i.name === g)),
            async grade() {
                const air = await S.test(`block ${c.x} ${c.y} ${c.z} minecraft:air`), got = (await S.count(drop)) - before;
                return { ok: air && got >= 1, measured: { air, got, drop } };
            },
        };
    },

    async place(S, rng, A) {
        const item = pick(rng, ['dirt', 'cobblestone', 'oak_planks', 'stone_bricks', 'glass', 'oak_log']);
        const c = spot(rng, A, ...NEAR, new Set([`${A.cx},${A.cz}`]));
        const how = pick(rng, ['ground', 'on_block', 'side']);
        if (how === 'on_block') { await S.must(`setblock ${c.x} ${GY + 1} ${c.z} minecraft:stone`); c.y = GY + 2; }
        if (how === 'side') {                                             // a floating cell beside a 2-high pillar: only the side supports it
            const [dx, dz] = pick(rng, [[1, 0], [-1, 0], [0, 1], [0, -1]]);
            await S.must(`fill ${c.x + dx} ${GY + 1} ${c.z + dz} ${c.x + dx} ${GY + 2} ${c.z + dz} minecraft:stone`);
            c.y = GY + 2;
        }
        const n = int(rng, 1, 16), slot = rng() < 0.5 ? `hotbar.${int(rng, 0, 8)}` : `inventory.${int(rng, 0, 26)}`;
        await S.must(`item replace entity ${BOT} ${slot} with minecraft:${item} ${n}`);
        return {
            pre: async () => ({ valid: await S.blockIs(c, 'air') }),
            args: { ...c, item }, scenario: { how, n, slot }, ready: (bot) => bot.inventory.items().some((i) => i.name === item),
            async grade() { const ok = await S.blockIs(c, item); return { ok, measured: { placed: ok } }; },
        };
    },

    async activate(S, rng, A) {
        const c = await maybeRaise(S, rng, spot(rng, A, ...NEAR, new Set([`${A.cx},${A.cz}`])), A.hard);
        const facing = pick(rng, ['north', 'south', 'east', 'west']);
        const kind = pick(rng, ['lever', 'oak_door', 'oak_trapdoor', 'oak_fence_gate', 'spruce_door']);
        const prop = kind === 'lever' ? 'powered' : 'open';
        if (kind === 'lever') await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:lever[face=floor,facing=${facing}]`);
        else if (kind.endsWith('_door')) {
            await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:${kind}[half=lower,facing=${facing}]`);
            await S.must(`setblock ${c.x} ${c.y + 1} ${c.z} minecraft:${kind}[half=upper,facing=${facing}]`);
        } else await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:${kind}[facing=${facing}]`);
        const was = await S.test(`block ${c.x} ${c.y} ${c.z} minecraft:${kind}[${prop}=true]`);
        return {
            args: c, scenario: { block: kind, facing }, ready: (bot) => bot.blockAt(new Vec3(c.x, c.y, c.z))?.name === kind,
            async grade() { const now = await S.test(`block ${c.x} ${c.y} ${c.z} minecraft:${kind}[${prop}=true]`); return { ok: now !== was, measured: { [prop]: [was, now] } }; },
        };
    },

    async pickup(S, rng, A, bot) {
        const item = pick(rng, ['apple', 'iron_ingot', 'bread', 'arrow', 'oak_sapling', 'diamond']);
        const n = int(rng, 1, 16);
        const c = spot(rng, A, ...FAR, new Set([`${A.cx},${A.cz}`]));
        const how = pick(rng, ['ground', 'ground', 'on_block', 'in_pit']);
        let y = GY + 1;
        if (how === 'on_block') { await S.must(`setblock ${c.x} ${GY + 1} ${c.z} minecraft:stone`); y = GY + 2; }
        if (how === 'in_pit') { await S.must(`setblock ${c.x} ${GY} ${c.z} minecraft:air`); y = GY; }
        await S.must(`summon item ${c.x + 0.5} ${y} ${c.z + 0.5} {Item:{id:"minecraft:${item}",Count:${n}b},PickupDelay:0s}`);
        const before = await S.count(item);
        let seen = null;
        const find = () => (seen = Object.values(bot.entities).find((e) => e.name === 'item' && e.getDroppedItem()?.name === item && Math.hypot(e.position.x - c.x - 0.5, e.position.z - c.z - 0.5) < 1.5));
        return {
            keep: [[c.x, c.z]],
            args: () => ({ entity: seen.id }), scenario: { item, n, how }, ready: () => !!find(),
            pre: async () => ({ valid: await S.test(`entity @e[type=item,x=${c.x + 0.5},y=${y},z=${c.z + 0.5},distance=..1.5]`) }),
            async grade() { const got = (await S.count(item)) - before; return { ok: got >= n, measured: { got, n } }; },
        };
    },

    async attack(S, rng, A, bot) {
        // The RL server runs with spawn-animals=false, and 1.20.1 then discards every Animal on its next tick (measured: all
        // summoned pigs/cows/sheep/chickens were gone before the command started). Targets are mobs it keeps; helmets stop
        // zombies and skeletons from burning in the fixed daylight, so only the bot can kill them.
        const mob = pick(rng, ['husk', 'zombie', 'skeleton', 'spider', 'slime']);
        const c = spot(rng, A, ...FAR, new Set([`${A.cx},${A.cz}`]));
        const weapon = pick(rng, [null, 'wooden_sword', 'stone_sword', 'iron_axe']);
        if (weapon) await S.must(`give ${BOT} minecraft:${weapon} 1`);
        const nbt = { zombie: ',ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",Count:1b}]', skeleton: ',ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",Count:1b}]', slime: ',Size:1' }[mob] || '';
        await S.must(`summon minecraft:${mob} ${c.x + 0.5} ${GY + 1} ${c.z + 0.5} {Tags:["bt"]${nbt}}`);
        if (A.hard) for (let i = int(rng, 1, 3); i > 0; i--) {             // tiny slimes do no damage but block rays and bodies
            const d = spot(rng, A, 2, 10, new Set([`${A.cx},${A.cz}`, `${c.x},${c.z}`]));
            await S.must(`summon minecraft:slime ${d.x + 0.5} ${GY + 1} ${d.z + 0.5} {Size:0}`);
        }
        let seen = null;
        const find = () => (seen = Object.values(bot.entities).find((e) => e.name === mob && Math.hypot(e.position.x - c.x - 0.5, e.position.z - c.z - 0.5) < 3));
        return {
            keep: [[c.x, c.z]],
            args: () => ({ entity: seen.id }), scenario: { mob, weapon }, ready: () => !!find() && (!weapon || bot.inventory.items().some((i) => i.name === weapon)),
            pre: async () => ({ valid: await S.test('entity @e[tag=bt]') }),
            async grade() { const alive = await S.test('entity @e[tag=bt]'); return { ok: !alive, measured: { alive } }; },
        };
    },

    async eat(S, rng, A, bot) {
        const food = pick(rng, ['bread', 'cooked_beef', 'apple', 'baked_potato', 'carrot', 'cooked_porkchop', 'cooked_chicken']);
        // Hunger 255 adds 1.28 exhaustion per tick; the first 80 only drain saturation (reset leaves it at 20).
        const secs = int(rng, 4, 6);
        await S.must(`effect give ${BOT} minecraft:hunger ${secs} 255 true`);
        await sleep(secs * 1000 + 300);
        await S.must(`effect clear ${BOT} minecraft:hunger`);
        const n = int(rng, 1, 5), slot = rng() < 0.5 ? `hotbar.${int(rng, 0, 8)}` : `inventory.${int(rng, 0, 26)}`;
        await S.must(`item replace entity ${BOT} ${slot} with minecraft:${food} ${n}`);
        const food0 = await S.num('foodLevel');
        return {
            pre: async () => ({ valid: food0 < 20, food0 }),
            args: { item: food }, scenario: { food, n, slot, food0 }, ready: () => bot.food === food0 && bot.inventory.items().some((i) => i.name === food),
            async grade() { const f = await S.num('foodLevel'), left = await S.count(food); return { ok: f > food0 && left === n - 1, measured: { food: [food0, f], left } }; },
        };
    },

    async equip(S, rng, A, bot) {
        const dest = pick(rng, ['hand', 'hand', 'off_hand', 'head', 'chest', 'legs', 'feet']);
        const items = { hand: ['iron_sword', 'stone_pickaxe', 'oak_planks', 'torch', 'bread'], off_hand: ['shield', 'torch', 'totem_of_undying'],
            head: ['iron_helmet', 'leather_helmet', 'golden_helmet'], chest: ['iron_chestplate', 'leather_chestplate'], legs: ['iron_leggings', 'chainmail_leggings'], feet: ['iron_boots', 'leather_boots'] };
        const item = pick(rng, items[dest]);
        const slot = rng() < 0.4 ? `hotbar.${int(rng, 0, 8)}` : `inventory.${int(rng, 0, 26)}`;
        await S.must(`item replace entity ${BOT} ${slot} with minecraft:${item} 1`);
        const occupied = dest !== 'hand' && dest !== 'off_hand' && rng() < 0.4;
        if (occupied) await S.must(`item replace entity ${BOT} armor.${dest} with minecraft:${{ head: 'turtle_helmet', chest: 'golden_chestplate', legs: 'leather_leggings', feet: 'golden_boots' }[dest]} 1`);
        for (let i = int(rng, 0, 4); i > 0; i--) await S.cmd(`give ${BOT} minecraft:${pick(rng, ['dirt', 'stick', 'cobblestone'])} ${int(rng, 1, 64)}`);
        const nbtSlot = { off_hand: -106, head: 103, chest: 102, legs: 101, feet: 100 }[dest];
        return {
            args: { item, dest }, scenario: { slot, occupied }, ready: () => bot.inventory.items().some((i) => i.name === item),
            async grade() {
                const ok = dest === 'hand' ? await S.test(`entity @a[name=${BOT},nbt={SelectedItem:{id:"minecraft:${item}"}}]`)
                    : await S.test(`entity @a[name=${BOT},nbt={Inventory:[{Slot:${nbtSlot}b,id:"minecraft:${item}"}]}]`);
                return { ok, measured: { equipped: ok } };
            },
        };
    },

    async toss(S, rng, A, bot) {
        const item = pick(rng, ['dirt', 'cobblestone', 'oak_planks', 'arrow', 'apple']);
        const n = int(rng, 2, 64), k = int(rng, 1, n);
        const slot = rng() < 0.5 ? `hotbar.${int(rng, 0, 8)}` : `inventory.${int(rng, 0, 26)}`;
        await S.must(`item replace entity ${BOT} ${slot} with minecraft:${item} ${n}`);
        return {
            args: { item, count: k }, scenario: { n, slot }, ready: () => bot.inventory.items().some((i) => i.name === item && i.count === n),
            async grade() { const left = await S.count(item); return { ok: left === n - k, measured: { left, want: n - k } }; },
        };
    },

    async craft(S, rng, A, bot) {
        const R = [['oak_planks', 4, { oak_log: 1 }], ['stick', 4, { oak_planks: 2 }], ['crafting_table', 1, { oak_planks: 4 }], ['chest', 1, { oak_planks: 8 }],
            ['wooden_pickaxe', 1, { oak_planks: 3, stick: 2 }], ['stone_pickaxe', 1, { cobblestone: 3, stick: 2 }], ['furnace', 1, { cobblestone: 8 }],
            ['torch', 4, { coal: 1, stick: 1 }], ['ladder', 3, { stick: 7 }], ['oak_planks', 8, { oak_log: 2 }]];
        const [item, n, mats] = pick(rng, R);
        const t = await maybeRaise(S, rng, spot(rng, A, ...NEAR, new Set([`${A.cx},${A.cz}`])), A.hard);
        await S.must(`setblock ${t.x} ${t.y} ${t.z} minecraft:crafting_table`);
        for (const [m, k] of Object.entries(mats)) await S.must(`give ${BOT} minecraft:${m} ${k + int(rng, 0, 2)}`);
        const before = await S.count(item);
        return {
            keep: [[t.x, t.z]],
            args: { item, count: n }, scenario: { mats, table: t }, ready: () => Object.keys(mats).every((m) => bot.inventory.items().some((i) => i.name === m)),
            async grade() { const got = (await S.count(item)) - before; return { ok: got >= n, measured: { got, n } }; },
        };
    },

    async smelt(S, rng, A, bot) {
        const [input, output] = pick(rng, [['raw_iron', 'iron_ingot'], ['sand', 'glass'], ['cobblestone', 'stone'], ['oak_log', 'charcoal'],
            ['beef', 'cooked_beef'], ['potato', 'baked_potato'], ['clay_ball', 'brick']]);
        const n = int(rng, 1, 2);
        // Never the output as fuel: the server-side baseline count would include it.
        const [fuel, fk] = pick(rng, [['coal', 1], ['oak_planks', 2], ['charcoal', 1]].filter(([f]) => f !== output));
        const f = await maybeRaise(S, rng, spot(rng, A, ...NEAR, new Set([`${A.cx},${A.cz}`])), A.hard);
        await S.must(`setblock ${f.x} ${f.y} ${f.z} minecraft:furnace[facing=${pick(rng, ['north', 'south', 'east', 'west'])}]`);
        await S.must(`give ${BOT} minecraft:${input} ${n}`);
        await S.must(`give ${BOT} minecraft:${fuel} ${fk}`);
        const before = await S.count(output);
        return {
            keep: [[f.x, f.z]],
            args: { item: input, count: n }, scenario: { output, fuel, furnace: f }, ready: () => bot.inventory.items().some((i) => i.name === input) && !!bot.blockAt(new Vec3(f.x, f.y, f.z))?.name.includes('furnace'),
            async grade() { const got = (await S.count(output)) - before; return { ok: got >= n, measured: { got, n } }; },
        };
    },

    async deposit(S, rng, A, bot) {
        const item = pick(rng, ['dirt', 'cobblestone', 'apple', 'oak_log', 'iron_ingot']);
        const n = int(rng, 1, 64), k = int(rng, 1, n);
        const c = await maybeRaise(S, rng, spot(rng, A, ...NEAR, new Set([`${A.cx},${A.cz}`])), A.hard);
        const junk = rng() < 0.5 ? `{Items:[{Slot:${int(rng, 0, 26)}b,id:"minecraft:stick",Count:${int(rng, 1, 64)}b}]}` : '';
        await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:${pick(rng, ['chest', 'barrel'])}${junk}`);
        await S.must(`give ${BOT} minecraft:${item} ${n}`);
        return {
            args: { item, count: k, ...c }, scenario: { n, junk: !!junk }, ready: () => bot.inventory.items().some((i) => i.name === item),
            async grade() { const inside = await S.container(c, item), left = await S.count(item); return { ok: inside === k && left === n - k, measured: { inside, left, want: [k, n - k] } }; },
        };
    },

    async withdraw(S, rng, A) {
        const item = pick(rng, ['dirt', 'cobblestone', 'apple', 'oak_log', 'iron_ingot']);
        const n = int(rng, 1, 64), k = int(rng, 1, n);
        const c = await maybeRaise(S, rng, spot(rng, A, ...NEAR, new Set([`${A.cx},${A.cz}`])), A.hard);
        await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:${pick(rng, ['chest', 'barrel'])}{Items:[{Slot:${int(rng, 0, 26)}b,id:"minecraft:${item}",Count:${n}b}]}`);
        return {
            args: { item, count: k, ...c }, scenario: { n }, ready: (bot) => !!bot.blockAt(new Vec3(c.x, c.y, c.z)),
            async grade() { const got = await S.count(item), inside = await S.container(c, item); return { ok: got === k && inside === n - k, measured: { got, inside, want: [k, n - k] } }; },
        };
    },
};

// ---------------------------------------------------------------- clutter: random terrain around every scenario
/**
 * Walls (2 or 3 high), single steps, pits (1-2 deep) and raised platforms anywhere in the arena except within one block
 * of the start and of the scenario's own cells (`keep`, x/z pairs). Feasibility is not guaranteed by construction: a
 * failure on cluttered terrain is reviewed by hand (scripts/skills/report.py prints its trace) before it is counted
 * against a command.
 */
async function clutter(S, rng, A, keep) {
    const blocked = (x, z) => [...keep, [A.cx, A.cz]].some(([kx, kz]) => Math.abs(kx - x) <= 1 && Math.abs(kz - z) <= 1);
    const lim = ARENA_R - 1;
    const anywhere = () => ({ x: A.cx + int(rng, -lim, lim), z: A.cz + int(rng, -lim, lim) });
    const n = { walls: int(rng, 2, 6), steps: int(rng, 2, 8), pits: int(rng, 1, 3), platforms: int(rng, 0, 2) };
    for (let i = 0; i < n.walls; i++) {
        const s0 = anywhere(), len = int(rng, 3, 7), alongX = rng() < 0.5, h = rng() < 0.5 ? 2 : 3;
        for (let k = 0; k < len; k++) {
            const x = s0.x + (alongX ? k : 0), z = s0.z + (alongX ? 0 : k);
            if (!blocked(x, z) && Math.abs(x - A.cx) <= lim && Math.abs(z - A.cz) <= lim) await S.must(`fill ${x} ${GY + 1} ${z} ${x} ${GY + h} ${z} minecraft:${pick(rng, ['stone', 'oak_planks', 'cobblestone'])}`);
        }
    }
    for (let i = 0; i < n.steps; i++) { const c = anywhere(); if (!blocked(c.x, c.z)) await S.must(`setblock ${c.x} ${GY + 1} ${c.z} minecraft:${pick(rng, ['dirt', 'cobblestone', 'oak_log'])}`); }
    for (let i = 0; i < n.pits; i++) {
        const c = anywhere(), d = int(rng, 1, 2);
        if (!blocked(c.x, c.z) && !blocked(c.x + 1, c.z + 1)) await S.must(`fill ${c.x} ${GY - d + 1} ${c.z} ${c.x + 1} ${GY} ${c.z + 1} minecraft:air`);
    }
    for (let i = 0; i < n.platforms; i++) {                               // 3x3, one block high: reachable by a step up
        const c = anywhere();
        if (![-1, 0, 1].some((dx) => [-1, 0, 1].some((dz) => blocked(c.x + dx, c.z + dz)))) await S.must(`fill ${c.x - 1} ${GY + 1} ${c.z - 1} ${c.x + 1} ${GY + 1} ${c.z + 1} minecraft:stone`);
    }
    return n;
}

/** x/z cells clutter must leave alone: the scenario's own `keep`, else its target cell. */
function keepOf(sc) {
    if (sc.keep) return sc.keep;
    const a = typeof sc.args === 'object' ? sc.args : {};
    return a.x !== undefined ? [[a.x, a.z]] : [];
}

/** x/z cells on the segment between two cells (look_at must keep its line of sight: it does not walk). */
function lineCells(a, b) {
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z)) * 2 || 1;
    return Array.from({ length: n + 1 }, (_, i) => [Math.round(a.x + ((b.x - a.x) * i) / n), Math.round(a.z + ((b.z - a.z) * i) / n)]);
}

/** With --clutter, half of the stations and containers stand on a one-block base (the bot must step up or reach up). */
async function maybeRaise(S, rng, c, on) {
    if (!on || rng() < 0.5) return c;
    await S.must(`setblock ${c.x} ${GY + 1} ${c.z} minecraft:stone`);
    return { ...c, y: GY + 2 };
}

// ---------------------------------------------------------------- trial loop
async function waitFor(what, cond, ms = 8000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`sync timeout: ${what}`);
        await sleep(20);
    }
}

async function resetArena(S, bot, A, rng) {
    const R = ARENA_R;
    await S.must(`gamemode survival ${BOT}`);
    await S.must(`clear ${BOT}`);
    await S.must(`effect clear ${BOT}`);
    await S.must(`tp ${BOT} ${A.cx + 0.5} ${GY + 1} ${A.cz + 0.5} ${int(rng, 0, 7) * 45 - 180} 0`);
    await S.must(`fill ${A.cx - R} ${GY + 1} ${A.cz - R} ${A.cx + R} ${GY + 8} ${A.cz + R} minecraft:air`);
    await S.must(`fill ${A.cx - R} ${GY - 2} ${A.cz - R} ${A.cx + R} ${GY - 1} ${A.cz + R} minecraft:dirt`);
    await S.must(`fill ${A.cx - R} ${GY} ${A.cz - R} ${A.cx + R} ${GY} ${A.cz + R} minecraft:grass_block`);
    await S.cmd(`kill @e[type=!player,x=${A.cx},y=${GY},z=${A.cz},distance=..${R + 24}]`);
    await S.must(`effect give ${BOT} minecraft:instant_health 1 10 true`);
    await S.must(`effect give ${BOT} minecraft:saturation 1 20 true`);
    await waitFor('teleport', () => Math.hypot(bot.entity.position.x - A.cx - 0.5, bot.entity.position.z - A.cz - 0.5) < 0.3);
    await waitFor('inventory cleared', () => bot.inventory.items().length === 0 && !bot.inventory.slots[45] && [5, 6, 7, 8].every((s) => !bot.inventory.slots[s]));
    await waitFor('health and food', () => bot.health >= 19.9 && bot.food >= 20);
    await waitFor('arena', () => bot.blockAt(new Vec3(A.cx + 3, GY + 1, A.cz))?.name === 'air' && bot.blockAt(new Vec3(A.cx + 3, GY, A.cz))?.name === 'grass_block');
    await waitFor('landed', () => bot.entity.onGround);
    // Killed mobs stay in the world for their 20-tick death animation (and on the client until the server removes them),
    // and late items can appear after the kill (measured in bench v2: an item entity spawned after it). A scenario must
    // not start with leftovers (bench v1-hard-a #62: a dying decoy slime in the way), so kill until the client sees none.
    const centre = new Vec3(A.cx, GY, A.cz);
    const lingering = () => Object.values(bot.entities).find((e) => e !== bot.entity && e.type !== 'player' && e.position.distanceTo(centre) <= R + 20);
    for (let round = 0; ; round++) {
        try { await waitFor('arena entities removed', () => !lingering(), 1500); break; } catch (err) {
            const e = lingering();
            if (!e) break;
            if (round >= 4) throw new Error(`${err.message}: ${e.name}${e.name === 'item' ? `(${e.getDroppedItem()?.name})` : ''} #${e.id} at ${e.position.floored()}`);
            await S.cmd(`kill @e[type=!player,x=${A.cx},y=${GY},z=${A.cz},distance=..${R + 24}]`);
        }
    }
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const dir = path.join(o.root, o.runId);
    fs.mkdirSync(path.join(dir, 'traces'), { recursive: true });
    const out = fs.openSync(path.join(dir, 'trials.jsonl'), 'a');
    const rcon = new Rcon({ host: process.env.RCON_HOST || 'localhost', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '' });
    await rcon.connect();
    const S = new Server(rcon);
    for (const rule of ['doDaylightCycle false', 'doMobSpawning false', 'doWeatherCycle false', 'doImmediateRespawn true', 'sendCommandFeedback false', 'logAdminCommands false', 'randomTickSpeed 0', 'doTileDrops true', 'doEntityDrops true', 'doMobLoot true']) await S.cmd(`gamerule ${rule}`);
    await S.cmd('time set day');
    // Hunger only drains above peaceful; hostile test mobs (husk) need it too. Restored at the end.
    await S.must('difficulty easy');

    const bot = createForgeBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: BOT });
    attachForgeHandshake(bot, { registry: process.env.BOT_REGISTRY || 'auto' });
    bot.on('kicked', (r) => { console.error('[bench] kicked:', String(r).slice(0, 200)); process.exit(4); });
    bot.on('error', (e) => console.error('[bench] bot error:', String(e.message || e).slice(0, 200)));
    await new Promise((resolve, reject) => { bot.once('spawn', resolve); setTimeout(() => reject(new Error('no spawn within 60 s')), 60000); });
    const A = { cx: o.originX, cz: o.originZ, hard: o.clutter };
    await S.must(`tp ${BOT} ${A.cx + 0.5} ${GY + 1} ${A.cz + 0.5}`);
    await waitFor('chunks', () => bot.blockAt(new Vec3(A.cx, GY, A.cz)) != null && bot.blockAt(new Vec3(A.cx + ARENA_R, GY, A.cz + ARENA_R)) != null, 30000);

    const rng = mulberry32(o.seed >>> 0);
    const cmds = o.only || Object.keys(COMMANDS);
    const order = cmds.flatMap((c) => Array(o.reps).fill(c));
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }

    const summary = {};
    console.log(`[bench] run ${o.runId}: ${order.length} trials, seed ${o.seed}${o.clutter ? ', clutter' : ''}${o.control ? `, control ${o.control}` : ''}`);
    for (let n = 0; n < order.length; n++) {
        if (o.trials && !o.trials.includes(n)) continue;
        const command = order[n], trng = mulberry32((o.seed * 1000003 + n) >>> 0);
        let rec = { n, command, seed: o.seed };
        try {
            await resetArena(S, bot, A, trng);
            const sc = await SCENARIOS[command](S, trng, A, bot);
            const clutterN = o.clutter ? await clutter(S, trng, A, keepOf(sc)) : null;
            await waitFor('scenario visible to the client', () => sc.ready(bot), 8000);
            await sleep(100);
            const args = typeof sc.args === 'function' ? sc.args() : sc.args;
            // A target that is already gone (or already in the goal state) would make the grade meaningless: such a trial is a
            // harness error, never a pass.
            const pre = sc.pre ? await sc.pre() : null;
            if (pre && !pre.valid) throw new Error(`precondition failed: ${JSON.stringify(pre)}`);
            const r = o.control === 'noop' ? await execute(bot, 'look_at', { x: A.cx, y: GY, z: A.cz }, { maxTicks: 20 }).then(() => ({ ok: false, reason: 'control', detail: {}, ticks: 0, ms: 0, phases: [], trace: [] }))
                : await execute(bot, command, args);
            const g = await sc.grade();
            rec = { ...rec, args, scenario: sc.scenario, clutter: clutterN, pre, bot: { ok: r.ok, reason: r.reason, detail: r.detail }, server: g, ok: g.ok, agree: r.ok === g.ok, ticks: r.ticks, ms: r.ms };
            fs.writeFileSync(path.join(dir, 'traces', `${n}.json`), JSON.stringify({ n, command, args, result: { ok: r.ok, reason: r.reason, detail: r.detail }, server: g, phases: r.phases, trace: r.trace }));
        } catch (e) {
            rec = { ...rec, ok: false, harness_error: String(e.message || e).slice(0, 300) };
        }
        fs.writeSync(out, JSON.stringify(rec) + '\n');
        const s = summary[command] || (summary[command] = { n: 0, ok: 0, self_ok_server_fail: 0, harness_errors: 0 });
        s.n++; if (rec.ok) s.ok++;
        if (rec.bot && rec.bot.ok && !rec.ok) s.self_ok_server_fail++;
        if (rec.harness_error) s.harness_errors++;
        console.log(`[bench] ${String(n + 1).padStart(3)}/${order.length} ${command.padEnd(9)} ${rec.ok ? 'PASS' : 'FAIL'} ${rec.harness_error ? `harness: ${rec.harness_error}` : `bot=${rec.bot.ok ? 'ok' : rec.bot.reason} ticks=${rec.ticks}`}`);
    }
    const total = Object.values(summary).reduce((a, s) => ({ n: a.n + s.n, ok: a.ok + s.ok }), { n: 0, ok: 0 });
    const result = { run_id: o.runId, seed: o.seed, reps: o.reps, clutter: o.clutter, control: o.control, total: { ...total, rate: total.ok / total.n }, per_command: Object.fromEntries(Object.entries(summary).map(([k, s]) => [k, { ...s, rate: s.ok / s.n }])) };
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result.total));
    await S.cmd('difficulty peaceful');
    fs.closeSync(out);
    rcon.close();
    bot.end();
    setTimeout(() => process.exit(0), 300);
}

if (require.main === module) main().catch((e) => { console.error('[bench] fatal:', e.stack || e.message); process.exit(1); });

module.exports = { SCENARIOS, parseArgs };

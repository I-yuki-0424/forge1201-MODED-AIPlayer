'use strict';
// Survival movement for builders: a plan over standing cells (A*) with the moves a player makes (walk, step up, drop up to three, pillar up on a temporary block, bridge over a
// gap on one, break what is in the way, dig down), and their execution with the bot's own physics and inputs (look, forward, jump, sneak, a click, a dig). Every move is
// checked against where the server puts the bot; a move that does not end where planned ends the run, the caller plans again.
// The world: the bot's view, with `rules`: canDig(x, y, z, block) (never a built cell of the box, a container, next to a fluid ...), temp() (the item for temporary blocks
// or null), onTemp(cell) (a temporary block was placed there: the caller removes it later).
const { Vec3 } = require('vec3');
const P = require('./place');
const V = require('./vanilla');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (x, y, z) => `${x},${y},${z}`;
const AVOID_IN = /^(lava|fire|soul_fire|nether_portal|end_portal|end_gateway|cobweb|sweet_berry_bush|powder_snow|bubble_column|wither_rose|magma_block|campfire|soul_campfire|pointed_dripstone|cactus|moving_piston)$/;
const NO_STAND = /^(magma_block|campfire|soul_campfire|cactus|.*_fence|.*_wall|.*_fence_gate|pointed_dripstone|honey_block|slime_block|powder_snow|scaffolding|.*_bed|hopper|composter)$/;
const H = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const COST = { walk: 4.6, diag: 6.5, up: 9, drop: 5, pillar: 14, bridge: 40, temp: 6, swim: 8, lava: 60 };

class Heap {
    constructor() { this.a = []; }
    push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= n.f) break; a[i] = a[p]; i = p; } a[i] = n; }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < (m === i ? last.f : a[m].f)) m = l; if (r < a.length && a[r].f < (m === i ? last.f : a[m].f)) m = r; if (m === i) break; a[i] = a[m]; i = m; } a[i] = last; } return top; }
    get size() { return this.a.length; }
}

/** The world as movement sees it: what a cell holds, with the changes a plan makes on its way (dug cells are air, temporary blocks stand). */
class View {
    constructor(bot, rules) { this.bot = bot; this.rules = rules; this.over = new Map(); this.cache = new Map(); }
    raw(x, y, z) {
        const k = key(x, y, z);
        let b = this.cache.get(k);
        if (b === undefined) { b = this.bot.blockAt(new Vec3(x, y, z), false); this.cache.set(k, b); }
        return b;
    }
    /** 'free' (a body can be in it), 'solid' (it stands on it / bumps into it), 'avoid' or 'unknown'. */
    kind(x, y, z) {
        const o = this.over.get(key(x, y, z));
        if (o) return o;
        const b = this.raw(x, y, z);
        if (!b) return 'unknown';
        if (AVOID_IN.test(b.name)) return 'avoid';
        if (b.boundingBox === 'empty') return b.name === 'water' ? 'water' : 'free';
        return 'solid';
    }
    free(x, y, z) { const k = this.kind(x, y, z); return k === 'free' || k === 'water'; }
    fits(x, y, z) { return this.free(x, y, z) && this.free(x, y + 1, z); }
    /** Can a body stand on the block at (x, y, z) (its top at the cell's top)? */
    stands(x, y, z) {
        const o = this.over.get(key(x, y, z));
        if (o === 'solid') return true;
        if (o) return false;
        const b = this.raw(x, y, z);
        if (!b || b.boundingBox !== 'block' || NO_STAND.test(b.name)) return false;
        const top = Math.max(...(b.shapes || []).map((s) => s[4]));
        return top >= 0.85 && top <= 1 + 1e-6;                    // a full top, or nearly (soul sand, mud, a dirt path, farmland, a chest)
    }
    /** Lava beside the body's two cells (a slip or a flow takes the bot) or under the feet (one or two down: a fall). Lava next to the floor block is no danger. */
    nearLava(x, y, z) {
        const k = key(x, y, z); let v = this.lavaNear && this.lavaNear.get(k);
        if (v !== undefined) return v;
        v = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [0, -1, 0], [0, -2, 0], [0, 2, 0]]) { const b = this.raw(x + dx, y + dy, z + dz); if (b && (b.name === 'lava' || b.name === 'fire')) { v = true; break; } }
        (this.lavaNear = this.lavaNear || new Map()).set(k, v);
        return v;
    }
    diggable(x, y, z) {
        if (this.kind(x, y, z) !== 'solid') return false;
        const b = this.raw(x, y, z);
        return !!b && this.rules.canDig(x, y, z, b);
    }
    // with the tool the dig will use, not what the hand holds now (priced with a held bed or dirt, stone cost 150 ticks and a 9-block tunnel lost to searching 30 000 surface cells, live 2026-11-22)
    digTicks(x, y, z) {
        const b = this.raw(x, y, z); if (!b) return Infinity;
        const tool = toolFor(this.bot, b);
        try { return Math.ceil(b.digTime(tool ? tool.type : null, false, false, false, [], {}) / 50) + 2; } catch (_) { return 40; }
    }
}

/**
 * A plan from the bot's feet cell to a cell `goal(x, y, z)` accepts (h: a heuristic point). Returns [{ x, y, z, move, dig: [cells], place: cell | null }] (the first entry is the start) or null.
 * `temps`: how many temporary blocks the plan may use.
 */
async function plan(view, start, goal, h, { maxNodes = 40000, temps = 0, box = null, budgetMs = 4000 } = {}) {
    const open = new Heap(), best = new Map();
    // height to gain costs about a pillar step each (a weaker estimate searched whole hillsides before climbing 17 blocks to a tree top, live 2026-11-22)
    const hh = (x, y, z) => (Math.abs(x - h.x) + Math.abs(z - h.z)) * COST.walk * 0.9 + (h.y > y ? (h.y - y) * (temps > 0 ? COST.pillar + COST.temp : COST.up) * 0.9 : (y - h.y) * COST.drop * 0.5);
    open.push({ x: start.x, y: start.y, z: start.z, g: 0, f: hh(start.x, start.y, start.z), t: 0, p: null, move: 'start' });
    best.set(key(start.x, start.y, start.z), 0);
    const inBox = (x, y, z) => !box || (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1);
    let n = 0, spent = 0, slice = Date.now();
    while (open.size && n++ < maxNodes) {
        // a long search gives the event loop back every 1500 nodes and ends after `budgetMs` of its own time (a synchronous search froze the work console for 25 s, live 2026-11-22)
        if (n % 1500 === 0) { spent += Date.now() - slice; if (spent > budgetMs) { plan.last = { why: 'time', nodes: n }; return null; } await new Promise((r) => setImmediate(r)); slice = Date.now(); }
        const c = open.pop();
        if (goal(c.x, c.y, c.z)) { const out = []; for (let q = c; q; q = q.p) out.push({ x: q.x, y: q.y, z: q.z, move: q.move, dig: q.dig || null, place: q.place || null }); return out.reverse(); }
        if ((best.get(key(c.x, c.y, c.z)) ?? Infinity) < c.g) continue;
        const add = (x, y, z, cost, move, extra = {}) => {
            if (!inBox(x, y, z)) return;
            if (view.nearLava(x, y, z)) return;                             // never a cell beside or over lava (a slip, a flow, a push: a cost was not enough, bots died in the Nether's lava sea, live 2026-11-22)
            const t = c.t + (extra.place ? 1 : 0);
            if (t > temps) return;
            const g = c.g + cost, k = key(x, y, z);
            if (g >= (best.get(k) ?? Infinity)) return;
            best.set(k, g);
            open.push({ x, y, z, g, f: g + hh(x, y, z), t, p: c, move, ...extra });
        };
        const headFree = view.free(c.x, c.y + 2, c.z);
        // swimming: from a cell in water (or into water, or out of it onto something to stand on) in the six directions
        const wetHere = view.kind(c.x, c.y, c.z) === 'water';
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
            const x = c.x + dx, y = c.y + dy, z = c.z + dz;
            if (!view.fits(x, y, z)) continue;
            const wetThere = view.kind(x, y, z) === 'water';
            if (!(wetHere || wetThere)) continue;
            if (!wetThere && !view.stands(x, y - 1, z)) continue;
            add(x, y, z, COST.swim, 'swim');
        }
        for (const [dx, dz] of H) {
            const x = c.x + dx, z = c.z + dz, diag = dx && dz;
            if (diag && !(view.fits(c.x + dx, c.y, c.z) && view.fits(c.x, c.y, c.z + dz))) continue;
            // walk on the same level
            if (view.fits(x, c.y, z)) {
                if (view.stands(x, c.y - 1, z)) { add(x, c.y, z, diag ? COST.diag : COST.walk, 'walk'); continue; }
                // drop down 1..3 onto something
                let landed = false;
                for (let k = 1; k <= 3 && !diag; k++) { if (!view.free(x, c.y - k, z)) { if (view.stands(x, c.y - k, z)) { add(x, c.y - k + 1, z, COST.drop + k, 'drop'); landed = true; } break; } }
                if (!landed && !diag) { if (view.free(x, c.y - 1, z) && view.kind(x, c.y - 1, z) !== 'water' && view.stands(c.x, c.y - 1, c.z) && P.full(blk(view, c.x, c.y - 1, c.z))) add(x, c.y, z, COST.bridge + COST.temp, 'bridge', { place: { x, y: c.y - 1, z } }); }
                continue;
            }
            if (diag) continue;
            // step up one
            if (headFree && view.fits(x, c.y + 1, z) && view.stands(x, c.y, z)) { add(x, c.y + 1, z, COST.up, 'up'); continue; }
            // break what is in the way (one or two cells) and walk on
            const d0 = !view.free(x, c.y, z), d1 = !view.free(x, c.y + 1, z);
            if ((!d0 || view.diggable(x, c.y, z)) && (!d1 || view.diggable(x, c.y + 1, z)) && view.stands(x, c.y - 1, z)) {
                const dig = []; let cost = COST.walk;
                if (d0) { dig.push({ x, y: c.y, z }); cost += view.digTicks(x, c.y, z); }
                if (d1) { dig.push({ x, y: c.y + 1, z }); cost += view.digTicks(x, c.y + 1, z); }
                add(x, c.y, z, cost, 'walk', { dig });
            }
        }
        // pillar up on a temporary block (head room first, broken when diggable)
        if (temps > c.t && view.kind(c.x, c.y + 2, c.z) !== 'avoid' && (headFree || view.diggable(c.x, c.y + 2, c.z))) add(c.x, c.y + 1, c.z, COST.pillar + COST.temp + (headFree ? 0 : view.digTicks(c.x, c.y + 2, c.z)), 'pillar', { place: { x: c.x, y: c.y, z: c.z }, dig: headFree ? null : [{ x: c.x, y: c.y + 2, z: c.z }] });
        // dig down one (the block under the feet), onto the one under it
        if (view.diggable(c.x, c.y - 1, c.z) && view.stands(c.x, c.y - 2, c.z)) add(c.x, c.y - 1, c.z, COST.drop + view.digTicks(c.x, c.y - 1, c.z), 'down', { dig: [{ x: c.x, y: c.y - 1, z: c.z }] });
    }
    plan.last = { why: open.size ? 'nodes' : 'no more cells', nodes: n };
    return null;
}
const blk = (view, x, y, z) => { const b = view.raw(x, y, z); return b ? { name: b.name, props: {}, shapes: b.shapes || [] } : null; };

/** The tool for block (its material: mineable/pickaxe, shovel, axe, hoe; shears for leaves, wool, cobwebs), the best tier the bot carries, or null. */
const TIER = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];
function toolFor(bot, block) {
    const m = String(block.material || ''), cls = /pickaxe/.test(m) ? 'pickaxe' : /shovel/.test(m) ? 'shovel' : /axe/.test(m) ? 'axe' : /hoe/.test(m) ? 'hoe' : /leaves|wool|cobweb/.test(block.name) ? 'shears' : null;
    if (!cls) return null;
    const cand = bot.inventory.items().filter((i) => (cls === 'shears' ? i.name === 'shears' : i.name.endsWith('_' + cls)));
    cand.sort((x, y) => TIER.indexOf(x.name.split('_')[0]) - TIER.indexOf(y.name.split('_')[0]));
    return cand[0] || null;
}

/** The feet cell of the bot. */
function feet(bot) { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y + 0.16), z: Math.floor(p.z) }; }      // + 0.16: standing on a block a little lower than a full one (soul sand 0.875) is standing on its cell

/** The mover of one bot. */
class Mover {
    constructor(bot, rules, { log = () => {} } = {}) { this.bot = bot; this.rules = rules; this.log = log; this.trace = []; }
    view() { return new View(this.bot, this.rules); }

    /** Look along (yaw, pitch) and let the server have it (it applies a look a tick after it arrives). */
    async look(yaw, pitch) { await this.bot.look(yaw, pitch, true); await sleep(110); }
    async lookAtPoint(p) { const e = this.bot.entity.position.offset(0, this.bot.entity.eyeHeight || 1.62, 0); await this.look(Math.atan2(-(p.x - e.x), -(p.z - e.z)), Math.atan2(p.y - e.y, Math.hypot(p.x - e.x, p.z - e.z))); }

    async hold(item) {
        const b = this.bot;
        if (b.heldItem && b.heldItem.name === item) return true;
        const it = b.inventory.items().find((i) => i.name === item);
        if (!it) return false;
        try { await b.equip(it, 'hand'); } catch (_) { return false; }
        return !!(b.heldItem && b.heldItem.name === item);
    }

    /** An empty hand (clicks on blocks: a note block, a repeater, a gate). */
    async holdNothing() {
        const b = this.bot;
        if (!b.heldItem) return true;
        for (let i = 0; i < 9; i++) if (!b.inventory.slots[36 + i]) { b.setQuickBarSlot(i); await sleep(60); return true; }
        try { await b.unequip('hand'); } catch (_) { /* a full pack: the click goes with the item */ }
        return !b.heldItem;
    }

    /** Place item `name` into cell c from where the bot stands (a face it sees; any orientation). Returns true, or a string: why not. */
    async placeItem(name, c, props = {}) {
        if (!(await this.hold(name))) return `cannot hold ${name}`;
        const world = P.botWorld(this.bot), me = feet(this.bot);
        const w = P.ways(world, c, { name, props }, name, [me], { max: 1 })[0] || P.ways(world, c, { name, props }, name, [me], { max: 1, sneakAlways: true })[0];
        if (!w) return `no face in sight from ${me.x},${me.y},${me.z}`;
        await this.click(w.n, w.face, w.hit, { sneak: w.sneak });
        for (let i = 0; i < 10; i++) { const bb = this.bot.blockAt(new Vec3(c.x, c.y, c.z), false); if (bb && bb.name === name) return true; await sleep(50); }
        const bb = this.bot.blockAt(new Vec3(c.x, c.y, c.z), false);
        return `clicked face ${w.face} of ${w.n.join(',')}, the cell holds ${bb && bb.name}`;
    }

    /** Break the block at c with the tool its material asks for (mineable/pickaxe, shovel, axe, hoe; the best tier the bot carries; shears for leaves and wool). */
    async dig(c) {
        const b = this.bot, block = b.blockAt(new Vec3(c.x, c.y, c.z), false);
        if (!block || block.boundingBox === 'empty' && block.name !== 'fire') return true;
        const tool = toolFor(b, block);
        if (tool && (!b.heldItem || b.heldItem.name !== tool.name)) { try { await b.equip(tool, 'hand'); } catch (_) { /* the hand it has */ } }
        else if (!tool && b.heldItem && /(_sword|_pickaxe|_axe|_shovel|_hoe)$/.test(b.heldItem.name) === false) { /* any item: breaking by hand is the same */ }
        try { await b.dig(block, true); } catch (e) { return false; }
        const after = b.blockAt(new Vec3(c.x, c.y, c.z), false);
        return !after || after.boundingBox === 'empty';
    }

    /** A click on face `face` of block n at point `hit` (a vanilla use packet), looking at the point first. */
    async click(n, face, hit, { sneak = false } = {}) {
        const b = this.bot;
        if (sneak) { b.setControlState('sneak', true); await sleep(60); }
        await this.lookAtPoint(new Vec3(hit[0], hit[1], hit[2]));
        b._client.write('block_place', { hand: 0, location: new Vec3(n[0], n[1], n[2]), direction: V.FACE[face], cursorX: hit[0] - n[0], cursorY: hit[1] - n[1], cursorZ: hit[2] - n[2], insideBlock: false, worldBorderHit: false, sequence: (this.seq = (this.seq || 0) + 1) });
        b.swingArm();
        await sleep(120);
        if (sneak) { b.setControlState('sneak', false); await sleep(60); }
    }

    /** Place the temporary block into cell c from where the bot stands (a face of a neighbour it sees). */
    async placeTemp(c) {
        const item = this.rules.temp();
        if (!item || !(await this.hold(item))) return false;
        const world = P.botWorld(this.bot), me = feet(this.bot);
        const st = [me];
        const w = P.ways(world, c, { name: item, props: {} }, item, st, { max: 1 })[0] || P.ways(world, c, { name: item, props: {} }, item, st, { max: 1, sneakAlways: true })[0];
        if (!w) return false;
        await this.click(w.n, w.face, w.hit, { sneak: w.sneak });
        for (let i = 0; i < 10; i++) { const bb = this.bot.blockAt(new Vec3(c.x, c.y, c.z), false); if (bb && bb.boundingBox === 'block') { this.rules.onTemp(c); return true; } await sleep(50); }
        return false;
    }

    /** Walk the body to the centre of cell c (same level or a step), with the bot's physics. */
    async walkTo(c, { jump = false, sneak = false, timeout = 2500 } = {}) {
        const b = this.bot, t0 = Date.now(), tx = c.x + 0.5, tz = c.z + 0.5;
        b.setControlState('sneak', sneak);
        try {
            for (;;) {
                const p = b.entity.position, dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
                if (d < 0.18 && Math.abs(p.y - c.y) < 0.6 && b.entity.onGround) break;
                if (Date.now() - t0 > timeout) return false;
                await b.look(Math.atan2(-dx, -dz), b.entity.pitch, true);
                b.setControlState('forward', d > 0.12);
                b.setControlState('sprint', false);
                b.setControlState('jump', jump && b.entity.onGround && p.y < c.y - 0.5);
                await sleep(50);
            }
        } finally { b.setControlState('forward', false); b.setControlState('jump', false); b.setControlState('sneak', false); }
        for (let i = 0; i < 10 && Math.hypot(b.entity.velocity.x, b.entity.velocity.z) > 0.02; i++) await sleep(50);
        return true;
    }

    /** Pillar: jump and put the temporary block into the cell the feet leave. */
    async pillar(c) {
        const b = this.bot, below = { x: c.x, y: c.y - 1, z: c.z }, item = this.rules.temp();
        if (!item || !(await this.hold(item))) return false;
        const p = b.entity.position;
        if (Math.hypot(below.x + 0.5 - p.x, below.z + 0.5 - p.z) > 0.2) await this.walkTo(below, { sneak: true, timeout: 1500 });          // from the cell's centre, or the block lands in the body
        await this.look(b.entity.yaw, -Math.PI / 2);
        b.setControlState('jump', true);
        let placed = false;
        for (let i = 0; i < 30 && !placed; i++) {
            await sleep(50);
            if (b.entity.position.y > below.y + 1.12 && b.entity.velocity.y > -0.2) {
                b._client.write('block_place', { hand: 0, location: new Vec3(below.x, below.y - 1, below.z), direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: (this.seq = (this.seq || 0) + 1) });
                b.swingArm(); placed = true;
            }
        }
        b.setControlState('jump', false);
        for (let i = 0; i < 30; i++) { await sleep(50); if (b.entity.onGround && b.entity.position.y >= c.y - 0.01) break; }
        const bb = b.blockAt(new Vec3(below.x, below.y, below.z), false);
        if (bb && bb.boundingBox === 'block') this.rules.onTemp(below);
        return feet(b).y === c.y;
    }

    /** Do one planned step from the cell before it. */
    async step(prev, s) {
        for (const d of s.dig || []) if (!(await this.dig(d))) return { ok: false, why: `dig ${d.x},${d.y},${d.z}` };
        if (s.move === 'walk') return (await this.walkTo(s)) ? { ok: true } : { ok: false, why: 'walk' };
        if (s.move === 'up') return (await this.walkTo(s, { jump: true })) ? { ok: true } : { ok: false, why: 'up' };
        if (s.move === 'drop') { const ok = await this.walkTo(s, { timeout: 3500 }); return ok ? { ok: true } : { ok: false, why: 'drop' }; }
        if (s.move === 'down') { for (let i = 0; i < 30 && feet(this.bot).y > s.y; i++) await sleep(50); return feet(this.bot).y === s.y ? { ok: true } : { ok: false, why: 'down' }; }
        if (s.move === 'pillar') return (await this.pillar(s)) ? { ok: true } : { ok: false, why: 'pillar' };
        if (s.move === 'bridge') {
            // sneak out over the edge (the body keeps 0.05 on the support), then click the support's side face toward the gap: its block goes under the next cell
            const b = this.bot, dx = s.x - prev.x, dz = s.z - prev.z, item = this.rules.temp();
            if (!item || !(await this.hold(item))) return { ok: false, why: 'bridge: no temporary block' };
            const edge = { x: prev.x + 0.5 + dx * 0.75, z: prev.z + 0.5 + dz * 0.75 };
            b.setControlState('sneak', true);
            try {
                for (let i = 0; i < 60; i++) {
                    const p = b.entity.position, ex = edge.x - p.x, ez = edge.z - p.z;
                    if (Math.abs(ex * dx + ez * dz) < 0.04 || (ex * dx + ez * dz) < 0) break;
                    await b.look(Math.atan2(-dx, -dz), 0, true); b.setControlState('forward', true); await sleep(50);
                }
                b.setControlState('forward', false);
                await sleep(150);
                const p = b.entity.position, eye = [p.x, p.y + 1.27, p.z], sup = [prev.x, prev.y - 1, prev.z];
                const face = dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north';
                const plane = [sup[0] + 0.5 + dx * 0.4999, 0, sup[2] + 0.5 + dz * 0.4999];
                const hit = [dx ? plane[0] : sup[0] + 0.5, sup[1] + 0.5, dz ? plane[2] : sup[2] + 0.5];
                const r = P.rayFirst(P.botWorld(b), eye, hit);
                if (!r || r.cell[0] !== sup[0] || r.cell[1] !== sup[1] || r.cell[2] !== sup[2]) return { ok: false, why: 'bridge: the support side is not in sight' };
                await this.lookAtPoint(new Vec3(...hit));
                b._client.write('block_place', { hand: 0, location: new Vec3(...sup), direction: V.FACE[face], cursorX: hit[0] - sup[0], cursorY: hit[1] - sup[1], cursorZ: hit[2] - sup[2], insideBlock: false, worldBorderHit: false, sequence: (this.seq = (this.seq || 0) + 1) });
                b.swingArm();
                await sleep(200);
            } finally { b.setControlState('forward', false); b.setControlState('sneak', false); }
            const bb = b.blockAt(new Vec3(s.place.x, s.place.y, s.place.z), false);
            if (!bb || bb.boundingBox !== 'block') return { ok: false, why: 'bridge place' };
            this.rules.onTemp(s.place);
            return (await this.walkTo(s)) ? { ok: true } : { ok: false, why: 'bridge walk' };
        }
        return { ok: false, why: `unknown move ${s.move}` };
    }

    /**
     * Follow a run of ground moves (walk, diagonal, up, drop) without stopping in between: steer at the next cell's centre, take it when within 0.35 (the last one: 0.15),
     * jump just before a step up. Ends when the bot leaves the run's cells (the caller plans again). Returns the index reached.
     */
    async follow(route, i0, i1, cancel) {
        const b = this.bot, cells = new Set(route.slice(Math.max(0, i0 - 1), i1 + 1).map((c) => key(c.x, c.y, c.z)));
        let i = i0, t0 = Date.now(), stuck = 0, lastD = Infinity;
        try {
            while (i <= i1 && !cancel.cancelled) {
                const c = route[i], last = i === i1, p = b.entity.position, dx = c.x + 0.5 - p.x, dz = c.z + 0.5 - p.z, d = Math.hypot(dx, dz);
                const f = feet(b);
                if (b.entity.onGround && !cells.has(key(f.x, f.y, f.z)) && !cells.has(key(f.x, f.y - 1, f.z)) && ![...cells].some((k) => { const [x, y, z] = k.split(',').map(Number); return Math.abs(x - f.x) <= 1 && Math.abs(z - f.z) <= 1 && Math.abs(y - f.y) <= 1; })) return { i, why: `off the route at ${f.x},${f.y},${f.z}` };
                if (d < (last ? 0.15 : 0.35) && (Math.abs(p.y - c.y) < 0.6 || (b.entity.isInWater && route[i].move === 'swim' && Math.abs(p.y - c.y) < 1.0))) { i++; t0 = Date.now(); stuck = 0; lastD = Infinity; continue; }
                if (Date.now() - t0 > 4000) { const nm = (dy) => { const q = b.blockAt(new Vec3(c.x, c.y + dy, c.z), false); return q ? q.name : '?'; }; return { i, why: `no progress toward ${c.x},${c.y},${c.z} (${route[i].move}; there ${nm(-1)}/${nm(0)}/${nm(1)}; bot at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ground ${b.entity.onGround})` }; }
                if (d > lastD - 0.005) stuck++; else stuck = 0;
                lastD = d;
                b.look(Math.atan2(-dx, -dz), 0, true);
                b.setControlState('forward', true);
                b.setControlState('sprint', false);
                const up = c.y > f.y && route[i].move === 'up', wet = b.entity.isInWater;
                // in water: up (jump) to rise or to stay at the surface, nothing to sink
                b.setControlState('jump', wet ? c.y >= f.y : ((up && d < 1.4 && b.entity.onGround) || (stuck > 6 && b.entity.onGround && c.y >= f.y)));
                b.setControlState('sneak', last && d < 0.6 && route[i].move !== 'drop' && c.y >= f.y);          // a careful last step, but never before a drop (sneak stops at the edge)
                await sleep(50);
            }
        } finally { for (const k of ['forward', 'jump', 'sneak', 'sprint']) b.setControlState(k, false); }
        for (let k = 0; k < 10 && Math.hypot(b.entity.velocity.x, b.entity.velocity.z) > 0.03; k++) await sleep(50);
        return { i };
    }

    /**
     * Go to a cell `goal` accepts (or `to` itself). Plans, follows, re-plans when the bot leaves the plan (up to `tries`). { ok, why, steps }.
     */
    async goto(to, { goal = null, cancel = { cancelled: false }, tries = 6, maxNodes = 40000, box = null } = {}) {
        const g = goal || ((x, y, z) => x === to.x && y === to.y && z === to.z);
        let steps = 0, last = null;
        for (let t = 0; t < tries && !cancel.cancelled; t++) {
            const start = feet(this.bot);
            if (g(start.x, start.y, start.z)) return { ok: true, steps };
            const view = new View(this.bot, this.rules), temps = this.rules.temp() ? this.bot.inventory.items().filter((i) => i.name === this.rules.temp()).reduce((a, i) => a + i.count, 0) : 0;
            // the bot's own cell not loaded yet (after a teleport, a respawn): wait for the chunks
            if (view.kind(start.x, start.y, start.z) === 'unknown') { await sleep(1000); continue; }
            const route = await plan(view, start, g, to, { maxNodes, temps, box });
            if (!route) {
                const l = plan.last || {};
                // nothing at all from where the bot believes it is (its picture of its own position is off: live 2026-11-22 the server had it on the chest, the bot a cell higher):
                // a jump lets the physics and the server's correction settle it, then plan again
                if (l.nodes <= 2 && t < tries - 1) { this.bot.setControlState('jump', true); await sleep(350); this.bot.setControlState('jump', false); await sleep(700); continue; }
                return { ok: false, why: `no plan (${l.why}, ${l.nodes} cells from ${start.x},${start.y},${start.z}; ${temps} ${this.rules.temp()}; goal ${view.kind(to.x, to.y, to.z)}/${view.kind(to.x, to.y + 1, to.z)} over ${view.kind(to.x, to.y - 1, to.z)}${view.stands(to.x, to.y - 1, to.z) ? ' stands' : ''}${view.nearLava(to.x, to.y, to.z) ? ' lava' : ''})`, from: start, steps };
            }
            let i = 1, broke = false;
            while (i < route.length && !cancel.cancelled) {
                const s = route[i];
                if (['walk', 'up', 'drop', 'swim'].includes(s.move) && !(s.dig && s.dig.length)) {
                    let j = i; while (j + 1 < route.length && ['walk', 'up', 'drop', 'swim'].includes(route[j + 1].move) && !(route[j + 1].dig && route[j + 1].dig.length)) j++;
                    const r = await this.follow(route, i, j, cancel);
                    steps += r.i - i;
                    if (r.i <= j) { last = r.why; broke = true; break; }
                    i = j + 1; continue;
                }
                const r = await this.step(route[i - 1], s), at = feet(this.bot);
                if (!r.ok || at.x !== s.x || at.z !== s.z || at.y !== s.y) { last = r.ok ? `ended at ${at.x},${at.y},${at.z} not ${s.x},${s.y},${s.z} (${s.move})` : r.why; broke = true; break; }
                steps++; i++;
            }
            if (!broke && !cancel.cancelled) { const f = feet(this.bot); if (g(f.x, f.y, f.z)) return { ok: true, steps }; }
        }
        return { ok: false, why: last || 'cancelled', steps };
    }
}

module.exports = { Mover, View, plan, feet, COST };

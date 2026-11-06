'use strict';
// One-off commands to single bots (the Commands page), bot detail, nearby entities, containers, leave-pit.
// A part of WorkService (index.js copies these methods onto it).
const inventory = require('../operator/inventory');
const gatherer = require('../jobs/gather');
const { catalog } = require('../operator/catalog');
const skills = require('../../skills');
const { Problem, need, int } = require('./common');

class CommandsPart {
    catalog() { return catalog(); }

    _online(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        need(rec.state === 'online' && rec.bot, `bot ${name} is ${rec.state}`, 409);
        return rec;
    }

    /**
     * Send one command to some bots. `bots`: a list of names, or 'all' (every online bot that is free). Each bot runs it on its own; the
     * call returns at once with who started and who refused (and why). Progress and results are in the bot view (`cmd`).
     */
    async runCommand({ bots, command, args = {} }) {
        const spec = catalog().find((c) => c.name === command);
        need(spec, `unknown command ${JSON.stringify(String(command).slice(0, 40))}`);
        need(args && typeof args === 'object' && !Array.isArray(args), 'args must be an object');
        let names;
        if (bots === 'all') names = [...this.bots.values()].filter((r) => !r.removed && r.state === 'online').map((r) => r.name);
        else { need(Array.isArray(bots) && bots.length && bots.length <= this.o.maxBots, 'bots: a list of names or "all"'); names = bots.map(String); }
        need(names.length, 'no bot is online', 409);
        if (spec.rcon) need(this.o.rcon, 'this command needs RCON', 503);
        const link = this._link(command, args);                 // a machine's coordinates -> its container (links.js); refused verbs throw
        args = link.args;
        const started = [], refused = [];
        for (const n of names) {
            const rec = this.bots.get(n);
            if (!rec || rec.removed) { refused.push({ name: n, why: 'no such bot' }); continue; }
            if (rec.state !== 'online') { refused.push({ name: n, why: rec.state }); continue; }
            if (command === 'stop') { if (rec.cmd && rec.cmd.status === 'running') rec.cmd.cancel.cancelled = true; started.push(n); continue; }
            if (rec.worker) { refused.push({ name: n, why: `works on job ${rec.job} (pause the job or take the bot off it)` }); continue; }
            if (rec.cmd && rec.cmd.status === 'running') { refused.push({ name: n, why: `busy with ${rec.cmd.name} (send Stop first)` }); continue; }
            if (spec.args.length) { try { this._checkArgs(spec, args); } catch (e) { refused.push({ name: n, why: e.message }); continue; } }
            this._exec(rec, command, args, link.via);
            started.push(n);
        }
        this._dirty();
        return { started, refused, ...(link.via.length ? { via: link.via } : {}) };
    }

    _checkArgs(spec, args) {
        if (spec.meta) {
            if (spec.name === 'say') { need(typeof args.text === 'string' && args.text.trim().length && args.text.length <= 100, 'text: 1-100 characters'); need(!args.text.trim().startsWith('/'), 'text must not start with /'); }
            if (spec.name === 'teleport') {
                const xyz = ['x', 'y', 'z'].filter((k) => args[k] !== undefined);
                need((args.player && inventory.NAME.test(String(args.player))) || xyz.length === 3, 'give a player or all of x, y, z');
                for (const k of xyz) int(args[k], k);
            }
            if (spec.name === 'gather') {
                need(typeof args.target === 'string' && /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/.test(args.target), 'target: a block or item name such as iron_ore, raw_iron, oak_log');
                if (args.count !== undefined) need(Number.isInteger(args.count) && args.count >= 1 && args.count <= 2304, 'count: 1..2304');
                if (args.radius !== undefined) need(Number.isInteger(args.radius) && args.radius >= 4 && args.radius <= 64, 'radius: 4..64');
            }
            if (spec.name === 'come' && args.player !== undefined) need(inventory.NAME.test(String(args.player)), 'player name');
            return;
        }
        try { skills.validateArgs(spec.name, args); } catch (e) { throw new Problem(`${e.detail && e.detail.why ? e.detail.why : e.reason || e.message}`); }
    }

    _exec(rec, command, args, via = []) {
        const cancel = { cancelled: false }, id = ++this.cmdSeq, t0 = Date.now();
        rec.cmd = { id, name: command, args, via, status: 'running', started: t0, cancel, result: null };
        const bot = rec.bot;
        const finish = (res) => {
            if (!rec.cmd || rec.cmd.id !== id) return;
            const ok = res && res.ok !== false;
            rec.cmd.status = cancel.cancelled && !ok ? 'cancelled' : ok ? 'ok' : 'failed';
            rec.cmd.result = { ok, reason: ok ? null : (res && res.reason) || 'error', detail: res && res.detail ? JSON.stringify(res.detail).slice(0, 240) : null, ms: Date.now() - t0 };
            rec.history = [{ id, name: command, args, status: rec.cmd.status, ms: rec.cmd.result.ms, reason: rec.cmd.result.reason, at: t0 }, ...(rec.history || [])].slice(0, 12);
            this.note('debug', `${rec.name} ${command} ${rec.cmd.status}`, { args });
            this._dirty();
        };
        (async () => {
            if (command === 'say') { bot.chat(String(args.text)); return { ok: true }; }
            if (command === 'teleport') {
                const dest = args.player ? String(args.player) : `${args.x} ${args.y} ${args.z}`;
                const r = String(await this.rcon(`tp ${rec.name} ${dest}`)).replace(/\x1b\[[0-9;]*m/g, '');
                return /^Teleported/i.test(r.trim()) ? { ok: true } : { ok: false, reason: 'refused', detail: { server: r.trim().slice(0, 120) } };
            }
            if (command === 'gather') {
                return gatherer.gather(bot, { target: String(args.target), count: args.count || 16, radius: args.radius || 32 }, {
                    cancel, execute: (b, n, a, o) => skills.execute(b, n, a, o),
                    onProgress: (p) => { if (rec.cmd && rec.cmd.id === id) rec.cmd.progress = p; },
                });
            }
            if (command === 'come') {
                const players = await this.players(), p = args.player ? players.find((q) => q.name === args.player) : players.find((q) => !q.bot && q.pos);
                if (!p || !p.pos) return { ok: false, reason: 'invalid_target', detail: { why: 'no operator position (is the player online?)' } };
                return skills.execute(bot, 'move_to', { x: p.pos.x, y: p.pos.y, z: p.pos.z }, { cancel });
            }
            // The operator's move_to climbs when there is no way up on foot (a pillar of temporary blocks, taken away again; moves.js climbTo).
            // The action layer's own move_to, the one the RL policy has, is unchanged.
            if (command === 'move_to') {
                const env = this.envFactory(bot, cancel);
                if (env && env.climb) { const r = await env.climb({ x: args.x, y: args.y, z: args.z }); return r.ok ? { ok: true, detail: { how: r.how, levels: r.levels } } : r; }
            }
            return skills.execute(bot, command, args, { cancel });
        })().then(finish, (e) => finish({ ok: false, reason: 'error', detail: { message: String(e.message).slice(0, 160) } }));
    }

    botDetail(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        const v = this._botView(rec), b = rec.bot;
        const held = b && rec.state === 'online' && b.heldItem ? { id: b.heldItem.name, count: b.heldItem.count } : null;
        return { ...v, held, history: rec.history || [], cmdArgs: rec.cmd ? rec.cmd.args : null, game: b && rec.state === 'online' && b.game ? { mode: b.game.gameMode, dimension: b.game.dimension } : null };
    }

    /** Entities near a bot (for attack / pickup / look_at): nearest first. */
    nearbyEntities(name, radius = 32) {
        const rec = this._online(name), me = rec.bot.entity.position, out = [];
        for (const e of Object.values(rec.bot.entities || {})) {
            if (!e || e === rec.bot.entity || !e.position) continue;
            const d = e.position.distanceTo(me); if (d > radius) continue;
            const item = e.name === 'item' && e.metadata ? (e.getDroppedItem ? e.getDroppedItem() : null) : null;
            out.push({ id: e.id, type: e.name || e.type, kind: e.type, username: e.username || null, item: item ? item.name : null, dist: Math.round(d * 10) / 10, pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) } });
        }
        return out.sort((a, b) => a.dist - b.dist).slice(0, 40);
    }

    /** Container blocks in the chunks a bot has loaded, within `radius` of it (for the inventory GUI). */
    containersNear(name, radius = 24) {
        const rec = this._online(name), b = rec.bot;
        const pos = b.findBlocks({ matching: (blk) => !!blk && inventory.CONTAINER.test(blk.name), maxDistance: Math.min(64, radius), count: 60 });
        return pos.map((p) => ({ x: p.x, y: p.y, z: p.z, block: b.blockAt(p)?.name || '?', site: (this.sites.at(p.x, p.y, p.z) || {}).name || null }));
    }

    /** What `gather` would find for a target around a bot (the page's Find button). */
    survey(name, target, radius = 32) {
        const rec = this._online(name);
        need(typeof target === 'string' && /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/.test(target), 'target: a block or item name');
        need(Number.isInteger(radius) && radius >= 4 && radius <= 64, 'radius: 4..64');
        return gatherer.survey(rec.bot, target, radius);
    }

    /** Bring a bot out of its pit by the pillar method (idle bots only: pause the job first). */
    async leavePit(name) {
        const rec = this.bots.get(name); need(rec && !rec.removed && rec.state === 'online' && rec.bot, `no online bot ${name}`, 404);
        const job = this._pitOf(rec); need(job, `${name} has no pit job`, 409);
        need(!rec.worker && !rec.script, `${name} is working: pause the job first`, 409);
        const cancel = { cancelled: false }; rec.script = { cancel, name: 'leave-pit' };
        try {
            const env = this.envFactory(rec.bot, cancel); if (env && env.configure) env.configure({ retireWorn: !!this.settings.retireWorn });
            const r = await require('../bot/exit').leavePit(env, job.spec.box);
            this.note(r.ok ? 'info' : 'warn', `${name} leave pit: ${r.ok ? r.how : r.reason}${r.levels ? ` (${r.levels} levels)` : ''}`, { job: job.id });
            return r;
        } finally { rec.script = null; this._dirty(); }
    }
}

module.exports = { CommandsPart };

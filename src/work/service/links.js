'use strict';
// Links between blocks (bot/sites.js `via`): a command or an inventory view aimed at a machine is carried out on the container
// linked to it, the way a symbolic link is followed. Only the verbs that move items through a container are redirected.
const { Problem, need } = require('./common');

const REDIRECT = new Set(['deposit', 'withdraw']);          // item verbs on a container
const NOT_ON_MACHINE = new Set(['smelt', 'craft']);          // verbs that open the block itself: a linked machine has no GUI to open

class LinksPart {
    /**
     * The arguments a command really runs with. `args.site` (a tagged block's name) becomes x, y, z; coordinates that belong to a
     * linked machine become the container's. Returns {args, via} where `via` is the list of names walked (empty = no link).
     */
    _link(command, args) {
        let a = args;
        if (a.site !== undefined) {
            need(typeof a.site === 'string', 'site must be the name of a tagged block');
            const s = this.sites.get(a.site); need(s, `no tagged block ${String(a.site).slice(0, 24)}`);
            a = { ...a, x: s.x, y: s.y, z: s.z }; delete a.site;
        }
        const at = ['x', 'y', 'z'].every((k) => Number.isInteger(a[k])) ? this.sites.at(a.x, a.y, a.z) : null;
        if (!at) return { args: a, via: [] };
        if (NOT_ON_MACHINE.has(command) && (at.via || at.purpose === 'furnace')) {
            throw new Problem(`${at.name} is a machine${at.via ? ` linked to ${at.via}` : ''}: use deposit to put items in and withdraw to take them out (it works on the container, ${command} would open the machine itself)`);
        }
        if (!REDIRECT.has(command) || !at.via) return { args: a, via: [] };
        let end; try { end = this.sites.through(a.x, a.y, a.z); } catch (e) { throw new Problem(e.message); }
        return { args: { ...a, x: end.x, y: end.y, z: end.z }, via: end.via };
    }

    /** The same for an inventory target {type:'block', x, y, z}: a linked machine shows and moves through its container. */
    _linkTarget(t) {
        if (!t || t.type !== 'block' || !['x', 'y', 'z'].every((k) => Number.isInteger(t[k]))) return t;
        let end = null; try { end = this.sites.through(t.x, t.y, t.z); } catch (e) { throw new Problem(e.message); }
        return end ? { ...t, x: end.x, y: end.y, z: end.z } : t;
    }
}

module.exports = { LinksPart };

'use strict';
// Reward v5 (src/rl/reward-v5.json, owner 2026-11-02): episodes of a fixed number of in-game days. Terms: `survival` (each
// dawn reached without a death since the previous one), `death` (per death; play goes on after the respawn), `progress`
// (each entry of the progress list, src/rl/progress-list.json, the first time it is reached in the episode, judged here from
// the player's server statistics) and `invalid` (a command that could not be executed). Pure: it scores progress events
// (src/rl/progress.js) and keeps per-episode counts. The environment sends every term unweighted; the learner weights them.
const TABLE = require('./reward-v5.json');
const LIST = require('./progress-list.json');

const TERMS = ['survival', 'death', 'progress', 'invalid'];
const short = (id) => String(id).replace(/^minecraft:/, '');

// Progress space: one flag per list entry in list order (easiest first), then days survived and days slept (/10, clipped).
// The learner's goals are dimensions of this space.
const ENTRIES = LIST.entries.map((e) => ({ ...e, set: new Set(e.any || []) }));
const MILESTONES = ENTRIES.map((e) => e.id);
const NOTABLE = [];
const PROGRESS_DIM = MILESTONES.length + 2;
const DAYS_SCALE = 10;

class CrafterReward {
    constructor() { this.newEpisode(); }

    newEpisode() {
        this.done = new Set(); this.kills = new Map();
        this.days = 0; this.slept = 0; this.deaths = 0; this.diedToday = false;
    }

    /** Entries an event reaches (statistics deltas from progress.js; `dawn` with slept for the bed entry). */
    static entriesOf(e) {
        if (e.type === 'dawn') return e.slept ? ENTRIES.filter((x) => x.event === 'slept') : [];
        const stat = e.type === 'mined' ? 'mined' : e.type === 'killed' ? 'killed' : e.type === 'stat' ? short(e.stat) : null;
        const name = short(e.type === 'mined' ? e.block : e.type === 'killed' ? e.entity : e.name);
        return stat && e.n > 0 ? ENTRIES.filter((x) => x.stat === stat && x.set.has(name)) : [];
    }

    /** events: [{type:'stat', stat, name, n} | {type:'mined', block, n} | {type:'killed', entity, n} | {type:'dawn', slept} |
     *  {type:'death'} | {type:'failed', reason}]; anything else (advancements, tool) is not scored. */
    score(events) {
        const terms = Object.fromEntries(TERMS.map((t) => [t, 0]));
        for (const e of events) {
            if (e.type === 'death') {
                this.deaths++; this.diedToday = true; terms.death += TABLE.death.penalty;
            } else if (e.type === 'failed') {
                terms.invalid += TABLE.invalid.reasons[e.reason] || 0;
            } else if (e.type === 'killed') {
                this.kills.set(short(e.entity), (this.kills.get(short(e.entity)) || 0) + e.n);
            }
            if (e.type === 'dawn') {
                if (!this.diedToday) { this.days++; if (e.slept) this.slept++; terms.survival += e.slept ? TABLE.survival.day_slept : TABLE.survival.day_awake; }
                this.diedToday = false;
            }
            for (const x of CrafterReward.entriesOf(e)) {
                if (!this.done.has(x.id)) { this.done.add(x.id); terms.progress += TABLE.progress.per_entry; }
            }
        }
        for (const t of TERMS) terms[t] = Math.round(terms[t] * 1e6) / 1e6;
        return { total: Math.round(TERMS.reduce((s, t) => s + terms[t], 0) * 1e6) / 1e6, terms };
    }

    /** This episode's position in the progress space. */
    progress() {
        return [...MILESTONES.map((id) => (this.done.has(id) ? 1 : 0)), Math.min(this.days / DAYS_SCALE, 1), Math.min(this.slept / DAYS_SCALE, 1)];
    }
}

/** Weighted scalar of reward_terms for a stage (the learner does the same in Python). */
function stageReward(terms, stage) {
    const w = TABLE.stages[stage];
    if (!w) throw new Error(`unknown stage ${stage}`);
    return TERMS.reduce((s, t) => s + (w[t] || 0) * (terms[t] || 0), 0);
}

module.exports = { CrafterReward, TABLE, LIST, TERMS, MILESTONES, NOTABLE, PROGRESS_DIM, DAYS_SCALE, stageReward };

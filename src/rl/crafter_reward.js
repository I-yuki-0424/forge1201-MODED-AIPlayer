'use strict';
// Reward v2 (Crafter-style, docs/proposed/RL-TRAINING-v2.md): survival nights, kills, notable kills, mined blocks and
// advancements, each a separate term. Pure: it scores progress events (src/rl/progress.js) and keeps per-episode counts.
// The environment sends every term unweighted; the learner applies the curriculum stage's weights (TABLE.stages).
const TABLE = require('./reward-v2.json');
const ADV = require('../../modpack/forgeaip-create.advancements.json').advancements;

const TERMS = ['survival', 'kills', 'notable', 'mined', 'achievements'];
const short = (id) => String(id).replace(/^minecraft:/, '');

const KILL_CLASS = new Map();
for (const c of ['passive', 'neutral', 'hostile']) for (const e of TABLE.kills[c]) KILL_CLASS.set(e, c);
const MINED = new Map();
for (const t of TABLE.mined.tiers) for (const b of t.blocks) MINED.set(b, t.score);

/** Score of one advancement: per_step * steps (vanilla tree depth) or the namespace's flat score; null = not an achievement. */
function advancementScore(id) {
    const a = ADV[id];
    if (!a) return null;
    const ns = id.split(':')[0];
    return ns in TABLE.achievements.flat ? TABLE.achievements.flat[ns] : TABLE.achievements.per_step * a.steps;
}

// Progress vector: what the player can read on the advancement and statistics screens, in a fixed order. The learner's
// target T lives in the same space (targetVector).
const MILESTONES = Object.keys(ADV).filter((id) => id.startsWith('minecraft:')).sort();
const NOTABLE = Object.keys(TABLE.notable.score).sort();
const PROGRESS_DIM = MILESTONES.length + NOTABLE.length + 2;
const NIGHTS_SCALE = 10;

class CrafterReward {
    constructor() { this.newEpisode(); }

    newEpisode() {
        this.kills = new Map(); this.mined = new Map(); this.done = new Set();
        this.nights = 0; this.slept = 0;
    }

    /** events: [{type:'killed', entity, n}, {type:'mined', block, n}, {type:'advancement', id}, {type:'dawn', slept}, {type:'death'}] */
    score(events) {
        const terms = Object.fromEntries(TERMS.map((t) => [t, 0]));
        for (const e of events) {
            if (e.type === 'dawn') {
                this.nights++; if (e.slept) this.slept++;
                terms.survival += e.slept ? TABLE.survival.night_slept : TABLE.survival.night_awake;
            } else if (e.type === 'death') {
                terms.survival += TABLE.survival.death;
            } else if (e.type === 'killed') {
                const name = short(e.entity), notable = TABLE.notable.score[name];
                for (let i = 0; i < e.n; i++) {
                    const k = this.kills.get(name) || 0;
                    this.kills.set(name, k + 1);
                    if (notable !== undefined) {
                        terms.notable += notable * (TABLE.notable.boss.includes(name) ? 1 : TABLE.notable.decay ** k);
                    } else {
                        const cls = KILL_CLASS.get(name) || 'hostile';
                        terms.kills += TABLE.kills.base * TABLE.kills.class[cls] * TABLE.kills.decay ** k;
                    }
                }
            } else if (e.type === 'mined') {
                const name = short(e.block), base = MINED.get(name) ?? MINED.get(e.block) ?? TABLE.mined.default;
                for (let i = 0; i < e.n; i++) {
                    const k = this.mined.get(name) || 0;
                    this.mined.set(name, k + 1);
                    terms.mined += base * TABLE.mined.decay ** k;
                }
            } else if (e.type === 'advancement') {
                const s = advancementScore(e.id);
                if (s !== null && !this.done.has(e.id)) { this.done.add(e.id); terms.achievements += s; }
            }
        }
        for (const t of TERMS) terms[t] = Math.round(terms[t] * 1e6) / 1e6;
        return { total: Math.round(TERMS.reduce((s, t) => s + terms[t], 0) * 1e6) / 1e6, terms };
    }

    /** This episode's progress in the milestone space (advancement flags, notable kill flags, nights, slept nights). */
    progress() {
        const v = MILESTONES.map((id) => (this.done.has(id) ? 1 : 0));
        for (const n of NOTABLE) v.push(this.kills.get(n) ? 1 : 0);
        v.push(Math.min(this.nights / NIGHTS_SCALE, 1), Math.min(this.slept / NIGHTS_SCALE, 1));
        return v;
    }
}

/** Target T of a curriculum stage in the progress space: 'survive' = ten nights, all slept; 'dragon' = the dragon is dead. */
function targetVector(stage) {
    const v = new Array(PROGRESS_DIM).fill(0);
    if (stage === 'survive') { v[PROGRESS_DIM - 2] = 1; v[PROGRESS_DIM - 1] = 1; }
    else if (stage === 'dragon') { v[MILESTONES.indexOf('minecraft:end/kill_dragon')] = 1; v[MILESTONES.length + NOTABLE.indexOf('ender_dragon')] = 1; }
    else throw new Error(`unknown stage ${stage}`);
    return v;
}

/** Weighted scalar of reward_terms for a stage (the learner does the same in Python). */
function stageReward(terms, stage) {
    const w = TABLE.stages[stage];
    if (!w) throw new Error(`unknown stage ${stage}`);
    return TERMS.reduce((s, t) => s + (w[t] || 0) * (terms[t] || 0), 0);
}

module.exports = { CrafterReward, TABLE, TERMS, MILESTONES, NOTABLE, PROGRESS_DIM, advancementScore, targetVector, stageReward, KILL_CLASS };

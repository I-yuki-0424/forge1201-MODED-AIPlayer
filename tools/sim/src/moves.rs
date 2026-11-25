//! The work layer's own movements (src/work/bot/moves.js `pillar`, `descend`; bridge.js `bridge`) as transitions, for the replay of the T26 corpora
//! (docs/implemented/SIM-PARITY-v1.md). Each one is the move's rule set: what it needs under and over the feet, which block it stacks (the test
//! worlds' temporary block first, TEMP_BLOCK=pumpkin, then the low-value blocks in moves.js / bridge.js order), what it takes away again and where
//! the body ends. Ticks per step are the medians of the corpus (place_b pb-r1, mine_b mb-r1, 1.21.1); what goes wrong in the body's physics
//! (`stuck` while jumping or sneaking over an edge) is not here: that is the packet front end's job.
use crate::data::Kind;
use crate::sim::{dig_ticks, Ev, Out, Sim};

/// Blocks a move may stack, after the test world's temporary block (bridge.js BRIDGE_ITEMS; tempblocks.js BASE starts the same way).
pub const STACK_ITEMS: [&str; 13] = ["cobblestone", "cobbled_deepslate", "netherrack", "end_stone", "blackstone", "dirt", "stone", "andesite", "diorite", "granite", "tuff", "deepslate", "basalt"];
/// Ticks of one pillar level (centre, jump, click at the top, land), one descend level besides its dig (the drop onto the cell below) and one
/// bridge cell (step to the edge, aim at the side face, click, step on; the first cell starts at the edge already): corpus medians (pillar
/// 10 for one level, descend 14 for one level with a 7-tick dig, bridge 16 for one cell and 20.6 per cell over 30).
pub const PILLAR_LEVEL: i64 = 10; pub const DESCEND_LEVEL: i64 = 7; pub const BRIDGE_CELL: i64 = 21; pub const BRIDGE_FIRST: i64 = 16;

impl Sim {
    /// The block a move stacks now: the temporary block when the pack has one, else the first of STACK_ITEMS it has.
    pub fn stack_item(&self, temp: &str) -> Option<String> {
        if !temp.is_empty() && self.count(temp) > 0 { return Some(temp.to_string()); }
        STACK_ITEMS.iter().find(|n| self.count(n) > 0).map(|n| n.to_string())
    }
    fn dig_here(&mut self, c: [i32; 3], ev: &mut Vec<Ev>) -> i64 {
        let bid = match self.blk(c[0], c[1], c[2]) { Some(b) => b, None => return 0 };
        let k = self.dig_plan(bid).map(|p| p.1).unwrap_or(30);
        crate::sim::Sim::break_block_pub(self, c, ev);
        dig_ticks(k)
    }
    /// moves.js pillar {levels}: per level a solid block under the feet, head room (blocks over the head are dug), a block stacked into the feet
    /// cell at the top of the jump, the body one cell up; the block of the level before (two below the feet now) is taken away again.
    pub fn do_pillar(&mut self, levels: i64, temp: &str) -> Out {
        let mut ev = vec![];
        let (mut ticks, mut prev): (i64, Option<[i32; 3]>) = (0, None);
        for i in 0..levels {
            let f = self.pos;
            if self.kind(f[0], f[1] - 1, f[2]) != Kind::Solid { return self.fail_with(if i == 0 { "invalid_target" } else { "invalid_target" }, ticks, ev); }
            for dy in [2, 1] { if !self.is_air(f[0], f[1] + dy, f[2]) { ticks += self.dig_here([f[0], f[1] + dy, f[2]], &mut ev); } }
            let item = match self.stack_item(temp) { Some(i) => i, None => return self.fail_with("missing_item", ticks, ev) };
            let bid = self.d.bid(&item);
            self.take(&item, 1); self.set(f[0], f[1], f[2], bid);
            self.pos = [f[0], f[1] + 1, f[2]]; self.exact = None; self.invalidate();
            ticks += PILLAR_LEVEL;
            if let Some(p) = prev { if self.kind(p[0], p[1], p[2]) == Kind::Solid { ticks += self.dig_here(p, &mut ev); } }
            prev = Some(f);
        }
        let o = Out { ok: true, reason: "ok", ticks, ev: vec![] };
        self.finish_pub(o, ev)
    }
    /// moves.js descend {levels}: per level the block under the feet is dug and the body drops one cell; with air two below, a block is put
    /// there first (against the underside of the block under the feet); on solid ground two below it is the last level.
    pub fn do_descend(&mut self, levels: i64, temp: &str) -> Out {
        let mut ev = vec![];
        let mut ticks = 0;
        for i in 0..levels {
            let f = self.pos;
            if self.kind(f[0], f[1] - 1, f[2]) != Kind::Solid { if i == 0 { return self.fail_with("invalid_target", ticks, ev); } break; }
            let below = self.kind(f[0], f[1] - 2, f[2]);
            if below == Kind::Liquid || self.blk(f[0], f[1] - 2, f[2]).is_none() { if i == 0 { return self.fail_with("invalid_target", ticks, ev); } break; }
            let ground = below == Kind::Solid;
            if !ground {
                let item = match self.stack_item(temp) { Some(i) => i, None => return self.fail_with("missing_item", ticks, ev) };
                let bid = self.d.bid(&item);
                self.take(&item, 1); self.set(f[0], f[1] - 2, f[2], bid);
            }
            ticks += self.dig_here([f[0], f[1] - 1, f[2]], &mut ev) + DESCEND_LEVEL;
            self.pos = [f[0], f[1] - 1, f[2]]; self.exact = None; self.invalidate();
            if ground { break; }
        }
        let o = Out { ok: true, reason: "ok", ticks, ev: vec![] };
        self.finish_pub(o, ev)
    }
    /// bridge.js bridge {y, cells}: the body stands at height y; for each next cell a block goes under it when its floor is open (clicked on the
    /// side of the floor the body stands on), the body steps on; the block of the cell left behind is taken away unless keep / road / build.
    pub fn do_bridge(&mut self, y: i32, cells: &[[i32; 2]], keep: bool, temp: &str) -> Out {
        let mut ev = vec![];
        let mut ticks = 0;
        let mut laid: Vec<[i32; 3]> = vec![];
        for n in cells {
            let f = self.pos;
            if f[1] != y { return self.fail_with("invalid_target", ticks, ev); }
            let floor = [n[0], y - 1, n[1]];
            if self.kind(floor[0], floor[1], floor[2]) != Kind::Solid {
                if !crate::sim::replaceable(self.name(floor[0], floor[1], floor[2])) { return self.fail_with("invalid_target", ticks, ev); }
                let item = match self.stack_item(temp) { Some(i) => i, None => return self.fail_with("missing_item", ticks, ev) };
                let bid = self.d.bid(&item);
                self.take(&item, 1); self.set(floor[0], floor[1], floor[2], bid); laid.push(floor);
            }
            if self.kind(n[0], y, n[1]) == Kind::Solid || self.kind(n[0], y + 1, n[1]) == Kind::Solid { return self.fail_with("stuck", ticks, ev); }
            ticks += if laid.len() <= 1 && ticks == 0 { BRIDGE_FIRST } else { BRIDGE_CELL };
            let old = [f[0], y - 1, f[2]];
            self.pos = [n[0], y, n[1]]; self.exact = None; self.invalidate();
            if !keep && laid.contains(&old) { ticks += self.dig_here(old, &mut ev); }
        }
        let o = Out { ok: true, reason: "ok", ticks, ev: vec![] };
        self.finish_pub(o, ev)
    }
    fn fail_with(&mut self, reason: &'static str, ticks: i64, ev: Vec<Ev>) -> Out { let o = Out { ok: false, reason, ticks, ev: vec![] }; self.finish_pub(o, ev) }
}

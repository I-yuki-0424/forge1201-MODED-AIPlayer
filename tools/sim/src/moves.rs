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
pub const PILLAR_LEVEL: i64 = 11; pub const DESCEND_LEVEL: i64 = 7; pub const BRIDGE_CELL: i64 = 21; pub const BRIDGE_FIRST: i64 = 16;
/// The blind click under the block below the feet and the server's block (descend_place: the use tick, one more, the confirmation).
pub const DESCEND_PLACE: i64 = 3;
/// The aim and the click of a bridge block with the tick physics (aimAtBlock, the use tick, one more; the block itself comes in the same window).
pub const BRIDGE_CLICK: i64 = 3;

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
            if self.kind(f[0], f[1] - 1, f[2]) != Kind::Solid { return self.fail_with("invalid_target", ticks, ev); }
            // moves.js: never ride on another bot's scaffolding (its owner takes it away)
            if i == 0 && self.floor_by_other { return self.fail_with("invalid_target", 0, ev); }
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
    /// The body as the tick physics starts it: where it really stands (the recorded position), at rest.
    fn body(&self) -> crate::physics::PState {
        let p = self.exact.unwrap_or([self.pos[0] as f64 + 0.5, self.pos[1] as f64, self.pos[2] as f64 + 0.5]);
        let mut b = crate::physics::PState::new(p[0], p[1], p[2]);
        b.on_ground = self.ground; b.food = self.food; b
    }
    /// Run the physics with `keys` (game yaw in degrees) until `done` or `max` ticks: Some(ticks) when done.
    fn ticks_until(&self, b: &mut crate::physics::PState, keys: crate::physics::Keys, yaw: f64, max: i64, done: &dyn Fn(&crate::physics::PState) -> bool) -> Option<i64> {
        let ph = self.phys.clone()?;
        b.keys = keys; b.yaw = yaw; b.pitch = 0.0;
        for t in 1..=max { ph.step(self, b); if done(b) { return Some(t); } }
        None
    }
    fn settle_body(&mut self, b: &crate::physics::PState) { self.pos = [b.x.floor() as i32, (b.y + 1e-3).floor() as i32, b.z.floor() as i32]; self.exact = Some([b.x, b.y, b.z]); self.ground = b.on_ground; self.invalidate(); }
    /// moves.js descend {levels}: per level the block under the feet is dug and the body drops one cell; with air two below, a block is put
    /// there first (against the underside of the block under the feet); on solid ground two below it is the last level. With the tick physics
    /// the drop is the body's own: after the dig the move waits up to 100 ticks, keys up, for the feet one cell lower and on the ground; a body
    /// still held by the edge of a neighbouring block ends `stuck` (the corpus: 84 of 238 descends).
    pub fn do_descend(&mut self, levels: i64, temp: &str) -> Out {
        let mut ev = vec![];
        let mut ticks = 0;
        let mut body = if self.phys.is_some() { Some(self.body()) } else { None };
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
                if self.phys.is_some() { ticks += DESCEND_PLACE; }
            }
            ticks += self.dig_here([f[0], f[1] - 1, f[2]], &mut ev);
            if let Some(b) = body.as_mut() {
                let want = f[1] - 1;
                match self.ticks_until(b, crate::physics::Keys::default(), b.yaw, 100, &|s| s.on_ground && (s.y + 1e-3).floor() as i32 == want) {
                    Some(t) => { ticks += t; let bb = b.clone(); self.settle_body(&bb); }
                    None => { ticks += 100; let bb = b.clone(); self.settle_body(&bb); return self.fail_with("stuck", ticks, ev); }
                }
            } else {
                ticks += DESCEND_LEVEL;
                self.pos = [f[0], f[1] - 1, f[2]]; self.exact = None; self.invalidate();
            }
            if ground { break; }
        }
        let o = Out { ok: true, reason: "ok", ticks, ev: vec![] };
        self.finish_pub(o, ev)
    }
    /// bridge.js bridge {y, cells}: the body stands at height y; for each next cell a block goes under it when its floor is open (clicked on the
    /// side of the floor the body stands on), the body steps on; the block of the cell left behind is taken away unless keep / road / build.
    /// With the tick physics the walking is the body's: sneaking forward to the edge (off >= 0.6 within 40 ticks), two still ticks, the aim and
    /// the click (3), then sneaking on until the feet are in the next cell on the ground (40 ticks); a body that does not get there is `stuck`.
    pub fn do_bridge(&mut self, y: i32, cells: &[[i32; 2]], keep: bool, temp: &str) -> Out {
        let mut ev = vec![];
        let mut ticks = 0;
        let mut laid: Vec<[i32; 3]> = vec![];
        // bridge.js: each cell one step along x or z from the one before (the first from where the body stands), else invalid_args before anything
        let mut prev = [self.pos[0], self.pos[2]];
        for n in cells { if (n[0] - prev[0]).abs() + (n[1] - prev[1]).abs() != 1 { return self.fail_with("invalid_args", 0, vec![]); } prev = *n; }
        let mut body = if self.phys.is_some() { Some(self.body()) } else { None };
        for n in cells {
            let f = self.pos;
            if f[1] != y { return self.fail_with("invalid_target", ticks, ev); }
            let (dx, dz) = (n[0] - f[0], n[1] - f[2]);
            let yaw = crate::physics::f((std::f64::consts::PI - (-(dx as f64)).atan2(-(dz as f64))) * 180.0 / std::f64::consts::PI);
            let walk = crate::physics::Keys { forward: true, sneak: true, ..Default::default() };
            let floor = [n[0], y - 1, n[1]];
            if self.kind(floor[0], floor[1], floor[2]) != Kind::Solid {
                if !crate::sim::replaceable(self.name(floor[0], floor[1], floor[2])) { return self.fail_with("invalid_target", ticks, ev); }
                // the temporary block first: bridge.js takes BRIDGE_ITEMS only when the crew has not reserved them for the blueprint (every corpus bridge
                // laid the test world's pumpkins although dirt was in the pack); the reservations are not recorded
                let item = match self.stack_item(temp) { Some(i) => i, None => return self.fail_with("missing_item", ticks, ev) };
                if let Some(b) = body.as_mut() {
                    let (fx, fz) = (f[0] as f64 + 0.5, f[2] as f64 + 0.5);
                    let off = move |s: &crate::physics::PState| (s.x - fx) * dx as f64 + (s.z - fz) * dz as f64;
                    match self.ticks_until(b, walk, yaw, 40, &|s| s.y < y as f64 - 1.2 || off(s) >= 0.6) {
                        Some(t) if b.y >= y as f64 - 1.2 => { ticks += t; }
                        Some(t) => { ticks += t; let bb = b.clone(); self.settle_body(&bb); return self.fail_with("stuck", ticks, ev); }
                        None => { ticks += 40; let bb = b.clone(); self.settle_body(&bb); return self.fail_with("stuck", ticks, ev); }
                    }
                    let _ = self.ticks_until(b, crate::physics::Keys::default(), yaw, 2, &|_| false); ticks += 2;
                    let _ = self.ticks_until(b, crate::physics::Keys { sneak: true, ..Default::default() }, yaw, BRIDGE_CLICK, &|_| false); ticks += BRIDGE_CLICK;
                }
                let bid = self.d.bid(&item);
                self.take(&item, 1); self.set(floor[0], floor[1], floor[2], bid); laid.push(floor);
            }
            if let Some(b) = body.as_mut() {
                let (nx, nz) = (n[0], n[1]);
                match self.ticks_until(b, walk, yaw, 40, &|s| s.on_ground && s.x.floor() as i32 == nx && s.z.floor() as i32 == nz && (s.y + 1e-3).floor() as i32 == y) {
                    Some(t) => { ticks += t; let bb = b.clone(); self.settle_body(&bb); }
                    None => { ticks += 40; let bb = b.clone(); self.settle_body(&bb); return self.fail_with("stuck", ticks, ev); }
                }
            } else {
                if self.kind(n[0], y, n[1]) == Kind::Solid || self.kind(n[0], y + 1, n[1]) == Kind::Solid { return self.fail_with("stuck", ticks, ev); }
                ticks += if laid.len() <= 1 && ticks == 0 { BRIDGE_FIRST } else { BRIDGE_CELL };
                self.pos = [n[0], y, n[1]]; self.exact = None; self.invalidate();
            }
            let old = [f[0], y - 1, f[2]];
            if !keep && laid.contains(&old) { ticks += self.dig_here(old, &mut ev); }
        }
        let o = Out { ok: true, reason: "ok", ticks, ev: vec![] };
        self.finish_pub(o, ev)
    }
    /// bridge.js: the bridge items first (cobblestone, cobbled deepslate, netherrack ...), then the temporary block.
    pub fn bridge_item(&self, temp: &str) -> Option<String> {
        STACK_ITEMS.iter().find(|n| self.count(n) > 0).map(|n| n.to_string()).or_else(|| if !temp.is_empty() && self.count(temp) > 0 { Some(temp.to_string()) } else { None })
    }
    fn fail_with(&mut self, reason: &'static str, ticks: i64, ev: Vec<Ev>) -> Out { let o = Out { ok: false, reason, ticks, ev: vec![] }; self.finish_pub(o, ev) }
}

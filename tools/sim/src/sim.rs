//! One bot in one world tile: state, walking (flood fill on the walker's own move set), and the commands as semi-Markov
//! transitions (outcome, reason, ticks, events). World clocks (time, hunger, mobs) advance in 20-tick sub-steps while a
//! command "runs". Semantics follow src/skills (docs/implemented/SKILLS-v1.md); tuned constants are marked (est.).
use crate::data::{Data, Kind};
use crate::tile::Tile;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::rc::Rc;

pub const EYE: f64 = 1.62;
pub const BLOCK_REACH: f64 = 4.1;
const B_PER_TICK: f64 = 4.317 / 20.0;
pub const DAY: i64 = 24000;

pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    pub fn f(&mut self) -> f64 { (self.next() >> 11) as f64 / (1u64 << 53) as f64 }
    pub fn below(&mut self, n: u64) -> u64 { self.next() % n.max(1) }
}
#[derive(Clone, Copy, Debug)]
pub struct Stack { pub item: u16, pub n: u32 }
#[derive(Clone, Debug)]
pub struct Mob { pub id: u32, pub name: &'static str, pub pos: [i32; 3], pub hp: f64, pub hostile: bool, pub spec: usize, pub cd: f64, pub fuse: f64 }
#[derive(Clone, Debug)]
pub enum Ev { Stat(&'static str, String, u32), Killed(String, u32), Dawn(bool), Death }
pub struct Out { pub ok: bool, pub reason: &'static str, pub ticks: i64, pub ev: Vec<Ev> }
impl Out {
    fn ok(ticks: i64, ev: Vec<Ev>) -> Out { Out { ok: true, reason: "ok", ticks, ev } }
    fn fail(reason: &'static str, ticks: i64, ev: Vec<Ev>) -> Out { Out { ok: false, reason, ticks, ev } }
}
pub struct Reach { pub dist: HashMap<[i32; 3], f32>, pub nodes: Vec<[i32; 3]> }
#[derive(PartialEq)]
struct Qn(f32, [i32; 3]);
impl Eq for Qn {}
impl PartialOrd for Qn { fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) } }
impl Ord for Qn { fn cmp(&self, o: &Self) -> Ordering { o.0.partial_cmp(&self.0).unwrap_or(Ordering::Equal) } }

pub struct Sim {
    pub d: Rc<Data>, pub tile: Rc<Tile>, pub edits: HashMap<(i32, i32, i32), u16>,
    pub pos: [i32; 3], pub yaw: f64, pub hp: f64, pub food: f64, pub sat: f64, pub exh: f64, pub inv: Vec<Option<Stack>>,
    pub tick: i64, pub mobs: Vec<Mob>, pub next_id: u32, pub rng: Rng, pub site: [i32; 3], pub fuel: f64,
    pub hostile_scale: f64, pub craft_slots: Option<usize>, pub dead: bool, pub mobf: Option<([i32; 3], usize, std::collections::HashMap<[i32; 3], f32>)>, pub ph: Vec<(&'static str, i64)>, pub view: [i32; 3], pub track: [i32; 3], pub air: f64, pub hits: u32, pub dmg: Vec<(&'static str, &'static str, f64, f64)>, day_seen: i64, regen_t: f64, pub kills: HashMap<String, u32>, pub audit: HashMap<String, u64>,
    reach: Option<Reach>,
}
pub const PASSIVE: [(&str, f64); 4] = [("cow", 10.0), ("pig", 10.0), ("sheep", 8.0), ("chicken", 4.0)];

fn stack_max(name: &str) -> u32 {
    if name.ends_with("_pickaxe") || name.ends_with("_axe") || name.ends_with("_shovel") || name.ends_with("_hoe") || name.ends_with("_sword") || name.ends_with("_helmet")
        || name.ends_with("_chestplate") || name.ends_with("_leggings") || name.ends_with("_boots") || name.ends_with("_bed") || name == "bow" || name == "bucket" || name == "shield" { 1 }
    else if matches!(name, "egg" | "ender_pearl" | "snowball") || name.ends_with("_sign") { 16 } else { 64 }
}
/// Block names `place` accepts as the target cell (src/skills/commands/block.js REPLACEABLE); anything else, a sapling or a flower
/// included, is `invalid_target` however empty it looks.
pub fn replaceable(n: &str) -> bool { matches!(n, "air" | "cave_air" | "void_air" | "grass" | "tall_grass" | "fern" | "large_fern" | "dead_bush" | "snow" | "seagrass" | "vine" | "glow_lichen") }
fn interactive(n: &str) -> bool { n.ends_with("_bed") || n.ends_with("chest") || n.ends_with("_door") || n.ends_with("_gate") || n.ends_with("trapdoor") || n.ends_with("_button")
    || matches!(n, "crafting_table" | "furnace" | "blast_furnace" | "smoker" | "barrel" | "lever" | "anvil" | "enchanting_table" | "brewing_stand" | "loom" | "grindstone" | "smithing_table" | "cartography_table" | "stonecutter" | "fletching_table") }
/// Protocol face normals (0 down, 1 up, 2 north, 3 south, 4 west, 5 east), geometry.js FACES.
pub const FACES: [[i32; 3]; 6] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
/// Ticks the action layer spends around the digging itself, per block (src/skills/commands/block.js `mine`): the hotbar swap to the
/// tool, the first aim, one tick to settle, and `collect_drop` (entity.js): wait for the item to appear and land, then walk into it.
/// Estimated from those waits (the item's pickup delay is 10 ticks); the real run's per-phase ticks (`ph`) will replace them.
/// Measured on the real server (per-phase ticks of 1,984 `mine` and 793 `tunnel`, `ph` in events.jsonl, tools/sim/phases.py): the dig phase
/// averages 45.6 ticks against the vanilla break time + aim (the server's confirmation of the break takes ~6 more), collect_drop 20.0, and
/// after it the walk to a drop that did not land at the feet 18.3 per mine (19.6 per tunnel); a tunnel step ends with a walk into the dug
/// cell and a settle (~39 ticks incl. falling-block waits).
pub const TUNNEL_BASE: i64 = 8; pub const TUNNEL_STEP: i64 = 39; pub const MINE_HOLD: i64 = 3; pub const MINE_AIM: i64 = 4; pub const MINE_CONFIRM: i64 = 6; pub const MINE_COLLECT: i64 = 20; pub const MINE_PICKUP: i64 = 19;
pub const AIM_REACH: f64 = 4.2;               // motion.js AIM_REACH = BLOCK_REACH 4.5 - 0.3
pub fn tool_rank(n: &str) -> i32 { ["wooden", "golden", "stone", "iron", "diamond", "netherite"].iter().position(|t| n.starts_with(t)).map(|p| p as i32).unwrap_or(-1) }

impl Sim {
    pub fn new(d: Rc<Data>, tile: Rc<Tile>, seed: u64) -> Sim {
        Sim { d, tile, edits: HashMap::new(), pos: [0; 3], yaw: 0.0, hp: 20.0, food: 20.0, sat: 5.0, exh: 0.0, inv: vec![None; 36], tick: 0, mobs: vec![], next_id: 1, rng: Rng(seed | 1),
            site: [0; 3], fuel: 0.0, hostile_scale: 1.0, craft_slots: None, dead: false, mobf: None, ph: vec![], view: [0; 3], track: [0; 3], air: 300.0, hits: 0, dmg: vec![], day_seen: 0, regen_t: 0.0, kills: HashMap::new(), audit: HashMap::new(), reach: None }
    }
    // ---- world access ----
    #[inline] pub fn blk(&self, x: i32, y: i32, z: i32) -> Option<u16> { if let Some(&b) = self.edits.get(&(x, y, z)) { Some(b) } else { self.tile.get(x, y, z) } }
    pub fn kind(&self, x: i32, y: i32, z: i32) -> Kind { match self.blk(x, y, z) { Some(b) => self.d.block(b).kind, None => Kind::Solid } }
    pub fn name(&self, x: i32, y: i32, z: i32) -> &str { match self.blk(x, y, z) { Some(b) => &self.d.block(b).name, None => "unloaded" } }
    pub fn is_air(&self, x: i32, y: i32, z: i32) -> bool { matches!(self.kind(x, y, z), Kind::Air | Kind::Passable) }
    pub(crate) fn lava(&self, x: i32, y: i32, z: i32) -> bool { self.name(x, y, z) == "lava" }
    pub fn standable(&self, x: i32, y: i32, z: i32) -> bool {
        let (f, h) = (self.kind(x, y, z), self.kind(x, y + 1, z));
        if f == Kind::Solid || h == Kind::Solid || self.lava(x, y, z) || self.lava(x, y + 1, z) || self.blk(x, y, z).is_none() { return false; }
        match self.kind(x, y - 1, z) { Kind::Solid => !self.lava(x, y - 1, z), _ => f == Kind::Climb || f == Kind::Liquid }
    }
    pub fn set(&mut self, x: i32, y: i32, z: i32, b: u16) { self.edits.insert((x, y, z), b); self.reach = None; }
    pub fn center(&self) -> [f64; 3] { [self.pos[0] as f64 + 0.5, self.pos[1] as f64, self.pos[2] as f64 + 0.5] }
    pub fn is_night(&self) -> bool { let t = self.tick % DAY; (12542..23460).contains(&t) }
    pub fn count(&self, name: &str) -> u32 { let id = self.d.item(name); self.inv.iter().flatten().filter(|s| s.item == id).map(|s| s.n).sum() }
    pub fn held(&self) -> Vec<(String, u32)> { let mut m: Vec<(String, u32)> = vec![]; for s in self.inv.iter().flatten() { let n = self.d.items[s.item as usize].clone(); if let Some(e) = m.iter_mut().find(|e| e.0 == n) { e.1 += s.n } else { m.push((n, s.n)) } } m }
    pub fn give(&mut self, name: &str, mut n: u32) -> u32 {
        let id = self.d.item(name);
        if id == 0 { return 0; }
        let max = stack_max(name);
        let mut put = 0;
        for s in self.inv.iter_mut().flatten() { if s.item == id && s.n < max && n > 0 { let a = (max - s.n).min(n); s.n += a; n -= a; put += a; } }
        for slot in self.inv.iter_mut() { if n == 0 { break; } if slot.is_none() { let a = max.min(n); *slot = Some(Stack { item: id, n: a }); n -= a; put += a; } }
        put
    }
    pub fn take(&mut self, name: &str, mut n: u32) -> bool {
        if self.count(name) < n { return false; }
        let id = self.d.item(name);
        for slot in self.inv.iter_mut() { if n == 0 { break; } if let Some(s) = slot { if s.item == id { let a = s.n.min(n); s.n -= a; n -= a; if s.n == 0 { *slot = None; } } } }
        true
    }
    // ---- walking ----
    pub(crate) fn reach_ref(&self) -> &HashMap<[i32; 3], f32> { &self.reach.as_ref().expect("reach() first").dist }
    pub fn reach(&mut self) -> &Reach {
        if self.reach.is_none() { self.reach = Some(self.flood()); }
        self.reach.as_ref().unwrap()
    }
    fn flood(&self) -> Reach { self.flood_n(1500, 18) }
    /// The walker's Dijkstra over its own moves from the bot: `max_nodes` cells within `radius` blocks (18 / 1,500 are skill_space.js's own values).
    pub(crate) fn flood_n(&self, max_nodes: usize, radius: i32) -> Reach {
        let start = self.pos;
        let mut dist: HashMap<[i32; 3], f32> = HashMap::new();
        let mut nodes = vec![];
        let mut q = BinaryHeap::new();
        dist.insert(start, 0.0);
        q.push(Qn(0.0, start));
        let mut done: std::collections::HashSet<[i32; 3]> = std::collections::HashSet::new();
        while let Some(Qn(c, n)) = q.pop() {
            if !done.insert(n) { continue; }
            if c > *dist.get(&n).unwrap_or(&f32::MAX) + 1e-6 { continue; }
            nodes.push(n);
            if nodes.len() >= max_nodes { break; }
            let [x, y, z] = n;
            let mut push = |m: [i32; 3], w: f32, q: &mut BinaryHeap<Qn>, dist: &mut HashMap<[i32; 3], f32>| {
                if (m[0] - start[0]).abs() > radius || (m[2] - start[2]).abs() > radius || (m[1] - start[1]).abs() > 12 { return; }
                let nc = c + w;
                if nc < *dist.get(&m).unwrap_or(&f32::MAX) { dist.insert(m, nc); q.push(Qn(nc, m)); }
            };
            let wet = if self.kind(x, y, z) == Kind::Liquid { 2.0 } else { 1.0 };
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let diag = dx != 0 && dz != 0;
                if diag && (self.kind(x + dx, y, z) == Kind::Solid || self.kind(x, y, z + dz) == Kind::Solid || self.kind(x + dx, y + 1, z) == Kind::Solid || self.kind(x, y + 1, z + dz) == Kind::Solid) { continue; }
                let (nx, nz) = (x + dx, z + dz);
                let base = if diag { 1.414 } else { 1.0 } * wet;
                if self.standable(nx, y, nz) { push([nx, y, nz], base, &mut q, &mut dist); continue; }
                if !diag && self.kind(x, y + 2, z) != Kind::Solid && self.kind(nx, y, nz) == Kind::Solid && self.standable(nx, y + 1, nz) { push([nx, y + 1, nz], base + 0.5, &mut q, &mut dist); continue; }
                if !diag { for dd in 1..=3 { if self.kind(nx, y - dd + 1, nz) == Kind::Solid || self.kind(nx, y - dd + 2, nz) == Kind::Solid { break; } if self.standable(nx, y - dd, nz) { push([nx, y - dd, nz], base + 0.3 * dd as f32, &mut q, &mut dist); break; } } }
            }
            if self.kind(x, y, z) == Kind::Climb {
                for dy in [-1, 1] { if self.standable(x, y + dy, z) { push([x, y + dy, z], 1.0, &mut q, &mut dist); } }
            }
        }
        Reach { dist, nodes }
    }
    /// Real walking (851 `move_to`): 24.0 + 5.69 ticks per block of displacement; the idealised 4.63 per block plus the settle at the end.
    pub fn ticks_for(&self, dist: f32) -> i64 { (dist as f64 / B_PER_TICK * 1.06).ceil() as i64 + 5 }
    /// motion.js `approachUntil`: walk to the first stand cell that satisfies the command's goal (reach 4.1), then look from where the body
    /// really stopped (`settle` ends within 0.25 of the cell centre, in practice about 0.2 on the side it came from) with the longer aim
    /// reach (4.2); if nothing is in sight, once more with reach 3.3 and another cell. Walk ticks on success; (reason, ticks) on failure:
    /// `unreachable` when the planner finds no cell, `not_visible` when the second stop does not see it either.
    pub(crate) fn approach(&mut self, goal: &dyn Fn(&Sim, [i32; 3], f64) -> bool, visible: &dyn Fn(&Sim, [f64; 3]) -> bool) -> Result<i64, (&'static str, i64)> {
        let mut ticks = 0i64;
        let start = self.pos;
        let mut here = self.pos;
        for attempt in 0..2 {
            let reach = BLOCK_REACH - 0.8 * attempt as f64;
            let excl = if attempt == 1 { Some(here) } else { None };
            if attempt == 0 && goal(self, here, reach) {
                if visible(self, [here[0] as f64 + 0.5, here[1] as f64 + EYE, here[2] as f64 + 0.5]) { return Ok(0); }
                continue;                                                  // no walk, nothing in sight: straight to the second attempt
            }
            self.pos = here; self.reach = None;
            let (n, c) = match self.stand_for(|s, n| Some(n) != excl && goal(s, n, reach)) { Some(x) => x, None => { self.pos = start; self.reach = None; return Err(("unreachable", 2 * ticks + 1)) } };
            ticks += self.ticks_for(c);
            // Where the body really stops: `settle` ends within 0.25 of the centre, wherever the walk's momentum left it. The walk is the
            // same every time the same command is repeated from the same cell, so the offset is a fixed function of (start, cell), not a
            // fresh random draw per try: a target seen through one gap fails again and again, as the 198 repeats in the real log did.
            let h = (here[0] as i64 * 73856093 ^ here[1] as i64 * 19349663 ^ here[2] as i64 * 83492791 ^ n[0] as i64 * 2654435761 ^ n[1] as i64 * 40503 ^ n[2] as i64 * 97531) as u64;
            let mut r = Rng(h.wrapping_mul(0x9E3779B97F4A7C15) | 1);
            let (ang, rad) = (r.f() * std::f64::consts::TAU, 0.25 * r.f().sqrt());
            let (ox, oz) = (rad * ang.cos(), rad * ang.sin());
            here = n;
            if visible(self, [n[0] as f64 + 0.5 + ox, n[1] as f64 + EYE, n[2] as f64 + 0.5 + oz]) { self.pos = n; self.reach = None; return Ok(ticks); }
        }
        self.pos = here; self.reach = None;
        Err(("not_visible", ticks))
    }
    /// First solid cell along the line from the eye of a standing cell to the centre of `t` is `t` itself.
    pub fn sees(&self, from: [i32; 3], t: [i32; 3]) -> bool {
        let e = [from[0] as f64 + 0.5, from[1] as f64 + EYE, from[2] as f64 + 0.5];
        let c = [t[0] as f64 + 0.5, t[1] as f64 + 0.5, t[2] as f64 + 0.5];
        match self.ray(e, [c[0] - e[0], c[1] - e[1], c[2] - e[2]], 8.0) { Some((cell, _)) => cell == t, None => false }
    }
    /// DDA through the voxels; returns the first solid/climb cell and the distance. `dir` need not be normalised.
    pub fn ray(&self, o: [f64; 3], dir: [f64; 3], maxd: f64) -> Option<([i32; 3], f64)> {
        let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if len < 1e-9 { return None; }
        let dv = [dir[0] / len, dir[1] / len, dir[2] / len];
        let mut cell = [o[0].floor() as i32, o[1].floor() as i32, o[2].floor() as i32];
        let mut step = [0i32; 3];
        let mut tmax = [f64::MAX; 3];
        let mut tdel = [f64::MAX; 3];
        for i in 0..3 {
            if dv[i] > 0.0 { step[i] = 1; tdel[i] = 1.0 / dv[i]; tmax[i] = (cell[i] as f64 + 1.0 - o[i]) / dv[i]; }
            else if dv[i] < 0.0 { step[i] = -1; tdel[i] = -1.0 / dv[i]; tmax[i] = (o[i] - cell[i] as f64) / -dv[i]; }
        }
        let mut t = 0.0;
        loop {
            if matches!(self.kind(cell[0], cell[1], cell[2]), Kind::Solid | Kind::Climb) { return Some((cell, t)); }
            let i = if tmax[0] < tmax[1] { if tmax[0] < tmax[2] { 0 } else { 2 } } else if tmax[1] < tmax[2] { 1 } else { 2 };
            t = tmax[i];
            if t > maxd { return None; }
            cell[i] += step[i];
            tmax[i] += tdel[i];
        }
    }
    /// geometry.js aimPoints (full cubes): is there a point on a face of block `cell` (optionally one face) that the eye sees within
    /// `reach`? Face centre and four inner points per face, faces turned away from the eye skipped, the ray to the point must hit `cell` first.
    pub fn aim_ok(&self, eye: [f64; 3], cell: [i32; 3], face: Option<usize>, reach: f64) -> bool {
        let lo = [cell[0] as f64, cell[1] as f64, cell[2] as f64];
        for f in 0..6 {
            if face.map_or(false, |q| q != f) { continue; }
            let n = FACES[f];
            let axis = if n[0] != 0 { 0 } else if n[1] != 0 { 1 } else { 2 };
            let pos = n[axis] > 0;
            let plane = lo[axis] + if pos { 1.0 } else { 0.0 };
            if if pos { eye[axis] <= plane } else { eye[axis] >= plane } { continue; }
            let (a1, a2) = match axis { 0 => (1, 2), 1 => (0, 2), _ => (0, 1) };
            for (u, v) in [(0.5, 0.5), (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                let mut p = [0.0; 3];
                p[axis] = plane; p[a1] = lo[a1] + u; p[a2] = lo[a2] + v;
                let d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
                let dist = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                if dist > reach || dist < 1e-9 { continue; }
                if let Some((c, _)) = self.ray(eye, d, dist + 0.01) { if c == cell { return true; } }
            }
        }
        false
    }
    /// motion.js reachGoal: a standing cell within reach (+0.9 for not standing at the centre) of the block with an aim point in sight.
    pub fn reach_goal(&self, c: [i32; 3], cell: [i32; 3], face: Option<usize>, reach: f64) -> bool {
        let dist = (((c[0] - cell[0]) as f64).powi(2) + (c[1] as f64 + EYE - cell[1] as f64 - 0.5).powi(2) + ((c[2] - cell[2]) as f64).powi(2)).sqrt();
        dist <= reach + 0.9 && self.aim_ok([c[0] as f64 + 0.5, c[1] as f64 + EYE, c[2] as f64 + 0.5], cell, face, reach)
    }
    /// The cheapest reachable stand cell satisfying `goal` (what the planner finds first), with its walking cost.
    fn stand_for(&mut self, goal: impl Fn(&Sim, [i32; 3]) -> bool) -> Option<([i32; 3], f32)> {
        let nodes: Vec<([i32; 3], f32)> = { let r = self.reach(); r.nodes.iter().map(|n| (*n, r.dist[n])).collect() };
        let mut best: Option<([i32; 3], f32)> = None;
        for (n, c) in nodes {
            if best.map_or(false, |b| b.1 <= c) { continue; }
            if goal(self, n) { best = Some((n, c)); }
        }
        best
    }

    // ---- tools and digging ----
    /// Best way to break `block` with what is held: (tool item name or "", ticks, can_harvest). None if undiggable.
    pub fn dig_plan(&self, bid: u16) -> Option<(String, i64, bool)> {
        let b = self.d.block(bid);
        if !b.diggable || b.hard < 0.0 { return None; }
        let mut best: Option<(String, i64, bool)> = None;
        let held = self.held();
        let mut cands: Vec<&str> = vec![""];
        cands.extend(held.iter().map(|h| h.0.as_str()));
        for t in cands {
            let harvest = match &b.harvest { None => true, Some(list) => !t.is_empty() && list.iter().any(|x| x == t) };
            let speed = if t.is_empty() { 1.0 } else { b.mult.iter().find(|m| m.0 == t).map(|m| m.1).unwrap_or(1.0) };
            let ticks = if b.hard == 0.0 { 0 } else { let dmg = speed / b.hard / if harvest { 30.0 } else { 100.0 }; if dmg >= 1.0 { 0 } else { (1.0 / dmg).ceil() as i64 } };
            if b.harvest.is_some() && !harvest { continue; }
            if best.as_ref().map_or(true, |x| ticks < x.1) { best = Some((t.to_string(), ticks, harvest)); }
        }
        best
    }
    fn break_block(&mut self, x: i32, y: i32, z: i32, ev: &mut Vec<Ev>) {
        let bid = self.blk(x, y, z).unwrap_or(self.d.air);
        let (name, drops, plan) = { let b = self.d.block(bid); (b.name.clone(), b.drops.clone(), self.dig_plan(bid)) };
        ev.push(Ev::Stat("mined", name.clone(), 1));
        if plan.map_or(false, |p| p.2) {
            if let Some(dn) = drops.first() { let put = self.give(dn, 1); if put > 0 { ev.push(Ev::Stat("picked_up", dn.clone(), put)); } }
        }
        // Water next to the opened cell flows in and on: down without limit, sideways seven cells (400 cells at most), so a tunnel opened
        // into an aquifer floods and a bot in it drowns, as in the game. Lava is left as one cell (it creeps three cells in the overworld).
        self.set(x, y, z, self.d.air);
        let mut water = None;
        for (a, b, c) in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, -1)] { if self.name(x + a, y + b, z + c) == "water" { water = self.blk(x + a, y + b, z + c); break; } }
        if let Some(w) = water { self.flow(w, [x, y, z]); }
        else { for (a, b, c) in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, -1)] { if self.kind(x + a, y + b, z + c) == Kind::Liquid { if let Some(l) = self.blk(x + a, y + b, z + c) { self.set(x, y, z, l); } break; } } }
        // gravity blocks above fall into the gap
        let mut yy = y + 1;
        while matches!(self.name(x, yy, z), "sand" | "red_sand" | "gravel") && self.is_air(x, yy - 1, z) {
            let b = self.blk(x, yy, z).unwrap();
            self.set(x, yy - 1, z, b); self.set(x, yy, z, self.d.air); yy += 1;
        }
    }
    /// Breadth-first water flow from the opened cell (see break_block).
    fn flow(&mut self, water: u16, src: [i32; 3]) {
        let mut q = std::collections::VecDeque::new();
        let mut seen = std::collections::HashSet::new();
        q.push_back((src, 7i32)); seen.insert(src);
        let mut n = 0;
        while let Some((c, lvl)) = q.pop_front() {
            n += 1; if n > 400 { break; }
            if c != src && !self.is_air(c[0], c[1], c[2]) { continue; }
            self.set(c[0], c[1], c[2], water);
            let d = [c[0], c[1] - 1, c[2]];
            if self.is_air(d[0], d[1], d[2]) && seen.insert(d) { q.push_back((d, 7)); continue; }
            if lvl > 0 { for (a, b) in [(1, 0), (-1, 0), (0, 1), (0, -1)] { let m = [c[0] + a, c[1], c[2] + b]; if self.is_air(m[0], m[1], m[2]) && seen.insert(m) { q.push_back((m, lvl - 1)); } } }
        }
    }
    // ---- world clocks ----
    /// Advance `ticks`; mobs act, hunger and health follow. Stops early on death (the Out carries `died`).
    pub fn advance(&mut self, ticks: i64, ev: &mut Vec<Ev>) {
        let mut left = ticks;
        while left > 0 && !self.dead {
            // Quarter-second steps while a hostile is within 8 blocks (attacks, knockback and chasing happen on the cooldown's clock, not at
            // whole-second boundaries), one-second steps otherwise.
            let near = self.mobs.iter().any(|m| m.hostile && (m.pos[0] - self.pos[0]).abs().max((m.pos[2] - self.pos[2]).abs()) <= 8);
            let c = left.min(if near { 5 } else { 20 });
            left -= c;
            let before = self.tick;
            self.tick += c;
            let frac = c as f64 / 20.0;
            if self.tick / DAY > before / DAY { ev.push(Ev::Dawn(false)); }
            // Hunger as in the game: no passive drain; exhaustion comes from actions (walking, digging, fighting, damage, healing) and
            // empties the saturation first, then the food bar. Fast healing (every 10 ticks) while food is full and saturation lasts.
            while self.exh >= 4.0 { self.exh -= 4.0; if self.sat > 0.0 { self.sat = (self.sat - 1.0).max(0.0); } else if self.food > 0.0 { self.food -= 1.0; } }
            self.regen_t += c as f64;
            let thr = if self.food >= 20.0 && self.sat > 0.0 { 10.0 } else { 80.0 };
            while self.regen_t >= thr {
                self.regen_t -= thr;
                if self.food >= 18.0 && self.hp < 20.0 { self.hp += 1.0; self.exh += 6.0; } else if self.food <= 0.0 && self.hp > 1.0 { self.hp -= 1.0; self.dmg.push(("starve", "", 1.0, 0.0)); }
            }
            // Air: 15 s under water, then 2 hp per second.
            if self.kind(self.pos[0], self.pos[1] + 1, self.pos[2]) == Kind::Liquid && !self.lava(self.pos[0], self.pos[1] + 1, self.pos[2]) {
                self.air -= c as f64;
                if self.air < 0.0 { self.air += 20.0; self.hp -= 2.0; self.dmg.push(("drown", "", 2.0, 0.0)); self.hits += 1; }
            } else { self.air = (self.air + 4.0 * c as f64).min(300.0); }
            // The mobs see the bot where it is while the command runs: between where it started and where it ends (the walk takes the whole
            // command), not at the end for the whole time (a bot walking away at 4.3 blocks/s is not hit by a zombie at 3.6).
            let f = ((ticks - left) as f64 - c as f64 / 2.0) / ticks.max(1) as f64;
            self.view = self.interp(self.track, self.pos, f);
            self.mobs_step(frac);
            if self.hp <= 0.0 { self.dead = true; ev.push(Ev::Death); }
        }
        self.track = self.pos;
    }
    /// Rock, dirt, planks or the like overhead within 40 blocks: no sky light. Leaves let light through (the game lowers it one level per
    /// layer, a canopy of a few layers stays far above the level monsters need).
    pub(crate) fn sky_blocked(&self, x: i32, y: i32, z: i32) -> bool { (y + 2..y + 40).any(|yy| self.kind(x, yy, z) == Kind::Solid && !self.name(x, yy, z).ends_with("_leaves")) }
    pub(crate) fn surface_exposed(&self) -> bool { !self.sky_blocked(self.pos[0], self.pos[1], self.pos[2]) }
    pub(crate) fn find_stand(&self, x: i32, z: i32, y0: i32) -> Option<i32> { (y0 - 10..=y0 + 10).rev().find(|&y| self.standable(x, y, z)) }
    fn interp(&self, a: [i32; 3], b: [i32; 3], f: f64) -> [i32; 3] {
        if a == b { return b; }
        let (x, z) = (a[0] + ((b[0] - a[0]) as f64 * f).round() as i32, a[2] + ((b[2] - a[2]) as f64 * f).round() as i32);
        match self.find_stand(x, z, if f < 0.5 { a[1] } else { b[1] }) { Some(y) if (y - a[1]).abs() <= 8 => [x, y, z], _ => b }
    }
    pub(crate) fn invalidate(&mut self) { self.reach = None; }
    pub fn spawn_animals(&mut self) {
        let [sx, sy, sz] = self.site;
        for _ in 0..24 {
            if self.mobs.len() >= 8 { break; }
            let (x, z) = (sx + self.rng.below(90) as i32 - 45, sz + self.rng.below(90) as i32 - 45);
            if let Some(y) = self.find_stand(x, z, sy) { if self.name(x, y - 1, z) == "grass_block" {
                let (n, hp) = PASSIVE[self.rng.below(4) as usize]; let id = self.next_id; self.next_id += 1;
                self.mobs.push(Mob::passive(id, n, [x, y, z], hp));
            } }
        }
    }
    // ---- commands ----
    fn finish(&mut self, mut o: Out, mut ev: Vec<Ev>) -> Out {
        self.advance(o.ticks, &mut ev);
        if self.dead { o.ok = false; o.reason = "cancelled"; }
        o.ev = ev; o
    }
    pub fn do_wait(&mut self, ticks: i64) -> Out { let o = Out::ok(ticks, vec![]); self.finish(o, vec![]) }
    pub fn do_move(&mut self, t: [i32; 3]) -> Out {
        let d = self.reach().dist.get(&t).copied();
        match d {
            None => Out::fail("unreachable", 1, vec![]).with(self, vec![]),
            Some(dd) => { let ticks = self.ticks_for(dd); self.ph = vec![("walk", ticks)]; self.look_at(t); self.exh += 0.02 * dd as f64; self.pos = t; self.reach = None; let o = Out::ok(ticks, vec![]); self.finish(o, vec![]) }
        }
    }
    pub(crate) fn look_at(&mut self, t: [i32; 3]) { let (dx, dz) = ((t[0] - self.pos[0]) as f64, (t[2] - self.pos[2]) as f64); if dx != 0.0 || dz != 0.0 { self.yaw = (-dx).atan2(-dz); } }
    pub fn do_mine(&mut self, t: [i32; 3]) -> Out {
        let bid = match self.blk(t[0], t[1], t[2]) { Some(b) => b, None => return Out::fail("invalid_target", 1, vec![]).with(self, vec![]) };
        let k = self.d.block(bid).kind;
        if k != Kind::Solid { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        let plan = match self.dig_plan(bid) { Some(p) => p, None => { let r = if self.d.block(bid).harvest.is_some() && self.d.block(bid).diggable { "missing_tool" } else { "invalid_target" }; return Out::fail(r, 1, vec![]).with(self, vec![]); } };
        let walk = match self.approach(&|s, n, r| !(n[0] == t[0] && n[2] == t[2] && n[1] == t[1] + 1) && s.reach_goal(n, t, None, r), &|s, e| s.aim_ok(e, t, None, AIM_REACH)) {
            Ok(w) => w, Err((r, tk)) => { let o = Out::fail(r, tk, vec![]); return self.finish(o, vec![]); } };
        let mut ev = vec![];
        let ticks = walk + plan.1.max(1) + self.mine_overhead(bid, plan.2);
        self.ph = vec![("walk", walk), ("dig", MINE_AIM + MINE_CONFIRM + plan.1.max(1) + 1), ("collect_drop", ticks - walk - (MINE_AIM + MINE_CONFIRM + plan.1.max(1) + 1))];
        self.look_at([t[0], self.pos[1], t[2]]);
        self.exh += 0.005;
        self.break_block(t[0], t[1], t[2], &mut ev);
        self.reach = None;
        self.finish(Out::ok(ticks, vec![]), ev)
    }
    /// Fixed ticks around one mined block: swap, aim, settle, and collecting the drop when the block yields one the tool harvests.
    fn mine_overhead(&self, bid: u16, harvests: bool) -> i64 {
        MINE_HOLD + MINE_AIM + MINE_CONFIRM + 1 + if harvests && !self.d.block(bid).drops.is_empty() { MINE_COLLECT + MINE_PICKUP } else { 0 }
    }
    pub fn tunnel_cells(f: [i32; 3], dir: &str, dy: i32) -> (Vec<[i32; 3]>, [i32; 3], [i32; 3]) {
        let (dx, dz) = match dir { "north" => (0, -1), "south" => (0, 1), "west" => (-1, 0), _ => (1, 0) };
        let (x, z) = (f[0] + dx, f[2] + dz);
        let to = [x, f[1] + dy, z];
        let clear = if dy == 0 { vec![[x, f[1] + 1, z], [x, f[1], z]] } else if dy < 0 { vec![[x, f[1] + 1, z], [x, f[1], z], [x, f[1] - 1, z]] } else { vec![[f[0], f[1] + 2, f[2]], [x, f[1] + 2, z], [x, f[1] + 1, z]] };
        (clear, to, [x, to[1] - 1, z])
    }
    /// Why a tunnel step cannot be dug from `f` (world only), or None.
    pub fn tunnel_problem(&self, f: [i32; 3], dir: &str, dy: i32) -> Option<&'static str> {
        let (clear, _to, floor) = Sim::tunnel_cells(f, dir, dy);
        if self.kind(floor[0], floor[1], floor[2]) != Kind::Solid || self.lava(floor[0], floor[1], floor[2]) { return Some("no floor"); }
        let mut solid = 0;
        for c in &clear {
            match self.blk(c[0], c[1], c[2]) { None => return Some("not loaded"), Some(_) => {} }
            let k = self.kind(c[0], c[1], c[2]);
            if matches!(k, Kind::Air | Kind::Passable | Kind::Climb) { continue; }
            if k != Kind::Solid { return Some("fluid"); }
            solid += 1;
            for (a, b, e) in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)] {
                let n = [c[0] + a, c[1] + b, c[2] + e];
                if clear.contains(&n) { continue; }
                if self.kind(n[0], n[1], n[2]) == Kind::Liquid { return Some("fluid behind"); }
            }
        }
        if solid == 0 { return Some("nothing to dig"); }
        None
    }
    pub fn do_tunnel(&mut self, dir: &str, dy: i32) -> Out {
        if self.tunnel_problem(self.pos, dir, dy).is_some() { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        let (clear, to, _) = Sim::tunnel_cells(self.pos, dir, dy);
        let mut ev = vec![];
        let mut ticks = TUNNEL_BASE;
        self.ph.clear();
        let mut cells = 0;
        for c in &clear {
            if self.kind(c[0], c[1], c[2]) == Kind::Solid {
                let bid = self.blk(c[0], c[1], c[2]).unwrap();
                match self.dig_plan(bid) {
                    Some(p) => {
                        // The first cell pays the swap, the aim, the break confirmation and the drop (measured: dig 37.7 and collect 22.7 + 19.6
                        // per tunnel command); the next cells are dug from the same stance and their drops are picked up on the step in.
                        let first = cells == 0; cells += 1;
                        let d = if first { MINE_AIM + MINE_CONFIRM + p.1.max(1) + 1 } else { 3 + p.1.max(1) };
                        let oh = if first { self.mine_overhead(bid, p.2) - (MINE_AIM + MINE_CONFIRM + 1) } else { 0 };
                        ticks += d + oh;
                        self.ph.push(("dig", d)); if oh > 0 { self.ph.push(("collect_drop", oh)); }
                    }
                    None => { let r = if self.d.block(bid).diggable { "missing_tool" } else { "invalid_target" }; return Out::fail(r, ticks, ev.clone()).with(self, ev); }
                }
                self.break_block(c[0], c[1], c[2], &mut ev);
            }
        }
        ticks += TUNNEL_STEP; self.ph.push(("tunnel_step", TUNNEL_STEP));
        if !self.standable(to[0], to[1], to[2]) { return Out::fail("stuck", ticks, ev.clone()).with(self, ev); }
        self.look_at(to); self.pos = to; self.reach = None; self.exh += 0.03;
        self.finish(Out::ok(ticks, vec![]), ev)
    }
    fn held_map(&self) -> HashMap<String, u32> { let mut m = HashMap::new(); for (n, c) in self.held() { m.insert(n, c); } m }
    pub fn recipe_for(&self, result: &str, with_table: bool) -> Option<usize> {
        let h = self.held_map();
        self.d.recipes.iter().position(|r| r.result == result && (with_table || !r.table) && r.need.iter().all(|(n, c)| h.get(n).copied().unwrap_or(0) >= *c))
    }
    pub fn craftable(&self, with_table: bool) -> Vec<String> {
        let h = self.held_map();
        let mut out: Vec<String> = vec![];
        for r in &self.d.recipes { if (with_table || !r.table) && !r.need.is_empty() && r.need.iter().all(|(n, c)| h.get(n).copied().unwrap_or(0) >= *c) && !out.contains(&r.result) { out.push(r.result.clone()); } }
        out
    }
    fn near_cell(&mut self, t: [i32; 3], r: f64) -> Option<f32> {
        let nodes: Vec<([i32; 3], f32)> = { let re = self.reach(); re.nodes.iter().map(|n| (*n, re.dist[n])).collect() };
        nodes.into_iter().filter(|(n, _)| ((n[0] - t[0]) as f64).powi(2) + (n[1] as f64 + EYE - t[1] as f64 - 0.5).powi(2) + ((n[2] - t[2]) as f64).powi(2) <= r * r).map(|x| x.1).fold(None, |a: Option<f32>, c| Some(a.map_or(c, |v| v.min(c))))
    }
    pub fn do_craft(&mut self, item: &str, table: Option<[i32; 3]>) -> Out {
        let mut walk = 0i64;
        let with_table = match table {
            Some(t) => { if self.name(t[0], t[1], t[2]) != "crafting_table" { return Out::fail("no_station", 1, vec![]).with(self, vec![]); }
                match self.approach(&|s, n, r| s.reach_goal(n, t, None, r), &|s, e| s.aim_ok(e, t, None, AIM_REACH)) { Ok(w) => { walk = w + 6; true } Err((r, tk)) => { let o = Out::fail(r, tk, vec![]); return self.finish(o, vec![]); } } }
            None => false,
        };
        let ri = match self.recipe_for(item, with_table) { Some(i) => i, None => return Out::fail("missing_materials", 1, vec![]).with(self, vec![]) };
        let (need, count, res) = { let r = &self.d.recipes[ri]; (r.need.clone(), r.count, r.result.clone()) };
        for (n, c) in &need { self.take(n, *c); }
        let put = self.give(&res, count);
        let ev = vec![Ev::Stat("crafted", res, put)];
        self.finish(Out::ok(if with_table { walk } else { 1 }, vec![]), ev)
    }
    /// src/skills/commands/block.js `place`: the target cell must be REPLACEABLE, it needs a solid neighbour to place against, and the
    /// bot must be able to stand (not in the target's column) where an aim point on that neighbour's face toward the target is in sight.
    pub fn do_place(&mut self, t: [i32; 3], item: &str) -> Out {
        let bid = self.d.bid(item);
        if bid == self.d.unknown { return Out::fail("invalid_args", 1, vec![]).with(self, vec![]); }
        let cur = match self.blk(t[0], t[1], t[2]) { Some(b) => self.d.block(b).name.clone(), None => return Out::fail("unreachable", 1, vec![]).with(self, vec![]) };
        if !replaceable(&cur) { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        if self.count(item) == 0 { return Out::fail("missing_item", 1, vec![]).with(self, vec![]); }
        let mut refs: Vec<([i32; 3], usize, bool)> = (0..6).filter_map(|f| {
            let n = [t[0] - FACES[f][0], t[1] - FACES[f][1], t[2] - FACES[f][2]];
            if self.kind(n[0], n[1], n[2]) == Kind::Solid { Some((n, f, interactive(self.name(n[0], n[1], n[2])))) } else { None }
        }).collect();
        if refs.is_empty() { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        refs.sort_by_key(|r| r.2);
        let free = |c: [i32; 3]| !(c[0] == t[0] && c[2] == t[2] && (c[1] == t[1] || c[1] + 1 == t[1]));
        let walk = match self.approach(&|s, n, r| free(n) && refs.iter().any(|q| s.reach_goal(n, q.0, Some(q.1), r)),
                                       &|s, e| refs.iter().any(|q| s.aim_ok(e, q.0, Some(q.1), AIM_REACH))) {
            Ok(w) => w, Err((r, tk)) => { let o = Out::fail(r, tk, vec![]); return self.finish(o, vec![]); } };
        // A mob standing in the cell: the server refuses the block, the command tries three faces and ends not_confirmed.
        if self.mobs.iter().any(|m| m.pos[0] == t[0] && m.pos[2] == t[2] && (m.pos[1] == t[1] || m.pos[1] + 1 == t[1])) {
            let o = Out::fail("not_confirmed", walk + 30, vec![]);
            return self.finish(o, vec![]);
        }
        let ticks = walk + 8;
        self.take(item, 1); self.set(t[0], t[1], t[2], bid);
        self.finish(Out::ok(ticks, vec![]), vec![Ev::Stat("used", item.to_string(), 1)])
    }
    pub fn fuel_value(name: &str) -> f64 {
        match name { "coal" | "charcoal" => 1600.0, "coal_block" => 16000.0, "lava_bucket" => 20000.0, "stick" => 100.0, "blaze_rod" => 2400.0,
            n if n.ends_with("_planks") || n.ends_with("_log") || n.ends_with("_wood") || n.ends_with("_stem") => 300.0, _ => 0.0 }
    }
    pub fn smelt_result(name: &str) -> Option<&'static str> {
        Some(match name { "raw_iron" | "iron_ore" | "deepslate_iron_ore" => "iron_ingot", "raw_gold" | "gold_ore" | "deepslate_gold_ore" => "gold_ingot", "raw_copper" | "copper_ore" | "deepslate_copper_ore" => "copper_ingot",
            "sand" | "red_sand" => "glass", "cobblestone" => "stone", "cobbled_deepslate" => "deepslate", "clay_ball" => "brick", "beef" => "cooked_beef", "porkchop" => "cooked_porkchop", "chicken" => "cooked_chicken",
            "mutton" => "cooked_mutton", "potato" => "baked_potato", "cod" => "cooked_cod", "salmon" => "cooked_salmon", "oak_log" | "spruce_log" | "birch_log" | "jungle_log" | "acacia_log" | "dark_oak_log" => "charcoal", _ => return None })
    }
    pub fn do_smelt(&mut self, item: &str, t: [i32; 3]) -> Out {
        let res = match Sim::smelt_result(item) { Some(r) => r, None => return Out::fail("invalid_args", 1, vec![]).with(self, vec![]) };
        if self.name(t[0], t[1], t[2]) != "furnace" { return Out::fail("no_station", 1, vec![]).with(self, vec![]); }
        let walk = match self.approach(&|s, n, r| s.reach_goal(n, t, None, r), &|s, e| s.aim_ok(e, t, None, AIM_REACH)) { Ok(w) => w, Err((r, tk)) => { let o = Out::fail(r, tk, vec![]); return self.finish(o, vec![]); } };
        if self.count(item) == 0 { return Out::fail("missing_item", 1, vec![]).with(self, vec![]); }
        while self.fuel < 200.0 {
            // gui.js `smelt`: the fuel that needs the fewest items (= the highest value); the first held one on a tie.
            let f = self.held().into_iter().filter(|(n, _)| n != item && Sim::fuel_value(n) > 0.0).fold(None, |b: Option<(String, u32)>, c| match b { Some(x) if Sim::fuel_value(&x.0) >= Sim::fuel_value(&c.0) => Some(x), _ => Some(c) });
            match f { Some((n, _)) => { self.take(&n, 1); self.fuel += Sim::fuel_value(&n); } None => return Out::fail("missing_materials", 1, vec![]).with(self, vec![]) }
        }
        self.fuel -= 200.0; self.take(item, 1);
        let put = self.give(res, 1);
        self.finish(Out::ok(walk + 200, vec![]), vec![Ev::Stat("crafted", res.to_string(), put)])
    }
    pub fn do_eat(&mut self, item: &str) -> Out {
        let f = match self.d.foods.get(item) { Some(f) => *f, None => return Out::fail("invalid_args", 1, vec![]).with(self, vec![]) };
        if self.count(item) == 0 { return Out::fail("missing_item", 1, vec![]).with(self, vec![]); }
        self.take(item, 1); self.food = (self.food + f.0).min(20.0); self.sat = (self.sat + f.1).min(self.food);
        self.finish(Out::ok(32, vec![]), vec![Ev::Stat("used", item.to_string(), 1)])
    }
    pub fn do_sleep(&mut self, t: [i32; 3]) -> Out {
        if !self.name(t[0], t[1], t[2]).ends_with("_bed") { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        if let Err((r, tk)) = self.approach(&|s, n, r| s.reach_goal(n, t, None, r), &|s, e| s.aim_ok(e, t, None, AIM_REACH)) { let o = Out::fail(r, tk, vec![]); return self.finish(o, vec![]); }
        if !self.is_night() { return Out::fail("not_confirmed", 20, vec![]).with(self, vec![]); }
        let next = (self.tick / DAY + 1) * DAY;
        let skip = next - self.tick;
        self.tick = next - 1;
        self.finish(Out::ok(1, vec![]), vec![]).with_slept(skip, self)
    }
    pub fn weapon_damage(&self) -> f64 {
        let mut best = 1.0;
        for (n, _) in self.held() { let t = tool_rank(&n); let d = if n.ends_with("_sword") { 4.0 + t as f64 } else if n.ends_with("_axe") { 3.0 + t as f64 } else { 0.0 }; if d > best { best = d; } }
        best
    }
    /// Distance cost to the cheapest reach node within `r` of a point (the walker can get near it), or None.
    pub(crate) fn near_cell_cost(&mut self, t: [i32; 3], r: f64) -> Option<f32> { self.near_cell(t, r) }
    /// Respawn after death: empty inventory, full health, back at the site.
    pub fn respawn(&mut self) { self.inv = vec![None; 36]; self.hp = 20.0; self.food = 20.0; self.sat = 5.0; self.exh = 0.0; self.air = 300.0; self.pos = self.site; self.track = self.site; self.dead = false; self.reach = None; self.mobs.retain(|m| !m.hostile); self.fuel = 0.0; }
    pub fn day_index(&self) -> i64 { self.day_seen }
}
trait With { fn with(self, s: &mut Sim, ev: Vec<Ev>) -> Out; fn with_slept(self, skip: i64, s: &mut Sim) -> Out; }
impl With for Out {
    fn with(mut self, s: &mut Sim, mut ev: Vec<Ev>) -> Out { s.advance(self.ticks, &mut ev); if s.dead { self.ok = false; self.reason = "cancelled"; } self.ev = ev; self }
    fn with_slept(mut self, _skip: i64, s: &mut Sim) -> Out { for e in self.ev.iter_mut() { if let Ev::Dawn(sl) = e { *sl = true; } } if !self.ev.iter().any(|e| matches!(e, Ev::Dawn(_))) && !s.dead { self.ev.push(Ev::Dawn(true)); } self }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::tile::{Chunk, Section};
    pub(crate) fn flat() -> Sim { flat_sized(3) }
    /// A flat world of side `w` chunks (stone below y = 64, air above), the bot at its centre.
    pub(crate) fn flat_sized(w: i32) -> Sim {
        let d = Rc::new(Data::load());
        let (stone, air) = (d.bid("stone"), d.air);
        let chunks = (0..w * w).map(|_| Some(Chunk { secs: (0..crate::tile::SECS).map(|i| Section::Uniform(if i < 8 { stone } else { air })).collect() })).collect();
        let c = w * 8;
        let tile = Rc::new(Tile { name: "flat".into(), site: [c, 64, c], cx0: 0, cz0: 0, w, h: w, chunks });
        let mut s = Sim::new(d, tile, 7);
        s.pos = [c, 64, c]; s.site = s.pos;
        s
    }
    #[test]
    fn walking_and_standing() {
        let mut s = flat();
        assert!(s.standable(24, 64, 24) && !s.standable(24, 63, 24));
        let o = s.do_move([30, 64, 24]);
        assert!(o.ok && s.pos == [30, 64, 24]);
        assert!((o.ticks - ((6.0f64 / (4.317 / 20.0)) * 1.06).ceil() as i64 - 5).abs() <= 1, "ticks {}", o.ticks);
        assert_eq!(s.do_move([30, 64, 60]).reason, "unreachable");          // beyond the flood radius / tile
    }
    #[test]
    fn mining_needs_the_tool_and_costs_vanilla_time() {
        let mut s = flat();
        let stone = s.d.bid("stone");
        s.set(26, 64, 24, stone);
        assert_eq!(s.do_mine([26, 64, 24]).reason, "missing_tool");
        s.give("wooden_pickaxe", 1);
        let o = s.do_mine([26, 64, 24]);
        assert!(o.ok, "{}", o.reason);
        assert_eq!(s.count("cobblestone"), 1);
        let plan = s.dig_plan(stone).unwrap();
        assert_eq!(plan.1, 23);                                              // ceil(1 / (2.0 / 1.5 / 30))
        assert!(o.ev.iter().any(|e| matches!(e, Ev::Stat("picked_up", n, 1) if n == "cobblestone")));
    }
    #[test]
    fn wood_to_table_chain() {
        let mut s = flat();
        let log = s.d.bid("oak_log");
        for y in 64..68 { s.set(28, y, 24, log); }
        for y in 64..67 { assert!(s.do_mine([28, y, 24]).ok); }
        assert_eq!(s.count("oak_log"), 3);
        assert!(s.do_craft("oak_planks", None).ok && s.count("oak_planks") == 4);
        assert!(s.do_craft("crafting_table", None).ok && s.count("crafting_table") == 1);
        let t = [s.pos[0], 64, s.pos[2] + 1];
        assert!(s.do_place(t, "crafting_table").ok);
        assert_eq!(s.name(t[0], t[1], t[2]), "crafting_table");
        s.do_craft("oak_planks", None);
        assert!(s.do_craft("stick", None).ok);
        assert_eq!(s.do_craft("wooden_pickaxe", None).reason, "missing_materials");     // 3x3 recipe: needs the table argument
        s.do_craft("oak_planks", None);
        assert!(s.do_craft("wooden_pickaxe", Some(t)).ok, "pickaxe at the table");
    }
    #[test]
    fn night_brings_zombies_and_sleep_needs_a_bed() {
        let mut s = flat();
        let mut ev = vec![];
        s.advance(13000, &mut ev);
        assert!(s.is_night());
        s.advance(2000, &mut ev);
        assert!(s.mobs.iter().any(|m| m.hostile), "no zombie after 2000 night ticks");
        s.respawn();                                                       // idle at night with nothing to fight back: dead by now
        assert_eq!(s.do_sleep([25, 64, 24]).reason, "invalid_target");
    }
    /// The trap of the real validation run (bot Train2, 181 identical `place` failures, `reason=unreachable, expanded=1`): the 9x5x9
    /// block categories the bot observed in a one-block pit (crafting tables W and N, soil E and S, a leaf canopy two blocks above the
    /// rim). Letters: . air, s soil, S stone, X crafting table, l leaves, L log. Rows are z, columns x, layers y-2..y+2.
    const TRAP: [&str; 5] = [
        ".....ssss ss.ssssss s..ssssss sssssssss sssssssss sssssssss sssssssss sssssssss sssssssss",
        ".......ss ......sss ...ssssss sssssssss sssssssss sssssssss ss.ssssss s.sssssss sssssssss",
        "lll...... ......... ...X.X..s ....XX.ss ...X@ssss ...Tsssss ....sssss ...ssssss ...ssssss",
        "lllllll.. ......... ......... l........ ll....... ll....... ll....... l........ .........",
        "..lllll.. ......... ..lllll.. lllllll.. llll.ll.. lllllll.. ll.lll... ll....... .........",
    ];
    #[test]
    fn the_real_pit_trap_makes_place_unreachable_and_a_sapling_cell_invalid() {
        let mut s = flat();
        let name = |c: char| match c { '.' => "air", 's' => "dirt", 'S' => "stone", 'X' => "crafting_table", 'l' => "oak_leaves", 'L' => "oak_log", '@' => "air", 'T' => "air", _ => "air" };
        let (cx, cy, cz) = (24, 64, 24);
        for (layer, rows) in TRAP.iter().enumerate() {
            let y = cy + layer as i32 - 2;
            for (dz, row) in rows.split(' ').enumerate() { for (dx, ch) in row.chars().enumerate() {
                let id = s.d.bid(name(ch));
                s.set(cx + dx as i32 - 4, y, cz + dz as i32 - 4, id);
            } }
        }
        s.pos = [cx, cy, cz];
        assert!(s.standable(cx, cy, cz));
        s.give("crafting_table", 1);
        let t = [cx - 1, cy, cz + 1];
        assert!(s.is_air(t[0], t[1], t[2]) && s.kind(t[0], t[1] - 1, t[2]) == Kind::Solid, "the candidate generator offers this cell");
        assert_eq!(s.do_move([cx + 3, cy, cz]).reason, "unreachable");          // walled in: no way out for the walker
        assert_eq!(s.do_place(t, "crafting_table").reason, "unreachable");      // the real outcome, 181 times
        // The same cell with a sapling on it: empty-looking, but not REPLACEABLE.
        let sap = s.d.bid("oak_sapling");
        s.set(t[0], t[1], t[2], sap);
        assert_eq!(s.do_place(t, "crafting_table").reason, "invalid_target");
    }
    #[test]
    fn open_ground_places_and_a_wall_hides_the_face() {
        let mut s = flat();
        s.give("crafting_table", 2);
        let o = s.do_place([26, 64, 24], "crafting_table");
        assert!(o.ok, "{}", o.reason);
        // Behind a closed ring of stone the cell's faces cannot be seen from any stand cell inside the ring.
        let stone = s.d.bid("stone");
        for (dx, dz) in [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)] { for dy in 0..3 { s.set(34 + dx, 64 + dy, 24 + dz, stone); } }
        for dx in -1..=1 { for dz in -1..=1 { s.set(34 + dx, 67, 24 + dz, stone); } }
        assert!(s.do_place([34, 64, 24], "crafting_table").reason == "unreachable" || s.count("crafting_table") == 0, "sealed cell");
    }
    fn put(s: &mut Sim, kind: usize, pos: [i32; 3]) -> u32 { let id = s.next_id; s.next_id += 1; s.mobs.push(Mob::hostile_of(id, kind, pos)); id }
    fn lose(s: &mut Sim, secs: i64) -> f64 { let hp0 = s.hp; let mut ev = vec![]; s.advance(secs * 20, &mut ev); hp0 - s.hp }
    #[test]
    fn zombie_hits_three_per_second_in_reach_and_knocks_the_bot_back() {
        let mut s = flat();
        s.tick = 5000; s.food = 17.0; s.exh = -1e9;                       // day, no regeneration noise
        put(&mut s, 0, [25, 64, 24]);
        let before = s.pos;
        assert!((lose(&mut s, 4) - 12.0).abs() <= 3.01, "4 s next to a zombie: about 3 hp per second");
        assert_ne!(s.pos, before, "knockback moved the bot");
    }
    #[test]
    fn arrows_need_a_line_of_sight_and_creepers_a_short_distance() {
        let mut s = flat();
        s.tick = 5000; s.food = 17.0; s.exh = -1e9;
        put(&mut s, 1, [32, 64, 24]);                                    // skeleton 8 blocks away in the open
        assert!(lose(&mut s, 60) > 0.0, "a skeleton in the open hits within a minute");
        let mut w = flat();
        w.tick = 5000; w.food = 17.0; w.exh = -1e9;
        let stone = w.d.bid("stone");
        for dy in 0..4 { for dz in -2..=2 { w.set(28, 64 + dy, 24 + dz, stone); } }   // a wall between
        put(&mut w, 1, [34, 64, 24]);
        assert_eq!(lose(&mut w, 30), 0.0, "no damage through a wall (the skeleton keeps its distance)");
        let mut c = flat();
        c.tick = 5000; c.food = 17.0; c.exh = -1e9;
        put(&mut c, 2, [26, 64, 24]);                                    // creeper 2 blocks away: fuse 1.5 s, explosion about 24 hp
        assert!(lose(&mut c, 3) >= 18.0 && c.dead, "point-blank explosion kills an unarmoured player");
    }
    #[test]
    fn a_fight_costs_hits_and_the_mob_hits_back() {
        let mut s = flat();
        s.tick = 15000; s.food = 17.0;                                       // night: zombies do not burn
        s.give("stone_sword", 1);                                         // 5 damage: 4 swings
        let id = put(&mut s, 0, [26, 64, 24]);
        let o = s.do_attack(id);
        assert!(o.ok, "{}", o.reason);
        assert!(o.ticks >= 3 * 12, "4 swings: {}", o.ticks);
        assert!(s.hp < 20.0, "the zombie fought back");
        // By hand it is 20 swings (a 12 s fight): the zombie's 3 hp per second is more than a bot has - a coin flip in the real game too.
        let mut b = flat();
        b.tick = 15000; b.food = 17.0;
        let id = put(&mut b, 0, [26, 64, 24]);
        let o = b.do_attack(id);
        assert!(o.ticks >= 8 * 12 && (o.ok || o.reason == "cancelled"), "{} {}", o.ticks, o.reason);   // 20 hp at 3 hp per second: dead after ~7 s
        assert_eq!(s.count("rotten_flesh") > 0, true);
    }
    /// The recorded failure that repeated 198 times in the real run (bot2, a floating log inside a leaf canopy, world snapshot around it in
    /// tests/case_mine_canopy.json): the candidate test passes with ONE stand cell and ONE aim point through the leaves (the JS replay of
    /// the same world finds exactly that cell), the body stops about 0.2 off its centre, the second attempt (reach 3.3) has no cell:
    /// the game says `unreachable`, every time.
    #[test]
    fn the_recorded_canopy_log_is_designated_but_cannot_be_mined() {
        let j = crate::json::parse(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/case_mine_canopy.json")).unwrap()).unwrap();
        let mut s = flat();
        let (bot, tgt) = ([3243, 87, 1253], [3243, 91, 1255]);
        let sh = [24 - bot[0], 64 - bot[1], 24 - bot[2]];
        let air = s.d.air;
        for x in -20..=20 { for y in -6..12 { for z in -20..=20 { s.set(24 + x, 64 + y, 24 + z, air); } } }
        for (k, v) in j.get("cells").obj() {
            let c: Vec<i32> = k.split(',').map(|t| t.parse().unwrap()).collect();
            let name = if v.s() == "grass" { "short_grass" } else { v.s() };
            let id = s.d.bid(name);
            if id != s.d.unknown { s.set(c[0] + sh[0], c[1] + sh[1], c[2] + sh[2], id); }
        }
        s.pos = [bot[0] + sh[0], bot[1] + sh[1], bot[2] + sh[2]];
        let t = [tgt[0] + sh[0], tgt[1] + sh[1], tgt[2] + sh[2]];
        assert!(s.standable(s.pos[0], s.pos[1], s.pos[2]));
        assert_eq!(s.name(t[0], t[1], t[2]), "oak_log");
        let stand = [3242 + sh[0], 86 + sh[1], 1256 + sh[2]];
        assert!(s.reach_goal(stand, t, None, BLOCK_REACH), "the candidate test's one cell sees the log from its centre");
        let a = s.do_mine(t);
        assert_eq!((a.ok, a.reason), (false, "unreachable"), "{} ticks {}", a.reason, a.ticks);
        assert_eq!(s.pos, [bot[0] + sh[0], bot[1] + sh[1], bot[2] + sh[2]], "and the bot is back where it started");
        let b = s.do_mine(t);
        assert_eq!(b.reason, "unreachable", "repeating it changes nothing");
    }
    #[test]
    fn a_tunnel_opened_into_water_floods_and_drowns_the_bot_a_walker_outruns_a_zombie() {
        let mut s = flat();
        s.tick = 5000; s.food = 17.0; s.exh = -1e9;
        let (stone, water) = (s.d.bid("stone"), s.d.bid("water"));
        // a water column behind a stone wall at x = 30, 3 blocks wide and tall, the bot in an open corridor next to it
        for y in 64..68 { for z in 22..=26 { s.set(30, y, z, water); s.set(31, y, z, water); } }
        for y in 64..68 { for z in 22..=26 { s.set(29, y, z, stone); } }
        s.give("wooden_pickaxe", 1);
        let o = s.do_mine([29, 64, 24]);
        assert!(o.ok, "{}", o.reason);
        assert!(s.name(29, 64, 24) == "water" && s.name(28, 64, 24) == "water" && s.name(25, 64, 24) == "water", "the corridor floods");
        // a bot walking away from a chasing zombie is not caught; the same bot standing still is
        let mut w = flat();
        w.tick = 5000; w.food = 17.0; w.exh = -1e9;
        put(&mut w, 0, [20, 64, 24]);
        let hp0 = w.hp;
        assert!(w.do_move([40, 64, 24]).ok);
        assert!(hp0 - w.hp <= 3.0, "walked 16 blocks away from a zombie 4 blocks behind: lost {}", hp0 - w.hp);
    }
    #[test]
    fn smelting_burns_the_fuel_the_real_command_picks_not_the_first_slot() {
        // gui.js `smelt` takes the fuel that needs the fewest items. A kit with tables and sticks ahead of the coal must burn coal
        // (the simulator used to take the first held fuel by slot order, and counted the crafting table as one; the real list has none).
        let mut s = flat();
        s.give("crafting_table", 5); s.give("stick", 64); s.give("coal", 8); s.give("raw_iron", 3);
        s.set(26, 64, 24, s.d.bid("furnace"));
        for _ in 0..3 { let o = s.do_smelt("raw_iron", [26, 64, 24]); assert!(o.ok, "{}", o.reason); }
        assert_eq!((s.count("iron_ingot"), s.count("coal"), s.count("crafting_table"), s.count("stick")), (3, 7, 5, 64));
        assert_eq!(Sim::fuel_value("crafting_table"), 0.0);
    }
    #[test]
    fn json_roundtrip_and_inflate() {
        let j = crate::json::parse(r#"{"a":[1,2.5,"x\n"],"b":{"c":true,"d":null}}"#).unwrap();
        assert_eq!(crate::json::parse(&j.dump()).unwrap(), j);
        // a real zlib stream (python zlib, level 9, dynamic Huffman) of 300 random words
        let z = [120,218,117,148,107,114,195,32,12,132,175,194,213,218,212,237,100,106,155,153,196,157,92,191,17,50,236,39,192,63,140,65,214,99,89,173,188,221,247,37,221,30,31,223,71,58,254,246,125,89,83,126,44,105,205,63,233,121,228,247,39,59,189,114,254,74,155,57,150,197,76,246,124,174,249,246,123,198,110,74,227,102,143,182,60,110,245,115,201,132,173,210,112,53,107,128,36,56,110,54,135,82,177,36,241,32,108,125,61,99,253,80,188,79,11,234,15,85,148,181,44,102,178,167,94,217,246,240,38,3,200,74,20,130,238,107,192,38,98,7,122,106,101,63,21,31,220,19,224,221,225,76,24,95,236,135,152,21,46,128,157,178,89,150,64,90,64,79,211,4,139,213,138,120,90,203,73,72,136,105,30,44,29,154,20,14,140,2,248,94,46,162,89,187,9,69,149,242,152,188,73,222,93,225,208,190,40,107,215,177,80,132,87,66,22,34,208,69,64,222,133,188,71,246,33,36,245,185,51,18,68,67,220,164,14,231,65,119,52,215,81,232,233,37,38,201,120,100,65,26,32,148,134,71,169,213,52,10,76,183,195,216,244,10,150,107,144,43,117,33,136,218,9,90,61,205,132,135,107,177,39,100,119,144,154,68,198,234,115,43,70,104,236,246,213,148,245,131,142,22,138,28,253,182,208,219,235,63,73,139,169,45,23,222,225,223,172,33,25,100,243,118,250,7,54,138,92,140];
        let want = "mine craft tunnel ore log stone ore wood mine mine ore ore block craft mine craft block stone log craft stone wood stone wood ore block block block ore craft tunnel log stone craft ore mine wood block wood block block tunnel block mine tunnel stone wood craft tunnel log mine wood wood log log ore ore log tunnel log block craft stone wood block block log stone stone block tunnel wood mine stone wood stone log log stone mine block wood wood craft stone tunnel tunnel tunnel craft block block ore block log wood block mine wood block wood wood tunnel stone block tunnel stone block craft stone tunnel ore tunnel tunnel wood ore stone stone stone tunnel wood ore wood tunnel craft tunnel craft tunnel tunnel wood wood block log stone craft wood mine wood mine tunnel craft block log log tunnel tunnel mine ore craft log tunnel mine ore wood mine log stone mine tunnel craft wood tunnel log tunnel craft block wood wood ore tunnel block wood block block stone block craft mine stone ore block mine stone ore wood tunnel mine log wood log mine stone stone mine block stone stone ore log craft wood mine stone block stone log tunnel craft wood ore stone tunnel mine mine log log craft mine wood craft stone ore block stone wood mine wood block stone ore tunnel stone stone craft stone log stone log ore stone log ore tunnel craft tunnel log tunnel block block wood tunnel wood mine tunnel block log craft stone block log craft stone tunnel ore block stone block stone tunnel ore tunnel block block ore stone mine mine wood log block mine block craft stone tunnel tunnel wood log ore log block log tunnel log stone ore craft mine block stone log";
        assert_eq!(String::from_utf8(crate::inflate::zlib(&z).unwrap()).unwrap(), want);
    }
}

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
pub struct Mob { pub id: u32, pub name: &'static str, pub pos: [i32; 3], pub hp: f64, pub hostile: bool }
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
    pub pos: [i32; 3], pub yaw: f64, pub hp: f64, pub food: f64, pub exh: f64, pub inv: Vec<Option<Stack>>,
    pub tick: i64, pub mobs: Vec<Mob>, pub next_id: u32, pub rng: Rng, pub site: [i32; 3], pub fuel: f64,
    pub dead: bool, day_seen: i64, regen_t: f64, pub kills: HashMap<String, u32>,
    reach: Option<Reach>,
}
const PASSIVE: [(&str, f64); 4] = [("cow", 10.0), ("pig", 10.0), ("sheep", 8.0), ("chicken", 4.0)];

fn stack_max(name: &str) -> u32 {
    if name.ends_with("_pickaxe") || name.ends_with("_axe") || name.ends_with("_shovel") || name.ends_with("_hoe") || name.ends_with("_sword") || name.ends_with("_helmet")
        || name.ends_with("_chestplate") || name.ends_with("_leggings") || name.ends_with("_boots") || name.ends_with("_bed") || name == "bow" || name == "bucket" || name == "shield" { 1 }
    else if matches!(name, "egg" | "ender_pearl" | "snowball") || name.ends_with("_sign") { 16 } else { 64 }
}
pub fn tool_rank(n: &str) -> i32 { ["wooden", "golden", "stone", "iron", "diamond", "netherite"].iter().position(|t| n.starts_with(t)).map(|p| p as i32).unwrap_or(-1) }

impl Sim {
    pub fn new(d: Rc<Data>, tile: Rc<Tile>, seed: u64) -> Sim {
        Sim { d, tile, edits: HashMap::new(), pos: [0; 3], yaw: 0.0, hp: 20.0, food: 20.0, exh: 0.0, inv: vec![None; 36], tick: 0, mobs: vec![], next_id: 1, rng: Rng(seed | 1),
            site: [0; 3], fuel: 0.0, dead: false, day_seen: 0, regen_t: 0.0, kills: HashMap::new(), reach: None }
    }
    // ---- world access ----
    #[inline] pub fn blk(&self, x: i32, y: i32, z: i32) -> Option<u16> { if let Some(&b) = self.edits.get(&(x, y, z)) { Some(b) } else { self.tile.get(x, y, z) } }
    pub fn kind(&self, x: i32, y: i32, z: i32) -> Kind { match self.blk(x, y, z) { Some(b) => self.d.block(b).kind, None => Kind::Solid } }
    pub fn name(&self, x: i32, y: i32, z: i32) -> &str { match self.blk(x, y, z) { Some(b) => &self.d.block(b).name, None => "unloaded" } }
    pub fn is_air(&self, x: i32, y: i32, z: i32) -> bool { matches!(self.kind(x, y, z), Kind::Air | Kind::Passable) }
    fn lava(&self, x: i32, y: i32, z: i32) -> bool { self.name(x, y, z) == "lava" }
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
    pub fn reach(&mut self) -> &Reach {
        if self.reach.is_none() { self.reach = Some(self.flood()); }
        self.reach.as_ref().unwrap()
    }
    fn flood(&self) -> Reach {
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
            if nodes.len() >= 1500 { break; }
            let [x, y, z] = n;
            let mut push = |m: [i32; 3], w: f32, q: &mut BinaryHeap<Qn>, dist: &mut HashMap<[i32; 3], f32>| {
                if (m[0] - start[0]).abs() > 18 || (m[2] - start[2]).abs() > 18 || (m[1] - start[1]).abs() > 12 { return; }
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
    pub fn ticks_for(&self, dist: f32) -> i64 { (dist as f64 / B_PER_TICK).ceil() as i64 + 2 }
    /// Nearest reach node (by walking cost) from which the eye is within BLOCK_REACH of the block centre and sees it.
    fn dig_node(&mut self, x: i32, y: i32, z: i32) -> Option<([i32; 3], f32)> {
        let nodes: Vec<([i32; 3], f32)> = { let r = self.reach(); r.nodes.iter().map(|n| (*n, r.dist[n])).collect() };
        let mut best: Option<([i32; 3], f32)> = None;
        for (n, c) in nodes {
            if best.map_or(false, |b| b.1 <= c) { continue; }
            let d2 = ((n[0] - x) as f64).powi(2) + (n[1] as f64 + EYE - y as f64 - 0.5).powi(2) + ((n[2] - z) as f64).powi(2);
            if d2 > BLOCK_REACH * BLOCK_REACH { continue; }
            if self.sees(n, [x, y, z]) { best = Some((n, c)); }
        }
        best
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
        // liquid next to the opened cell flows in (one step, no spreading)
        let mut fill = self.d.air;
        for (a, b, c) in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, -1)] { if self.kind(x + a, y + b, z + c) == Kind::Liquid { fill = self.blk(x + a, y + b, z + c).unwrap_or(fill); break; } }
        self.set(x, y, z, fill);
        // gravity blocks above fall into the gap
        let mut yy = y + 1;
        while matches!(self.name(x, yy, z), "sand" | "red_sand" | "gravel") && self.is_air(x, yy - 1, z) {
            let b = self.blk(x, yy, z).unwrap();
            self.set(x, yy - 1, z, b); self.set(x, yy, z, self.d.air); yy += 1;
        }
    }
    // ---- world clocks ----
    /// Advance `ticks`; mobs act, hunger and health follow. Stops early on death (the Out carries `died`).
    pub fn advance(&mut self, ticks: i64, ev: &mut Vec<Ev>) {
        let mut left = ticks;
        while left > 0 && !self.dead {
            let c = left.min(20);
            left -= c;
            let before = self.tick;
            self.tick += c;
            let frac = c as f64 / 20.0;
            if self.tick / DAY > before / DAY { ev.push(Ev::Dawn(false)); }
            self.exh += 0.002 * c as f64;
            if self.exh >= 4.0 { self.exh -= 4.0; if self.food > 0.0 { self.food -= 1.0; } }
            self.regen_t += c as f64;
            if self.regen_t >= 80.0 {
                self.regen_t -= 80.0;
                if self.food >= 18.0 && self.hp < 20.0 { self.hp += 1.0; self.exh += 0.6; } else if self.food <= 0.0 && self.hp > 1.0 { self.hp -= 1.0; }
            }
            self.mobs_step(frac);
            if self.hp <= 0.0 { self.dead = true; ev.push(Ev::Death); }
        }
    }
    fn surface_exposed(&self) -> bool { let [x, y, z] = self.pos; (y + 2..y + 40).all(|yy| !matches!(self.kind(x, yy, z), Kind::Solid)) }
    fn find_stand(&self, x: i32, z: i32, y0: i32) -> Option<i32> { (y0 - 10..=y0 + 10).rev().find(|&y| self.standable(x, y, z)) }
    fn mobs_step(&mut self, frac: f64) {
        let [bx, by, bz] = self.pos;
        let hostiles = self.mobs.iter().filter(|m| m.hostile).count();
        if hostiles < 3 && (self.is_night() || !self.surface_exposed()) && self.rng.f() < 0.12 * frac {
            for _ in 0..6 {
                let ang = self.rng.f() * std::f64::consts::TAU;
                let dd = 18.0 + self.rng.f() * 12.0;
                let (x, z) = (bx + (ang.cos() * dd) as i32, bz + (ang.sin() * dd) as i32);
                if let Some(y) = self.find_stand(x, z, by) { let id = self.next_id; self.next_id += 1; self.mobs.push(Mob { id, name: "zombie", pos: [x, y, z], hp: 20.0, hostile: true }); break; }
            }
        }
        let day_surface = !self.is_night() && self.surface_exposed();
        let mut dmg = 0.0;
        let snapshot = self.mobs.clone();
        let mut keep = vec![];
        for mut m in snapshot {
            if m.hostile {
                let far = (m.pos[0] - bx).abs().max((m.pos[2] - bz).abs()) > 44;
                if far || (day_surface && self.rng.f() < 0.1 * frac) { continue; }
                let steps = (3.5 / 20.0 * 20.0 * frac).round() as i32;
                for _ in 0..steps.max(1) {
                    let h = (((m.pos[0] - bx) as f64).powi(2) + ((m.pos[2] - bz) as f64).powi(2)).sqrt();
                    if h <= 1.5 || h > 24.0 { break; }
                    let (sx, sz) = ((bx - m.pos[0]).signum(), (bz - m.pos[2]).signum());
                    let opts = if (bx - m.pos[0]).abs() >= (bz - m.pos[2]).abs() { [(sx, 0), (0, sz)] } else { [(0, sz), (sx, 0)] };
                    for (a, b) in opts { if (a, b) == (0, 0) { continue; } if let Some(y) = self.find_stand(m.pos[0] + a, m.pos[2] + b, m.pos[1]).filter(|y| (y - m.pos[1]).abs() <= 1) { m.pos = [m.pos[0] + a, y, m.pos[2] + b]; break; } }
                }
                let h = (((m.pos[0] - bx) as f64).powi(2) + ((m.pos[2] - bz) as f64).powi(2)).sqrt();
                if h <= 1.8 && (m.pos[1] - by).abs() <= 2 { dmg += 3.0 * frac; }
            }
            keep.push(m);
        }
        self.mobs = keep;
        self.hp -= dmg;
    }
    pub fn spawn_animals(&mut self) {
        let [sx, sy, sz] = self.site;
        for _ in 0..24 {
            if self.mobs.len() >= 8 { break; }
            let (x, z) = (sx + self.rng.below(90) as i32 - 45, sz + self.rng.below(90) as i32 - 45);
            if let Some(y) = self.find_stand(x, z, sy) { if self.name(x, y - 1, z) == "grass_block" {
                let (n, hp) = PASSIVE[self.rng.below(4) as usize]; let id = self.next_id; self.next_id += 1;
                self.mobs.push(Mob { id, name: n, pos: [x, y, z], hp, hostile: false });
            } }
        }
    }
    // ---- commands ----
    fn finish(&mut self, mut o: Out, mut ev: Vec<Ev>) -> Out {
        self.advance(o.ticks, &mut ev);
        if self.dead { o.ok = false; o.reason = "died"; }
        o.ev = ev; o
    }
    pub fn do_wait(&mut self, ticks: i64) -> Out { let o = Out::ok(ticks, vec![]); self.finish(o, vec![]) }
    pub fn do_move(&mut self, t: [i32; 3]) -> Out {
        let d = self.reach().dist.get(&t).copied();
        match d {
            None => Out::fail("unreachable", 1, vec![]).with(self, vec![]),
            Some(dd) => { let ticks = self.ticks_for(dd); self.look_at(t); self.exh += 0.01 * dd as f64; self.pos = t; self.reach = None; let o = Out::ok(ticks, vec![]); self.finish(o, vec![]) }
        }
    }
    fn look_at(&mut self, t: [i32; 3]) { let (dx, dz) = ((t[0] - self.pos[0]) as f64, (t[2] - self.pos[2]) as f64); if dx != 0.0 || dz != 0.0 { self.yaw = (-dx).atan2(-dz); } }
    pub fn do_mine(&mut self, t: [i32; 3]) -> Out {
        let bid = match self.blk(t[0], t[1], t[2]) { Some(b) => b, None => return Out::fail("invalid_target", 1, vec![]).with(self, vec![]) };
        let k = self.d.block(bid).kind;
        if k != Kind::Solid { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        let plan = match self.dig_plan(bid) { Some(p) => p, None => { let r = if self.d.block(bid).harvest.is_some() && self.d.block(bid).diggable { "missing_tool" } else { "invalid_target" }; return Out::fail(r, 1, vec![]).with(self, vec![]); } };
        let (node, cost) = match self.dig_node(t[0], t[1], t[2]) { Some(n) => n, None => return Out::fail("unreachable", 2, vec![]).with(self, vec![]) };
        let mut ev = vec![];
        let ticks = self.ticks_for(cost) + plan.1.max(1) + 2;
        self.look_at([t[0], node[1], t[2]]);
        self.pos = node; self.exh += 0.005;
        self.break_block(t[0], t[1], t[2], &mut ev);
        self.reach = None;
        self.finish(Out::ok(ticks, vec![]), ev)
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
        let mut ticks = 8;
        for c in &clear {
            if self.kind(c[0], c[1], c[2]) == Kind::Solid {
                let bid = self.blk(c[0], c[1], c[2]).unwrap();
                match self.dig_plan(bid) { Some(p) => ticks += p.1.max(1) + 2, None => { let r = if self.d.block(bid).diggable { "missing_tool" } else { "invalid_target" }; return Out::fail(r, ticks, ev.clone()).with(self, ev); } }
                self.break_block(c[0], c[1], c[2], &mut ev);
            }
        }
        if !self.standable(to[0], to[1], to[2]) { return Out::fail("stuck", ticks, ev.clone()).with(self, ev); }
        self.look_at(to); self.pos = to; self.reach = None; self.exh += 0.01;
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
                match self.near_cell(t, 3.9) { Some(c) => { walk = self.ticks_for(c); true } None => return Out::fail("no_station", 1, vec![]).with(self, vec![]) } }
            None => false,
        };
        let ri = match self.recipe_for(item, with_table) { Some(i) => i, None => return Out::fail("missing_materials", 1, vec![]).with(self, vec![]) };
        let (need, count, res) = { let r = &self.d.recipes[ri]; (r.need.clone(), r.count, r.result.clone()) };
        for (n, c) in &need { self.take(n, *c); }
        let put = self.give(&res, count);
        let ev = vec![Ev::Stat("crafted", res, put)];
        self.finish(Out::ok(walk + 5, vec![]), ev)
    }
    pub fn do_place(&mut self, t: [i32; 3], item: &str) -> Out {
        if self.count(item) == 0 { return Out::fail("missing_item", 1, vec![]).with(self, vec![]); }
        if !self.is_air(t[0], t[1], t[2]) || self.kind(t[0], t[1] - 1, t[2]) != Kind::Solid || (t[0] == self.pos[0] && t[2] == self.pos[2]) { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        let bid = self.d.bid(item);
        if bid == self.d.unknown { return Out::fail("invalid_args", 1, vec![]).with(self, vec![]); }
        self.take(item, 1); self.set(t[0], t[1], t[2], bid);
        self.finish(Out::ok(6, vec![]), vec![Ev::Stat("used", item.to_string(), 1)])
    }
    pub fn fuel_value(name: &str) -> f64 {
        match name { "coal" | "charcoal" => 1600.0, "lava_bucket" => 20000.0, "stick" => 100.0, "blaze_rod" => 2400.0, n if n.ends_with("_planks") || n.ends_with("_log") || n == "crafting_table" => 300.0, _ => 0.0 }
    }
    pub fn smelt_result(name: &str) -> Option<&'static str> {
        Some(match name { "raw_iron" | "iron_ore" | "deepslate_iron_ore" => "iron_ingot", "raw_gold" | "gold_ore" | "deepslate_gold_ore" => "gold_ingot", "raw_copper" | "copper_ore" | "deepslate_copper_ore" => "copper_ingot",
            "sand" | "red_sand" => "glass", "cobblestone" => "stone", "cobbled_deepslate" => "deepslate", "clay_ball" => "brick", "beef" => "cooked_beef", "porkchop" => "cooked_porkchop", "chicken" => "cooked_chicken",
            "mutton" => "cooked_mutton", "potato" => "baked_potato", "cod" => "cooked_cod", "salmon" => "cooked_salmon", "oak_log" | "spruce_log" | "birch_log" | "jungle_log" | "acacia_log" | "dark_oak_log" => "charcoal", _ => return None })
    }
    pub fn do_smelt(&mut self, item: &str, t: [i32; 3]) -> Out {
        let res = match Sim::smelt_result(item) { Some(r) => r, None => return Out::fail("invalid_args", 1, vec![]).with(self, vec![]) };
        if self.name(t[0], t[1], t[2]) != "furnace" { return Out::fail("no_station", 1, vec![]).with(self, vec![]); }
        let walk = match self.near_cell(t, 3.9) { Some(c) => self.ticks_for(c), None => return Out::fail("no_station", 1, vec![]).with(self, vec![]) };
        if self.count(item) == 0 { return Out::fail("missing_item", 1, vec![]).with(self, vec![]); }
        while self.fuel < 200.0 {
            let f = self.held().into_iter().find(|(n, _)| n != item && Sim::fuel_value(n) > 0.0);
            match f { Some((n, _)) => { self.take(&n, 1); self.fuel += Sim::fuel_value(&n); } None => return Out::fail("missing_materials", 1, vec![]).with(self, vec![]) }
        }
        self.fuel -= 200.0; self.take(item, 1);
        let put = self.give(res, 1);
        self.finish(Out::ok(walk + 200, vec![]), vec![Ev::Stat("crafted", res.to_string(), put)])
    }
    pub fn do_eat(&mut self, item: &str) -> Out {
        let f = match self.d.foods.get(item) { Some(f) => *f, None => return Out::fail("invalid_args", 1, vec![]).with(self, vec![]) };
        if self.count(item) == 0 { return Out::fail("missing_item", 1, vec![]).with(self, vec![]); }
        self.take(item, 1); self.food = (self.food + f.0).min(20.0);
        self.finish(Out::ok(32, vec![]), vec![Ev::Stat("used", item.to_string(), 1)])
    }
    pub fn do_sleep(&mut self, t: [i32; 3]) -> Out {
        if !self.name(t[0], t[1], t[2]).ends_with("_bed") { return Out::fail("invalid_target", 1, vec![]).with(self, vec![]); }
        if self.near_cell(t, 4.5).is_none() { return Out::fail("unreachable", 1, vec![]).with(self, vec![]); }
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
    pub fn do_attack(&mut self, id: u32) -> Out {
        let mi = match self.mobs.iter().position(|m| m.id == id) { Some(i) => i, None => return Out::fail("target_lost", 1, vec![]).with(self, vec![]) };
        let m = self.mobs[mi].clone();
        let walk = match self.near_cell(m.pos, 2.6) { Some(c) => self.ticks_for(c), None => return Out::fail("unreachable", 2, vec![]).with(self, vec![]) };
        let dmg = self.weapon_damage();
        let hits = (m.hp / dmg).ceil().max(1.0);
        let fight = (hits * 12.0) as i64;
        let mut ev = vec![];
        self.exh += 0.1 * hits;
        // the fight runs through the world clock (the mob keeps hitting), the mob is gone once the bot survived it
        let mut o = Out::ok(walk + fight, vec![]);
        self.mobs.remove(mi);
        let (name, drops): (&str, Vec<(&str, u32)>) = match m.name {
            "zombie" => ("zombie", vec![("rotten_flesh", 1 + (self.rng.below(2) as u32))]), "cow" => ("cow", vec![("beef", 1 + self.rng.below(3) as u32), ("leather", 1)]),
            "pig" => ("pig", vec![("porkchop", 1 + self.rng.below(3) as u32)]), "sheep" => ("sheep", vec![("mutton", 1 + self.rng.below(2) as u32), ("white_wool", 1)]),
            _ => ("chicken", vec![("chicken", 1), ("feather", 1)]) };
        if m.hostile { self.hp -= 3.0 * (fight as f64 / 20.0).min(2.0) * 0.5; }
        if self.hp > 0.0 {
            ev.push(Ev::Killed(name.to_string(), 1));
            *self.kills.entry(name.to_string()).or_insert(0) += 1;
            for (dn, n) in drops { let put = self.give(dn, n); if put > 0 { ev.push(Ev::Stat("picked_up", dn.to_string(), put)); } }
        }
        o.ticks = walk + fight;
        self.look_at([m.pos[0], self.pos[1], m.pos[2]]);
        self.finish(o, ev)
    }
    /// Respawn after death: empty inventory, full health, back at the site.
    pub fn respawn(&mut self) { self.inv = vec![None; 36]; self.hp = 20.0; self.food = 20.0; self.exh = 0.0; self.pos = self.site; self.dead = false; self.reach = None; self.mobs.retain(|m| !m.hostile); self.fuel = 0.0; }
    pub fn day_index(&self) -> i64 { self.day_seen }
}
trait With { fn with(self, s: &mut Sim, ev: Vec<Ev>) -> Out; fn with_slept(self, skip: i64, s: &mut Sim) -> Out; }
impl With for Out {
    fn with(mut self, s: &mut Sim, mut ev: Vec<Ev>) -> Out { s.advance(self.ticks, &mut ev); if s.dead { self.ok = false; self.reason = "died"; } self.ev = ev; self }
    fn with_slept(mut self, _skip: i64, s: &mut Sim) -> Out { for e in self.ev.iter_mut() { if let Ev::Dawn(sl) = e { *sl = true; } } if !self.ev.iter().any(|e| matches!(e, Ev::Dawn(_))) && !s.dead { self.ev.push(Ev::Dawn(true)); } self }
}

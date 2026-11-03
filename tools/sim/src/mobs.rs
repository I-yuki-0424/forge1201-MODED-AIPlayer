//! Mobs of the simulator. The hostile ones act by the game's rules on Normal difficulty (melee reach and cooldown, arrows that need a
//! line of sight and miss, the creeper's fuse and the explosion's falloff with distance, knockback); how many of which kind appear
//! is not derived from the game's spawn algorithm but fitted to what the real server showed (SIM-RUST-v1.md section 11: share of
//! observations with a hostile within 16 blocks, by kind and time of day), so those two constants are the only fitted numbers here.
use crate::data::Kind;
use crate::sim::{Ev, Mob, Out, Sim, DAY};

#[derive(Clone, Copy, PartialEq)]
pub enum Atk { Melee, Bow, Fuse }
pub struct Spec { pub name: &'static str, pub hp: f64, pub speed: f64, pub follow: f64, pub burns: bool, pub atk: Atk, pub reach: f64, pub dmg: f64, pub every: f64, pub weight: f64, pub day_neutral: bool }
// speed in blocks/s, reach = horizontal distance for melee and the shooting range for the bow, every = seconds between attacks
pub const SPECS: [Spec; 4] = [
    Spec { name: "zombie", hp: 20.0, speed: 3.6, follow: 35.0, burns: true, atk: Atk::Melee, reach: 1.9, dmg: 3.0, every: 1.0, weight: 1.4, day_neutral: false },
    Spec { name: "skeleton", hp: 20.0, speed: 3.6, follow: 16.0, burns: true, atk: Atk::Bow, reach: 15.0, dmg: 3.5, every: 2.5, weight: 3.0, day_neutral: false },
    Spec { name: "creeper", hp: 20.0, speed: 3.6, follow: 16.0, burns: false, atk: Atk::Fuse, reach: 3.0, dmg: 0.0, every: 0.0, weight: 1.4, day_neutral: false },
    Spec { name: "spider", hp: 16.0, speed: 5.0, follow: 16.0, burns: false, atk: Atk::Melee, reach: 1.7, dmg: 2.0, every: 1.0, weight: 0.4, day_neutral: true },
];
/// Spawn attempts per second (fitted): on an exposed surface at night, and with rock overhead (caves, own tunnels, any time of day).
pub const SPAWN_NIGHT: f64 = 0.05;
pub const SPAWN_DARK: f64 = 0.07;
pub const HOSTILE_CAP: usize = 10;

impl Mob {
    pub fn hostile_of(id: u32, kind: usize, pos: [i32; 3]) -> Mob { let s = &SPECS[kind]; Mob { id, name: s.name, pos, hp: s.hp, hostile: true, spec: kind, cd: 1.0, fuse: -1.0 } }
    pub fn passive(id: u32, name: &'static str, pos: [i32; 3], hp: f64) -> Mob { Mob { id, name, pos, hp, hostile: false, spec: usize::MAX, cd: 0.0, fuse: -1.0 } }
}

impl Sim {
    fn spawn_hostile(&mut self, frac: f64) {
        let [bx, by, bz] = self.pos;
        if self.mobs.iter().filter(|m| m.hostile).count() >= HOSTILE_CAP { return; }
        let exposed = self.surface_exposed();
        let rate = if self.is_night() && exposed { SPAWN_NIGHT } else if !exposed { SPAWN_DARK } else { 0.0 };
        if self.rng.f() >= rate * frac { return; }
        let total: f64 = SPECS.iter().map(|s| s.weight).sum();
        let mut w = self.rng.f() * total;
        let mut kind = 0;
        for (i, s) in SPECS.iter().enumerate() { if w < s.weight { kind = i; break; } w -= s.weight; }
        for _ in 0..6 {
            let ang = self.rng.f() * std::f64::consts::TAU;
            let dd = 20.0 + self.rng.f() * 24.0;
            let (x, z) = (bx + (ang.cos() * dd) as i32, bz + (ang.sin() * dd) as i32);
            if let Some(y) = self.find_stand(x, z, by) {
                // dark enough: night under open sky, or rock overhead at any hour
                let covered = self.sky_blocked(x, y, z);
                if !(covered || self.is_night()) { continue; }
                let id = self.next_id; self.next_id += 1;
                self.mobs.push(Mob::hostile_of(id, kind, [x, y, z]));
                return;
            }
        }
    }
    /// One step of a mob along the shortest way to the bot: the neighbouring cell (8 directions, up to one block higher or three lower)
    /// with the smallest walking distance in the bot's reach field. None when the mob is outside the field.
    fn downhill(&mut self, from: [i32; 3]) -> Option<[i32; 3]> {
        self.reach();
        let r = self.reach_ref();
        let here = r.get(&from).copied();
        let mut best: Option<([i32; 3], f32)> = None;
        for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            for dy in [1, 0, -1, -2, -3] {
                let c = [from[0] + dx, from[1] + dy, from[2] + dz];
                if let Some(&d) = r.get(&c) { if here.map_or(true, |h| d < h) && best.map_or(true, |b| d < b.1) { best = Some((c, d)); } }
            }
        }
        best.map(|b| b.0)
    }
    fn los(&self, from: [i32; 3], to: [i32; 3]) -> bool {
        let a = [from[0] as f64 + 0.5, from[1] as f64 + 1.6, from[2] as f64 + 0.5];
        let b = [to[0] as f64 + 0.5, to[1] as f64 + 1.62, to[2] as f64 + 0.5];
        let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        self.ray(a, d, len).is_none()
    }
    /// Damage with its cause, in the names of the real server's damage_event log (src/rl/damage_log.js) so the two can be tabulated together.
    fn hurt(&mut self, d: f64, src: &'static str, by: &'static str, dist: f64) { self.hp -= d; self.exh += 0.1; self.hits += 1; self.dmg.push((src, by, d, dist)); }
    /// Mobs act for `frac` seconds (<= 1): arrival, movement, attacks; the bot is knocked back by a melee hit.
    pub(crate) fn mobs_step(&mut self, frac: f64) {
        self.spawn_hostile(frac);
        let [bx, by, bz] = self.pos;
        let dark_day = !self.is_night() && !self.surface_exposed();
        let day_surface = !self.is_night() && self.surface_exposed();
        let mobs = std::mem::take(&mut self.mobs);
        let mut keep = Vec::with_capacity(mobs.len());
        let mut shove: Option<[i32; 3]> = None;
        for mut m in mobs {
            if !m.hostile { keep.push(m); continue; }
            let sp = &SPECS[m.spec];
            let hdist = |m: &Mob| (((m.pos[0] - bx) as f64).powi(2) + ((m.pos[2] - bz) as f64).powi(2)).sqrt();
            let mut h = hdist(&m);
            // Despawn as in the game: instantly beyond 128 blocks, beyond 32 blocks with 1/800 per tick (2.5 % per second).
            if h > 70.0 || (h > 32.0 && self.rng.f() < 0.0247 * frac) || (sp.burns && day_surface && self.rng.f() < 0.1 * frac) { continue; }
            m.cd -= frac;
            let aggro = h <= sp.follow && !(sp.day_neutral && !self.is_night() && !dark_day);
            let stop = match sp.atk { Atk::Melee => 1.5, Atk::Bow => 8.0, Atk::Fuse => 2.0 };
            let steps = (sp.speed * frac).round() as i32;
            for _ in 0..steps.max(if aggro { 1 } else { 0 }) {
                let (tx, tz, away) = if aggro { (bx, bz, sp.atk == Atk::Bow && h < 4.0) }
                    else { (m.pos[0] + (self.rng.below(3) as i32 - 1) * 4, m.pos[2] + (self.rng.below(3) as i32 - 1) * 4, false) };
                if aggro && !away && h <= stop { break; }
                if !aggro && self.rng.f() > 0.4 * frac { break; }
                let (mut sx, mut sz) = ((tx - m.pos[0]).signum(), (tz - m.pos[2]).signum());
                if away { sx = -sx; sz = -sz; }
                // Chasing: down the walker's own distance field when the mob stands inside it (it goes round walls and up one-block
                // steps like the game's pathfinding), else straight at the bot; fleeing and wandering stay straight.
                if aggro && !away {
                    if let Some(next) = self.downhill(m.pos) { m.pos = next; h = hdist(&m); continue; }
                }
                let opts = if (tx - m.pos[0]).abs() >= (tz - m.pos[2]).abs() { [(sx, 0), (0, sz)] } else { [(0, sz), (sx, 0)] };
                for (a, b) in opts { if (a, b) == (0, 0) { continue; }
                    if let Some(y) = self.find_stand(m.pos[0] + a, m.pos[2] + b, m.pos[1]).filter(|y| (y - m.pos[1]).abs() <= 1) { m.pos = [m.pos[0] + a, y, m.pos[2] + b]; break; } }
                h = hdist(&m);
            }
            let dy = (m.pos[1] - by).abs();
            if aggro {
                match sp.atk {
                    Atk::Melee => if h <= sp.reach && dy <= 1 && m.cd <= 0.0 { m.cd = sp.every; self.hurt(sp.dmg, "mob_attack", sp.name, h); shove = Some(m.pos); },
                    Atk::Bow => if h <= sp.reach && m.cd <= 0.0 && self.los(m.pos, self.pos) {
                        m.cd = sp.every * (0.8 + 0.4 * self.rng.f());
                        if self.rng.f() < (0.85 - 0.04 * h).clamp(0.15, 0.8) { let d = sp.dmg - 0.5 + self.rng.f() * 1.5; self.hurt(d, "arrow", sp.name, h); }
                    },
                    Atk::Fuse => {
                        if m.fuse < 0.0 { if h <= sp.reach { m.fuse = 1.5; } }
                        else if h > 7.0 { m.fuse = -1.0; }
                        else {
                            m.fuse -= frac;
                            if m.fuse <= 0.0 {
                                // explosion: damage = floor((i^2 + i) / 2 * 7 * 6 + 1), i = (1 - distance / 6) x exposure (power 3, Normal)
                                let dd = (((m.pos[0] - bx) as f64).powi(2) + ((m.pos[1] - by) as f64).powi(2) + ((m.pos[2] - bz) as f64).powi(2)).sqrt();
                                let expo = if self.los(m.pos, self.pos) { 1.0 } else { 0.25 };
                                let i = (1.0 - dd / 6.0).max(0.0) * expo;
                                if i > 0.0 { let d = ((i * i + i) / 2.0 * 42.0 + 1.0).floor(); self.hurt(d, "player_explosion", sp.name, dd); }
                                continue;
                            }
                        }
                    }
                }
            }
            keep.push(m);
        }
        self.mobs = keep;
        if let Some(from) = shove { self.knockback(from); }
    }
    /// A melee hit pushes the bot one cell away from the attacker when that cell can be stood in.
    fn knockback(&mut self, from: [i32; 3]) {
        let [x, y, z] = self.pos;
        let (sx, sz) = ((x - from[0]).signum(), (z - from[2]).signum());
        let (sx, sz) = if (sx, sz) == (0, 0) { (1, 0) } else { (sx, sz) };
        for (a, b) in [(sx, sz), (sx, 0), (0, sz)] {
            if (a, b) == (0, 0) { continue; }
            if let Some(ny) = self.find_stand(x + a, z + b, y).filter(|ny| (ny - y).abs() <= 1) { self.pos = [x + a, ny, z + b]; self.invalidate(); return; }
        }
    }
    /// attack: the bot walks to the mob, then swings every 12 ticks (the weapon's damage per swing) while the mob keeps acting, until it
    /// is dead, gone, or the bot is. Ends cancelled when the bot dies (the real runner reports the cancel token first).
    pub fn do_attack(&mut self, id: u32) -> Out {
        let mut ev: Vec<Ev> = vec![];
        let m0 = match self.mobs.iter().find(|m| m.id == id) { Some(m) => m.clone(), None => return self.fail_now("target_lost", 1) };
        let walk = match self.near_cell_cost(m0.pos, 2.6) { Some(c) => self.ticks_for(c), None => return self.fail_now("unreachable", 2) };
        let dmg = self.weapon_damage();
        let mut ticks = walk;
        self.advance(walk, &mut ev);
        let mut swings = 0;
        let kill = loop {
            if self.dead { return Out { ok: false, reason: "cancelled", ticks, ev }; }
            let Some(mi) = self.mobs.iter().position(|m| m.id == id) else { return Out { ok: false, reason: "target_lost", ticks, ev }; };
            if swings >= 40 { return Out { ok: false, reason: "timeout", ticks, ev }; }
            self.mobs[mi].hp -= dmg; swings += 1; self.exh += 0.1;
            if self.mobs[mi].hp <= 0.0 { break self.mobs.remove(mi); }
            let step = if swings % 4 == 0 { 18 } else { 12 };          // every fourth swing the mob has been knocked back and is closed in on again
            ticks += step; self.advance(step, &mut ev);
        };
        self.look_at([kill.pos[0], self.pos[1], kill.pos[2]]);
        let r = &mut self.rng;
        let drops: Vec<(&str, u32)> = match kill.name {
            "zombie" => vec![("rotten_flesh", 1 + r.below(2) as u32)], "skeleton" => vec![("bone", r.below(3) as u32), ("arrow", r.below(3) as u32)],
            "creeper" => vec![("gunpowder", r.below(3) as u32)], "spider" => vec![("string", r.below(3) as u32)],
            "cow" => vec![("beef", 1 + r.below(3) as u32), ("leather", 1)], "pig" => vec![("porkchop", 1 + r.below(3) as u32)],
            "sheep" => vec![("mutton", 1 + r.below(2) as u32), ("white_wool", 1)], _ => vec![("chicken", 1), ("feather", 1)] };
        ev.push(Ev::Killed(kill.name.to_string(), 1));
        *self.kills.entry(kill.name.to_string()).or_insert(0) += 1;
        for (dn, n) in drops { if n > 0 { let put = self.give(dn, n); if put > 0 { ev.push(Ev::Stat("picked_up", dn.to_string(), put)); } } }
        Out { ok: true, reason: "ok", ticks, ev }
    }
    fn fail_now(&mut self, reason: &'static str, ticks: i64) -> Out {
        let mut ev = vec![]; self.advance(ticks, &mut ev);
        Out { ok: false, reason: if self.dead { "cancelled" } else { reason }, ticks, ev }
    }
}

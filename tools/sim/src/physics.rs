//! The vanilla player movement, one client tick: a port of TASK-076's src/native/physics (player.js, shapes.js, blocks.js, mth.js) for the
//! 1.21.1 feature set (edge probe below the feet, the jump keeps upward speed, two-candidate step-up, float Mth.sin), with its golden traces
//! (tests/golden_native/*.jsonl, recorded on the server or generated from prismarine) as the shared test. Block facts come from the per-state
//! tables (gen_data.js SIM_MC_VERSION): collision boxes, name and the properties movement reads. Elytra, riding, creative flight, entity pushing
//! are not modelled (as in the JS).
use crate::data::Data;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[inline] pub fn f(x: f64) -> f64 { x as f32 as f64 }
fn sin_table() -> &'static [f32] {
    use std::sync::OnceLock;
    static T: OnceLock<Vec<f32>> = OnceLock::new();
    T.get_or_init(|| (0..65536).map(|i| ((i as f64) * std::f64::consts::PI * 2.0 / 65536.0).sin() as f32).collect())
}
fn to_int(v: f64) -> i32 { if v.is_finite() { v.trunc() as i64 as i32 } else { 0 } }
const F_TABLE: f32 = 10430.378;
/// Mth.sin / Mth.cos of a float (up to 1.21.1).
pub fn msin(v: f64) -> f64 { sin_table()[(to_int(f(f(v) * F_TABLE as f64)) & 65535) as usize] as f64 }
pub fn mcos(v: f64) -> f64 { sin_table()[(to_int(f(f(f(v) * F_TABLE as f64) + 16384.0)) & 65535) as usize] as f64 }
fn deg() -> f64 { f(f(std::f64::consts::PI) / 180.0) }

const EPS: f64 = 1e-7;
pub type Bx = [f64; 6];
fn mv(b: &Bx, dx: f64, dy: f64, dz: f64) -> Bx { [b[0] + dx, b[1] + dy, b[2] + dz, b[3] + dx, b[4] + dy, b[5] + dz] }
fn expand(b: &Bx, dx: f64, dy: f64, dz: f64) -> Bx { [if dx < 0.0 { b[0] + dx } else { b[0] }, if dy < 0.0 { b[1] + dy } else { b[1] }, if dz < 0.0 { b[2] + dz } else { b[2] }, if dx > 0.0 { b[3] + dx } else { b[3] }, if dy > 0.0 { b[4] + dy } else { b[4] }, if dz > 0.0 { b[5] + dz } else { b[5] }] }
fn deflate(b: &Bx, d: f64) -> Bx { [b[0] + d, b[1] + d, b[2] + d, b[3] - d, b[4] - d, b[5] - d] }
fn intersects(a: &Bx, b: &Bx) -> bool { a[0] < b[3] && a[3] > b[0] && a[1] < b[4] && a[4] > b[1] && a[2] < b[5] && a[5] > b[2] }
fn collide_axis(axis: usize, b: &Bx, shapes: &[Bx], mut d: f64) -> f64 {
    let (o1, o2) = ((axis + 1) % 3, (axis + 2) % 3);
    for s in shapes {
        if d.abs() < EPS { return 0.0; }
        if !(b[o1] + EPS < s[o1 + 3] && b[o1 + 3] - EPS >= s[o1] && b[o2] + EPS < s[o2 + 3] && b[o2 + 3] - EPS >= s[o2]) { continue; }
        if d > 0.0 { if s[axis] > b[axis + 3] - EPS { let g = s[axis] - b[axis + 3]; if g >= -EPS && g < d { d = g; } } }
        else if s[axis + 3] <= b[axis] + EPS { let g = s[axis + 3] - b[axis]; if g <= EPS && g > d { d = g; } }
    }
    d
}
fn collide_with_shapes(v: [f64; 3], mut b: Bx, shapes: &[Bx]) -> [f64; 3] {
    if shapes.is_empty() { return v; }
    let [mut dx, mut dy, mut dz] = v;
    if dy != 0.0 { dy = collide_axis(1, &b, shapes, dy); if dy != 0.0 { b = mv(&b, 0.0, dy, 0.0); } }
    let zfirst = dx.abs() < dz.abs();
    if zfirst && dz != 0.0 { dz = collide_axis(2, &b, shapes, dz); if dz != 0.0 { b = mv(&b, 0.0, 0.0, dz); } }
    if dx != 0.0 { dx = collide_axis(0, &b, shapes, dx); if !zfirst && dx != 0.0 { b = mv(&b, dx, 0.0, 0.0); } }
    if !zfirst && dz != 0.0 { dz = collide_axis(2, &b, shapes, dz); }
    [dx, dy, dz]
}

#[derive(Clone, Debug)]
pub struct Fluid { pub water: bool, pub amount: f64, pub falling: bool }
/// What movement needs to know about one block state (blocks.js describe).
pub struct Facts { pub name: String, pub shapes: Vec<Bx>, pub fluid: Option<Fluid>, pub air: bool, pub friction: f64, pub speed: f64, pub jump: f64, pub climbable: bool,
    pub trapdoor: bool, pub ladder: bool, pub fence_like: bool, pub bed: bool, pub slime: bool, pub honey: bool, pub cobweb: bool, pub berry: bool, pub powder: bool,
    pub scaffolding: bool, pub bubble: Option<bool>, pub blocks_motion: bool, pub full_cube: bool, pub props: Vec<(String, String)> }
impl Facts {
    fn prop(&self, k: &str) -> Option<&str> { self.props.iter().find(|p| p.0 == k).map(|p| p.1.as_str()) }
    fn describe(d: &Data, id: u16) -> Facts {
        let b = d.block(id);
        let name = b.name.clone();
        let shapes: Vec<Bx> = if b.coll != crate::data::NO_SHAPE { d.shapes[b.coll as usize].clone() } else { vec![] };
        let pv = |k: &str| b.props.iter().find(|p| p.0 == k).map(|p| p.1.clone());
        let fluid = if name == "water" || name == "lava" {
            let lvl: i32 = pv("level").and_then(|v| v.parse().ok()).unwrap_or(0);
            Some(Fluid { water: name == "water", amount: if lvl == 0 || lvl >= 8 { 8.0 } else { (8 - lvl) as f64 }, falling: lvl >= 8 })
        } else if name == "bubble_column" || matches!(name.as_str(), "seagrass" | "tall_seagrass" | "kelp" | "kelp_plant") || pv("waterlogged").as_deref() == Some("true") {
            Some(Fluid { water: true, amount: 8.0, falling: false })
        } else { None };
        let full_cube = shapes.len() == 1 && shapes[0] == [0.0, 0.0, 0.0, 1.0, 1.0, 1.0];
        Facts {
            air: matches!(name.as_str(), "air" | "cave_air" | "void_air"),
            friction: match name.as_str() { "ice" | "packed_ice" | "frosted_ice" => f(0.98), "blue_ice" => f(0.989), "slime_block" => f(0.8), _ => f(0.6) },
            speed: match name.as_str() { "soul_sand" | "honey_block" => f(0.4), _ => 1.0 },
            jump: if name == "honey_block" { f(0.5) } else { 1.0 },
            climbable: matches!(name.as_str(), "ladder" | "vine" | "scaffolding" | "weeping_vines" | "weeping_vines_plant" | "twisting_vines" | "twisting_vines_plant" | "cave_vines" | "cave_vines_plant"),
            trapdoor: name.ends_with("_trapdoor"), ladder: name == "ladder",
            fence_like: name.ends_with("_fence") || name.ends_with("_wall") || name.ends_with("_fence_gate"),
            bed: name.ends_with("_bed"), slime: name == "slime_block", honey: name == "honey_block", cobweb: name == "cobweb", berry: name == "sweet_berry_bush",
            powder: name == "powder_snow", scaffolding: name == "scaffolding",
            bubble: if name == "bubble_column" { Some(pv("drag").as_deref() == Some("true")) } else { None },
            blocks_motion: !shapes.is_empty() && name != "cobweb" && name != "bamboo_sapling",
            full_cube, fluid, props: b.props.clone(), shapes, name,
        }
    }
}

/// The world as the movement sees it: the block state of a cell (None = not loaded).
pub trait PWorld { fn state(&self, x: i32, y: i32, z: i32) -> Option<u16>; }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pose { Standing, Crouching, Swimming }
fn height(p: Pose) -> f64 { match p { Pose::Standing => 1.8, Pose::Crouching => 1.5, Pose::Swimming => 0.6 } }
fn eye(p: Pose) -> f64 { f(match p { Pose::Standing => 1.62, Pose::Crouching => 1.27, Pose::Swimming => 0.4 }) }
#[derive(Clone, Copy, Default, Debug)]
pub struct Keys { pub forward: bool, pub back: bool, pub left: bool, pub right: bool, pub jump: bool, pub sprint: bool, pub sneak: bool }
impl Keys {
    /// The runner's key string 'FBLRJSN...' ('.' = up).
    pub fn parse(s: &str) -> Keys { let c: Vec<char> = s.chars().collect(); let on = |i: usize| c.get(i).map_or(false, |x| *x != '.'); Keys { forward: on(0), back: on(1), left: on(2), right: on(3), jump: on(4), sprint: on(5), sneak: on(6) } }
}
/// One player's movement state (player.js fresh); yaw and pitch in degrees (the game's yRot / xRot).
#[derive(Clone, Debug)]
pub struct PState {
    pub x: f64, pub y: f64, pub z: f64, pub vx: f64, pub vy: f64, pub vz: f64, pub yaw: f64, pub pitch: f64,
    pub on_ground: bool, pub hcoll: bool, pub minor_hcoll: bool, pub vcoll: bool, pub fall: f64, pub pose: Pose, pub sprinting: bool, pub swimming: bool,
    pub was_water: bool, pub eye_water: bool, pub was_eye_water: bool, pub fh_water: f64, pub fh_lava: f64, pub no_jump: i32, pub stuck: Option<[f64; 3]>,
    pub supporting: Option<[i32; 3]>, pub on_ground_no_blocks: bool, pub first_tick: bool, pub in_powder: bool, pub keys: Keys, pub food: f64, pub min_y: f64,
    xxa: f64, zza: f64,
}
impl PState {
    pub fn new(x: f64, y: f64, z: f64) -> PState {
        PState { x, y, z, vx: 0.0, vy: 0.0, vz: 0.0, yaw: 0.0, pitch: 0.0, on_ground: false, hcoll: false, minor_hcoll: false, vcoll: false, fall: 0.0, pose: Pose::Standing,
            sprinting: false, swimming: false, was_water: false, eye_water: false, was_eye_water: false, fh_water: 0.0, fh_lava: 0.0, no_jump: 0, stuck: None, supporting: None,
            on_ground_no_blocks: false, first_tick: false, in_powder: false, keys: Keys::default(), food: 20.0, min_y: -64.0, xxa: 0.0, zza: 0.0 }
    }
    fn bx(&self, pose: Pose) -> Bx { [self.x - 0.3, self.y, self.z - 0.3, self.x + 0.3, self.y + height(pose), self.z + 0.3] }
}
// attribute bases of a plain survival player
const SPEED_BASE: f64 = 0.1; const JUMP_STRENGTH: f64 = 0.42; const GRAVITY: f64 = 0.08; const STEP: f64 = 0.6; const SNEAK_SPEED: f64 = 0.3;
fn speed_value(s: &PState) -> f64 { let mut e = SPEED_BASE; if s.sprinting { e *= 1.3; } f(e.clamp(0.0, 1024.0)) }

pub struct Phys { d: Rc<Data>, facts: RefCell<HashMap<u16, Rc<Facts>>> }
impl Phys {
    pub fn new(d: Rc<Data>) -> Phys { Phys { d, facts: RefCell::new(HashMap::new()) } }
    fn at(&self, w: &dyn PWorld, x: i32, y: i32, z: i32) -> Option<Rc<Facts>> {
        let id = w.state(x, y, z)?;
        if let Some(fc) = self.facts.borrow().get(&id) { return Some(fc.clone()); }
        let fc = Rc::new(Facts::describe(&self.d, id));
        self.facts.borrow_mut().insert(id, fc.clone());
        Some(fc)
    }
    fn fluid(&self, w: &dyn PWorld, x: i32, y: i32, z: i32) -> Option<Fluid> { self.at(w, x, y, z).and_then(|f| f.fluid.clone()) }
    /// blocks.js View.shapes: scaffolding and powder snow depend on who asks.
    fn shapes(&self, w: &dyn PWorld, x: i32, y: i32, z: i32, s: &PState) -> Option<Vec<Bx>> {
        let d = self.at(w, x, y, z)?;
        let above = f(1e-5);
        if d.scaffolding {
            if s.y > y as f64 + 1.0 - above && !s.keys.sneak { return Some(d.shapes.clone()); }
            let dist: i32 = d.prop("distance").and_then(|v| v.parse().ok()).unwrap_or(0);
            return Some(if dist != 0 && d.prop("bottom") == Some("true") && s.y > y as f64 - above { vec![[0.0, 0.0, 0.0, 1.0, 0.125, 1.0]] } else { vec![] });
        }
        if d.powder {
            if s.fall > 2.5 { return Some(vec![[0.0, 0.0, 0.0, 1.0, f(0.9), 1.0]]); }
            return Some(vec![]);                                                   // walksOnPowderSnow: leather boots, not modelled
        }
        Some(d.shapes.clone())
    }
    fn boxes(&self, w: &dyn PWorld, s: &PState, q: &Bx) -> Vec<Bx> {
        let mut out = vec![];
        let (x0, x1) = ((q[0] - EPS).floor() as i32 - 1, (q[3] + EPS).floor() as i32 + 1);
        let (y0, y1) = ((q[1] - EPS).floor() as i32 - 1, (q[4] + EPS).floor() as i32 + 1);
        let (z0, z1) = ((q[2] - EPS).floor() as i32 - 1, (q[5] + EPS).floor() as i32 + 1);
        for x in x0..=x1 { for z in z0..=z1 { for y in y0..=y1 {
            let edge = (x == x0 || x == x1) as u8 + (y == y0 || y == y1) as u8 + (z == z0 || z == z1) as u8;
            if edge >= 2 { continue; }
            let sh = match self.shapes(w, x, y, z, s) { Some(v) if !v.is_empty() => v, _ => continue };
            if edge == 1 && !sh.iter().any(|b| b[0] < 0.0 || b[1] < 0.0 || b[2] < 0.0 || b[3] > 1.0 || b[4] > 1.0 || b[5] > 1.0) { continue; }
            for b in sh { let wb = [b[0] + x as f64, b[1] + y as f64, b[2] + z as f64, b[3] + x as f64, b[4] + y as f64, b[5] + z as f64]; if intersects(&wb, q) { out.push(wb); } }
        } } }
        out
    }
    fn no_collision(&self, w: &dyn PWorld, s: &PState, q: &Bx) -> bool { self.boxes(w, s, q).is_empty() }
    fn contains_liquid(&self, w: &dyn PWorld, q: &Bx) -> bool {
        for x in q[0].floor() as i32..q[3].ceil() as i32 { for y in q[1].floor() as i32..q[4].ceil() as i32 { for z in q[2].floor() as i32..q[5].ceil() as i32 { if self.fluid(w, x, y, z).is_some() { return true; } } } }
        false
    }
    fn is_free(&self, w: &dyn PWorld, s: &PState, dx: f64, dy: f64, dz: f64) -> bool { let q = mv(&s.bx(s.pose), dx, dy, dz); self.no_collision(w, s, &q) && !self.contains_liquid(w, &q) }
    fn pos(s: &PState) -> [i32; 3] { [s.x.floor() as i32, s.y.floor() as i32, s.z.floor() as i32] }
    fn in_block(&self, w: &dyn PWorld, s: &PState) -> Option<Rc<Facts>> { let p = Phys::pos(s); self.at(w, p[0], p[1], p[2]) }
    fn on_pos(&self, w: &dyn PWorld, s: &PState, fd: f64) -> [i32; 3] {
        if let Some(p) = s.supporting {
            if !(fd > 1e-5) { return p; }
            let d = self.at(w, p[0], p[1], p[2]);
            return if fd <= 0.5 && d.map_or(false, |d| d.fence_like) { p } else { [p[0], (s.y - fd).floor() as i32, p[2]] };
        }
        [s.x.floor() as i32, (s.y - fd).floor() as i32, s.z.floor() as i32]
    }
    fn below_affecting(&self, w: &dyn PWorld, s: &PState) -> [i32; 3] { self.on_pos(w, s, f(0.500001)) }
    fn fluid_height_at(&self, w: &dyn PWorld, x: i32, y: i32, z: i32, fl: &Fluid) -> f64 { match self.fluid(w, x, y + 1, z) { Some(u) if u.water == fl.water => 1.0, _ => f(fl.amount / 9.0) } }
    fn own_height(fl: &Option<Fluid>) -> f64 { fl.as_ref().map_or(0.0, |f2| f(f2.amount / 9.0)) }
    fn solid_face(&self, w: &dyn PWorld, x: i32, y: i32, z: i32, fl: &Fluid) -> bool {
        if let Some(n) = self.fluid(w, x, y, z) { if n.water == fl.water { return false; } }
        self.at(w, x, y, z).map_or(false, |d| d.full_cube && !d.name.ends_with("ice"))
    }
    fn flow(&self, w: &dyn PWorld, x: i32, y: i32, z: i32, fl: &Fluid) -> [f64; 3] {
        let own = Phys::own_height(&Some(fl.clone()));
        let (mut dx, mut dz) = (0.0, 0.0);
        for (sx, sz) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
            let n = self.fluid(w, x + sx, y, z + sz);
            if let Some(ref nn) = n { if nn.water != fl.water { continue; } }
            let mut h = Phys::own_height(&n); let mut g = 0.0;
            if h == 0.0 {
                let nb = self.at(w, x + sx, y, z + sz);
                if !nb.map_or(false, |d| d.blocks_motion) {
                    let b = self.fluid(w, x + sx, y - 1, z + sz);
                    if b.as_ref().map_or(true, |bb| bb.water == fl.water) { h = Phys::own_height(&b); if h > 0.0 { g = f(own - f(h - f(0.8888889))); } }
                }
            } else if h > 0.0 { g = f(own - h); }
            if g != 0.0 { dx += sx as f64 * g; dz += sz as f64 * g; }
        }
        let mut v = [dx, 0.0, dz];
        if fl.falling {
            for (sx, sz) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                if self.solid_face(w, x + sx, y, z + sz, fl) || self.solid_face(w, x + sx, y + 1, z + sz, fl) { v = norm(v); v[1] -= 6.0; break; }
            }
        }
        norm(v)
    }
    fn fluid_push(&self, w: &dyn PWorld, s: &mut PState, water: bool, scale: f64) -> bool {
        let bb = deflate(&s.bx(s.pose), 0.001);
        let (i, j, k, l, m, n) = (bb[0].floor() as i32, bb[3].ceil() as i32, bb[1].floor() as i32, bb[4].ceil() as i32, bb[2].floor() as i32, bb[5].ceil() as i32);
        let (mut e, mut touching, mut vx, mut vy, mut vz, mut o) = (0.0f64, false, 0.0, 0.0, 0.0, 0);
        for x in i..j { for y in k..l { for z in m..n {
            let fl = match self.fluid(w, x, y, z) { Some(fl) if fl.water == water => fl, _ => continue };
            let h = y as f64 + self.fluid_height_at(w, x, y, z, &fl);
            if h < bb[1] { continue; }
            touching = true; e = (h - bb[1]).max(e);
            let mut fv = self.flow(w, x, y, z, &fl);
            if e < 0.4 { fv = [fv[0] * e, fv[1] * e, fv[2] * e]; }
            vx += fv[0]; vy += fv[1]; vz += fv[2]; o += 1;
        } } }
        let mut len = (vx * vx + vy * vy + vz * vz).sqrt();
        if len > 0.0 {
            if o > 0 { vx /= o as f64; vy /= o as f64; vz /= o as f64; }
            vx *= scale; vy *= scale; vz *= scale; len = (vx * vx + vy * vy + vz * vz).sqrt();
            if s.vx.abs() < 0.003 && s.vz.abs() < 0.003 && len < 0.0045000000000000005 { let k2 = 0.0045000000000000005 / len; vx *= k2; vy *= k2; vz *= k2; }
            s.vx += vx; s.vy += vy; s.vz += vz;
        }
        if water { s.fh_water = e; } else { s.fh_lava = e; }
        touching
    }
    fn water_state(&self, w: &dyn PWorld, s: &mut PState) { if self.fluid_push(w, s, true, 0.014) { s.fall = 0.0; s.was_water = true; } else { s.was_water = false; } }
    fn fluids_and_eyes(&self, w: &dyn PWorld, s: &mut PState) {
        s.fh_water = 0.0; s.fh_lava = 0.0;
        self.water_state(w, s);
        self.fluid_push(w, s, false, 0.0023333333333333335);
        s.was_eye_water = s.eye_water;
        let ey = s.y + eye(s.pose) - f(0.11111111);
        let (bx, by, bz) = (s.x.floor() as i32, ey.floor() as i32, s.z.floor() as i32);
        s.eye_water = match self.fluid(w, bx, by, bz) { Some(fl) => fl.water && by as f64 + self.fluid_height_at(w, bx, by, bz, &fl) > ey, None => false };
        let p = Phys::pos(s);
        let feet = self.fluid(w, p[0], p[1], p[2]);
        s.swimming = if s.swimming { s.sprinting && s.was_water } else { s.sprinting && s.was_eye_water && feet.map_or(false, |f2| f2.water) };
    }
    fn in_lava(s: &PState) -> bool { !s.first_tick && s.fh_lava > 0.0 }
    fn on_climbable(&self, w: &dyn PWorld, s: &PState) -> bool {
        let p = Phys::pos(s);
        let d = match self.at(w, p[0], p[1], p[2]) { Some(d) => d, None => return false };
        if d.climbable { return true; }
        if d.trapdoor && d.prop("open") == Some("true") { let b = self.at(w, p[0], p[1] - 1, p[2]); return b.map_or(false, |b| b.ladder && b.prop("facing") == d.prop("facing")); }
        false
    }
    fn can_fit(&self, w: &dyn PWorld, s: &PState, pose: Pose) -> bool { self.no_collision(w, s, &deflate(&s.bx(pose), 1e-7)) }
    fn input(&self, w: &dyn PWorld, s: &mut PState) -> (f64, f64) {
        let k = s.keys;
        let mut fwd = if k.forward == k.back { 0.0 } else if k.forward { 1.0 } else { -1.0 };
        let mut left = if k.left == k.right { 0.0 } else if k.left { 1.0 } else { -1.0 };
        let crouching = self.can_fit(w, s, Pose::Crouching) && (k.sneak || !self.can_fit(w, s, Pose::Standing));
        let slowly = crouching || (s.pose == Pose::Swimming && !s.was_water);
        if slowly { let m = f(SNEAK_SPEED); fwd = f(fwd * m); left = f(left * m); }
        let (under, inw) = (s.was_eye_water, s.was_water);
        let impulse = if under { fwd > 1e-5 } else { fwd >= 0.8 };
        let food = s.food > 6.0;
        if !s.sprinting && k.sprint && impulse && food && (!inw || under) { s.sprinting = true; }
        if s.sprinting {
            let no_imp = !(fwd > 1e-5) || !food;
            let stop = no_imp || (s.hcoll && !s.minor_hcoll) || (inw && !under);
            if s.swimming { if (!s.on_ground && !k.sneak && no_imp) || !inw { s.sprinting = false; } } else if stop { s.sprinting = false; }
            if !k.sprint { s.sprinting = false; }
        }
        (fwd, left)
    }
    fn move_relative(&self, s: &mut PState, speed: f64, xxa: f64, zza: f64) {
        let lsq = xxa * xxa + zza * zza;
        if lsq < 1e-7 { return; }
        let (mut ix, mut iz) = (xxa, zza);
        if lsq > 1.0 { let l = lsq.sqrt(); ix /= l; iz /= l; }
        ix *= speed; iz *= speed;
        let r = f(s.yaw * deg());
        let (sn, cs) = (msin(r), mcos(r));
        s.vx += ix * cs - iz * sn; s.vz += iz * cs + ix * sn;
    }
    fn friction_speed(&self, s: &PState, p: f64) -> f64 { if s.on_ground { f(speed_value(s) * f(f(0.21600002) / f(f(p * p) * p))) } else if s.sprinting { f(0.025999999) } else { f(0.02) } }
    fn climb(&self, w: &dyn PWorld, s: &mut PState) {
        if !self.on_climbable(w, s) { return; }
        s.fall = 0.0;
        let c = f(0.15);
        s.vx = s.vx.clamp(-c, c); s.vz = s.vz.clamp(-c, c);
        let mut g = s.vy.max(-c);
        let inb = self.in_block(w, s);
        if g < 0.0 && !inb.map_or(false, |b| b.scaffolding) && s.keys.sneak { g = 0.0; }
        s.vy = g;
    }
    fn fluid_falling(&self, s: &mut PState, d: f64, falling: bool) {
        if d != 0.0 && !s.sprinting { s.vy = if falling && (s.vy - 0.005).abs() >= 0.003 && (s.vy - d / 16.0).abs() < 0.003 { -0.003 } else { s.vy - d / 16.0 }; }
    }
    fn travel(&self, w: &dyn PWorld, s: &mut PState, xxa: f64, zza: f64, jumping: bool) {
        let d = GRAVITY;
        let falling = s.vy <= 0.0;
        if s.swimming {
            let xr = f(s.pitch * deg()); let look = -msin(xr);
            let e = if look < -0.2 { 0.085 } else { 0.06 };
            let above = self.fluid(w, s.x.floor() as i32, (s.y + 1.0 - 0.1).floor() as i32, s.z.floor() as i32);
            if look <= 0.0 || jumping || above.is_some() { s.vy += (look - s.vy) * e; }
        }
        if s.was_water {
            let y0 = s.y;
            let fr = if s.sprinting { f(0.9) } else { f(0.8) }; let g = f(0.02);
            self.move_relative(s, g, xxa, zza);
            self.do_move(w, s);
            if s.hcoll && self.on_climbable(w, s) { s.vy = 0.2; }
            s.vx *= fr; s.vy *= f(0.8); s.vz *= fr;
            self.fluid_falling(s, d, falling);
            let (vx, vy, vz) = (s.vx, s.vy + f(0.6) - s.y + y0, s.vz);
            if s.hcoll && self.is_free(w, s, vx, vy, vz) { s.vy = f(0.3); }
        } else if Phys::in_lava(s) {
            let y0 = s.y;
            self.move_relative(s, f(0.02), xxa, zza);
            self.do_move(w, s);
            if s.fh_lava <= 0.4 { s.vx *= 0.5; s.vy *= f(0.8); s.vz *= 0.5; self.fluid_falling(s, d, falling); } else { s.vx *= 0.5; s.vy *= 0.5; s.vz *= 0.5; }
            s.vy += -d / 4.0;
            let (vx, vy, vz) = (s.vx, s.vy + f(0.6) - s.y + y0, s.vz);
            if s.hcoll && self.is_free(w, s, vx, vy, vz) { s.vy = f(0.3); }
        } else {
            let bp = self.below_affecting(w, s); let bd = self.at(w, bp[0], bp[1], bp[2]);
            let p = f(bd.as_ref().map_or(0.6, |b| b.friction));
            let fr = if s.on_ground { f(p * f(0.91)) } else { f(0.91) };
            let sp = self.friction_speed(s, p);
            self.move_relative(s, sp, xxa, zza);
            self.climb(w, s);
            self.do_move(w, s);
            if s.hcoll || jumping { let inb = self.in_block(w, s); if self.on_climbable(w, s) || inb.map_or(false, |b| b.powder && false) { s.vy = 0.2; } }
            let mut q = s.vy;
            if bd.is_some() { q -= d; } else { q = if s.y > s.min_y { -0.1 } else { 0.0 }; }
            s.vx *= fr; s.vy = q * f(0.98); s.vz *= fr;
        }
    }
    fn can_fall_at_least(&self, w: &dyn PWorld, s: &PState, dx: f64, dz: f64, h: f64) -> bool {
        let b = s.bx(s.pose);
        self.no_collision(w, s, &[b[0] + dx, b[1] - h - f(1e-5), b[2] + dz, b[3] + dx, b[1], b[5] + dz])
    }
    fn above_ground(&self, w: &dyn PWorld, s: &PState, step: f64) -> bool {
        if s.on_ground { return true; }
        if !(s.fall < step) { return false; }
        !self.can_fall_at_least(w, s, 0.0, 0.0, step - s.fall)
    }
    fn back_off_from_edge(&self, w: &dyn PWorld, s: &PState, v: [f64; 3]) -> [f64; 3] {
        let step = f(STEP);
        if v[1] > 0.0 || !s.keys.sneak || !self.above_ground(w, s, step) { return v; }
        let (mut d, mut e) = (v[0], v[2]);
        let (h, i) = (d.signum() * 0.05 * (d != 0.0) as i32 as f64, e.signum() * 0.05 * (e != 0.0) as i32 as f64);
        while d != 0.0 && self.can_fall_at_least(w, s, d, 0.0, step) { if d.abs() <= 0.05 { d = 0.0; break; } d -= h; }
        while e != 0.0 && self.can_fall_at_least(w, s, 0.0, e, step) { if e.abs() <= 0.05 { e = 0.0; break; } e -= i; }
        while d != 0.0 && e != 0.0 && self.can_fall_at_least(w, s, d, e, step) {
            d = if d.abs() <= 0.05 { 0.0 } else { d - h };
            e = if e.abs() <= 0.05 { 0.0 } else { e - i };
        }
        [d, v[1], e]
    }
    fn collide_box(&self, w: &dyn PWorld, s: &PState, v: [f64; 3], b: &Bx) -> [f64; 3] { collide_with_shapes(v, *b, &self.boxes(w, s, &expand(b, v[0], v[1], v[2]))) }
    fn collide(&self, w: &dyn PWorld, s: &PState, v: [f64; 3]) -> [f64; 3] {
        let bb = s.bx(s.pose);
        let wv = if v[0] * v[0] + v[1] * v[1] + v[2] * v[2] == 0.0 { v } else { self.collide_box(w, s, v, &bb) };
        let (cx, cy, cz) = (v[0] != wv[0], v[1] != wv[1], v[2] != wv[2]);
        let step = f(STEP);
        let hd = |a: &[f64; 3]| a[0] * a[0] + a[2] * a[2];
        if !(step > 0.0 && (s.on_ground || (cy && v[1] < 0.0)) && (cx || cz)) { return wv; }
        let mut x = self.collide_box(w, s, [v[0], step, v[2]], &bb);
        let y = self.collide_box(w, s, [0.0, step, 0.0], &expand(&bb, v[0], 0.0, v[2]));
        if y[1] < step {
            let z = self.collide_box(w, s, [v[0], 0.0, v[2]], &mv(&bb, 0.0, y[1], 0.0));
            let zz = [z[0] + y[0], z[1] + y[1], z[2] + y[2]];
            if hd(&zz) > hd(&x) { x = zz; }
        }
        if hd(&x) > hd(&wv) {
            let down = self.collide_box(w, s, [0.0, -x[1] + v[1], 0.0], &mv(&bb, x[0], x[1], x[2]));
            return [x[0] + down[0], x[1] + down[1], x[2] + down[2]];
        }
        wv
    }
    fn minor_collision(&self, s: &PState, w: [f64; 3]) -> bool {
        let r = f(s.yaw * deg()); let (d, e) = (msin(r), mcos(r));
        let (g, h) = (s.xxa * e - s.zza * d, s.zza * e + s.xxa * d);
        let (i, j) = (g * g + h * h, w[0] * w[0] + w[2] * w[2]);
        if i < 1e-5 || j < 1e-5 { return false; }
        ((g * w[0] + h * w[2]) / (i * j).sqrt()).acos() < f(0.13962634)
    }
    fn supporting_block(&self, wd: &dyn PWorld, s: &mut PState, w: [f64; 3]) {
        let b = s.bx(s.pose);
        let find = |q: Bx, s: &PState| -> Option<[i32; 3]> {
            let mut best: Option<[i32; 3]> = None; let mut bd = f64::INFINITY;
            for x in (q[0] - 1e-7).floor() as i32 - 1..=(q[3] + 1e-7).floor() as i32 + 1 { for y in (q[1] - 1e-7).floor() as i32 - 1..=(q[4] + 1e-7).floor() as i32 + 1 { for z in (q[2] - 1e-7).floor() as i32 - 1..=(q[5] + 1e-7).floor() as i32 + 1 {
                let sh = match self.shapes(wd, x, y, z, s) { Some(v) => v, None => continue };
                if !sh.iter().any(|t| intersects(&[t[0] + x as f64, t[1] + y as f64, t[2] + z as f64, t[3] + x as f64, t[4] + y as f64, t[5] + z as f64], &q)) { continue; }
                let dd = (x as f64 + 0.5 - s.x).powi(2) + (y as f64 + 0.5 - s.y).powi(2) + (z as f64 + 0.5 - s.z).powi(2);
                let later = best.map_or(false, |bb| if y != bb[1] { y > bb[1] } else if z != bb[2] { z > bb[2] } else { x > bb[0] });
                if dd < bd || (dd == bd && (best.is_none() || later)) { best = Some([x, y, z]); bd = dd; }
            } } }
            best
        };
        if !s.on_ground { s.on_ground_no_blocks = false; s.supporting = None; return; }
        let below = [b[0], b[1] - 1e-6, b[2], b[3], b[1], b[5]];
        let mut p = find(below, s);
        if p.is_none() && !s.on_ground_no_blocks { p = find(mv(&below, -w[0], 0.0, -w[2]), s); }
        s.supporting = p; s.on_ground_no_blocks = p.is_none();
    }
    fn inside_blocks(&self, w: &dyn PWorld, s: &mut PState) {
        let b = s.bx(s.pose); let e = f(1e-5);
        let feet = self.in_block(w, s);
        for x in (b[0] + e).floor() as i32..=(b[3] - e).floor() as i32 { for y in (b[1] + e).floor() as i32..=(b[4] - e).floor() as i32 { for z in (b[2] + e).floor() as i32..=(b[5] - e).floor() as i32 {
            let d = match self.at(w, x, y, z) { Some(d) => d, None => continue };
            if d.cobweb { s.fall = 0.0; s.stuck = Some([0.25, f(0.05), 0.25]); }
            else if d.berry { s.fall = 0.0; s.stuck = Some([f(0.8), 0.75, f(0.8)]); }
            else if d.powder { if feet.as_ref().map_or(false, |f2| f2.powder) { s.fall = 0.0; s.stuck = Some([f(0.9), 1.5, f(0.9)]); } s.in_powder = true; }
            else if d.honey {
                let half = 0.4375 + 0.3;
                if !s.on_ground && !(s.y > y as f64 + 0.9375 - 1e-7) && !(s.vy >= -0.08) && ((x as f64 + 0.5 - s.x).abs() + 1e-7 > half || (z as f64 + 0.5 - s.z).abs() + 1e-7 > half) {
                    if s.vy < -0.13 { let k = -0.05 / s.vy; s.vx *= k; s.vz *= k; }
                    s.vy = -0.05; s.fall = 0.0;
                }
            } else if let Some(down) = d.bubble {
                let up = self.at(w, x, y + 1, z);
                if up.map_or(false, |u| u.air) { s.vy = if down { (s.vy - 0.03).max(-0.9) } else { (s.vy + 0.1).min(1.8) }; }
                else { s.vy = if down { (s.vy - 0.03).max(-0.3) } else { (s.vy + 0.06).min(0.7) }; s.fall = 0.0; }
            }
        } } }
    }
    fn speed_factor(&self, w: &dyn PWorld, s: &PState) -> f64 {
        let feet = self.in_block(w, s);
        let mut sf = feet.as_ref().map_or(1.0, |f2| f2.speed);
        if !feet.as_ref().map_or(false, |f2| f2.name == "water" || f2.name == "bubble_column") && sf == 1.0 { let bp = self.below_affecting(w, s); sf = self.at(w, bp[0], bp[1], bp[2]).map_or(1.0, |b| b.speed); }
        f(sf)
    }
    fn do_move(&self, w: &dyn PWorld, s: &mut PState) {
        let mut v = [s.vx, s.vy, s.vz];
        if let Some(st) = s.stuck { if st[0] * st[0] + st[1] * st[1] + st[2] * st[2] > 1e-7 { v = [v[0] * st[0], v[1] * st[1], v[2] * st[2]]; s.stuck = None; s.vx = 0.0; s.vy = 0.0; s.vz = 0.0; } }
        v = self.back_off_from_edge(w, s, v);
        let wv = self.collide(w, s, v);
        if wv[0] * wv[0] + wv[1] * wv[1] + wv[2] * wv[2] > 1e-7 { s.x += wv[0]; s.y += wv[1]; s.z += wv[2]; }
        let (bx, bz) = (!((wv[0] - v[0]).abs() < f(1e-5)), !((wv[2] - v[2]).abs() < f(1e-5)));
        s.hcoll = bx || bz;
        s.vcoll = v[1] != wv[1];
        let below = s.vcoll && v[1] < 0.0;
        s.minor_hcoll = if s.hcoll { self.minor_collision(s, wv) } else { false };
        s.on_ground = below;
        self.supporting_block(w, s, wv);
        let bp = self.on_pos(w, s, f(0.2)); let bs = self.at(w, bp[0], bp[1], bp[2]);
        if !s.was_water { self.water_state(w, s); }
        if s.on_ground { s.fall = 0.0; } else if wv[1] < 0.0 { s.fall = f(s.fall - f(wv[1])); }
        if s.hcoll { if bx { s.vx = 0.0; } if bz { s.vz = 0.0; } }
        if v[1] != wv[1] {
            if bs.as_ref().map_or(false, |b| b.slime) && !s.keys.sneak { if s.vy < 0.0 { s.vy = -s.vy; } }
            else if bs.as_ref().map_or(false, |b| b.bed) && !s.keys.sneak { if s.vy < 0.0 { s.vy = -s.vy * f(0.66); } }
            else { s.vy = 0.0; }
        }
        if s.on_ground && bs.as_ref().map_or(false, |b| b.slime) { let dd = s.vy.abs(); if dd < 0.1 && !s.keys.sneak { let e = 0.4 + dd * 0.2; s.vx *= e; s.vz *= e; } }
        self.inside_blocks(w, s);
        let sf = self.speed_factor(w, s);
        s.vx *= sf; s.vz *= sf;
    }
    fn pose(&self, w: &dyn PWorld, s: &mut PState) {
        if !self.can_fit(w, s, Pose::Swimming) { return; }
        let want = if s.swimming { Pose::Swimming } else if s.keys.sneak { Pose::Crouching } else { Pose::Standing };
        s.pose = if self.can_fit(w, s, want) { want } else if self.can_fit(w, s, Pose::Crouching) { Pose::Crouching } else { Pose::Swimming };
    }
    fn jump_from_ground(&self, w: &dyn PWorld, s: &mut PState) {
        let p = Phys::pos(s); let here = self.at(w, p[0], p[1], p[2]); let bp = self.below_affecting(w, s); let below = self.at(w, bp[0], bp[1], bp[2]);
        let jf = match here { Some(ref h) if h.jump != 1.0 => h.jump, _ => below.map_or(1.0, |b| b.jump) };
        let pw = f(f(f(JUMP_STRENGTH) * f(jf)));
        if pw <= f(1e-5) { return; }
        s.vy = pw.max(s.vy);
        if s.sprinting { let r = f(s.yaw * deg()); s.vx += -msin(r) * 0.2; s.vz += mcos(r) * 0.2; }
    }
    /// One client tick of the player `s` in `w` (player.js step).
    pub fn step(&self, w: &dyn PWorld, s: &mut PState) {
        s.in_powder = false;
        self.fluids_and_eyes(w, s);
        let (fwd, left) = self.input(w, s);
        let jumping = s.keys.jump;
        if s.no_jump > 0 { s.no_jump -= 1; }
        if s.vx.abs() < 0.003 { s.vx = 0.0; }
        if s.vy.abs() < 0.003 { s.vy = 0.0; }
        if s.vz.abs() < 0.003 { s.vz = 0.0; }
        if jumping {
            let lava = Phys::in_lava(s); let k = if lava { s.fh_lava } else { s.fh_water };
            let water = s.was_water && k > 0.0; let l = 0.4;
            if !water || (s.on_ground && !(k > l)) {
                if !lava || (s.on_ground && !(k > l)) {
                    if (s.on_ground || (water && k <= l)) && s.no_jump == 0 { self.jump_from_ground(w, s); s.no_jump = 10; }
                } else { s.vy += f(0.04); }
            } else { s.vy += f(0.04); }
        } else { s.no_jump = 0; }
        let (xxa, zza) = (f(left * f(0.98)), f(fwd * f(0.98)));
        s.xxa = xxa; s.zza = zza;
        self.travel(w, s, xxa, zza, jumping);
        self.pose(w, s);
        s.first_tick = false;
    }
}
fn norm(v: [f64; 3]) -> [f64; 3] { let d = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt(); if d < 1e-4 { [0.0; 3] } else { [v[0] / d, v[1] / d, v[2] / d] } }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::Trace;
    struct TW { cols: HashMap<(i32, i32), (i32, i32, Vec<u16>)>, over: HashMap<[i32; 3], u16> }
    impl PWorld for TW {
        fn state(&self, x: i32, y: i32, z: i32) -> Option<u16> {
            if let Some(s) = self.over.get(&[x, y, z]) { return Some(*s); }
            let (min_y, h, c) = self.cols.get(&(x.div_euclid(16), z.div_euclid(16)))?;
            if y < *min_y || y >= min_y + h { return None; }
            Some(c[(((y - min_y) * 16 + z.rem_euclid(16)) * 16 + x.rem_euclid(16)) as usize])
        }
    }
    /// Every golden trace of TASK-076 (tests/golden_native, server-recorded and prismarine-generated) replayed tick by tick: the position stays
    /// within the JS test's tolerance (1e-5 for the game's own traces, 2e-5 for generated ones).
    #[test]
    fn the_golden_traces_of_the_native_physics_replay_in_rust() {
        let d = Rc::new(Data::from_file(concat!(env!("CARGO_MANIFEST_DIR"), "/data/data-1.21.1.json")).unwrap());
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden_native");
        let mut files: Vec<String> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path().display().to_string()).filter(|p| p.ends_with(".jsonl")).collect();
        files.sort();
        assert!(!files.is_empty());
        let mut bad = vec![];
        for fpath in &files {
            let text = std::fs::read_to_string(fpath).unwrap();
            let t = Trace::parse(&text).unwrap();
            let generated = t.recorder.starts_with("generated:prismarine");
            let tol = if generated { 2e-5 } else { 1e-5 };
            let mut w = TW { cols: HashMap::new(), over: HashMap::new() };
            for (_, cx, cz, min_y, h, cells) in &t.chunks { w.cols.insert((*cx, *cz), (*min_y, *h, cells.clone())); }
            for (sid, name) in &t.states { assert_eq!(&d.block(*sid as u16).name, name, "{}: state {} is {} in the trace", fpath, sid, name); }
            let ph = Phys::new(d.clone());
            assert!(t.ticks.len() > 10, "{}: no tick rows", fpath);
            let r0 = &t.ticks[0];
            let mut s = PState::new(r0.pos[0], r0.pos[1], r0.pos[2]);
            s.vx = r0.vel[0]; s.vy = r0.vel[1]; s.vz = r0.vel[2]; s.on_ground = r0.ground; s.min_y = t.min_y as f64;
            let mut blk = 0usize;
            let mut worst = (0.0f64, -1i64);
            for tk in &t.ticks[1..] {
                while blk < t.blks.len() && (t.blk_ticks[blk] as i64) <= tk.tick { let (_, p, sid) = t.blks[blk]; w.over.insert(p, sid as u16); blk += 1; }
                s.yaw = f((std::f64::consts::PI - tk.yaw) * 180.0 / std::f64::consts::PI); s.pitch = f(-tk.pitch * 180.0 / std::f64::consts::PI);
                s.keys = Keys::parse(&tk.keys);
                ph.step(&w, &mut s);
                let dp = ((s.x - tk.pos[0]).powi(2) + (s.y - tk.pos[1]).powi(2) + (s.z - tk.pos[2]).powi(2)).sqrt();
                if dp > worst.0 { worst = (dp, tk.tick); }
            }
            if worst.0 > tol { bad.push(format!("{}: off by {:.2e} at tick {} (tolerance {:.0e})", fpath.rsplit('/').next().unwrap(), worst.0, worst.1, tol)); }
        }
        assert!(bad.is_empty(), "{} of {} golden traces off:\n{}", bad.len(), files.len(), bad.join("\n"));
    }
}

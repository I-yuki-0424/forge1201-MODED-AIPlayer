//! Target scan (docs/proposed/MOE-v2.md): where the nearest blocks of a few goal-related groups are, seen or not, within 4 chunks of the bot's chunk.
//! The experts' view (a 24-block ray fan, a 9x9x5 grid) hides ore that lies behind a hill or under the ground; the router tells an expert which groups
//! matter and the expert gets only those, as vectors. Privileged information on purpose (owner 2026-11-09): nothing here is specific to the real game's
//! view, though the real bot has every block of its loaded chunks, so the same scan can be made from the client's chunk data.
//! Switched on by the scenario key `scan`; without it no observation field and no candidate changes (older runs stay comparable).
use crate::sim::Sim;
use crate::tile::{Section, Tile, MINY, SECS};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// log, coal, iron are found in the world; way = the scenario's waypoint; sky = the standing cell on top of the bot's own column.
pub const GROUPS: [&str; 5] = ["log", "coal", "iron", "way", "sky"];
pub const NATURAL: usize = 3;
pub const M: usize = 3;
pub const CHUNKS: i32 = 4;
pub const R: f64 = 64.0;
/// Block names an item's expert may want, per natural group (the representative item of a group is the first one).
pub const REP: [&str; 5] = ["oak_log", "coal_ore", "iron_ore", "", ""];

pub fn group_of(name: &str) -> Option<usize> {
    if name.ends_with("_log") || name.ends_with("_stem") { Some(0) }
    else if name == "coal_ore" || name == "deepslate_coal_ore" { Some(1) }
    else if name == "iron_ore" || name == "deepslate_iron_ore" { Some(2) }
    else { None }
}

pub struct Idx { pos: Vec<HashMap<(i32, i32), Vec<[i32; 3]>>> }
thread_local! { static CACHE: RefCell<HashMap<String, Rc<Idx>>> = RefCell::new(HashMap::new()); }

fn build(s: &Sim, t: &Tile) -> Idx {
    let tab: Vec<i8> = (0..s.d.blocks.len()).map(|i| group_of(&s.d.blocks[i].name).map_or(-1, |g| g as i8)).collect();
    let g = |b: u16| tab.get(b as usize).copied().unwrap_or(-1);
    let mut pos: Vec<HashMap<(i32, i32), Vec<[i32; 3]>>> = vec![HashMap::new(); NATURAL];
    for (ci, c) in t.chunks.iter().enumerate() {
        let c = match c { Some(c) => c, None => continue };
        let (cx, cz) = (t.cx0 + ci as i32 % t.w, t.cz0 + ci as i32 / t.w);
        for si in 0..SECS {
            let sec = &c.secs[si];
            match sec {
                Section::Uniform(b) => { if g(*b) < 0 { continue; } }
                Section::Pal(p, _) => { if !p.iter().any(|b| g(*b) >= 0) { continue; } }
                Section::Raw(_) => {}
            }
            for i in 0..4096usize {
                let b = sec.get(i);
                let k = g(b);
                if k >= 0 { pos[k as usize].entry((cx, cz)).or_default().push([cx * 16 + (i & 15) as i32, MINY + si as i32 * 16 + (i >> 8) as i32, cz * 16 + ((i >> 4) & 15) as i32]); }
            }
        }
    }
    Idx { pos }
}
fn idx(s: &Sim) -> Option<Rc<Idx>> {
    if s.tile.name.is_empty() || s.tile.chunks.is_empty() { return None; }
    CACHE.with(|c| {
        if let Some(i) = c.borrow().get(&s.tile.name) { return Some(i.clone()); }
        let i = Rc::new(build(s, &s.tile));
        let mut m = c.borrow_mut();
        if m.len() >= 8 { m.clear(); }
        m.insert(s.tile.name.clone(), i.clone());
        Some(i)
    })
}
#[inline] fn chunk_apart(a: [i32; 3], b: [i32; 3]) -> i32 { (a[0].div_euclid(16) - b[0].div_euclid(16)).abs().max((a[2].div_euclid(16) - b[2].div_euclid(16)).abs()) }
fn d3(a: [i32; 3], b: [i32; 3]) -> f64 { (((a[0] - b[0]) as f64).powi(2) + ((a[1] - b[1]) as f64).powi(2) + ((a[2] - b[2]) as f64).powi(2)).sqrt() }

thread_local! { static TOPS: RefCell<(String, HashMap<(i32, i32), i32>)> = RefCell::new((String::new(), HashMap::new())); }
fn solid_ish(s: &Sim, x: i32, y: i32, z: i32) -> Option<bool> { s.blk(x, y, z).map(|b| !matches!(s.d.block(b).kind, crate::data::Kind::Air | crate::data::Kind::Passable)) }
/// The top non-air cell of the tile's own blocks in column (x, z), cached per tile (the column walk is 380 lookups; edits are looked at on top of it).
fn natural_top(s: &Sim, x: i32, z: i32) -> Option<i32> {
    TOPS.with(|c| {
        let mut c = c.borrow_mut();
        if c.0 != s.tile.name { c.0 = s.tile.name.clone(); c.1.clear(); }
        if let Some(&y) = c.1.get(&(x, z)) { return Some(y); }
        for y in (MINY..MINY + 380).rev() {
            let b = s.tile.get(x, y, z)?;
            if !matches!(s.d.block(b).kind, crate::data::Kind::Air | crate::data::Kind::Passable) { c.1.insert((x, z), y); return Some(y); }
        }
        None
    })
}
/// The standing cell on top of column (x, z): the first non-air cell from the sky down (leaves count as ground; the bot cannot walk through them).
pub fn surface(s: &Sim, x: i32, z: i32) -> Option<[i32; 3]> {
    let nat = natural_top(s, x, z)?;
    let mut y = nat + 24;                                                  // placed blocks may stand above the natural top
    while y > nat && !solid_ish(s, x, y, z)? { y -= 1; }
    while y > MINY && !solid_ish(s, x, y, z)? { y -= 1; }                  // a carved top (a shaft) is air: on down to the next solid cell
    Some([x, y + 1, z])
}

/// The M nearest cells of group `g` within CHUNKS chunks of the bot, nearest first.
pub fn nearest(s: &Sim, g: usize, ix: &Option<Rc<Idx>>) -> Vec<[i32; 3]> {
    let me = s.pos;
    let mut v: Vec<(f64, [i32; 3])> = vec![];
    match g {
        3 => { if let Some(w) = s.way { v.push((d3(me, w), w)); } }
        // the top of the highest column within 2 blocks (a shaft's own column is open to the sky, its rim is not), the nearest of equal height
        4 => {
            let mut best: Option<[i32; 3]> = None;
            for dz in -2..=2 { for dx in -2..=2 { if let Some(t) = surface(s, me[0] + dx, me[2] + dz) {
                let better = best.map_or(true, |b| t[1] > b[1] || (t[1] == b[1] && d3(me, t) < d3(me, b)));
                if better { best = Some(t); }
            } } }
            if let Some(t) = best { v.push((d3(me, t), t)); }
        }
        _ => {
            let want = |p: [i32; 3]| -> bool { s.blk(p[0], p[1], p[2]).map_or(false, |b| group_of(&s.d.block(b).name) == Some(g)) };
            // the cheap distance test first: the block lookups run only for cells that would enter the M nearest
            let mut push = |p: [i32; 3], v: &mut Vec<(f64, [i32; 3])>| {
                let d = d3(me, p);
                if v.len() < M || d < v[v.len() - 1].0 { v.push((d, p)); v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)); v.truncate(M); }
            };
            let worse = |p: [i32; 3], v: &Vec<(f64, [i32; 3])>| v.len() >= M && d3(me, p) >= v[v.len() - 1].0;
            // rings of chunks outward from the bot's own; stop once the M found are nearer than anything a farther ring can hold
            if let Some(ix) = ix {
                let (mx, mz) = (me[0].div_euclid(16), me[2].div_euclid(16));
                for r in 0..=CHUNKS {
                    if v.len() >= M && v[M - 1].0 <= ((r - 1).max(0) * 16) as f64 { break; }
                    for cz in mz - r..=mz + r { for cx in mx - r..=mx + r {
                        if (cx - mx).abs().max((cz - mz).abs()) != r { continue; }
                        if let Some(b) = ix.pos[g].get(&(cx, cz)) { for &p in b { if !worse(p, &v) && !s.edits.contains_key(&(p[0], p[1], p[2])) && want(p) { push(p, &mut v); } } }
                    } }
                }
            }
            for (k, _) in s.edits.iter() { let p = [k.0, k.1, k.2]; if chunk_apart(me, p) <= CHUNKS && !worse(p, &v) && want(p) { push(p, &mut v); } }
        }
    }
    v.into_iter().map(|x| x.1).collect()
}

/// For every group the nearest M cells; flat vector [g][m][dx, dy, dz, dist, present] and the nearest target of each group for the candidates' progress.
pub fn scan(s: &Sim) -> (Vec<f64>, Vec<Option<[i32; 3]>>) {
    let ix = idx(s);
    let me = s.pos;
    let mut out = Vec::with_capacity(GROUPS.len() * M * 5);
    let mut first = vec![];
    for g in 0..GROUPS.len() {
        let l = nearest(s, g, &ix);
        first.push(l.first().copied());
        for m in 0..M {
            match l.get(m) {
                Some(p) => { let c = |x: f64| (x / R).max(-1.0).min(1.0); out.extend_from_slice(&[c((p[0] - me[0]) as f64), c((p[1] - me[1]) as f64), c((p[2] - me[2]) as f64), (d3(me, *p) / R).min(1.0), 1.0]); }
                None => out.extend_from_slice(&[0.0; 5]),
            }
        }
    }
    (out.iter().map(|x| (x * 1e4).round() / 1e4).collect(), first)
}
/// How much a command that ends at `q` shortens the distance to each group's nearest target (blocks / 16, -1..1); 0 where there is no target.
pub fn progress(first: &[Option<[i32; 3]>], from: [i32; 3], q: [i32; 3]) -> Vec<f64> {
    first.iter().map(|t| t.map_or(0.0, |t| (((d3(from, t) - d3(q, t)) / 16.0).max(-1.0).min(1.0) * 1e4).round() / 1e4)).collect()
}

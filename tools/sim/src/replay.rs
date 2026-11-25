//! `replay`: the parity check of the simulator against the real server (TASK-20261125-078, docs/proposed/SIM-PARITY-v1.md).
//! Reads traces written by `scripts/sim/record.js` (one JSONL file per bot: chunk snapshots and block updates as the server sent them, and
//! per command its arguments, the bot's state before, and the outcome after), runs every command the simulator models on the same blocks
//! from the same state, and compares outcome by outcome. Each command starts from the RECORDED world and bot (teacher forcing), so one
//! divergence never carries into the next command; every divergence gets one or more categories.
//!
//!   forgeaip-sim replay TRACE.jsonl... [--data data/data-1.21.1.json] [--rows rows.jsonl] [--json summary.json] [--near 6]
use crate::data::Data;
use crate::inflate;
use crate::json::{self, J};
use crate::sim::{Sim, Stack};
use crate::tile::{Chunk, Section, Tile, MINY, SECS};
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

/// Commands the simulator models (the others are counted as `unsupported`: a coverage gap, not a divergence).
pub const MODELLED: [&str; 8] = ["move_to", "mine", "tunnel", "place", "craft", "smelt", "eat", "equip"];
/// Divergence categories (the task's list plus the ones the comparison needs); `unsupported` and `data` are reported apart.
pub const CATEGORIES: [&str; 16] = ["movement_reach", "collision", "walk_time", "dig_time", "dig_rules", "placement_rules", "place_time", "fluids", "drops",
    "gravity_blocks", "hunger", "light", "recipes", "inventory_other", "blocks_other", "other_time"];
/// Ticks agree when within this share of the real count, or within TICK_ABS ticks for short commands.
pub const TICK_REL: f64 = 0.10;
pub const TICK_ABS: i64 = 2;

#[derive(Clone, Debug, Default)]
pub struct State { pub pos: [f64; 3], pub hp: f64, pub food: f64, pub sat: f64, pub air: f64, pub inv: Vec<(u32, String, u32)> }
impl State {
    fn parse(j: &J) -> State {
        let p = j.get("pos");
        State { pos: [p.at(0).f(), p.at(1).f(), p.at(2).f()], hp: j.get("hp").f(), food: j.get("food").f(), sat: j.get("sat").f(), air: j.get("air").f(),
            inv: j.get("inv").arr().iter().map(|r| (r.at(0).i() as u32, r.at(1).s().to_string(), r.at(2).i() as u32)).collect() }
    }
    /// The cell the feet are in (a hair above, so 63.99999 from float noise counts as 64).
    pub fn cell(&self) -> [i32; 3] { [self.pos[0].floor() as i32, (self.pos[1] + 1e-3).floor() as i32, self.pos[2].floor() as i32] }
    /// Item counts in the 36 main slots (mineflayer slots 9-44), which is all the simulator holds.
    fn counts(&self) -> BTreeMap<String, i64> { let mut m = BTreeMap::new(); for (s, n, c) in &self.inv { if (9..=44).contains(s) { *m.entry(n.clone()).or_insert(0) += *c as i64; } } m }
}
pub struct Cmd { pub id: u64, pub layer: String, pub name: String, pub args: J, pub t0: f64, pub t1: f64, pub before: State, pub after: State, pub ok: bool, pub reason: String, pub ticks: Option<i64> }
/// One bot's trace.
pub struct Trace {
    pub bot: String, pub version: String,
    pub states: HashMap<u32, String>,
    /// (ms, cx, cz, minY, height, state ids y-major / z / x)
    pub chunks: Vec<(f64, i32, i32, i32, i32, Vec<u16>)>,
    /// (ms, cell, state id) in file order
    pub blks: Vec<(f64, [i32; 3], u32)>,
    pub cmds: Vec<Cmd>,
}

fn b64(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut n) = (0u32, 0u32);
    for &c in s.as_bytes() {
        let v = match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, b'=' => break, _ => return Err("base64: bad character".into()) } as u32;
        buf = (buf << 6) | v; n += 6;
        if n >= 8 { n -= 8; out.push((buf >> n) as u8); buf &= (1 << n) - 1; }
    }
    Ok(out)
}

impl Trace {
    pub fn parse(text: &str) -> Result<Trace, String> {
        let mut t = Trace { bot: String::new(), version: String::new(), states: HashMap::new(), chunks: vec![], blks: vec![], cmds: vec![] };
        let mut open: HashMap<u64, Cmd> = HashMap::new();
        for (ln, line) in text.lines().enumerate() {
            if line.trim().is_empty() { continue; }
            let j = json::parse(line).map_err(|e| format!("line {}: {}", ln + 1, e))?;
            match j.get("t").s() {
                "hello" => { if j.get("format").i() != 1 { return Err(format!("line {}: trace format {} (this replayer reads 1)", ln + 1, j.get("format").i())); }
                    t.bot = j.get("bot").s().to_string(); t.version = j.get("version").s().to_string(); }
                "st" => { t.states.insert(j.get("id").i() as u32, j.get("n").s().to_string()); }
                "chunk" => {
                    if j.get("enc").s() != "u16le-deflate-b64" { return Err(format!("line {}: chunk encoding {}", ln + 1, j.get("enc").s())); }
                    let raw = inflate::zlib(&b64(j.get("cells").s())?)?;
                    let cells: Vec<u16> = raw.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                    let (min_y, height) = (j.get("minY").i() as i32, j.get("height").i() as i32);
                    if cells.len() != (256 * height) as usize { return Err(format!("line {}: chunk has {} cells, want {}", ln + 1, cells.len(), 256 * height)); }
                    t.chunks.push((j.get("ms").f(), j.get("cx").i() as i32, j.get("cz").i() as i32, min_y, height, cells));
                }
                "blk" => { let p = j.get("p"); t.blks.push((j.get("ms").f(), [p.at(0).i() as i32, p.at(1).i() as i32, p.at(2).i() as i32], j.get("s").i() as u32)); }
                "cmd" => { let id = j.get("id").i() as u64;
                    open.insert(id, Cmd { id, layer: j.get("layer").s().to_string(), name: j.get("name").s().to_string(), args: j.get("args").clone(), t0: j.get("ms").f(), t1: f64::NAN,
                        before: State::parse(j.get("before")), after: State::default(), ok: false, reason: String::new(), ticks: None }); }
                "res" => { if let Some(mut c) = open.remove(&(j.get("id").i() as u64)) {
                    c.t1 = j.get("ms").f(); c.ok = j.get("ok").b(); c.reason = j.get("reason").s().to_string(); c.after = State::parse(j.get("after"));
                    c.ticks = if j.get("ticks").is_null() { None } else { Some(j.get("ticks").i()) };
                    t.cmds.push(c); } }
                _ => {}                                                    // spawn, death, and later line kinds: not needed here
            }
        }
        t.cmds.sort_by(|a, b| a.t0.partial_cmp(&b.t0).unwrap_or(std::cmp::Ordering::Equal));
        Ok(t)
    }
    pub fn state_name(&self, id: u32) -> &str { self.states.get(&id).map(|s| s.as_str()).unwrap_or("?") }
}

/// The world the simulator replays on: the FIRST snapshot of every chunk as the tile, later block updates as edits in time order.
pub struct World { pub tile: Rc<Tile>, pub events: Vec<(f64, [i32; 3], u16)>, pub unknown: BTreeMap<String, u32> }
pub fn world(t: &Trace, d: &Data) -> World {
    let mut unknown = BTreeMap::new();
    let mut map: HashMap<u32, u16> = HashMap::new();
    let mut sim_id = |id: u32, unknown: &mut BTreeMap<String, u32>| -> u16 {
        *map.entry(id).or_insert_with(|| { let n = t.state_name(id); let b = d.bid(n); if b == d.unknown { *unknown.entry(n.to_string()).or_insert(0) += 1; } b })
    };
    let mut first: HashMap<(i32, i32), usize> = HashMap::new();
    for (i, c) in t.chunks.iter().enumerate() { first.entry((c.1, c.2)).or_insert(i); }
    let (mut x0, mut z0, mut x1, mut z1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for &(cx, cz) in first.keys() { x0 = x0.min(cx); z0 = z0.min(cz); x1 = x1.max(cx); z1 = z1.max(cz); }
    let (w, h) = if first.is_empty() { (0, 0) } else { (x1 - x0 + 1, z1 - z0 + 1) };
    let mut chunks: Vec<Option<Chunk>> = (0..w * h).map(|_| None).collect();
    let mut events: Vec<(f64, [i32; 3], u16)> = vec![];
    let mut cur: HashMap<(i32, i32), Vec<u16>> = HashMap::new();           // the current copy of each chunk, in sim ids (for re-snapshots)
    for (i, (ms, cx, cz, min_y, height, cells)) in t.chunks.iter().enumerate() {
        let ids: Vec<u16> = cells.iter().map(|&s| sim_id(s as u32, &mut unknown)).collect();
        if first[&(*cx, *cz)] == i {
            let mut secs = vec![];
            for s in 0..SECS as i32 {
                let base = MINY + 16 * s;
                if base < *min_y || base + 16 > min_y + height { secs.push(Section::Uniform(d.air)); continue; }
                let off = ((base - min_y) * 256) as usize;
                secs.push(Section::from_blocks(&ids[off..off + 4096]));
            }
            chunks[((cz - z0) * w + (cx - x0)) as usize] = Some(Chunk { secs });
        } else if let Some(old) = cur.get(&(*cx, *cz)) {
            // sent again (respawn, reload): the cells that differ from what the replay holds become edits at that moment
            for (k, (&a, &b)) in old.iter().zip(ids.iter()).enumerate() { if a != b { let (y, z, x) = (k as i32 / 256 + min_y, (k as i32 / 16) % 16, k as i32 % 16); events.push((*ms, [cx * 16 + x, y, cz * 16 + z], b)); } }
        }
        cur.insert((*cx, *cz), ids);
    }
    for (ms, p, s) in &t.blks { events.push((*ms, *p, sim_id(*s, &mut unknown))); }
    events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    World { tile: Rc::new(Tile { name: t.bot.clone(), site: [0; 3], cx0: x0.min(x1), cz0: z0.min(z1), w, h, chunks }), events, unknown }
}

/// One compared command.
pub struct Row { pub bot: String, pub id: u64, pub name: String, pub supported: bool, pub real: Outcome, pub sim: Outcome, pub agree: Agree, pub cats: Vec<&'static str> }
#[derive(Clone, Debug, Default)]
pub struct Outcome { pub ok: bool, pub reason: String, pub ticks: Option<i64>, pub cell: [i32; 3], pub blocks: BTreeMap<[i32; 3], String>, pub inv: BTreeMap<String, i64>, pub food: f64 }
#[derive(Clone, Copy, Debug, Default)]
pub struct Agree { pub outcome: bool, pub cell: bool, pub blocks: bool, pub inv: bool, pub ticks: bool, pub food: bool }
impl Agree { pub fn all(&self) -> bool { self.outcome && self.cell && self.blocks && self.inv } }

fn arg_cell(a: &J) -> Option<[i32; 3]> { if a.get("x").is_null() || a.get("y").is_null() || a.get("z").is_null() { None } else { Some([a.get("x").i() as i32, a.get("y").i() as i32, a.get("z").i() as i32]) } }
fn dist2(a: [i32; 3], b: [i32; 3]) -> i32 { (a[0] - b[0]).pow(2) + (a[1] - b[1]).pow(2) + (a[2] - b[2]).pow(2) }
fn delta(a: &BTreeMap<String, i64>, b: &BTreeMap<String, i64>) -> BTreeMap<String, i64> {
    let mut m = BTreeMap::new();
    for k in a.keys().chain(b.keys()) { let v = b.get(k).copied().unwrap_or(0) - a.get(k).copied().unwrap_or(0); if v != 0 { m.insert(k.clone(), v); } }
    m
}
const FLUID: [&str; 3] = ["water", "lava", "bubble_column"];
fn gravity(n: &str) -> bool { matches!(n, "sand" | "red_sand" | "gravel" | "suspicious_sand" | "suspicious_gravel" | "anvil" | "chipped_anvil" | "damaged_anvil" | "pointed_dripstone" | "dragon_egg" | "scaffolding") || n.ends_with("_concrete_powder") }

/// Put the recorded bot state into the simulator: cell, the 36 main slots, health and food; mobs off (the parity tests run peaceful).
fn load_state(s: &mut Sim, st: &State, skipped: &mut BTreeMap<String, u32>) {
    s.pos = st.cell(); s.track = s.pos; s.hp = st.hp; s.food = st.food; s.sat = st.sat; s.exh = 0.0; s.air = if st.air > 0.0 { st.air * 15.0 } else { 300.0 };
    s.dead = false; s.mobs.clear(); s.hostile_scale = 0.0; s.fuel = 0.0; s.tick = 6000; s.dmg.clear(); s.ph.clear(); s.invalidate();
    s.inv = vec![None; 36];
    for (slot, name, n) in &st.inv {
        if !(9..=44).contains(slot) { continue; }
        let id = s.d.item(name);
        if id == 0 { *skipped.entry(name.clone()).or_insert(0) += 1; continue; }
        s.inv[(*slot - 9) as usize] = Some(Stack { item: id, n: *n });
    }
}

/// Run one command in the simulator. None = not modelled.
fn sim_command(s: &mut Sim, name: &str, a: &J) -> Option<(bool, String, i64)> {
    let o = match name {
        "move_to" => s.do_move(arg_cell(a)?),
        "mine" => s.do_mine(arg_cell(a)?),
        "tunnel" => s.do_tunnel(a.get("dir").s(), a.get("dy").i() as i32),
        "place" => { let item = a.get("item").s().trim_start_matches("minecraft:"); s.do_place(arg_cell(a)?, if a.get("block").is_null() { item } else { a.get("block").s().trim_start_matches("minecraft:") }) }
        "craft" | "smelt" => {
            let n = a.get("count").i().max(1);
            let (mut ticks, mut last) = (0, None);
            for _ in 0..n { let o = if name == "craft" { s.do_craft(a.get("item").s(), arg_cell(a)) } else { s.do_smelt(a.get("item").s(), arg_cell(a)?) }; ticks += o.ticks; let stop = !o.ok; last = Some(o); if stop { break; } }
            let mut o = last?; o.ticks = ticks; o
        }
        "eat" => { let it = if a.get("item").is_null() { s.held().into_iter().map(|h| h.0).find(|n| s.d.foods.contains_key(n)).unwrap_or_default() } else { a.get("item").s().to_string() }; s.do_eat(&it) }
        "equip" => { let it = a.get("item").s().trim_start_matches("minecraft:"); return Some(if s.count(it) > 0 { (true, "ok".into(), 1) } else { (false, "missing_item".into(), 0) }); }
        _ => return None,
    };
    Some((o.ok, o.reason.to_string(), o.ticks))
}

/// Replay one trace: rows in command order, plus the block names the tables do not know and items that could not be loaded.
pub fn replay(t: &Trace, d: Rc<Data>, near: i32) -> (Vec<Row>, BTreeMap<String, u32>, BTreeMap<String, u32>) {
    let w = world(t, &d);
    let mut s = Sim::new(d.clone(), w.tile.clone(), 1);
    let mut skipped = BTreeMap::new();
    let mut ev = 0usize;
    let mut rows = vec![];
    let name_of = |s: &Sim, c: [i32; 3]| s.name(c[0], c[1], c[2]).to_string();
    for c in &t.cmds {
        // the world up to the command's start: every recorded block update before it (the bot's own earlier ones and everyone else's)
        while ev < w.events.len() && w.events[ev].0 < c.t0 { let (_, p, b) = w.events[ev]; s.set(p[0], p[1], p[2], b); ev += 1; }
        // the real outcome: block updates inside the command's window near the bot (another bot's changes farther away are not this command's)
        let (cb, ca) = (c.before.cell(), c.after.cell());
        let target = arg_cell(&c.args);
        let mut real_blocks: BTreeMap<[i32; 3], String> = BTreeMap::new();
        let mut first_name: HashMap<[i32; 3], String> = HashMap::new();
        let mut k = ev;
        while k < w.events.len() && w.events[k].0 <= c.t1 {
            let (_, p, b) = w.events[k];
            let close = dist2(p, cb) <= near * near || dist2(p, ca) <= near * near || target.map_or(false, |q| dist2(p, q) <= near * near);
            if close { first_name.entry(p).or_insert_with(|| name_of(&s, p)); real_blocks.insert(p, d.block(b).name.clone()); }
            k += 1;
        }
        real_blocks.retain(|p, n| first_name.get(p).map_or(true, |f| f != n));
        let real = Outcome { ok: c.ok, reason: if c.ok { "ok".into() } else { c.reason.clone() }, ticks: c.ticks, cell: ca, blocks: real_blocks, inv: delta(&c.before.counts(), &c.after.counts()), food: c.after.food };
        // the simulator from the same state; its changes are undone afterwards (the next command starts from the recorded world again)
        load_state(&mut s, &c.before, &mut skipped);
        s.journal = Some(vec![]);
        let inv0 = { let mut m = BTreeMap::new(); for (n, q) in s.held() { m.insert(n, q as i64); } m };
        let out = if c.layer == "execute" { sim_command(&mut s, &c.name, &c.args) } else { None };
        let journal = s.journal.take().unwrap_or_default();
        let mut sim_blocks: BTreeMap<[i32; 3], String> = BTreeMap::new();
        let mut olds: HashMap<[i32; 3], u16> = HashMap::new();
        for ((x, y, z), old) in &journal { olds.entry([*x, *y, *z]).or_insert(*old); }
        for (p, old) in &olds { let now = s.blk(p[0], p[1], p[2]).unwrap_or(d.air); if now != *old { sim_blocks.insert(*p, d.block(now).name.clone()); } }
        let inv1 = { let mut m = BTreeMap::new(); for (n, q) in s.held() { m.insert(n, q as i64); } m };
        let supported = out.is_some();
        let (sok, sreason, sticks) = out.unwrap_or((false, "unsupported".into(), 0));
        let sim = Outcome { ok: sok, reason: sreason, ticks: Some(sticks), cell: s.pos, blocks: sim_blocks, inv: delta(&inv0, &inv1), food: s.food };
        // undo the simulator's changes: back to the recorded blocks (edits made by recorded events stay as they were before the command)
        for (p, old) in &olds { s.set(p[0], p[1], p[2], *old); }
        let agree = Agree {
            outcome: real.ok == sim.ok && real.reason == sim.reason,
            cell: real.cell == sim.cell,
            blocks: real.blocks == sim.blocks,
            inv: real.inv == sim.inv,
            ticks: match real.ticks { Some(rt) => (rt - sticks).abs() <= TICK_ABS.max((TICK_REL * rt as f64).round() as i64), None => false },
            food: (real.food - sim.food).abs() < 1.0,
        };
        let cats = if supported { categorize(&c.name, &real, &sim, &agree) } else { vec![] };
        rows.push(Row { bot: t.bot.clone(), id: c.id, name: c.name.clone(), supported, real, sim, agree, cats });
    }
    s.journal = None;
    (rows, w.unknown, skipped)
}

/// The categories of one diverging command (empty when everything agrees). Rules in docs/proposed/SIM-PARITY-v1.md section 4.
pub fn categorize(name: &str, r: &Outcome, s: &Outcome, a: &Agree) -> Vec<&'static str> {
    let mut c: Vec<&'static str> = vec![];
    let aim = |x: &str| matches!(x, "unreachable" | "not_visible");
    if !a.outcome {
        c.push(match name {
            "move_to" => if r.reason == "stuck" || s.reason == "stuck" { "collision" } else { "movement_reach" },
            "mine" | "tunnel" => if aim(&r.reason) || aim(&s.reason) { "movement_reach" } else { "dig_rules" },
            "place" => if aim(&r.reason) || aim(&s.reason) { "movement_reach" } else { "placement_rules" },
            "craft" | "smelt" => "recipes",
            "eat" => "hunger",
            _ => "inventory_other",
        });
    }
    if a.outcome && !a.cell { c.push(if name == "move_to" { "collision" } else { "movement_reach" }); }
    if !a.blocks {
        let names: Vec<&String> = r.blocks.values().chain(s.blocks.values()).collect();
        c.push(if names.iter().any(|n| FLUID.contains(&n.as_str())) { "fluids" }
            else if names.iter().any(|n| gravity(n)) { "gravity_blocks" }
            else { match name { "place" => "placement_rules", "mine" | "tunnel" => "dig_rules", _ => "blocks_other" } });
    }
    if !a.inv { c.push(match name { "mine" | "tunnel" => "drops", "place" => "placement_rules", "craft" | "smelt" => "recipes", "eat" => "hunger", _ => "inventory_other" }); }
    if a.outcome && r.ok && !a.ticks { c.push(match name { "move_to" => "walk_time", "mine" | "tunnel" => "dig_time", "place" => "place_time", _ => "other_time" }); }
    if !a.food { c.push("hunger"); }
    c.sort(); c.dedup();
    c
}

/// Per command name: n, modelled, outcome+reason agree, everything agrees, ticks agree (of the commands whose outcome agrees and succeeded).
pub fn summary(rows: &[Row]) -> J {
    let mut by: BTreeMap<String, [u64; 6]> = BTreeMap::new();
    let mut cats: BTreeMap<&str, u64> = CATEGORIES.iter().map(|c| (*c, 0)).collect();
    for r in rows {
        let e = by.entry(r.name.clone()).or_insert([0; 6]);
        e[0] += 1;
        if !r.supported { continue; }
        e[1] += 1;
        if r.agree.outcome { e[2] += 1; }
        if r.agree.all() { e[3] += 1; }
        if r.agree.outcome && r.real.ok { e[4] += 1; if r.agree.ticks { e[5] += 1; } }
        for c in &r.cats { *cats.entry(c).or_insert(0) += 1; }
    }
    let mut tot = [0u64; 6];
    for v in by.values() { for i in 0..6 { tot[i] += v[i]; } }
    let row = |v: &[u64; 6]| J::o(vec![("n", J::n(v[0] as f64)), ("modelled", J::n(v[1] as f64)), ("outcome", J::n(v[2] as f64)), ("all", J::n(v[3] as f64)), ("ok_both", J::n(v[4] as f64)), ("ticks", J::n(v[5] as f64))]);
    J::o(vec![("commands", J::Obj(by.iter().map(|(k, v)| (k.clone(), row(v))).collect())), ("total", row(&tot)),
        ("categories", J::Obj(cats.iter().map(|(k, v)| (k.to_string(), J::n(*v as f64))).collect()))])
}

fn pct(a: u64, b: u64) -> String { if b == 0 { "-".into() } else { format!("{:.1} %", 100.0 * a as f64 / b as f64) } }
pub fn table(sum: &J) -> String {
    let mut o = format!("modelled: {}; outcome = same ok and reason; all = outcome, cell, blocks and inventory; ticks = within {} % or {} ticks (both ok)\n", MODELLED.join(" "), (TICK_REL * 100.0) as i64, TICK_ABS);
    o += &format!("{:<12} {:>6} {:>9} {:>9} {:>9} {:>9}\n", "command", "n", "modelled", "outcome", "all", "ticks");
    let line = |k: &str, v: &J| format!("{:<12} {:>6} {:>9} {:>9} {:>9} {:>9}\n", k, v.get("n").i(), v.get("modelled").i(),
        pct(v.get("outcome").i() as u64, v.get("modelled").i() as u64), pct(v.get("all").i() as u64, v.get("modelled").i() as u64), pct(v.get("ticks").i() as u64, v.get("ok_both").i() as u64));
    for (k, v) in sum.get("commands").obj() { o += &line(k, v); }
    o += &line("total", sum.get("total"));
    o += "divergences by category:";
    for (k, v) in sum.get("categories").obj() { if v.i() > 0 { o += &format!(" {} {}", k, v.i()); } }
    o.push('\n');
    o
}

fn row_json(r: &Row) -> J {
    let out = |o: &Outcome| J::o(vec![("ok", J::Bool(o.ok)), ("reason", J::st(&o.reason)), ("ticks", o.ticks.map_or(J::Null, |t| J::n(t as f64))), ("cell", J::nums(&o.cell)),
        ("blocks", J::Obj(o.blocks.iter().map(|(p, n)| (format!("{},{},{}", p[0], p[1], p[2]), J::st(n))).collect())), ("inv", J::Obj(o.inv.iter().map(|(n, c)| (n.clone(), J::n(*c as f64))).collect())), ("food", J::n(o.food))]);
    J::o(vec![("bot", J::st(&r.bot)), ("id", J::n(r.id as f64)), ("name", J::st(&r.name)), ("supported", J::Bool(r.supported)), ("real", out(&r.real)), ("sim", out(&r.sim)),
        ("agree", J::o(vec![("outcome", J::Bool(r.agree.outcome)), ("cell", J::Bool(r.agree.cell)), ("blocks", J::Bool(r.agree.blocks)), ("inv", J::Bool(r.agree.inv)), ("ticks", J::Bool(r.agree.ticks)), ("food", J::Bool(r.agree.food))])),
        ("cats", J::Arr(r.cats.iter().map(|c| J::st(c)).collect()))])
}

/// Where the tables of `version` are: the crate's data/ as built, next to the binary (target/<dir>/release -> ../../../data), or under the
/// working directory (tools/sim/data or data). The first that exists; the crate path otherwise (the caller then falls back to 1.20.1).
fn data_path(version: &str) -> String {
    let f = format!("data-{}.json", version);
    let mut c = vec![format!("{}/data/{}", env!("CARGO_MANIFEST_DIR"), f)];
    if let Ok(exe) = std::env::current_exe() { if let Some(d) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).and_then(|p| p.parent()) { c.push(format!("{}/data/{}", d.display(), f)); } }
    c.push(format!("tools/sim/data/{}", f)); c.push(format!("data/{}", f));
    c.iter().find(|p| std::path::Path::new(p).exists()).cloned().unwrap_or_else(|| c[0].clone())
}

pub fn run(args: &[String]) -> Result<(), String> {
    let (mut files, mut data, mut rows_out, mut json_out, mut near) = (vec![], None, None, None, 6);
    let mut i = 0;
    while i < args.len() {
        let v = || args.get(i + 1).cloned().ok_or(format!("{} needs a value", args[i]));
        match args[i].as_str() { "--data" => { data = Some(v()?); i += 1; } "--rows" => { rows_out = Some(v()?); i += 1; } "--json" => { json_out = Some(v()?); i += 1; }
            "--near" => { near = v()?.parse().map_err(|_| "--near: a number")?; i += 1; } f => files.push(f.to_string()) }
        i += 1;
    }
    if files.is_empty() { return Err("usage: forgeaip-sim replay TRACE.jsonl... [--data data-VERSION.json] [--rows rows.jsonl] [--json summary.json] [--near 6]".into()); }
    let mut all = vec![];
    let mut cache: HashMap<String, Rc<Data>> = HashMap::new();
    for f in &files {
        let t = Trace::parse(&std::fs::read_to_string(f).map_err(|e| format!("{}: {}", f, e))?).map_err(|e| format!("{}: {}", f, e))?;
        // the tables of the trace's version: --data, else data/data-<version>.json next to the crate, else the built-in 1.20.1 set
        let path = data.clone().unwrap_or_else(|| data_path(&t.version));
        let d = match cache.get(&path) { Some(d) => d.clone(), None => { let d = Rc::new(if std::path::Path::new(&path).exists() { Data::from_file(&path)? } else { eprintln!("replay: no {}, using the built-in 1.20.1 tables", path); Data::load() }); cache.insert(path.clone(), d.clone()); d } };
        let (rows, unknown, skipped) = replay(&t, d, near);
        if !unknown.is_empty() { eprintln!("{}: block names the tables do not know (treated as solid, undiggable): {:?}", f, unknown); }
        if !skipped.is_empty() { eprintln!("{}: items the tables do not know (left out of the pack): {:?}", f, skipped); }
        all.extend(rows);
    }
    let sum = summary(&all);
    print!("{}", table(&sum));
    if let Some(p) = rows_out { let mut s = String::new(); for r in &all { s += &row_json(r).dump(); s.push('\n'); } std::fs::write(&p, s).map_err(|e| format!("{}: {}", p, e))?; }
    if let Some(p) = json_out { std::fs::write(&p, sum.dump()).map_err(|e| format!("{}: {}", p, e))?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Speed of the modelled commands on a natural tile (the testing-backend estimate in docs/proposed/SIM-PARITY-v1.md section 6):
    ///   SIM_BENCH_TILE=/tiles/vps-s0-28.tile cargo test --release bench_commands -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_commands() {
        let path = std::env::var("SIM_BENCH_TILE").expect("SIM_BENCH_TILE=path of a .tile");
        let tile = Rc::new(Tile::load(&path).unwrap());
        let d = Rc::new(Data::load());
        let mut s = Sim::new(d.clone(), tile.clone(), 3);
        s.site = tile.site; s.pos = crate::run::find_start(&s).expect("a start on the tile"); s.hostile_scale = 0.0;
        for (n, c) in [("diamond_pickaxe", 1), ("dirt", 64), ("cobblestone", 64)] { s.give(n, c); }
        let mut rng = crate::sim::Rng(11);
        let (mut n, mut ok, mut by) = (0u64, 0u64, BTreeMap::<&str, (u64, f64, u64)>::new());
        let t0 = std::time::Instant::now();
        while t0.elapsed().as_secs_f64() < 5.0 {
            // timed from a fresh walking graph: a replayed command always starts from a new state
            let t = std::time::Instant::now();
            s.invalidate();
            let nodes: Vec<[i32; 3]> = s.reach().nodes.clone();
            let p = s.pos;
            let pick = |r: &mut crate::sim::Rng| nodes[r.below(nodes.len() as u64) as usize];
            let k = rng.below(3);
            let (name, o) = match k {
                0 => ("move_to", s.do_move(pick(&mut rng))),
                1 => { let c = pick(&mut rng); ("mine", s.do_mine([c[0], c[1] - 1, c[2]])) }
                _ => { let c = pick(&mut rng); ("place", s.do_place([c[0], c[1], c[2]], "dirt")) }
            };
            let e = by.entry(name).or_insert((0, 0.0, 0)); e.0 += 1; e.1 += t.elapsed().as_secs_f64(); if o.ok { e.2 += 1; }
            n += 1; if o.ok { ok += 1; }
            if s.dead { s.respawn(); s.pos = p; }
            if k == 0 && o.ok && rng.below(20) == 0 { s.pos = crate::run::find_start(&s).unwrap_or(p); }      // now and then back to the start: stay in the tile
            s.give("dirt", 1); s.hp = 20.0; s.food = 20.0;
        }
        let secs = t0.elapsed().as_secs_f64();
        eprintln!("{} commands in {:.1} s = {:.0} commands/s ({} ok) on {}", n, secs, n as f64 / secs, ok, path);
        for (k, (c, t, o)) in &by { eprintln!("  {:<8} {:>7} x {:>8.1} us, {:.0} % ok", k, c, 1e6 * t / *c as f64, 100.0 * *o as f64 / *c as f64); }
    }
    fn fixture() -> (Trace, Rc<Data>) {
        let t = Trace::parse(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/trace_flat.jsonl")).unwrap()).unwrap();
        let d = Rc::new(Data::from_file(concat!(env!("CARGO_MANIFEST_DIR"), "/data/data-1.21.1.json")).unwrap());
        (t, d)
    }
    #[test]
    fn base64_decodes_what_node_encodes() {
        assert_eq!(b64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64("AAEC/w==").unwrap(), vec![0, 1, 2, 255]);
    }
    /// The recorder's own output (tests/test_sim_recorder.js writes tests/trace_flat.jsonl from a fake bot on a flat 1.21.1 world) parses into
    /// the world it recorded: grass at y 64, stone below, air above, and the block updates in time order.
    #[test]
    fn a_recorded_trace_rebuilds_the_world_it_was_recorded_on() {
        let (t, d) = fixture();
        assert_eq!(t.version, "1.21.1");
        let w = world(&t, &d);
        assert!(w.unknown.is_empty(), "{:?}", w.unknown);
        let s = Sim::new(d.clone(), w.tile.clone(), 1);
        assert_eq!(s.name(8, 64, 8), "grass_block");
        assert_eq!(s.name(8, 40, 8), "stone");
        assert_eq!(s.name(8, 70, 8), "air");
        assert!(w.events.windows(2).all(|p| p[0].0 <= p[1].0));
    }
    /// The fixture's commands: a mine and a place the simulator reproduces, a place into short grass it refuses (its REPLACEABLE list still
    /// says `grass`, the 1.20.1 name: a real divergence of category placement_rules), and an `activate` it does not model.
    #[test]
    fn replay_finds_the_agreements_and_names_the_divergence() {
        let (t, d) = fixture();
        let (rows, _, skipped) = replay(&t, d, 6);
        assert!(skipped.is_empty(), "{:?}", skipped);
        let by: HashMap<u64, &Row> = rows.iter().map(|r| (r.id, r)).collect();
        let mine = by[&1];
        assert!(mine.agree.outcome && mine.agree.blocks && mine.agree.inv && mine.agree.cell, "mine: real {:?} sim {:?}", mine.real, mine.sim);
        let place = by[&2];
        assert!(place.agree.all(), "place: real {:?} sim {:?}", place.real, place.sim);
        let grass = by[&3];
        assert!(!grass.agree.outcome);
        assert_eq!(grass.sim.reason, "invalid_target");
        assert!(grass.cats.contains(&"placement_rules"), "{:?}", grass.cats);
        assert!(!by[&4].supported);
        let sum = summary(&rows);
        assert_eq!(sum.get("total").get("n").i(), 4);
        assert_eq!(sum.get("total").get("modelled").i(), 3);
        assert_eq!(sum.get("total").get("outcome").i(), 2);
    }
    /// Teacher forcing: the simulator's changes are undone after each command; the next command sees the recorded blocks.
    #[test]
    fn each_command_starts_from_the_recorded_world_not_from_the_simulators() {
        let (t, d) = fixture();
        let (rows, _, _) = replay(&t, d, 6);
        // command 3 failed in the simulator, so it changed nothing; command 1 dug (10,64,8) in both, command 2 refilled it with dirt in both
        assert!(rows[2].sim.blocks.is_empty());
        assert_eq!(rows[0].real.blocks.get(&[10, 64, 8]).map(|s| s.as_str()), Some("air"));
        assert_eq!(rows[1].real.blocks.get(&[10, 64, 8]).map(|s| s.as_str()), Some("dirt"));
    }
}

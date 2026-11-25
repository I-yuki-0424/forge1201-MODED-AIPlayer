//! `replay`: the parity check of the simulator against the real server (TASK-20261125-078, docs/implemented/SIM-PARITY-v1.md).
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
pub const MODELLED: [&str; 11] = ["move_to", "mine", "tunnel", "place", "craft", "smelt", "eat", "equip", "move:pillar", "move:descend", "move:bridge"];
/// Divergence categories (the task's list plus the ones the comparison needs); `unsupported` and `data` are reported apart.
pub const CATEGORIES: [&str; 18] = ["movement_reach", "collision", "walk_time", "dig_time", "dig_rules", "placement_rules", "place_time", "fluids", "drops",
    "gravity_blocks", "hunger", "light", "recipes", "inventory_other", "blocks_other", "other_time", "world_clock", "random_drops"];

/// A change no command makes but the server's clocks do (random and scheduled ticks): leaves without a log nearby decay, grass and mycelium under
/// an opaque block turn to dirt, dirt next to grass turns to grass, farmland dries, snow and ice melt, fire burns out.
pub fn world_clock(from: &str, to: &str) -> bool {
    (from.ends_with("_leaves") && to == "air") || (from == "air" && crate::sim::gravity_block(to)) || (matches!(from, "grass_block" | "mycelium" | "podzol") && to == "dirt") || (from == "dirt" && matches!(to, "grass_block" | "mycelium"))
        || (from == "farmland" && to == "dirt") || (matches!(from, "snow" | "ice") && matches!(to, "air" | "water")) || (from == "fire" && to == "air")
}
/// Items a broken block drops only by chance (loot tables with a random chance), so one command's drop cannot be expected to match.
pub fn random_drop(block: &str, item: &str) -> bool {
    (block.ends_with("_leaves") && (item.ends_with("_sapling") || matches!(item, "stick" | "apple" | "mangrove_propagule"))) || (block == "gravel" && item == "flint")
        || (matches!(block, "short_grass" | "grass" | "tall_grass" | "fern" | "large_fern") && item == "wheat_seeds") || (block == "dead_bush" && item == "stick") || (block == "cocoa" && item == "cocoa_beans")
}
/// Ticks agree when within this share of the real count, or within TICK_ABS ticks for short commands.
pub const TICK_REL: f64 = 0.10;
pub const TICK_ABS: i64 = 2;

#[derive(Clone, Debug, Default)]
pub struct State { pub pos: [f64; 3], pub ground: bool, pub slot: i64, pub hp: f64, pub food: f64, pub sat: f64, pub air: f64, pub inv: Vec<(u32, String, u32)>, pub eff: HashMap<String, i32> }
impl State {
    fn parse(j: &J) -> State {
        let p = j.get("pos");
        let mut eff = HashMap::new();
        for r in j.get("inv").arr() { for e in r.at(4).arr() { if e.at(0).s() == "efficiency" { eff.insert(r.at(1).s().to_string(), e.at(1).i() as i32); } } }
        State { pos: [p.at(0).f(), p.at(1).f(), p.at(2).f()], slot: j.get("slot").i(), ground: j.get("ground").is_null() || j.get("ground").b(), hp: j.get("hp").f(), food: j.get("food").f(), sat: j.get("sat").f(), air: j.get("air").f(),
            inv: j.get("inv").arr().iter().map(|r| (r.at(0).i() as u32, r.at(1).s().to_string(), r.at(2).i() as u32)).collect(), eff }
    }
    /// The cell the feet are in (a hair above, so 63.99999 from float noise counts as 64).
    pub fn cell(&self) -> [i32; 3] { [self.pos[0].floor() as i32, (self.pos[1] + 1e-3).floor() as i32, self.pos[2].floor() as i32] }
    /// Item counts in the 36 main slots (mineflayer slots 9-44), which is all the simulator holds.
    fn counts(&self) -> BTreeMap<String, i64> { let mut m = BTreeMap::new(); for (s, n, c) in &self.inv { if (9..=44).contains(s) { *m.entry(n.clone()).or_insert(0) += *c as i64; } } m }
}
pub struct Cmd { pub id: u64, pub refid: Option<u64>, pub atomic: bool, pub env: (usize, i32, bool), pub avoid: Vec<[i32; 3]>, pub floor_by: bool, pub layer: String, pub name: String, pub args: J, pub t0: f64, pub t1: f64, pub before: State, pub after: State, pub ok: bool, pub reason: String, pub ticks: Option<i64> }
/// One bot's trace.
pub struct Trace {
    pub bot: String, pub version: String,
    /// The test world's temporary block (hello `temp`; traces before it was recorded came from 1.21.1 test worlds: pumpkin).
    pub temp: String,
    /// Recorded on a test world of the harness (hello `world`): the server has the auto-pickup mod.
    pub test_world: bool,
    pub states: HashMap<u32, String>,
    /// Vine faces per state id (from the `st` lines' properties).
    pub vine_bits: HashMap<u32, u8>,
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
        let mut t = Trace { bot: String::new(), version: String::new(), temp: "pumpkin".into(), test_world: false, states: HashMap::new(), vine_bits: HashMap::new(), chunks: vec![], blks: vec![], cmds: vec![] };
        let mut open: HashMap<u64, Cmd> = HashMap::new();
        for (ln, line) in text.lines().enumerate() {
            if line.trim().is_empty() { continue; }
            let j = json::parse(line).map_err(|e| format!("line {}: {}", ln + 1, e))?;
            match j.get("t").s() {
                "hello" => { if j.get("format").i() != 1 { return Err(format!("line {}: trace format {} (this replayer reads 1)", ln + 1, j.get("format").i())); }
                    t.bot = j.get("bot").s().to_string(); t.version = j.get("version").s().to_string();
                    t.test_world = !j.get("world").is_null();
                    if !j.get("temp").is_null() { t.temp = j.get("temp").s().trim_start_matches("minecraft:").to_string(); } }
                "st" => {
                    let id = j.get("id").i() as u32;
                    if j.get("n").s() == "vine" {
                        let on = |k: &str| { let v = j.get("p").get(k); v.b() || v.s() == "true" };
                        let mut b = 0u8;
                        for (k, bit) in [("north", crate::sim::VINE_N), ("south", crate::sim::VINE_S), ("west", crate::sim::VINE_W), ("east", crate::sim::VINE_E), ("up", crate::sim::VINE_UP)] { if on(k) { b |= bit; } }
                        t.vine_bits.insert(id, b);
                    }
                    t.states.insert(id, j.get("n").s().to_string());
                }
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
                    open.insert(id, Cmd { id, refid: if j.get("ref").is_null() { None } else { Some(j.get("ref").i() as u64) }, atomic: j.get("atomic").b(),
                        // the planner settings; a trace without them (format 1 before 2026-11-26) came from the T26 harness, whose bots are all work-service bots: 6,000 nodes, vines as air
                        env: { let e = j.get("env"); if e.is_null() { (6000, 3, true) } else { (e.get("planNodes").i().max(1) as usize, if e.get("maxDrop").i() > 0 { e.get("maxDrop").i() as i32 } else { 3 }, e.get("noVines").b()) } },
                        floor_by: !j.get("env").get("floorBy").is_null(),
                        avoid: j.get("env").get("avoid").arr().iter().map(|c| [c.at(0).i() as i32, c.at(1).i() as i32, c.at(2).i() as i32]).collect(),
                        layer: j.get("layer").s().to_string(), name: j.get("name").s().to_string(), args: j.get("args").clone(), t0: j.get("ms").f(), t1: f64::NAN,
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
pub struct World { pub tile: Rc<Tile>, pub events: Vec<(f64, [i32; 3], u16, u8)>, pub unknown: BTreeMap<String, u32>, pub vine: HashMap<[i32; 3], u8> }
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
    let mut events: Vec<(f64, [i32; 3], u16, u8)> = vec![];
    let mut vine: HashMap<[i32; 3], u8> = HashMap::new();
    let mut cur: HashMap<(i32, i32), Vec<u16>> = HashMap::new();           // the current copy of each chunk, in sim ids (for re-snapshots)
    for (i, (ms, cx, cz, min_y, height, cells)) in t.chunks.iter().enumerate() {
        let ids: Vec<u16> = cells.iter().map(|&s| sim_id(s as u32, &mut unknown)).collect();
        if first[&(*cx, *cz)] == i {
            for (k, &st) in cells.iter().enumerate() { if let Some(&b) = t.vine_bits.get(&(st as u32)) { vine.insert([cx * 16 + k as i32 % 16, k as i32 / 256 + min_y, cz * 16 + (k as i32 / 16) % 16], b); } }
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
            for (k, (&a, &b)) in old.iter().zip(ids.iter()).enumerate() { if a != b { let (y, z, x) = (k as i32 / 256 + min_y, (k as i32 / 16) % 16, k as i32 % 16); events.push((*ms, [cx * 16 + x, y, cz * 16 + z], b, t.vine_bits.get(&(cells[k] as u32)).copied().unwrap_or(0))); } }
        }
        cur.insert((*cx, *cz), ids);
    }
    for (ms, p, s) in &t.blks { events.push((*ms, *p, sim_id(*s, &mut unknown), t.vine_bits.get(s).copied().unwrap_or(0))); }
    events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    World { tile: Rc::new(Tile { name: t.bot.clone(), site: [0; 3], cx0: x0.min(x1), cz0: z0.min(z1), w, h, chunks }), events, unknown, vine }
}

/// One compared command.
pub struct Row { pub bot: String, pub id: u64, pub name: String, pub supported: bool, pub real: Outcome, pub sim: Outcome, pub agree: Agree, pub cats: Vec<&'static str> }
#[derive(Clone, Debug, Default)]
pub struct Outcome { pub ok: bool, pub reason: String, pub ticks: Option<i64>, pub cell: [i32; 3], pub blocks: BTreeMap<[i32; 3], String>, pub inv: BTreeMap<String, i64>, pub food: f64,
    /// Block changes in the window that are the world's own clock, not the command (leaf decay, grass under a block turning to dirt, ...): kept
    /// apart from `blocks` and compared as their own category (`world_clock`).
    pub clock: BTreeMap<[i32; 3], String>,
    /// Items gained that are a random drop of a block the command broke (saplings, sticks, apples from leaves; flint from gravel ...).
    pub random: BTreeMap<String, i64>,
    /// What each changed cell held before (blocks and clock), for the report.
    pub from: BTreeMap<[i32; 3], String> }
#[derive(Clone, Copy, Debug, Default)]
pub struct Agree { pub outcome: bool, pub cell: bool, pub blocks: bool, pub inv: bool, pub ticks: bool, pub food: bool, pub clock: bool, pub random: bool }
impl Agree { pub fn all(&self) -> bool { self.outcome && self.cell && self.blocks && self.inv } }

/// Every cell a command names (x/y/z, a bridge's cells at its y): block changes near any of them belong to the command.
fn arg_cells(a: &J) -> Vec<[i32; 3]> {
    let mut v: Vec<[i32; 3]> = arg_cell(a).into_iter().collect();
    for c in a.get("cells").arr() { v.push([c.get("x").i() as i32, a.get("y").i() as i32, c.get("z").i() as i32]); }
    v
}
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
    s.pos = st.cell(); s.track = s.pos; s.exact = Some(st.pos); s.ground = st.ground; s.hp = st.hp; s.food = st.food; s.sat = st.sat; s.exh = 0.0; s.air = if st.air > 0.0 { st.air * 15.0 } else { 300.0 };
    s.dead = false; s.mobs.clear(); s.hostile_scale = 0.0; s.fuel = 0.0; s.tick = 6000; s.dmg.clear(); s.ph.clear(); s.invalidate();
    s.inv = vec![None; 36]; s.eff.clear();
    s.hand = st.inv.iter().find(|r| r.0 as i64 == 36 + st.slot).map(|r| r.1.clone());
    for (slot, name, n) in &st.inv {
        if !(9..=44).contains(slot) { continue; }
        let id = s.d.item(name);
        if id == 0 { *skipped.entry(name.clone()).or_insert(0) += 1; continue; }
        s.inv[(*slot - 9) as usize] = Some(Stack { item: id, n: *n });
        if let Some(l) = st.eff.get(name) { s.eff.insert(name.clone(), *l); }
    }
}

/// Run one command in the simulator. None = not modelled.
fn sim_command(s: &mut Sim, name: &str, a: &J, temp: &str) -> Option<(bool, String, i64)> {
    let o = match name {
        "move:pillar" => s.do_pillar(a.get("levels").i().max(1), temp),
        "move:descend" => s.do_descend(a.get("levels").i().max(1), temp),
        "move:bridge" | "run:bridge" => {
            let cells: Vec<[i32; 2]> = a.get("cells").arr().iter().map(|c| [c.get("x").i() as i32, c.get("z").i() as i32]).collect();
            s.do_bridge(a.get("y").i() as i32, &cells, a.get("keep").b() || a.get("road").b() || a.get("build").b(), temp)
        }
        "move_to" => s.do_move(arg_cell(a)?),
        "mine" => s.do_mine_opts(arg_cell(a)?, a.get("collect").is_null() || a.get("collect").b(), a.get("blind").b()),
        "tunnel" => s.do_tunnel(a.get("dir").s(), a.get("dy").i() as i32),
        "place" => {
            let item = a.get("item").s().trim_start_matches("minecraft:");
            let block = if a.get("block").is_null() { item } else { a.get("block").s().trim_start_matches("minecraft:") };
            let r = a.get("recipe");
            let sup = if r.is_null() { None } else { match r.get("support").s() { "north" => Some([0, 0, -1]), "south" => Some([0, 0, 1]), "west" => Some([-1, 0, 0]), "east" => Some([1, 0, 0]), "up" => Some([0, 1, 0]), "down" => Some([0, -1, 0]), _ => None } };
            if s.atomic && s.place_unmet(arg_cell(a)?, item, sup) { return Some((false, "precondition_failed".into(), 0)); }
            if r.is_null() { s.do_place(arg_cell(a)?, block) }
            else {
                let dir = match r.get("support").s() { "north" => [0, 0, -1], "south" => [0, 0, 1], "west" => [-1, 0, 0], "east" => [1, 0, 0], "up" => [0, 1, 0], "down" => [0, -1, 0], _ => return Some((false, "invalid_args".into(), 0)) };
                s.do_place_recipe(arg_cell(a)?, item, block, dir)
            }
        }
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

/// What another bot of the same run was doing: its command windows and the cells each one is about (start, end, the cells it names). A block
/// change inside one bot's window that is nearer to another bot's concurrent command than to its own is the other bot's (four bots building
/// bridges from one platform: place_a pa-r1).
#[derive(Clone)]
pub struct Win { pub t0: f64, pub t1: f64, pub cells: Vec<[i32; 3]> }
pub fn windows(t: &Trace) -> Vec<Win> {
    t.cmds.iter().map(|c| { let mut cells = arg_cells(&c.args); cells.push(c.before.cell()); cells.push(c.after.cell()); Win { t0: c.t0, t1: c.t1, cells } }).collect()
}
fn nearest(p: [i32; 3], cells: &[[i32; 3]]) -> i32 { cells.iter().map(|q| dist2(p, *q)).min().unwrap_or(i32::MAX) }

/// A recorded world followed through time: the tile, the block updates in order, and a Sim holding the world at the cursor.
pub struct Cursor { pub w: World, pub s: Sim, pub ev: usize }
impl Cursor {
    pub fn new(t: &Trace, d: Rc<Data>) -> Cursor { let w = world(t, &d); let mut s = Sim::new(d, w.tile.clone(), 1); s.vine = w.vine.clone(); s.astar = true; s.autopickup = t.test_world; Cursor { w, s, ev: 0 } }
    /// Apply every recorded block update before `t0`.
    pub fn advance(&mut self, t0: f64) {
        while self.ev < self.w.events.len() && self.w.events[self.ev].0 < t0 {
            let (_, p, b, v) = self.w.events[self.ev];
            self.s.set(p[0], p[1], p[2], b);
            if v != 0 { self.s.vine.insert(p, v); } else { self.s.vine.remove(&p); }
            self.ev += 1;
        }
    }
    /// What the server did in command `c` (call after `advance(c.t0)`): the block updates inside its window near the bot's start, end or target
    /// (another bot's changes farther away are not this command's), cells that came back to their first state dropped.
    pub fn outcome(&self, c: &Cmd, near: i32, others: &[Win]) -> Outcome {
        let (cb, ca) = (c.before.cell(), c.after.cell());
        let target = arg_cell(&c.args);
        let named = arg_cells(&c.args);
        let mut own = named.clone(); own.push(cb); own.push(ca);
        let busy: Vec<&Win> = others.iter().filter(|w| w.t0 <= c.t1 && w.t1 >= c.t0).collect();
        let mut blocks: BTreeMap<[i32; 3], String> = BTreeMap::new();
        let mut first: HashMap<[i32; 3], String> = HashMap::new();
        let mut k = self.ev;
        while k < self.w.events.len() && self.w.events[k].0 <= c.t1 {
            let (_, p, b, _) = self.w.events[k];
            let mine = nearest(p, &own);
            if mine <= near * near && !busy.iter().any(|w| nearest(p, &w.cells) < mine) {
                first.entry(p).or_insert_with(|| self.s.name(p[0], p[1], p[2]).to_string());
                blocks.insert(p, self.s.d.block(b).name.clone());
            }
            k += 1;
        }
        blocks.retain(|p, n| first.get(p).map_or(true, |f| f != n));
        let clock: BTreeMap<[i32; 3], String> = blocks.iter().filter(|(p, n)| Some(**p) != target && first.get(*p).map_or(false, |f| world_clock(f, n))).map(|(p, n)| (*p, n.clone())).collect();
        blocks.retain(|p, _| !clock.contains_key(p));
        let mut inv = delta(&c.before.counts(), &c.after.counts());
        let broke: Vec<&String> = first.iter().filter(|(p, _)| blocks.get(*p).map_or(false, |n| n == "air")).map(|(_, f)| f).collect();
        let random: BTreeMap<String, i64> = inv.iter().filter(|(i, n)| **n > 0 && broke.iter().any(|b| random_drop(b, i))).map(|(i, n)| (i.clone(), *n)).collect();
        inv.retain(|i, _| !random.contains_key(i));
        let from = first.into_iter().filter(|(p, _)| blocks.contains_key(p) || clock.contains_key(p)).collect();
        Outcome { ok: c.ok, reason: if c.ok { "ok".into() } else { c.reason.clone() }, ticks: c.ticks, cell: ca, blocks, inv, food: c.after.food, clock, random, from }
    }
    /// The block names within `r` of `cells` (for "were the surroundings the same at the start").
    pub fn around(&self, cells: &[[i32; 3]], r: i32) -> BTreeMap<[i32; 3], String> {
        let mut m = BTreeMap::new();
        for c in cells { for x in -r..=r { for y in -r..=r { for z in -r..=r { let p = [c[0] + x, c[1] + y, c[2] + z]; m.entry(p).or_insert_with(|| self.s.name(p[0], p[1], p[2]).to_string()); } } } }
        m
    }
}

pub fn agree(a: &Outcome, b: &Outcome) -> Agree {
    Agree {
        outcome: a.ok == b.ok && a.reason == b.reason,
        cell: a.cell == b.cell,
        blocks: a.blocks == b.blocks,
        inv: a.inv == b.inv,
        ticks: match (a.ticks, b.ticks) { (Some(rt), Some(st)) => (rt - st).abs() <= TICK_ABS.max((TICK_REL * rt as f64).round() as i64), _ => false },
        food: (a.food - b.food).abs() < 1.0,
        clock: a.clock == b.clock,
        random: a.random == b.random,
    }
}

/// Replay one trace: rows in command order, plus the block names the tables do not know and items that could not be loaded.
pub fn replay(t: &Trace, d: Rc<Data>, near: i32, others: &[Win]) -> (Vec<Row>, BTreeMap<String, u32>, BTreeMap<String, u32>) {
    let mut cur = Cursor::new(t, d.clone());
    let mut skipped = BTreeMap::new();
    let mut rows = vec![];
    for c in &t.cmds {
        // the world up to the command's start: every recorded block update before it (the bot's own earlier ones and everyone else's)
        cur.advance(c.t0);
        // `cancelled` is the caller stopping the command (the job's own timing), not something the server answered: nothing to compare
        if c.reason == "cancelled" { rows.push(Row { bot: t.bot.clone(), id: c.id, name: c.name.clone(), supported: false, real: Outcome::default(), sim: Outcome { reason: "cancelled".into(), ..Default::default() }, agree: Agree::default(), cats: vec![] }); continue; }
        let real = cur.outcome(c, near, others);
        // the simulator from the same state; its changes are undone afterwards (the next command starts from the recorded world again)
        let s = &mut cur.s;
        load_state(s, &c.before, &mut skipped);
        s.journal = Some(vec![]);
        let vine0 = s.vine.clone();
        let inv0 = { let mut m = BTreeMap::new(); for (n, q) in s.held() { m.insert(n, q as i64); } m };
        s.avoid = c.avoid.iter().copied().collect(); s.floor_by_other = c.floor_by;
        s.atomic = c.atomic; s.plan_nodes = c.env.0; s.max_drop = c.env.1; s.no_vines = c.env.2;
        let out = if c.layer == "execute" || c.name.starts_with("move:") || c.name == "run:bridge" { sim_command(s, &c.name, &c.args, &t.temp) } else { None };
        s.atomic = false;
        let journal = s.journal.take().unwrap_or_default();
        let mut sim_blocks: BTreeMap<[i32; 3], String> = BTreeMap::new();
        let mut olds: HashMap<[i32; 3], u16> = HashMap::new();
        for ((x, y, z), old) in &journal { olds.entry([*x, *y, *z]).or_insert(*old); }
        let (cb, ca, named) = (c.before.cell(), c.after.cell(), arg_cells(&c.args));
        let seen = |p: &[i32; 3]| dist2(*p, cb) <= near * near || dist2(*p, ca) <= near * near || named.iter().any(|q| dist2(*p, *q) <= near * near);
        for (p, old) in &olds { let now = s.blk(p[0], p[1], p[2]).unwrap_or(d.air); if now != *old && seen(p) { sim_blocks.insert(*p, d.block(now).name.clone()); } }
        let inv1 = { let mut m = BTreeMap::new(); for (n, q) in s.held() { m.insert(n, q as i64); } m };
        let supported = out.is_some();
        let (sok, sreason, sticks) = out.unwrap_or((false, "unsupported".into(), 0));
        let mut sinv = delta(&inv0, &inv1);
        let sbroke: Vec<String> = olds.iter().filter(|(p, _)| sim_blocks.get(*p).map_or(false, |n| n == "air")).map(|(_, o)| d.block(*o).name.clone()).collect();
        let srandom: BTreeMap<String, i64> = sinv.iter().filter(|(i, n)| **n > 0 && sbroke.iter().any(|b| random_drop(b, i))).map(|(i, n)| (i.clone(), *n)).collect();
        sinv.retain(|i, _| !srandom.contains_key(i));
        let sfrom: BTreeMap<[i32; 3], String> = olds.iter().filter(|(p, _)| sim_blocks.contains_key(*p)).map(|(p, o)| (*p, d.block(*o).name.clone())).collect();
        let sim = Outcome { ok: sok, reason: sreason, ticks: Some(sticks), cell: s.pos, blocks: sim_blocks, inv: sinv, food: s.food, clock: BTreeMap::new(), random: srandom,
            from: sfrom };
        // undo the simulator's changes: back to the recorded blocks (edits made by recorded events stay as they were before the command)
        for (p, old) in &olds { s.set(p[0], p[1], p[2], *old); }
        s.vine = vine0; s.falling.clear();
        let ag = agree(&real, &sim);
        let cats = if supported { categorize(&c.name, &real, &sim, &ag) } else { vec![] };
        rows.push(Row { bot: t.bot.clone(), id: c.id, name: c.name.clone(), supported, real, sim, agree: ag, cats });
    }
    cur.s.journal = None;
    (rows, cur.w.unknown, skipped)
}

/// The real server against itself: run A (recorded) and run B (scripts/sim/play.js re-playing A on a new world of the same seed, its commands
/// carrying `ref` = A's id). Pairs whose surroundings (blocks within 3 of the bot and the target), cell or pack differed at the start are left
/// out (`diverged`): they measure the replay, not the server. Returns the rows (`real` = A, `sim` = B) and [paired, diverged, unplayed].
pub fn compare(a: &Trace, b: &Trace, d: Rc<Data>, near: i32, others_a: &[Win], others_b: &[Win]) -> (Vec<Row>, [u64; 3]) {
    let mut ca = Cursor::new(a, d.clone());
    let mut cb = Cursor::new(b, d);
    let by_ref: HashMap<u64, &Cmd> = b.cmds.iter().filter_map(|c| c.refid.map(|r| (r, c))).collect();
    let (mut rows, mut n) = (vec![], [0u64; 3]);
    for c in &a.cmds {
        let p = match by_ref.get(&c.id) { Some(p) => *p, None => { n[2] += 1; continue; } };
        ca.advance(c.t0); cb.advance(p.t0);
        let mut cells = vec![c.before.cell()];
        if let Some(t) = arg_cell(&c.args) { cells.push(t); }
        if ca.around(&cells, 3) != cb.around(&cells, 3) || c.before.cell() != p.before.cell() || c.before.counts() != p.before.counts() { n[1] += 1; continue; }
        n[0] += 1;
        let (ra, rb) = (ca.outcome(c, near, others_a), cb.outcome(p, near, others_b));
        let ag = agree(&ra, &rb);
        let cats = categorize(&c.name, &ra, &rb, &ag);
        rows.push(Row { bot: a.bot.clone(), id: c.id, name: c.name.clone(), supported: true, real: ra, sim: rb, agree: ag, cats });
    }
    (rows, n)
}

/// The categories of one diverging command (empty when everything agrees). Rules in docs/implemented/SIM-PARITY-v1.md section 4.
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
    if !a.clock { c.push("world_clock"); }
    if !a.random { c.push("random_drops"); }
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
        ("blocks", J::Obj(o.blocks.iter().map(|(p, n)| (format!("{},{},{}", p[0], p[1], p[2]), J::st(n))).collect())), ("inv", J::Obj(o.inv.iter().map(|(n, c)| (n.clone(), J::n(*c as f64))).collect())), ("food", J::n(o.food)),
        ("clock", J::Obj(o.clock.iter().map(|(p, n)| (format!("{},{},{}", p[0], p[1], p[2]), J::st(n))).collect())), ("random", J::Obj(o.random.iter().map(|(n, c)| (n.clone(), J::n(*c as f64))).collect())),
        ("from", J::Obj(o.from.iter().map(|(p, n)| (format!("{},{},{}", p[0], p[1], p[2]), J::st(n))).collect()))]);
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

/// Trace files named on the command line: a directory stands for its *.jsonl files.
fn expand(paths: &[String]) -> Result<Vec<String>, String> {
    let mut out = vec![];
    for f in paths {
        if std::path::Path::new(f).is_dir() {
            let mut v: Vec<String> = std::fs::read_dir(f).map_err(|e| format!("{}: {}", f, e))?.filter_map(|e| e.ok()).map(|e| e.path().display().to_string()).filter(|p| p.ends_with(".jsonl")).collect();
            v.sort(); out.extend(v);
        } else { out.push(f.clone()); }
    }
    Ok(out)
}
fn load_trace(f: &str) -> Result<Trace, String> { Trace::parse(&std::fs::read_to_string(f).map_err(|e| format!("{}: {}", f, e))?).map_err(|e| format!("{}: {}", f, e)) }
fn tables(data: &Option<String>, version: &str, cache: &mut HashMap<String, Rc<Data>>) -> Result<Rc<Data>, String> {
    let path = data.clone().unwrap_or_else(|| data_path(version));
    if let Some(d) = cache.get(&path) { return Ok(d.clone()); }
    let d = Rc::new(if std::path::Path::new(&path).exists() { Data::from_file(&path)? } else { eprintln!("no {}, using the built-in 1.20.1 tables", path); Data::load() });
    cache.insert(path, d.clone());
    Ok(d)
}
fn write_out(all: &[Row], sum: &J, rows_out: Option<String>, json_out: Option<String>) -> Result<(), String> {
    if let Some(p) = rows_out { let mut s = String::new(); for r in all { s += &row_json(r).dump(); s.push('\n'); } std::fs::write(&p, s).map_err(|e| format!("{}: {}", p, e))?; }
    if let Some(p) = json_out { std::fs::write(&p, sum.dump()).map_err(|e| format!("{}: {}", p, e))?; }
    Ok(())
}

/// `forgeaip-sim compare RUN_A RUN_B [--rows f] [--json f] [--near 6] [--data f]`: the real server against itself (scripts/sim/play.js), per bot file.
pub fn run_compare(args: &[String]) -> Result<(), String> {
    let (mut pos, mut data, mut rows_out, mut json_out, mut near) = (vec![], None, None, None, 6);
    let mut i = 0;
    while i < args.len() {
        let v = || args.get(i + 1).cloned().ok_or(format!("{} needs a value", args[i]));
        match args[i].as_str() { "--data" => { data = Some(v()?); i += 1; } "--rows" => { rows_out = Some(v()?); i += 1; } "--json" => { json_out = Some(v()?); i += 1; }
            "--near" => { near = v()?.parse().map_err(|_| "--near: a number")?; i += 1; } f => pos.push(f.to_string()) }
        i += 1;
    }
    if pos.len() != 2 { return Err("usage: forgeaip-sim compare RUN_A_DIR RUN_B_DIR [--rows rows.jsonl] [--json summary.json] [--near 6]".into()); }
    let (fa, fb) = (expand(&pos[..1])?, expand(&pos[1..])?);
    let mut cache = HashMap::new();
    let (mut all, mut tot) = (vec![], [0u64; 3]);
    for f in &fa {
        let base = std::path::Path::new(f).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        let g = match fb.iter().find(|g| g.ends_with(&format!("/{}", base))) { Some(g) => g, None => { eprintln!("{}: no re-play", base); continue; } };
        let (a, b) = (load_trace(f)?, load_trace(g)?);
        let d = tables(&data, &a.version, &mut cache)?;
        let (rows, n) = compare(&a, &b, d, near, &[], &[]);
        eprintln!("{}: {} paired, {} left out (surroundings or state differed at the start), {} not re-played", base, n[0], n[1], n[2]);
        for k in 0..3 { tot[k] += n[k]; }
        all.extend(rows);
    }
    let sum = summary(&all);
    print!("{}", table(&sum).replace("modelled", "paired"));
    println!("paired {}, left out {}, not re-played {}", tot[0], tot[1], tot[2]);
    write_out(&all, &sum, rows_out, json_out)
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
    if files.is_empty() { return Err("usage: forgeaip-sim replay TRACE.jsonl|DIR... [--data data-VERSION.json] [--rows rows.jsonl] [--json summary.json] [--near 6]".into()); }
    let files = expand(&files)?;
    let mut all = vec![];
    let mut cache: HashMap<String, Rc<Data>> = HashMap::new();
    let traces: Vec<(String, Trace)> = files.iter().map(|f| load_trace(f).map(|t| (f.clone(), t))).collect::<Result<_, _>>()?;
    let wins: Vec<Vec<Win>> = traces.iter().map(|(_, t)| windows(t)).collect();
    for (i, (f, t)) in traces.iter().enumerate() {
        // the other bots of the same directory (one run) share the world: their concurrent commands own the changes near them
        let dir = std::path::Path::new(f).parent();
        let others: Vec<Win> = traces.iter().enumerate().filter(|(j, (g, _))| *j != i && std::path::Path::new(g).parent() == dir).flat_map(|(j, _)| wins[j].clone()).collect();
        // the tables of the trace's version: --data, else data/data-<version>.json, else the built-in 1.20.1 set
        let d = tables(&data, &t.version, &mut cache)?;
        let (rows, unknown, skipped) = replay(t, d, near, &others);
        if !unknown.is_empty() { eprintln!("{}: block names the tables do not know (treated as solid, undiggable): {:?}", f, unknown); }
        if !skipped.is_empty() { eprintln!("{}: items the tables do not know (left out of the pack): {:?}", f, skipped); }
        all.extend(rows);
    }
    let sum = summary(&all);
    print!("{}", table(&sum));
    write_out(&all, &sum, rows_out, json_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Speed of the modelled commands on a natural tile (the testing-backend estimate in docs/implemented/SIM-PARITY-v1.md section 6):
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
    /// The fixture's commands: a mine, a place, a place into short grass (block.js REPLACEABLE lists it under its 1.20.3+ name since this task;
    /// before, the simulator said `invalid_target` here), all reproduced; an `activate` it does not model. A changed real outcome is a divergence
    /// with its category.
    #[test]
    fn replay_finds_the_agreements_and_names_a_divergence() {
        let (mut t, d) = fixture();
        let (rows, _, skipped) = replay(&t, d.clone(), 6, &[]);
        assert!(skipped.is_empty(), "{:?}", skipped);
        for r in &rows[..3] { assert!(r.agree.all(), "#{} {}: real {:?} sim {:?}", r.id, r.name, r.real, r.sim); }
        assert!(!rows[3].supported);
        let sum = summary(&rows);
        assert_eq!((sum.get("total").get("n").i(), sum.get("total").get("modelled").i(), sum.get("total").get("outcome").i()), (4, 3, 3));
        // the same trace with the server refusing the short-grass placement (as a 1.20.1 rule would): one divergence, placement_rules
        t.cmds[2].ok = false; t.cmds[2].reason = "invalid_target".into();
        let (rows, _, _) = replay(&t, d, 6, &[]);
        assert!(!rows[2].agree.outcome);
        assert!(rows[2].cats.contains(&"placement_rules"), "{:?}", rows[2].cats);
    }
    /// The real server against itself: a run compared with its own re-play (every command carrying `ref` = its id) pairs every command and
    /// agrees on all of them; a re-play that started from another cell is left out, not counted as a divergence.
    #[test]
    fn a_run_compared_with_its_replay_pairs_command_by_command() {
        let (a, d) = fixture();
        let (mut b, _) = fixture();
        for c in b.cmds.iter_mut() { c.refid = Some(c.id); }
        let (rows, n) = compare(&a, &b, d.clone(), 6, &[], &[]);
        assert_eq!(n, [4, 0, 0]);
        assert!(rows.iter().all(|r| r.agree.all() && r.agree.ticks), "{:?}", rows.iter().map(|r| (r.id, r.agree)).collect::<Vec<_>>());
        b.cmds[1].before.pos[0] += 3.0;
        let (rows, n) = compare(&a, &b, d, 6, &[], &[]);
        assert_eq!((n, rows.len()), ([3, 1, 0], 3));
    }
    /// Teacher forcing: the simulator's changes are undone after each command; the next command sees the recorded blocks.
    #[test]
    fn each_command_starts_from_the_recorded_world_not_from_the_simulators() {
        let (t, d) = fixture();
        let (rows, _, _) = replay(&t, d, 6, &[]);
        // command 1 dug (10,64,8) in both, command 2 refilled it with dirt in both; command 3's dirt is where the short grass was
        assert_eq!(rows[2].sim.blocks.get(&[12, 65, 8]).map(|s| s.as_str()), Some("dirt"));
        assert_eq!(rows[0].real.blocks.get(&[10, 64, 8]).map(|s| s.as_str()), Some("air"));
        assert_eq!(rows[1].real.blocks.get(&[10, 64, 8]).map(|s| s.as_str()), Some("dirt"));
    }
}

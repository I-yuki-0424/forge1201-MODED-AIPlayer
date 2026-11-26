//! `forgeaip-sim serve`: the world side of the packet front end (scripts/sim/front.js, docs/implemented/SIM-PARITY-v1.md section 7). One JSON request
//! per line on stdin, one JSON answer per line on stdout. The world is a block-state world (1.21.1 tables) loaded from a server's region files around
//! a centre (or from a recorded trace), and the rules are the simulator's: digging accepted at >= 70 % of the vanilla break time (ServerPlayerGameMode),
//! the drop the tool harvests, blocks that lose their support, water that flows into a dug cell, sand and gravel that fall and land later; placing
//! with the state the click and the look give (Block.getStateForPlacement per family, the rules src/work/jobs/orient.js models); the world commands
//! the test harness sends (setblock, fill, clone, execute if/unless block(s)). Players, inventories and packets stay in front.js.
//!
//!   {"op":"open","regions":DIR,"cx":0,"cz":0,"r":16}   {"op":"chunk","cx":..,"cz":..}   {"op":"dig","x","y","z","tool","eff","ground","water","elapsed"}
//!   {"op":"place","x","y","z","face","hy","yaw","pitch","item","solid_below"}   {"op":"tick","n":..}   {"op":"cmd","line":".."}   {"op":"block","x","y","z"}
use crate::anvil::{chunk_sections, Region};
use crate::data::{Data, Kind};
use crate::json::{self, J};
use crate::sim::Sim;
use crate::tile::{Chunk, Section, Tile, HEIGHT, MINY, SECS};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::rc::Rc;

fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(A[(n >> 18) as usize & 63] as char); s.push(A[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' }); s.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    s
}

/// The world: the chunks of the region files within `r` chunks of (cx, cz), as a tile of block states.
pub fn load_regions(dir: &str, d: &Data, cx: i32, cz: i32, r: i32) -> Result<Tile, String> {
    let (w, h) = (2 * r + 1, 2 * r + 1);
    let mut chunks: Vec<Option<Chunk>> = (0..w * h).map(|_| None).collect();
    let mut regs: HashMap<(i32, i32), Option<Region>> = HashMap::new();
    let mut unknown = HashMap::new();
    for z in 0..h { for x in 0..w {
        let (ccx, ccz) = (cx - r + x, cz - r + z);
        let (rx, rz) = (ccx.div_euclid(32), ccz.div_euclid(32));
        let reg = regs.entry((rx, rz)).or_insert_with(|| Region::open(&format!("{}/r.{}.{}.mca", dir, rx, rz)).ok());
        if let Some(reg) = reg.as_mut() {
            let (lx, lz) = (ccx.rem_euclid(32) as usize, ccz.rem_euclid(32) as usize);
            if !reg.has(lx, lz) { continue; }
            if let Ok(Some(root)) = reg.chunk_nbt(lx, lz) { chunks[(z * w + x) as usize] = chunk_sections(&root, d, &mut unknown); }
        }
    } }
    Ok(Tile { name: dir.to_string(), site: [cx * 16 + 8, 64, cz * 16 + 8], cx0: cx - r, cz0: cz - r, w, h, chunks })
}

const DIRS: [(&str, [i32; 3]); 6] = [("down", [0, -1, 0]), ("up", [0, 1, 0]), ("north", [0, 0, -1]), ("south", [0, 0, 1]), ("west", [-1, 0, 0]), ("east", [1, 0, 0])];
fn opp(d: &str) -> &'static str { match d { "north" => "south", "south" => "north", "west" => "east", "east" => "west", "up" => "down", _ => "up" } }
fn horiz(d: &str) -> bool { d != "up" && d != "down" }
/// orient.js dirOfYRot: the horizontal direction of a game yaw (0 south, 90 west, 180 north, 270 east).
fn dir_of_yrot(y: f64) -> &'static str { ["south", "west", "north", "east"][(((y / 90.0 + 0.5).floor() as i64 % 4 + 4) % 4) as usize] }
/// The block an item places (orient.js itemOf, reversed for the items whose block has another name).
fn block_of_item(item: &str) -> String { match item { "redstone" => "redstone_wire".into(), "string" => "tripwire".into(), "wheat_seeds" => "wheat".into(), i => i.to_string() } }

/// Block.getStateForPlacement per family (orient.js model): (block name, properties) or None when the game refuses.
pub fn placement(name: &str, clicked: &str, hy: f64, yaw: f64, pitch: f64, solid: &dyn Fn(&str) -> bool) -> Option<(String, Vec<(String, String)>)> {
    let facing = dir_of_yrot(yaw);
    let look = if pitch < -45.0 { "up" } else if pitch > 45.0 { "down" } else { facing };
    let top = clicked == "down" || (horiz(clicked) && hy > 0.5);
    let p = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
    let n = name.to_string();
    let fam = if name.ends_with("stairs") { "stairs" } else if name.ends_with("_slab") { "slab" } else if name.ends_with("_trapdoor") { "trapdoor" }
        else if matches!(name, "repeater" | "comparator") { "diode" } else if name == "hopper" { "hopper" } else if matches!(name, "chest" | "trapped_chest") { "chest" }
        else if matches!(name, "piston" | "sticky_piston" | "dispenser" | "dropper" | "barrel") { "nearest" } else if name == "observer" { "observer" }
        else if matches!(name, "furnace" | "blast_furnace" | "smoker" | "loom" | "stonecutter" | "lectern" | "anvil" | "chipped_anvil" | "damaged_anvil" | "carved_pumpkin" | "jack_o_lantern" | "ender_chest") { "facing_opposite" }
        else if name.ends_with("_fence_gate") { "gate" } else if name.ends_with("_bed") { "bed" } else if name.ends_with("_door") { "door" }
        else if matches!(name, "torch" | "soul_torch" | "redstone_torch") { "torch" } else if name == "redstone_wire" { "wire" } else if name == "ladder" { "ladder" }
        else if name.ends_with("_log") || name.ends_with("_wood") || name.ends_with("_stem") || name.ends_with("_hyphae") || matches!(name, "basalt" | "polished_basalt" | "bone_block" | "hay_block" | "chain" | "purpur_pillar" | "quartz_pillar") { "pillar" }
        else { "plain" };
    Some(match fam {
        "plain" => (n, vec![]),
        "stairs" => (n, p(&[("facing", facing), ("half", if top { "top" } else { "bottom" })])),
        "slab" => (n, p(&[("type", if clicked == "up" { "bottom" } else if clicked == "down" { "top" } else if top { "top" } else { "bottom" })])),
        "trapdoor" => if horiz(clicked) { (n, p(&[("facing", clicked), ("half", if hy > 0.5 { "top" } else { "bottom" })])) } else { (n, p(&[("facing", opp(facing)), ("half", if clicked == "up" { "bottom" } else { "top" })])) },
        "diode" => if clicked == "up" && solid("down") { (n, p(&[("facing", opp(facing))])) } else { return None },
        "hopper" => (n, p(&[("facing", if horiz(clicked) { opp(clicked) } else { "down" })])),
        "chest" | "facing_opposite" => (n, p(&[("facing", opp(facing))])),
        "nearest" => (n, p(&[("facing", opp(look))])),
        "observer" => (n, p(&[("facing", look)])),
        "gate" | "bed" => (n, p(&[("facing", facing)])),
        "door" => if clicked == "down" { return None } else { (n, p(&[("facing", facing)])) },
        "pillar" => (n, p(&[("axis", if clicked == "up" || clicked == "down" { "y" } else if clicked == "east" || clicked == "west" { "x" } else { "z" })])),
        "ladder" => if horiz(clicked) { (n, p(&[("facing", clicked)])) } else { return None },
        "wire" => if clicked == "up" && solid("down") { (n, vec![]) } else { return None },
        "torch" => {
            if clicked == "down" { return None; }
            if clicked == "up" { if solid("down") { (n, vec![]) } else { return None } }
            else { let wall = if name == "torch" { "wall_torch".to_string() } else { name.replace("_torch", "_wall_torch") }; if solid(opp(clicked)) { (wall, p(&[("facing", clicked)])) } else { return None } }
        }
        _ => (n, vec![]),
    })
}

pub struct Server { pub d: Rc<Data>, pub s: Sim }
impl Server {
    fn changes(&mut self) -> J {
        let j = self.s.journal.take().unwrap_or_default();
        self.s.journal = Some(vec![]);
        let mut seen: HashMap<[i32; 3], u16> = HashMap::new();
        for ((x, y, z), old) in j { seen.entry([x, y, z]).or_insert(old); }
        J::Arr(seen.into_iter().filter_map(|(p, old)| { let now = self.s.blk(p[0], p[1], p[2]).unwrap_or(0); if now != old { Some(J::nums(&[p[0] as f64, p[1] as f64, p[2] as f64, now as f64])) } else { None } }).collect())
    }
    fn solid(&self, x: i32, y: i32, z: i32) -> bool { self.s.kind(x, y, z) == Kind::Solid }
    fn parse_state(&self, spec: &str) -> Option<u16> {
        let spec = spec.trim_start_matches("minecraft:");
        let (name, props) = match spec.find('[') { Some(i) => (&spec[..i], spec[i + 1..].trim_end_matches(']')), None => (spec, "") };
        let def = self.d.bid(name);
        if def == self.d.unknown { return None; }
        let mut kv = self.d.props_of_state(def);
        for pair in props.split(',').filter(|s| !s.is_empty()) { if let Some((k, v)) = pair.split_once('=') { if let Some(e) = kv.iter_mut().find(|e| e.0 == k) { e.1 = v.to_string(); } } }
        self.d.state_of(name, &kv).or(Some(def))
    }
    fn matches(&self, x: i32, y: i32, z: i32, spec: &str) -> bool {
        let have = self.s.blk(x, y, z).unwrap_or(0);
        let spec = spec.trim_start_matches("minecraft:");
        let (name, props) = match spec.find('[') { Some(i) => (&spec[..i], spec[i + 1..].trim_end_matches(']')), None => (spec, "") };
        if self.d.block(have).name != name { return false; }
        let hp = self.d.props_of_state(have);
        props.split(',').filter(|s| !s.is_empty()).all(|pair| pair.split_once('=').map_or(true, |(k, v)| hp.iter().any(|e| e.0 == k && e.1 == v)))
    }
    fn coord(tok: &str) -> Option<i32> { tok.trim_start_matches('~').parse::<f64>().ok().map(|v| v.floor() as i32) }
    /// The world commands of the harness. Returns (handled, output).
    fn command(&mut self, line: &str) -> (bool, String) {
        let w: Vec<&str> = line.split_whitespace().collect();
        let c = |i: usize| w.get(i).and_then(|t| Server::coord(t));
        match w.first().copied() {
            Some("setblock") => {
                let (x, y, z) = match (c(1), c(2), c(3)) { (Some(a), Some(b), Some(cc)) => (a, b, cc), _ => return (true, "bad coordinates".into()) };
                match w.get(4).and_then(|s| self.parse_state(s)) { Some(st) => { if self.s.blk(x, y, z).is_none() { return (true, "That position is not loaded".into()); } self.s.set(x, y, z, st); (true, "Changed the block".into()) } None => (true, "Unknown block".into()) }
            }
            Some("fill") => {
                let v: Vec<Option<i32>> = (1..7).map(c).collect();
                if v.iter().any(|x| x.is_none()) { return (true, "bad coordinates".into()); }
                let v: Vec<i32> = v.into_iter().map(|x| x.unwrap()).collect();
                let st = match w.get(7).and_then(|s| self.parse_state(s)) { Some(s) => s, None => return (true, "Unknown block".into()) };
                let mode = w.get(8).copied().unwrap_or("replace");
                let mut n = 0;
                for x in v[0].min(v[3])..=v[0].max(v[3]) { for y in v[1].min(v[4])..=v[1].max(v[4]) { for z in v[2].min(v[5])..=v[2].max(v[5]) {
                    let cur = match self.s.blk(x, y, z) { Some(b) => b, None => continue };
                    if mode == "keep" && !self.s.is_air(x, y, z) { continue; }
                    if mode == "replace" && w.len() > 9 { if let Some(f) = w.get(9) { if !self.matches(x, y, z, f) { continue; } } }
                    if cur != st { self.s.set(x, y, z, st); n += 1; }
                } } }
                (true, format!("Successfully filled {} block(s)", n))
            }
            Some("clone") => {
                let v: Vec<Option<i32>> = (1..10).map(c).collect();
                if v.iter().any(|x| x.is_none()) { return (true, "bad coordinates".into()); }
                let v: Vec<i32> = v.into_iter().map(|x| x.unwrap()).collect();
                let (x0, y0, z0, x1, y1, z1) = (v[0].min(v[3]), v[1].min(v[4]), v[2].min(v[5]), v[0].max(v[3]), v[1].max(v[4]), v[2].max(v[5]));
                let mut cells = vec![];
                for x in x0..=x1 { for y in y0..=y1 { for z in z0..=z1 { cells.push(([x - x0 + v[6], y - y0 + v[7], z - z0 + v[8]], self.s.blk(x, y, z).unwrap_or(0))); } } }
                let n = cells.len();
                for (p, b) in cells { self.s.set(p[0], p[1], p[2], b); }
                (true, format!("Successfully cloned {} block(s)", n))
            }
            Some("execute") => {
                // execute [in <dim>] (if|unless) block x y z <state> | (if|unless) blocks x0 y0 z0 x1 y1 z1 dx dy dz (all|masked) [run ...]: only the test forms
                let mut i = 1;
                if w.get(1) == Some(&"in") { i = 3; }
                if w.get(i) == Some(&"positioned") { return (false, String::new()); }
                let neg = match w.get(i) { Some(&"if") => false, Some(&"unless") => true, _ => return (false, String::new()) };
                let ok = match w.get(i + 1) {
                    Some(&"block") => { let (x, y, z) = (c(i + 2), c(i + 3), c(i + 4)); match (x, y, z, w.get(i + 5)) { (Some(x), Some(y), Some(z), Some(s)) => self.matches(x, y, z, s), _ => false } }
                    Some(&"blocks") => {
                        let v: Vec<Option<i32>> = (i + 2..i + 11).map(c).collect();
                        if v.iter().any(|x| x.is_none()) { return (true, "bad coordinates".into()); }
                        let v: Vec<i32> = v.into_iter().map(|x| x.unwrap()).collect();
                        let masked = w.get(i + 11) == Some(&"masked");
                        let (x0, y0, z0, x1, y1, z1) = (v[0].min(v[3]), v[1].min(v[4]), v[2].min(v[5]), v[0].max(v[3]), v[1].max(v[4]), v[2].max(v[5]));
                        let mut same = true;
                        'o: for x in x0..=x1 { for y in y0..=y1 { for z in z0..=z1 {
                            let a = self.s.blk(x, y, z).unwrap_or(0);
                            if masked && self.d.block(a).name == "air" { continue; }
                            if a != self.s.blk(x - x0 + v[6], y - y0 + v[7], z - z0 + v[8]).unwrap_or(0) { same = false; break 'o; }
                        } } }
                        same
                    }
                    _ => return (false, String::new()),
                };
                let pass = ok != neg;
                (true, if pass { "Test passed".into() } else { "Test failed".into() })
            }
            _ => (false, String::new()),
        }
    }
    pub fn handle(&mut self, q: &J) -> J {
        let i = |k: &str| q.get(k).i() as i32;
        match q.get("op").s() {
            "chunk" => {
                let (cx, cz) = (i("cx"), i("cz"));
                if self.s.blk(cx * 16, 0, cz * 16).is_none() { return J::o(vec![("cells", J::Null)]); }
                let mut bytes = Vec::with_capacity(256 * HEIGHT as usize * 2);
                for y in MINY..MINY + HEIGHT { for z in 0..16 { for x in 0..16 { let s = self.s.blk(cx * 16 + x, y, cz * 16 + z).unwrap_or(0); bytes.extend_from_slice(&s.to_le_bytes()); } } }
                J::o(vec![("minY", J::n(MINY)), ("height", J::n(HEIGHT)), ("cells", J::st(&b64(&bytes)))])
            }
            "block" => J::o(vec![("s", J::n(self.s.blk(i("x"), i("y"), i("z")).map_or(-1.0, |b| b as f64)))]),
            "dig" => {
                let (x, y, z) = (i("x"), i("y"), i("z"));
                let bid = match self.s.blk(x, y, z) { Some(b) => b, None => return J::o(vec![("ok", J::Bool(false))]) };
                let tool = q.get("tool").s().trim_start_matches("minecraft:").to_string();
                self.s.eff.clear(); if q.get("eff").i() > 0 { self.s.eff.insert(tool.clone(), q.get("eff").i() as i32); }
                let (need, harvest) = match self.s.tool_ticks(bid, &tool) { Some(t) => t, None => self.s.tool_ticks(bid, "").map_or((i64::MAX / 4, false), |t| (t.0, false)) };
                let need = if q.get("ground").b() || q.get("ground").is_null() { need } else { need * 5 };
                let elapsed = q.get("elapsed").i();
                if !(elapsed as f64 + 1.0 >= 0.7 * need as f64) { return J::o(vec![("ok", J::Bool(false)), ("need", J::n(need as f64))]); }
                // the tool in a scratch pack so the simulator's harvest rule sees it; what else is in the pack afterwards is the drop
                self.s.inv = vec![None; 36];
                if !tool.is_empty() { self.s.give(&tool, 1); }
                let mut ev = vec![];
                self.s.break_block_pub([x, y, z], &mut ev);
                let drops: Vec<J> = if harvest { self.s.held().into_iter().filter_map(|(n, c)| { let c = if n == tool { c.saturating_sub(1) } else { c }; if c > 0 { Some(J::Arr(vec![J::st(&n), J::n(c as f64)])) } else { None } }).collect() } else { vec![] };
                self.s.inv = vec![None; 36];
                J::o(vec![("ok", J::Bool(true)), ("changes", self.changes()), ("drops", J::Arr(drops))])
            }
            "place" => {
                let (x, y, z) = (i("x"), i("y"), i("z"));
                let face = q.get("face").i() as usize;
                let clicked = DIRS.get(face).map(|d| d.0).unwrap_or("up");
                let cur = match self.s.blk(x, y, z) { Some(b) => b, None => return J::o(vec![("ok", J::Bool(false))]) };
                let t = if crate::sim::replaceable(&self.d.block(cur).name) || self.d.block(cur).name == "water" { [x, y, z] } else { let n = DIRS[face.min(5)].1; [x + n[0], y + n[1], z + n[2]] };
                let tn = self.d.block(self.s.blk(t[0], t[1], t[2]).unwrap_or(0)).name.clone();
                if !(crate::sim::replaceable(&tn) || tn == "water" || tn == "lava") { return J::o(vec![("ok", J::Bool(false)), ("why", J::st("occupied"))]); }
                let item = block_of_item(q.get("item").s().trim_start_matches("minecraft:"));
                if self.d.bid(&item) == self.d.unknown { return J::o(vec![("ok", J::Bool(false)), ("why", J::st("not a block"))]); }
                let solid = |dn: &str| { let v = DIRS.iter().find(|d| d.0 == dn).unwrap().1; self.solid(t[0] + v[0], t[1] + v[1], t[2] + v[2]) };
                let (name, props) = match placement(&item, clicked, q.get("hy").f(), q.get("yaw").f(), q.get("pitch").f(), &solid) { Some(r) => r, None => return J::o(vec![("ok", J::Bool(false)), ("why", J::st("refused"))]) };
                let mut kv = self.d.props_of_state(self.d.bid(&name));
                for (k, v) in props { if let Some(e) = kv.iter_mut().find(|e| e.0 == k) { e.1 = v; } }
                if tn == "water" { if let Some(e) = kv.iter_mut().find(|e| e.0 == "waterlogged") { e.1 = "true".into(); } }
                let st = self.d.state_of(&name, &kv).unwrap_or(self.d.bid(&name));
                self.s.set(t[0], t[1], t[2], st);
                J::o(vec![("ok", J::Bool(true)), ("at", J::nums(&[t[0] as f64, t[1] as f64, t[2] as f64])), ("changes", self.changes())])
            }
            "tick" => { let mut ev = vec![]; self.s.advance(q.get("n").i().max(1), &mut ev); J::o(vec![("changes", self.changes())]) }
            "cmd" => { let (handled, out) = self.command(q.get("line").s()); J::o(vec![("handled", J::Bool(handled)), ("out", J::st(&out)), ("changes", self.changes())]) }
            o => J::o(vec![("error", J::st(&format!("unknown op {}", o)))]),
        }
    }
}

/// `forgeaip-sim serve --regions DIR --cx N --cz N [--r 16] [--data data-1.21.1.json]`
pub fn run(args: &[String]) -> Result<(), String> {
    let (mut regions, mut cx, mut cz, mut r, mut data, mut trace) = (String::new(), 0, 0, 16, format!("{}/data/data-1.21.1.json", env!("CARGO_MANIFEST_DIR")), String::new());
    let mut i = 0;
    while i < args.len() {
        let v = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() { "--regions" => regions = v, "--trace" => trace = v, "--cx" => cx = v.parse().unwrap_or(0), "--cz" => cz = v.parse().unwrap_or(0), "--r" => r = v.parse().unwrap_or(16), "--data" => data = v, _ => {} }
        i += 2;
    }
    if !std::path::Path::new(&data).exists() { data = "tools/sim/data/data-1.21.1.json".into(); }
    let d = Rc::new(Data::from_file(&data)?);
    if !d.states { return Err("serve needs the per-state tables (gen_data.js SIM_MC_VERSION)".into()); }
    // the world: region files around a centre, or the first snapshot of every chunk of a recorded run (`--trace DIR`)
    let (tile, vine) = if !trace.is_empty() {
        let mut files: Vec<String> = std::fs::read_dir(&trace).map_err(|e| format!("{}: {}", trace, e))?.filter_map(|e| e.ok()).map(|e| e.path().display().to_string()).filter(|p| p.ends_with(".jsonl")).collect();
        files.sort();
        let mut all: Option<crate::replay::Trace> = None;
        for f in &files {
            let t = crate::replay::Trace::parse(&std::fs::read_to_string(f).map_err(|e| e.to_string())?)?;
            match all.as_mut() { None => all = Some(t), Some(a) => { a.chunks.extend(t.chunks); for (k, v) in t.states { a.states.insert(k, v); } for (k, v) in t.vine_bits { a.vine_bits.insert(k, v); } } }
        }
        let t = all.ok_or("no traces")?;
        let w = crate::replay::world(&t, &d);
        (w.tile, w.vine)
    } else { (Rc::new(load_regions(&regions, &d, cx, cz, r)?), HashMap::new()) };
    let loaded = tile.chunks.iter().filter(|c| c.is_some()).count();
    let mut s = Sim::new(d.clone(), tile, 1);
    s.vine = vine;
    s.hostile_scale = 0.0; s.tick = 6000; s.journal = Some(vec![]);
    let mut srv = Server { d, s };
    let out = std::io::stdout();
    let mut o = out.lock();
    writeln!(o, "{}", J::o(vec![("ready", J::Bool(true)), ("chunks", J::n(loaded as f64))]).dump()).map_err(|e| e.to_string())?;
    o.flush().ok();
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() { continue; }
        let ans = match json::parse(&line) { Ok(q) => { let mut a = srv.handle(&q); if let J::Obj(v) = &mut a { v.insert(0, ("id".into(), q.get("id").clone())); } a } Err(e) => J::o(vec![("error", J::st(&e))]) };
        writeln!(o, "{}", ans.dump()).map_err(|e| e.to_string())?;
        o.flush().ok();
    }
    let _ = (Section::Uniform(0), SECS);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d() -> Rc<Data> { Rc::new(Data::from_file(concat!(env!("CARGO_MANIFEST_DIR"), "/data/data-1.21.1.json")).unwrap()) }
    /// prismarine-block's state ids: every block's default state round-trips through its properties.
    #[test]
    fn state_ids_round_trip_through_properties() {
        let d = d();
        let mut n = 0;
        for (name, (min, _)) in &d.props_of {
            let ds = d.bid(name);
            assert!(ds >= *min, "{}", name);
            assert_eq!(d.state_of(name, &d.props_of_state(ds)), Some(ds), "{}", name);
            n += 1;
        }
        assert!(n > 1000);
        let st = d.state_of("oak_stairs", &[("facing".into(), "east".into()), ("half".into(), "top".into())]).unwrap();
        let p = d.props_of_state(st);
        assert!(p.contains(&("facing".into(), "east".into())) && p.contains(&("half".into(), "top".into())));
    }
    /// Placement as the game gives it (orient.js model): stairs face the way the player looks, a log follows the clicked face, a torch on a side
    /// face is a wall torch facing away from the wall.
    #[test]
    fn placement_follows_the_click_and_the_look() {
        let solid = |_: &str| true;
        assert_eq!(placement("oak_stairs", "up", 0.25, 180.0, 0.0, &solid).unwrap().1, vec![("facing".to_string(), "north".to_string()), ("half".to_string(), "bottom".to_string())]);
        assert_eq!(placement("oak_log", "east", 0.5, 0.0, 0.0, &solid).unwrap().1, vec![("axis".to_string(), "x".to_string())]);
        let (n, p) = placement("torch", "south", 0.5, 0.0, 0.0, &solid).unwrap();
        assert_eq!((n.as_str(), p), ("wall_torch", vec![("facing".to_string(), "south".to_string())]));
        assert!(placement("repeater", "up", 0.5, 0.0, 0.0, &|_| false).is_none());
    }
}

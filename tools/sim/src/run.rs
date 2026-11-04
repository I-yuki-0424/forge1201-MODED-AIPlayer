//! `run`: the environment side of the file API (src/rl/run_skill_env.js, env v3.x) on the simulator. One process = one group
//! (shard) of bots, each in its own world tile; same hello / obs / act messages, same reward terms, so the learner needs no change.
use crate::data::Data;
use crate::json::{self, J};
use crate::obs::{self, Args, Cand, REASONS};
use crate::scenario::{entry_ids, Scenario};
use crate::sim::{Ev, Out, Sim, DAY};
use crate::tile::Tile;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TERMS: [&str; 4] = ["survival", "death", "progress", "invalid"];
const ENV_VERSION: &str = "2026-11-04-sim0.2-skills-v3.1";

struct Entry { id: String, stat: Option<String>, any: HashSet<String>, event: Option<String> }
struct Table { scored: Option<HashSet<String>>, death: f64, awake: f64, slept: f64, per_entry: f64, invalid: HashMap<String, f64>, v: f64, stages: J }
struct Reward { done: HashSet<String>, at: Vec<(String, u32)>, days: u32, slept: u32, diedtoday: bool }
impl Reward {
    fn new(preset: &HashSet<String>) -> Reward { Reward { done: preset.clone(), at: vec![], days: 0, slept: 0, diedtoday: false } }
    fn progress(&self, entries: &[Entry]) -> Vec<f64> {
        let mut v: Vec<f64> = entries.iter().map(|e| if self.done.contains(&e.id) { 1.0 } else { 0.0 }).collect();
        v.push((self.days as f64 / 10.0).min(1.0)); v.push((self.slept as f64 / 10.0).min(1.0)); v
    }
    fn score(&mut self, ev: &[Ev], failed: Option<&str>, t: &Table, entries: &[Entry], step: u32) -> ([f64; 4], f64) {
        let mut terms = [0.0f64; 4];
        let mut reach = |this: &mut Reward, stat: Option<&str>, name: &str, slept: bool, terms: &mut [f64; 4]| {
            for e in entries {
                let hit = match (&e.stat, stat) { (Some(s), Some(q)) => s == q && e.any.contains(name), _ => e.event.as_deref() == Some("slept") && slept && stat.is_none() };
                if hit && !this.done.contains(&e.id) { this.done.insert(e.id.clone()); this.at.push((e.id.clone(), step)); if t.scored.as_ref().map_or(true, |s| s.contains(&e.id)) { terms[2] += t.per_entry; } }
            }
        };
        for e in ev {
            match e {
                Ev::Death => { self.diedtoday = true; terms[1] += t.death; }
                Ev::Dawn(sl) => { if !self.diedtoday { self.days += 1; if *sl { self.slept += 1; } terms[0] += if *sl { t.slept } else { t.awake }; } self.diedtoday = false; reach(self, None, "", *sl, &mut terms); }
                Ev::Stat(stat, name, n) => if *n > 0 { reach(self, Some(stat), name, false, &mut terms) },
                Ev::Killed(name, n) => if *n > 0 { reach(self, Some("killed"), name, false, &mut terms) },
            }
        }
        if let Some(r) = failed { terms[3] += t.invalid.get(r).copied().unwrap_or(0.0); }
        for x in terms.iter_mut() { *x = (*x * 1e6).round() / 1e6; }
        (terms, (terms.iter().sum::<f64>() * 1e6).round() / 1e6)
    }
}

struct Bot {
    env_id: u32, sim: Sim, rew: Reward, episode: u32, step: u32, cands: Vec<Cand>, last: (usize, i64), msg: ([f64; 4], f64, bool),
    ring: Vec<(bool, [i32; 3])>, pending: Vec<Ev>, tile: usize, ep_steps: u32, deaths: u32, info: Option<J>,
}
struct Cfg { root: String, base: String, shard: u32, bots: u32, days: i64, tiles: Vec<String>, seed: u64, entries: Vec<Entry>, table: Table, d: Rc<Data>, run_id: String, scn: Option<Scenario>, preset: HashSet<String> }

fn now() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0) }
struct Chan { out: std::fs::File, inp: String, pos: u64, rest: Vec<u8>, seq: u64, run_id: String }
impl Chan {
    fn send(&mut self, env_id: u32, ty: &str, mut f: Vec<(&str, J)>) {
        let mut v = vec![("v", J::n(1.0)), ("type", J::st(ty)), ("run_id", J::st(&self.run_id)), ("env_id", J::n(env_id as f64)), ("seq", J::n(self.seq as f64)), ("t", J::n((now() * 1000.0).round() / 1000.0))];
        v.append(&mut f);
        self.seq += 1;
        let mut line = J::o(v).dump();
        line.push('\n');
        self.out.write_all(line.as_bytes()).expect("write env_to_policy");
    }
    fn poll(&mut self) -> Vec<J> {
        let mut out = vec![];
        let mut f = match std::fs::File::open(&self.inp) { Ok(f) => f, Err(_) => return out };
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        if size <= self.pos { return out; }
        let mut buf = vec![0u8; (size - self.pos) as usize];
        if f.seek(SeekFrom::Start(self.pos)).is_err() || f.read_exact(&mut buf).is_err() { return out; }
        self.pos = size;
        self.rest.extend_from_slice(&buf);
        if let Some(end) = self.rest.iter().rposition(|&b| b == b'\n') {
            let chunk: Vec<u8> = self.rest.drain(..=end).collect();
            for line in String::from_utf8_lossy(&chunk).lines() {
                if line.is_empty() { continue; }
                if let Ok(m) = json::parse(line) { if m.get("v").i() == 1 && m.get("run_id").s() == self.run_id && matches!(m.get("type").s(), "hello_ack" | "act") { out.push(m); } }
            }
        }
        out
    }
}

fn find_start(s: &Sim) -> Option<[i32; 3]> {
    let [sx, sy, sz] = s.site;
    let mut logs = 0;
    for dx in -16..=16i32 { for dz in -16..=16i32 { if dx * dx + dz * dz > 256 { continue; } for y in sy - 6..=sy + 24 { if s.name(sx + dx, y, sz + dz).ends_with("_log") { logs += 1; } } } }
    if logs < 12 { return None; }
    let mut ring: Vec<(i32, i32, i32)> = vec![];
    for dx in -8..=8 { for dz in -8..=8 { ring.push((dx * dx + dz * dz, dx, dz)); } }
    ring.sort();
    for (_, dx, dz) in ring {
        let (cx, cz) = (sx + dx, sz + dz);
        for cy in (sy - 20..=sy + 30).rev() {
            let below = s.name(cx, cy - 1, cz);
            if below == "unloaded" { break; }
            let bad_floor = below.ends_with("_leaves") || below.ends_with("_log") || below.ends_with("_wood") || below.contains("water") || below.contains("lava") || below.contains("ice");
            let wet = s.name(cx, cy, cz).contains("water") || s.name(cx, cy, cz).contains("lava");
            if s.standable(cx, cy, cz) && !wet && !bad_floor { return Some([cx, cy, cz]); }
            if !s.is_air(cx, cy - 1, cz) && !below.ends_with("_leaves") && !below.ends_with("_log") && !below.contains("vine") { break; }
        }
    }
    None
}

fn new_episode(c: &Cfg, b: &mut Bot, cache: &mut HashMap<usize, Rc<Tile>>, avoid: Option<usize>, rng: &mut crate::sim::Rng) -> Result<(), String> {
    for _ in 0..40 {
        let ti = (rng.below(c.tiles.len() as u64)) as usize;
        if Some(ti) == avoid && c.tiles.len() > 1 { continue; }
        if !cache.contains_key(&ti) {
            if cache.len() >= 3 { let k = *cache.keys().find(|k| Some(**k) != avoid).unwrap_or(&ti); cache.remove(&k); }
            cache.insert(ti, Rc::new(Tile::load(&c.tiles[ti])?));
        }
        let tile = cache[&ti].clone();
        let mut sim = Sim::new(c.d.clone(), tile.clone(), rng.next());
        sim.site = tile.site;
        let st = match find_start(&sim) { Some(s) => s, None => continue };
        sim.site = st; sim.pos = st; sim.track = st; sim.view = st;
        sim.spawn_animals();
        b.info = match &c.scn { Some(sc) => match sc.start(&mut sim, rng) { Ok(i) => Some(i), Err(_) => continue }, None => None };
        b.sim = sim; b.tile = ti;
        b.rew = Reward::new(&c.preset); b.step = 0; b.ep_steps = 0; b.deaths = 0; b.ring.clear(); b.pending.clear();
        b.last = (0, 0); b.msg = ([0.0; 4], 0.0, false);
        return Ok(());
    }
    Err("no usable start site in the tiles (for the scenario: no start that fits its placements)".into())
}

fn exec(s: &mut Sim, c: &Cand) -> Out {
    s.track = s.pos; s.ph.clear();
    match &c.args {
        Args::Wait => s.do_wait(40), Args::Move(t) => s.do_move(*t), Args::Mine(t) => s.do_mine(*t), Args::Tunnel(d, dy) => s.do_tunnel(d, *dy), Args::Attack(id) => s.do_attack(*id),
        Args::Craft(n, t) => s.do_craft(n, *t), Args::Smelt(n, t) => s.do_smelt(n, *t), Args::Place(t, n) => s.do_place(*t, n), Args::Activate(t) => s.do_sleep(*t), Args::Eat(n) => s.do_eat(n),
    }
}
fn args(v: &[String]) -> HashMap<String, String> { let mut m = HashMap::new(); let mut i = 0; while i + 1 < v.len() { m.insert(v[i].clone(), v[i + 1].clone()); i += 2; } m }

pub fn run(argv: &[String]) -> Result<(), String> {
    let a = args(argv);
    let g = |k: &str, d: &str| a.get(k).cloned().unwrap_or_else(|| d.to_string());
    let root = g("--root", "/exchange"); let base = a.get("--base").cloned().ok_or("--base")?;
    let shard: u32 = g("--shard", "0").parse().map_err(|_| "--shard")?; let bots: u32 = g("--bots", "2").parse().map_err(|_| "--bots")?;
    let days: i64 = g("--days", "3").parse().map_err(|_| "--days")?; let seed: u64 = g("--seed", "1").parse().map_err(|_| "--seed")?;
    let world = a.get("--world").cloned().ok_or("--world <tile name prefix, e.g. vps-s0>")?; let tdir = a.get("--tiles").cloned().ok_or("--tiles <dir>")?;
    let mut tiles: Vec<String> = std::fs::read_dir(&tdir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).map(|e| e.path().to_string_lossy().into_owned())
        .filter(|p| p.rsplit('/').next().map_or(false, |f| f.starts_with(&format!("{}-", world)) && f.ends_with(".tile"))).collect();
    tiles.sort();
    if tiles.is_empty() { return Err(format!("no tiles {}-*.tile in {}", world, tdir)); }
    let rj = json::parse(&std::fs::read_to_string(g("--reward", "src/rl/reward-v6.json")).map_err(|e| e.to_string())?)?;
    let pj = json::parse(&std::fs::read_to_string(g("--progress", "src/rl/progress-list.json")).map_err(|e| e.to_string())?)?;
    let entries: Vec<Entry> = pj.get("entries").arr().iter().map(|e| Entry { id: e.get("id").s().to_string(), stat: if e.get("stat").is_null() { None } else { Some(e.get("stat").s().to_string()) },
        any: e.get("any").arr().iter().map(|x| x.s().to_string()).collect(), event: if e.get("event").is_null() { None } else { Some(e.get("event").s().to_string()) } }).collect();
    let ids = entry_ids(&pj);
    let scn = match a.get("--scenario") { Some(p) => Some(Scenario::load(p, &Data::load(), &ids)?), None => None };
    let preset = scn.as_ref().map_or(HashSet::new(), |s| s.preset(&ids));
    let table = Table { scored: scn.as_ref().and_then(|s| s.score.clone()), death: rj.get("death").get("penalty").f(), awake: rj.get("survival").get("day_awake").f(), slept: rj.get("survival").get("day_slept").f(), per_entry: rj.get("progress").get("per_entry").f(),
        invalid: rj.get("invalid").get("reasons").obj().iter().map(|(k, v)| (k.clone(), v.f())).collect(), v: rj.get("v").f(), stages: scn.as_ref().map_or_else(|| rj.get("stages").clone(), |s| s.stages(rj.get("stages"))) };
    let d = Rc::new(Data::load());
    let stamp = { let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0); format!("{}", t) };
    let run_id = format!("{}-s{}-sim{}", base, shard, stamp);
    let dir = format!("{}/{}", root, run_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(format!("{}/{}.s{}.current", root, base, shard), format!("{}\n", run_id)).map_err(|e| e.to_string())?;
    let out = std::fs::OpenOptions::new().create(true).append(true).open(format!("{}/env_to_policy.jsonl", dir)).map_err(|e| e.to_string())?;
    let mut events = std::fs::OpenOptions::new().create(true).append(true).open(format!("{}/events.jsonl", dir)).map_err(|e| e.to_string())?;
    let mut ch = Chan { out, inp: format!("{}/policy_to_env.jsonl", dir), pos: 0, rest: vec![], seq: 0, run_id: run_id.clone() };
    let cfg = Cfg { root, base, shard, bots, days, tiles, seed, entries, table, d: d.clone(), run_id, scn, preset };
    eprintln!("[sim] {} tiles of {}, run {}, scenario {}", cfg.tiles.len(), world, cfg.run_id, cfg.scn.as_ref().map_or("-", |s| s.id.as_str()));

    // hello
    let nent = d.entities.len();
    let f = |n: &str, shape: Vec<f64>, dt: &str| J::o(vec![("name", J::st(n)), ("shape", J::nums(&shape)), ("dtype", J::st(dt))]);
    let obs_spec = J::o(vec![("fields", J::Arr(vec![f("grid", vec![405.0], "int"), f("self", vec![20.0], "float"), f("inv_item", vec![36.0], "int"), f("inv_count", vec![36.0], "float"), f("ent_type", vec![8.0], "int"),
        f("ent_feat", vec![8.0, 5.0], "float"), f("progress", vec![cfg.entries.len() as f64 + 2.0], "float"), f("view_cat", vec![128.0], "int"), f("view_item", vec![128.0], "int"), f("view_dist", vec![128.0], "float"),
        f("killed", vec![nent as f64], "float"), f("clock", vec![3.0], "float"), f("cand_cmd", vec![64.0], "int"), f("cand_item", vec![64.0], "int"), f("cand_ent", vec![64.0], "int"),
        f("cand_feat", vec![64.0, 8.0], "float"), f("cand_mask", vec![64.0], "bool"), f("last_reason", vec![], "int"), f("dt_ticks", vec![], "float")]))]);
    let hello = |k: u32| -> Vec<(&str, J)> { vec![
        ("env_version", J::st(ENV_VERSION)),
        ("action_spec", J::o(vec![("name", J::st("skills_v1")), ("version", J::n(1.0)), ("ticks_per_step", J::n(1.0)), ("components", J::Arr(vec![J::o(vec![("kind", J::st("select")), ("name", J::st("candidate")), ("n", J::n(64.0))])])), ("rules", J::Arr(vec![]))])),
        ("obs_spec", obs_spec.clone()),
        ("vocab_sizes", J::o(vec![("item", J::n(d.items.len() as f64)), ("entity", J::n(nent as f64)), ("cmd", J::n(13.0)), ("reason", J::n(REASONS.len() as f64)), ("category", J::n(11.0))])),
        ("milestones", J::Arr(cfg.entries.iter().map(|e| J::st(&e.id)).collect())), ("notable", J::Arr(vec![])), ("reward_terms", J::Arr(TERMS.iter().map(|t| J::st(t)).collect())),
        ("stages", cfg.table.stages.clone()), ("reward_table_version", J::n(cfg.table.v)),
        ("vocab", J::o(vec![("items", J::Arr(d.items.iter().map(|x| J::st(x)).collect())), ("entities", J::Arr(d.entities.iter().map(|x| J::st(x)).collect()))])),
        ("view_shape", J::nums(&[8.0, 16.0])), ("days", J::n(cfg.days as f64)),
        ("start", J::o(vec![("pair", J::n(cfg.shard as f64)), ("shard", J::n(cfg.shard as f64)), ("member", J::n(k as f64)), ("world", J::st(&world)), ("scenario", J::st(cfg.scn.as_ref().map_or("", |s| s.id.as_str())))])) ] };
    let off = cfg.shard * cfg.bots;
    for k in 0..cfg.bots { ch.send(off + k, "hello", hello(k)); }
    let mut acks = HashSet::new();
    let t0 = Instant::now();
    while acks.len() < cfg.bots as usize {
        for m in ch.poll() { if m.get("type").s() == "hello_ack" { if !m.get("accepted").b() { return Err(format!("hello refused: {}", m.get("reason").s())); } acks.insert(m.get("env_id").i() as u32); } }
        if t0.elapsed() > Duration::from_secs(120) { return Err("no hello_ack within 120 s".into()); }
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut rng = crate::sim::Rng(cfg.seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
    let mut cache: HashMap<usize, Rc<Tile>> = HashMap::new();
    let mut bs: Vec<Bot> = vec![];
    for k in 0..cfg.bots {
        let dummy = Sim::new(d.clone(), Rc::new(Tile { name: String::new(), site: [0; 3], cx0: 0, cz0: 0, w: 0, h: 0, chunks: vec![] }), 1);
        let mut b = Bot { env_id: off + k, sim: dummy, rew: Reward::new(&cfg.preset), episode: 0, step: 0, cands: vec![], last: (0, 0), msg: ([0.0; 4], 0.0, false), ring: vec![], pending: vec![], tile: 0, ep_steps: 0, deaths: 0, info: None };
        let avoid = bs.first().map(|x: &Bot| x.tile);
        new_episode(&cfg, &mut b, &mut cache, avoid, &mut rng)?;
        log_start(&mut events, &b);
        bs.push(b);
    }
    for i in 0..bs.len() { send_obs(&cfg, &mut ch, &mut bs[i]); }
    let mut last_act = Instant::now();
    let mut last_done = Instant::now();
    let limit = cfg.days * DAY;
    let mut total: u64 = 0;
    loop {
        let msgs = ch.poll();
        if msgs.is_empty() {
            if last_done.elapsed() > Duration::from_secs(2) {
                last_done = Instant::now();
                if std::path::Path::new(&format!("{}/{}.done", cfg.root, cfg.base)).exists() {          // the learner spent its budget
                    for b in &bs { ch.send(b.env_id, "bye", vec![]); }
                    eprintln!("[sim] shard {}: learner done after {} steps", cfg.shard, total);
                    return Ok(());
                }
            }
            if last_act.elapsed() > Duration::from_secs(600) { return Err("no act within 600 s".into()); }
            std::thread::sleep(Duration::from_micros(300));
            continue;
        }
        for m in msgs {
            if m.get("type").s() != "act" { continue; }
            last_act = Instant::now();
            let bi = match bs.iter().position(|b| b.env_id as i64 == m.get("env_id").i()) { Some(i) => i, None => continue };
            if bs[bi].episode as i64 != m.get("episode").i() || bs[bi].step as i64 != m.get("step").i() { continue; }
            if bs[bi].msg.2 { continue; }
            let ci = m.get("action").get("candidate").i();
            let b = &mut bs[bi];
            let cand = if ci >= 0 && (ci as usize) < b.cands.len() { Some(b.cands[ci as usize].clone()) } else { None };
            let mut o = match &cand { Some(c) => exec(&mut b.sim, c), None => b.sim.do_wait(20) };
            if cand.is_none() { o.ok = false; o.reason = "invalid_args"; }
            let mut ev = std::mem::take(&mut b.pending);
            ev.extend(o.ev.drain(..));
            // The same step record as the real environment's events.jsonl (cmd, reason, ticks, damage by cause, position, health), so
            // tools/sim/compare.py reads both.
            { let dm: Vec<J> = b.sim.dmg.drain(..).map(|(src, by, d, dist)| J::o(vec![("k", J::st("hit")), ("src", J::st(src)), ("by", J::st(by)), ("d", J::n((d * 100.0).round() / 100.0)), ("dist", J::n((dist * 10.0).round() / 10.0))])).collect();
              let mut row = vec![("event", J::st("step")), ("env_id", J::n(b.env_id as f64)), ("episode", J::n(b.episode as f64)), ("step", J::n(b.step as f64 + 1.0)),
                  ("cmd", J::st(cand.as_ref().map_or("invalid", |c| obs::CMDS[c.cmd]))), ("reason", J::st(if o.ok { "ok" } else { o.reason })), ("ticks", J::n(o.ticks as f64)),
                  ("health", J::n((b.sim.hp.max(0.0) * 10.0).round() / 10.0)), ("pos", J::nums(&[b.sim.pos[0] as f64, b.sim.pos[1] as f64, b.sim.pos[2] as f64]))];
              if !b.sim.ph.is_empty() { let mut t = 0i64; let mut v = vec![]; for (n, d) in b.sim.ph.drain(..) { v.push(J::Arr(vec![J::st(n), J::n(t as f64)])); t += d.max(0); } row.push(("ph", J::Arr(v))); }
              match cand.as_ref().map(|c| &c.args) {
                  Some(Args::Mine(t)) => row.push(("args", J::o(vec![("x", J::n(t[0] as f64)), ("y", J::n(t[1] as f64)), ("z", J::n(t[2] as f64))]))),
                  Some(Args::Place(t, n)) => row.push(("args", J::o(vec![("x", J::n(t[0] as f64)), ("y", J::n(t[1] as f64)), ("z", J::n(t[2] as f64)), ("item", J::st(n))]))),
                  _ => {} }
              if !dm.is_empty() { row.push(("dmg", J::Arr(dm))); }
              if ev.iter().any(|e| matches!(e, Ev::Death)) { row.push(("died", J::Bool(true))); }
              let _ = writeln!(events, "{}", J::o(row).dump()); }
            let died = ev.iter().any(|e| matches!(e, Ev::Death));
            let (terms, total_r) = b.rew.score(&ev, if o.ok { None } else { Some(o.reason) }, &cfg.table, &cfg.entries, b.step + 1);
            if died { b.deaths += 1; b.sim.respawn(); if let Some(sc) = &cfg.scn { sc.respawned(&mut b.sim); } b.ring.clear(); }
            else {
                let is_wait = matches!(cand.as_ref().map(|c| &c.args), Some(Args::Wait));
                b.ring.push((o.ok && !is_wait, b.sim.pos)); if b.ring.len() > 200 { b.ring.remove(0); }
                if b.ring.len() == 200 && (b.ring.iter().filter(|r| r.0).count() as f64 / 200.0) < 0.1
                    && (0..3).all(|i| { let mx = b.ring.iter().map(|r| r.1[i]).max().unwrap(); let mn = b.ring.iter().map(|r| r.1[i]).min().unwrap(); mx - mn <= 2 }) {
                    b.pending.push(Ev::Death); b.sim.respawn(); if let Some(sc) = &cfg.scn { sc.respawned(&mut b.sim); } b.ring.clear();      // trapped: killed, hiding must not collect days
                }
            }
            let ridx = REASONS.iter().position(|r| *r == if o.ok { "ok" } else { o.reason }).unwrap_or(0);
            b.last = (ridx, o.ticks.max(1));
            b.msg = (terms, total_r, b.sim.tick >= limit);
            b.step += 1; b.ep_steps += 1; total += 1;
            send_obs(&cfg, &mut ch, &mut bs[bi]);
            if bs[bi].msg.2 {
                // episode over: one summary row (entries reached this episode with the step of the first time, deaths), then the next one
                { let b = &bs[bi]; let row = J::o(vec![("event", J::st("episode_end")), ("env_id", J::n(b.env_id as f64)), ("episode", J::n(b.episode as f64)), ("steps", J::n(b.ep_steps as f64)), ("deaths", J::n(b.deaths as f64)),
                    ("reached", J::Obj(b.rew.at.iter().map(|(k, v)| (k.clone(), J::n(*v as f64))).collect()))]); let _ = writeln!(events, "{}", row.dump()); }
                let avoid = bs.iter().enumerate().find(|(i, _)| *i != bi).map(|(_, x)| x.tile);
                let b = &mut bs[bi];
                b.episode += 1;
                new_episode(&cfg, b, &mut cache, avoid, &mut rng)?;
                log_start(&mut events, b);
                send_obs(&cfg, &mut ch, &mut bs[bi]);
            }
            if total % 20000 == 0 { eprintln!("[sim] shard {}: {} steps", cfg.shard, total); }
        }
    }
}
/// The scenario record of a new episode (what was placed where, the heading) next to the step rows, with the episode and bot ids.
fn log_start(events: &mut std::fs::File, b: &Bot) {
    if let Some(J::Obj(v)) = &b.info { let mut row = vec![("env_id".to_string(), J::n(b.env_id as f64)), ("episode".to_string(), J::n(b.episode as f64))]; row.extend(v.iter().cloned()); let _ = writeln!(events, "{}", J::Obj(row).dump()); }
}
fn send_obs(cfg: &Cfg, ch: &mut Chan, b: &mut Bot) {
    let cands = obs::candidates(&mut b.sim);
    b.cands = cands;
    let limit = (cfg.days * DAY) as f64;
    let clock = [b.sim.tick as f64 / limit, ((b.step as f64).ln_1p() / 10.0 * 1e4).round() / 1e4, (b.sim.tick % DAY) as f64 / DAY as f64];
    let prog = b.rew.progress(&cfg.entries);
    let o = obs::observe(&mut b.sim, &b.cands, &prog, b.last, clock);
    let terms = J::o(TERMS.iter().enumerate().map(|(i, t)| (*t, J::n(b.msg.0[i]))).collect());
    ch.send(b.env_id, "obs", vec![("episode", J::n(b.episode as f64)), ("step", J::n(b.step as f64)), ("obs", o), ("reward", J::n(b.msg.1)), ("reward_terms", terms), ("terminated", J::Bool(b.msg.2)), ("truncated", J::Bool(false))]);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(id: &str, stat: &str, item: &str) -> Entry { Entry { id: id.into(), stat: Some(stat.into()), any: [item.to_string()].into_iter().collect(), event: None } }
    fn table(scored: Option<&[&str]>) -> Table {
        Table { scored: scored.map(|l| l.iter().map(|x| x.to_string()).collect()), death: -0.25, awake: 1.0, slept: 1.5, per_entry: 1.0, invalid: HashMap::new(), v: 6.0, stages: J::Null }
    }
    #[test]
    fn unscored_entries_are_tracked_but_pay_nothing_and_a_preset_entry_never_pays() {
        let ents = vec![entry("collect_iron", "picked_up", "raw_iron"), entry("craft_stick", "crafted", "stick"), entry("smelt_iron", "crafted", "iron_ingot")];
        let preset: HashSet<String> = ["smelt_iron".to_string()].into_iter().collect();
        let mut r = Reward::new(&preset);
        let ev = |s: &'static str, n: &str| vec![Ev::Stat(s, n.to_string(), 1)];
        let t = table(Some(&["collect_iron", "smelt_iron"]));
        assert_eq!(r.score(&ev("crafted", "stick"), None, &t, &ents, 3).0[2], 0.0);          // tracked, unpaid
        assert_eq!(r.score(&ev("picked_up", "raw_iron"), None, &t, &ents, 9).0[2], 1.0);      // paid once
        assert_eq!(r.score(&ev("picked_up", "raw_iron"), None, &t, &ents, 10).0[2], 0.0);
        assert_eq!(r.score(&ev("crafted", "iron_ingot"), None, &t, &ents, 20).0[2], 0.0);     // preset: already reached, never paid
        assert_eq!(r.progress(&ents)[..3], [1.0, 1.0, 1.0]);
        assert_eq!(r.at, vec![("craft_stick".to_string(), 3), ("collect_iron".to_string(), 9)]);
        // without a scenario every entry pays, as before
        let mut r = Reward::new(&HashSet::new());
        assert_eq!(r.score(&ev("crafted", "stick"), None, &table(None), &ents, 1).0[2], 1.0);
    }
}

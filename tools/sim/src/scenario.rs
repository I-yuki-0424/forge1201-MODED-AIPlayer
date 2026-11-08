//! Scenarios: what an episode starts from, as data (docs/proposed/SCENARIO-v1.md). One JSON file per condition; `run --scenario FILE`.
//! The start kit, blocks placed around the start (clusters, stations; on the surface or buried), the hostile-mob level, what a
//! respawn gives back, and which progress entries pay (the rest are tracked, or shown as already done, but unpaid) with the reward
//! weights per term. Nothing here is specific to iron: the isolation runs of 2026-11-04 are three files in `scenarios/`.
//! Unknown keys, unknown items/blocks/entries and empty ranges are errors, so a typo cannot silently run another condition.
use crate::data::{Data, Kind};
use crate::json::{self, J};
use crate::sim::{replaceable, Rng, Sim};
use std::collections::HashSet;

#[derive(Debug)]
pub enum PreDone { No, Unscored, List(Vec<String>) }
#[derive(Debug)]
struct Place { id: String, block: u16, size: (u32, u32), buried: bool, depth: (i32, i32), dist: (f64, f64), bearing: (f64, f64) }
/// When an episode ends before the days run out (per-goal training of one expert, docs/proposed/MOE-v1.md): all of `have` held and the progress
/// `entry` reached = "success"; a death with `die` = "died"; `max_steps` commands or `max_ticks` game ticks = "timeout".
#[derive(Debug)]
pub struct End { have: Vec<(String, u32)>, entry: Option<String>, max_steps: u32, max_ticks: i64, die: bool }
#[derive(Debug)]
pub struct Scenario {
    pub id: String, kit: Vec<(String, (u32, u32))>, kit_on_death: bool, hostiles: f64, craft_slots: Option<usize>, place: Vec<Place>,
    pub score: Option<HashSet<String>>, pub pre_done: PreDone, pub weights: Vec<(String, f64)>, end: Option<End>,
}

/// Names in `end.have` that stand for a family of items (wood comes in many species): `#log` = every *_log, `#planks` = every *_planks.
const GROUPS: [&str; 2] = ["#log", "#planks"];
fn held_n(s: &Sim, n: &str) -> u32 {
    let suffix = match n { "#log" => "_log", "#planks" => "_planks", _ => return s.count(n) };
    s.held().iter().filter(|(k, _)| k.ends_with(suffix)).map(|(_, c)| *c).sum()
}
fn keys(j: &J, ok: &[&str], what: &str) -> Result<(), String> {
    if let J::Obj(v) = j { for (k, _) in v { if !ok.contains(&k.as_str()) { return Err(format!("scenario: unknown key `{}` in {}", k, what)); } } Ok(()) } else { Err(format!("scenario: {} must be an object", what)) }
}
fn range(j: &J, d: (f64, f64), what: &str) -> Result<(f64, f64), String> {
    if j.is_null() { return Ok(d); }
    let r = match j { J::Num(n) => (*n, *n), J::Arr(a) if a.len() == 2 => (a[0].f(), a[1].f()), _ => return Err(format!("scenario: {} must be a number or [lo, hi]", what)) };
    if r.0 > r.1 { Err(format!("scenario: {} is an empty range", what)) } else { Ok(r) }
}
fn ids(j: &J) -> Vec<String> { j.arr().iter().map(|x| x.s().to_string()).collect() }

impl Scenario {
    /// `entries`: the ids of the progress list (checked against `score` / `pre_done`).
    pub fn load(path: &str, d: &Data, entries: &[String]) -> Result<Scenario, String> {
        let j = json::parse(&std::fs::read_to_string(path).map_err(|e| format!("{}: {}", path, e))?)?;
        Scenario::parse(&j, d, entries)
    }
    pub fn parse(j: &J, d: &Data, entries: &[String]) -> Result<Scenario, String> {
        keys(j, &["v", "id", "doc", "kit", "on_death", "hostiles", "craft_slots", "place", "reward", "end"], "the scenario")?;
        let id = j.get("id").s().to_string();
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err("scenario: `id` is required ([A-Za-z0-9_-])".into()); }
        let mut kit = vec![];
        for (k, v) in j.get("kit").obj() {
            if d.item(k) == 0 { return Err(format!("scenario: unknown item `{}` in kit", k)); }
            // a count, or [lo, hi]: drawn at the start of every episode (a standardised start distribution, docs/proposed/MOE-v1.md); a range may start at 0
            let (lo, hi) = range(v, (1.0, 1.0), &format!("kit count of `{}`", k))?;
            if lo < 0.0 || hi < 1.0 || (matches!(v, J::Num(_)) && lo < 1.0) { return Err(format!("scenario: kit count of `{}` must be >= 1 (a range may start at 0)", k)); }
            kit.push((k.clone(), (lo as u32, hi as u32)));
        }
        let kit_on_death = match j.get("on_death").s() { "" | "empty" => false, "kit" => true, o => return Err(format!("scenario: on_death `{}` (empty|kit)", o)) };
        let hostiles = if j.get("hostiles").is_null() { 1.0 } else { j.get("hostiles").f() };
        if hostiles < 0.0 { return Err("scenario: hostiles must be >= 0".into()); }
        let craft_slots = if j.get("craft_slots").is_null() { None } else { Some(j.get("craft_slots").i().max(1) as usize) };      // the old fixed quota was 6
        let mut place = vec![];
        for p in j.get("place").arr() {
            keys(p, &["id", "block", "size", "mode", "depth", "dist", "bearing"], "a place entry")?;
            let block = d.bid(p.get("block").s());
            if block == d.unknown { return Err(format!("scenario: unknown block `{}`", p.get("block").s())); }
            let size = range(p.get("size"), (1.0, 1.0), "size")?;
            if size.0 < 1.0 { return Err("scenario: size must be >= 1".into()); }
            let buried = match p.get("mode").s() { "" | "surface" => false, "buried" => true, o => return Err(format!("scenario: mode `{}` (surface|buried)", o)) };
            let depth = range(p.get("depth"), (3.0, 6.0), "depth")?;
            let dist = range(p.get("dist"), (2.0, 4.0), "dist")?;
            let bearing = range(p.get("bearing"), (-180.0, 180.0), "bearing")?;
            place.push(Place { id: p.get("id").s().to_string(), block, size: (size.0 as u32, size.1 as u32), buried, depth: (depth.0 as i32, depth.1 as i32), dist, bearing });
        }
        let r = j.get("reward");
        if !r.is_null() { keys(r, &["score", "pre_done", "weights"], "reward")?; }
        let known = |l: &[String]| -> Result<(), String> { for x in l { if !entries.contains(x) { return Err(format!("scenario: unknown progress entry `{}`", x)); } } Ok(()) };
        let score = if r.get("score").is_null() { None } else { let l = ids(r.get("score")); known(&l)?; Some(l.into_iter().collect()) };
        let pre_done = match r.get("pre_done") { J::Null => PreDone::No, J::Str(s) if s == "unscored" => PreDone::Unscored, J::Arr(_) => { let l = ids(r.get("pre_done")); known(&l)?; PreDone::List(l) }, _ => return Err("scenario: pre_done is \"unscored\" or a list of entries".into()) };
        if matches!(pre_done, PreDone::Unscored) && score.is_none() { return Err("scenario: pre_done \"unscored\" needs `score`".into()); }
        let mut weights = vec![];
        for (k, v) in r.get("weights").obj() {
            if !["survival", "death", "progress", "invalid"].contains(&k.as_str()) { return Err(format!("scenario: unknown reward term `{}`", k)); }
            weights.push((k.clone(), v.f()));
        }
        let e = j.get("end");
        let end = if e.is_null() { None } else {
            keys(e, &["have", "entry", "max_steps", "max_ticks", "die"], "end")?;
            let mut have = vec![];
            for (k, v) in e.get("have").obj() {
                if d.item(k) == 0 && !GROUPS.contains(&k.as_str()) { return Err(format!("scenario: unknown item `{}` in end.have", k)); }
                if v.i() < 1 { return Err(format!("scenario: end.have count of `{}` must be >= 1", k)); }
                have.push((k.clone(), v.i() as u32));
            }
            let entry = if e.get("entry").is_null() { None } else { let x = e.get("entry").s().to_string(); if !entries.contains(&x) { return Err(format!("scenario: unknown progress entry `{}` in end.entry", x)); } Some(x) };
            if have.is_empty() && entry.is_none() { return Err("scenario: `end` needs `have` or `entry` (what counts as success)".into()); }
            let (max_steps, max_ticks) = (e.get("max_steps").i().max(0) as u32, e.get("max_ticks").i().max(0));
            if max_steps == 0 && max_ticks == 0 { return Err("scenario: `end` needs max_steps or max_ticks (an episode that cannot fail would never end)".into()); }
            Some(End { have, entry, max_steps, max_ticks, die: e.get("die").b() })
        };
        Ok(Scenario { id, kit, kit_on_death, hostiles, craft_slots, place, score, pre_done, weights, end })
    }

    /// How the episode ends now, if it does: "success", "died", "timeout" or "" (goes on). `steps` = commands run this episode, `reached` = progress entries reached.
    pub fn ended(&self, s: &Sim, reached: &HashSet<String>, steps: u32, died: bool) -> &'static str {
        let e = match &self.end { Some(e) => e, None => return "" };
        if e.have.iter().all(|(n, c)| held_n(s, n) >= *c) && e.entry.as_ref().map_or(true, |x| reached.contains(x)) { return "success"; }
        if died && e.die { return "died"; }
        if (e.max_steps > 0 && steps >= e.max_steps) || (e.max_ticks > 0 && s.tick >= e.max_ticks) { return "timeout"; }
        ""
    }

    /// The entries shown as reached from the first observation (not paid).
    pub fn preset(&self, entries: &[String]) -> HashSet<String> {
        match &self.pre_done {
            PreDone::No => HashSet::new(),
            PreDone::List(l) => l.iter().cloned().collect(),
            PreDone::Unscored => entries.iter().filter(|e| !self.score.as_ref().map_or(false, |s| s.contains(*e))).cloned().collect(),
        }
    }
    /// The reward stages with this scenario's weights laid over every stage.
    pub fn stages(&self, stages: &J) -> J {
        J::Obj(stages.obj().iter().map(|(n, w)| (n.clone(), J::Obj({
            let mut o: Vec<(String, J)> = w.obj().to_vec();
            for (t, x) in &self.weights { match o.iter_mut().find(|(k, _)| k == t) { Some(e) => e.1 = J::n(*x), None => o.push((t.clone(), J::n(*x))) } }
            o
        }))).collect())
    }

    fn give_kit(&self, s: &mut Sim, rng: Option<&mut Rng>) {
        let mut rng = rng;
        for (n, (lo, hi)) in &self.kit {
            let c = match rng.as_deref_mut() { Some(r) if hi > lo => lo + r.below((hi - lo + 1) as u64) as u32, _ => *lo };      // after a death (no rng): the least
            if c > 0 { s.give(n, c); }
        }
    }
    /// After a death: the scenario's kit again if it says so (the world edits stay as they are).
    pub fn respawned(&self, s: &mut Sim) { s.hostile_scale = self.hostiles; s.craft_slots = self.craft_slots; if self.kit_on_death { self.give_kit(s, None); } }

    /// Set the episode up on `s` (standing at its start): kit, mob level, a random heading, the placements. Err = this start cannot
    /// host the scenario (nothing reachable at that distance); the caller tries another site. Returns the record for events.jsonl.
    pub fn start(&self, s: &mut Sim, rng: &mut Rng) -> Result<J, String> {
        s.hostile_scale = self.hostiles; s.craft_slots = self.craft_slots;
        s.yaw = rng.f() * std::f64::consts::TAU;
        self.give_kit(s, Some(rng));
        let st = s.pos;
        let far = self.place.iter().map(|p| p.dist.1).fold(0.0, f64::max);
        let walk: HashSet<[i32; 3]> = s.flood_n(80_000, far.ceil() as i32 + 6).nodes.into_iter().collect();
        let mut rec = vec![];
        for p in &self.place {
            let cells = (0..80).find_map(|_| self.try_place(s, rng, &walk, p)).ok_or_else(|| format!("no room for `{}` at distance {:?}", p.id, p.dist))?;
            for c in &cells { s.set(c[0], c[1], c[2], p.block); }
            let d = cells.iter().map(|c| (((c[0] - st[0]) as f64).powi(2) + ((c[2] - st[2]) as f64).powi(2)).sqrt()).fold(f64::MAX, f64::min);
            rec.push((p.id.as_str(), J::o(vec![("block", J::st(&s.d.block(p.block).name)), ("dist", J::n((d * 10.0).round() / 10.0)),
                ("cells", J::Arr(cells.iter().map(|c| J::nums(&[c[0] as f64, c[1] as f64, c[2] as f64])).collect()))])));
        }
        Ok(J::o(vec![("event", J::st("scenario")), ("scenario", J::st(&self.id)), ("yaw", J::n((s.yaw * 1000.0).round() / 1000.0)), ("start", J::nums(&[st[0] as f64, st[1] as f64, st[2] as f64])), ("place", J::o(rec))]))
    }

    fn try_place(&self, s: &Sim, rng: &mut Rng, walk: &HashSet<[i32; 3]>, p: &Place) -> Option<Vec<[i32; 3]>> {
        let st = s.pos;
        let d = p.dist.0 + rng.f() * (p.dist.1 - p.dist.0);
        let a = s.yaw + (p.bearing.0 + rng.f() * (p.bearing.1 - p.bearing.0)).to_radians();      // the heading convention of Sim::look_at
        let (x, z) = (st[0] + (-a.sin() * d).round() as i32, st[2] + (-a.cos() * d).round() as i32);
        let y = s.find_stand(x, z, st[1])?;
        let below = s.name(x, y - 1, z);
        if !walk.contains(&[x, y, z]) || below.ends_with("_leaves") || below.ends_with("_log") || below.contains("water") || below.contains("lava") || below.contains("ice") || apart(st, [x, y, z]) < 2 { return None; }
        let n = p.size.0 + rng.below((p.size.1 - p.size.0 + 1) as u64) as u32;
        let mut cells = vec![if p.buried { [x, y - rng_in(rng, p.depth), z] } else { [x, y, z] }];
        let free = |c: [i32; 3]| if p.buried { s.kind(c[0], c[1], c[2]) == Kind::Solid && s.name(c[0], c[1], c[2]) != "bedrock" && c[1] < y - 1 }
            else { replaceable(s.name(c[0], c[1], c[2])) && c[1] <= y + 1 && s.kind(c[0], c[1] - 1, c[2]) == Kind::Solid && apart(st, c) >= 2 };
        if p.buried && !free(cells[0]) { return None; }
        let dirs: &[[i32; 3]] = if p.buried { &[[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] } else { &[[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] };
        for _ in 0..80 {
            if cells.len() as u32 >= n { break; }
            let c = cells[rng.below(cells.len() as u64) as usize];
            let dv = dirs[rng.below(dirs.len() as u64) as usize];
            let nb = [c[0] + dv[0], c[1] + dv[1], c[2] + dv[2]];
            // on the surface a block may also stand on a cluster block (dv up), elsewhere it needs ground under it
            let ok = if p.buried { free(nb) } else { replaceable(s.name(nb[0], nb[1], nb[2])) && c[1] <= y && (dv[1] == 1 || free(nb)) && apart(st, nb) >= 2 };
            if ok && !cells.contains(&nb) { cells.push(nb); }
        }
        if (cells.len() as u32) < p.size.0.min(n) { return None; }
        Some(cells)
    }
}
/// Blocks between two cells horizontally (Chebyshev): clusters keep two clear of the start so they never box the bot in.
fn apart(a: [i32; 3], b: [i32; 3]) -> i32 { (a[0] - b[0]).abs().max((a[2] - b[2]).abs()) }
fn rng_in(rng: &mut Rng, r: (i32, i32)) -> i32 { r.0 + rng.below((r.1 - r.0 + 1) as u64) as i32 }

/// Entry ids of a progress list (`entries` of src/rl/progress-list.json), for `Scenario::load`.
pub fn entry_ids(pj: &J) -> Vec<String> { pj.get("entries").arr().iter().map(|e| e.get("id").s().to_string()).collect() }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::tests::flat_sized;
    use crate::sim::{Ev, Sim};
    use std::rc::Rc;

    fn scn(src: &str, d: &Data) -> Result<Scenario, String> {
        let ent: Vec<String> = ["collect_iron", "smelt_iron", "craft_iron_pickaxe", "eat_food"].iter().map(|x| x.to_string()).collect();
        Scenario::parse(&json::parse(src).unwrap(), d, &ent)
    }
    const KIT: &str = r#""kit":{"cobblestone":64,"stone_pickaxe":2,"stick":64,"crafting_table":5,"coal":8}"#;
    fn dist(a: [i32; 3], b: [i32; 3]) -> f64 { (((a[0] - b[0]) as f64).powi(2) + ((a[2] - b[2]) as f64).powi(2)).sqrt() }
    fn cells(s: &Sim, block: &str, r: i32) -> Vec<[i32; 3]> {
        let (b, c) = (s.d.bid(block), s.pos);
        let mut v = vec![];
        for x in c[0] - r..=c[0] + r { for z in c[2] - r..=c[2] + r { for y in 56..=70 { if s.blk(x, y, z) == Some(b) && s.edits.contains_key(&(x, y, z)) { v.push([x, y, z]); } } } }
        v
    }

    #[test]
    fn kit_counts_may_be_ranges_drawn_per_episode_and_a_range_may_start_at_zero() {
        let d = Rc::new(Data::load());
        assert!(scn(r#"{"id":"a","kit":{"stick":0}}"#, &d).is_err(), "a plain count of 0 is still an error");
        assert!(scn(r#"{"id":"a","kit":{"stick":[3,1]}}"#, &d).unwrap_err().contains("empty range"));
        assert!(scn(r#"{"id":"a","kit":{"stick":[0,0]}}"#, &d).is_err());
        let sc = scn(r#"{"id":"r","kit":{"stick":[0,4],"cobblestone":[10,12],"coal":3}}"#, &d).unwrap();
        let (mut sticks, mut seen_zero, mut seen_four) = (std::collections::HashSet::new(), false, false);
        for seed in 1..80u64 {
            let mut s = flat_sized(9); let mut rng = Rng(seed * 104729 | 1);
            sc.start(&mut s, &mut rng).unwrap();
            let (st, co, cl) = (s.count("stick"), s.count("cobblestone"), s.count("coal"));
            assert!(st <= 4 && (10..=12).contains(&co) && cl == 3, "seed {} stick {} cobble {} coal {}", seed, st, co, cl);
            sticks.insert(st); seen_zero |= st == 0; seen_four |= st == 4;
        }
        assert!(seen_zero && seen_four && sticks.len() == 5, "the whole range is drawn: {:?}", sticks);
    }

    #[test]
    fn an_end_condition_needs_a_goal_and_a_limit_and_names_are_checked() {
        let d = Data::load();
        assert!(scn(r#"{"id":"a","end":{"max_steps":5}}"#, &d).unwrap_err().contains("have"));
        assert!(scn(r#"{"id":"a","end":{"have":{"stick":1}}}"#, &d).unwrap_err().contains("max_steps"));
        assert!(scn(r#"{"id":"a","end":{"have":{"stickk":1},"max_steps":5}}"#, &d).unwrap_err().contains("stickk"));
        assert!(scn(r#"{"id":"a","end":{"entry":"nope","max_steps":5}}"#, &d).unwrap_err().contains("nope"));
        assert!(scn(r#"{"id":"a","end":{"have":{"stick":0},"max_steps":5}}"#, &d).is_err());
        assert!(scn(r#"{"id":"a","end":{"have":{"stick":1},"max_steps":5,"typo":1}}"#, &d).unwrap_err().contains("typo"));
        assert!(scn(r#"{"id":"a","end":{"have":{"stick":1},"entry":"eat_food","max_ticks":100,"die":true}}"#, &d).is_ok());
    }

    #[test]
    fn an_episode_ends_in_success_when_the_goal_is_held_and_in_timeout_or_death_otherwise() {
        let d = Rc::new(Data::load());
        let sc = scn(r#"{"id":"e","end":{"have":{"stick":2},"entry":"eat_food","max_steps":10,"max_ticks":500,"die":true}}"#, &d).unwrap();
        let mut s = flat_sized(9);
        let none: HashSet<String> = HashSet::new(); let ate: HashSet<String> = ["eat_food".to_string()].into_iter().collect();
        assert_eq!(sc.ended(&s, &none, 1, false), "", "nothing held, early: goes on");
        s.give("stick", 2);
        assert_eq!(sc.ended(&s, &none, 1, false), "", "the item without the entry is not the goal");
        assert_eq!(sc.ended(&s, &ate, 1, false), "success");
        assert_eq!(sc.ended(&s, &ate, 99, true), "success", "success wins over a late death and the step limit");
        let grp = scn(r##"{"id":"g","end":{"have":{"#log":3},"max_steps":5}}"##, &d).unwrap();
        let mut u = flat_sized(9); u.give("oak_log", 2); assert_eq!(grp.ended(&u, &none, 1, false), "", "two logs of one species are not three");
        u.give("birch_log", 1); assert_eq!(grp.ended(&u, &none, 1, false), "success", "species are summed");
        let mut t = flat_sized(9);
        assert_eq!(sc.ended(&t, &none, 10, false), "timeout");
        assert_eq!(sc.ended(&t, &none, 3, true), "died");
        t.tick = 500; assert_eq!(sc.ended(&t, &none, 3, false), "timeout");
        let plain = scn(r#"{"id":"p"}"#, &d).unwrap();
        assert_eq!(plain.ended(&t, &ate, 1000, true), "", "no end block: the days decide, as before");
        let nodie = scn(r#"{"id":"n","end":{"have":{"stick":1},"max_steps":5}}"#, &d).unwrap();
        assert_eq!(nodie.ended(&t, &none, 2, true), "", "a death does not end it without `die`");
    }

    #[test]
    fn typos_and_unknown_names_are_errors() {
        let d = Data::load();
        assert!(scn(r#"{"id":"a","kitt":{}}"#, &d).unwrap_err().contains("kitt"));
        assert!(scn(r#"{"id":"a","kit":{"cobblestone_":3}}"#, &d).is_err());
        assert!(scn(r#"{"id":"a","place":[{"id":"i","block":"iron_ore","dist":[5,2]}]}"#, &d).unwrap_err().contains("empty range"));
        assert!(scn(r#"{"id":"a","reward":{"score":["collect_irn"]}}"#, &d).unwrap_err().contains("collect_irn"));
        assert!(scn(r#"{"id":"a","reward":{"pre_done":"unscored"}}"#, &d).is_err());
        assert!(scn(r#"{"id":"a","reward":{"weights":{"iron":1}}}"#, &d).is_err());
        assert!(scn(r#"{"id":"a","place":[{"id":"i","block":"iron_ore","size":0}]}"#, &d).is_err());
    }

    #[test]
    fn an_outcrop_of_three_or_more_stands_in_front_within_the_distance_and_can_be_mined() {
        let d = Rc::new(Data::load());
        let sc = scn(&format!(r#"{{"id":"a",{},"place":[{{"id":"iron","block":"iron_ore","size":[3,5],"dist":[2,3],"bearing":[-15,15]}}]}}"#, KIT), &d).unwrap();
        for seed in 1..40u64 {
            let mut s = flat_sized(9); s.rng = Rng(seed * 7919 | 1);
            let mut rng = Rng(seed * 104729 | 1);
            let rec = sc.start(&mut s, &mut rng).unwrap();
            let iron = cells(&s, "iron_ore", 6);
            assert!(iron.len() >= 3 && iron.len() <= 5, "seed {} size {}", seed, iron.len());
            let near = iron.iter().map(|c| dist(*c, s.pos)).fold(f64::MAX, f64::min);
            assert!(near >= 2.0 && near <= 3.6, "seed {} nearest {}", seed, near);
            // in front: the nearest cell lies within 15 degrees (+ rounding) of the heading
            let c = iron.iter().min_by(|a, b| dist(**a, s.pos).partial_cmp(&dist(**b, s.pos)).unwrap()).unwrap();
            let ang = (-(c[0] - s.pos[0]) as f64).atan2(-(c[2] - s.pos[2]) as f64) - s.yaw;
            assert!(ang.sin().atan2(ang.cos()).abs().to_degrees() <= 45.0, "seed {} bearing {}", seed, ang.to_degrees());
            assert_eq!(rec.get("place").get("iron").get("cells").arr().len(), iron.len());
            // connected (4-neighbourhood plus stacking), and all of it reachable to a miner with the kit's stone pickaxe
            let mut seen = vec![iron[0]]; let mut grew = true;
            while grew { grew = false; for c in &iron { if !seen.contains(c) && seen.iter().any(|q| (q[0] - c[0]).abs() + (q[1] - c[1]).abs() + (q[2] - c[2]).abs() == 1) { seen.push(*c); grew = true; } } }
            assert_eq!(seen.len(), iron.len(), "seed {} not connected", seed);
            assert_eq!((s.count("cobblestone"), s.count("stone_pickaxe"), s.count("stick"), s.count("crafting_table"), s.count("coal")), (64, 2, 64, 5, 8));
        }
    }

    #[test]
    fn the_chain_can_be_played_end_to_end_from_the_kit() {
        // mine the cluster, place a furnace, smelt every ore, craft the pickaxe at a placed table: the preconditions of A are enough
        let d = Rc::new(Data::load());
        let sc = scn(&format!(r#"{{"id":"a",{},"place":[{{"id":"iron","block":"iron_ore","size":3,"dist":[2,3],"bearing":[-10,10]}}]}}"#, KIT), &d).unwrap();
        let mut s = flat_sized(9); let mut rng = Rng(5);
        sc.start(&mut s, &mut rng).unwrap();
        let mut evs: Vec<Ev> = vec![];
        for c in cells(&s, "iron_ore", 6) { let o = s.do_mine(c); assert!(o.ok, "mine {:?}: {}", c, o.reason); evs.extend(o.ev); }
        assert_eq!(s.count("raw_iron"), 3);
        s.give("furnace", 1);
        let spot = |s: &Sim, k: i32| [s.pos[0] + k, s.pos[1], s.pos[2]];
        let f = spot(&s, 1); assert!(s.do_place(f, "furnace").ok);
        for _ in 0..3 { let o = s.do_smelt("raw_iron", f); assert!(o.ok, "{}", o.reason); }
        assert_eq!((s.count("iron_ingot"), s.count("crafting_table"), s.count("stick")), (3, 5, 64));
        let t = spot(&s, -1); assert!(s.do_place(t, "crafting_table").ok);
        let o = s.do_craft("iron_pickaxe", Some(t)); assert!(o.ok, "{}", o.reason);
        assert_eq!(s.count("iron_pickaxe"), 1);
    }

    #[test]
    fn a_furnace_fifty_blocks_away_is_walkable_and_buried_ore_needs_digging() {
        let d = Rc::new(Data::load());
        let sc = scn(&format!(r#"{{"id":"c",{},"hostiles":0,"place":[{{"id":"furnace","block":"furnace","dist":[49,51]}},{{"id":"iron","block":"iron_ore","size":[3,4],"mode":"buried","depth":[3,5],"dist":[8,12]}}]}}"#, KIT), &d).unwrap();
        let mut s = flat_sized(9); let mut rng = Rng(11);
        sc.start(&mut s, &mut rng).unwrap();
        assert_eq!(s.hostile_scale, 0.0);
        let f = cells(&s, "furnace", 60);
        assert_eq!(f.len(), 1); let df = dist(f[0], s.pos); assert!((48.5..=51.5).contains(&df), "{}", df);
        let iron = cells(&s, "iron_ore", 20);
        assert!(iron.len() >= 3 && iron.iter().all(|c| c[1] < 63 && c[1] >= 54), "{:?}", iron);
        // not offered while buried (no face is open)
        let cand = crate::obs::candidates(&mut s);
        assert!(!cand.iter().any(|c| matches!(&c.args, crate::obs::Args::Mine(p) if iron.contains(p))));
        // the furnace is outside the 18-block flood the candidates are made from: no smelt candidate, as in the real environment, until
        // the policy has walked there with move_to (16-block steps); then the command works
        s.give("raw_iron", 1);
        assert!(!cand.iter().any(|c| matches!(c.args, crate::obs::Args::Smelt(..))));
        let (mut walked, mut hops) = (0i64, 0);
        while dist(s.pos, f[0]) > 10.0 && hops < 8 {
            let to = crate::obs::candidates(&mut s).iter().filter_map(|c| match &c.args { crate::obs::Args::Move(t) => Some(*t), _ => None })
                .min_by(|a, b| dist(*a, f[0]).partial_cmp(&dist(*b, f[0])).unwrap()).unwrap();
            let o = s.do_move(to); assert!(o.ok, "{}", o.reason); walked += o.ticks; hops += 1;
        }
        assert!(hops >= 3 && hops <= 5 && walked > 40 * 4, "hops {} ticks {}", hops, walked);
        assert!(crate::obs::candidates(&mut s).iter().any(|c| matches!(c.args, crate::obs::Args::Smelt(..))));
        let o = s.do_smelt("raw_iron", f[0]); assert!(o.ok, "{}", o.reason);
    }

    #[test]
    fn the_kit_comes_back_after_a_death_only_when_asked_and_hostiles_scale_the_spawn() {
        let d = Rc::new(Data::load());
        let keep = scn(&format!(r#"{{"id":"k",{},"on_death":"kit","hostiles":0}}"#, KIT), &d).unwrap();
        let gone = scn(&format!(r#"{{"id":"g",{}}}"#, KIT), &d).unwrap();
        let (mut a, mut b) = (flat_sized(3), flat_sized(3));
        keep.start(&mut a, &mut Rng(3)).unwrap(); gone.start(&mut b, &mut Rng(3)).unwrap();
        a.respawn(); keep.respawned(&mut a); b.respawn(); gone.respawned(&mut b);
        assert_eq!((a.count("coal"), a.count("stone_pickaxe"), b.count("coal"), a.hostile_scale, b.hostile_scale), (8, 2, 0, 0.0, 1.0));
        // a night on open ground: the default level spawns hostiles, scale 0 spawns none
        let (mut z, mut n) = (0, 0);
        for seed in 1..6u64 { for scale in [1.0, 0.0] {
            let mut s = flat_sized(9); s.rng = Rng(seed * 31 | 1); s.hostile_scale = scale; s.tick = 14000;
            let mut ev = vec![]; s.advance(20 * 60 * 5, &mut ev);
            if scale == 0.0 { z += s.mobs.iter().filter(|m| m.hostile).count(); } else { n += s.mobs.iter().filter(|m| m.hostile).count(); }
        } }
        assert!(z == 0 && n > 0, "scale 0: {} hostiles, scale 1: {}", z, n);
    }

    #[test]
    fn the_iron_pickaxe_is_offered_when_it_can_be_crafted_however_much_else_can_be() {
        // Found 2026-11-04 by the scripted solver (0 of 23 pickaxes with 3 ingots, 64 sticks and a table in reach): the craft candidates were cut to a
        // quota of 6 in "not held first, then alphabetical" order, so with stone and sticks in the pack `iron_pickaxe` never made the list.
        let d = Rc::new(Data::load());
        let sc = scn(&format!(r#"{{"id":"a",{},"place":[]}}"#, KIT), &d).unwrap();
        let mut s = flat_sized(3);
        sc.start(&mut s, &mut Rng(1)).unwrap();
        s.give("iron_ingot", 3);
        let t = [s.pos[0] + 1, s.pos[1], s.pos[2]];
        assert!(s.do_place(t, "crafting_table").ok);
        let crafts: Vec<String> = crate::obs::candidates(&mut s).iter().filter_map(|c| match &c.args { crate::obs::Args::Craft(n, _) => Some(n.clone()), _ => None }).collect();
        assert!(crafts.iter().any(|n| n == "iron_pickaxe"), "craft candidates offered: {:?} of {} craftable", crafts, s.craftable(true).len());
    }

    #[test]
    fn the_furnace_the_table_and_raw_iron_are_offered_however_full_the_pack_is() {
        // Found 2026-11-05 by the presentation audit (docs/proposed/SCENARIO-v1.md): `place` listed 3 and `smelt` 2 held items in pack-slot order, so at normal
        // starts the crafting table was hidden in 42 % of the steps it was held, the furnace in 16 %, raw iron in 56 % of those it could be smelted.
        let d = Rc::new(Data::load());
        let sc = scn(&format!(r#"{{"id":"a",{},"place":[]}}"#, KIT), &d).unwrap();
        let mut s = flat_sized(3);
        sc.start(&mut s, &mut Rng(1)).unwrap();
        for it in ["oak_log", "sand", "birch_planks", "dirt", "gravel", "torch", "chest", "stone"] { s.give(it, 4); }
        s.give("furnace", 1);
        let f = [s.pos[0], s.pos[1], s.pos[2] + 1];
        assert!(s.do_place(f, "furnace").ok);          // a furnace in reach (the bot holds none now), then another one and the iron last in the pack
        s.give("furnace", 1); s.give("raw_iron", 3);
        let c = crate::obs::candidates(&mut s);
        let place: Vec<String> = c.iter().filter_map(|c| match &c.args { crate::obs::Args::Place(_, n) => Some(n.clone()), _ => None }).collect();
        let smelt: Vec<String> = c.iter().filter_map(|c| match &c.args { crate::obs::Args::Smelt(n, _) => Some(n.clone()), _ => None }).collect();
        assert!(place.iter().any(|n| n == "furnace") && place.iter().any(|n| n == "crafting_table"), "place offered: {:?}", place);
        assert_eq!(smelt.first().map(|x| x.as_str()), Some("raw_iron"), "smelt offered: {:?}", smelt);
    }

    #[test]
    fn an_ore_seen_12_blocks_ahead_is_offered_as_a_move_with_its_item() {
        // Scenario B (2026-11-05): the ore 10-16 blocks away and not in front was reached in 67 % of the episodes (98 % in front); move_to had world-axis headings only.
        let d = Rc::new(Data::load());
        let ore = d.item("iron_ore");
        let sc = scn(r#"{"id":"b","place":[{"id":"iron","block":"iron_ore","size":[5,5],"dist":[12,12],"bearing":[0,0]}]}"#, &d).unwrap();
        let mut s = flat_sized(3);
        sc.start(&mut s, &mut Rng(1)).unwrap();
        let c = crate::obs::candidates(&mut s);
        let ap: Vec<_> = c.iter().filter(|c| matches!(c.args, crate::obs::Args::Move(_)) && c.item == ore).collect();
        assert_eq!(ap.len(), 1, "approach candidates for iron_ore: {} of {} candidates", ap.len(), c.len());
        // the same world seen from the other way round: the bot faces away, nothing is offered
        s.yaw += std::f64::consts::PI;
        let back = crate::obs::candidates(&mut s);
        assert!(!back.iter().any(|c| matches!(c.args, crate::obs::Args::Move(_)) && c.item == ore), "the ore behind the bot must not be offered");
        assert!(c.len() <= crate::obs::K && c.iter().filter(|c| matches!(c.args, crate::obs::Args::Wait)).count() == 1);
    }

    #[test]
    fn crafts_that_burn_iron_without_a_progress_entry_are_not_offered() {
        // 2026-11-05: at normal starts a nugget craft ended the one or two ingots of an episode (502 nugget crafts in 270 smelting episodes of normal-kit).
        let d = Rc::new(Data::load());
        let sc = scn(&format!(r#"{{"id":"a",{},"place":[]}}"#, KIT), &d).unwrap();
        let mut s = flat_sized(3);
        sc.start(&mut s, &mut Rng(1)).unwrap();
        s.give("iron_ingot", 9);
        let t = [s.pos[0] + 1, s.pos[1], s.pos[2]];
        assert!(s.do_place(t, "crafting_table").ok);
        let offered = |s: &mut Sim| -> Vec<String> { crate::obs::candidates(s).iter().filter_map(|c| match &c.args { crate::obs::Args::Craft(n, _) => Some(n.clone()), _ => None }).collect() };
        let c = offered(&mut s);
        for sink in ["iron_nugget", "iron_shovel", "iron_hoe", "iron_axe", "bucket", "shears", "iron_helmet", "iron_block", "shield"] { assert!(!c.iter().any(|n| n == sink), "{} offered: {:?}", sink, c); }
        assert!(c.iter().any(|n| n == "iron_pickaxe") && c.iter().any(|n| n == "iron_sword"), "offered: {:?}", c);
        assert!(s.craftable(true).iter().any(|n| n == "iron_nugget"), "the sink is still a legal craft, just not offered");
    }

    #[test]
    fn stages_take_the_scenario_weights_and_the_preset_marks_the_unpaid_entries_done() {
        let d = Data::load();
        let sc = scn(r#"{"id":"w","reward":{"score":["collect_iron","smelt_iron"],"pre_done":"unscored","weights":{"survival":0,"death":0,"invalid":0}}}"#, &d).unwrap();
        let ent: Vec<String> = ["collect_iron", "smelt_iron", "craft_iron_pickaxe", "eat_food"].iter().map(|x| x.to_string()).collect();
        let mut p: Vec<String> = sc.preset(&ent).into_iter().collect(); p.sort();
        assert_eq!(p, vec!["craft_iron_pickaxe", "eat_food"]);
        let st = sc.stages(&json::parse(r#"{"days":{"survival":1,"death":1,"progress":1,"invalid":1}}"#).unwrap());
        assert_eq!(st.dump(), r#"{"days":{"survival":0,"death":0,"progress":1,"invalid":0}}"#);
    }
}

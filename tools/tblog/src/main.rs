//! forgeaip-tblog: the learning-status record of an RL training run, in formats anyone can open.
//!   forgeaip-tblog --dir exchange/<base>/train [--out exchange/<base>/tb] [--follow] [--block 60]
//! Reads `train_log.jsonl` (one row per learner update) and `episodes.jsonl` (one row per finished episode) and writes
//!   events.out.tfevents.0.forgeaip  TensorBoard scalars (tensorboard --logdir exchange/<base>/tb); x-axis = env steps
//!   metrics.csv                     the same as long format wall_time,step,tag,value (pandas, spreadsheet, anything)
//!   status.json                     the verdict (see `verdict`) and the health flags, rewritten on every pass
//! No dependency: CRC-32C, the TFRecord framing and the three protobuf messages TensorBoard reads are written here.
#[path = "../../sim/src/json.rs"]
#[allow(dead_code)]
mod json;
use json::J;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

// ---- TensorBoard event file ----
fn crc32c(d: &[u8]) -> u32 {
    let mut t = [0u32; 256];
    for i in 0..256u32 { let mut c = i; for _ in 0..8 { c = if c & 1 != 0 { (c >> 1) ^ 0x82F6_3B78 } else { c >> 1 }; } t[i as usize] = c; }
    !d.iter().fold(!0u32, |c, &b| t[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8))
}
fn masked(d: &[u8]) -> u32 { crc32c(d).rotate_right(15).wrapping_add(0xa282_ead8) }
fn varint(mut v: u64, o: &mut Vec<u8>) { while v >= 0x80 { o.push((v as u8) | 0x80); v >>= 7; } o.push(v as u8); }
fn field_len(tag: u8, body: &[u8], o: &mut Vec<u8>) { o.push(tag); varint(body.len() as u64, o); o.extend_from_slice(body); }
/// Event{wall_time, step, summary{value{tag, simple_value}}}
fn scalar_event(wall: f64, step: i64, tag: &str, v: f32) -> Vec<u8> {
    let mut val = Vec::new(); field_len(0x0a, tag.as_bytes(), &mut val); val.push(0x15); val.extend_from_slice(&v.to_le_bytes());
    let mut sum = Vec::new(); field_len(0x0a, &val, &mut sum);
    let mut e = vec![0x09]; e.extend_from_slice(&wall.to_le_bytes()); e.push(0x10); varint(step as u64, &mut e); field_len(0x2a, &sum, &mut e);
    e
}
fn record(o: &mut impl Write, data: &[u8]) -> std::io::Result<()> {
    let len = (data.len() as u64).to_le_bytes();
    o.write_all(&len)?; o.write_all(&masked(&len).to_le_bytes())?; o.write_all(data)?; o.write_all(&masked(data).to_le_bytes())
}

struct Sink { tb: File, csv: File }
impl Sink {
    fn new(out: &Path) -> std::io::Result<Sink> {
        fs::create_dir_all(out)?;
        let mut tb = File::create(out.join("events.out.tfevents.0.forgeaip"))?;
        let mut v = vec![0x09]; v.extend_from_slice(&0f64.to_le_bytes()); field_len(0x1a, b"brain.Event:2", &mut v);
        record(&mut tb, &v)?;
        let mut csv = File::create(out.join("metrics.csv"))?; csv.write_all(b"wall_time,step,tag,value\n")?;
        Ok(Sink { tb, csv })
    }
    fn put(&mut self, wall: f64, step: i64, tag: &str, v: f64) {
        if !v.is_finite() { return; }
        let _ = record(&mut self.tb, &scalar_event(wall, step, tag, v as f32));
        let _ = writeln!(self.csv, "{:.3},{},{},{}", wall, step, tag, v);
    }
    fn flush(&mut self) { let _ = self.tb.flush(); let _ = self.csv.flush(); }
}

// ---- reading the logs ----
struct Tail { path: PathBuf, off: u64 }
impl Tail {
    /// New complete lines since the last call (a half-written last line waits for the next pass).
    fn lines(&mut self) -> Vec<J> {
        let Ok(mut f) = File::open(&self.path) else { return vec![] };
        if f.metadata().map(|m| m.len()).unwrap_or(0) < self.off { self.off = 0; }
        let _ = f.seek(SeekFrom::Start(self.off));
        let mut r = BufReader::new(f);
        let mut out = vec![];
        loop {
            let mut s = String::new();
            match r.read_line(&mut s) { Ok(0) | Err(_) => break, Ok(n) => { if !s.ends_with('\n') { break; } self.off += n as u64;
                // Python writes NaN / Infinity, which is not JSON: they become null (the value is skipped).
                let s = s.replace("-Infinity", "null").replace("Infinity", "null").replace("NaN", "null");
                if let Ok(j) = json::parse(s.trim()) { out.push(j); } } }
        }
        out
    }
}
/// Numeric leaves of an object as ("a/b", value); arrays and strings are skipped.
fn flatten(prefix: &str, j: &J, out: &mut Vec<(String, f64)>) {
    for (k, v) in j.obj() {
        let name = if prefix.is_empty() { k.clone() } else { format!("{}/{}", prefix, k) };
        match v { J::Num(n) => out.push((name, *n)), J::Bool(b) => out.push((name, *b as u8 as f64)), J::Obj(_) => flatten(&name, v, out), _ => {} }
    }
}

// ---- the verdict ----
#[derive(Default)]
struct Series { v: Vec<f64> }
fn mean_se(x: &[f64]) -> (f64, f64) {
    let n = x.len() as f64; if n < 2.0 { return (x.first().copied().unwrap_or(0.0), f64::INFINITY); }
    let m = x.iter().sum::<f64>() / n; let var = x.iter().map(|a| (a - m) * (a - m)).sum::<f64>() / (n - 1.0);
    (m, (var / n).sqrt())
}
/// Pre-registered rule (docs/proposed/TRAIN-STATUS-v1.md): episodes are cut into blocks of `block`; block k is better than block j
/// when its mean exceeds the other's by z >= 2 combined standard errors. The verdict is on `progress` (entries of the progress
/// list reached per episode), the quantity the training is for.
///   learning   the last block beats the one two blocks earlier (z >= 2)
///   regressing the last block is worse than the one two blocks earlier (z <= -2)
///   stalled    neither, and no block of the last three beat the earlier best by z >= 2: stop and rethink the design
///   warming    fewer than 4 full blocks so far
fn verdict(prog: &[f64], block: usize) -> (String, Vec<(f64, f64)>, f64) {
    let blocks: Vec<(f64, f64)> = prog.chunks(block).filter(|c| c.len() == block).map(mean_se).collect();
    let z = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0) / (a.1 * a.1 + b.1 * b.1).sqrt().max(1e-9);
    let n = blocks.len();
    if n < 4 { return ("warming".into(), blocks, 0.0); }
    let zl = z(blocks[n - 1], blocks[n - 3]);
    let best_before = blocks[..n - 3].iter().copied().fold(blocks[0], |a, b| if b.0 > a.0 { b } else { a });
    let beat = blocks[n - 3..].iter().any(|&b| z(b, best_before) >= 2.0);
    let v = if zl >= 2.0 { "learning" } else if zl <= -2.0 { "regressing" } else if beat { "learning" } else { "stalled" };
    (v.into(), blocks, zl)
}

fn run(dir: &Path, out: &Path, follow: bool, block: usize) -> std::io::Result<()> {
    let mut sink = Sink::new(out)?;
    let (mut upd, mut epi) = (Tail { path: dir.join("train_log.jsonl"), off: 0 }, Tail { path: dir.join("episodes.jsonl"), off: 0 });
    let mut steps_at: Vec<(f64, i64)> = vec![];       // (wall time, total steps) of every update, to place an episode on the step axis
    let mut ser: HashMap<&str, Series> = HashMap::new();
    let mut last_upd: Vec<HashMap<String, f64>> = vec![];
    let mut n_upd = 0usize;
    loop {
        for r in upd.lines() {
            if r.get("event").s() != "update" { continue; }
            let (t, step) = (r.get("t").f(), r.get("total_steps").i());
            steps_at.push((t, step)); n_upd += 1;
            let mut kv = vec![]; flatten("", &r, &mut kv);
            let mut row = HashMap::new();
            for (k, v) in kv { if k == "t" || k == "total_steps" { continue; } sink.put(t, step, &format!("train/{}", k), v); row.insert(k, v); }
            if steps_at.len() > 1 { let (t0, s0) = steps_at[steps_at.len() - 2]; if t > t0 { sink.put(t, step, "rate/env_steps_per_s", (step - s0) as f64 / (t - t0)); } }
            last_upd.push(row); if last_upd.len() > 10 { last_upd.remove(0); }
        }
        for r in epi.lines() {
            let t = r.get("t").f();
            let step = steps_at.iter().rev().find(|(tu, _)| *tu <= t).map(|x| x.1).unwrap_or(0);
            let mut kv = vec![]; flatten("", &r, &mut kv);
            for (k, v) in kv { if matches!(k.as_str(), "t" | "env_id" | "episode" | "pair" | "shard") { continue; } sink.put(t, step, &format!("episode/{}", k), v); }
            let p = r.get("terms").get("progress").f();
            ser.entry("progress").or_default().v.push(p);
            ser.entry("deaths").or_default().v.push(r.get("deaths").f());
            ser.entry("return").or_default().v.push(r.get("return_task").f());
        }
        sink.flush();
        let empty = Series::default();
        let prog = &ser.get("progress").unwrap_or(&empty).v;
        let (v, blocks, zl) = verdict(prog, block);
        let avg = |k: &str| { let xs: Vec<f64> = last_upd.iter().filter_map(|m| m.get(k).copied()).collect(); if xs.is_empty() { None } else { Some(xs.iter().sum::<f64>() / xs.len() as f64) } };
        // Health of the optimisation over the last 10 updates; each flag names the number it rests on.
        let mut flags: Vec<J> = vec![];
        let mut flag = |cond: bool, msg: String| if cond { flags.push(J::Str(msg)); };
        if let Some(e) = avg("ent") { flag(e < 0.5, format!("policy entropy {:.2} < 0.5: collapsed onto few actions", e)); }
        if let Some(c) = avg("clipfrac") { flag(c > 0.3, format!("clipfrac {:.2} > 0.3: updates leave the trust region (lr too high or data too stale)", c)); }
        if let Some(k) = avg("kl") { flag(k > 0.05, format!("kl {:.3} > 0.05 between behaviour and updated policy", k)); }
        if let Some(e) = avg("expl_var") { flag(e < 0.1, format!("value explained variance {:.2} < 0.1: the critic predicts returns no better than their mean", e)); }
        if let Some(s) = avg("staleness_mean") { flag(s > 6.0, format!("data is {:.1} updates old on average", s)); }
        let d = &ser.get("deaths").unwrap_or(&empty).v;
        let status = J::o(vec![("verdict", J::st(&v)), ("episodes", J::n(prog.len() as f64)), ("updates", J::n(n_upd as f64)), ("block", J::n(block as f64)),
            ("progress_blocks", J::Arr(blocks.iter().map(|b| J::nums(&[b.0, b.1])).collect())), ("z_last_vs_two_blocks_earlier", J::n(zl)),
            ("deaths_per_episode_last_block", J::n(d.iter().rev().take(block).sum::<f64>() / d.len().min(block).max(1) as f64)),
            ("last_total_steps", J::n(steps_at.last().map(|x| x.1).unwrap_or(0) as f64)), ("flags", J::Arr(flags))]);
        fs::write(out.join("status.json.tmp"), status.dump() + "\n")?;
        fs::rename(out.join("status.json.tmp"), out.join("status.json"))?;
        if !follow { println!("{}", status.dump()); return Ok(()); }
        std::thread::sleep(std::time::Duration::from_secs(20));
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let get = |k: &str| a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).cloned();
    let Some(dir) = get("--dir") else { eprintln!("usage: forgeaip-tblog --dir exchange/<base>/train [--out DIR] [--follow] [--block 60]"); std::process::exit(2) };
    let out = get("--out").map(PathBuf::from).unwrap_or_else(|| Path::new(&dir).join("../tb"));
    let block = get("--block").and_then(|b| b.parse().ok()).unwrap_or(60usize).max(5);
    if let Err(e) = run(Path::new(&dir), &out, a.iter().any(|x| x == "--follow"), block) { eprintln!("tblog: {}", e); std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crc32c_known_vectors() {
        assert_eq!(crc32c(b"123456789"), 0xE306_9283);     // the CRC-32C check value
        assert_eq!(crc32c(&[0u8; 32]), 0x8A91_36AA);
    }
    #[test]
    fn scalar_event_layout() {
        // Event{wall_time=1.0, step=3, summary{value{tag="a", simple_value=2.0}}}
        let e = scalar_event(1.0, 3, "a", 2.0);
        assert_eq!(e[0], 0x09); assert_eq!(&e[1..9], &1.0f64.to_le_bytes()); assert_eq!(&e[9..11], &[0x10, 3]);
        assert_eq!(&e[11..], &[0x2a, 10, 0x0a, 8, 0x0a, 1, b'a', 0x15, 0, 0, 0, 0x40]);
    }
    fn series(means: &[f64], per: usize) -> Vec<f64> { means.iter().flat_map(|m| (0..per).map(move |i| m + if i % 2 == 0 { 1.0 } else { -1.0 })).collect() }
    #[test]
    fn verdict_separates_learning_from_a_plateau() {
        assert_eq!(verdict(&series(&[5.0, 5.0], 60), 60).0, "warming");
        assert_eq!(verdict(&series(&[5.0, 6.0, 7.0, 9.0], 60), 60).0, "learning");
        assert_eq!(verdict(&series(&[8.0, 8.1, 7.9, 8.0, 8.1], 60), 60).0, "stalled");        // plateau: the case to stop and rethink
        assert_eq!(verdict(&series(&[9.0, 9.0, 8.0, 6.0], 60), 60).0, "regressing");
        assert_eq!(verdict(&series(&[5.0, 5.0, 5.0, 5.0, 5.0, 9.0], 60), 60).0, "learning");   // a late jump is not a plateau
    }
    #[test]
    fn tail_reads_python_nan_and_waits_for_whole_lines() {
        let d = std::env::temp_dir().join(format!("tblog-test-{}", std::process::id())); fs::create_dir_all(&d).unwrap();
        fs::write(d.join("x.jsonl"), "{\"a\": NaN, \"b\": 2}\n{\"a\": 1").unwrap();
        let mut t = Tail { path: d.join("x.jsonl"), off: 0 };
        let r = t.lines(); assert_eq!(r.len(), 1); assert!(r[0].get("a").is_null()); assert_eq!(r[0].get("b").f(), 2.0);
        fs::OpenOptions::new().append(true).open(d.join("x.jsonl")).unwrap().write_all(b"}\n").unwrap();
        assert_eq!(t.lines().len(), 1);
        let _ = fs::remove_dir_all(&d);
    }
}

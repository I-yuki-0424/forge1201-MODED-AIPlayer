//! `export`: tiles from a server's region files. A tile is the (2r+1)^2 chunks around a site candidate; it is written only if
//! every chunk is fully generated (so the whole start-site area is real worldgen output, nothing is invented).
use crate::anvil::{chunk_sections, Region};
use crate::data::Data;
use crate::json;
use crate::tile::{Chunk, Tile};
use std::collections::HashMap;

pub fn run(args: &[String]) -> Result<(), String> {
    let mut a: HashMap<&str, &str> = HashMap::new();
    let mut i = 0;
    while i + 1 < args.len() { a.insert(args[i].as_str(), args[i + 1].as_str()); i += 2; }
    let regions = a.get("--regions").ok_or("--regions <dir with r.X.Z.mca>")?;
    let sites = a.get("--sites").ok_or("--sites <site-finder json>")?;
    let out = a.get("--out").ok_or("--out <dir>")?;
    let name = a.get("--name").ok_or("--name <world>")?;
    let r: i32 = a.get("--radius").and_then(|x| x.parse().ok()).unwrap_or(7);
    let limit: usize = a.get("--limit").and_then(|x| x.parse().ok()).unwrap_or(usize::MAX);
    let data = Data::load();
    let cands = json::parse(&std::fs::read_to_string(sites).map_err(|e| e.to_string())?)?;
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let mut regs: HashMap<(i32, i32), Option<Region>> = HashMap::new();
    let mut open = |rx: i32, rz: i32, regs: &mut HashMap<(i32, i32), Option<Region>>| {
        regs.entry((rx, rz)).or_insert_with(|| Region::open(&format!("{}/r.{}.{}.mca", regions, rx, rz)).ok());
    };
    let (mut made, mut tried, mut bytes) = (0usize, 0usize, 0u64);
    let mut unknown: HashMap<String, u32> = HashMap::new();
    for (ci, c) in cands.get("sites").arr().iter().enumerate() {
        if made >= limit { break; }
        let (sx, sz, sy) = (c.at(0).i() as i32, c.at(1).i() as i32, c.at(2).i() as i32);
        let (cx0, cz0) = (sx.div_euclid(16) - r, sz.div_euclid(16) - r);
        let w = 2 * r + 1;
        // header-only check first
        let mut ok = true;
        'chk: for dz in 0..w { for dx in 0..w {
            let (cx, cz) = (cx0 + dx, cz0 + dz);
            open(cx.div_euclid(32), cz.div_euclid(32), &mut regs);
            match regs.get(&(cx.div_euclid(32), cz.div_euclid(32))).and_then(|x| x.as_ref()) {
                Some(rg) if rg.has(cx.rem_euclid(32) as usize, cz.rem_euclid(32) as usize) => {}
                _ => { ok = false; break 'chk; }
            }
        } }
        if !ok { continue; }
        tried += 1;
        let mut chunks: Vec<Option<Chunk>> = Vec::with_capacity((w * w) as usize);
        let mut full = true;
        'build: for dz in 0..w { for dx in 0..w {
            let (cx, cz) = (cx0 + dx, cz0 + dz);
            let rg = regs.get_mut(&(cx.div_euclid(32), cz.div_euclid(32))).and_then(|x| x.as_mut()).unwrap();
            let ch = rg.chunk_nbt(cx.rem_euclid(32) as usize, cz.rem_euclid(32) as usize)?.and_then(|n| chunk_sections(&n, &data, &mut unknown));
            if ch.is_none() { full = false; break 'build; }
            chunks.push(ch);
        } }
        if !full { continue; }
        let t = Tile { name: name.to_string(), site: [sx, sy, sz], cx0, cz0, w, h: w, chunks };
        let path = format!("{}/{}-{}.tile", out, name, ci);
        t.save(&path).map_err(|e| e.to_string())?;
        bytes += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        made += 1;
    }
    let mut un: Vec<_> = unknown.into_iter().collect();
    un.sort_by(|a, b| b.1.cmp(&a.1));
    println!("tiles {} (complete areas found {}), {} MB; block names not in minecraft-data (mapped to 'unknown'): {:?}", made, tried, bytes / 1_000_000, &un[..un.len().min(12)]);
    Ok(())
}

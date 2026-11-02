//! Anvil region files (r.X.Z.mca) → chunk sections of block ids.
use crate::data::Data;
use crate::inflate;
use crate::nbt::{self, N};
use crate::tile::{Chunk, Section, SECS};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

pub struct Region { f: File, pub offs: [u32; 1024] }
impl Region {
    pub fn open(path: &str) -> Result<Region, String> {
        let mut f = File::open(path).map_err(|e| format!("{}: {}", path, e))?;
        let mut h = [0u8; 4096];
        f.read_exact(&mut h).map_err(|e| format!("{}: {}", path, e))?;
        let mut offs = [0u32; 1024];
        for i in 0..1024 { offs[i] = u32::from_be_bytes([h[4 * i], h[4 * i + 1], h[4 * i + 2], h[4 * i + 3]]); }
        Ok(Region { f, offs })
    }
    pub fn has(&self, lx: usize, lz: usize) -> bool { self.offs[lz * 32 + lx] != 0 }
    pub fn chunk_nbt(&mut self, lx: usize, lz: usize) -> Result<Option<N>, String> {
        let o = self.offs[lz * 32 + lx];
        if o == 0 { return Ok(None); }
        let sector = (o >> 8) as u64;
        self.f.seek(SeekFrom::Start(sector * 4096)).map_err(|e| e.to_string())?;
        let mut hd = [0u8; 5];
        self.f.read_exact(&mut hd).map_err(|e| e.to_string())?;
        let len = u32::from_be_bytes([hd[0], hd[1], hd[2], hd[3]]) as usize;
        if len < 1 || len > 1 << 24 { return Err("anvil: bad chunk length".into()); }
        let mut buf = vec![0u8; len - 1];
        self.f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let raw = match hd[4] { 2 => inflate::zlib(&buf)?, 3 => buf, c => return Err(format!("anvil: compression {} unsupported", c)) };
        nbt::parse(&raw).map(Some)
    }
}
/// Sections of a fully generated chunk (Status minecraft:full), or None.
pub fn chunk_sections(root: &N, data: &Data, unknown_names: &mut HashMap<String, u32>) -> Option<Chunk> {
    if root.get("Status")?.str() != "minecraft:full" { return None; }
    let mut secs: Vec<Section> = (0..SECS).map(|_| Section::Uniform(data.air)).collect();
    for s in root.get("sections")?.list() {
        let y = s.get("Y").map(|v| v.int()).unwrap_or(99) as i32;
        let si = y + 4;
        if !(0..SECS as i32).contains(&si) { continue; }
        let bs = match s.get("block_states") { Some(b) => b, None => continue };
        let pal: Vec<u16> = bs.get("palette").map(|p| p.list()).unwrap_or(&[]).iter().map(|e| {
            let n = e.get("Name").map(|n| n.str()).unwrap_or("air");
            let n = n.strip_prefix("minecraft:").unwrap_or(n);
            match data.block_ix.get(n) { Some(&i) => i, None => { *unknown_names.entry(n.to_string()).or_insert(0) += 1; if n.contains(':') { data.bid("stone") } else { data.unknown } } }
        }).collect();
        if pal.is_empty() { continue; }
        if pal.len() == 1 { secs[si as usize] = Section::Uniform(pal[0]); continue; }
        let longs = match bs.get("data") { Some(N::Longs(l)) => l, _ => continue };
        let bits = (usize::BITS - (pal.len() - 1).leading_zeros()).max(4) as usize;
        let per = 64 / bits;
        let mask = (1u64 << bits) - 1;
        let mut blocks = vec![0u16; 4096];
        for (i, b) in blocks.iter_mut().enumerate() {
            let w = longs.get(i / per).copied().unwrap_or(0) as u64;
            let idx = ((w >> ((i % per) * bits)) & mask) as usize;
            *b = pal[idx.min(pal.len() - 1)];
        }
        secs[si as usize] = Section::from_blocks(&blocks);
    }
    Some(Chunk { secs })
}

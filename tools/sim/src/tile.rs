//! World tiles: the chunks around one start site, read once from the server's region files (`export`) and loaded read-only by
//! the simulator. Block ids are minecraft-data block ids (state properties are dropped). Format "FSIM1", sections coded
//! uniform / 8-bit palette / raw.
use std::io::{Read, Write};

pub const MINY: i32 = -64;
pub const SECS: usize = 24;
pub const HEIGHT: i32 = 384;
#[derive(Clone)]
pub enum Section { Uniform(u16), Pal(Vec<u16>, Vec<u8>), Raw(Vec<u16>) }
impl Section {
    #[inline] pub fn get(&self, i: usize) -> u16 { match self { Section::Uniform(b) => *b, Section::Pal(p, d) => p[d[i] as usize], Section::Raw(v) => v[i] } }
    pub fn from_blocks(b: &[u16]) -> Section {
        let mut pal: Vec<u16> = Vec::new();
        for &x in b { if !pal.contains(&x) { pal.push(x); if pal.len() > 256 { return Section::Raw(b.to_vec()); } } }
        if pal.len() == 1 { return Section::Uniform(pal[0]); }
        let idx = b.iter().map(|x| pal.iter().position(|p| p == x).unwrap() as u8).collect();
        Section::Pal(pal, idx)
    }
}
pub struct Chunk { pub secs: Vec<Section> }
pub struct Tile { pub name: String, pub site: [i32; 3], pub cx0: i32, pub cz0: i32, pub w: i32, pub h: i32, pub chunks: Vec<Option<Chunk>> }
impl Tile {
    #[inline] pub fn get(&self, x: i32, y: i32, z: i32) -> Option<u16> {
        if !(MINY..MINY + HEIGHT).contains(&y) { return Some(0); }
        let (cx, cz) = (x.div_euclid(16) - self.cx0, z.div_euclid(16) - self.cz0);
        if cx < 0 || cz < 0 || cx >= self.w || cz >= self.h { return None; }
        let c = self.chunks[(cz * self.w + cx) as usize].as_ref()?;
        let yy = y - MINY;
        Some(c.secs[(yy >> 4) as usize].get((((yy & 15) << 8) | (z.rem_euclid(16) << 4) | x.rem_euclid(16)) as usize))
    }
    pub fn save(&self, path: &str) -> std::io::Result<()> {
        let mut o = Vec::new();
        o.extend_from_slice(b"FSIM1");
        for v in [self.site[0], self.site[1], self.site[2], self.cx0, self.cz0, self.w, self.h] { o.extend_from_slice(&v.to_le_bytes()); }
        for c in &self.chunks {
            match c {
                None => o.push(0),
                Some(c) => { o.push(1); for s in &c.secs { match s {
                    Section::Uniform(b) => { o.push(0); o.extend_from_slice(&b.to_le_bytes()); }
                    Section::Pal(p, d) => { o.push(1); o.extend_from_slice(&(p.len() as u16).to_le_bytes()); for x in p { o.extend_from_slice(&x.to_le_bytes()); } o.extend_from_slice(d); }
                    Section::Raw(v) => { o.push(2); for x in v { o.extend_from_slice(&x.to_le_bytes()); } }
                } } }
            }
        }
        let tmp = format!("{}.tmp", path);
        std::fs::File::create(&tmp)?.write_all(&o)?;
        std::fs::rename(tmp, path)
    }
    pub fn load(path: &str) -> Result<Tile, String> {
        let mut d = Vec::new();
        std::fs::File::open(path).and_then(|mut f| f.read_to_end(&mut d)).map_err(|e| format!("{}: {}", path, e))?;
        if d.get(..5) != Some(b"FSIM1") { return Err(format!("{}: not a tile", path)); }
        let mut p = 5usize;
        let mut rd = |n: usize| -> Result<&[u8], String> { let s = d.get(p..p + n).ok_or("tile: short")?; p += n; Ok(s) };
        let mut iv = [0i32; 7];
        for v in iv.iter_mut() { let b = rd(4)?; *v = i32::from_le_bytes([b[0], b[1], b[2], b[3]]); }
        let (w, h) = (iv[5], iv[6]);
        let mut chunks = Vec::with_capacity((w * h) as usize);
        for _ in 0..w * h {
            if rd(1)?[0] == 0 { chunks.push(None); continue; }
            let mut secs = Vec::with_capacity(SECS);
            for _ in 0..SECS {
                match rd(1)?[0] {
                    0 => { let b = rd(2)?; secs.push(Section::Uniform(u16::from_le_bytes([b[0], b[1]]))); }
                    1 => { let b = rd(2)?; let n = u16::from_le_bytes([b[0], b[1]]) as usize; let pb = rd(2 * n)?; let pal = pb.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect(); secs.push(Section::Pal(pal, rd(4096)?.to_vec())); }
                    _ => { let b = rd(8192)?; secs.push(Section::Raw(b.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())); }
                }
            }
            chunks.push(Some(Chunk { secs }));
        }
        Ok(Tile { name: path.to_string(), site: [iv[0], iv[1], iv[2]], cx0: iv[3], cz0: iv[4], w, h, chunks })
    }
}

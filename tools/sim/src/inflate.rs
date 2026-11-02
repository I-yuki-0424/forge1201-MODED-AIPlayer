//! zlib/DEFLATE decoder (RFC 1950/1951), after zlib's puff.c; std only.
struct Bits<'a> { d: &'a [u8], p: usize, buf: u32, cnt: u32 }
struct Huff { count: [u16; 16], sym: Vec<u16> }
const MAXBITS: usize = 15;
impl<'a> Bits<'a> {
    fn bits(&mut self, n: u32) -> Result<u32, String> {
        while self.cnt < n { let b = *self.d.get(self.p).ok_or("inflate: out of input")?; self.p += 1; self.buf |= (b as u32) << self.cnt; self.cnt += 8; }
        let v = self.buf & ((1u32 << n) - 1); self.buf >>= n; self.cnt -= n; Ok(v)
    }
    fn decode(&mut self, h: &Huff) -> Result<u16, String> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for len in 1..=MAXBITS {
            code |= self.bits(1)? as i32;
            let count = h.count[len] as i32;
            if code - count < first { return Ok(h.sym[(index + (code - first)) as usize]); }
            index += count; first += count; first <<= 1; code <<= 1;
        }
        Err("inflate: bad code".into())
    }
}
fn build(lengths: &[u8]) -> Huff {
    let mut count = [0u16; 16];
    for &l in lengths { count[l as usize] += 1; }
    let mut offs = [0u16; 16];
    for l in 1..MAXBITS { offs[l + 1] = offs[l] + count[l]; }
    let mut sym = vec![0u16; lengths.len()];
    for (s, &l) in lengths.iter().enumerate() { if l != 0 { sym[offs[l as usize] as usize] = s as u16; offs[l as usize] += 1; } }
    Huff { count, sym }
}
const LBASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

fn codes(s: &mut Bits, out: &mut Vec<u8>, lc: &Huff, dc: &Huff) -> Result<(), String> {
    loop {
        let sym = s.decode(lc)? as usize;
        if sym < 256 { out.push(sym as u8); }
        else if sym == 256 { return Ok(()); }
        else {
            let sym = sym - 257;
            if sym >= 29 { return Err("inflate: bad length".into()); }
            let len = LBASE[sym] as usize + s.bits(LEXT[sym] as u32)? as usize;
            let ds = s.decode(dc)? as usize;
            if ds >= 30 { return Err("inflate: bad distance".into()); }
            let dist = DBASE[ds] as usize + s.bits(DEXT[ds] as u32)? as usize;
            if dist > out.len() { return Err("inflate: distance too far".into()); }
            for _ in 0..len { let b = out[out.len() - dist]; out.push(b); }
        }
    }
}
pub fn inflate(d: &[u8]) -> Result<Vec<u8>, String> {
    let mut s = Bits { d, p: 0, buf: 0, cnt: 0 };
    let mut out = Vec::with_capacity(d.len() * 4);
    loop {
        let last = s.bits(1)?;
        match s.bits(2)? {
            0 => { s.buf = 0; s.cnt = 0; let a = s.d.get(s.p..s.p + 4).ok_or("inflate: stored header")?; let len = u16::from_le_bytes([a[0], a[1]]) as usize; s.p += 4;
                out.extend_from_slice(s.d.get(s.p..s.p + len).ok_or("inflate: stored data")?); s.p += len; }
            1 => { let mut l = [0u8; 288]; for (i, x) in l.iter_mut().enumerate() { *x = if i < 144 { 8 } else if i < 256 { 9 } else if i < 280 { 7 } else { 8 }; }
                codes(&mut s, &mut out, &build(&l), &build(&[5u8; 30]))?; }
            2 => { let nlen = s.bits(5)? as usize + 257; let ndist = s.bits(5)? as usize + 1; let ncode = s.bits(4)? as usize + 4;
                const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                let mut lengths = [0u8; 320];
                for &o in ORDER.iter().take(ncode) { lengths[o] = s.bits(3)? as u8; }
                let lencode = build(&lengths[..19]);
                let mut idx = 0; let mut ll = [0u8; 320];
                while idx < nlen + ndist {
                    let sym = s.decode(&lencode)?;
                    if sym < 16 { ll[idx] = sym as u8; idx += 1; }
                    else { let (v, rep) = match sym { 16 => { if idx == 0 { return Err("inflate: repeat".into()); } (ll[idx - 1], 3 + s.bits(2)?) } 17 => (0, 3 + s.bits(3)?), _ => (0, 11 + s.bits(7)?) };
                        if idx + rep as usize > nlen + ndist { return Err("inflate: too many lengths".into()); } for _ in 0..rep { ll[idx] = v; idx += 1; } }
                }
                codes(&mut s, &mut out, &build(&ll[..nlen]), &build(&ll[nlen..nlen + ndist]))?; }
            _ => return Err("inflate: bad block type".into()),
        }
        if last == 1 { return Ok(out); }
    }
}
pub fn zlib(d: &[u8]) -> Result<Vec<u8>, String> { if d.len() < 2 { return Err("zlib: short".into()); } inflate(&d[2..]) }

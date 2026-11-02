//! Minimal NBT reader (big endian), std only.
#[derive(Debug, Clone)]
pub enum N { Byte(i8), Short(i16), Int(i32), Long(i64), Float(f32), Double(f64), Bytes(Vec<i8>), Str(String), List(Vec<N>), Comp(Vec<(String, N)>), Ints(Vec<i32>), Longs(Vec<i64>) }
impl N {
    pub fn get(&self, k: &str) -> Option<&N> { if let N::Comp(v) = self { v.iter().find(|(a, _)| a == k).map(|(_, b)| b) } else { None } }
    pub fn list(&self) -> &[N] { if let N::List(v) = self { v } else { &[] } }
    pub fn str(&self) -> &str { if let N::Str(s) = self { s } else { "" } }
    pub fn int(&self) -> i64 { match self { N::Byte(x) => *x as i64, N::Short(x) => *x as i64, N::Int(x) => *x as i64, N::Long(x) => *x, _ => 0 } }
}
struct R<'a> { d: &'a [u8], p: usize }
impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> { let s = self.d.get(self.p..self.p + n).ok_or("nbt: short")?; self.p += n; Ok(s) }
    fn u8(&mut self) -> Result<u8, String> { Ok(self.take(1)?[0]) }
    fn i16(&mut self) -> Result<i16, String> { let b = self.take(2)?; Ok(i16::from_be_bytes([b[0], b[1]])) }
    fn i32(&mut self) -> Result<i32, String> { let b = self.take(4)?; Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]])) }
    fn i64(&mut self) -> Result<i64, String> { let b = self.take(8)?; Ok(i64::from_be_bytes(b.try_into().unwrap())) }
    fn s(&mut self) -> Result<String, String> { let n = self.i16()? as u16 as usize; Ok(String::from_utf8_lossy(self.take(n)?).into_owned()) }
    fn payload(&mut self, t: u8, depth: u32) -> Result<N, String> {
        if depth > 64 { return Err("nbt: too deep".into()); }
        Ok(match t {
            1 => N::Byte(self.u8()? as i8), 2 => N::Short(self.i16()?), 3 => N::Int(self.i32()?), 4 => N::Long(self.i64()?),
            5 => N::Float(f32::from_bits(self.i32()? as u32)), 6 => N::Double(f64::from_bits(self.i64()? as u64)),
            7 => { let n = self.i32()?.max(0) as usize; N::Bytes(self.take(n)?.iter().map(|&b| b as i8).collect()) }
            8 => N::Str(self.s()?),
            9 => { let et = self.u8()?; let n = self.i32()?.max(0) as usize; let mut v = Vec::with_capacity(n.min(4096)); for _ in 0..n { v.push(self.payload(et, depth + 1)?); } N::List(v) }
            10 => { let mut v = Vec::new(); loop { let t = self.u8()?; if t == 0 { break; } let k = self.s()?; v.push((k, self.payload(t, depth + 1)?)); } N::Comp(v) }
            11 => { let n = self.i32()?.max(0) as usize; let mut v = Vec::with_capacity(n); for _ in 0..n { v.push(self.i32()?); } N::Ints(v) }
            12 => { let n = self.i32()?.max(0) as usize; let mut v = Vec::with_capacity(n); for _ in 0..n { v.push(self.i64()?); } N::Longs(v) }
            _ => return Err(format!("nbt: bad tag {}", t)),
        })
    }
}
/// A whole NBT file: the root compound's contents.
pub fn parse(d: &[u8]) -> Result<N, String> { let mut r = R { d, p: 0 }; let t = r.u8()?; if t != 10 { return Err("nbt: root is not a compound".into()); } r.s()?; r.payload(10, 0) }

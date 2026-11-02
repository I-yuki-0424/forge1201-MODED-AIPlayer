//! Minimal JSON (std only): enough for the data tables and the JSON-lines file API.
use std::fmt::Write;

#[derive(Clone, Debug, PartialEq)]
pub enum J { Null, Bool(bool), Num(f64), Str(String), Arr(Vec<J>), Obj(Vec<(String, J)>) }
static NULL: J = J::Null;

impl J {
    pub fn get(&self, k: &str) -> &J { match self { J::Obj(v) => v.iter().find(|(a, _)| a == k).map(|(_, b)| b).unwrap_or(&NULL), _ => &NULL } }
    pub fn at(&self, i: usize) -> &J { match self { J::Arr(v) => v.get(i).unwrap_or(&NULL), _ => &NULL } }
    pub fn f(&self) -> f64 { if let J::Num(n) = self { *n } else { 0.0 } }
    pub fn i(&self) -> i64 { self.f() as i64 }
    pub fn s(&self) -> &str { if let J::Str(s) = self { s } else { "" } }
    pub fn b(&self) -> bool { matches!(self, J::Bool(true)) }
    pub fn arr(&self) -> &[J] { if let J::Arr(v) = self { v } else { &[] } }
    pub fn obj(&self) -> &[(String, J)] { if let J::Obj(v) = self { v } else { &[] } }
    pub fn is_null(&self) -> bool { matches!(self, J::Null) }
    pub fn o(v: Vec<(&str, J)>) -> J { J::Obj(v.into_iter().map(|(k, v)| (k.to_string(), v)).collect()) }
    pub fn n<T: Into<f64>>(x: T) -> J { J::Num(x.into()) }
    pub fn st(s: &str) -> J { J::Str(s.to_string()) }
    pub fn nums<T: Copy + Into<f64>>(v: &[T]) -> J { J::Arr(v.iter().map(|&x| J::Num(x.into())).collect()) }
    pub fn dump(&self) -> String { let mut s = String::new(); self.write(&mut s); s }
    pub fn write(&self, o: &mut String) {
        match self {
            J::Null => o.push_str("null"),
            J::Bool(b) => o.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => {
                if !n.is_finite() { o.push_str("0") } else if n.fract() == 0.0 && n.abs() < 1e15 { let _ = write!(o, "{}", *n as i64); } else { let _ = write!(o, "{}", n); }
            }
            J::Str(s) => { o.push('"'); for c in s.chars() { match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"), '\r' => o.push_str("\\r"), '\t' => o.push_str("\\t"), c if (c as u32) < 0x20 => { let _ = write!(o, "\\u{:04x}", c as u32); } c => o.push(c) } } o.push('"'); }
            J::Arr(v) => { o.push('['); for (i, x) in v.iter().enumerate() { if i > 0 { o.push(','); } x.write(o); } o.push(']'); }
            J::Obj(v) => { o.push('{'); for (i, (k, x)) in v.iter().enumerate() { if i > 0 { o.push(','); } J::Str(k.clone()).write(o); o.push(':'); x.write(o); } o.push('}'); }
        }
    }
}

pub fn parse(s: &str) -> Result<J, String> {
    let b = s.as_bytes();
    let mut p = 0usize;
    let v = val(b, &mut p)?;
    ws(b, &mut p);
    if p != b.len() { return Err(format!("trailing data at {}", p)); }
    Ok(v)
}
fn ws(b: &[u8], p: &mut usize) { while *p < b.len() && matches!(b[*p], b' ' | b'\n' | b'\r' | b'\t') { *p += 1; } }
fn val(b: &[u8], p: &mut usize) -> Result<J, String> {
    ws(b, p);
    if *p >= b.len() { return Err("unexpected end".into()); }
    match b[*p] {
        b'n' => lit(b, p, "null", J::Null), b't' => lit(b, p, "true", J::Bool(true)), b'f' => lit(b, p, "false", J::Bool(false)),
        b'"' => Ok(J::Str(string(b, p)?)),
        b'[' => { *p += 1; let mut v = vec![]; ws(b, p); if b.get(*p) == Some(&b']') { *p += 1; return Ok(J::Arr(v)); }
            loop { v.push(val(b, p)?); ws(b, p); match b.get(*p) { Some(b',') => *p += 1, Some(b']') => { *p += 1; return Ok(J::Arr(v)); } _ => return Err(format!("bad array at {}", p)) } } }
        b'{' => { *p += 1; let mut v = vec![]; ws(b, p); if b.get(*p) == Some(&b'}') { *p += 1; return Ok(J::Obj(v)); }
            loop { ws(b, p); let k = string(b, p)?; ws(b, p); if b.get(*p) != Some(&b':') { return Err(format!("expected : at {}", p)); } *p += 1; v.push((k, val(b, p)?)); ws(b, p);
                match b.get(*p) { Some(b',') => *p += 1, Some(b'}') => { *p += 1; return Ok(J::Obj(v)); } _ => return Err(format!("bad object at {}", p)) } } }
        _ => { let st = *p; while *p < b.len() && matches!(b[*p], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') { *p += 1; }
            std::str::from_utf8(&b[st..*p]).ok().and_then(|t| t.parse::<f64>().ok()).map(J::Num).ok_or_else(|| format!("bad number at {}", st)) }
    }
}
fn lit(b: &[u8], p: &mut usize, w: &str, v: J) -> Result<J, String> { if b[*p..].starts_with(w.as_bytes()) { *p += w.len(); Ok(v) } else { Err(format!("bad literal at {}", p)) } }
fn string(b: &[u8], p: &mut usize) -> Result<String, String> {
    if b.get(*p) != Some(&b'"') { return Err(format!("expected string at {}", p)); }
    *p += 1;
    let mut out = Vec::new();
    while *p < b.len() {
        match b[*p] {
            b'"' => { *p += 1; return String::from_utf8(out).map_err(|e| e.to_string()); }
            b'\\' => { *p += 1; match b.get(*p) { Some(b'n') => out.push(b'\n'), Some(b'r') => out.push(b'\r'), Some(b't') => out.push(b'\t'), Some(b'b') => out.push(8), Some(b'f') => out.push(12),
                Some(b'u') => { let h = std::str::from_utf8(b.get(*p + 1..*p + 5).ok_or("bad \\u")?).map_err(|e| e.to_string())?; let mut c = u32::from_str_radix(h, 16).map_err(|e| e.to_string())?; *p += 4;
                    if (0xD800..0xDC00).contains(&c) && b.get(*p + 1) == Some(&b'\\') && b.get(*p + 2) == Some(&b'u') { if let Ok(l) = u32::from_str_radix(std::str::from_utf8(&b[*p + 3..*p + 7]).unwrap_or("x"), 16) { c = 0x10000 + ((c - 0xD800) << 10) + (l - 0xDC00); *p += 6; } }
                    let mut t = [0u8; 4]; out.extend_from_slice(char::from_u32(c).unwrap_or('?').encode_utf8(&mut t).as_bytes()); }
                Some(c) => out.push(*c), None => return Err("bad escape".into()) } *p += 1; }
            c => { out.push(c); *p += 1; }
        }
    }
    Err("unterminated string".into())
}

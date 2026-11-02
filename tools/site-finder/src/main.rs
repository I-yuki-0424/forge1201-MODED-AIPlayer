//! Start-site candidates for the RL training bots, computed from the world seed alone (cubiomes, Minecraft 1.20 overworld
//! generation): owner 2026-11-02, "the world terrain can be determined from the seed; give a new location for each episode".
//!
//!   site-finder --seed 20261101 --count 20000 [--spacing 640] [--jitter 64] [--threads N] > sites.json
//!
//! The world is cut into cells of `spacing` blocks, visited ring by ring from the origin; a cell yields at most one site, at
//! most `jitter` blocks from its centre, so any two sites are at least spacing - 2 x jitter (512) blocks apart: a list consumed
//! in order never starts a bot within 500 blocks of an earlier start. A point qualifies when
//!   trees   it and at least 7 of 8 points 24 blocks around it lie in a biome that generates trees densely (forests, taigas,
//!           jungles; the environment counts the logs on arrival, since biome != trees),
//!   land    at most 30 % of the points of a 32-block grid within 256 blocks are ocean, river or beach (no small island),
//!   height  the approximate surface is 63..110 (above sea level, below the mountains).
//! Output: {"seed", "mc", "spacing", "jitter", "criteria", "sites": [[x, z, approx_y], ...]} in visiting order.
use std::{env, ffi::c_void, process::exit, thread};

extern "C" {
    fn sf_new(seed: u64) -> *mut c_void;
    fn sf_free(c: *mut c_void);
    fn sf_biome(c: *mut c_void, x: i32, z: i32) -> i32;
    fn sf_class(id: i32) -> i32;
    fn sf_height(c: *mut c_void, x: i32, z: i32) -> f32;
}

struct Gen(*mut c_void);
impl Gen {
    fn new(seed: u64) -> Self {
        let p = unsafe { sf_new(seed) };
        assert!(!p.is_null(), "out of memory");
        Gen(p)
    }
    fn class(&self, x: i32, z: i32) -> i32 {
        unsafe { sf_class(sf_biome(self.0, x, z)) }
    }
    fn height(&self, x: i32, z: i32) -> f32 {
        unsafe { sf_height(self.0, x, z) }
    }
}
impl Drop for Gen {
    fn drop(&mut self) {
        unsafe { sf_free(self.0) }
    }
}

#[derive(Clone, Copy)]
struct Opt {
    seed: u64,
    count: usize,
    spacing: i32,
    jitter: i32,
    threads: usize,
    max_ring: i32,
}

fn args() -> Opt {
    let mut o = Opt { seed: 0, count: 20000, spacing: 640, jitter: 64, threads: 4, max_ring: 2000 };
    let a: Vec<String> = env::args().skip(1).collect();
    let mut seed = None;
    for p in a.chunks(2) {
        let v = p.get(1).map(String::as_str).unwrap_or_else(|| die(&format!("{} needs a value", p[0])));
        let n = || v.parse::<i64>().unwrap_or_else(|_| die(&format!("{}: not a number: {v}", p[0])));
        match p[0].as_str() {
            "--seed" => seed = Some(n() as u64),
            "--count" => o.count = n().clamp(1, 1_000_000) as usize,
            "--spacing" => o.spacing = n().clamp(64, 100_000) as i32,
            "--jitter" => o.jitter = n().clamp(0, 10_000) as i32,
            "--threads" => o.threads = n().clamp(1, 64) as usize,
            "--max-ring" => o.max_ring = n().clamp(1, 40_000) as i32,
            f => die(&format!("unknown option {f}")),
        }
    }
    o.seed = seed.unwrap_or_else(|| die("--seed is required"));
    if 2 * o.jitter >= o.spacing {
        die("--jitter must be below spacing / 2");
    }
    o
}

fn die(m: &str) -> ! {
    eprintln!("site-finder: {m}");
    exit(2)
}

/// Cells of ring r (Chebyshev distance r from the origin cell), in a fixed order.
fn ring(r: i32) -> Vec<(i32, i32)> {
    if r == 0 {
        return vec![(0, 0)];
    }
    let mut v = vec![];
    for i in -r..r {
        v.push((i, -r));
        v.push((r, i));
        v.push((-i, r));
        v.push((-r, -i));
    }
    v
}

fn qualifies(g: &Gen, x: i32, z: i32) -> Option<f32> {
    if g.class(x, z) != 2 {
        return None;
    }
    let around = (0..8).filter(|k| {
        let a = *k as f64 * std::f64::consts::FRAC_PI_4;
        g.class(x + (24.0 * a.cos()).round() as i32, z + (24.0 * a.sin()).round() as i32) == 2
    });
    if around.count() < 7 {
        return None;
    }
    let y = g.height(x, z);
    if !(63.0..=110.0).contains(&y) {
        return None;
    }
    let (mut n, mut wet) = (0, 0);
    for dx in (-256..=256).step_by(32) {
        for dz in (-256..=256).step_by(32) {
            if dx * dx + dz * dz <= 256 * 256 {
                n += 1;
                wet += (g.class(x + dx, z + dz) == 0) as i32;
            }
        }
    }
    (wet * 10 <= n * 3).then_some(y)
}

/// The site of one cell: the centre first, then the jitter grid nearest the centre first.
fn cell_site(g: &Gen, o: &Opt, (cx, cz): (i32, i32)) -> Option<[i32; 3]> {
    let mut offs: Vec<(i32, i32)> = vec![];
    for dx in (-o.jitter..=o.jitter).step_by(32.max(1)) {
        for dz in (-o.jitter..=o.jitter).step_by(32.max(1)) {
            offs.push((dx, dz));
        }
    }
    offs.sort_by_key(|&(dx, dz)| (dx * dx + dz * dz, dx, dz));
    offs.into_iter().find_map(|(dx, dz)| {
        let (x, z) = (cx * o.spacing + dx, cz * o.spacing + dz);
        qualifies(g, x, z).map(|y| [x, z, y.round() as i32])
    })
}

fn main() {
    let o = args();
    let mut sites: Vec<[i32; 3]> = vec![];
    let mut r = 0;
    while sites.len() < o.count && r <= o.max_ring {
        let cells = ring(r);
        let chunk = cells.len().div_ceil(o.threads);
        let found: Vec<Vec<Option<[i32; 3]>>> = thread::scope(|s| {
            let hs: Vec<_> = cells
                .chunks(chunk)
                .map(|part| {
                    s.spawn(move || {
                        let g = Gen::new(o.seed);
                        part.iter().map(|&c| cell_site(&g, &o, c)).collect()
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().expect("worker")).collect()
        });
        sites.extend(found.into_iter().flatten().flatten());
        r += 1;
    }
    sites.truncate(o.count);
    let list: Vec<String> = sites.iter().map(|s| format!("[{},{},{}]", s[0], s[1], s[2])).collect();
    println!(
        "{{\"seed\":{},\"mc\":\"1.20\",\"spacing\":{},\"jitter\":{},\"rings\":{},\"criteria\":\"trees: centre + >= 7 of 8 points at 24 blocks in a tree biome; land: <= 30 % ocean/river/beach within 256 blocks; approx surface 63..110\",\"sites\":[{}]}}",
        o.seed,
        o.spacing,
        o.jitter,
        r,
        list.join(",")
    );
    if sites.len() < o.count {
        eprintln!("site-finder: only {} sites within {} rings", sites.len(), o.max_ring);
    }
}

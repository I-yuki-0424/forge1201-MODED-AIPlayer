//! train-dash: a read-only page for watching the RL training bots (docs/proposed/RL-TRAINING-v2.md "Watching").
//!
//!   train-dash --root <exchange dir> --base <run base> [--bind 127.0.0.1:3021]
//!
//! Serves exactly five paths with GET or HEAD: the page (`/`, `/app.js`, `/app.css`, compiled in), `/live.json` (the
//! environment's `<root>/<base>.live.json`) and `/learner.json` (the tail of the learner's train_log.jsonl and
//! episodes.jsonl). It never writes, never runs anything, and reads no path derived from the request. Standard library only.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const PAGE: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const APP_CSS: &str = include_str!("../web/app.css");
const MAX_REQUEST: usize = 8 * 1024;
const MAX_CONNS: usize = 32;
const LIVE_MAX: u64 = 4 * 1024 * 1024;
const TAIL_BYTES: u64 = 256 * 1024;
const CSP: &str =
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; \
                   base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

struct Config {
    live: PathBuf,
    train_log: PathBuf,
    episodes: PathBuf,
}

fn parse_args() -> Result<(Config, String), String> {
    let (mut root, mut base, mut bind) = (None, None, "127.0.0.1:3021".to_string());
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let v = it.next().ok_or(format!("{k} needs a value"))?;
        match k.as_str() {
            "--root" => root = Some(PathBuf::from(v)),
            "--base" => base = Some(v),
            "--bind" => bind = v,
            _ => return Err(format!("unknown option {k}")),
        }
    }
    let root = root.ok_or("--root is required")?;
    let base = base.ok_or("--base is required")?;
    let ok = !base.is_empty()
        && base.len() <= 40
        && base
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !ok {
        return Err("--base: [A-Za-z0-9_-]{1,40}".into());
    }
    let train = root.join(&base).join("train");
    Ok((
        Config {
            live: root.join(format!("{base}.live.json")),
            train_log: train.join("train_log.jsonl"),
            episodes: train.join("episodes.jsonl"),
        },
        bind,
    ))
}

/// The last `max_lines` complete JSON-object lines of a file, read from at most its last TAIL_BYTES.
fn tail_lines(path: &Path, max_lines: usize, keep: impl Fn(&str) -> bool) -> Vec<String> {
    let Ok(mut f) = File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.take(TAIL_BYTES).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // probably cut in the middle
    }
    let mut out: Vec<String> = lines
        .into_iter()
        .map(str::trim)
        .filter(|l| l.starts_with('{') && l.ends_with('}') && keep(l))
        .map(String::from)
        .collect();
    let n = out.len();
    out.drain(..n.saturating_sub(max_lines));
    out
}

fn learner_json(c: &Config) -> String {
    let updates = tail_lines(&c.train_log, 240, |l| {
        l.contains("\"event\": \"update\"")
            || l.contains("\"event\": \"stage_switch\"")
            || l.contains("\"event\": \"model\"")
    });
    let episodes = tail_lines(&c.episodes, 40, |_| true);
    format!(
        "{{\"updates\":[{}],\"episodes\":[{}]}}",
        updates.join(","),
        episodes.join(",")
    )
}

fn read_live(c: &Config) -> Option<Vec<u8>> {
    let f = File::open(&c.live).ok()?;
    let mut buf = Vec::new();
    f.take(LIVE_MAX).read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn respond(s: &mut TcpStream, status: &str, ctype: &str, body: &[u8], head: bool) {
    let hdr = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: {CSP}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(hdr.as_bytes());
    if !head {
        let _ = s.write_all(body);
    }
}

fn handle(mut s: TcpStream, c: &Config) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > MAX_REQUEST {
            return respond(
                &mut s,
                "431 Request Header Fields Too Large",
                "text/plain",
                b"too large\n",
                false,
            );
        }
    }
    let line =
        String::from_utf8_lossy(buf.split(|&b| b == b'\r').next().unwrap_or(&[])).into_owned();
    let mut parts = line.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let head = method == "HEAD";
    if method != "GET" && !head {
        return respond(
            &mut s,
            "405 Method Not Allowed",
            "text/plain",
            b"GET only\n",
            false,
        );
    }
    let path = target.split('?').next().unwrap_or("");
    match path {
        "/" => respond(
            &mut s,
            "200 OK",
            "text/html; charset=utf-8",
            PAGE.as_bytes(),
            head,
        ),
        "/app.js" => respond(
            &mut s,
            "200 OK",
            "text/javascript; charset=utf-8",
            APP_JS.as_bytes(),
            head,
        ),
        "/app.css" => respond(
            &mut s,
            "200 OK",
            "text/css; charset=utf-8",
            APP_CSS.as_bytes(),
            head,
        ),
        "/live.json" => match read_live(c) {
            Some(b) => respond(&mut s, "200 OK", "application/json", &b, head),
            None => respond(
                &mut s,
                "503 Service Unavailable",
                "application/json",
                b"{\"error\":\"no live file yet\"}",
                head,
            ),
        },
        "/learner.json" => respond(
            &mut s,
            "200 OK",
            "application/json",
            learner_json(c).as_bytes(),
            head,
        ),
        _ => respond(&mut s, "404 Not Found", "text/plain", b"not found\n", head),
    }
}

fn main() {
    let (cfg, bind) = match parse_args() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("train-dash: {e}");
            std::process::exit(2);
        }
    };
    let listener = match TcpListener::bind(&bind) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("train-dash: bind {bind}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("train-dash: serving {} on {bind}", cfg.live.display());
    let cfg = Arc::new(cfg);
    let active = Arc::new(AtomicUsize::new(0));
    for conn in listener.incoming() {
        let Ok(mut s) = conn else { continue };
        if active.load(Ordering::SeqCst) >= MAX_CONNS {
            respond(
                &mut s,
                "503 Service Unavailable",
                "text/plain",
                b"busy\n",
                false,
            );
            continue;
        }
        active.fetch_add(1, Ordering::SeqCst);
        let (cfg, active) = (Arc::clone(&cfg), Arc::clone(&active));
        std::thread::spawn(move || {
            handle(s, &cfg);
            active.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_last_complete_objects() {
        let dir = std::env::temp_dir().join(format!("train-dash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("log.jsonl");
        std::fs::write(&p, "{\"event\": \"update\", \"u\": 1}\nnot json\n{\"event\": \"run\"}\n{\"event\": \"update\", \"u\": 2}\n{\"event\": \"upd").unwrap();
        let got = tail_lines(&p, 10, |l| l.contains("\"event\": \"update\""));
        assert_eq!(
            got,
            vec![
                "{\"event\": \"update\", \"u\": 1}",
                "{\"event\": \"update\", \"u\": 2}"
            ]
        );
        assert_eq!(
            tail_lines(&p, 1, |_| true),
            vec!["{\"event\": \"update\", \"u\": 2}"]
        );
        assert!(tail_lines(&dir.join("missing"), 5, |_| true).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

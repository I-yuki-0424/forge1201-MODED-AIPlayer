// Compiles the vendored cubiomes (C, MIT, commit in cubiomes/COMMIT) and src/shim.c into a static library with the system
// C compiler; no build crates. CC / AR override the tools (x86_64-w64-mingw32-gcc for a Windows build).
use std::{env, path::PathBuf, process::Command};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let cc = env::var("CC").unwrap_or_else(|_| "cc".into());
    let ar = env::var("AR").unwrap_or_else(|_| "ar".into());
    let srcs = ["noise", "biomes", "layers", "biomenoise", "generator", "finders", "util", "quadbase"]
        .iter()
        .map(|s| format!("cubiomes/{s}.c"))
        .chain(["src/shim.c".to_string()]);
    let mut objs = vec![];
    for src in srcs {
        let obj = out.join(PathBuf::from(&src).file_stem().unwrap()).with_extension("o");
        let ok = Command::new(&cc)
            .args(["-c", "-O3", "-fwrapv", "-fPIC", "-Icubiomes", &src, "-o"])
            .arg(&obj)
            .status()
            .expect("C compiler")
            .success();
        assert!(ok, "compiling {src} failed");
        println!("cargo:rerun-if-changed={src}");
        objs.push(obj);
    }
    let lib = out.join("libcubiomes.a");
    let _ = std::fs::remove_file(&lib);
    assert!(Command::new(&ar).arg("crs").arg(&lib).args(&objs).status().expect("ar").success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=cubiomes");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        println!("cargo:rustc-link-lib=m");
    }
}

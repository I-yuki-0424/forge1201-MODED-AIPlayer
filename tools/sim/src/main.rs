mod anvil; mod data; mod export; mod inflate; mod json; mod nbt; mod obs; mod run; mod sim; mod tile;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let rest = &args[2.min(args.len())..];
    let res = match args.get(1).map(|s| s.as_str()) {
        Some("export") => export::run(rest),
        Some("run") => run::run(rest),
        _ => Err("usage: forgeaip-sim export|run ...".to_string()),
    };
    if let Err(e) = res { eprintln!("forgeaip-sim: {}", e); std::process::exit(2); }
}

//! Candidates and observation, ported from src/rl/skill_space.js (K = 64 concrete commands the bot can carry out from here).
use crate::data::Kind;
use crate::json::J;
use crate::sim::{Sim, EYE, BLOCK_REACH, DAY};
use std::collections::HashMap;

pub const K: usize = 64;
pub const CMDS: [&str; 13] = ["pad", "move_to", "mine", "attack", "pickup", "craft", "smelt", "place", "activate", "equip", "eat", "wait", "tunnel"];
fn cmd_ix(n: &str) -> usize { CMDS.iter().position(|c| *c == n).unwrap() }
fn quota(n: &str) -> usize { match n { "move_to" => 12, "mine" => 11, "attack" => 4, "pickup" => 2, "craft" => 6, "smelt" => 6, "place" => 8, "activate" => 2, "equip" => 2, "eat" => 4, "wait" => 1, _ => 12 } }
pub const REASONS: [&str; 17] = ["ok", "invalid_args", "invalid_target", "missing_item", "missing_tool", "missing_materials", "no_station", "unreachable", "stuck", "not_visible", "not_confirmed", "target_lost", "timeout", "died", "disconnected", "cancelled", "internal"];
pub const VIEW_W: usize = 16; pub const VIEW_H: usize = 8; const VIEW_R: f64 = 24.0;

#[derive(Clone, Debug)]
pub enum Args { Move([i32; 3]), Mine([i32; 3]), Tunnel(&'static str, i32), Attack(u32), Craft(String, Option<[i32; 3]>), Smelt(String, [i32; 3]), Place([i32; 3], String), Activate([i32; 3]), Eat(String), Wait }
#[derive(Clone, Debug)]
pub struct Cand { pub cmd: usize, pub args: Args, pub item: u16, pub ent: u16, pub feat: [f64; 8] }
fn r4(x: f64) -> f64 { (x * 1e4).round() / 1e4 }
fn clip(x: f64) -> f64 { x.max(-1.0).min(1.0) }

fn feat(s: &Sim, pos: Option<[f64; 3]>, count: u32) -> [f64; 8] {
    let night = if s.is_night() { 1.0 } else { 0.0 };
    match pos {
        None => [0.0, 0.0, 0.0, 0.0, r4(count as f64 / 64.0), 1.0, night, 0.0],
        Some(q) => { let p = s.center(); let (dx, dy, dz) = (q[0] - p[0], q[1] - p[1], q[2] - p[2]); let d = (dx * dx + dy * dy + dz * dz).sqrt();
            [clip(dx / 16.0), clip(dy / 16.0), clip(dz / 16.0), (d / 16.0).min(1.0), r4(count as f64 / 64.0), if d <= 4.5 { 1.0 } else { 0.0 }, night, 0.0].map(r4) }
    }
}
fn placeable(n: &str) -> bool {
    matches!(n, "crafting_table" | "furnace" | "chest" | "torch" | "cobblestone" | "cobbled_deepslate" | "dirt" | "netherrack" | "stone" | "sand" | "gravel" | "oak_log" | "spruce_log" | "birch_log") || n.ends_with("_bed") || n.ends_with("_planks")
}
fn in_reach(nodes: &[[i32; 3]], x: i32, y: i32, z: i32) -> bool {
    nodes.iter().any(|n| ((n[0] - x) as f64).powi(2) + (n[1] as f64 + EYE - y as f64 - 0.5).powi(2) + ((n[2] - z) as f64).powi(2) <= BLOCK_REACH * BLOCK_REACH)
}

pub fn candidates(s: &mut Sim) -> Vec<Cand> {
    let [fx, fy, fz] = s.pos;
    let nodes: Vec<[i32; 3]> = s.reach().nodes.clone();
    let reach_ok: std::collections::HashSet<[i32; 3]> = nodes.iter().copied().collect();
    // The lists are collected first and cut to their quotas at the end: `craft` takes every slot the other commands leave free (below), so a
    // recipe is not hidden behind a fixed number of alphabetically earlier ones (2026-11-04: iron_pickaxe was the 11th of 21 craftable).
    let mut parts: Vec<(&'static str, Vec<Cand>)> = vec![];
    let add = |parts: &mut Vec<(&'static str, Vec<Cand>)>, cmd: &'static str, list: Vec<Cand>| parts.push((cmd, list));

    // move_to
    let dirs: [(f64, f64); 8] = [(1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (-1.0, 1.0), (-1.0, 0.0), (-1.0, -1.0), (0.0, -1.0), (1.0, -1.0)];
    let mut moves = vec![];
    for (dd, idxs) in [(6.0, vec![0, 1, 2, 3, 4, 5, 6, 7]), (16.0, vec![0, 2, 4, 6])] {
        for i in idxs {
            let (ux, uz) = dirs[i];
            let h = (ux * ux + uz * uz).sqrt();
            let (x, z) = (fx + (ux * dd / h).round() as i32, fz + (uz * dd / h).round() as i32);
            for dy in [0, 1, -1, 2, -2, 3, -3, 4, -4] {
                if reach_ok.contains(&[x, fy + dy, z]) { moves.push(Cand { cmd: cmd_ix("move_to"), args: Args::Move([x, fy + dy, z]), item: 0, ent: 0, feat: feat(s, Some([x as f64 + 0.5, (fy + dy) as f64, z as f64 + 0.5]), 0) }); break; }
            }
        }
    }
    add(&mut parts, "move_to", moves);

    // mine
    let mut found: Vec<(String, i32, [i32; 3], i32)> = vec![];
    let mut can: HashMap<u16, bool> = HashMap::new();
    for dy in -3..=4 { for dz in -5..=5 { for dx in -5..=5 {
        if dx == 0 && dz == 0 && dy < 0 { continue; }
        let (x, y, z) = (fx + dx, fy + dy, fz + dz);
        let bid = match s.blk(x, y, z) { Some(b) => b, None => continue };
        let b = s.d.block(bid);
        if b.name == "bedrock" || !b.diggable || b.kind != Kind::Solid { continue; }
        if ![(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)].iter().any(|(a, c, e)| s.is_air(x + a, y + c, z + e)) { continue; }
        let ok = *can.entry(bid).or_insert_with(|| s.dig_plan(bid).is_some());
        if !ok { continue; }
        found.push((b.name.clone(), dx * dx + dy * dy + dz * dz, [x, y, z], dy));
    } } }
    found.sort_by_key(|f| f.1);
    let mut best: HashMap<String, (i32, [i32; 3])> = HashMap::new();
    let mut up: HashMap<String, (i32, [i32; 3])> = HashMap::new();
    for (name, d, pos, dy) in found {
        if best.contains_key(&name) && (dy < 1 || up.contains_key(&name)) { continue; }
        if !minable(s, &nodes, pos) { continue; }
        best.entry(name.clone()).or_insert((d, pos));
        if dy >= 1 { up.entry(name).or_insert((d, pos)); }
    }
    let mut mines: Vec<(String, f64, [i32; 3])> = best.iter().map(|(n, v)| (n.clone(), v.0 as f64, v.1)).collect();
    for (n, v) in &up { if best[n].1 != v.1 { mines.push((n.clone(), v.0 as f64 + 0.5, v.1)); } }
    mines.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(a.0.cmp(&b.0)));
    let ml: Vec<Cand> = mines.into_iter().map(|(n, _, p)| Cand { cmd: cmd_ix("mine"), args: Args::Mine(p), item: s.d.item(&n), ent: 0, feat: feat(s, Some([p[0] as f64 + 0.5, p[1] as f64 + 0.5, p[2] as f64 + 0.5]), 0) }).collect();
    add(&mut parts, "mine", ml);

    // tunnel
    if s.standable(fx, fy, fz) {
        let mut tl = vec![];
        for dir in ["north", "south", "west", "east"] { for dy in [-1, 0, 1] {
            if s.tunnel_problem(s.pos, dir, dy).is_some() { continue; }
            let (clear, to, _) = Sim::tunnel_cells(s.pos, dir, dy);
            let all = clear.iter().all(|c| { let k = s.kind(c[0], c[1], c[2]); matches!(k, Kind::Air | Kind::Passable | Kind::Climb) || s.blk(c[0], c[1], c[2]).map_or(false, |b| s.dig_plan(b).is_some()) });
            if !all { continue; }
            let first = clear.iter().find(|c| !matches!(s.kind(c[0], c[1], c[2]), Kind::Air | Kind::Passable | Kind::Climb)).unwrap();
            let nm = s.name(first[0], first[1], first[2]).to_string();
            tl.push(Cand { cmd: cmd_ix("tunnel"), args: Args::Tunnel(dir, dy), item: s.d.item(&nm), ent: 0, feat: feat(s, Some([to[0] as f64 + 0.5, to[1] as f64, to[2] as f64 + 0.5]), 0) });
        } }
        add(&mut parts, "tunnel", tl);
    }

    // attack
    let p = s.center();
    let mut ents: Vec<(f64, usize)> = s.mobs.iter().enumerate().map(|(i, m)| (((m.pos[0] as f64 + 0.5 - p[0]).powi(2) + (m.pos[1] as f64 - p[1]).powi(2) + (m.pos[2] as f64 + 0.5 - p[2]).powi(2)).sqrt(), i)).collect();
    ents.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut seen: Vec<&str> = vec![];
    let mut atk = vec![];
    for (d, i) in &ents {
        let m = &s.mobs[*i];
        if *d > 16.0 || seen.contains(&m.name) { continue; }
        if !nodes.iter().any(|n| (((n[0] - m.pos[0]) as f64).powi(2) + ((n[2] - m.pos[2]) as f64).powi(2)).sqrt() <= 2.5 && ((n[1] - m.pos[1]) as f64).abs() <= 1.5) { continue; }
        seen.push(m.name);
        atk.push(Cand { cmd: cmd_ix("attack"), args: Args::Attack(m.id), item: 0, ent: s.d.ent(m.name), feat: feat(s, Some([m.pos[0] as f64 + 0.5, m.pos[1] as f64, m.pos[2] as f64 + 0.5]), 0) });
    }
    add(&mut parts, "attack", atk);

    // stations: placed crafting tables / furnaces in reach (natural ones are not looked for)
    let mut table = None; let mut furnace = None; let mut beds: Vec<[i32; 3]> = vec![];
    let mut edits: Vec<(&(i32, i32, i32), &u16)> = s.edits.iter().collect();
    edits.sort();
    for ((x, y, z), b) in edits {
        if (x - fx).abs() > 16 || (z - fz).abs() > 16 || (y - fy).abs() > 8 { continue; }
        let nm = s.d.block(*b).name.as_str();
        if nm == "crafting_table" && table.is_none() && in_reach(&nodes, *x, *y, *z) { table = Some([*x, *y, *z]); }
        if nm == "furnace" && furnace.is_none() && in_reach(&nodes, *x, *y, *z) { furnace = Some([*x, *y, *z]); }
        if nm.ends_with("_bed") && (x - fx).abs() <= 8 && (z - fz).abs() <= 8 && in_reach(&nodes, *x, *y, *z) { beds.push([*x, *y, *z]); }
    }
    // craft
    let held = s.held();
    let mut cr = s.craftable(table.is_some());
    cr.sort_by(|a, b| (held.iter().any(|h| &h.0 == a) as u8).cmp(&(held.iter().any(|h| &h.0 == b) as u8)).then(a.cmp(b)));
    let crl: Vec<Cand> = cr.into_iter().map(|n| { let needs = s.recipe_for(&n, false).is_none(); Cand { cmd: cmd_ix("craft"), args: Args::Craft(n.clone(), if needs { table } else { None }), item: s.d.item(&n), ent: 0, feat: feat(s, None, 1) } }).collect();
    add(&mut parts, "craft", crl);
    // smelt
    if let Some(f) = furnace {
        let mut sl = vec![];
        let mut done: Vec<&str> = vec![];
        for (n, c) in &held {
            if Sim::smelt_result(n).is_none() || done.contains(&n.as_str()) { continue; }
            if !held.iter().any(|(j, _)| j != n && Sim::fuel_value(j) > 0.0) { continue; }
            done.push(n);
            sl.push(Cand { cmd: cmd_ix("smelt"), args: Args::Smelt(n.clone(), f), item: s.d.item(n), ent: 0, feat: feat(s, Some([f[0] as f64 + 0.5, f[1] as f64, f[2] as f64 + 0.5]), *c) });
        }
        sl.sort_by_key(|c| match &c.args { Args::Smelt(n, _) => !n.starts_with("raw_"), _ => true });       // ores first, then the pack's slot order (stable)
        add(&mut parts, "smelt", sl);
    }
    // place
    let mut spot = None;
    for (dx, dz) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1)] {
        let (x, z) = (fx + dx, fz + dz);
        if s.is_air(x, fy, z) && s.kind(x, fy - 1, z) == Kind::Solid { spot = Some([x, fy, z]); break; }
    }
    if let Some(sp) = spot {
        let pl: Vec<Cand> = held.iter().filter(|h| placeable(&h.0)).map(|(n, c)| Cand { cmd: cmd_ix("place"), args: Args::Place(sp, n.clone()), item: s.d.item(n), ent: 0, feat: feat(s, Some([sp[0] as f64 + 0.5, sp[1] as f64, sp[2] as f64 + 0.5]), *c) }).collect();
        let mut pl = pl;
        pl.sort_by_key(|c| match &c.args { Args::Place(_, n) => match n.as_str() { "crafting_table" => 0, "furnace" => 1, _ => 2 }, _ => 2 });       // stations first, then the pack's slot order (stable)
        add(&mut parts, "place", pl);
    }
    // activate (beds)
    let al: Vec<Cand> = beds.into_iter().take(4).map(|b| Cand { cmd: cmd_ix("activate"), args: Args::Activate(b), item: s.d.item(&s.name(b[0], b[1], b[2]).to_string()), ent: 0, feat: feat(s, Some([b[0] as f64 + 0.5, b[1] as f64 + 0.5, b[2] as f64 + 0.5]), 0) }).collect();
    add(&mut parts, "activate", al);
    // eat
    if s.food < 20.0 {
        let el: Vec<Cand> = held.iter().filter(|h| s.d.foods.contains_key(&h.0)).map(|(n, c)| Cand { cmd: cmd_ix("eat"), args: Args::Eat(n.clone()), item: s.d.item(n), ent: 0, feat: feat(s, None, *c) }).collect();
        add(&mut parts, "eat", el);
    }
    let used = 1 + parts.iter().filter(|p| p.0 != "craft").map(|p| p.1.len().min(quota(p.0))).sum::<usize>();       // 1 = wait
    let craft_slots = s.craft_slots.unwrap_or_else(|| quota("craft").max(K.saturating_sub(used)));
    // Presentation audit (2026-11-05): per episode, how often a list was cut by its quota and how often a command that matters (a furnace or table to place,
    // iron to smelt, an iron tool to craft) was on the list but behind the cut; written to the episode_end row (`audit`).
    for (cmd, list) in &parts {
        let q = if *cmd == "craft" { craft_slots } else { quota(cmd) };
        if list.len() > q { *s.audit.entry(format!("cut_{cmd}")).or_default() += 1; }
        for (i, c) in list.iter().enumerate() {
            let key = match &c.args {
                Args::Place(_, n) if n == "furnace" || n == "crafting_table" => Some(format!("place_{n}")),
                Args::Smelt(n, _) if n.contains("iron") => Some(format!("smelt_{n}")),
                Args::Craft(n, _) if n.starts_with("iron_") => Some(format!("craft_{n}")),
                _ => None,
            };
            if let Some(k) = key { *s.audit.entry(format!("on_{k}")).or_default() += 1; if i >= q { *s.audit.entry(format!("hidden_{k}")).or_default() += 1; } }
        }
        *s.audit.entry(format!("calls_{cmd}")).or_default() += 1;
    }
    let mut out: Vec<Cand> = vec![];
    for (cmd, list) in parts { out.extend(list.into_iter().take(if cmd == "craft" { craft_slots } else { quota(cmd) })); }
    out.push(Cand { cmd: cmd_ix("wait"), args: Args::Wait, item: 0, ent: 0, feat: feat(s, None, 0) });
    out.truncate(K);
    out
}
/// skill_space.js `minable`: some node within 5 blocks satisfies the mine command's own goal (reach and an aim point in sight).
fn minable(s: &Sim, nodes: &[[i32; 3]], p: [i32; 3]) -> bool {
    nodes.iter().any(|n| (n[0] - s.pos[0]).abs() <= 10 && (n[2] - s.pos[2]).abs() <= 10 && (n[1] - s.pos[1]).abs() <= 8
        && !(n[0] == p[0] && n[2] == p[2] && n[1] == p[1] + 1)
        && (((n[0] - p[0]) as f64).powi(2) + (n[1] as f64 + EYE - p[1] as f64 - 0.5).powi(2) + ((n[2] - p[2]) as f64).powi(2)).sqrt() <= 5.0 && s.reach_goal(*n, p, None, BLOCK_REACH))
}

pub fn observe(s: &mut Sim, cands: &[Cand], progress: &[f64], last: (usize, i64), clock: [f64; 3]) -> J {
    let [fx, fy, fz] = s.pos;
    let cat = |s: &Sim, x: i32, y: i32, z: i32| -> f64 { match s.blk(x, y, z) { Some(b) => s.d.block(b).cat as f64, None => 10.0 } };
    let mut grid = Vec::with_capacity(405);
    for dy in -2..=2 { for dz in -4..=4 { for dx in -4..=4 { grid.push(cat(s, fx + dx, fy + dy, fz + dz)); } } }
    let t = (s.tick % DAY) as f64 / 24000.0;
    let night = if s.is_night() { 1.0 } else { 0.0 };
    let wet = if s.kind(fx, fy, fz) == Kind::Liquid { 1.0 } else { 0.0 };
    let selfv: Vec<f64> = [s.hp / 20.0, s.food / 20.0, 0.0, 0.0, 0.0, 1.0, 1.0, wet, 0.0, 0.0, (2.0 * std::f64::consts::PI * t).sin(), (2.0 * std::f64::consts::PI * t).cos(), night, 0.0, 1.0, 0.0, 0.0,
        clip(fy as f64 / 128.0), s.yaw.sin(), s.yaw.cos()].iter().map(|x| r4(*x)).collect();
    // entities
    let p = s.center();
    let mut near: Vec<(f64, usize)> = s.mobs.iter().enumerate().map(|(i, m)| (((m.pos[0] as f64 + 0.5 - p[0]).powi(2) + (m.pos[1] as f64 - p[1]).powi(2) + (m.pos[2] as f64 + 0.5 - p[2]).powi(2)).sqrt(), i)).filter(|x| x.0 <= 16.0).collect();
    near.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let (mut et, mut ef) = (vec![], vec![]);
    for i in 0..8 {
        if let Some((d, mi)) = near.get(i) { let m = &s.mobs[*mi]; et.push(J::n(s.d.ent(m.name) as f64));
            ef.push(J::nums(&[r4(clip((m.pos[0] as f64 + 0.5 - p[0]) / 16.0)), r4(clip((m.pos[1] as f64 - p[1]) / 16.0)), r4(clip((m.pos[2] as f64 + 0.5 - p[2]) / 16.0)), r4(d / 16.0), 0.0])); }
        else { et.push(J::n(0.0)); ef.push(J::nums(&[0.0, 0.0, 0.0, 0.0, 0.0])); }
    }
    // view
    let eye = [p[0], fy as f64 + EYE, p[2]];
    let fov = 110.0f64.to_radians();
    let (p0, p1) = ((-60.0f64).to_radians(), 40.0f64.to_radians());
    let (mut vc, mut vi, mut vd) = (vec![], vec![], vec![]);
    for j in 0..VIEW_H {
        let pitch = p1 - (j as f64 + 0.5) * (p1 - p0) / VIEW_H as f64;
        for i in 0..VIEW_W {
            let yaw = s.yaw + fov / 2.0 - (i as f64 + 0.5) * fov / VIEW_W as f64;
            let dir = [-yaw.sin() * pitch.cos(), pitch.sin(), -yaw.cos() * pitch.cos()];
            match s.ray(eye, dir, VIEW_R) {
                Some((c, tt)) => { let b = s.blk(c[0], c[1], c[2]).unwrap_or(s.d.air); let blk = s.d.block(b); vc.push(blk.cat as f64); vi.push(s.d.item(&blk.name) as f64); vd.push(r4(tt / VIEW_R)); }
                None => { vc.push(0.0); vi.push(0.0); vd.push(1.0); }
            }
        }
    }
    let mut kills = vec![0.0; s.d.entities.len()];
    for (n, k) in &s.kills { let i = s.d.ent(n) as usize; if i > 0 { kills[i] = r4((*k).min(64) as f64 / 8.0); } }
    let inv_item: Vec<f64> = s.inv.iter().map(|x| x.map_or(0.0, |s| s.item as f64)).collect();
    let inv_count: Vec<f64> = s.inv.iter().map(|x| x.map_or(0.0, |s| r4(s.n as f64 / 64.0))).collect();
    let pad = |v: Vec<f64>| -> J { let mut v = v; v.resize(K, 0.0); J::nums(&v) };
    let mut feats: Vec<J> = cands.iter().map(|c| J::nums(&c.feat)).collect();
    feats.resize(K, J::nums(&[0.0; 8]));
    J::o(vec![
        ("grid", J::nums(&grid)), ("self", J::nums(&selfv)), ("inv_item", J::nums(&inv_item)), ("inv_count", J::nums(&inv_count)), ("ent_type", J::Arr(et)), ("ent_feat", J::Arr(ef)),
        ("progress", J::nums(&progress.iter().map(|x| r4(*x)).collect::<Vec<_>>())), ("view_cat", J::nums(&vc)), ("view_item", J::nums(&vi)), ("view_dist", J::nums(&vd)), ("killed", J::nums(&kills)),
        ("clock", J::nums(&[r4(clock[0].max(0.0).min(1.0)), r4(clock[1]), r4(clock[2])])),
        ("cand_cmd", pad(cands.iter().map(|c| c.cmd as f64).collect())), ("cand_item", pad(cands.iter().map(|c| c.item as f64).collect())), ("cand_ent", pad(cands.iter().map(|c| c.ent as f64).collect())),
        ("cand_feat", J::Arr(feats)), ("cand_mask", J::Arr((0..K).map(|i| J::Bool(i < cands.len())).collect())), ("last_reason", J::n(last.0 as f64)), ("dt_ticks", J::n(last.1 as f64)),
    ])
}

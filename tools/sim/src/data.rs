//! The simulator's tables (tools/sim/gen_data.js → data/data.json): blocks, recipes, vocabularies, foods.
use crate::json::{self, J};
use std::collections::HashMap;

#[derive(Clone)]
pub struct Block { pub name: String, pub hard: f64, pub diggable: bool, pub kind: Kind, pub cat: u8, pub harvest: Option<Vec<String>>, pub drops: Vec<String>, pub mult: Vec<(String, f64)>,
    /// Shape indexes into `Data::shapes` (tables with block states only): the boxes a view ray hits (world.js shapesOf) and the collision boxes.
    pub aim: u16, pub coll: u16 }
/// The walking kind of a block (world.js kindOf when the tables have block states: `Partial` = some other collision shape, an obstacle that is
/// neither ground nor passable; `Danger` = never step in or on: lava, fire, magma, cactus ...).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind { Air, Passable, Solid, Liquid, Climb, Partial, Danger }
pub const NO_SHAPE: u16 = u16::MAX;
pub struct Recipe { pub result: String, pub count: u32, pub need: Vec<(String, u32)>, pub table: bool }
pub struct Data {
    pub items: Vec<String>, pub entities: Vec<String>, pub item_ix: HashMap<String, u16>, pub ent_ix: HashMap<String, u16>,
    pub blocks: Vec<Block>, pub block_ix: HashMap<String, u16>, pub recipes: Vec<Recipe>, pub foods: HashMap<String, (f64, f64)>, pub unknown: u16, pub air: u16,
    pub cmds: Vec<String>, pub categories: Vec<String>,
    /// Block ids are block STATE ids (tables of a version with `states`): `blocks[state]` is that state's block with its own kind and shapes,
    /// `bid(name)` gives the default state.
    pub states: bool, pub shapes: Vec<Vec<[f64; 6]>>,
    /// Minecraft version of the tables ("" = the built-in 1.20.1 set).
    pub version: String,
}
const RAW: &str = include_str!("../data/data.json");

impl Data {
    /// The built-in tables (minecraft-data 1.20.1 + the RL vocabulary): what `run` and the RL training use.
    pub fn load() -> Data { Data::parse(RAW).expect("data.json") }
    /// Tables of another version (gen_data.js with SIM_MC_VERSION, e.g. data/data-1.21.1.json) for replaying traces recorded on it.
    pub fn from_file(path: &str) -> Result<Data, String> { Data::parse(&std::fs::read_to_string(path).map_err(|e| format!("{}: {}", path, e))?) }
    pub fn parse(raw: &str) -> Result<Data, String> {
        let j = json::parse(raw)?;
        let strs = |k: &str| -> Vec<String> { j.get(k).arr().iter().map(|x| x.s().to_string()).collect() };
        let items = strs("items");
        let entities = strs("entities");
        let item_ix = items.iter().enumerate().map(|(i, n)| (n.clone(), i as u16)).collect();
        let ent_ix = entities.iter().enumerate().map(|(i, n)| (n.clone(), i as u16)).collect();
        let mut blocks = Vec::new();
        let mut block_ix = HashMap::new();
        for (i, b) in j.get("blocks").arr().iter().enumerate() {
            if b.is_null() { blocks.push(Block { name: format!("?{}", i), hard: -1.0, diggable: false, kind: Kind::Solid, cat: 9, harvest: None, drops: vec![], mult: vec![], aim: NO_SHAPE, coll: NO_SHAPE }); continue; }
            let kind = match b.get("k").s() { "air" => Kind::Air, "liquid" => Kind::Liquid, "climb" => Kind::Climb, "passable" => Kind::Passable, _ => Kind::Solid };
            let harvest = if b.get("ht").is_null() { None } else { Some(b.get("ht").arr().iter().map(|x| x.s().to_string()).collect()) };
            blocks.push(Block { name: b.get("n").s().to_string(), hard: b.get("h").f(), diggable: b.get("d").b(), kind, cat: b.get("c").i() as u8, harvest,
                drops: b.get("dr").arr().iter().map(|x| x.s().to_string()).collect(), mult: b.get("tm").obj().iter().map(|(k, v)| (k.clone(), v.f())).collect(), aim: NO_SHAPE, coll: NO_SHAPE });
            block_ix.insert(b.get("n").s().to_string(), i as u16);
        }
        // per-state tables: one Block per state id, with the state's own kind and shapes; names point at the default state
        let has_states = !j.get("states").is_null();
        let shapes: Vec<Vec<[f64; 6]>> = j.get("shapes").arr().iter().map(|l| l.arr().iter().map(|b| { let mut a = [0.0; 6]; for (k, v) in a.iter_mut().enumerate() { *v = b.at(k).f(); } a }).collect()).collect();
        if has_states {
            let base = std::mem::take(&mut blocks);
            let defaults: Vec<i64> = j.get("blocks").arr().iter().map(|b| if b.is_null() { -1 } else { b.get("ds").i() }).collect();
            for st in j.get("states").arr() {
                if st.is_null() { blocks.push(Block { name: "?".into(), hard: -1.0, diggable: false, kind: Kind::Solid, cat: 9, harvest: None, drops: vec![], mult: vec![], aim: NO_SHAPE, coll: NO_SHAPE }); continue; }
                let mut b = base[st.at(0).i() as usize].clone();
                b.kind = match st.at(1).s() { "air" => Kind::Air, "solid" => Kind::Solid, "partial" => Kind::Partial, "water" | "liquid" => Kind::Liquid, "climb" => Kind::Climb, "danger" => Kind::Danger, _ => Kind::Solid };
                b.aim = st.at(2).i() as u16; b.coll = st.at(3).i() as u16;
                blocks.push(b);
            }
            block_ix.clear();
            for (i, b) in base.iter().enumerate() { if defaults[i] >= 0 { block_ix.insert(b.name.clone(), defaults[i] as u16); } }
        }
        let unknown = blocks.len() as u16;
        blocks.push(Block { name: "unknown".into(), hard: -1.0, diggable: false, kind: Kind::Solid, cat: 9, harvest: None, drops: vec![], mult: vec![], aim: NO_SHAPE, coll: NO_SHAPE });
        let recipes = j.get("recipes").arr().iter().map(|r| Recipe { result: r.get("r").s().to_string(), count: r.get("c").i() as u32,
            need: r.get("n").obj().iter().map(|(k, v)| (k.clone(), v.i() as u32)).collect(), table: r.get("t").b() }).collect();
        let foods = j.get("foods").obj().iter().map(|(k, v)| (k.clone(), (v.at(0).f(), v.at(1).f()))).collect();
        let air = *block_ix.get("air").unwrap_or(&0);
        Ok(Data { items, entities, item_ix, ent_ix, blocks, block_ix, recipes, foods, unknown, air, cmds: strs("cmds"), categories: strs("categories"), version: j.get("version").s().to_string(), states: has_states, shapes })
    }
    pub fn item(&self, n: &str) -> u16 { *self.item_ix.get(n).unwrap_or(&0) }
    pub fn ent(&self, n: &str) -> u16 { *self.ent_ix.get(n).unwrap_or(&0) }
    pub fn block(&self, id: u16) -> &Block { self.blocks.get(id as usize).unwrap_or(&self.blocks[self.unknown as usize]) }
    pub fn bid(&self, n: &str) -> u16 { *self.block_ix.get(n).unwrap_or(&self.unknown) }
    /// The aim boxes of a block (state) in cell coordinates: the state's own shapes with per-state tables, else a full cube for anything solid.
    pub fn aim_boxes(&self, id: u16) -> &[[f64; 6]] {
        const FULL: [[f64; 6]; 1] = [[0.0, 0.0, 0.0, 1.0, 1.0, 1.0]];
        let b = self.block(id);
        if b.aim != NO_SHAPE { return &self.shapes[b.aim as usize]; }
        if b.kind == Kind::Solid { &FULL } else { &[] }
    }
}
pub fn kind_json(k: Kind) -> J { J::st(match k { Kind::Air => "air", Kind::Passable => "passable", Kind::Solid => "solid", Kind::Liquid => "liquid", Kind::Climb => "climb", Kind::Partial => "partial", Kind::Danger => "danger" }) }

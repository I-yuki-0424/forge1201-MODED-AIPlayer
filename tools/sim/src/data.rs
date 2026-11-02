//! The simulator's tables (tools/sim/gen_data.js → data/data.json): blocks, recipes, vocabularies, foods.
use crate::json::{self, J};
use std::collections::HashMap;

pub struct Block { pub name: String, pub hard: f64, pub diggable: bool, pub kind: Kind, pub cat: u8, pub harvest: Option<Vec<String>>, pub drops: Vec<String>, pub mult: Vec<(String, f64)> }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind { Air, Passable, Solid, Liquid, Climb }
pub struct Recipe { pub result: String, pub count: u32, pub need: Vec<(String, u32)>, pub table: bool }
pub struct Data {
    pub items: Vec<String>, pub entities: Vec<String>, pub item_ix: HashMap<String, u16>, pub ent_ix: HashMap<String, u16>,
    pub blocks: Vec<Block>, pub block_ix: HashMap<String, u16>, pub recipes: Vec<Recipe>, pub foods: HashMap<String, (f64, f64)>, pub unknown: u16, pub air: u16,
    pub cmds: Vec<String>, pub categories: Vec<String>,
}
const RAW: &str = include_str!("../data/data.json");

impl Data {
    pub fn load() -> Data {
        let j = json::parse(RAW).expect("data.json");
        let strs = |k: &str| -> Vec<String> { j.get(k).arr().iter().map(|x| x.s().to_string()).collect() };
        let items = strs("items");
        let entities = strs("entities");
        let item_ix = items.iter().enumerate().map(|(i, n)| (n.clone(), i as u16)).collect();
        let ent_ix = entities.iter().enumerate().map(|(i, n)| (n.clone(), i as u16)).collect();
        let mut blocks = Vec::new();
        let mut block_ix = HashMap::new();
        for (i, b) in j.get("blocks").arr().iter().enumerate() {
            if b.is_null() { blocks.push(Block { name: format!("?{}", i), hard: -1.0, diggable: false, kind: Kind::Solid, cat: 9, harvest: None, drops: vec![], mult: vec![] }); continue; }
            let kind = match b.get("k").s() { "air" => Kind::Air, "liquid" => Kind::Liquid, "climb" => Kind::Climb, "passable" => Kind::Passable, _ => Kind::Solid };
            let harvest = if b.get("ht").is_null() { None } else { Some(b.get("ht").arr().iter().map(|x| x.s().to_string()).collect()) };
            blocks.push(Block { name: b.get("n").s().to_string(), hard: b.get("h").f(), diggable: b.get("d").b(), kind, cat: b.get("c").i() as u8, harvest,
                drops: b.get("dr").arr().iter().map(|x| x.s().to_string()).collect(), mult: b.get("tm").obj().iter().map(|(k, v)| (k.clone(), v.f())).collect() });
            block_ix.insert(b.get("n").s().to_string(), i as u16);
        }
        let unknown = blocks.len() as u16;
        blocks.push(Block { name: "unknown".into(), hard: -1.0, diggable: false, kind: Kind::Solid, cat: 9, harvest: None, drops: vec![], mult: vec![] });
        let recipes = j.get("recipes").arr().iter().map(|r| Recipe { result: r.get("r").s().to_string(), count: r.get("c").i() as u32,
            need: r.get("n").obj().iter().map(|(k, v)| (k.clone(), v.i() as u32)).collect(), table: r.get("t").b() }).collect();
        let foods = j.get("foods").obj().iter().map(|(k, v)| (k.clone(), (v.at(0).f(), v.at(1).f()))).collect();
        let air = *block_ix.get("air").unwrap_or(&0);
        Data { items, entities, item_ix, ent_ix, blocks, block_ix, recipes, foods, unknown, air, cmds: strs("cmds"), categories: strs("categories") }
    }
    pub fn item(&self, n: &str) -> u16 { *self.item_ix.get(n).unwrap_or(&0) }
    pub fn ent(&self, n: &str) -> u16 { *self.ent_ix.get(n).unwrap_or(&0) }
    pub fn block(&self, id: u16) -> &Block { self.blocks.get(id as usize).unwrap_or(&self.blocks[self.unknown as usize]) }
    pub fn bid(&self, n: &str) -> u16 { *self.block_ix.get(n).unwrap_or(&self.unknown) }
}
pub fn kind_json(k: Kind) -> J { J::st(match k { Kind::Air => "air", Kind::Passable => "passable", Kind::Solid => "solid", Kind::Liquid => "liquid", Kind::Climb => "climb" }) }

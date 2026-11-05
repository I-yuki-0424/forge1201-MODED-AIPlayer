'use strict';
// Colour of a block for the top-down map: exact vanilla entries first, then keyword rules, then a muted colour hashed from the name
// (mod blocks). Returns [r, g, b]. Plain script (also loaded by Node for tests).
(function (root) {
    const EXACT = {
        'minecraft:grass_block': [96, 150, 58], 'minecraft:dirt': [134, 96, 67], 'minecraft:coarse_dirt': [120, 85, 60], 'minecraft:podzol': [92, 68, 40], 'minecraft:mycelium': [112, 96, 112],
        'minecraft:sand': [219, 207, 163], 'minecraft:red_sand': [190, 102, 33], 'minecraft:gravel': [131, 127, 126], 'minecraft:clay': [160, 166, 179], 'minecraft:mud': [60, 57, 60],
        'minecraft:stone': [125, 125, 125], 'minecraft:cobblestone': [118, 118, 118], 'minecraft:deepslate': [80, 80, 84], 'minecraft:bedrock': [50, 50, 50],
        'minecraft:water': [52, 92, 190], 'minecraft:lava': [220, 100, 20], 'minecraft:ice': [150, 190, 250], 'minecraft:packed_ice': [140, 180, 240], 'minecraft:blue_ice': [110, 160, 240],
        'minecraft:snow': [245, 250, 250], 'minecraft:snow_block': [245, 250, 250], 'minecraft:powder_snow': [240, 245, 245], 'minecraft:netherrack': [110, 50, 50], 'minecraft:end_stone': [220, 222, 160],
        'minecraft:obsidian': [20, 18, 30], 'minecraft:farmland': [110, 75, 40], 'minecraft:dirt_path': [148, 122, 65], 'minecraft:terracotta': [152, 94, 67], 'minecraft:glass': [200, 230, 240],
    };
    const RULES = [
        [/(^|:)(water|seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/, [52, 92, 190]], [/lava/, [220, 100, 20]], [/(ice)$/, [150, 190, 250]], [/snow/, [245, 250, 250]],
        [/leaves/, [48, 120, 40]], [/(^|_)(log|wood|stem|hyphae)$/, [102, 81, 50]], [/planks|fence|stairs$|slab$/, [160, 130, 80]], [/sand/, [219, 207, 163]], [/grass|fern|moss/, [96, 150, 58]],
        [/deepslate/, [80, 80, 84]], [/cobble|stone|andesite|diorite|granite|tuff|calcite|basalt|blackstone/, [125, 125, 125]], [/dirt|mud|podzol|farmland|path/, [134, 96, 67]],
        [/terracotta|concrete|wool|glass|carpet/, [170, 170, 190]], [/brick/, [150, 97, 83]], [/ore$/, [140, 140, 140]], [/netherrack|nether|crimson|warped/, [110, 50, 50]], [/iron|steel|copper|brass|andesite_alloy|casing/, [160, 140, 120]],
    ];
    const cache = new Map();
    function blockColor(name) {
        let c = cache.get(name);
        if (c) return c;
        c = EXACT[name];
        if (!c) { const hit = RULES.find(([re]) => re.test(name)); c = hit ? hit[1] : null; }
        if (!c) {                                          // unknown (mod) block: stable muted colour from the name
            let x = 7; for (let i = 0; i < name.length; i++) x = (Math.imul(x, 31) + name.charCodeAt(i)) >>> 0;
            c = [90 + (x & 0x5f), 90 + ((x >> 8) & 0x5f), 90 + ((x >> 16) & 0x5f)];
        }
        cache.set(name, c);
        return c;
    }
    /** Fill `rgba` (Uint8ClampedArray, side*side*4) from a region payload { names, idx, h }: colour by block, shade by the height step to the north. */
    function paintRegion(names, idx, h, rgba, side) {
        const cols = names.map(blockColor);
        for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
            const i = z * side + x, k = idx[i], o = i * 4;
            if (!k) { rgba[o + 3] = 0; continue; }
            const c = cols[k - 1] || [128, 128, 128];
            const north = z > 0 && idx[i - side] ? h[i - side] : h[i], d = Math.max(-3, Math.min(3, h[i] - north));
            const f = 1 + d * 0.09, water = names[k - 1] === 'minecraft:water';
            rgba[o] = c[0] * (water ? 1 : f); rgba[o + 1] = c[1] * (water ? 1 : f); rgba[o + 2] = c[2] * (water ? 1 : f); rgba[o + 3] = 255;
        }
    }
    const api = { blockColor, paintRegion };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BlockColor = api;
})(typeof window !== 'undefined' ? window : globalThis);

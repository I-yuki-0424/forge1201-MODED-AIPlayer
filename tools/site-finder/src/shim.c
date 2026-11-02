// The three cubiomes calls the site finder needs, behind an opaque handle (Generator and SurfaceNoise stay C-side).
#include <stdlib.h>
#include "generator.h"

typedef struct { Generator g; SurfaceNoise sn; } Ctx;

void *sf_new(uint64_t seed) {
    Ctx *c = malloc(sizeof(Ctx));
    if (!c) return NULL;
    setupGenerator(&c->g, MC_1_20, 0);
    applySeed(&c->g, DIM_OVERWORLD, seed);
    initSurfaceNoise(&c->sn, DIM_OVERWORLD, seed);
    return c;
}

void sf_free(void *c) { free(c); }

// Biome at block (x, z), sampled at sea level (y 63) on the 1:4 biome grid.
int sf_biome(void *c, int x, int z) { return getBiomeAt(&((Ctx *)c)->g, 4, x >> 2, 63 >> 2, z >> 2); }

// 0 = water or shore (oceans, rivers, beaches: what an island is surrounded by), 2 = a biome whose generation places trees
// densely (forests, taigas, jungles), 1 = other land.
int sf_class(int id) {
    if (isOceanic(id)) return 0;
    switch (id) {
    case river: case frozen_river: case beach: case snowy_beach: case stony_shore: return 0;
    case forest: case flower_forest: case birch_forest: case old_growth_birch_forest: case dark_forest: case taiga: case snowy_taiga:
    case old_growth_pine_taiga: case old_growth_spruce_taiga: case jungle: case sparse_jungle: case bamboo_jungle:
    case windswept_forest: case cherry_grove: return 2;
    default: return 1;
    }
}

// Approximate surface height in blocks at block (x, z).
float sf_height(void *c, int x, int z) {
    float y = 0;
    int id = 0;
    if (mapApproxHeight(&y, &id, &((Ctx *)c)->g, &((Ctx *)c)->sn, x >> 2, z >> 2, 1, 1)) return -1000.0f;
    return y;
}

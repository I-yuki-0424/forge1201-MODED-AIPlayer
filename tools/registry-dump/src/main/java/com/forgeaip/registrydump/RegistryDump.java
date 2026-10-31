package com.forgeaip.registrydump;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.IdMapper;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BooleanProperty;
import net.minecraft.world.level.block.state.properties.IntegerProperty;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.fml.ModList;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.ForgeRegistry;
import net.minecraftforge.registries.GameData;
import net.minecraftforge.versions.forge.ForgeVersion;
import org.slf4j.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Writes the block and item tables of the running server (TASK-20261031-020) so the bot can name mod blocks and items
 * exactly: per block its registry id, state-id range, state properties in wire order, collision boxes per state, hardness
 * and tool tags; per mod item its id and stack size. Runs once on a disposable server (scripts/world/registry-dump.sh),
 * never in the build world: FORGEAIP_DUMP = output file, FORGEAIP_DUMP_HALT=1 stops the server afterwards.
 */
@Mod(RegistryDump.MOD_ID)
public final class RegistryDump {
    public static final String MOD_ID = "forgeaip_registrydump";
    private static final Logger LOG = LogUtils.getLogger();

    public RegistryDump() {
        MinecraftForge.EVENT_BUS.addListener(this::onStarted);
    }

    private void onStarted(ServerStartedEvent event) {
        Path out = Path.of(System.getenv().getOrDefault("FORGEAIP_DUMP", "forgeaip-registry-dump.json"));
        try {
            Files.writeString(out, new GsonBuilder().disableHtmlEscaping().create().toJson(dump()));
            LOG.info("[registrydump] wrote {}", out.toAbsolutePath());
        } catch (Exception e) {
            LOG.error("[registrydump] failed", e);
        }
        if ("1".equals(System.getenv("FORGEAIP_DUMP_HALT"))) event.getServer().halt(false);
    }

    private static JsonObject dump() {
        IdMapper<BlockState> stateIds = GameData.getBlockStateIDMap();
        ForgeRegistry<Block> blocks = (ForgeRegistry<Block>) ForgeRegistries.BLOCKS;
        ForgeRegistry<Item> items = (ForgeRegistry<Item>) ForgeRegistries.ITEMS;
        JsonObject root = new JsonObject();
        root.addProperty("format", 1);
        root.addProperty("minecraft", SharedConstants.getCurrentVersion().getName());
        root.addProperty("forge", ForgeVersion.getVersion());
        JsonArray mods = new JsonArray();
        ModList.get().getMods().forEach(m -> mods.add(m.getModId() + "@" + m.getVersion()));
        root.add("mods", mods);
        root.addProperty("blockStates", stateIds.size());

        Map<String, Integer> shapeIndex = new HashMap<>();
        JsonArray shapes = new JsonArray();
        JsonArray problems = new JsonArray();
        JsonArray jb = new JsonArray();
        for (Block block : blocks) {                      // registry-id order = the order state ids are assigned in
            ResourceLocation rl = blocks.getKey(block);
            List<BlockState> states = block.getStateDefinition().getPossibleStates();
            int min = stateIds.getId(states.get(0));
            JsonObject b = new JsonObject();
            b.addProperty("name", rl.toString());
            b.addProperty("id", blocks.getID(block));
            b.addProperty("minStateId", min);
            b.addProperty("states", states.size());
            for (int i = 0; i < states.size(); i++)
                if (stateIds.getId(states.get(i)) != min + i) { problems.add(rl + ": state ids not contiguous"); break; }
            if (!"minecraft".equals(rl.getNamespace())) describe(block, states, b, shapeIndex, shapes, problems);
            jb.add(b);
        }
        root.add("blocks", jb);
        root.add("shapes", shapes);

        JsonArray ji = new JsonArray();
        for (Item item : items) {
            ResourceLocation rl = items.getKey(item);
            if ("minecraft".equals(rl.getNamespace())) continue;
            JsonObject o = new JsonObject();
            o.addProperty("name", rl.toString());
            o.addProperty("id", items.getID(item));
            o.addProperty("stackSize", item.getMaxStackSize());
            ji.add(o);
        }
        root.add("items", ji);
        root.add("problems", problems);
        return root;
    }

    /** Properties, shapes and digging data of one mod block. */
    private static void describe(Block block, List<BlockState> states, JsonObject b, Map<String, Integer> shapeIndex,
                                 JsonArray shapes, JsonArray problems) {
        String name = String.valueOf(ForgeRegistries.BLOCKS.getKey(block));
        BlockState d = block.defaultBlockState();
        b.addProperty("defaultState", states.indexOf(d));
        List<Property<?>> props = new ArrayList<>(block.getStateDefinition().getProperties());
        JsonArray jp = new JsonArray();
        for (Property<?> p : props) {
            JsonObject o = new JsonObject();
            o.addProperty("name", p.getName());
            o.addProperty("type", p instanceof BooleanProperty ? "bool" : p instanceof IntegerProperty ? "int" : "enum");
            JsonArray values = new JsonArray();
            for (Object v : p.getPossibleValues()) values.add(valueName(p, v));
            o.add("values", values);
            jp.add(o);
        }
        b.add("properties", jp);

        // The bot decodes a state index with the last property varying fastest (prismarine-block); check that here.
        for (int i = 0; i < states.size(); i++) {
            int idx = i;
            for (int k = props.size() - 1; k >= 0; k--) {
                Property<?> p = props.get(k);
                List<?> values = new ArrayList<>(p.getPossibleValues());
                if (!values.get(idx % values.size()).equals(states.get(i).getValue(p))) { problems.add(name + ": state order"); i = states.size(); break; }
                idx /= values.size();
            }
        }

        JsonArray perState = new JsonArray();
        boolean same = true;
        int first = -1;
        for (BlockState s : states) {
            String key;
            JsonArray boxes = new JsonArray();
            try {
                for (AABB a : s.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).toAabbs()) {
                    JsonArray box = new JsonArray();
                    for (double v : new double[]{a.minX, a.minY, a.minZ, a.maxX, a.maxY, a.maxZ}) box.add(Math.round(v * 1e6) / 1e6);
                    boxes.add(box);
                }
            } catch (Exception e) {
                problems.add(name + ": collision shape needs a level (" + e.getClass().getSimpleName() + "), full block used");
                boxes = new JsonArray();
                JsonArray full = new JsonArray();
                for (double v : new double[]{0, 0, 0, 1, 1, 1}) full.add(v);
                boxes.add(full);
            }
            key = boxes.toString();
            Integer id = shapeIndex.get(key);
            if (id == null) { id = shapes.size(); shapeIndex.put(key, id); shapes.add(boxes); }
            if (first < 0) first = id; else if (id != first) same = false;
            perState.add(id);
        }
        if (same) b.addProperty("shape", first); else b.add("shape", perState);

        b.addProperty("hardness", d.getDestroySpeed(EmptyBlockGetter.INSTANCE, BlockPos.ZERO));
        b.addProperty("resistance", block.getExplosionResistance());
        b.addProperty("air", d.isAir());
        b.addProperty("liquid", block instanceof LiquidBlock);
        b.addProperty("transparent", !d.canOcclude());
        b.addProperty("light", d.getLightEmission());
        b.addProperty("requiresTool", d.requiresCorrectToolForDrops());
        String tool = d.is(BlockTags.MINEABLE_WITH_PICKAXE) ? "pickaxe" : d.is(BlockTags.MINEABLE_WITH_AXE) ? "axe"
                : d.is(BlockTags.MINEABLE_WITH_SHOVEL) ? "shovel" : d.is(BlockTags.MINEABLE_WITH_HOE) ? "hoe" : null;
        if (tool != null) b.addProperty("tool", tool);
        String tier = d.is(BlockTags.NEEDS_DIAMOND_TOOL) ? "diamond" : d.is(BlockTags.NEEDS_IRON_TOOL) ? "iron"
                : d.is(BlockTags.NEEDS_STONE_TOOL) ? "stone" : null;
        if (tier != null) b.addProperty("tier", tier);
        ResourceLocation item = ForgeRegistries.ITEMS.getKey(block.asItem());
        if (item != null && !"minecraft:air".equals(item.toString())) b.addProperty("item", item.toString());
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static String valueName(Property p, Object v) {
        return p.getName((Comparable) v);
    }
}

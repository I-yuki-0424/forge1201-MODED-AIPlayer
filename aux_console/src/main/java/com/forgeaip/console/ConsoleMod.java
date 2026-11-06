package com.forgeaip.console;

import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraftforge.common.ForgeConfigSpec;
import net.minecraftforge.event.BuildCreativeModeTabContentsEvent;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.ModLoadingContext;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.config.ModConfig;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

/**
 * ForgeAIP Console: the work console inside the game. Common part (both sides): the Tag Tool item. The web view and the key are client only
 * (client/ package, which needs MCEF); a dedicated server loads this class and the item, nothing else.
 */
@Mod(ConsoleMod.ID)
public class ConsoleMod {
    public static final String ID = "aipconsole";

    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, ID);
    public static final RegistryObject<Item> TAG_TOOL = ITEMS.register("tag_tool", () -> new TagToolItem(new Item.Properties().stacksTo(1)));

    public ConsoleMod() {
        IEventBus bus = FMLJavaModLoadingContext.get().getModEventBus();
        ITEMS.register(bus);
        bus.addListener((BuildCreativeModeTabContentsEvent e) -> { if (e.getTabKey() == CreativeModeTabs.TOOLS_AND_UTILITIES) e.accept(TAG_TOOL); });
        ModLoadingContext.get().registerConfig(ModConfig.Type.CLIENT, ClientConfig.SPEC);        // only read on a client
    }

    /** config/aipconsole-client.toml: where the console is and how to sign in. */
    public static final class ClientConfig {
        public static final ForgeConfigSpec SPEC;
        public static final ForgeConfigSpec.ConfigValue<String> URL, TOKEN;
        public static final ForgeConfigSpec.BooleanValue KIOSK;
        static {
            ForgeConfigSpec.Builder b = new ForgeConfigSpec.Builder();
            URL = b.comment("Address of the work console (the tailnet address of the VPS).").define("url", "http://100.77.246.23:3021/");
            TOKEN = b.comment("The console's access token (console.token). Sent only to the console, as a #fragment that no server sees. Empty: sign in by hand once.").define("token", "");
            KIOSK = b.comment("Larger controls for the in-game window.").define("kiosk", true);
            SPEC = b.build();
        }
        private ClientConfig() { }

        /** The address to open: the console, the sign-in fragment, and `extra` (for example goto=tags&x=1&y=2&z=3). */
        public static String address(String extra) {
            String base = URL.get().trim().replaceAll("#.*$", "");
            StringBuilder frag = new StringBuilder();
            if (!TOKEN.get().isBlank()) frag.append("token=").append(TOKEN.get().trim());
            if (KIOSK.get()) frag.append(frag.length() > 0 ? "&" : "").append("kiosk");
            if (extra != null && !extra.isEmpty()) frag.append(frag.length() > 0 ? "&" : "").append(extra);
            return frag.length() > 0 ? base + "#" + frag : base;
        }
    }
}

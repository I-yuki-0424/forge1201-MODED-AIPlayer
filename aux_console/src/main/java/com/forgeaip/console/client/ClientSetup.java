package com.forgeaip.console.client;

import com.forgeaip.console.ConsoleMod;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RegisterKeyMappingsEvent;
import net.minecraftforge.client.settings.KeyConflictContext;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import org.lwjgl.glfw.GLFW;

/** The key that opens the console (F12 by default, rebindable in Controls). Client only. */
public final class ClientSetup {
    public static final KeyMapping OPEN = new KeyMapping("key.aipconsole.open", KeyConflictContext.IN_GAME, InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F12, "key.categories.aipconsole");

    private ClientSetup() { }

    @Mod.EventBusSubscriber(modid = ConsoleMod.ID, bus = Mod.EventBusSubscriber.Bus.MOD, value = Dist.CLIENT)
    public static final class ModBus {
        @SubscribeEvent
        public static void keys(RegisterKeyMappingsEvent e) { e.register(OPEN); }
    }

    @Mod.EventBusSubscriber(modid = ConsoleMod.ID, bus = Mod.EventBusSubscriber.Bus.FORGE, value = Dist.CLIENT)
    public static final class ForgeBus {
        @SubscribeEvent
        public static void tick(TickEvent.ClientTickEvent e) {
            if (e.phase != TickEvent.Phase.END) return;
            while (OPEN.consumeClick()) if (Minecraft.getInstance().screen == null) ClientActions.open(null);
        }
    }
}

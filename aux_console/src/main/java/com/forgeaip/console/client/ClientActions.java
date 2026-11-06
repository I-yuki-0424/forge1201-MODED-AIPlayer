package com.forgeaip.console.client;

import com.cinemamod.mcef.MCEF;
import com.forgeaip.console.ConsoleMod;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;

/** What the key and the tag tool do on the client (this class is only loaded there). */
public final class ClientActions {
    private ClientActions() { }

    /** Open the console in a full-screen web view; `extra` goes into the address fragment. */
    public static void open(String extra) {
        Minecraft mc = Minecraft.getInstance();
        if (!MCEF.isInitialized()) {
            if (mc.player != null) mc.player.displayClientMessage(Component.translatable("aipconsole.browser.starting"), false);
            return;
        }
        mc.setScreen(new WebViewScreen(ConsoleMod.ClientConfig.address(extra)));
    }

    /** The Tags page, with the coordinates of `pos` filled in (and the block's name as a hint). */
    public static void openTags(BlockPos pos, String block) {
        open("goto=tags&x=" + pos.getX() + "&y=" + pos.getY() + "&z=" + pos.getZ());
    }
}

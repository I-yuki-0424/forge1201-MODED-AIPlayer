package com.forgeaip.tickrate;

import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.logging.LogUtils;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.RegisterCommandsEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.fml.common.Mod;
import org.slf4j.Logger;

/**
 * Server clock multiplier (owner 2026-11-01: time, movement and mining all faster by the same factor). The factor comes from
 * FORGEAIP_TICKRATE at start (default 1) and from `/tickrate <factor>` (op level 2) at run time; `/tickrate` reports the
 * factor and the measured rate. The server can only go as fast as its tick work allows: when a tick takes longer than
 * 50 / factor ms the rate falls short, which the report shows (mean tick time).
 */
@Mod("forgeaip_tickrate")
public final class TickRate {
    private static final Logger LOG = LogUtils.getLogger();
    private static final double MIN = 0.25, MAX = 10.0;
    private static volatile double factor = 1.0;
    private static volatile long msPerTick = 50L;
    private static long windowStart = System.nanoTime(), windowTicks = 0;
    private static volatile double measured = 20.0;

    public TickRate() {
        String env = System.getenv("FORGEAIP_TICKRATE");
        if (env != null && !env.isBlank()) {
            try { set(Double.parseDouble(env.trim())); } catch (IllegalArgumentException e) { LOG.error("FORGEAIP_TICKRATE={} ignored: {}", env, e.getMessage()); }
        }
        MinecraftForge.EVENT_BUS.addListener(TickRate::onTick);
        MinecraftForge.EVENT_BUS.addListener(TickRate::onCommands);
        LOG.info("tick rate x{} ({} ms per tick)", factor, msPerTick);
    }

    public static long msPerTick() { return msPerTick; }

    static void set(double f) {
        if (!(f >= MIN && f <= MAX)) throw new IllegalArgumentException("factor must be in [" + MIN + ", " + MAX + "]");
        factor = f;
        msPerTick = Math.max(1L, Math.round(50.0 / f));
    }

    private static void onTick(TickEvent.ServerTickEvent e) {
        if (e.phase != TickEvent.Phase.END) return;
        windowTicks++;
        long now = System.nanoTime();
        if (now - windowStart >= 5_000_000_000L) {
            measured = windowTicks * 1e9 / (now - windowStart);
            windowStart = now;
            windowTicks = 0;
        }
    }

    private static String report(net.minecraft.server.MinecraftServer server) {
        return String.format("tickrate %.2f (%d ms per tick): measured %.1f ticks/s (target %.1f), mean tick %.1f ms",
                factor, msPerTick, measured, 1000.0 / msPerTick, server.getAverageTickTime());
    }

    private static void onCommands(RegisterCommandsEvent e) {
        e.getDispatcher().register(Commands.literal("tickrate").requires(s -> s.hasPermission(2))
                .executes(c -> { c.getSource().sendSuccess(() -> Component.literal(report(c.getSource().getServer())), false); return 1; })
                .then(Commands.argument("factor", DoubleArgumentType.doubleArg(MIN, MAX)).executes(c -> {
                    set(DoubleArgumentType.getDouble(c, "factor"));
                    LOG.info("tick rate set to x{} ({} ms per tick)", factor, msPerTick);
                    c.getSource().sendSuccess(() -> Component.literal(report(c.getSource().getServer())), true);
                    return 1;
                })));
    }
}

package com.forgeaip.tickrate.mixin;

import com.forgeaip.tickrate.TickRate;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.Constant;
import org.spongepowered.asm.mixin.injection.ModifyConstant;

/**
 * Every 50 in MinecraftServer.runServer (1.20.1) is the length of one tick in milliseconds: the next tick's due time, the
 * overload catch-up and the deadline for delayed tasks. Replacing all of them with one value changes the clock and nothing
 * else: every game rule that counts ticks (day length, movement per tick, dig progress, growth, AI) speeds up together.
 */
@Mixin(MinecraftServer.class)
public abstract class MinecraftServerMixin {
    @ModifyConstant(method = "runServer", constant = @Constant(longValue = 50L), require = 3)
    private long forgeaip$msPerTick(long ms) {
        return TickRate.msPerTick();
    }
}

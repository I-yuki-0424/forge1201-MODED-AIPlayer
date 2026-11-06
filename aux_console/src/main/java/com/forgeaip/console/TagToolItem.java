package com.forgeaip.console;

import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.Level;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.DistExecutor;
import net.minecraftforge.registries.ForgeRegistries;

/**
 * The tagging item. Right-click a block: a line says what it is and where. Shift + right-click: the console's Tags page opens in the game
 * for that block (coordinates filled in), where the tags, label and link are set. The item changes nothing in the world and
 * runs before the block's own use, so a chest does not open.
 */
public class TagToolItem extends Item {
    public TagToolItem(Properties props) { super(props); }

    @Override
    public InteractionResult onItemUseFirst(ItemStack stack, UseOnContext ctx) {
        Level level = ctx.getLevel();
        Player player = ctx.getPlayer();
        BlockPos pos = ctx.getClickedPos();
        if (level.isClientSide && player != null) {
            String block = String.valueOf(ForgeRegistries.BLOCKS.getKey(level.getBlockState(pos).getBlock()));
            if (player.isShiftKeyDown()) DistExecutor.unsafeRunWhenOn(Dist.CLIENT, () -> () -> com.forgeaip.console.client.ClientActions.openTags(pos, block));
            else player.displayClientMessage(Component.translatable("aipconsole.tool.info", block, pos.getX(), pos.getY(), pos.getZ()), true);
        }
        return InteractionResult.sidedSuccess(level.isClientSide);
    }
}

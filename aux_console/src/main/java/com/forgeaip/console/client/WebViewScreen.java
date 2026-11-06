package com.forgeaip.console.client;

import com.cinemamod.mcef.MCEF;
import com.cinemamod.mcef.MCEFBrowser;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.BufferBuilder;
import com.mojang.blaze3d.vertex.DefaultVertexFormat;
import com.mojang.blaze3d.vertex.Tesselator;
import com.mojang.blaze3d.vertex.VertexFormat;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.network.chat.Component;

/**
 * A full-screen web view over the game (MCEF, Chromium): the work console as a page, like the web view of a game's shop screen.
 * Closes with Escape or the key that opened it (F12). Structure after MCEF's own ExampleScreen (mouse and key forwarding, GUI-scale
 * conversion, texture drawn as one quad); only the address, the margin and the close key differ.
 */
public class WebViewScreen extends Screen {
    private static final int MARGIN = 8;
    private final String url;
    private MCEFBrowser browser;

    public WebViewScreen(String url) {
        super(Component.literal("ForgeAIP Console"));
        this.url = url;
    }

    @Override
    protected void init() {
        super.init();
        if (browser == null) {
            browser = MCEF.createBrowser(url, false);
            resizeBrowser();
        }
    }

    private double scale() { return minecraft.getWindow().getGuiScale(); }
    private int mx(double x) { return (int) ((x - MARGIN) * scale()); }
    private int my(double y) { return (int) ((y - MARGIN) * scale()); }

    private void resizeBrowser() {
        if (browser != null && width > 100 && height > 100) browser.resize((int) ((width - MARGIN * 2) * scale()), (int) ((height - MARGIN * 2) * scale()));
    }

    @Override
    public void resize(net.minecraft.client.Minecraft mc, int w, int h) { super.resize(mc, w, h); resizeBrowser(); }

    @Override
    public void onClose() {
        if (browser != null) { browser.close(); browser = null; }
        super.onClose();
    }

    @Override
    public boolean isPauseScreen() { return false; }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partial) {
        renderBackground(g);
        super.render(g, mouseX, mouseY, partial);
        if (browser == null) return;
        RenderSystem.disableDepthTest();
        RenderSystem.enableBlend();
        RenderSystem.setShader(GameRenderer::getPositionTexColorShader);
        RenderSystem.setShaderTexture(0, browser.getRenderer().getTextureID());
        BufferBuilder b = Tesselator.getInstance().getBuilder();
        b.begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_TEX_COLOR);
        b.vertex(MARGIN, height - MARGIN, 0).uv(0f, 1f).color(255, 255, 255, 255).endVertex();
        b.vertex(width - MARGIN, height - MARGIN, 0).uv(1f, 1f).color(255, 255, 255, 255).endVertex();
        b.vertex(width - MARGIN, MARGIN, 0).uv(1f, 0f).color(255, 255, 255, 255).endVertex();
        b.vertex(MARGIN, MARGIN, 0).uv(0f, 0f).color(255, 255, 255, 255).endVertex();
        Tesselator.getInstance().end();
        RenderSystem.setShaderTexture(0, 0);
        RenderSystem.enableDepthTest();
    }

    @Override
    public boolean mouseClicked(double x, double y, int button) {
        if (browser != null) { browser.sendMousePress(mx(x), my(y), button); browser.setFocus(true); }
        return super.mouseClicked(x, y, button);
    }

    @Override
    public boolean mouseReleased(double x, double y, int button) {
        if (browser != null) { browser.sendMouseRelease(mx(x), my(y), button); browser.setFocus(true); }
        return super.mouseReleased(x, y, button);
    }

    @Override
    public void mouseMoved(double x, double y) {
        if (browser != null) browser.sendMouseMove(mx(x), my(y));
        super.mouseMoved(x, y);
    }

    @Override
    public boolean mouseDragged(double x, double y, int button, double dx, double dy) {
        if (browser != null) browser.sendMouseMove(mx(x), my(y));
        return super.mouseDragged(x, y, button, dx, dy);
    }

    @Override
    public boolean mouseScrolled(double x, double y, double delta) {
        if (browser != null) browser.sendMouseWheel(mx(x), my(y), delta, 0);
        return super.mouseScrolled(x, y, delta);
    }

    @Override
    public boolean keyPressed(int keyCode, int scanCode, int modifiers) {
        if (ClientSetup.OPEN.matches(keyCode, scanCode)) { onClose(); return true; }          // the key that opened it closes it
        if (browser != null) { browser.sendKeyPress(keyCode, scanCode, modifiers); browser.setFocus(true); }
        return super.keyPressed(keyCode, scanCode, modifiers);
    }

    @Override
    public boolean keyReleased(int keyCode, int scanCode, int modifiers) {
        if (browser != null) { browser.sendKeyRelease(keyCode, scanCode, modifiers); browser.setFocus(true); }
        return super.keyReleased(keyCode, scanCode, modifiers);
    }

    @Override
    public boolean charTyped(char c, int modifiers) {
        if (browser != null) { browser.sendKeyTyped(c, modifiers); browser.setFocus(true); }
        return super.charTyped(c, modifiers);
    }
}

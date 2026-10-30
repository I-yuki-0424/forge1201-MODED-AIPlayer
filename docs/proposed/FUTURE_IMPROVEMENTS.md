# Future Improvements
## Ender Dragon AI State Tracking
Currently, the `_killEnderDragon` action heuristic attempts to predict the Ender Dragon's behavior state (e.g., Flying vs. Perching) by checking if `dragon.velocity` is near zero on all axes (`Math.abs(dv.x) < 0.1 && Math.abs(dv.z) < 0.1 && Math.abs(dv.y) < 0.05`).

This is unreliable due to network interpolation and noise. A better approach for the future would be to develop a companion/auxiliary server-side mod that directly exposes the Ender Dragon's AI `Phase` (e.g., `Phase.LANDING`, `Phase.SITTING_FLAMING`) to the Mineflayer bot. This would allow the bot to optimally time its attacks, precisely dodge dragon breath, and avoid wasting time reacting to delayed velocity data.

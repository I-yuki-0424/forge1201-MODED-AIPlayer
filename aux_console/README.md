# aux_console: the work console inside the game (Forge 1.20.1 mod, id `aipconsole`)

- **F12** (rebindable in Controls, "ForgeAIP Console") opens the work console in a full-screen web view (MCEF, Chromium); Esc or F12 closes it.
- **Tag Tool** (`/give @s aipconsole:tag_tool`, also in the creative Tools tab): right-click a block shows what and where; **shift + right-click** opens the console's
  Tags page for that block (coordinates filled in; an already tagged block opens for editing), where tags, label and link are set. It changes nothing in the world.
- Client config `config/aipconsole-client.toml`: `url` (default `http://100.77.246.23:3021/`), `token` (the console token; sent only as a `#fragment` that no server
  sees, empty = sign in by hand once), `kiosk` (larger controls).
- Needs **MCEF 2.1.6** on the client (it downloads Chromium on the first start). The server only needs this jar (the item); MCEF is a client dependency.
- Sign-in and security are the console's own (token, session cookie, CSRF); nothing here talks to the server except the normal game connection.

Build (JDK 17, no Node needed; first run downloads Forge and Minecraft, about 2 minutes here):

    mkdir -p libs && curl -L -o libs/mcef-2.1.6-1.20.1.jar https://cdn.modrinth.com/data/TObQ0HxZ/versions/x91l6OKB/mcef-forge-2.1.6-1.20.1.jar   # compile-time only, not committed
    docker run --rm -v "$PWD":/w -w /w -v gradle-forgeaip:/root/.gradle eclipse-temurin:17-jdk ./gradlew --no-daemon build     # build/libs/aipconsole-0.1.0.jar

Not tested in a real client (none here): the rendering follows MCEF's own ExampleScreen (same calls, checked against the jar with javap), compiled against the real MCEF jar.
The older `aux_mod/` (block registry export, HUD) is a separate, unused project.

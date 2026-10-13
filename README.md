# FERAL

**Early development build — not released yet.** Expect things to change and break.

FERAL is a multiplayer zombie tag FPS that runs in the browser. One player turns into the zombie and hunts everyone else; the survivors just have to make it to the end of the round. It's set in a container yard at night, and rounds last 150 seconds.

Built with three.js, Vite, and a small Node WebSocket server that handles all the game logic.

## How it plays

**Survivors** pick a class in the lobby:
- **SWAT**: M4 rifle and a pistol. Grab ammo crates to keep shooting.
- **Hunter**: a bow with unlimited arrows. The longer you draw, the harder it hits.

When a survivor goes down, they can still crawl around while bleeding out. A teammate can hold **F** to bring them back with CPR.

**The zombie** is picked at random from the survivors each round (never the same person twice in a row). It's stuck in place for the first 5 seconds, then it gets:
- a charged super jump that slams the ground on landing
- a rage mode that makes it faster than any survivor and heals it

## Controls

| Key | Survivor | Zombie |
|---|---|---|
| WASD / Shift | Move / sprint | Move / sprint |
| Space | Jump | Tap to jump, hold and release to super jump |
| Left click | Shoot / draw bow | Punch |
| R | Reload | Rage |
| 1 / 2 | Rifle / pistol | |
| Hold F | Revive a downed teammate | |
| Ctrl + 1 / 2 / 3 | Dance | Dance |
| Esc | Menu | Menu |

The settings menu has mouse sensitivity, volume, and a Korean/English toggle. You can also start a solo practice round against bots from the lobby.

## Running it locally

```bash
npm install
npm run dev
```

Then open http://localhost:5173. This starts both Vite and the game server (port 3000), and both reload automatically when you change code. You need two players to start a real round; two browser windows on the same machine work fine.

Add `?offline` to the URL if you only want to work on the menus and UI without connecting to the server.

All the balance numbers live in `shared/config.js` and `shared/loadout.js`. Both the server and the client read them.

## Deploying

```bash
npm run pack
```

This builds the client and bundles it with the server into `feral.tgz`. In production, one Node process serves both the static files and the WebSocket on a single port.

The `deploy/` folder has scripts for an Ubuntu box:
- `setup.sh`: Node 22, Caddy for automatic HTTPS, and a systemd service
- `update.sh`: swaps in a new build
- `gcp.sh`: does the same steps from Google Cloud Shell

## Project layout

```
shared/   game config, map collision, network protocol (used by server and client)
server/   authoritative game server, rounds, practice bots and their pathfinding
src/      client: input, networking, player, combat, animation, map, audio, UI
public/   models, textures, sounds, UI art
tools/    asset build scripts (turn source FBX/glTF files into the lightweight GLBs in public/)
deploy/   server setup and update scripts
```

The asset build scripts read source files that aren't in this repo. You only need them to rebuild the models, not to run the game.

## Credits

- 3D models and textures: Sketchfab (CC BY 4.0) and Poly Haven (CC0). Full attribution is in [`public/models/CREDITS.md`](public/models/CREDITS.md).
- Character animations: Adobe Mixamo.
- Sound effects: [Freesound](https://freesound.org).
- The round-start music isn't included in this repo for licensing reasons. The game just skips it if the file is missing.

## License

All rights reserved. The source is public so people can read it, but please don't copy, modify, or redistribute it. Third-party assets are covered by their own licenses.

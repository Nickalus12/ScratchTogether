# ScratchTogether

TurboWarp (Scratch fork) with real-time multiplayer coding bolted on. Built for
coding together with your kid — name-only login, live block editing, cursors,
and presence.

## Layout

| Path | What |
|---|---|
| `scratch-gui/` | TurboWarp editor (clone of `TurboWarp/scratch-gui`) + collab client in `src/lib/collab/` |
| `collab-server/` | Node WebSocket relay + static host (port 4455). Rooms persist to `collab-server/rooms/*.sb3` |
| `start.cmd` | Double-click launcher |

## Run it

```cmd
start.cmd
```

Or manually:

```bash
# terminal 1 — multiplayer server (also serves the built editor at :4455)
cd collab-server && node server.js

# terminal 2 — dev editor (only needed if you haven't built)
cd scratch-gui
NODE_OPTIONS=--openssl-legacy-provider npm start   # http://localhost:8601
```

Production build (then :4455 serves everything, one process):

```bash
cd scratch-gui
NODE_OPTIONS=--openssl-legacy-provider npm run build
```

## Playing together

1. Both open the editor (same LAN: `http://<your-ip>:8601` or `:4455`).
2. Type a name, use the same room name, hit **Join & code together**.
3. That's the whole login. First person in seeds the room with their project;
   everyone else gets it automatically.

URL params: `?name=Emma&room=family&server=ws://192.168.x.x:4455`

### Over the internet

**Easiest:** double-click `host-online.cmd` — starts the server + a Cloudflare
quick tunnel (needs `winget install Cloudflare.cloudflared` once). Share the
printed `https://xxxx.trycloudflare.com/editor.html?room=family` link; the
editor and websocket ride the same URL, nothing else to configure.

**Permanent hosting:** any Node box or container host:

```bash
docker compose up -d      # builds editor + serves on :4455, rooms persisted in a volume
```

or bare Node: build the gui once, then `npm start` at the repo root
(`PORT`, `HOST`, `ROOMS_DIR`, `BUILD_DIR` env vars supported). Behind a
reverse proxy / Cloudflare tunnel, wss upgrades work on the same port —
no extra config. The server prints LAN invite links at startup.

## What syncs

| Action | How |
|---|---|
| Block editing (create/move/change/delete, variables, comments) | live Blockly events, per-sprite, no reload |
| Sprite drag on stage, direction/size/visibility | live, throttled |
| Green flag / stop | mirrored on both sides + toast |
| Paint edits (vector + bitmap) | LIVE per stroke-commit — costume/stage update in place, no reload |
| Add/delete/rename sprite, costumes, sounds | debounced full `.sb3` snapshot — everyone converges |
| Cursors (on the same sprite's workspace) | colored pointer with name tag |
| Presence (who's here, which sprite, coding/playing) | widget bottom-right |

Routing is by sprite **name** (stable across .sb3 loads); snapshots are cached
by the server and persisted, so a room survives restarts and rejoining.

## License

The editor is derived from [TurboWarp](https://github.com/TurboWarp/scratch-gui)
(GPL-3.0), which builds on Scratch by the Scratch Foundation. This project keeps
the GPL-3.0 license; see `scratch-gui/LICENSE`. The collab server and tooling
are part of the same distribution. Not affiliated with or endorsed by Scratch
or TurboWarp.

## Notes

- Node 24 works; webpack 4 needs `NODE_OPTIONS=--openssl-legacy-provider`.
- Both VMs run the project independently when playing — motion is computed
  locally on each side (this is intentional; scripts don't fight each other).
- Upstream TurboWarp is GPL-side licensed (their scratch-gui carries
  GPL-3.0); fine for personal use, mind it if you ever publish this.

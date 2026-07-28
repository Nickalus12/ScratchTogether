# Squiggle

Real-time multiplayer for block coding — two people, one project, live. Built
on [TurboWarp](https://turbowarp.org), which is built on
[Scratch](https://scratch.mit.edu).

Accounts are a handle and a passphrase (no email — kids don't have one, so
recovery is a four-word code). Rooms are private, unlisted or public, with
owner/editor/viewer roles and invite links. Everyone gets a colour and a cursor
style, and you see each other's cursors move as you build.

**[Join the Discord](https://discord.gg/8rc63SwhvW)** — share what you built,
find someone to build with, or report something broken.

> Not affiliated with or endorsed by the Scratch Team. "Scratch" is their
> trademark and is used here only to describe what this interoperates with.

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
| Sprite drag on stage, direction/size/visibility | live, throttled (paused while green-flag running) |
| Green flag / stop | mirrored on both sides + toast |
| Paint edits (vector + bitmap) | LIVE per stroke-commit — costume/stage update in place, no reload |
| Add/delete/rename sprite, costumes, sounds | debounced full `.sb3` snapshot — everyone converges |
| Cursors (on the same sprite's workspace) | colored pointer with name tag |
| Presence (who's here, which sprite, coding/playing) | widget bottom-right |
| **Game messages & shared variables** (Together extension) | live `game` messages over the same socket; vars cached server-side for late joiners |

Routing is by sprite **name** (stable across .sb3 loads); snapshots are cached
by the server and persisted, so a room survives restarts and rejoining.

## Multiplayer games

The **Together** extension (Add Extension → Together) turns a room into a
multiplayer game session. Everyone running the same project exchanges game
messages and shared variables while the green flag is down — each machine still
simulates independently; only the values you send are shared.

| Block | What it does |
|---|---|
| `broadcast game message [name] with [value]` | Send a named message + value to everyone in the room (including yourself) |
| `when I receive game message [name]` | Hat — runs when that message arrives |
| `game message name` / `game message value` | Name and value of the most recent game message |
| `set shared variable [name] to [value]` | Last-write-wins room variable (synced) |
| `change shared variable [name] by [value]` | Atomic-ish numeric bump (read-modify-write locally, then sync) |
| `shared variable [name]` | Read a shared variable (late joiners get current values) |
| `my player name` | Your collab login name |
| `other players` | Comma-joined names of everyone else in the room |
| `player count` | You + everyone else currently in the room |
| `when a player joins` / `when a player leaves` | Hats for presence changes |
| `last player joined` / `last player left` | Names from the most recent join/leave |
| `connected to room?` | Whether the collab socket is live |

### Tiny two-player example

A shared counter both players can bump:

1. Add the **Together** extension.
2. On the Stage:

```text
when green flag clicked
set shared variable [score] to [0]

when I receive game message [bump]
change shared variable [score] by (game message value)
say (join [Score: ] (shared variable [score]))

when this sprite clicked
broadcast game message [bump] with [1]
```

3. Open the same room in two browsers, green-flag both, click the stage on
   either side — both see the score climb. A third tab that joins mid-game
   already has the current `score` via the server cache.

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

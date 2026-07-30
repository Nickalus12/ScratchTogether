# Squiggle

Real-time multiplayer for block coding — open a room, share the link, and build
the same project together while you watch each other's cursors move. Built on
[TurboWarp](https://turbowarp.org), which is built on
[Scratch](https://scratch.mit.edu).

**[squigglegames.app](https://squigglegames.app)** · **[Discord](https://discord.gg/8rc63SwhvW)** · **[Contributing](./CONTRIBUTING.md)**

> Not affiliated with or endorsed by the Scratch Team or TurboWarp. "Scratch" is
> a trademark of the Scratch Foundation and is used here only to describe what
> this interoperates with.

---

## What it does

| | |
|---|---|
| **Live co-editing** | Block edits, sprite drags, costume paint strokes and green-flag runs replay on everyone's screen as they happen — no reload, no save-and-refresh |
| **Rooms** | Private, unlisted or public, with owner / editor / viewer roles and invite links. A room survives server restarts and rejoining |
| **Accounts without email** | A handle and a passphrase. Kids don't have an email address, so recovery is a four-word code you write down at signup |
| **Grown-up accounts** | A parent account sees its children's projects and approves anything that would go public |
| **Publishing** | Share a finished project to `/explore`, play it at `/play`, favourite it. A child account can't publish on its own — it *asks*, and the request lands on the grown-up's dashboard |
| **Version history** | Every room keeps 25 snapshots a minute apart, browsable and restorable from the history panel — "undo this whole afternoon" after someone paints over a sprite |
| **Multiplayer games** | The **Together** extension turns a room into a game session — shared variables and game messages between running projects. See [docs/TOGETHER.md](./docs/TOGETHER.md) |
| **Editor extras** | A Squiggle theme, typed comments with section frames and an outline, and the QoL addons wired in as native extensions |
| **Moderation** | Word filtering, reports, an admin console at `/admin`, and a Discord bug pipeline that files GitHub issues |
| **Discord linking** | `/link` in the Discord server hands you a code; confirming it while signed in grants the 🔗 Linked role |
| **Counting, not tracking** | Daily counters only — no access log, no cookie, no third-party script. See [Privacy](#privacy) |

## Contributing

Squiggle is built in the open and outside help is genuinely wanted — a bug
report from someone who hit the bug is worth more than a week of guessing.

- **Something broken?** `/bug` in [Discord](https://discord.gg/8rc63SwhvW) (it
  files the issue for you), or open one [here](https://github.com/Nickalus12/SquiggleGames/issues/new/choose).
- **Idea for a block, a feature, a game?** Open a feature issue, or say it in
  `#feature-ideas`.
- **Want to write code?** Read [CONTRIBUTING.md](./CONTRIBUTING.md) — it covers
  setup, how the pieces fit, what a good PR looks like, and which areas are open.

Everyone taking part is held to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Children use this project; that shapes what we ship and how we talk to each
other.

## Run it locally

Needs **Node ≥ 22.13** (the server uses the built-in `node:sqlite`; Node 24 is
what it's developed against).

```bash
git clone https://github.com/Nickalus12/SquiggleGames.git
cd SquiggleGames

# 1. the multiplayer server + static host (port 4455)
cd collab-server && npm install && node server.js

# 2. only if you're changing the editor — dev server on :8601 with hot reload
cd scratch-gui && npm install
NODE_OPTIONS=--openssl-legacy-provider npm start
```

On Windows, `start.cmd` does both by double-click.

To run the way production does — one process serving everything on `:4455`:

```bash
cd scratch-gui && NODE_OPTIONS=--openssl-legacy-provider npm run build
cd .. && npm start
```

Then open `http://localhost:4455`, sign up, and make a room. To try multiplayer
alone, open the room in a second browser profile.

Useful env vars: `PORT`, `HOST`, `ROOMS_DIR`, `BUILD_DIR`, `TELEMETRY`.
URL params: `?name=Emma&room=family&server=ws://192.168.x.x:4455`.

### Tests

```bash
cd collab-server && npm test    # auth, hardening, moderation, publishing, telemetry, deploy/drain
```

They boot real servers on real ports and assert behaviour, not implementation —
they are the gate for a server change. Browser-level checks live in `scripts/`
(`node scripts/test-collab-edit.mjs` and friends).

## Layout

| Path | What |
|---|---|
| `collab-server/` | Node WebSocket relay + static host + REST API + SQLite metadata store. Zero dependencies beyond `ws` |
| `collab-server/rooms/` | Room snapshots as plain `.sb3` files — copyable, not locked in a database |
| `scratch-gui/` | TurboWarp editor (clone of `TurboWarp/scratch-gui`); the collab client lives in `src/lib/collab/` |
| `scripts/` | Browser-driven integration checks |
| `docs/` | [Architecture](./docs/ARCHITECTURE.md) · [Deploying](./docs/DEPLOY.md) · [Together extension](./docs/TOGETHER.md) · [Cloudflare](./docs/cloudflare.md) |

## Hosting it yourself

Easiest public link: double-click `host-online.cmd` — server plus a Cloudflare
quick tunnel (`winget install Cloudflare.cloudflared` once). Share the printed
`https://xxxx.trycloudflare.com/` URL; editor and websocket ride the same origin.

Permanent:

```bash
docker compose up -d   # builds the editor, serves :4455, rooms in a volume
```

Deploying to a real box — including what happens to people who are mid-project
when you push — is [docs/DEPLOY.md](./docs/DEPLOY.md). The short version: work
is drained to disk before the process exits, clients reconnect in about a second
and get a *"A new version of Squiggle is ready — Reload"* banner instead of
losing what's on screen.

## Privacy

Daily counters, no access log, no cookie, no third party, no script in the page.
Counted: page views by name, distinct visitors, signups, logins, room joins,
saves, referrer host, country, device class, peak people online. Never stored:
addresses, user-agent strings, full referrer URLs.

Distinct visitors are counted by hashing the address under a secret that rotates
nightly and is destroyed, so the pseudonyms cannot be linked across days or
reversed. Do Not Track and Global Privacy Control are honoured; `TELEMETRY=0`
turns the whole thing off.

```bash
cd collab-server && npm run stats     # last 30 days; `npm run stats 90` for a wider window
node test-telemetry.js                # the privacy claims, asserted
```

`/admin` is the same data as a page (admin accounts, or an email on
`ADMIN_EMAILS` behind Cloudflare Access). The user-facing version is `/privacy`;
the mechanism is documented in the header of `collab-server/telemetry.js`.

## Security

Found something that could hurt a user — account takeover, data exposure, a way
past moderation? Please don't open a public issue. [SECURITY.md](./SECURITY.md)
has the private route.

## License

GPL-3.0. The editor derives from [TurboWarp](https://github.com/TurboWarp/scratch-gui)
(GPL-3.0), which builds on Scratch by the Scratch Foundation; the collab server
and tooling ship under the same license as part of the same distribution. See
[LICENSE](./LICENSE).

## Notes

- Webpack 4 needs `NODE_OPTIONS=--openssl-legacy-provider` on modern Node.
- Every browser runs the project independently — motion is computed locally on
  each side, and only the values you explicitly send are shared. This is
  deliberate: it keeps scripts from fighting each other.
- The version the app reports at `/api/version` comes from
  **`collab-server/package.json`** — the root `package.json` is a launcher, not
  the version of record. Changes are in [CHANGELOG.md](./CHANGELOG.md).

# Squiggle — editor

The Squiggle editor: a [TurboWarp](https://turbowarp.org) fork (itself built on
[Scratch](https://scratch.mit.edu)) with the multiplayer client built in, so
block edits, sprite drags, paint strokes and green-flag runs replay live on
everyone else's screen.

**[squigglegames.app](https://squigglegames.app)** · **[Discord](https://discord.gg/8rc63SwhvW)** · **[Contributing](./CONTRIBUTING.md)**

[![editor](https://github.com/Nickalus12/SquiggleGames/actions/workflows/editor.yml/badge.svg)](https://github.com/Nickalus12/SquiggleGames/actions/workflows/editor.yml)
[![license: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](./LICENSE)
[![good first issues](https://img.shields.io/github/issues/Nickalus12/SquiggleGames/good%20first%20issue?label=good%20first%20issues&color=7057ff)](https://github.com/Nickalus12/SquiggleGames/labels/good%20first%20issue)

> Not affiliated with or endorsed by the Scratch Team or TurboWarp. "Scratch" is
> a trademark of the Scratch Foundation and is used here only to describe what
> this interoperates with.

---

## What is in this repository

This repository contains **the editor only** — the part that runs in your
browser, licensed GPL-3.0 because it derives from TurboWarp.

The Squiggle server the editor talks to over a WebSocket — rooms, accounts,
permissions, moderation, publishing, the gallery — is a **separate proprietary
program**. It is not in this repository, not distributed here, and not covered
by this repository's license. See [License](#license).

| Path | What |
|---|---|
| `scratch-gui/` | The editor — a clone of `TurboWarp/scratch-gui` with Squiggle's changes |
| `scratch-gui/src/lib/collab/` | The multiplayer client: the half of the protocol that runs in the browser |
| `docs/TOGETHER.md` | The **Together** extension — shared variables and messages between running projects |
| `tools/` | Demo-video tooling |

## Running the editor

Needs **Node ≥ 22.13**.

```bash
git clone https://github.com/Nickalus12/SquiggleGames.git
cd SquiggleGames/scratch-gui
npm install
NODE_OPTIONS=--openssl-legacy-provider npm start     # dev server on :8601
```

That gives you a working editor with hot reload, which is what you want for any
change to the editor itself. Point it at a server with `?server=ws://host:4455`
if you have one to point at.

```bash
NODE_OPTIONS=--openssl-legacy-provider npm run build  # production bundle
```

## Contributing

Outside help is genuinely wanted — a bug report from someone who hit the bug is
worth more than a week of guessing.

- **Something broken?** `/bug` in [Discord](https://discord.gg/8rc63SwhvW) (it
  files the issue for you), or open one [here](https://github.com/Nickalus12/SquiggleGames/issues/new/choose).
- **Idea for a block, a feature, a game?** Open a feature issue, or say it in
  `#feature-ideas`.
- **Want to write code?** Read [CONTRIBUTING.md](./CONTRIBUTING.md).

Everyone taking part is held to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Children use this project; that shapes what we ship and how we talk to each
other.

## Privacy

The hosted service keeps daily counters only — no access log, no cookie, no
third-party script in the page. Counted: page views by name, distinct visitors,
signups, logins, room joins, saves, referrer host, country, device class, peak
people online. Never stored: addresses, user-agent strings, full referrer URLs.

Distinct visitors are counted by hashing the address under a secret that rotates
nightly and is destroyed, so the pseudonyms cannot be linked across days or
reversed. Do Not Track and Global Privacy Control are honoured. The user-facing
version is at [squigglegames.app/privacy](https://squigglegames.app/privacy).

## Security

Found something that could hurt a user — account takeover, data exposure, a way
past moderation? Please don't open a public issue. [SECURITY.md](./SECURITY.md)
has the private route.

## License

**GPL-3.0**, for the contents of this repository. The editor derives from
[TurboWarp/scratch-gui](https://github.com/TurboWarp/scratch-gui) (GPL-3.0),
which builds on Scratch by the Scratch Foundation. See [LICENSE](./LICENSE).

The Squiggle server is a **separate and independent program**. It is not part of
this repository, is not distributed with it, and is not licensed under the GPL.
The editor communicates with it at arm's length over a WebSocket and HTTP
interface, exchanging data rather than linking code. Running this editor against
the hosted service, or against any other server, does not place that server
under this license.

## Notes

- Webpack 4 needs `NODE_OPTIONS=--openssl-legacy-provider` on modern Node.
- Every browser runs the project independently — motion is computed locally on
  each side, and only the values you explicitly send are shared. This is
  deliberate: it keeps scripts from fighting each other.
- Release notes are in [CHANGELOG.md](./CHANGELOG.md).

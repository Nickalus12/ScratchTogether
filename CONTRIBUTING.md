# Contributing to Squiggle

Squiggle is a small project used by real kids, and outside help is genuinely
wanted. A bug report from someone who actually hit the bug is worth more than a
week of guessing; a block idea from someone who tried to build a game and
couldn't is worth more than a roadmap.

There is no contributor bar here. If you have never opened a pull request
before, this is a fine place to open your first one — say so and someone will
walk you through it.

## Ways to help, easiest first

| | How |
|---|---|
| **Report a bug** | `/bug` in [Discord](https://discord.gg/8rc63SwhvW) — it files the GitHub issue for you — or [open one directly](https://github.com/Nickalus12/SquiggleGames/issues/new/choose) |
| **Suggest a feature or a block** | [Feature issue](https://github.com/Nickalus12/SquiggleGames/issues/new/choose), or `#feature-ideas` in Discord |
| **Show what you built** | `#showcase` in Discord. Projects that break things in interesting ways are the best test suite we have |
| **Improve the docs** | Anything in `README.md` or `docs/` that was wrong or confusing when *you* read it. These PRs are welcome and get reviewed fast |
| **Fix a bug** | Issues labelled [`good first issue`](https://github.com/Nickalus12/SquiggleGames/labels/good%20first%20issue) are scoped to be self-contained |
| **Build a feature** | Comment on the issue first (or open one) so two people don't build the same thing |

## What is in this repository

This repository is **the editor** — the TurboWarp-derived app that runs in the
browser, including the multiplayer client under `src/lib/collab/`.

The Squiggle server it connects to is a separate proprietary program in its own
repository, so server-side changes aren't something a PR here can make. That is
not a hint that help isn't wanted: the editor is where nearly everything a
person actually sees lives, and it is all here.

## Setting up

You need **Node ≥ 22.13**. Nothing to install beyond npm packages.

```bash
git clone https://github.com/Nickalus12/SquiggleGames.git
cd SquiggleGames/scratch-gui
npm install
NODE_OPTIONS=--openssl-legacy-provider npm start      # → http://localhost:8601
```

Webpack 4 needs that `--openssl-legacy-provider` flag on modern Node; leave it
off and you get an opaque OpenSSL error.

That is a full editor with hot reload. It runs single-player out of the box,
which is enough for most changes. To work on anything that syncs, point it at a
server with `?server=ws://host:4455` and open the same room in a second browser
profile or a private window — two tabs in the same profile share a session.

## Finding your way around

Two rules are not obvious from reading the source, and breaking either produces
a bug that looks like something else entirely:

- Applying a remote change must not emit a local event that gets sent back out
  (echo loops look like lag and end in divergence).
- Sync routes by sprite **name**, not id — ids are regenerated on `.sb3` load.

Short version of where things live:

| I want to change… | Look in |
|---|---|
| What syncs between players | `scratch-gui/src/lib/collab/index.js` |
| Cursors, presence widget, toasts, banners | `scratch-gui/src/lib/collab/overlay.js` |
| Reconnect behaviour | `scratch-gui/src/lib/collab/client.js` |
| The Together extension's blocks | search `scratch-gui` for the Together extension; see [docs/TOGETHER.md](./docs/TOGETHER.md) |

## Before you open a PR

The build succeeding is the gate:

```bash
cd scratch-gui && NODE_OPTIONS=--openssl-legacy-provider npm run build
npx eslint src/lib/collab --ext .js,.jsx    # advisory, see below
```

Lint is worth reading but is not a pass/fail: upstream's eslint config reports
about 75 pre-existing JSDoc and operator-precedence errors on
`src/lib/collab`. Don't fix them in your PR — just don't add new ones on the
lines you touched.

If your change touches sync, say in the PR how you checked it and what you saw.
Two things about that are worth knowing before you spend an evening confused:

**Give each identity its own account.** The server drops the older socket when
the same account joins twice — that is what stops one person appearing twice
after a refresh — so a second tab signed into the same account silently evicts
the first from the room. That tab stays up, stops receiving, and the failure
reads exactly like a sync bug. Use a second browser profile.

**Check that your check can fail.** A sync test that replays a snapshot proves
nothing if the room has not moved on since that snapshot was taken: both
editors recognise it as the one they already have, skip the reload, and the
check passes without ever running the path it is named after. Advance the room
first, then verify.

**When you fix a bug, describe the reproduction that used to fail.** That is the
whole review standard for a fix — if the bug could come back silently, it will.

## What a good pull request looks like

- **One thing.** A fix and a refactor in the same PR take three times as long to
  review and cannot be reverted independently.
- **Every changed line traces to the stated goal.** Please don't reformat
  neighbouring code, rename things you happened to read, or "improve" something
  adjacent. Mention it instead — that's useful.
- **Matches the surrounding style** even where you'd have done it differently.
- **Explains the *why*, not the *what*.** The diff already says what changed.
  The description should say what was broken, what you tried, and anything you
  weren't sure about. "I don't know if this is the right place for this" is a
  perfectly good line in a PR description.
- **Comments carry the non-obvious reason**, not a narration of the next line.

Commit messages: plain sentences describing what changed and why. Conventional
`type(scope):` prefixes are used in places and are fine, but a clear sentence
beats a badly-scoped prefix.

## Review

PRs are reviewed by a human, usually within a few days. Expect questions — they
are about the change, never about you. If something is asked for that you don't
know how to do, say so; it's normal for a reviewer to push a commit onto your
branch to help it land.

A PR can be turned down for reasons that have nothing to do with quality: it
collects data the privacy model doesn't allow, it needs a server change that
isn't happening, or it makes the editor harder to explain to a ten-year-old. If
that risk is high, ask in an issue first and save yourself the work.

## Things this project holds to

These are not negotiable in a PR, so they're worth knowing up front:

1. **Children use this.** Anything user-visible gets read by someone who is ten.
   Anything that collects data gets weighed against them being here.
2. **Counting, not tracking.** No access log, no cookie, no third-party script,
   no fingerprinting surface. A change that adds one won't land.
3. **Nobody loses work.** Restarts drain, disconnects rescue, conflicts copy the
   losing side into the user's library. A change that can silently discard what's
   on someone's screen won't land.
4. **Projects stay portable.** Project blobs are plain `.sb3` files you can copy
   out. Nothing gets locked into a format only Squiggle can open.

## Security

Please don't open a public issue for anything that could hurt a user — account
takeover, data exposure, a bypass of moderation. [SECURITY.md](./SECURITY.md)
has the private route.

## License

By contributing you agree your work is licensed under GPL-3.0, the same as the
rest of the project.

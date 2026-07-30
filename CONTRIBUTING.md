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

## Setting up

You need **Node 24**. The declared floor is 22.13 (that's where `node:sqlite`
becomes usable), but one query needs SQLite math functions that Node 22's build
lacks — see [#8](https://github.com/Nickalus12/SquiggleGames/issues/8), which is
open and takers are welcome. No database to install, no services to configure.

```bash
git clone https://github.com/Nickalus12/SquiggleGames.git
cd SquiggleGames

cd collab-server && npm install && node server.js     # → http://localhost:4455
```

That is enough for any **server** change. Open the site, sign up (handle +
passphrase, no email), make a room.

For an **editor** change you also want the dev server, which hot-reloads:

```bash
cd scratch-gui && npm install
NODE_OPTIONS=--openssl-legacy-provider npm start      # → http://localhost:8601
```

Webpack 4 needs that `--openssl-legacy-provider` flag on modern Node; leave it
off and you get an opaque OpenSSL error.

To test multiplayer by yourself, open the same room in a second browser profile
or a private window — two tabs in the same profile share a session.

Windows: `start.cmd` starts both by double-click.

## Finding your way around

Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before your first code
change — it's short, and it explains the two rules that are not obvious from
reading the source:

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
| Rooms, presence, drain, the socket protocol | `collab-server/server.js` |
| Accounts, projects, publishing, explore, admin | `collab-server/http-api.js` |
| Schema and queries | `collab-server/db.js` |
| Moderation | `collab-server/moderation.js`, `moderation-words.js` |
| Counting and the privacy model | `collab-server/telemetry.js` |

## Before you open a PR

```bash
npm test          # from the repo root — delegates to collab-server
```

Seven suites, each booting a real server on a real port. They must be green.
They assert *claims* — "the in-progress work reached disk", "a wrong token is
refused" — rather than implementation, so when you change behaviour the test
that fails should be describing the behaviour you changed.

Editor changes — the build succeeding is the gate:

```bash
cd scratch-gui && NODE_OPTIONS=--openssl-legacy-provider npm run build
npx eslint src/lib/collab --ext .js,.jsx    # advisory, see below
```

Lint is worth reading but is not a pass/fail: upstream's eslint config reports
about 75 pre-existing JSDoc and operator-precedence errors on
`src/lib/collab`. Don't fix them in your PR — just don't add new ones on the
lines you touched.

If your change touches sync, run the browser check that covers it. These drive a
real editor with Playwright against a running server:

```bash
# once
npm install && npx playwright install chromium

# with the server running on :4455 and a built editor
npm run test:browser
```

Five checks: block create/move relaying, paint surviving a stale snapshot,
simultaneous co-painting, sprite add/delete/rename, and Together messages +
shared variables. They sign up over the API and hand the session cookie to the
browser, so there is nothing to set up by hand. A preflight runs first and tells
you which of the three prerequisites is missing rather than failing as a module
error or a timeout. `ST_BASE` points them somewhere other than
`http://127.0.0.1:4455`; individual files still run on their own with
`node scripts/<name>.mjs`.

**If you add one, give each identity its own account.** The server drops the
older socket when the same account joins twice — right, it is what stops one
person appearing twice after a refresh — so a second socket opened inside a tab
silently evicts that tab from the room. The tab stays up, stops receiving, and
the failure reads exactly like a sync bug. `puppet()` in `scripts/_session.mjs`
exists for third parties and logs in separately for this reason.

**And check that your check can fail.** `test-paint-sync` replays an old zip to
prove paint survives a stale snapshot — but if the room has not moved on since
that zip was captured, both editors recognise it as the one they already have
and skip the reload, and the test passes without ever running the path it is
named after. It advances the room first, deliberately.

**Add a test when you fix a bug.** The test should fail on the old code. That is
the whole review standard for a fix — if the bug could come back silently, it
will.

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
adds a dependency to a server that deliberately has one, it collects data the
privacy model doesn't allow, or it makes the editor harder to explain to a
ten-year-old. If that risk is high, ask in an issue first and save yourself the
work.

## Things this project holds to

These are not negotiable in a PR, so they're worth knowing up front:

1. **Children use this.** Anything user-visible gets read by someone who is ten.
   Anything that collects data gets weighed against them being here.
2. **Counting, not tracking.** No access log, no cookie, no third-party script,
   no fingerprinting surface. `test-telemetry.js` asserts this and will fail you.
3. **Nobody loses work.** Restarts drain, disconnects rescue, conflicts copy the
   losing side into the user's library. A change that can silently discard what's
   on someone's screen won't land.
4. **The server stays dependency-light.** `ws` and the Node standard library.
   Adding a dependency needs a reason that survives "why can't the platform do
   this".
5. **Projects stay portable.** Room and project blobs are plain `.sb3` files you
   can copy out. Nothing gets locked into the database.

## Security

Please don't open a public issue for anything that could hurt a user — account
takeover, data exposure, a bypass of moderation. [SECURITY.md](./SECURITY.md)
has the private route.

## License

By contributing you agree your work is licensed under GPL-3.0, the same as the
rest of the project.

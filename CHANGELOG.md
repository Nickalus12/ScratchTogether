# Changelog — Squiggle editor

Changes to the editor in this repository. The editor is versioned by the
Squiggle release it ships with; the hosted service reports its own version at
`/api/version`.

Entries before the repository split are not reproduced here. That history
described the service and the editor as one program, which they are not, and
splitting the narrative after the fact would have meant rewriting descriptions
of work rather than just moving files.

## Unreleased

### Changed

- A refusal in co-play chat now carries the server's warning with it, so the
  panel around the player can show what was recognised and what it costs the
  account rather than a line in the chat log. The editor forwards it and does
  not re-derive any of it — the decision is the server's.

## 1.5.0

### Added

- **`when I receive any game message`.** Asked for by a player: naming every
  message up front is fine until you are writing the thing that logs them,
  relays them, or reacts to whatever the other player just did — and then it is
  one hat block per message, edited again whenever the game changes. Inside the
  new hat, `game message name` and `game message value` tell you which one
  arrived, so one script can handle all of them.

### Fixed

- **Watching a project no longer looks like editing one.** A viewer was handed
  a working editor: `canEdit` arrived with the welcome, was shown in a toast
  that faded in under three seconds, and then nothing consulted it. Every edit
  applied locally, went to the server, and was refused there in silence — the
  error handler knew three codes and dropped the rest, `read-only` among them
  — until the next snapshot erased the lot. Viewers now send nothing, the
  workspace and the palette stop accepting edits, every structural change is
  refused at the call rather than half-applied, and the reason stays on screen
  instead of fading.
- **A project too large to save said so.** `bad-snapshot` — the size cap, which
  means nothing is reaching disk any more — was one of the errors being
  dropped. It gets a banner now, and anything unrecognised at least gets a
  toast.
- **Costumes and sounds are addressed by identity, not position.** An index is
  a fact about one editor's list at one moment: a partner adding, deleting or
  reordering a costume renumbers everything below it, so "delete costume 3"
  sent when 3 was the hat arrived where 3 was the whole drawing. Blocks already
  routed by sprite name; the two lists that never got that lesson now carry a
  name and an asset id, and a message whose costume is not here does nothing
  rather than acting on whatever occupies the slot.
- **Continuous editing is saved.** The snapshot debounce was re-armed by every
  edit and guards the only path to disk, so painting or dragging blocks without
  ever pausing the minimum wait saved nothing at all. The deferral now has a
  ceiling.
- **A dead connection is noticed.** A socket whose path died without a close
  frame stayed open in the tab forever with the presence dot green. The editor
  keeps its own clock now, and a handshake left hanging gets a deadline.
- **Dropped edits ask for a fresh copy.** Four buffers silently discarded
  relayed edits when full — edits nothing would ever resend, because the sender
  never learns they went missing. Each now repairs itself rather than leaving
  two people looking at different projects.
- **Game messages no longer read each other's values.** Two arriving in one
  frame both wrote `game message name` before either script ran, so both scripts
  saw the second one — rare enough with `when I receive [score]` to look like a
  glitch, and the normal case for a script handling several kinds. Each started
  script now carries the message it woke on. Broadcasting had the same bug
  locally and worse: `broadcast score` then `broadcast lives` in one frame is an
  ordinary pair, and both hats read "lives". A game behaves the same now
  whoever sent the message, which matters more than the frame it costs — a bug
  that only appears when *you* are the host is the worst kind to be told about.
- **A `forever` loop cannot flood the room.** `forever [broadcast game
  message]` sends at the frame rate, and the server relays game traffic
  reliably, unthrottled, fanned out per peer — six players was 900 relayed
  messages a second from one loop nobody thought was unusual. There is a budget
  now: under it nothing changes, over it messages coalesce by name and flush
  next frame, so distinct events still all arrive.
- **A second project load no longer stacks another copy of the extension.**
  `dispose()` left its runtime listeners attached, so the step handler ran once
  per project ever opened, each with its own inbox, all firing hats into the
  current one. Shared variables were left behind for the next project to read
  as though they were current, too.
- **`player count` counts you.** It returned 0 while connected-but-not-yet-named
  and 1 when there was no bridge at all — so it read 1 alone offline, 0 alone
  online, and any game checking `= 1` or dividing by it broke for the first
  second of every session.
- **`change shared variable by` cannot lose a point.** It computed the new
  value locally and sent that, so two players scoring at once both read 5, both
  wrote 6, and one child's point vanished. The increment now travels as an
  increment. Requires a server new enough to understand it.
- **Comment bodies are not overwritten while you type in them**, and comments
  cost one pair of document listeners between them rather than two each — forty
  comments used to force eighty layouts on every click anywhere in the editor.
- **The History panel says why it failed.** Every failure collapsed into "Could
  not read the history", so a permission problem, a signed-out session and a
  real outage were indistinguishable — impossible to diagnose from a
  screenshot, which is exactly how it arrived. The server sends a reason and the
  panel shows it, restore included, where the likely answer is that only the
  host may put a version back.
- Frame interpolation is on by default whether or not you opened a room link;
  History works against the dev server; a session that ends actually stops.

### Changed

- This repository is now the editor alone. The Squiggle server moved to a
  separate, private repository; the two programs exchange data over a
  WebSocket rather than being built or licensed together. See the README's
  [License](./README.md#license) section for what that means for reuse.
- `README.md` and `CONTRIBUTING.md` rewritten around the editor: how to run it,
  where the collab client lives, and what a PR here can change.

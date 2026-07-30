# The Together extension — multiplayer games

Add Extension → **Together** turns a room into a multiplayer game session.
Everyone running the same project exchanges game messages and shared variables
while the green flag is down. Each machine still simulates independently; only
the values you send are shared.

## Blocks

| Block | What it does |
|---|---|
| `broadcast game message [name] with [value]` | Send a named message + value to everyone in the room (including yourself) |
| `when I receive game message [name]` | Hat — runs when that message arrives |
| `game message name` / `game message value` | Name and value of the most recent game message |
| `set shared variable [name] to [value]` | Last-write-wins room variable (synced) |
| `change shared variable [name] by [value]` | Atomic-ish numeric bump (read-modify-write locally, then sync) |
| `shared variable [name]` | Read a shared variable — late joiners get current values from the server cache |
| `my player name` | Your Squiggle login name |
| `other players` | Comma-joined names of everyone else in the room |
| `player count` | You + everyone else currently in the room |
| `when a player joins` / `when a player leaves` | Hats for presence changes |
| `last player joined` / `last player left` | Names from the most recent join/leave |
| `connected to room?` | Whether the collab socket is live |

## A two-player example

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

## Things worth knowing before you design a game

- **Every player simulates the whole project.** Motion, collisions and timers
  run locally on each machine. Two players will not agree about anything you
  don't explicitly share — which is exactly what keeps their scripts from
  fighting each other.
- **Pick one authority for anything contested.** For scores, turn order or
  spawns, let one player (say, the first to join) own the value and broadcast
  results; `change shared variable` is read-modify-write, so two simultaneous
  bumps can land as one.
- **Late joiners get shared variables, not game messages.** Messages are live
  only; anything a newcomer needs to know must live in a shared variable.
- **Names are the identity.** `my player name` is the collab login, so use it as
  the key when you track per-player state.

`scripts/test-together-game.mjs` and `scripts/test-together-browser.mjs` drive
this end to end in a real editor — a good starting point if you're changing the
extension.

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

- This repository is now the editor alone. The Squiggle server moved to a
  separate, private repository; the two programs exchange data over a
  WebSocket rather than being built or licensed together. See the README's
  [License](./README.md#license) section for what that means for reuse.
- `README.md` and `CONTRIBUTING.md` rewritten around the editor: how to run it,
  where the collab client lives, and what a PR here can change.

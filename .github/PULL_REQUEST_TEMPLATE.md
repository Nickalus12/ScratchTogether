<!--
Thanks for this. Nothing here is a hurdle — if a section doesn't apply, delete it.
First PR? Say so and someone will help it land.
-->

## What this changes

<!-- What was broken or missing, and what this does about it. The diff says what
     changed; this should say why. -->

Fixes #

## How I checked it

<!-- What you ran, and what you clicked. -->

- [ ] `cd collab-server && npm test` passes
- [ ] Editor change: `npm run build` succeeds and `npx eslint src/lib/collab --ext .js,.jsx` is clean
- [ ] Sync change: tried it with two browser profiles in one room
- [ ] Bug fix: added a test that fails on the old code

## Anything you're unsure about

<!-- Genuinely useful. "I don't know if this belongs here" or "this might be
     slow with 10 people" saves a review round trip. -->

---

- [ ] Every changed line traces to the thing above — no drive-by reformatting or renames
- [ ] No new server dependency (or the PR explains why the platform can't do it)
- [ ] Nothing new is collected about users
- [ ] No path where someone's on-screen work can be silently discarded

# Security

Squiggle holds children's accounts and their work. If you have found something
that could hurt a user, please tell us privately first.

## Reporting a vulnerability

**Email nbrewer@lumina-erp.com**, or use GitHub's
[private vulnerability reporting](https://github.com/Nickalus12/SquiggleGames/security/advisories/new).

Please don't open a public issue, post it in Discord, or demonstrate it against
the live site with anyone else's account.

Useful to include: what you did, what happened, and how bad you think it is.
A rough reproduction beats a polished write-up — send what you have.

You'll get a reply within a few days. If the report is valid you'll hear what
the fix is and when it ships, and you'll be credited in the changelog unless you
would rather not be.

## What we especially want to hear about

- Signing in as, or acting as, someone else — session, recovery-code or
  passphrase weaknesses
- Reading or writing a room or project you shouldn't have access to (the
  owner / editor / viewer roles)
- Anything that de-anonymises the telemetry — the visitor pseudonyms are meant
  to be unlinkable across days and unreversible, including by whoever holds the
  database
- Reaching the admin surface without an admin account
- Stored XSS or script injection anywhere a user's text is shown — project
  names, handles, comments, room titles
- Path traversal in the static host or the project/room file handling
- A way past moderation that puts adult content or contact details in front of
  a child
- Anything that lets one user destroy another user's saved work

## Out of scope

- Denial of service by volume against a self-hosted or LAN instance
- Missing hardening headers with no demonstrated impact
- Findings from automated scanners with no working reproduction
- Social engineering of moderators or users
- Vulnerabilities in TurboWarp or Scratch upstream — report those to
  [TurboWarp](https://github.com/TurboWarp) or the Scratch Team, though we'd
  still like to know if it affects Squiggle

## What this repository covers

This repository is the editor — the code that runs in a browser. It is GPL-3.0
and you are welcome to build and host it.

The Squiggle server is a separate program and is not distributed here, so
issues in it can't be reported as issues against this repository. Report them
by the private route above; they are the ones most worth telling us about,
because they are the ones affecting children using the hosted service.

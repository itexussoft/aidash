# What's new

One list per version, in the app's own words. Terse on purpose: this is what
the update banner shows, and it is read in a glance or not at all.

Each `##` heading is a version and each `-` under it is one line in the app.
`app/src/notes.js` parses this file; keep the shape.

## Unreleased

- Says which account has the most room left, and when the next window frees up
- Menu bar item counting down to that reset, with notifications when it arrives
- Refreshes on its own on a schedule you set, and marks how old a reading is
- Shows which account a session's Remote Control link belongs to
- Lists what each account has on Anthropic's side, on request
- Opens a project on its own: every session, both tools, all accounts, by day
- Builds a project brief from recent transcripts, to paste under another account
- Searches every transcript at once, across accounts and both tools

## 0.1.3

- Notarises the disk image, not just the app inside it

## 0.1.2

- Reports build failures with the end of the log rather than its start
- Says which test failed on CI instead of only that one did

## 0.1.1

- Finds project folders whose paths contain dots, matching Claude Code's own
  encoding
- Runs the Windows shim correctly when the home directory has a space in it

## 0.1.0

- First release: Codex and Claude usage on one screen, and moving Claude Code
  sessions between accounts

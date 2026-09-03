# What's new

One list per version, in the app's own words. Terse on purpose: this is what
the update banner shows, and it is read in a glance or not at all.

Each `##` heading is a version and each `-` under it is one line in the app.
`app/src/notes.js` parses this file; keep the shape.

## Unreleased

- Watches GitHub Copilot accounts: chat, completions and premium requests
  against the monthly credit allowance, signed in through the GitHub CLI
- Watches Cursor accounts, each in its own copy of the editor, with the included
  and paid-for model pools kept apart
- Marks both as alpha: neither vendor publishes a contract for the numbers, so a
  reading that stops making sense says so instead of drawing an empty bar
- Signs an account in again in place, keeping its name, its sessions and its
  separate instance — an expired login no longer means removing the account
- Frees the Finish button on the code box, which signing in to Claude needs

## 0.2.2

- Shows every action button by its icon, instead of only on hover
- Hides any session-folder column, and brings it back with one click
- Collapses every project on Local Sessions by default, so the list stays scannable
- Stops merging a second profile from leaving an empty folder behind

## 0.2.0

- Says which account has the most room left, and when the next window frees up
- Menu bar item counting down to that reset, with notifications when it arrives
- Refreshes on its own on a schedule you set, and marks how old a reading is
- Shows which account a session's Remote Control link belongs to
- Lists what each account has on Anthropic's side, on request
- Opens a project on its own: every session, both tools, all accounts, by day
- Builds a project brief from recent transcripts, to paste under another account
- Searches every transcript at once, across accounts and both tools
- Runs a second copy of Claude Desktop per account, signed in side by side
- Clears a stuck Remote Control link for a whole account, when Desktop's own
  disconnect fails

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

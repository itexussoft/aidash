# aidash

A desktop app showing how much of each Claude and Codex account you have used,
on one screen. Plus a tool for moving Claude Code sessions between accounts.

Landing page: [aidash.itex.us](https://aidash.itex.us)

## Why it is a desktop app

It started as a hosted dashboard and moved local, because every hard problem
traced back to running in a browser-less sandbox:

- `chatgpt.com` refuses the Cloudflare Workers runtime outright. Measured from
  `wrangler dev`, even `GET https://chatgpt.com/` returns a 403 challenge, while
  `example.com`, `api.anthropic.com` and `auth.openai.com` all answer from the
  same runtime, and `curl` reaches it fine from the same address. Reading Codex
  usage from a Worker needed a relay on a third host.
- Both providers register their OAuth clients against a `localhost` redirect, so
  adding an account could never happen in a web page.
- Hosting meant storing refresh tokens somewhere, which meant encrypting them,
  which meant a key that lived next to the data anyway.

Running on the machine that owns the credentials removes all three.

## What it does

**Usage** — one card per account, rendered the way each provider reports it.
There is no shared usage model, because the two do not measure the same thing:
Codex has one rolling window plus a separate personal spend control, Claude has
several independent windows that can each be exhausted alone. Whichever limit is
closest to stopping you sorts to the top.

Refreshes when you open the window if the data is older than ten minutes, and
when you press the button. Nothing runs in the background.

**Utils** — Claude Code keeps its transcripts under
`<config dir>/projects/<encoded cwd>/`, so two accounts used alternately on one
machine end up with the same project's history split between them. This tab
groups every session by project folder with one column per account, and drag and
drop moves a session across. A session belongs to the directory it ran in, so it
can only be dropped into another account's column of its own row.

## Credentials

The app stores no secrets. Signing in hands over to the vendor's own client,
which writes its credentials where it always does — a per-account config
directory, and the macOS keychain for Claude. The app only records which
directory belongs to which account.

On macOS, Claude Code keys its keychain entry by
`Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`. That is
what lets several accounts coexist without colliding, and what
`app/src/keychain.js` relies on.

## Requirements

The vendors' own clients do the signing in, so at least one must be installed:

| For | Install |
| --- | --- |
| Codex accounts | ChatGPT.app (ships the `codex` binary) |
| Claude accounts | Claude Code (`claude` on your `PATH`) |

A provider whose client is missing stays visible in the add dialog, disabled,
with the reason.

## Running from source

```bash
npm install
npm start
```

```bash
npm test
```

## Updates

The app checks `https://aidash.itex.us/version.json` on launch and shows a
banner when a newer version exists.

It notifies rather than installs, and that is a constraint, not a preference:
**macOS will not apply an update to an unsigned application.** Silent
auto-update needs an Apple Developer certificate ($99/year) for signing and
notarisation — which unsigned builds also need to avoid a Gatekeeper warning on
first launch. `app/src/updates.js` already speaks the shape electron-updater
expects, so switching over is a change in that one file once a certificate
exists.

To publish a release: bump `version` in `package.json`, build with
`npm run dist`, attach the artefacts to a GitLab release, then bump `RELEASE` in
`worker/src/index.js` and `npm run site:deploy`.

## Layout

```
app/
  main.js            Electron main: window, IPC, orchestration
  preload.cjs        the renderer's entire surface
  src/
    accounts.js      registry and the refresh cycle
    providers/       one adapter per provider, native response shapes
    sessions.js      Claude Code session scanning and moving
    keychain.js      reads and writes Claude's stored credentials
    updates.js       version manifest check
  renderer/          the window
worker/              landing page and version manifest for aidash.itex.us
```

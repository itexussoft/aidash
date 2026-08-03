/**
 * Landing page for aidash.itex.us.
 *
 * Styled after itexus.com, using values measured off the live site rather than
 * guessed: Heebo, ink #051320, accent #25BB4D, 48/600 headline, 10px buttons.
 *
 * Downloads are derived from the release manifest, so a platform with no build
 * yet says so instead of offering a link that 404s.
 */

import { usageMockup, sessionsMockup, logoMark } from './mockups.js';

const ACCENT = '#25BB4D';
const ACCENT_DARK = '#1FA543';
const INK = '#051320';
const MUTED = '#6E717A';
const WASH = '#F6F8F8';
const LINE = '#E8E8E8';

const PLATFORMS = [
	{ key: 'darwin-arm64', name: 'macOS', detail: 'Apple Silicon' },
	{ key: 'darwin-x64', name: 'macOS', detail: 'Intel' },
	{ key: 'win32-x64', name: 'Windows', detail: '64-bit' },
];

/** A download button, or a disabled one saying why it cannot be offered. */
function downloadButton(platform, downloads, { ghost = false } = {}) {
	const url = downloads?.[platform.key];
	// Same two-line silhouette whether or not a build exists, so the row of
	// buttons keeps one baseline instead of stepping up and down.
	const body = `<strong>${platform.name}</strong><em>${platform.detail}</em>`;
	if (!url) return `<span class="btn disabled" title="No build published for this platform yet">${body}</span>`;
	return `<a class="btn ${ghost ? 'ghost' : ''}" href="${url}">${body}</a>`;
}

export function renderLanding({ version, downloads, repoUrl }) {
	const anyDownload = PLATFORMS.some((p) => downloads?.[p.key]);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>aidash — one screen for every Claude and Codex quota</title>
<meta name="description" content="A desktop dashboard showing how much of each Claude and Codex account you have used, and a tool for moving Claude Code sessions between accounts. Credentials never leave your machine.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:${INK}; --accent:${ACCENT}; --accent-dark:${ACCENT_DARK};
    --muted:${MUTED}; --wash:${WASH}; --line:${LINE};
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{
    margin:0; background:#fff; color:var(--ink);
    font:16px/1.6 Heebo,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:1120px; margin:0 auto; padding:0 24px}

  /* ------------------------------------------------------------------ nav */
  header.nav{position:sticky; top:0; z-index:10; background:rgb(255 255 255 / .92); backdrop-filter:blur(8px); border-bottom:1px solid var(--line)}
  header.nav .wrap{display:flex; align-items:center; gap:16px; height:66px}
  .brand{display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px; letter-spacing:-.01em}
  .brand span{color:var(--accent)}
  .mark{display:block; width:30px; height:30px; border-radius:8px; flex:none}
  .nav-spacer{flex:1}
  .nav a{color:var(--muted); text-decoration:none; font-size:14px; font-weight:500}
  .nav a:hover{color:var(--ink)}
  .nav .btn{font-size:13px; padding:8px 18px}
  @media (max-width:720px){ .nav .hide-sm{display:none} }

  /* --------------------------------------------------------------- buttons */
  .btn{
    display:inline-flex; flex-direction:column; justify-content:center; gap:1px;
    min-width:150px; min-height:52px; padding:8px 20px; border-radius:10px;
    background:var(--accent); color:#fff; text-decoration:none;
    border:1px solid var(--accent); transition:background .15s,border-color .15s,transform .12s;
  }
  .btn strong{font-size:14px; font-weight:600; line-height:1.25}
  .btn em{font-style:normal; font-size:12px; font-weight:400; opacity:.72; line-height:1.25}
  .btn:hover{background:var(--accent-dark); border-color:var(--accent-dark); transform:translateY(-1px)}
  .btn.ghost{background:transparent; color:#fff; border-color:rgb(255 255 255 / .3)}
  .btn.ghost:hover{background:rgb(255 255 255 / .08); border-color:rgb(255 255 255 / .5)}
  .btn.dark{
    background:var(--ink); border-color:var(--ink); flex-direction:row; align-items:center;
    min-width:0; min-height:0; padding:9px 18px; font-size:13px; font-weight:600;
  }
  .btn.dark:hover{background:#0d2436; border-color:#0d2436}
  .btn.disabled{
    background:transparent; color:rgb(255 255 255 / .38);
    border:1px dashed rgb(255 255 255 / .2); cursor:not-allowed;
  }
  .btn.disabled:hover{transform:none; background:transparent; border-color:rgb(255 255 255 / .2)}
  .btn.disabled em::after{content:" · not yet built"}

  /* ------------------------------------------------------------------ hero */
  .hero{background:var(--ink); color:#fff; padding:92px 0 0; overflow:hidden}
  .hero h1{font-size:52px; font-weight:600; line-height:1.08; margin:0 0 20px; max-width:15ch; letter-spacing:-.02em}
  .hero .sub{font-size:19px; color:rgb(255 255 255 / .74); max-width:52ch; margin:0 0 32px}
  .downloads{display:flex; gap:12px; flex-wrap:wrap; align-items:stretch}
  .hero .meta{font-size:13px; color:rgb(255 255 255 / .45); margin-top:18px}
  .hero .meta a{color:rgb(255 255 255 / .7)}
  .hero-shot{margin-top:56px; margin-bottom:-70px}
  .hero-shot svg{display:block; width:100%; height:auto; border-radius:12px 12px 0 0;
                 box-shadow:0 -1px 0 rgb(255 255 255 / .1), 0 -24px 70px rgb(37 187 77 / .12)}

  /* --------------------------------------------------------------- sections */
  section{padding:110px 0 88px}
  section.light{background:var(--wash)}
  h2{font-size:38px; font-weight:600; line-height:1.15; margin:0 0 14px; letter-spacing:-.015em}
  .lede{font-size:18px; color:var(--muted); max-width:60ch; margin:0 0 40px}
  .kicker{
    display:inline-block; font-size:12px; font-weight:700; color:var(--accent);
    text-transform:uppercase; letter-spacing:.09em; margin-bottom:12px;
  }

  .split{display:grid; gap:56px; grid-template-columns:1fr 1.15fr; align-items:center}
  .split.flip > :first-child{order:2}
  @media (max-width:900px){
    .split{grid-template-columns:1fr; gap:32px}
    .split.flip > :first-child{order:0}
    .hero h1{font-size:34px} h2{font-size:27px} section{padding:64px 0 56px}
  }

  .shot svg{display:block; width:100%; height:auto; border-radius:12px; box-shadow:0 14px 40px rgb(5 19 32 / .12)}

  ul.checks{list-style:none; padding:0; margin:0}
  ul.checks li{position:relative; padding-left:28px; margin-bottom:16px; color:var(--muted)}
  ul.checks li::before{
    content:""; position:absolute; left:0; top:8px; width:13px; height:7px;
    border-left:2px solid var(--accent); border-bottom:2px solid var(--accent); transform:rotate(-45deg);
  }
  ul.checks b{color:var(--ink); font-weight:600}

  .cards{display:grid; gap:20px; grid-template-columns:repeat(auto-fit,minmax(270px,1fr))}
  .card{background:#fff; border:1px solid var(--line); border-radius:14px; padding:26px}
  .card h3{font-size:18px; font-weight:600; margin:0 0 8px}
  .card p{margin:0; color:var(--muted); font-size:15px}

  /* -------------------------------------------------------------------- cta */
  .cta{background:var(--ink); color:#fff; text-align:center; padding:86px 0}
  .cta h2{margin-bottom:12px}
  .cta p{color:rgb(255 255 255 / .7); margin:0 0 30px; font-size:18px}
  .cta .downloads{justify-content:center}

  footer{border-top:1px solid var(--line); padding:34px 0; color:var(--muted); font-size:13px}
  footer .wrap{display:flex; gap:18px; flex-wrap:wrap; align-items:center}
  footer a{color:var(--muted)}
  code{background:var(--wash); border:1px solid var(--line); border-radius:5px; padding:1px 6px; font-size:.9em}
  .note{font-size:14px; color:var(--muted); margin-top:28px; padding-left:14px; border-left:2px solid var(--line)}
</style>
</head>
<body>

<header class="nav">
  <div class="wrap">
    <div class="brand">
      ${logoMark(30)}
      ai<span>dash</span>
    </div>
    <div class="nav-spacer"></div>
    <a href="#usage" class="hide-sm">Usage</a>
    <a href="#sessions" class="hide-sm">Sessions</a>
    <a href="#privacy" class="hide-sm">Privacy</a>
    <a href="${repoUrl}" class="hide-sm">Source</a>
    <a class="btn dark" href="#download">Download</a>
  </div>
</header>

<div class="hero">
  <div class="wrap">
    <h1>Every AI quota on one screen</h1>
    <p class="sub">
      Run several Claude and Codex accounts and you lose track of which one is about to stop working.
      aidash shows all of them at once — how much of each limit is gone, and when it resets.
    </p>
    <div class="downloads" id="download">
      ${PLATFORMS.map((p, i) => downloadButton(p, downloads, { ghost: i > 0 })).join('')}
    </div>
    <p class="meta">
      Version ${version} · free and <a href="${repoUrl}">open source</a>
      ${anyDownload ? '' : ' · builds are published on the releases page'}
    </p>
    <div class="hero-shot">${usageMockup()}</div>
  </div>
</div>

<section id="usage">
  <div class="wrap">
    <span class="kicker">Usage</span>
    <h2>A quota is not one number</h2>
    <p class="lede">
      Each provider measures usage its own way, and any single limit can stop you. aidash shows them as
      the provider reports them rather than flattening everything into one misleading percentage.
    </p>
    <div class="cards">
      <div class="card">
        <h3>Claude</h3>
        <p>Session, weekly and per-model windows, each with its own reset time and its own bar.</p>
      </div>
      <div class="card">
        <h3>Codex</h3>
        <p>The shared weekly window <em>and</em> your personal spend control, which run out independently.</p>
      </div>
      <div class="card">
        <h3>Sorted by urgency</h3>
        <p>Whatever is closest to running out sits at the top, in the colour that says how close.</p>
      </div>
    </div>
    <p class="note">
      Shape matters more than the number: a third of a shared quota spent is no comfort when the personal
      spend control beside it is already full.
    </p>
  </div>
</section>

<section class="light" id="sessions">
  <div class="wrap">
    <div class="split flip">
      <div>
        <span class="kicker">Local Sessions</span>
        <h2>Move a conversation to the right account</h2>
        <p class="lede">
          Work in one project under two accounts and your history ends up split between them — visible
          under one, missing under the other. Drag a session across to hand it over.
        </p>
        <ul class="checks">
          <li><b>Grouped by project</b> — every folder, with each account's sessions side by side</li>
          <li><b>Same folder only</b> — a session belongs to the directory it ran in</li>
          <li><b>Nothing overwritten</b> — a move stops rather than clobber what is already there</li>
          <li><b>Across tools too</b> — Claude and Codex describe conversations differently, so that one copies the dialogue and says so first</li>
        </ul>
      </div>
      <div class="shot">${sessionsMockup()}</div>
    </div>
  </div>
</section>

<section id="privacy">
  <div class="wrap">
    <span class="kicker">Privacy</span>
    <h2>Your credentials never leave the machine</h2>
    <p class="lede">
      aidash stores no secrets of its own. Signing in hands you to the vendor's own client, which keeps
      its credentials where it always has. The app only remembers which directory belongs to which account.
    </p>
    <div class="cards">
      <div class="card">
        <h3>Nothing to sign up for</h3>
        <p>No server, no login, no password. The app talks to Anthropic and OpenAI directly, on your behalf, from your machine.</p>
      </div>
      <div class="card">
        <h3>Only while you look</h3>
        <p>It refreshes when you open the window and when you ask. Nothing runs in the background, and nothing is collected.</p>
      </div>
      <div class="card">
        <h3>Read the code</h3>
        <p>Every request it makes is in the repository. There is no telemetry and nowhere for your data to go.</p>
      </div>
    </div>
    <p class="note">
      Session handling is unofficial: neither tool documents how conversations are stored on disk, so it
      was worked out by reading the files. The app says as much before it touches anything.
    </p>
  </div>
</section>

<div class="cta">
  <div class="wrap">
    <h2>Stop guessing which account still has room</h2>
    <p>Add your accounts once. See all of them every time you open the window.</p>
    <div class="downloads">
      ${PLATFORMS.map((p, i) => downloadButton(p, downloads, { ghost: i > 0 })).join('')}
    </div>
  </div>
</div>

<footer>
  <div class="wrap">
    <span>aidash ${version} — an <a href="https://itexus.com">Itexus</a> tool</span>
    <span class="nav-spacer"></span>
    <a href="${repoUrl}">Repository</a>
    <a href="${repoUrl}/-/releases">Releases</a>
    <a href="/version.json">Version manifest</a>
  </div>
</footer>

</body>
</html>`;
}

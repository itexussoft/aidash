/**
 * Landing page for aidash.itex.us.
 *
 * Styled after itexus.com, using values read off the live site rather than
 * guessed: Heebo, ink #051320, accent #25BB4D, 48/600 headline, 10px buttons.
 */

const ACCENT = '#25BB4D';
const ACCENT_DARK = '#2CAA4D';
const INK = '#051320';
const MUTED = '#6E717A';
const WASH = '#F6F8F8';
const LINE = '#E8E8E8';
const SURFACE = '#1F2432';

export function renderLanding({ version, downloadUrl, repoUrl }) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>aidash — one screen for every Claude and Codex quota</title>
<meta name="description" content="A desktop dashboard showing how much of each Claude and Codex account you have used. Credentials never leave your machine.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:${INK}; --accent:${ACCENT}; --accent-dark:${ACCENT_DARK};
    --muted:${MUTED}; --wash:${WASH}; --line:${LINE}; --surface:${SURFACE};
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:#fff; color:var(--ink);
    font:16px/1.6 Heebo,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:1080px; margin:0 auto; padding:0 24px}

  header.nav{border-bottom:1px solid var(--line)}
  header.nav .wrap{display:flex; align-items:center; gap:16px; height:68px}
  .brand{font-weight:700; font-size:18px; letter-spacing:-.01em}
  .brand span{color:var(--accent)}
  .nav-spacer{flex:1}
  .nav a{color:var(--muted); text-decoration:none; font-size:14px; font-weight:500}
  .nav a:hover{color:var(--ink)}

  .btn{
    display:inline-block; background:var(--accent); color:#fff; text-decoration:none;
    border-radius:10px; padding:11px 26px; font-size:14px; font-weight:600; border:0;
    transition:background .15s;
  }
  .btn:hover{background:var(--accent-dark)}
  .btn.ghost{background:transparent; color:#fff; border:1px solid rgb(255 255 255 / .3)}
  .btn.ghost:hover{background:rgb(255 255 255 / .1)}

  .hero{background:var(--ink); color:#fff; padding:96px 0 104px}
  .hero h1{font-size:48px; font-weight:600; line-height:1.1; margin:0 0 20px; max-width:17ch}
  .hero p{font-size:19px; color:rgb(255 255 255 / .78); max-width:56ch; margin:0 0 36px}
  .hero .actions{display:flex; gap:14px; flex-wrap:wrap; align-items:center}
  .hero .meta{font-size:13px; color:rgb(255 255 255 / .5); margin-top:20px}

  section{padding:88px 0}
  section.wash{background:var(--wash)}
  h2{font-size:40px; font-weight:600; line-height:1.15; margin:0 0 16px}
  .lede{font-size:18px; color:var(--muted); max-width:62ch; margin:0 0 48px}

  .cards{display:grid; gap:24px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
  .card{background:#fff; border:1px solid var(--line); border-radius:14px; padding:28px}
  section.wash .card{background:#fff}
  .card h3{font-size:19px; font-weight:600; margin:0 0 10px}
  .card p{margin:0; color:var(--muted); font-size:15px}
  .card .k{
    display:inline-block; font-size:12px; font-weight:600; color:var(--accent);
    text-transform:uppercase; letter-spacing:.06em; margin-bottom:12px;
  }

  .split{display:grid; gap:56px; grid-template-columns:1fr 1fr; align-items:center}
  @media (max-width:820px){ .split{grid-template-columns:1fr; gap:32px} .hero h1{font-size:34px} h2{font-size:28px} }

  .shot{
    background:var(--surface); border-radius:14px; padding:22px; color:#fff;
    font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  .shot .row{display:flex; justify-content:space-between; margin-bottom:6px}
  .shot .bar{height:6px; border-radius:99px; background:rgb(255 255 255 / .14); margin-bottom:16px; overflow:hidden}
  .shot .bar i{display:block; height:100%; border-radius:99px; background:var(--accent)}
  .shot .bar.hot i{background:#C0402E}
  .shot .who{color:rgb(255 255 255 / .55); font-size:12px; margin-bottom:14px}

  ul.checks{list-style:none; padding:0; margin:0}
  ul.checks li{position:relative; padding-left:28px; margin-bottom:14px; color:var(--muted)}
  ul.checks li::before{
    content:""; position:absolute; left:0; top:8px; width:14px; height:8px;
    border-left:2px solid var(--accent); border-bottom:2px solid var(--accent);
    transform:rotate(-45deg);
  }
  ul.checks b{color:var(--ink); font-weight:600}

  .cta{background:var(--ink); color:#fff; text-align:center; padding:88px 0}
  .cta h2{margin-bottom:14px}
  .cta p{color:rgb(255 255 255 / .72); margin:0 0 32px; font-size:18px}

  footer{border-top:1px solid var(--line); padding:36px 0; color:var(--muted); font-size:13px}
  footer .wrap{display:flex; gap:16px; flex-wrap:wrap; align-items:center}
  footer a{color:var(--muted)}
  code{background:var(--wash); border:1px solid var(--line); border-radius:5px; padding:1px 6px; font-size:.9em}
  .hero code{background:rgb(255 255 255 / .1); border-color:rgb(255 255 255 / .18)}
</style>
</head>
<body>

<header class="nav">
  <div class="wrap">
    <div class="brand">ai<span>dash</span></div>
    <div class="nav-spacer"></div>
    <a href="#what">What it does</a>
    <a href="#privacy">Privacy</a>
    <a href="${repoUrl}">Source</a>
  </div>
</header>

<div class="hero">
  <div class="wrap">
    <h1>One screen for every Claude and Codex quota</h1>
    <p>
      Run several AI coding accounts and you lose track of which one is about to stop working.
      aidash shows all of them at once — how much of each limit is gone, and when it resets.
    </p>
    <div class="actions">
      <a class="btn" href="${downloadUrl}">Download for macOS</a>
      <a class="btn ghost" href="${repoUrl}">View source</a>
    </div>
    <p class="meta">Version ${version} · macOS · Requires the Codex or Claude Code CLI you already use</p>
  </div>
</div>

<section id="what">
  <div class="wrap">
    <div class="split">
      <div>
        <h2>Quotas are not one number</h2>
        <p class="lede">
          Each provider measures usage its own way, and any of the limits can stop you on its own.
          aidash shows them as the provider reports them rather than flattening everything into a
          single misleading percentage.
        </p>
        <ul class="checks">
          <li><b>Claude</b> — session, weekly, and per-model windows, each with its own reset</li>
          <li><b>Codex</b> — the shared weekly window <em>and</em> your personal spend control</li>
          <li><b>Both</b> — sorted so the limit closest to exhaustion is on top</li>
        </ul>
      </div>
      <div class="shot">
        <div class="who">claude.dev@itexus.com · max</div>
        <div class="row"><span>weekly all</span><span>56%</span></div>
        <div class="bar"><i style="width:56%"></i></div>
        <div class="row"><span>weekly · Fable</span><span>46%</span></div>
        <div class="bar"><i style="width:46%"></i></div>
        <div class="who" style="margin-top:22px">codex.dev@itexus.com · team</div>
        <div class="row"><span>weekly window</span><span>15%</span></div>
        <div class="bar"><i style="width:15%"></i></div>
        <div class="row"><span>personal spend control</span><span>100%</span></div>
        <div class="bar hot"><i style="width:100%"></i></div>
      </div>
    </div>
  </div>
</section>

<section class="wash" id="privacy">
  <div class="wrap">
    <h2>Your credentials never leave the machine</h2>
    <p class="lede">
      aidash stores no secrets of its own. Signing in hands you to the vendor's own client, which
      keeps its credentials where it always has — its config directory, and the system keychain.
      The app only remembers which directory belongs to which account.
    </p>
    <div class="cards">
      <div class="card">
        <span class="k">No account</span>
        <h3>Nothing to sign up for</h3>
        <p>No server, no login, no password. The app talks to Anthropic and OpenAI directly, on your behalf, from your machine.</p>
      </div>
      <div class="card">
        <span class="k">No background polling</span>
        <h3>Only while you look</h3>
        <p>It refreshes when you open the window and when you ask. Nothing runs when the app is closed.</p>
      </div>
      <div class="card">
        <span class="k">Open</span>
        <h3>Read the code</h3>
        <p>Every request it makes is in the repository. There is no telemetry and nowhere for data to go.</p>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Move sessions between accounts</h2>
    <p class="lede">
      Work in one project under two different Claude Code accounts and your history ends up split
      between them. The Utils tab shows every session grouped by project folder, one column per
      account — drag a session across to move it, along with its environment.
    </p>
    <div class="cards">
      <div class="card">
        <span class="k">Grouped by project</span>
        <h3>See the split</h3>
        <p>Every project folder, with each account's sessions side by side, so you can tell at a glance where your history actually is.</p>
      </div>
      <div class="card">
        <span class="k">Safe by construction</span>
        <h3>Same folder only</h3>
        <p>A session belongs to the directory it ran in, so it can only be dropped into another account's column of its own row.</p>
      </div>
      <div class="card">
        <span class="k">Nothing overwritten</span>
        <h3>Refuses to lose data</h3>
        <p>A move stops rather than clobber an existing session, and the session's <code>session-env</code> travels with it.</p>
      </div>
    </div>
  </div>
</section>

<div class="cta">
  <div class="wrap">
    <h2>Stop guessing which account still has room</h2>
    <p>Add your accounts once. See all of them every time you open the window.</p>
    <a class="btn" href="${downloadUrl}">Download aidash ${version}</a>
  </div>
</div>

<footer>
  <div class="wrap">
    <span>aidash — an <a href="https://itexus.com">Itexus</a> internal tool</span>
    <span class="nav-spacer"></span>
    <a href="${repoUrl}">Repository</a>
    <a href="/version.json">Version manifest</a>
  </div>
</footer>

</body>
</html>`;
}

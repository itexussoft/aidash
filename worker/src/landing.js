/**
 * Landing page for aidash.itex.us.
 *
 * Styled after itexus.com, using values measured off the live site rather than
 * guessed: Heebo, ink #051320, accent #25BB4D, tight display weights.
 *
 * Two things carry the "this is a real product" feeling and both are cheap:
 * light — a single accent glow and a faint grid keep the dark blocks from
 * reading as flat fills — and rhythm, so type and spacing step through a scale
 * instead of being chosen per element. Everything is fluid (clamp) rather than
 * switched at breakpoints, so there is no width at which the page looks broken.
 *
 * Downloads are derived from the release manifest, so a platform with no build
 * yet says so instead of offering a link that 404s.
 */

import {
	usageMockup,
	usageMockupCompact,
	sessionsMockup,
	sessionsMockupCompact,
	logoLockup,
} from './mockups.js';

const ACCENT = '#25BB4D';
const ACCENT_DARK = '#1FA543';
const INK = '#051320';
const MUTED = '#6E717A';
const WASH = '#F6F8F8';
const LINE = '#E8E8E8';

const SITE = 'https://aidash.itex.us';

const PLATFORMS = [
	{ key: 'darwin-arm64', name: 'macOS', detail: 'Apple Silicon', glyph: 'apple' },
	{ key: 'darwin-x64', name: 'macOS', detail: 'Intel', glyph: 'apple' },
	{ key: 'win32-x64', name: 'Windows', detail: '64-bit', glyph: 'windows' },
];

/**
 * Glyphs, inline so the page still makes no external request.
 *
 * Drawn on a 24 grid and sized by CSS. The two platform marks are filled; the
 * rest are strokes at a single weight, which is what keeps a set of icons
 * looking like a set rather than a collection.
 */
const FILLED = {
	apple:
		'<path d="M17.05 12.54c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.09-2.01-3.76-2.04-1.6-.16-3.12.94-3.93.94-.81 0-2.06-.92-3.39-.9-1.74.03-3.35 1.01-4.25 2.57-1.81 3.14-.46 7.79 1.3 10.34.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.39.81 1.4-.02 2.28-1.27 3.13-2.53.99-1.45 1.4-2.86 1.42-2.93-.03-.01-2.72-1.04-2.75-4.11Z"/><path d="M14.9 4.9c.71-.86 1.19-2.06 1.06-3.25-1.02.04-2.26.68-3 1.54-.66.76-1.24 1.98-1.08 3.15 1.14.09 2.3-.58 3.02-1.44Z"/>',
	windows:
		'<path d="M3 5.75 10.4 4.7v7.05H3V5.75Z"/><path d="M11.9 4.5 21 3.2v8.55h-9.1V4.5Z"/><path d="M3 12.9h7.4v7.05L3 18.9v-6Z"/><path d="M11.9 12.9H21v8.55l-9.1-1.3v-7.25Z"/>',
};

const STROKED = {
	gauge: '<path d="M4.6 18a9 9 0 1 1 14.8 0"/><circle cx="12" cy="12.2" r="2"/><path d="m13.6 10.6 3.2-3.2"/>',
	layers: '<path d="m12 3 8.5 4.7-8.5 4.7L3.5 7.7 12 3Z"/><path d="m3.5 13.2 8.5 4.7 8.5-4.7"/>',
	sort: '<path d="M7 4.5v15"/><path d="m3.8 16.2 3.2 3.3 3.2-3.3"/><path d="M13.5 6h7"/><path d="M13.5 11.5h5"/><path d="M13.5 17h3"/>',
	lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M9 10.5V7.6a3 3 0 0 1 6 0v2.9"/>',
	eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
	code: '<path d="m8.5 6-5.5 6 5.5 6"/><path d="m15.5 6 5.5 6-5.5 6"/>',
	download: '<path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5L16.5 10"/><path d="M4 20h16"/>',
	accounts:
		'<circle cx="9.5" cy="8" r="3.5"/><path d="M3.5 20v-.8a4.7 4.7 0 0 1 4.7-4.7h2.6a4.7 4.7 0 0 1 4.7 4.7v.8"/><path d="M18.5 7.5v5"/><path d="M16 10h5"/>',
	transfer: '<path d="M4 8.5h13"/><path d="m14 5.5 3 3-3 3"/><path d="M20 15.5H7"/><path d="m10 12.5-3 3 3 3"/>',
};

const icon = (name) =>
	FILLED[name]
		? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${FILLED[name]}</svg>`
		: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STROKED[name]}</svg>`;

/** A download button, or a disabled one saying why it cannot be offered. */
function downloadButton(platform, downloads, { primary = false } = {}) {
	const url = downloads?.[platform.key];
	// Same silhouette whether or not a build exists, so the row of buttons keeps
	// one baseline instead of stepping up and down.
	const body = `${icon(platform.glyph)}<span class="txt"><strong>${platform.name}</strong><em>${platform.detail}</em></span>`;
	if (!url) return `<span class="btn disabled" title="No build published for this platform yet">${body}</span>`;
	return `<a class="btn${primary ? ' primary' : ''}" data-os="${platform.key}" href="${url}">${body}</a>`;
}

/** The row of downloads, repeated verbatim in the hero and in the closing CTA. */
const downloadRow = (downloads) =>
	`<div class="downloads">${PLATFORMS.map((p, i) => downloadButton(p, downloads, { primary: i === 0 })).join('')}</div>`;

const card = (glyph, title, body) =>
	`<div class="card" data-reveal><span class="ico">${icon(glyph)}</span><h3>${title}</h3><p>${body}</p></div>`;

/**
 * The favicon, as a data URI.
 *
 * The dark tile is back for this one: at 16px a bare ring on the browser's own
 * white chrome loses its counter and turns into a dot, whereas the tile holds
 * the shape. Same drawing as build/icon.png, minus the detail nothing that
 * small can carry.
 */
const FAVICON =
	`data:image/svg+xml,` +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="${INK}"/><circle cx="20" cy="20" r="12.5" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="6"/><path d="M20 7.5A12.5 12.5 0 1 1 8.2 24" fill="none" stroke="${ACCENT}" stroke-width="6" stroke-linecap="round"/></svg>`,
	);

const DESCRIPTION =
	'A desktop dashboard showing how much of each Claude and Codex account you have used, and a tool for moving Claude Code sessions between accounts. Credentials never leave your machine.';

export function renderLanding({ version, downloads, repoUrl }) {
	const anyDownload = PLATFORMS.some((p) => downloads?.[p.key]);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>aidash — one screen for every Claude and Codex quota</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${SITE}/">
<link rel="icon" href="${FAVICON}">
<meta name="theme-color" content="${INK}">
<meta name="color-scheme" content="light">
<meta property="og:type" content="website">
<meta property="og:site_name" content="aidash">
<meta property="og:url" content="${SITE}/">
<meta property="og:title" content="aidash — every AI quota on one screen">
<meta property="og:description" content="${DESCRIPTION}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="aidash — every AI quota on one screen">
<meta name="twitter:description" content="${DESCRIPTION}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700&display=swap" rel="stylesheet">
<script>document.documentElement.className+=" js"</script>
<style>
  :root{
    --ink:${INK}; --accent:${ACCENT}; --accent-dark:${ACCENT_DARK};
    --muted:${MUTED}; --wash:${WASH}; --line:${LINE}; --line-strong:#DBE1E4;
    --lift:0 1px 2px rgb(5 19 32 / .04), 0 14px 34px -12px rgb(5 19 32 / .18);
    --ease:cubic-bezier(.2,.7,.3,1);
    --nav:66px;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth; scroll-padding-top:calc(var(--nav) + 24px); -webkit-text-size-adjust:100%}
  body{
    margin:0; background:#fff; color:var(--ink);
    font:400 16px/1.65 Heebo,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  }
  .wrap{max-width:1140px; margin:0 auto; padding:0 24px}
  ::selection{background:rgb(37 187 77 / .22)}
  :focus-visible{outline:2px solid var(--accent); outline-offset:3px; border-radius:6px}

  /* ------------------------------------------------------------------ nav */
  /* Dark to begin with, so it is part of the hero rather than a white bar
     laid across it, and only turns into glass once the hero has gone by. */
  header.nav{
    position:sticky; top:0; z-index:30; background:var(--ink); color:#fff;
    border-bottom:1px solid rgb(255 255 255 / .07);
    transition:background .3s var(--ease), color .3s var(--ease), border-color .3s var(--ease), box-shadow .3s var(--ease);
  }
  header.nav.solid{
    background:rgb(255 255 255 / .82); color:var(--ink);
    -webkit-backdrop-filter:saturate(180%) blur(14px); backdrop-filter:saturate(180%) blur(14px);
    border-bottom-color:var(--line); box-shadow:0 1px 30px rgb(5 19 32 / .06);
  }
  header.nav .wrap{display:flex; align-items:center; gap:8px; height:var(--nav)}
  .brand{text-decoration:none; color:inherit; margin-right:8px}
  .lockup{display:inline-flex; align-items:center; gap:9px}
  .lockup-mark{width:26px; height:26px; flex:none; display:block}
  .lockup-word{font-size:20px; font-weight:700; letter-spacing:-.035em; line-height:1; color:inherit}
  .lockup-accent{color:var(--accent)}
  .nav-spacer{flex:1}
  .nav-link{
    color:inherit; opacity:.66; text-decoration:none; font-size:14.5px; font-weight:500;
    padding:8px 12px; border-radius:8px; transition:opacity .15s, background .15s;
  }
  .nav-link:hover{opacity:1; background:rgb(127 140 150 / .12)}
  .nav .btn{min-height:38px; padding:0 18px; font-size:13.5px; border-radius:9px; margin-left:8px}
  @media (max-width:820px){ .nav .hide-sm{display:none} }

  /* --------------------------------------------------------------- buttons */
  .btn{
    display:inline-flex; align-items:center; gap:11px; min-height:54px; padding:0 22px;
    border-radius:12px; border:1px solid rgb(255 255 255 / .16); background:rgb(255 255 255 / .06);
    color:#fff; text-decoration:none; font-weight:600; white-space:nowrap;
    -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    transition:transform .18s var(--ease), background .18s, border-color .18s, box-shadow .25s;
  }
  .btn .txt{display:flex; flex-direction:column; line-height:1.2; text-align:left}
  .btn strong{font-size:14.5px; font-weight:600}
  .btn em{font-style:normal; font-size:12px; font-weight:400; opacity:.72}
  .btn svg{width:18px; height:18px; flex:none; opacity:.9}
  .btn:hover{background:rgb(255 255 255 / .12); border-color:rgb(255 255 255 / .3); transform:translateY(-2px)}
  .btn:active{transform:translateY(0)}
  .btn.primary{
    background:var(--accent); border-color:transparent; color:#fff;
    box-shadow:inset 0 1px 0 rgb(255 255 255 / .22), 0 10px 26px -8px rgb(37 187 77 / .7);
  }
  .btn.primary:hover{background:var(--accent-dark); box-shadow:inset 0 1px 0 rgb(255 255 255 / .22), 0 16px 34px -10px rgb(37 187 77 / .85)}
  .btn.disabled{
    background:none; border-style:dashed; border-color:rgb(255 255 255 / .18);
    color:rgb(255 255 255 / .4); cursor:not-allowed; box-shadow:none;
  }
  .btn.disabled:hover{transform:none; background:none; border-color:rgb(255 255 255 / .18)}
  .btn.disabled em::after{content:" · not yet built"}
  /* On a light background the same button has to borrow the ink, not the paper. */
  .nav.solid .btn:not(.primary){background:rgb(5 19 32 / .04); border-color:var(--line-strong); color:var(--ink)}

  /* ------------------------------------------------------------------ hero */
  .hero{position:relative; isolation:isolate; background:var(--ink); color:#fff; overflow:hidden;
        padding:clamp(56px,8vw,104px) 0 clamp(64px,8vw,110px)}
  /* One light source above the headline, and a grid faint enough to be felt
     rather than seen — both masked out before they reach the edges. */
  .hero::before{
    content:""; position:absolute; left:50%; top:-460px; width:1200px; height:900px;
    transform:translateX(-50%); pointer-events:none; z-index:-1;
    background:radial-gradient(50% 50% at 50% 50%, rgb(37 187 77 / .22), transparent 70%);
  }
  .hero::after{
    content:""; position:absolute; inset:0; pointer-events:none; z-index:-1;
    background-image:linear-gradient(rgb(255 255 255 / .045) 1px,transparent 1px),
                     linear-gradient(90deg,rgb(255 255 255 / .045) 1px,transparent 1px);
    background-size:76px 76px;
    -webkit-mask-image:radial-gradient(72% 58% at 50% 22%,#000,transparent);
    mask-image:radial-gradient(72% 58% at 50% 22%,#000,transparent);
  }
  .hero-copy{text-align:center; max-width:900px; margin:0 auto}
  .pill{
    display:inline-flex; align-items:center; gap:9px; height:31px; padding:0 15px; border-radius:999px;
    background:rgb(255 255 255 / .06); border:1px solid rgb(255 255 255 / .13);
    font-size:12.5px; font-weight:500; color:rgb(255 255 255 / .8); margin:0 0 24px;
  }
  .pill i{width:6px; height:6px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px rgb(37 187 77 / .18)}
  .pill a{color:#fff; text-decoration-color:rgb(255 255 255 / .4)}
  .hero h1{
    font-size:clamp(36px,5.6vw,62px); font-weight:600; line-height:1.05; letter-spacing:-.03em;
    margin:0 auto 22px; max-width:16ch;
    background:linear-gradient(180deg,#fff 34%,rgb(255 255 255 / .62));
    -webkit-background-clip:text; background-clip:text; color:transparent;
  }
  @supports not ((-webkit-background-clip:text) or (background-clip:text)){ .hero h1{color:#fff} }
  .hero .sub{font-size:clamp(17px,1.5vw,19.5px); color:rgb(255 255 255 / .72); max-width:57ch; margin:0 auto 34px}
  .downloads{display:flex; gap:12px; flex-wrap:wrap; justify-content:center}
  .hero .meta{font-size:13.5px; color:rgb(255 255 255 / .45); margin-top:20px}
  .hero .meta a{color:rgb(255 255 255 / .72)}
  /* The window sits on a pedestal — a hairline bezel and a long shadow — so it
     reads as an object in the space rather than a picture pasted on it. */
  .hero-shot{
    position:relative; max-width:960px; margin:clamp(48px,6vw,76px) auto 0; padding:10px;
    border-radius:18px; border:1px solid rgb(255 255 255 / .1);
    background:linear-gradient(180deg,rgb(255 255 255 / .11),rgb(255 255 255 / .02));
    box-shadow:0 50px 100px -30px rgb(0 0 0 / .75), 0 -14px 70px -30px rgb(37 187 77 / .5);
  }
  .hero-shot svg{display:block; width:100%; height:auto; border-radius:9px}

  /* --------------------------------------------------------------- sections */
  section{padding:clamp(72px,9vw,118px) 0}
  section.light{background:var(--wash)}
  /* The drawings are white windows; on a near-white block they vanish, so the
     section they sit in is dark and they read as screens again. */
  section.dark{background:var(--ink); color:#fff; position:relative; isolation:isolate; overflow:hidden}
  section.dark::before{
    content:""; position:absolute; right:-10%; top:-30%; width:900px; height:900px; pointer-events:none; z-index:-1;
    background:radial-gradient(50% 50% at 50% 50%, rgb(37 187 77 / .13), transparent 70%);
  }
  section.dark .lede{color:rgb(255 255 255 / .68)}
  section.dark ul.checks li{color:rgb(255 255 255 / .66)}
  section.dark ul.checks b{color:#fff}
  h2{font-size:clamp(27px,3.5vw,40px); font-weight:600; line-height:1.14; margin:0 0 16px; letter-spacing:-.022em}
  .lede{font-size:clamp(16.5px,1.4vw,18px); color:var(--muted); max-width:62ch; margin:0 0 44px}
  .kicker{
    display:inline-block; font-size:12px; font-weight:700; color:var(--accent);
    text-transform:uppercase; letter-spacing:.1em; margin-bottom:14px;
  }

  .split{display:grid; gap:clamp(36px,5vw,64px); grid-template-columns:1fr 1.16fr; align-items:center}
  .split .lede{margin-bottom:32px}

  .shot{
    position:relative; padding:8px; border-radius:16px; border:1px solid rgb(255 255 255 / .1);
    background:linear-gradient(180deg,rgb(255 255 255 / .1),rgb(255 255 255 / .02));
    box-shadow:0 36px 80px -26px rgb(0 0 0 / .7);
  }
  .shot svg{display:block; width:100%; height:auto; border-radius:9px}
  /* Phones get the narrower crop of each drawing; everything else the wide one. */
  .m-compact{display:none}
  @media (max-width:640px){ .m-full{display:none} .m-compact{display:block} }

  ul.checks{list-style:none; padding:0; margin:0}
  ul.checks li{position:relative; padding-left:34px; margin-bottom:18px; color:var(--muted)}
  ul.checks li::before{
    content:""; position:absolute; left:0; top:2px; width:21px; height:21px; border-radius:50%;
    background:rgb(37 187 77 / .16);
  }
  ul.checks li::after{
    content:""; position:absolute; left:6.5px; top:8.5px; width:8px; height:4px;
    border-left:2px solid var(--accent); border-bottom:2px solid var(--accent); transform:rotate(-45deg);
  }
  ul.checks b{color:var(--ink); font-weight:600}

  .cards{display:grid; gap:22px; grid-template-columns:repeat(auto-fit,minmax(272px,1fr))}
  .card{
    background:#fff; border:1px solid var(--line); border-radius:16px; padding:28px 26px 30px;
    transition:transform .25s var(--ease), box-shadow .3s var(--ease), border-color .25s;
  }
  .card:hover{transform:translateY(-3px); border-color:var(--line-strong); box-shadow:var(--lift)}
  .card .ico{
    display:grid; place-items:center; width:40px; height:40px; border-radius:11px;
    background:rgb(37 187 77 / .1); color:var(--accent); margin-bottom:18px;
  }
  .card .ico svg{width:20px; height:20px}
  .card h3{font-size:17.5px; font-weight:600; margin:0 0 8px; letter-spacing:-.008em}
  .card p{margin:0; color:var(--muted); font-size:15px}

  /* ------------------------------------------------------------------ steps */
  .steps{padding:clamp(52px,6vw,72px) 0}
  .steps-grid{display:grid; grid-template-columns:repeat(3,1fr); gap:0}
  .step{padding:4px 0 4px 34px; border-left:1px solid var(--line)}
  .step:first-child{padding-left:0; border-left:0}
  .step:last-child{padding-right:0}
  .step .num{
    display:flex; align-items:center; gap:10px; font-size:12px; font-weight:700;
    letter-spacing:.12em; color:var(--accent); margin-bottom:12px;
  }
  .step .num svg{width:17px; height:17px}
  .step h3{font-size:17px; font-weight:600; margin:0 0 6px}
  .step p{margin:0; color:var(--muted); font-size:14.5px}
  @media (max-width:820px){
    .steps-grid{grid-template-columns:1fr; gap:26px}
    .step{padding:0 0 0 0; border-left:0; border-top:1px solid var(--line); padding-top:22px}
    .step:first-child{border-top:0; padding-top:0}
  }

  /* -------------------------------------------------------------------- cta */
  .cta{text-align:center}
  .cta h2{margin:0 auto 14px; max-width:20ch}
  .cta p{color:rgb(255 255 255 / .7); margin:0 auto 34px; font-size:clamp(16.5px,1.4vw,18px); max-width:52ch}
  .cta .meta{font-size:13.5px; color:rgb(255 255 255 / .42); margin-top:22px}

  .note{
    margin-top:36px; max-width:78ch; padding:16px 20px; font-size:14.5px; color:var(--muted);
    background:var(--wash); border-left:2px solid var(--accent); border-radius:0 10px 10px 0;
  }
  section.light .note{background:#fff}

  /* ----------------------------------------------------------------- footer */
  footer{border-top:1px solid var(--line); padding:56px 0 32px; color:var(--muted); font-size:14.5px}
  .foot{display:grid; grid-template-columns:1.6fr 1fr 1fr; gap:36px}
  .foot p{margin:14px 0 0; max-width:34ch; font-size:14.5px}
  .foot h4{font-size:12px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--ink); margin:0 0 14px}
  .foot a{display:block; color:var(--muted); text-decoration:none; margin-bottom:10px; width:fit-content}
  .foot a:hover{color:var(--ink)}
  .foot-base{
    display:flex; gap:16px; flex-wrap:wrap; align-items:center; font-size:13px;
    margin-top:44px; padding-top:24px; border-top:1px solid var(--line);
  }
  .foot-base a{color:var(--muted)}
  @media (max-width:820px){ .foot{grid-template-columns:1fr 1fr; gap:32px} .foot>:first-child{grid-column:1/-1} }

  @media (max-width:900px){
    .split{grid-template-columns:1fr}
    .split .shot{order:-1}
  }
  @media (max-width:520px){
    .downloads{flex-direction:column; align-items:stretch}
    .btn{justify-content:center}
    .btn .txt{text-align:center}
  }

  /* ------------------------------------------------------------- motion */
  @keyframes rise{from{opacity:0; transform:translateY(18px)} to{opacity:1; transform:none}}
  html.js .hero-copy>*{animation:rise .8s var(--ease) both}
  html.js .hero-copy>*:nth-child(2){animation-delay:.06s}
  html.js .hero-copy>*:nth-child(3){animation-delay:.12s}
  html.js .hero-copy>*:nth-child(4){animation-delay:.18s}
  html.js .hero-copy>*:nth-child(5){animation-delay:.24s}
  html.js .hero-shot{animation:rise 1s var(--ease) .3s both}
  html.js [data-reveal]{opacity:0; transform:translateY(16px)}
  html.js [data-reveal].in{
    opacity:1; transform:none;
    transition:opacity .7s var(--ease), transform .7s var(--ease);
  }
  html.js .cards [data-reveal]:nth-child(2).in{transition-delay:.08s}
  html.js .cards [data-reveal]:nth-child(3).in{transition-delay:.16s}
  @media (prefers-reduced-motion:reduce){
    html{scroll-behavior:auto}
    html.js [data-reveal]{opacity:1; transform:none}
    *,*::before,*::after{animation-duration:.001ms!important; animation-delay:0ms!important; transition-duration:.001ms!important}
  }
</style>
</head>
<body id="top">

<header class="nav">
  <div class="wrap">
    <a class="brand" href="#top" aria-label="aidash — home">${logoLockup()}</a>
    <div class="nav-spacer"></div>
    <a href="#usage" class="nav-link hide-sm">Usage</a>
    <a href="#sessions" class="nav-link hide-sm">Sessions</a>
    <a href="#privacy" class="nav-link hide-sm">Privacy</a>
    <a href="${repoUrl}" class="nav-link hide-sm">Source</a>
    <a class="btn primary" href="#download">Download</a>
  </div>
</header>

<main>

<div class="hero">
  <div class="wrap">
    <div class="hero-copy">
      <span class="pill"><i></i>Version ${version} · free and <a href="${repoUrl}">open source</a></span>
      <h1>Every AI quota on one screen</h1>
      <p class="sub">
        Run several Claude and Codex accounts and you lose track of which one is about to stop working.
        aidash shows all of them at once — how much of each limit is gone, and when it resets.
      </p>
      <div id="download">${downloadRow(downloads)}</div>
      <p class="meta">
        macOS 12 and later · Windows 10 and later · no account, no telemetry
        ${anyDownload ? '' : ' · builds are published on the releases page'}
      </p>
    </div>
    <div class="hero-shot">
      <div class="m-full">${usageMockup()}</div>
      <div class="m-compact">${usageMockupCompact()}</div>
    </div>
  </div>
</div>

<section class="steps light">
  <div class="wrap">
    <div class="steps-grid">
      <div class="step" data-reveal>
        <span class="num">${icon('download')}STEP 01</span>
        <h3>Install and open</h3>
        <p>One download, no account to create. The window opens on whatever is already signed in.</p>
      </div>
      <div class="step" data-reveal>
        <span class="num">${icon('accounts')}STEP 02</span>
        <h3>Point it at your accounts</h3>
        <p>Add each directory you work from. Signing in happens in the vendor's own client, never here.</p>
      </div>
      <div class="step" data-reveal>
        <span class="num">${icon('transfer')}STEP 03</span>
        <h3>Work from the one with room</h3>
        <p>Read every limit at a glance, and drag a session over to the account that can still finish it.</p>
      </div>
    </div>
  </div>
</section>

<section id="usage">
  <div class="wrap">
    <span class="kicker">Usage</span>
    <h2>A quota is not one number</h2>
    <p class="lede">
      Each provider measures usage its own way, and any single limit can stop you. aidash shows them as
      the provider reports them rather than flattening everything into one misleading percentage.
    </p>
    <div class="cards">
      ${card('layers', 'Claude', 'Session, weekly and per-model windows, each with its own reset time and its own bar.')}
      ${card('gauge', 'Codex', 'The shared weekly window <em>and</em> your personal spend control, which run out independently.')}
      ${card('sort', 'Sorted by urgency', 'Whatever is closest to running out sits at the top, in the colour that says how close.')}
    </div>
    <p class="note">
      Shape matters more than the number: a third of a shared quota spent is no comfort when the personal
      spend control beside it is already full.
    </p>
  </div>
</section>

<section class="dark" id="sessions">
  <div class="wrap">
    <div class="split">
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
      <div class="shot">
        <div class="m-full">${sessionsMockup()}</div>
        <div class="m-compact">${sessionsMockupCompact()}</div>
      </div>
    </div>
  </div>
</section>

<section id="privacy" class="light">
  <div class="wrap">
    <span class="kicker">Privacy</span>
    <h2>Your credentials never leave the machine</h2>
    <p class="lede">
      aidash stores no secrets of its own. Signing in hands you to the vendor's own client, which keeps
      its credentials where it always has. The app only remembers which directory belongs to which account.
    </p>
    <div class="cards">
      ${card('lock', 'Nothing to sign up for', 'No server, no login, no password. The app talks to Anthropic and OpenAI directly, on your behalf, from your machine.')}
      ${card('eye', 'Only while you look', 'It refreshes when you open the window and when you ask. Nothing runs in the background, and nothing is collected.')}
      ${card('code', 'Read the code', 'Every request it makes is in the repository. There is no telemetry and nowhere for your data to go.')}
    </div>
    <p class="note">
      Session handling is unofficial: neither tool documents how conversations are stored on disk, so it
      was worked out by reading the files. The app says as much before it touches anything.
    </p>
  </div>
</section>

<section class="dark cta">
  <div class="wrap">
    <h2>Stop guessing which account still has room</h2>
    <p>Add your accounts once. See all of them every time you open the window.</p>
    ${downloadRow(downloads)}
    <p class="meta">Version ${version} · free and open source · no account required</p>
  </div>
</section>

</main>

<footer>
  <div class="wrap">
    <div class="foot">
      <div>
        ${logoLockup()}
        <p>One screen for every Claude and Codex quota, and a way to move sessions between the accounts you already have.</p>
      </div>
      <div>
        <h4>Product</h4>
        <a href="#download">Download</a>
        <a href="#usage">Usage</a>
        <a href="#sessions">Local Sessions</a>
        <a href="#privacy">Privacy</a>
      </div>
      <div>
        <h4>Source</h4>
        <a href="${repoUrl}">Repository</a>
        <a href="${repoUrl}/releases">Releases</a>
        <a href="/version.json">Version manifest</a>
      </div>
    </div>
    <div class="foot-base">
      <span>aidash ${version} — an <a href="https://itexus.com">Itexus</a> tool</span>
      <span class="nav-spacer"></span>
      <span>Claude and Codex are trademarks of their respective owners.</span>
    </div>
  </div>
</footer>

<script>
(function(){
  var nav = document.querySelector('.nav'), hero = document.querySelector('.hero');

  // The header only turns to glass once the dark hero has passed under it;
  // switching at the first pixel of scroll reads as a flicker.
  function sync(){ nav.classList.toggle('solid', window.scrollY > hero.offsetHeight - 80); }
  addEventListener('scroll', sync, {passive:true});
  addEventListener('resize', sync);
  sync();

  // Lead with the build the visitor can actually run. The two Mac builds are
  // indistinguishable from the browser, so a Mac gets Apple Silicon, which is
  // what a Mac bought in the last five years is.
  var ua = navigator.userAgent || '';
  var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  var want = /win/i.test(plat) || /Windows/.test(ua) ? 'win32-x64'
           : /mac/i.test(plat) || /Mac OS X/.test(ua) ? 'darwin-arm64'
           : null;
  if (want) {
    Array.prototype.forEach.call(document.querySelectorAll('.downloads'), function(row){
      var match = row.querySelector('a.btn[data-os="' + want + '"]');
      if (!match) return;  // no build for this platform; leave the default lead alone
      Array.prototype.forEach.call(row.querySelectorAll('.btn'), function(b){ b.classList.remove('primary'); });
      match.classList.add('primary');
    });
  }

  var targets = document.querySelectorAll('[data-reveal]');
  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(targets, function(el){ el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, {rootMargin:'0px 0px -12% 0px'});
  Array.prototype.forEach.call(targets, function(el){ io.observe(el); });
})();
</script>

</body>
</html>`;
}

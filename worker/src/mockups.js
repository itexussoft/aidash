/**
 * Schematic drawings of the app for the landing page.
 *
 * Deliberately not screenshots. A real capture of a dense interface reads as
 * noise at page width, and it would put someone's actual accounts and quotas on
 * a public site. These keep the shapes, proportions and colour meanings, use
 * placeholder names, and reduce text that carries no explanation to plain grey
 * bars — so the eye reads structure rather than trying to read words.
 *
 * They are drawn light on purpose: the hero behind them is near-black, and an
 * equally dark panel disappeared into it.
 *
 * Inline SVG, so the page still makes no external requests.
 */

const INK = '#051320';
const SURFACE = '#ffffff';
const SUBTLE = '#f4f6f7';
const LINE = '#e2e6e8';
const TEXT = '#0d1b28';
const MUTED = '#6e717a';
const GHOST = '#dfe4e7';
const ACCENT = '#25bb4d';
const WARN = '#d9a441';
const CRIT = '#d94a35';

/** Text that exists only to fill a line becomes a bar. */
const ghost = (x, y, w, h = 5, fill = GHOST) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;

const label = (x, y, text, { size = 9.5, fill = TEXT, weight = 400, anchor = 'start' } = {}) =>
	`<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="system-ui, sans-serif">${text}</text>`;

/** Window chrome and tab strip, shared by both drawings. */
const frame = (w, active) => `
  <rect x="0.5" y="0.5" width="${w - 1}" height="34" fill="${SUBTLE}"/>
  <circle cx="18" cy="17" r="4.5" fill="#e8695a"/>
  <circle cx="33" cy="17" r="4.5" fill="#e0b04a"/>
  <circle cx="48" cy="17" r="4.5" fill="#5cc46f"/>
  <line x1="0" y1="34" x2="${w}" y2="34" stroke="${LINE}"/>
  ${label(24, 55, 'Usage', { size: 10.5, weight: active === 'usage' ? 600 : 400, fill: active === 'usage' ? TEXT : MUTED })}
  ${label(72, 55, 'Local Sessions', { size: 10.5, weight: active === 'sessions' ? 600 : 400, fill: active === 'sessions' ? TEXT : MUTED })}
  <line x1="0" y1="66" x2="${w}" y2="66" stroke="${LINE}"/>
  <rect x="${active === 'usage' ? 22 : 70}" y="64" width="${active === 'usage' ? 38 : 76}" height="2.5" rx="1" fill="${ACCENT}"/>`;

/** One limit: its name, its figure, and a bar filled to match. */
function meter(x, y, w, name, pct, colour) {
	const fill = Math.max(3, Math.round((w * Math.min(pct, 100)) / 100));
	return `
    ${label(x, y, name, { size: 8.5, fill: MUTED })}
    ${label(x + w, y, `${pct}%`, { size: 9, weight: 600, fill: colour, anchor: 'end' })}
    <rect x="${x}" y="${y + 5}" width="${w}" height="4.5" rx="2.25" fill="${GHOST}"/>
    <rect x="${x}" y="${y + 5}" width="${fill}" height="4.5" rx="2.25" fill="${colour}"/>`;
}

/** An account card. The name is a placeholder; the address below it is a bar. */
function card(x, y, w, h, name, meters) {
	return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${SURFACE}" stroke="${LINE}"/>
    ${label(x + 14, y + 22, name, { size: 11, weight: 600 })}
    ${ghost(x + 14, y + 29, 96)}
    ${meters.map((m, i) => meter(x + 14, y + 54 + i * 25, w - 28, m.name, m.pct, m.colour)).join('')}`;
}

const groupLabel = (x, y, w, text) => `
  ${label(x, y, text, { size: 8, weight: 700, fill: '#9aa0a6' })}
  <line x1="${x + text.length * 5.6}" y1="${y - 3}" x2="${w}" y2="${y - 3}" stroke="${LINE}"/>`;

/**
 * Usage: accounts grouped by provider, every limit drawn on its own.
 *
 * The picture has one job — show that an account can be comfortable on one
 * limit and finished on another. Hence the red bar sitting beside a green one.
 */
export function usageMockup() {
	const W = 720;
	const H = 386;
	return `
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="The Usage tab: one card per account, with a separate bar for every limit">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${SURFACE}" stroke="${LINE}"/>
  ${frame(W, 'usage')}

  ${label(24, 94, 'Usage', { size: 15, weight: 650 })}
  <rect x="72" y="83" width="60" height="15" rx="7.5" fill="${SUBTLE}"/>
  ${label(102, 94, '4 ACCOUNTS', { size: 7.5, weight: 600, fill: MUTED, anchor: 'middle' })}
  <rect x="${W - 128}" y="82" width="52" height="18" rx="5" fill="${SURFACE}" stroke="${LINE}"/>
  ${label(W - 102, 94, 'Refresh', { size: 9, fill: MUTED, anchor: 'middle' })}
  <rect x="${W - 68}" y="82" width="44" height="18" rx="5" fill="${ACCENT}"/>
  ${label(W - 46, 94, 'Add', { size: 9, weight: 600, fill: '#fff', anchor: 'middle' })}
  ${ghost(24, 108, 118, 5)}

  ${groupLabel(24, 138, W - 24, '▾ CODEX')}
  ${card(24, 148, 330, 104, 'Work', [
		{ name: 'Weekly window', pct: 34, colour: ACCENT },
		{ name: 'Spend control', pct: 100, colour: CRIT },
	])}
  ${card(366, 148, 330, 104, 'Personal', [
		{ name: 'Weekly window', pct: 61, colour: ACCENT },
		{ name: 'Credits', pct: 12, colour: ACCENT },
	])}

  ${groupLabel(24, 282, W - 24, '▾ CLAUDE')}
  ${card(24, 292, 330, 78, 'Team', [
		{ name: 'Weekly, all models', pct: 82, colour: WARN },
		{ name: 'Weekly, one model', pct: 46, colour: ACCENT },
	])}
  ${card(366, 292, 330, 78, 'Personal', [
		{ name: 'Weekly, all models', pct: 24, colour: ACCENT },
		{ name: 'Session', pct: 8, colour: ACCENT },
	])}
</svg>`;
}

/** A session tile: one readable line, the rest as bars. */
const tile = (x, y, w, title) => `
  <rect x="${x}" y="${y}" width="${w}" height="32" rx="5" fill="${SUBTLE}" stroke="${LINE}"/>
  ${label(x + 9, y + 14, title, { size: 9 })}
  ${ghost(x + 9, y + 21, w * 0.52, 4)}`;

/** A column of sessions belonging to one account. */
const column = (x, y, w, h, name, body, { accent = LINE, dashed = false } = {}) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${dashed ? 'none' : SURFACE}"
        stroke="${accent}" ${dashed ? 'stroke-dasharray="4 3"' : ''}/>
  ${label(x + 12, y + 20, name, { size: 9.5, weight: 600 })}
  ${ghost(x + 12, y + 27, w * 0.46, 4)}
  <line x1="${x + 12}" y1="${y + 38}" x2="${x + w - 12}" y2="${y + 38}" stroke="${LINE}"/>
  ${body}`;

/**
 * Local Sessions: one row per project, one column per account, and a session
 * caught mid-drag between two of them.
 */
export function sessionsMockup() {
	const W = 720;
	const H = 386;
	const cw = 214;
	return `
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="The Local Sessions tab: sessions grouped by project, one column per account, dragged between them">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${SURFACE}" stroke="${LINE}"/>
  ${frame(W, 'sessions')}

  ${label(24, 94, 'Local Sessions', { size: 15, weight: 650 })}
  <rect x="${W - 84}" y="82" width="60" height="18" rx="5" fill="${SURFACE}" stroke="${LINE}"/>
  ${label(W - 54, 94, 'Rescan', { size: 9, fill: MUTED, anchor: 'middle' })}
  ${ghost(24, 108, 210, 5)}

  <rect x="24" y="126" width="${W - 48}" height="26" rx="6" fill="#fdf6e8" stroke="#eddcb4"/>
  ${label(38, 143, 'Unofficial, and at your own risk.', { size: 8.5, weight: 600, fill: '#8a6a1f' })}
  ${ghost(196, 137, 300, 5, '#e8dcc0')}

  ${ghost(24, 172, 168, 6, '#d5dade')}

  ${column(24, 190, cw, 158, 'Only in the CLI', tile(36, 238, cw - 24, 'Clone repository') + tile(36, 278, cw - 24, 'Review the schema'), {
		dashed: true,
	})}

  ${column(
		250,
		190,
		cw,
		158,
		'Account A',
		`<rect x="262" y="238" width="${cw - 24}" height="72" rx="5" fill="#f0fbf3" stroke="${ACCENT}" stroke-dasharray="5 4"/>
     ${label(250 + cw / 2, 278, 'drop here', { size: 9, fill: ACCENT, anchor: 'middle' })}`,
		{ accent: ACCENT },
	)}

  ${column(476, 190, cw, 158, 'Codex', tile(488, 238, cw - 24, 'Rewrite the importer'))}

  <!-- The session being dragged, lifted clear of its column -->
  <g transform="translate(148 252) rotate(-4)">
    <rect x="0" y="0" width="188" height="34" rx="5" fill="${SURFACE}" stroke="${ACCENT}" stroke-width="1.5"/>
    ${label(10, 15, 'Integrate the new module', { size: 9, weight: 500 })}
    ${ghost(10, 22, 96, 4)}
  </g>
  <path d="M330 270 L 368 270" stroke="${ACCENT}" stroke-width="1.5" stroke-dasharray="4 3" fill="none"/>
  <path d="M364 265 L 372 270 L 364 275 Z" fill="${ACCENT}"/>
</svg>`;
}

/** The gauge mark, matching the application icon. */
export function logoMark(size = 30) {
	return `
<svg class="mark" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" rx="24" fill="${INK}"/>
  <circle cx="50" cy="50" r="24" fill="none" stroke="#26333f" stroke-width="11.5"/>
  <path d="M 50 26 A 24 24 0 1 1 26.5 55.5" fill="none" stroke="${ACCENT}" stroke-width="11.5" stroke-linecap="butt"/>
</svg>`;
}

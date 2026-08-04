/**
 * The answer the cards cannot give: where to work now, and when anything frees
 * up.
 *
 * A card describes one account. The question you actually have before starting
 * is about all of them at once, and reading it off five cards means comparing
 * five sets of windows by eye — which is exactly the arithmetic a person is
 * worst at and gets wrong in the direction that costs them an evening.
 *
 * Two claims are made here and no more:
 *
 *   - which account is furthest from stopping you, by its fullest window;
 *   - when each window that is still open comes back.
 *
 * Neither is a claim about *capacity*. A Codex weekly window at 15% and a
 * Claude session window at 15% are not the same amount of work, and no arrow
 * here points from one to the other. Headroom is comparable; quota is not.
 */

import { escapeHtml, relativeTime, barColour } from './render.js';
import { rankByHeadroom, upcomingResets } from '../src/windows.js';

/**
 * Where "nearly out" starts, matching the amber the meters already use. The
 * relief line only speaks when something has crossed it — below that, nothing
 * is about to stop you, and that is itself the answer.
 */
const TIGHT_PERCENT = 80;

const HOUR = 3600000;

const TICKS = [
	{ ms: HOUR, label: '1h' },
	{ ms: 6 * HOUR, label: '6h' },
	{ ms: 24 * HOUR, label: '1d' },
	{ ms: 72 * HOUR, label: '3d' },
	{ ms: 168 * HOUR, label: '7d' },
	{ ms: 336 * HOUR, label: '14d' },
	{ ms: 720 * HOUR, label: '30d' },
];

/**
 * Where a reset sits on the track, as a fraction of its width.
 *
 * Logarithmic, and for the same reason the meter's hue stops are uneven: the
 * interesting part of the range is one end of it. Resets land anywhere from
 * minutes to a month out — a five-hour window and a monthly spend control share
 * this axis — and spread linearly the whole of tomorrow would collapse into the
 * first few pixels while three empty weeks took the rest. The ticks are labelled
 * so the compression is visible rather than quietly misleading.
 */
export const position = (deltaMs, horizonMs) => {
	const span = Math.log1p(Math.max(horizonMs, HOUR) / HOUR);
	return span <= 0 ? 0 : Math.min(1, Math.max(0, Math.log1p(Math.max(0, deltaMs) / HOUR) / span));
};

/** The meter's convention: cap the bar, but never hide a reading above 100. */
const showPercent = (raw) => (raw > 100 ? `${Math.round(raw)}%` : `${Math.max(0, raw).toFixed(0)}%`);

const clock = (epochMs) => new Date(epochMs).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function lead(best) {
	const { account, tightest: worst } = best;
	const room = worst.percent >= 100 ? 'nothing left in' : `${showPercent(worst.percent)} used in`;

	return `
    <p class="outlook-lead">
      <span class="lead-label">Most room now</span>
      <b class="lead-name">${escapeHtml(account.label)}</b>
      <span class="lead-why">— ${escapeHtml(room)} its fullest window
        (${escapeHtml(worst.label)}${worst.resetAt ? `, resets ${escapeHtml(relativeTime(worst.resetAt))}` : ''})</span>
    </p>`;
}

/**
 * The next window to come back among those close to stopping someone.
 *
 * Deliberately not "the next reset of any window": the soonest reset is almost
 * always a session window sitting at 4%, which is true and useless.
 */
function relief(accounts, now) {
	const next = upcomingResets(accounts, now).find((r) => (r.window.percent ?? 0) >= TIGHT_PERCENT);
	if (!next) return '';

	return `
    <p class="outlook-relief">
      <span class="lead-label">Nearest relief</span>
      <b>${escapeHtml(next.account.label)}</b>
      <span class="lead-why">— ${escapeHtml(next.window.label)} at ${escapeHtml(showPercent(next.window.percent))},
        frees ${escapeHtml(relativeTime(next.window.resetAt))} · ${escapeHtml(clock(next.window.resetAt))}</span>
    </p>`;
}

function lane(entry, resets, horizon, now) {
	const { account, tightest: worst } = entry;
	const mine = resets.filter((r) => r.account.id === account.id);

	const dots = mine
		.map((r) => {
			const at = position(r.window.resetAt - now, horizon);
			const detail = `${r.window.label} · ${showPercent(r.window.percent ?? 0)} · resets ${relativeTime(r.window.resetAt)} (${clock(r.window.resetAt)})`;
			return `<i class="tl-dot" data-at="${(at * 100).toFixed(2)}" data-colour="${barColour(r.window.percent ?? 0)}" title="${escapeHtml(detail)}"></i>`;
		})
		.join('');

	return `
    <li class="tl-lane">
      <span class="tl-who">
        <b>${escapeHtml(account.label)}</b>
        <span class="tl-tag ${escapeHtml(account.provider)}">${escapeHtml(account.provider)}</span>
        <span class="tl-pct" data-colour="${barColour(worst.percent)}">${escapeHtml(showPercent(worst.percent))}</span>
      </span>
      <span class="tl-track">${dots || '<span class="tl-none">no reset reported</span>'}</span>
    </li>`;
}

/**
 * The whole section, or an empty string when there is nothing to say.
 *
 * Accounts that reported nothing readable are named rather than dropped: a
 * ranking that quietly left one out would be answering a different question
 * from the one it appears to answer.
 */
export function outlookHtml(accounts, now = Date.now()) {
	const { ranked, unreadable } = rankByHeadroom(accounts);
	if (!ranked.length) return '';

	const resets = upcomingResets(accounts, now);
	const horizon = resets.length ? resets[resets.length - 1].window.resetAt - now : HOUR;

	const ticks = TICKS.filter((t) => t.ms < horizon)
		.map((t) => `<span class="tl-tick" data-at="${(position(t.ms, horizon) * 100).toFixed(2)}">${t.label}</span>`)
		.join('');

	const note = unreadable.length
		? `<p class="outlook-note">Not ranked: ${escapeHtml(unreadable.map((a) => a.label).join(', '))} — no usage window could be read.</p>`
		: '';

	return `
    ${lead(ranked[0])}
    ${relief(accounts, now)}
    <ul class="timeline">
      <li class="tl-lane tl-head">
        <span class="tl-who">resets</span>
        <span class="tl-track"><span class="tl-tick tl-now" data-at="0">now</span>${ticks}</span>
      </li>
      ${ranked.map((entry) => lane(entry, resets, horizon, now)).join('')}
    </ul>
    ${note}`;
}

/**
 * Applies the positions and colours the markup carries as data.
 *
 * Same reason as applyBarWidths(): the page's `style-src 'self'` drops inline
 * style attributes, so anything positional has to be set from script after the
 * markup lands. Call after inserting.
 */
export function applyOutlook(root) {
	for (const el of root.querySelectorAll('[data-at]')) el.style.left = `${el.dataset.at}%`;
	for (const el of root.querySelectorAll('.tl-dot[data-colour]')) el.style.background = el.dataset.colour;
	for (const el of root.querySelectorAll('.tl-pct[data-colour]')) el.style.color = el.dataset.colour;
}

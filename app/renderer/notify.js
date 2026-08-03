/**
 * Transient notifications, shown on the pinned tab bar.
 *
 * Two kinds of message were previously mixed in the page headings: standing
 * facts ("updated 3 min ago", "122 sessions across 24 projects") and things
 * that had just happened ("moved", "exported", an error). The second kind does
 * not belong in a heading — it accumulates there and stops being read.
 *
 * These fade out on their own. Failures linger noticeably longer, because a
 * message you missed is the one you most needed.
 */

const HOLD_MS = { info: 2600, ok: 3600, error: 9000 };
const FADE_MS = 900;

const el = () => document.getElementById('toast');

let hideTimer = null;
let clearTimer = null;

/**
 * Shows a message and schedules its disappearance.
 *
 * `busy` messages ("scanning…") stay until something replaces them: they mark
 * work in progress, and a progress note that vanished mid-work would read as
 * the work having stopped.
 */
export function notify(message, tone = 'info') {
	const node = el();
	if (!node) return;

	clearTimeout(hideTimer);
	clearTimeout(clearTimer);

	node.textContent = message ?? '';
	node.className = `toast ${tone}`;
	// Re-trigger the fade-in even when one message replaces another.
	node.classList.remove('leaving');
	void node.offsetWidth;
	node.classList.add('showing');

	if (!message || tone === 'busy') return;

	hideTimer = setTimeout(() => {
		node.classList.add('leaving');
		clearTimer = setTimeout(() => {
			node.classList.remove('showing', 'leaving');
			node.textContent = '';
		}, FADE_MS);
	}, HOLD_MS[tone] ?? HOLD_MS.info);
}

/** Convenience for the common shapes. */
export const busy = (message) => notify(message, 'busy');
export const done = (message) => notify(message, 'ok');
export const failed = (message) => notify(message, 'error');

/** Strips Electron's IPC wrapper from an error before showing it. */
export const reason = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*/, '');

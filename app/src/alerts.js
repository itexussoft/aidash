/**
 * When there is something worth saying, worked out from data already on disk.
 *
 * A reset time is an absolute stamp the provider has already handed over, so
 * counting down to it needs no network at all: the schedule is rebuilt from the
 * last snapshot whenever a new one arrives, and the waiting in between costs
 * nothing. That is what lets a menu bar item and reset notifications exist
 * without reintroducing polling — the app still only reaches out when a refresh
 * is asked for, or at the one moment the numbers are known to have changed.
 *
 * Two kinds of moment, and only one of them can be known in advance:
 *
 *   reset      the stamp is in hand, so it fires on a local timer, offline.
 *   threshold  crossing 80% is only visible in fresh numbers, so it is noticed
 *              when a refresh brings them and never guessed at in between.
 *
 * Nothing here imports Electron. What to do when a moment arrives is passed in,
 * so the deciding can be tested without a window.
 */

import { tightest, upcomingResets } from './windows.js';

/** Where "nearly out" starts, matching the amber the meters already use. */
export const NOTIFY_ABOVE = 80;

/**
 * setTimeout stores its delay in a signed 32-bit int: anything longer overflows
 * and fires immediately, repeatedly. A monthly spend control is comfortably
 * past that, so long waits are served in stages.
 */
export const MAX_DELAY = 2 ** 31 - 1;

/**
 * The resets worth interrupting someone for.
 *
 * A window at 4% coming back is not news; the soonest reset almost always is
 * one. Only windows near enough to stopping you qualify.
 */
export function notableResets(accounts, now = Date.now()) {
	return upcomingResets(accounts, now).filter((r) => (r.window.percent ?? 0) >= NOTIFY_ABOVE);
}

/**
 * Which accounts crossed into trouble between two readings.
 *
 * Only upward crossings count, and only the first one: a window sitting at 92%
 * across five refreshes is one piece of news, not five. `before` is the map
 * this returns alongside, so the caller keeps no bookkeeping of its own.
 */
export function crossings(accounts, before) {
	const after = new Map();
	const crossed = [];

	for (const account of accounts ?? []) {
		const worst = tightest(account);
		if (!worst) continue;
		after.set(account.id, worst.percent);

		const was = before?.get(account.id);
		// An account seen for the first time is recorded, not announced —
		// otherwise opening the app would report everything already true.
		if (was == null) continue;

		if (was < 100 && worst.percent >= 100) crossed.push({ account, window: worst, level: 'exhausted' });
		else if (was < NOTIFY_ABOVE && worst.percent >= NOTIFY_ABOVE) crossed.push({ account, window: worst, level: 'nearly' });
	}

	return { crossed, seen: after };
}

const relative = (ms) => {
	const mins = Math.round(Math.abs(ms) / 60000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(Math.abs(ms) / 3600000);
	return hours < 48 ? `${hours}h` : `${Math.round(Math.abs(ms) / 86400000)}d`;
};

/** What a reset notification says. */
export const resetMessage = ({ account, window }) => ({
	title: `${account.label}: ${window.label} is back`,
	body: `It was at ${Math.round(window.percent)}% and has just reset.`,
});

/** What a threshold notification says. */
export const crossingMessage = ({ account, window, level }) => ({
	title: level === 'exhausted' ? `${account.label} is out` : `${account.label} is nearly out`,
	body:
		`${window.label} is at ${Math.round(window.percent)}%` +
		(window.resetAt ? `, back in ${relative(window.resetAt - Date.now())}.` : '.'),
});

/**
 * Holds the timers and the last reading.
 *
 * `update` is the only entry point: call it whenever the accounts change, and
 * whenever the machine wakes — a timer set before a laptop was closed fires
 * late, and the schedule it belonged to may have been overtaken entirely.
 */
export class Alerts {
	constructor({ notify, refresh, now = () => Date.now() }) {
		this.notify = notify;
		this.refresh = refresh;
		this.now = now;
		this.timers = [];
		this.seen = new Map();
		this.on = true;
	}

	enabled(on) {
		this.on = Boolean(on);
		if (!this.on) this.clear();
	}

	clear() {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers = [];
	}

	update(accounts) {
		const { crossed, seen } = crossings(accounts, this.seen);
		this.seen = seen;

		this.clear();
		if (!this.on) return;

		for (const crossing of crossed) this.notify(crossingMessage(crossing));

		for (const reset of notableResets(accounts, this.now())) {
			this.schedule(reset);
		}
	}

	/**
	 * Waits for one reset, in stages when it is further off than a timer can
	 * express. Each stage simply re-arms; nothing is announced until the stamp
	 * itself has passed, so a clock adjustment cannot bring the news early.
	 */
	schedule(reset) {
		const wait = () => {
			const remaining = reset.window.resetAt - this.now();
			if (remaining <= 0) {
				this.notify(resetMessage(reset));
				// The one moment the numbers are known to have changed, so this is
				// the one place worth spending a request without being asked.
				this.refresh?.();
				return;
			}
			this.timers.push(setTimeout(wait, Math.min(remaining, MAX_DELAY)));
		};
		wait();
	}
}

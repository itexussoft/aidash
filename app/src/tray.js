/**
 * The menu bar item.
 *
 * Carries a countdown to the next window worth waiting for, and lists every
 * account beneath it. All of it is read from the snapshot already on disk, so
 * opening the menu costs nothing and reaches no network — "Refresh now" is the
 * only thing here that does.
 *
 * On macOS the item is text rather than a picture: a menu bar is the one place
 * where a reading is worth more than an icon, and the app icon shrunk to 16px is
 * a coloured smudge either way. The other platforms have no text option, so
 * they get the icon.
 */

import { Tray, Menu, nativeImage, app } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankByHeadroom, upcomingResets } from './windows.js';
import { notableResets } from './alerts.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The countdowns go stale on their own, so the menu is rebuilt on the clock. */
const REBUILD_EVERY_MS = 60000;

const percent = (n) => (n > 100 ? `${Math.round(n)}%` : `${Math.max(0, n).toFixed(0)}%`);

/** Compact enough for a menu bar: 45m, 2h, 6d. */
const duration = (ms) => {
	if (ms <= 0) return 'now';
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(ms / 3600000);
	return hours < 48 ? `${hours}h` : `${Math.round(ms / 86400000)}d`;
};

/**
 * What the menu bar counts down to.
 *
 * A window near its limit coming back is the thing worth waiting for, so that
 * one wins. When nothing is close to stopping you there is no such window, and
 * the next reset of anything is shown instead — still a true countdown, just
 * not an urgent one. Either way the tooltip names which window it belongs to,
 * so the number is never left to be guessed at.
 */
const nextReset = (accounts, now) => notableResets(accounts, now)[0] ?? upcomingResets(accounts, now)[0] ?? null;

function icon() {
	// An empty image plus a title is a legitimate menu bar item on macOS, and
	// avoids shipping a second icon that only looks right in one theme.
	if (process.platform === 'darwin') return nativeImage.createEmpty();
	return nativeImage.createFromPath(join(here, '..', '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
}

export class MenuBar {
	/**
	 * `hooks` are what the menu can do: refresh, open the window, change a
	 * setting, quit. None of them are decided here.
	 */
	constructor(hooks) {
		this.hooks = hooks;
		this.tray = new Tray(icon());
		this.accounts = [];
		this.settings = {};
		this.timer = setInterval(() => this.paint(), REBUILD_EVERY_MS);
		this.paint();
	}

	update(accounts, settings) {
		this.accounts = accounts ?? [];
		this.settings = settings ?? {};
		this.paint();
	}

	paint() {
		if (!this.tray || this.tray.isDestroyed()) return;

		const { ranked, unreadable } = rankByHeadroom(this.accounts);
		const best = ranked[0];
		const now = Date.now();
		const next = nextReset(this.accounts, now);

		if (process.platform === 'darwin') {
			this.tray.setTitle(next ? duration(next.window.resetAt - now) : '—');
		}
		this.tray.setToolTip(
			next
				? `${next.account.label} — ${next.window.label} at ${percent(next.window.percent ?? 0)}, back in ${duration(next.window.resetAt - now)}`
				: 'aidash — no reset ahead',
		);

		const lines = ranked.map(({ account, tightest }) => ({
			label:
				`${account.label} · ${percent(tightest.percent)}` +
				(tightest.resetAt ? ` · ${tightest.label} back in ${duration(tightest.resetAt - now)}` : ` · ${tightest.label}`),
			click: () => this.hooks.onOpen?.(),
		}));

		for (const account of unreadable) {
			lines.push({ label: `${account.label} · not reporting`, enabled: false });
		}

		this.tray.setContextMenu(
			Menu.buildFromTemplate([
				{
					label: next ? `${next.window.label} back in ${duration(next.window.resetAt - now)} · ${next.account.label}` : 'No reset ahead',
					enabled: false,
				},
				{ label: best ? `Most room: ${best.account.label} · ${percent(best.tightest.percent)} used` : 'No usage data yet', enabled: false },
				{ type: 'separator' },
				...(lines.length ? lines : [{ label: 'No accounts added', enabled: false }]),
				{ type: 'separator' },
				{ label: 'Refresh now', click: () => this.hooks.onRefresh?.() },
				{ label: 'Open aidash', click: () => this.hooks.onOpen?.() },
				{ type: 'separator' },
				{
					label: 'Notify when a window frees up',
					type: 'checkbox',
					checked: this.settings.notifications !== false,
					click: (item) => this.hooks.onSetting?.('notifications', item.checked),
				},
				{ label: 'Hide from the menu bar', click: () => this.hooks.onSetting?.('tray', false) },
				{ type: 'separator' },
				{ label: `Quit ${app.getName()}`, click: () => this.hooks.onQuit?.() },
			]),
		);
	}

	destroy() {
		clearInterval(this.timer);
		this.tray?.destroy();
		this.tray = null;
	}
}

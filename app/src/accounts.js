/**
 * Account registry and the refresh cycle.
 *
 * The app stores no secrets. Each account owns a directory that the vendor's
 * own client writes its credentials into (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`,
 * plus the macOS keychain for Claude), and this file only remembers which
 * directory belongs to which account, along with the last snapshot.
 *
 * Snapshots are kept verbatim: the two providers describe usage in genuinely
 * different terms, and normalising on the way in would only lose detail and
 * break whenever either side changes shape.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { codex } from './providers/codex.js';
import { claude } from './providers/claude.js';
import { DEFAULT_ROOT } from './sessions.js';

export const PROVIDERS = { codex, claude };

/**
 * Both on by default.
 *
 * They cost nothing to leave running — a reset time is a stamp already in hand,
 * so the countdown behind them is local arithmetic, not a poll — and something
 * that only speaks when a window you were near comes back is worth more before
 * you notice you need it than after.
 */
export const DEFAULT_SETTINGS = { tray: true, notifications: true, refreshEveryMinutes: 60 };

export class AccountStore {
	constructor(userDataDir) {
		this.file = join(userDataDir, 'accounts.json');
		this.accountsDir = join(userDataDir, 'accounts');
		this.state = { accounts: [], lastRefreshAt: null, settings: { ...DEFAULT_SETTINGS } };
	}

	async load() {
		try {
			const raw = JSON.parse(await readFile(this.file, 'utf8'));
			this.state = {
				accounts: raw.accounts ?? [],
				lastRefreshAt: raw.lastRefreshAt ?? null,
				// Spread over the defaults rather than replacing them, so a setting
				// added in a later version arrives switched on rather than undefined.
				settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
			};
		} catch {
			this.state = { accounts: [], lastRefreshAt: null, settings: { ...DEFAULT_SETTINGS } };
		}

		await mkdir(this.accountsDir, { recursive: true });
		return this.state;
	}

	/**
	 * Changes one preference and leaves the rest alone.
	 *
	 * The default's type decides how the value is read, so a switch cannot be set
	 * to a number nor an interval to `true` by a caller that got it wrong.
	 */
	async setSetting(key, value) {
		if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting: ${key}`);

		const shape = DEFAULT_SETTINGS[key];
		const next = typeof shape === 'number' ? Math.max(0, Math.round(Number(value) || 0)) : Boolean(value);

		this.state.settings = { ...this.state.settings, [key]: next };
		await this.save();
		return this.state;
	}

	async save() {
		await mkdir(this.accountsDir, { recursive: true });
		await writeFile(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
	}

	/** Where an account's vendor client keeps its credentials. */
	dirFor(id) {
		return join(this.accountsDir, id);
	}

	/**
	 * Slug for a new account.
	 *
	 * Keeps letters from any script rather than only ASCII: stripping non-Latin
	 * text would collapse names like "Работа" and "Личный" to the same empty
	 * slug, silently pointing two accounts at one credential directory.
	 */
	makeId(provider, label) {
		const base =
			`${provider}-${label}`
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s-]/gu, '')
				.trim()
				.replace(/[\s_]+/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 40) || provider;

		if (!this.state.accounts.some((a) => a.id === base)) return base;
		for (let n = 2; ; n++) {
			const candidate = `${base}-${n}`;
			if (!this.state.accounts.some((a) => a.id === candidate)) return candidate;
		}
	}

	/**
	 * Claude Code config directories the app can read an identity from.
	 *
	 * Used only to put readable names on the account UUIDs in the desktop app's
	 * session index — the sessions themselves come from that index, not from
	 * these directories. An account signed in nowhere the app knows shows as a
	 * bare id until it is added on the Usage tab.
	 */
	claudeConfigDirs() {
		const dirs = [DEFAULT_ROOT];
		for (const account of this.state.accounts) {
			if (account.provider === 'claude') dirs.push(this.dirFor(account.id));
		}
		return [...new Set(dirs)];
	}

	/**
	 * Signs in and registers the account.
	 *
	 * Nothing is written to the registry until the sign-in succeeds, so an
	 * abandoned attempt leaves no half-configured entry behind.
	 */
	async add({ provider, label }, hooks = {}) {
		const adapter = PROVIDERS[provider];
		if (!adapter) throw new Error(`unknown provider: ${provider}`);
		if (!label?.trim()) throw new Error('a name is required');

		const id = this.makeId(provider, label.trim());
		const dir = this.dirFor(id);
		await mkdir(dir, { recursive: true });

		let identity;
		try {
			identity = await adapter.login(dir, hooks);
		} catch (err) {
			await rm(dir, { recursive: true, force: true });
			throw err;
		}

		const account = {
			id,
			provider,
			label: label.trim(),
			email: identity?.email ?? null,
			plan: identity?.plan ?? null,
			addedAt: Date.now(),
			lastOkAt: null,
			lastError: null,
			payload: null,
		};

		this.state.accounts.push(account);
		await this.save();
		return account;
	}

	/**
	 * Changes what an account is called.
	 *
	 * Only the label moves. The id is what names the directory holding the
	 * account's credentials, so renaming must not touch it — a "tidier" id would
	 * orphan the very folder the account signs in through.
	 */
	async rename(id, label) {
		const account = this.state.accounts.find((a) => a.id === id);
		if (!account) throw new Error('no such account');

		const next = String(label ?? '').trim();
		if (!next) throw new Error('a name is required');

		account.label = next;
		await this.save();
		return this.state;
	}

	async remove(id) {
		const account = this.state.accounts.find((a) => a.id === id);
		if (!account) return;

		this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
		await this.save();

		// Credentials go with the account; leaving them behind would keep a live
		// grant on the machine for something the user just deleted.
		if (account.provider === 'claude') {
			const { deleteClaudeCredentials } = await import('./keychain.js');
			await deleteClaudeCredentials(this.dirFor(id));
		}
		await rm(this.dirFor(id), { recursive: true, force: true });
	}

	/**
	 * Refreshes every account.
	 *
	 * One failure is recorded against its own card and does not stop the others:
	 * a single revoked credential should not blank the whole screen.
	 */
	async refreshAll() {
		await Promise.all(
			this.state.accounts.map(async (account) => {
				try {
					account.payload = await PROVIDERS[account.provider].fetchUsage(this.dirFor(account.id));
					account.lastOkAt = Date.now();
					account.lastError = null;
				} catch (err) {
					account.lastError = String(err?.message ?? err).slice(0, 400);
				}
			}),
		);

		// Stamped even when some accounts failed: the refresh did run, and a
		// timestamp that only moved on success would send the window into a loop.
		this.state.lastRefreshAt = Date.now();
		await this.save();
		return this.state;
	}

	/** Which vendor clients are present, for the first-run explanation. */
	availability() {
		return {
			codex: Boolean(codex.findBinary()),
			claude: Boolean(claude.findBinary()),
		};
	}
}

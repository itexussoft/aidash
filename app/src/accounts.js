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

export class AccountStore {
	constructor(userDataDir) {
		this.file = join(userDataDir, 'accounts.json');
		this.accountsDir = join(userDataDir, 'accounts');
		this.state = { accounts: [], lastRefreshAt: null };
	}

	async load() {
		try {
			const raw = JSON.parse(await readFile(this.file, 'utf8'));
			this.state = { accounts: raw.accounts ?? [], lastRefreshAt: raw.lastRefreshAt ?? null };
		} catch {
			this.state = { accounts: [], lastRefreshAt: null };
		}

		await mkdir(this.accountsDir, { recursive: true });
		return this.state;
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

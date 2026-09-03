/**
 * Account registry and the refresh cycle.
 *
 * The app stores no secrets. Each account owns a directory that the vendor's
 * own client writes its credentials into — `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
 * `GH_CONFIG_DIR` for Copilot, and for Cursor the `--user-data-dir` of its own
 * copy of the editor — plus the macOS keychain for Claude. This file only
 * remembers which directory belongs to which account, along with the last
 * snapshot.
 *
 * That one directory per account is also what makes several accounts of the
 * same provider possible at all. None of these clients holds more than one
 * sign-in; giving each its own directory is what turns a single-account client
 * into as many accounts as there are directories.
 *
 * Snapshots are kept verbatim: the two providers describe usage in genuinely
 * different terms, and normalising on the way in would only lose detail and
 * break whenever either side changes shape.
 */

import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { codex } from './providers/codex.js';
import { claude } from './providers/claude.js';
import { copilot } from './providers/copilot.js';
import { cursor } from './providers/cursor.js';
import { DEFAULT_ROOT, MAIN_ROOT } from './sessions.js';
import { findDesktop, indexIn, instanceDirIn } from './instances.js';

const exists = (p) =>
	access(p).then(
		() => true,
		() => false,
	);

export const PROVIDERS = { codex, claude, copilot, cursor };

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
		// Beside the credential directories rather than inside them: this holds a
		// whole second copy of Claude Desktop's user data, which has no business
		// sitting in a folder Claude Code treats as its own.
		this.instancesDir = join(userDataDir, 'instances');
		this.state = { accounts: [], lastRefreshAt: null, sessionRoots: [], settings: { ...DEFAULT_SETTINGS } };
	}

	async load() {
		try {
			const raw = JSON.parse(await readFile(this.file, 'utf8'));
			this.state = {
				accounts: raw.accounts ?? [],
				lastRefreshAt: raw.lastRefreshAt ?? null,
				// Only folders pointed at by hand. The ones belonging to accounts are
				// derived from the disk in indexRoots(), so there is no second record
				// of them to fall out of step.
				sessionRoots: raw.sessionRoots ?? [],
				// Spread over the defaults rather than replacing them, so a setting
				// added in a later version arrives switched on rather than undefined.
				settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
			};
		} catch {
			this.state = { accounts: [], lastRefreshAt: null, sessionRoots: [], settings: { ...DEFAULT_SETTINGS } };
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
	 * Where an account's own copy of Claude Desktop keeps its user data.
	 *
	 * Named from the account id rather than recorded anywhere, which is what
	 * limits an account to one instance: the path is a function of the account,
	 * so there is no second name to allocate and no counter to disagree with.
	 * The id survives renaming for exactly this reason.
	 */
	instanceDirFor(id) {
		return instanceDirIn(this.instancesDir, id);
	}

	/** Whether that copy has been created. The directory is the whole record. */
	hasInstance(id) {
		return exists(this.instanceDirFor(id));
	}

	/**
	 * Every session index worth reading, main profile first.
	 *
	 * Three kinds, and the distinction is not cosmetic: the main one is where
	 * things are folded back to, an instance belongs to an account and dies with
	 * it, and a folder pointed at by hand is only ever remembered — forgetting it
	 * must leave whatever it names untouched.
	 */
	async indexRoots() {
		const roots = [MAIN_ROOT];

		for (const account of this.state.accounts) {
			if (account.provider !== 'claude') continue;
			if (!(await this.hasInstance(account.id))) continue;
			roots.push({
				id: `instance:${account.id}`,
				path: indexIn(this.instanceDirFor(account.id)),
				kind: 'instance',
				label: account.label,
				accountId: account.id,
				profile: this.instanceDirFor(account.id),
			});
		}

		for (const extra of this.state.sessionRoots) {
			roots.push({ id: extra.id, path: extra.path, kind: 'manual', label: extra.label, profile: extra.profile ?? null });
		}

		// One folder reaching this list twice — most easily by being pointed at by
		// hand before the account that owns it grew an instance — would become two
		// columns over one directory, offering a move that does nothing.
		const seen = new Set();
		return roots.filter((root) => {
			if (seen.has(root.path)) return false;
			seen.add(root.path);
			return true;
		});
	}

	/**
	 * Remembers a folder the app did not create.
	 *
	 * `profile` is the directory the user actually chose and `path` the index
	 * inside it; both are kept because merging reads the index while retiring the
	 * folder means the profile, and guessing one from the other later would be
	 * guessing about a path someone typed.
	 */
	async addSessionRoot({ path, profile, label }) {
		const roots = await this.indexRoots();
		if (roots.some((r) => r.path === path)) throw new Error('that folder is already listed');

		const id = `manual-${Date.now().toString(36)}`;
		this.state.sessionRoots.push({ id, path, profile: profile ?? null, label: label || (profile ?? path).replace(homedir(), '~') });
		await this.save();
		return id;
	}

	/** Forgets a hand-picked folder. Nothing on disk is touched. */
	async removeSessionRoot(id) {
		if (!id?.startsWith('manual-')) throw new Error('this folder belongs to an account and is removed with it');
		this.state.sessionRoots = this.state.sessionRoots.filter((r) => r.id !== id);
		await this.save();
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
	 * Signs an existing account in again, in place.
	 *
	 * A grant expires or is revoked, and until now the only way back was to
	 * remove the account and add it again. Those are not the same act: the id
	 * names the credential directory and the account's separate copy of Claude
	 * Desktop, so removing takes both with it, and re-adding under the same name
	 * mints a fresh id. A signed-in second window and the sessions listed under
	 * it, thrown away to replace a dead token.
	 *
	 * Here the sign-in runs against the directory the account already owns, so
	 * everything keyed to the id survives it.
	 */
	async reauthorize(id, hooks = {}) {
		const account = this.state.accounts.find((a) => a.id === id);
		if (!account) throw new Error('no such account');

		const adapter = PROVIDERS[account.provider];
		if (!adapter) throw new Error(`unknown provider: ${account.provider}`);

		const dir = this.dirFor(id);
		await mkdir(dir, { recursive: true });

		// A directory that still holds a credential makes either client decide the
		// sign-in is already done, so it is cleared first — and put back when the
		// attempt does not land, which is what makes cancelling one free.
		const restore = await adapter.stashCredentials?.(dir);

		let identity;
		try {
			identity = await adapter.login(dir, hooks);
		} catch (err) {
			await restore?.();
			throw err;
		}

		const before = account.email;
		account.email = identity?.email ?? null;
		account.plan = identity?.plan ?? null;
		// The error goes now rather than at the next refresh, and the last reading
		// with it: those numbers describe a grant that has just been replaced, and
		// a card cannot both say it is signed in afresh and show what the old
		// login last saw.
		account.lastError = null;
		account.payload = null;
		account.lastOkAt = null;
		account.reauthorizedAt = Date.now();
		await this.save();

		// Nothing here stops someone signing in as a different person, and
		// occasionally that is the intent. Whether it was is worth saying out
		// loud, because everything keyed to the id — the folder, the instance, the
		// sessions listed under it — stayed exactly where it was.
		return { account, switched: Boolean(before && account.email && before !== account.email) };
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
		// The instance is this account's second copy of Claude Desktop; leaving it
		// would leave a signed-in window for an account the user just deleted.
		// Its sessions are not lost with it — the transcripts are shared, so they
		// reappear as unclaimed and can be adopted again.
		await rm(this.instanceDirFor(id), { recursive: true, force: true });
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
			// Copilot signs in through the GitHub CLI and Cursor through its own
			// editor, so what has to be present is that client rather than anything
			// named after the provider.
			copilot: Boolean(copilot.findBinary()),
			cursor: Boolean(cursor.findBinary()),
			// A separate instance is a second copy of the desktop app, so the button
			// offering one has to know whether there is a first.
			claudeDesktop: Boolean(findDesktop()),
		};
	}
}

/**
 * Claude Code session management.
 *
 * Two stores are involved, and confusing them is the trap:
 *
 *   - The transcript is at
 *     `~/.claude/projects/<cwd with slashes as dashes>/<cliSessionId>.jsonl`.
 *     It is shared. Nothing in it says which account recorded it.
 *
 *   - What the desktop app *lists* comes from its own index at
 *     `~/Library/Application Support/Claude/claude-code-sessions/
 *      <accountUuid>/<orgUuid>/local_<uuid>.json`,
 *     each entry naming a `cliSessionId` and carrying the title, cwd and
 *     timestamps.
 *
 * So a session belongs to an account by virtue of an index entry, not by where
 * its transcript sits. Signing in as a different account changes which index
 * directory is read, which is why the same project can look empty under one
 * account and full under another.
 *
 * Moving a session therefore means moving its index entry. Moving the
 * transcript would do nothing useful and would strand the entry that points at
 * it.
 */

import { readdir, stat, rename, access, open, readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { locate, spawnOptionsFor } from './locate.js';
import { DEFAULT_CONFIG_DIR, claudeEnv } from './claude-config.js';
import { readClaudeCredentials } from './keychain.js';

const run = promisify(execFile);

export const DEFAULT_ROOT = DEFAULT_CONFIG_DIR;

/** Where the desktop app keeps the index that decides what it shows. */
export const INDEX_ROOT = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

const TRANSCRIPTS = join(DEFAULT_CONFIG_DIR, 'projects');

// Enough for the session header; `ai-title` lands within the first few tens of
// kilobytes and transcripts reach tens of megabytes.
const HEAD_BYTES = 64 * 1024;

const exists = (p) =>
	access(p).then(
		() => true,
		() => false,
	);

/* ------------------------------------------------------------- identities */

/**
 * Which account a config directory is signed in as.
 *
 * `claude auth status` answers from stored credentials rather than the server
 * and keeps reporting loggedIn once they expire, so the expiry is read too.
 */
export async function identifyRoot(dir) {
	const credential = await readClaudeCredentials(dir).catch(() => null);
	const expiresAt = credential?.expiresAt ?? null;
	const expired = expiresAt != null && expiresAt < Date.now();

	try {
		const binary = locate('claude');
		if (!binary) return { email: null, orgId: null, loggedIn: false, expiresAt, expired };
		const { stdout } = await run(binary, ['auth', 'status'], {
			env: { ...process.env, ...claudeEnv(dir) },
			...spawnOptionsFor(binary),
		});
		const status = JSON.parse(stdout);
		return {
			email: status.email ?? null,
			orgId: status.orgId ?? null,
			orgName: status.orgName ?? null,
			loggedIn: Boolean(status.loggedIn),
			expiresAt,
			expired,
		};
	} catch {
		return { email: null, orgId: null, loggedIn: false, expiresAt, expired };
	}
}

/**
 * Names the accounts the index knows about.
 *
 * The index identifies an account by UUID only, so the readable name comes from
 * whichever config directories are signed in — matched on the organisation id,
 * which both sides report.
 */
async function nameAccounts(configDirs) {
	const byOrg = new Map();
	await Promise.all(
		configDirs.map(async (dir) => {
			const identity = await identifyRoot(dir);
			if (identity.orgId && identity.email && !byOrg.has(identity.orgId)) {
				byOrg.set(identity.orgId, { email: identity.email, orgName: identity.orgName, expired: identity.expired });
			}
		}),
	);
	return byOrg;
}

/* ----------------------------------------------------------------- index */

/** Every account/organisation pair the desktop app has recorded sessions for. */
export async function listIndexAccounts(indexRoot = INDEX_ROOT) {
	if (!(await exists(indexRoot))) return [];

	const accounts = [];
	for (const account of await readdir(indexRoot, { withFileTypes: true })) {
		if (!account.isDirectory()) continue;
		const accountDir = join(indexRoot, account.name);
		for (const org of await readdir(accountDir, { withFileTypes: true })) {
			if (!org.isDirectory()) continue;
			accounts.push({
				id: `${account.name}/${org.name}`,
				accountUuid: account.name,
				orgUuid: org.name,
				path: join(accountDir, org.name),
			});
		}
	}
	return accounts;
}

/** Reads one index entry, ignoring anything unreadable. */
async function readEntry(file) {
	try {
		const entry = JSON.parse(await readFile(file, 'utf8'));
		if (!entry?.cliSessionId) return null;
		return { file, ...entry };
	} catch {
		return null;
	}
}

/** Encoded transcript folder name for a working directory. */
const encodeCwd = (cwd) => cwd.replace(/[/\\]/g, '-');

/** Size and branch from the transcript, when it is still on disk. */
async function transcriptFacts(cliSessionId, cwd) {
	const file = join(TRANSCRIPTS, encodeCwd(cwd), `${cliSessionId}.jsonl`);
	if (!(await exists(file))) return { transcript: null, sizeBytes: null, branch: null };

	let branch = null;
	try {
		const handle = await open(file, 'r');
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
			for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line);
					if (record.gitBranch) {
						branch = record.gitBranch;
						break;
					}
				} catch {
					/* the last line of the slice is usually truncated */
				}
			}
		} finally {
			await handle.close();
		}
	} catch {
		/* unreadable transcript is not fatal — the entry still lists */
	}

	const stats = await stat(file).catch(() => null);
	return { transcript: file, sizeBytes: stats?.size ?? null, branch };
}

/**
 * The whole picture: accounts across the top, projects down the side.
 *
 * Grouped by project because that is the rule made visible — a session belongs
 * to the directory it ran in, so it only ever moves sideways within its row.
 */
export async function scanAll(configDirs = [DEFAULT_CONFIG_DIR], indexRoot = INDEX_ROOT) {
	const [indexAccounts, namesByOrg] = await Promise.all([listIndexAccounts(indexRoot), nameAccounts(configDirs)]);

	const byProject = new Map();

	const accounts = await Promise.all(
		indexAccounts.map(async (account) => {
			const files = (await readdir(account.path)).filter((f) => f.endsWith('.json'));
			const entries = (await Promise.all(files.map((f) => readEntry(join(account.path, f))))).filter(Boolean);

			for (const entry of entries) {
				if (!entry.cwd) continue;
				const facts = await transcriptFacts(entry.cliSessionId, entry.cwd);

				if (!byProject.has(entry.cwd)) byProject.set(entry.cwd, { cwd: entry.cwd, byAccount: {} });
				const project = byProject.get(entry.cwd);
				(project.byAccount[account.id] ??= []).push({
					id: entry.sessionId,
					cliSessionId: entry.cliSessionId,
					file: entry.file,
					title: entry.title ?? null,
					model: entry.model ?? null,
					archived: Boolean(entry.isArchived),
					lastAt: entry.lastActivityAt ?? entry.createdAt ?? null,
					...facts,
				});
			}

			const named = namesByOrg.get(account.orgUuid);
			return {
				...account,
				email: named?.email ?? null,
				orgName: named?.orgName ?? null,
				expired: named?.expired ?? false,
				sessions: entries.length,
			};
		}),
	);

	for (const project of byProject.values()) {
		for (const list of Object.values(project.byAccount)) list.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
	}

	const projects = [...byProject.values()].sort((a, b) => a.cwd.localeCompare(b.cwd));

	return { accounts, projects, indexRoot };
}

/**
 * Moves a session to another account by moving its index entry.
 *
 * The transcript is shared and stays exactly where it is; only the record of
 * which account may see it changes.
 */
export async function moveSession({ fromFile, toAccountPath, cliSessionId }) {
	if (!(await exists(fromFile))) throw new Error('this session is no longer where it was — rescan and try again');
	if (!(await exists(toAccountPath))) throw new Error('the destination account has no session store yet');

	const target = join(toAccountPath, basename(fromFile));
	if (await exists(target)) throw new Error('the destination account already lists this session');

	// The same transcript listed twice under one account would show as two
	// sessions that are really one.
	for (const file of (await readdir(toAccountPath)).filter((f) => f.endsWith('.json'))) {
		const entry = await readEntry(join(toAccountPath, file));
		if (entry?.cliSessionId === cliSessionId) throw new Error('the destination account already lists this session');
	}

	await mkdir(toAccountPath, { recursive: true });
	try {
		await rename(fromFile, target);
	} catch (err) {
		// rename() cannot cross filesystems.
		if (err.code !== 'EXDEV') throw err;
		await copyFile(fromFile, target);
		await rm(fromFile, { force: true });
	}

	return { moved: cliSessionId, to: toAccountPath };
}

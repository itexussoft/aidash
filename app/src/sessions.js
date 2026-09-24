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
 *
 * This is the desktop app's mechanism specifically. The terminal CLI carries no
 * reference to this index — it lists whatever is in its own
 * `<config dir>/projects/`, for whoever happens to be signed in — so its
 * sessions are scoped by directory rather than by account, and are never hidden
 * from it. Eight transcripts on the machine this was built against have no
 * index entry at all: visible to the CLI, invisible to the desktop.
 */

import { readdir, stat, rename, access, open, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { locate, spawnable } from './locate.js';
import { DEFAULT_CONFIG_DIR, claudeEnv } from './claude-config.js';
import { readClaudeCredentials } from './keychain.js';
import { listSessions as listCodexSessions, DEFAULT_CODEX_HOME } from './codex-sessions.js';

const run = promisify(execFile);

export const DEFAULT_ROOT = DEFAULT_CONFIG_DIR;

/** Where the desktop app keeps the index that decides what it shows. */
export const INDEX_ROOT = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

/**
 * The index belonging to the copy of Claude Desktop everyone already has.
 *
 * There can now be more than one — a second copy pointed at its own user data
 * directory keeps its own index, and each of those is another place a session
 * can be listed. They are described as roots rather than paths because a column
 * has to say which one it came from; see `listIndexAccounts`.
 */
export const MAIN_ROOT = { id: 'main', path: INDEX_ROOT, kind: 'main', label: 'Claude Desktop' };

/**
 * The index Claude Desktop keeps while in developer mode with third-party
 * inference.
 *
 * That mode runs the same app over a user data folder of its own, `Claude-3p`,
 * so its sessions are listed by an index nothing else reads — while their
 * transcripts land in the same `~/.claude/projects` as everyone's. Unread, its
 * sessions showed here as belonging to nobody. Found by name rather than added
 * by hand, because the app chooses the folder and nobody picks it.
 *
 * Its account folder sits under a placeholder organisation, not a real one, so
 * no signed-in config directory will ever name it; the column is named for the
 * mode instead.
 */
export const THIRD_PARTY_ROOT = {
	id: 'third-party',
	path: join(homedir(), 'Library', 'Application Support', 'Claude-3p', 'claude-code-sessions'),
	kind: 'third-party',
	label: 'Claude-3p',
};

/** Accepts a bare path, one root, or several, and always yields several. */
const asRoots = (roots) =>
	(Array.isArray(roots) ? roots : [roots]).map((root) => (typeof root === 'string' ? { ...MAIN_ROOT, path: root } : root));

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
		const { command, options } = spawnable(binary);
		const { stdout } = await run(command, ['auth', 'status'], {
			env: { ...process.env, ...claudeEnv(dir) },
			...options,
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

/**
 * Every account/organisation pair any known index has recorded sessions for.
 *
 * One index means one column per account. Several mean the same account can
 * appear more than once — once per copy of Claude Desktop that has listed it —
 * which is the point: those are genuinely separate listings of a shared pile of
 * transcripts, and a session moves between them exactly as it moves between
 * accounts.
 *
 * The main profile's column ids are left byte-for-byte as they were. They are
 * what the bridge journal recorded its attributions against, and prefixing them
 * "for consistency" would orphan every attribution ever made.
 */
export async function listIndexAccounts(roots = [MAIN_ROOT]) {
	const accounts = [];

	for (const root of asRoots(roots)) {
		if (!(await exists(root.path))) continue;

		for (const account of await readdir(root.path, { withFileTypes: true })) {
			if (!account.isDirectory()) continue;
			const accountDir = join(root.path, account.name);
			for (const org of await readdir(accountDir, { withFileTypes: true })) {
				if (!org.isDirectory()) continue;
				const secondary = root.kind !== 'main';
				accounts.push({
					id: secondary ? `${root.id}:${account.name}/${org.name}` : `${account.name}/${org.name}`,
					accountUuid: account.name,
					orgUuid: org.name,
					path: join(accountDir, org.name),
					root: root.id,
					rootPath: root.path,
					rootKind: root.kind ?? 'main',
					rootLabel: root.label ?? null,
					secondary,
				});
			}
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

/**
 * Encoded transcript folder name for a working directory.
 *
 * Claude Code replaces every character that is not an ASCII letter or digit,
 * not just the path separators. Confirmed by running it in directories built to
 * tell the candidate rules apart: `a_b c.d-e` became `a-b-c-d-e`, and a Cyrillic
 * name became one dash per letter.
 *
 * Matching it exactly matters more than it looks. Replacing only separators
 * missed three of seventeen projects on the machine this was written on —
 * anything with a dot in the path, such as a domain-named folder or a
 * `.claude/worktrees` checkout. On Windows it would have been worse than a miss:
 * `C:\...` would have produced `C:-...`, and a colon cannot exist in an NTFS
 * name, so creating the folder would have thrown rather than come up empty.
 *
 * The collapse is lossy — two paths differing only in punctuation encode alike —
 * but that is Claude Code's behaviour, and this has to find its folders, not
 * design better ones.
 */
export const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** Size and branch from the transcript, when it is still on disk. */
async function transcriptFacts(cliSessionId, cwd, transcriptsRoot = TRANSCRIPTS) {
	const file = join(transcriptsRoot, encodeCwd(cwd), `${cliSessionId}.jsonl`);
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

/** The column standing for transcripts no account has claimed. */
export const UNINDEXED = 'unindexed';

/**
 * The Codex column.
 *
 * One column, not one per account: nothing in Codex's storage records an
 * account, so every session in a CODEX_HOME is visible to whichever account is
 * signed in.
 */
export const CODEX = 'codex';

/**
 * Reads what an index entry needs from a transcript.
 *
 * Only the head is parsed — transcripts reach tens of megabytes, and the title,
 * cwd, branch and model all appear near the top.
 */
async function describeTranscript(file) {
	const stats = await stat(file).catch(() => null);
	if (!stats) return null;

	let title = null;
	let cwd = null;
	let branch = null;
	let model = null;
	let createdAt = null;

	try {
		const handle = await open(file, 'r');
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
			for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
				if (!line.trim()) continue;
				let record;
				try {
					record = JSON.parse(line);
				} catch {
					// The final line of the slice is normally cut mid-record.
					continue;
				}
				if (record.type === 'ai-title' && record.aiTitle) title = record.aiTitle;
				cwd ??= record.cwd ?? null;
				branch ??= record.gitBranch ?? null;
				model ??= record.message?.model ?? null;
				if (!createdAt && record.timestamp) createdAt = Date.parse(record.timestamp) || null;
			}
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}

	return {
		cliSessionId: basename(file, '.jsonl'),
		title,
		cwd,
		branch,
		model,
		createdAt: createdAt ?? stats.mtimeMs,
		lastAt: stats.mtimeMs,
		sizeBytes: stats.size,
		transcript: file,
	};
}

/**
 * The last resort for an entry's model: an alias the CLI resolves itself, so it
 * does not go stale the way a pinned model id would.
 */
const FALLBACK_MODEL = 'opus';

/** A model id a real turn ran on — not our own `imported`, not `<synthetic>`. */
const realModel = (model) => typeof model === 'string' && model && model !== 'imported' && !model.startsWith('<');

/**
 * The first model a transcript records, read as far into it as it takes.
 *
 * Not from the head `describeTranscript` reads: the first assistant turn lands
 * after the opening prompt and its attachments, which on the machine this was
 * found on put it 170–205 KB in — well past the 64 KB slice.
 */
async function findModel(file) {
	const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.includes('"model"')) continue;
			try {
				const model = JSON.parse(line).message?.model;
				if (realModel(model)) return model;
			} catch {
				/* a half-written last line */
			}
		}
	} finally {
		lines.close();
	}
	return null;
}

/** The model of the account's most recently active session, if any has one. */
async function recentModel(accountPath) {
	const files = (await readdir(accountPath).catch(() => [])).filter((f) => f.endsWith('.json'));
	const entries = (await Promise.all(files.map((f) => readEntry(join(accountPath, f))))).filter((e) => realModel(e?.model));
	entries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
	return entries[0]?.model ?? null;
}

/**
 * What to put in a new entry's `model`. Never null.
 *
 * The desktop app calls a string method on this field for every session it
 * lists. A null there throws, and the app drops the session from its sidebar
 * without a word — the entry is on disk, the transcript is intact, and the
 * session is simply not shown. So the transcript's own model comes first, then
 * whatever the account last used, then an alias.
 */
async function modelFor({ transcriptFile = null, toAccountPath }) {
	return (transcriptFile && (await findModel(transcriptFile))) || (await recentModel(toAccountPath)) || FALLBACK_MODEL;
}

/**
 * Transcripts with no index entry anywhere.
 *
 * These are resumable from the terminal and invisible to the desktop app,
 * which lists only what its index names.
 */
async function listUnindexed(indexedIds, transcriptsRoot = TRANSCRIPTS) {
	if (!(await exists(transcriptsRoot))) return [];

	const found = [];
	for (const dir of await readdir(transcriptsRoot, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const path = join(transcriptsRoot, dir.name);
		for (const file of await readdir(path)) {
			if (!file.endsWith('.jsonl')) continue;
			if (indexedIds.has(basename(file, '.jsonl'))) continue;
			const described = await describeTranscript(join(path, file));
			if (described?.cwd) found.push(described);
		}
	}
	return found;
}

/**
 * Gives a transcript to an account by writing the index entry it lacks.
 *
 * The transcript is untouched; this only creates the record that makes the
 * desktop app willing to list it.
 */
export async function adoptSession({ transcriptFile, toAccountPath }) {
	if (!(await exists(transcriptFile))) throw new Error('that transcript is no longer there — rescan and try again');
	if (!(await exists(toAccountPath))) throw new Error('the destination account has no session store yet');

	const described = await describeTranscript(transcriptFile);
	if (!described?.cwd) throw new Error('this transcript records no working directory, so it cannot be placed in a project');

	// Refuse rather than produce a second listing of one conversation.
	for (const file of (await readdir(toAccountPath)).filter((f) => f.endsWith('.json'))) {
		const entry = await readEntry(join(toAccountPath, file));
		if (entry?.cliSessionId === described.cliSessionId) throw new Error('the destination account already lists this session');
	}

	const sessionId = `local_${randomUUID()}`;
	// Mirrors the shape the desktop app writes itself. Fields it fills in from
	// live state are left at their neutral values rather than invented.
	const entry = {
		sessionId,
		cliSessionId: described.cliSessionId,
		cwd: described.cwd,
		originCwd: described.cwd,
		createdAt: described.createdAt,
		lastActivityAt: described.lastAt,
		lastFocusedAt: described.lastAt,
		model: realModel(described.model) ? described.model : await modelFor({ transcriptFile, toAccountPath }),
		isArchived: false,
		title: described.title ?? basename(described.cwd),
		titleSource: described.title ? 'auto' : 'derived',
		writtenBranches: described.branch ? [described.branch] : [],
		enabledMcpTools: {},
		remoteMcpServersConfig: [],
		alwaysAllowedReasons: [],
		sessionPermissionUpdates: [],
		bridgeSessionIds: [],
		spawnSeed: {},
	};

	await writeFile(join(toAccountPath, `${sessionId}.json`), JSON.stringify(entry, null, 2));
	return { adopted: described.cliSessionId, to: toAccountPath };
}

/** Changes what a session is called, in the entry that names it. */
export async function renameSession(entryFile, title) {
	const next = String(title ?? '').trim();
	if (!next) throw new Error('a name is required');

	const entry = await readEntry(entryFile);
	if (!entry) throw new Error('no such session');

	const { file, ...rest } = entry;
	await writeFile(entryFile, JSON.stringify({ ...rest, title: next, titleSource: 'user' }, null, 2));
}

/**
 * Clears every Remote Control link this account's index records.
 *
 * A local edit only, and that is the whole of what it can be: `bridgeSessionIds`
 * names a server-side session, and nothing this app holds can reach in and stop
 * one. What it can do is edit the record — the same field the desktop app
 * itself reads to know a session is remote-controlled — so both stop treating
 * these sessions as live. That is not a lesser fix when the desktop app's own
 * disconnect flow is the thing that is broken: editing the record directly is
 * then the only way left out of a stuck state, not a workaround for one.
 *
 * Whatever is genuinely still running on the server keeps running; quitting
 * Claude Code (or `claude remote-control` / `/remote-control` in the session
 * that opened it) is what actually stops that.
 */
export async function clearAccountBridges(accountPath) {
	if (!(await exists(accountPath))) throw new Error('this account has no session store');

	let cleared = 0;
	const clearedIds = [];

	for (const file of (await readdir(accountPath)).filter((f) => f.endsWith('.json'))) {
		const entry = await readEntry(join(accountPath, file));
		if (!entry?.bridgeSessionIds?.length) continue;

		clearedIds.push(...entry.bridgeSessionIds);
		const { file: entryFile, ...rest } = entry;
		await writeFile(entryFile, JSON.stringify({ ...rest, bridgeSessionIds: [] }, null, 2));
		cleared++;
	}

	return { cleared, clearedIds };
}

/**
 * Gives a model to every entry that has `model: null`, in every index.
 *
 * Earlier versions of this app wrote exactly that when adopting a CLI-only
 * transcript or copying a conversation in from Codex, and the desktop app drops
 * such an entry from its sidebar — see `modelFor`. Run on every scan rather
 * than once, because the desktop app keeps the broken entry in memory until it
 * restarts, and if it writes that copy back, the fix has to happen again.
 *
 * Only null, not a missing key: null is what was written and what was seen to
 * throw, while no entry the desktop app wrote itself has been seen without the
 * field, so rewriting that case would be guessing on its behalf.
 */
export async function repairIndex(roots = [MAIN_ROOT], transcriptsRoot = TRANSCRIPTS) {
	const repaired = [];

	for (const account of await listIndexAccounts(roots)) {
		for (const file of (await readdir(account.path)).filter((f) => f.endsWith('.json'))) {
			const entry = await readEntry(join(account.path, file));
			if (!entry || entry.model !== null) continue;

			const { transcript } = entry.cwd ? await transcriptFacts(entry.cliSessionId, entry.cwd, transcriptsRoot) : {};
			const model = await modelFor({ transcriptFile: transcript, toAccountPath: account.path });

			const { file: entryFile, ...rest } = entry;
			await writeFile(entryFile, JSON.stringify({ ...rest, model }, null, 2));
			repaired.push({ title: entry.title ?? null, cwd: entry.cwd ?? null, model, account: account.id });
		}
	}

	return repaired;
}

/**
 * Removes a session: the entry that lists it and the transcript it points at.
 *
 * Both, deliberately — deleting only the entry would leave the conversation on
 * disk, unlisted, which is a state nobody asked for and nothing would explain.
 */
export async function deleteSession(entryFile) {
	const entry = await readEntry(entryFile);
	if (!entry) throw new Error('no such session');

	const { transcript } = await transcriptFacts(entry.cliSessionId, entry.cwd);
	await rm(entryFile, { force: true });
	if (transcript) await rm(transcript, { force: true });
}

/**
 * Writes a conversation carried over from Codex as a Claude session.
 *
 * The transcript is synthesised from the dialogue alone; the index entry is
 * what makes the desktop app willing to list it.
 */
export async function importConversation(toAccountPath, { title, cwd, messages, preamble }, transcriptsRoot = TRANSCRIPTS) {
	if (!(await exists(toAccountPath))) throw new Error('the destination account has no session store yet');

	const sessionId = randomUUID();
	const workingDir = cwd ?? homedir();
	const folder = join(transcriptsRoot, encodeCwd(workingDir));
	await mkdir(folder, { recursive: true });

	const stamp = new Date().toISOString();
	const lines = [JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId })];

	let parentUuid = null;
	const record = (role, text, at) => {
		const uuid = randomUUID();
		const message =
			role === 'assistant'
				? { role, content: [{ type: 'text', text }], model: 'imported' }
				: { role, content: text };
		const line = {
			parentUuid,
			isSidechain: false,
			type: role,
			message,
			uuid,
			timestamp: at ?? stamp,
			cwd: workingDir,
			sessionId,
			userType: 'external',
			version: 'imported',
		};
		parentUuid = uuid;
		return JSON.stringify(line);
	};

	lines.push(record('user', preamble, stamp));
	for (const m of messages) lines.push(record(m.role, m.text, m.at));

	const transcript = join(folder, `${sessionId}.jsonl`);
	await writeFile(transcript, `${lines.join('\n')}\n`);

	const entryId = `local_${randomUUID()}`;
	const now = Date.now();
	// The transcript's turns say `imported`, which is no model at all.
	const model = await modelFor({ toAccountPath });
	await writeFile(
		join(toAccountPath, `${entryId}.json`),
		JSON.stringify(
			{
				sessionId: entryId,
				cliSessionId: sessionId,
				cwd: workingDir,
				originCwd: workingDir,
				createdAt: now,
				lastActivityAt: now,
				lastFocusedAt: now,
				model,
				isArchived: false,
				title,
				titleSource: 'user',
				writtenBranches: [],
				enabledMcpTools: {},
				remoteMcpServersConfig: [],
				alwaysAllowedReasons: [],
				sessionPermissionUpdates: [],
				bridgeSessionIds: [],
				spawnSeed: {},
			},
			null,
			2,
		),
	);

	return { cliSessionId: sessionId, transcript };
}

/**
 * The whole picture: accounts across the top, projects down the side.
 *
 * Grouped by project because that is the rule made visible — a session belongs
 * to the directory it ran in, so it only ever moves sideways within its row.
 */
export async function scanAll(configDirs = [DEFAULT_CONFIG_DIR], indexRoots = [MAIN_ROOT], transcriptsRoot = TRANSCRIPTS) {
	const [indexAccounts, namesByOrg] = await Promise.all([listIndexAccounts(indexRoots), nameAccounts(configDirs)]);

	const byProject = new Map();

	const accounts = await Promise.all(
		indexAccounts.map(async (account) => {
			const files = (await readdir(account.path)).filter((f) => f.endsWith('.json'));
			const entries = (await Promise.all(files.map((f) => readEntry(join(account.path, f))))).filter(Boolean);

			for (const entry of entries) {
				if (!entry.cwd) continue;
				const facts = await transcriptFacts(entry.cliSessionId, entry.cwd, transcriptsRoot);

				if (!byProject.has(entry.cwd)) byProject.set(entry.cwd, { cwd: entry.cwd, byAccount: {} });
				const project = byProject.get(entry.cwd);
				(project.byAccount[account.id] ??= []).push({
					id: entry.sessionId,
					cliSessionId: entry.cliSessionId,
					file: entry.file,
					title: entry.title ?? null,
					model: entry.model ?? null,
					archived: Boolean(entry.isArchived),
					createdAt: entry.createdAt ?? null,
					lastAt: entry.lastActivityAt ?? entry.createdAt ?? null,
					// The Remote Control links, carried through as the entry holds them.
					// An id says nothing about which account minted it — see bridges.js.
					bridges: Array.isArray(entry.bridgeSessionIds) ? entry.bridgeSessionIds : [],
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

	// Transcripts nothing has claimed get a column of their own, so the sessions
	// only the terminal can see are visible here — and can be handed to an
	// account by the same drag as everything else.
	const indexedIds = new Set();
	for (const project of byProject.values()) {
		for (const list of Object.values(project.byAccount)) {
			for (const session of list) indexedIds.add(session.cliSessionId);
		}
	}

	for (const orphan of await listUnindexed(indexedIds, transcriptsRoot)) {
		if (!byProject.has(orphan.cwd)) byProject.set(orphan.cwd, { cwd: orphan.cwd, byAccount: {} });
		(byProject.get(orphan.cwd).byAccount[UNINDEXED] ??= []).push({
			id: orphan.cliSessionId,
			cliSessionId: orphan.cliSessionId,
			file: null,
			title: orphan.title,
			model: orphan.model,
			archived: false,
			lastAt: orphan.lastAt,
			transcript: orphan.transcript,
			sizeBytes: orphan.sizeBytes,
			branch: orphan.branch,
		});
	}

	// One conversation listed by two accounts at once. It happens without this
	// app's involvement, and it is the case where nothing on disk can say which
	// account a Remote Control link belongs to.
	for (const project of byProject.values()) {
		const listedBy = new Map();
		const bridgedBy = new Map();

		for (const [columnId, list] of Object.entries(project.byAccount)) {
			if (columnId === UNINDEXED || columnId === CODEX) continue;
			for (const session of list) {
				if (!listedBy.has(session.cliSessionId)) listedBy.set(session.cliSessionId, new Set());
				listedBy.get(session.cliSessionId).add(columnId);

				// Which accounts have Remote Control set up for this conversation.
				// Local and exact: each listing carries its own link list.
				if (session.bridges.length) {
					if (!bridgedBy.has(session.cliSessionId)) bridgedBy.set(session.cliSessionId, new Set());
					bridgedBy.get(session.cliSessionId).add(columnId);
				}
			}
		}

		for (const list of Object.values(project.byAccount)) {
			for (const session of list) {
				session.duplicated = (listedBy.get(session.cliSessionId)?.size ?? 0) > 1;
				session.remoteAccounts = [...(bridgedBy.get(session.cliSessionId) ?? [])];
			}
		}
	}

	for (const project of byProject.values()) {
		for (const list of Object.values(project.byAccount)) list.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
	}

	const projects = [...byProject.values()].sort((a, b) => a.cwd.localeCompare(b.cwd));

	const unindexed = projects.reduce((n, p) => n + (p.byAccount[UNINDEXED]?.length ?? 0), 0);

	return { accounts, projects, indexRoots: asRoots(indexRoots), unindexed };
}

/** Everything, with Codex folded in as its own column. */
export async function scanEverything(configDirs = [DEFAULT_CONFIG_DIR], codexHome = DEFAULT_CODEX_HOME, indexRoots = [MAIN_ROOT]) {
	const view = await scanAll(configDirs, indexRoots);
	const byProject = new Map(view.projects.map((p) => [p.cwd, p]));

	let codexCount = 0;
	for (const session of await listCodexSessions(codexHome)) {
		if (!session.cwd) continue;
		codexCount++;
		if (!byProject.has(session.cwd)) byProject.set(session.cwd, { cwd: session.cwd, byAccount: {} });
		(byProject.get(session.cwd).byAccount[CODEX] ??= []).push({ ...session, tool: 'codex' });
	}

	for (const project of byProject.values()) {
		for (const list of Object.values(project.byAccount)) list.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
	}

	return {
		...view,
		projects: [...byProject.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)),
		codex: { home: codexHome, sessions: codexCount },
	};
}

/**
 * Moves a session to another account by moving its index entry.
 *
 * The transcript is shared and stays exactly where it is; only the record of
 * which account may see it changes.
 */
export async function moveSession({ fromFile, toAccountPath, cliSessionId, retarget = false, transcriptsRoot = TRANSCRIPTS }) {
	if (!(await exists(fromFile))) throw new Error('this session is no longer where it was — rescan and try again');
	if (!(await exists(toAccountPath))) throw new Error('the destination account has no session store yet');

	// Read before the move, and hand back: the Remote Control links are the one
	// thing whose meaning the move changes, and afterwards nothing on disk can
	// say where they came from.
	const source = await readEntry(fromFile);
	const bridges = Array.isArray(source?.bridgeSessionIds) ? source.bridgeSessionIds : [];

	const target = join(toAccountPath, basename(fromFile));
	if (await exists(target)) throw new Error('the destination account already lists this session');

	// The same transcript listed twice under one account would show as two
	// sessions that are really one.
	for (const file of (await readdir(toAccountPath)).filter((f) => f.endsWith('.json'))) {
		const entry = await readEntry(join(toAccountPath, file));
		if (entry?.cliSessionId === cliSessionId) throw new Error('the destination account already lists this session');
	}

	// Read before the move, while the destination holds only its own sessions —
	// afterwards the newest entry there would be this one, naming the old model.
	const across = retarget ? await modelAcross({ source, toAccountPath, transcriptsRoot }) : null;
	const model = across && across !== source?.model ? across : null;

	await mkdir(toAccountPath, { recursive: true });
	try {
		await rename(fromFile, target);
	} catch (err) {
		// rename() cannot cross filesystems.
		if (err.code !== 'EXDEV') throw err;
		await copyFile(fromFile, target);
		await rm(fromFile, { force: true });
	}

	if (model) {
		const { file: _, ...rest } = await readEntry(target);
		await writeFile(target, JSON.stringify({ ...rest, model }, null, 2));
	}

	return { moved: cliSessionId, to: toAccountPath, bridges, model };
}

/**
 * The model a session should name after crossing between Claude Desktop's own
 * inference and its third-party mode.
 *
 * The desktop app resumes a session with the model its entry names, and across
 * that line the provider behind the name changes: a Claude model id means
 * nothing to a third-party gateway, and the reverse. What the destination last
 * ran on is the best evidence of what its provider serves; failing that, what
 * the conversation itself ran on — right for a session going back to where it
 * started, which is the common case.
 */
async function modelAcross({ source, toAccountPath, transcriptsRoot }) {
	const recent = await recentModel(toAccountPath);
	if (recent) return recent;
	if (!source?.cwd) return null;
	const { transcript } = await transcriptFacts(source.cliSessionId, source.cwd, transcriptsRoot);
	return transcript ? await findModel(transcript) : null;
}

/**
 * Folds one index into another, entry by entry.
 *
 * This is the bulk form of the drag that already moves a single session, and it
 * exists because retiring an instance any other way loses things. Deleting the
 * profile would not lose conversations — the transcripts are shared, so they
 * would simply reappear as unclaimed and could be adopted again — but adoption
 * rebuilds an entry from the transcript, and the transcript never held
 * `isArchived`, a title the user typed, `lastFocusedAt`, or the Remote Control
 * links. Moving the file keeps all of it.
 *
 * Entries land under the same account uuid they were already filed under, since
 * that uuid is the account rather than the profile. They therefore become
 * visible in the destination when it is signed in as that account, which is not
 * necessarily the moment this returns.
 *
 * A duplicate is skipped rather than thrown on. One entry refusing to move is a
 * fact worth reporting; it is not a reason to abandon the other fifty
 * half-merged.
 */
export async function mergeIndexRoot({ from, toPath = INDEX_ROOT }) {
	if (!(await exists(from.path))) throw new Error('that profile has no session index to merge');

	let moved = 0;
	const skipped = [];
	const carried = [];

	for (const account of await readdir(from.path, { withFileTypes: true })) {
		if (!account.isDirectory()) continue;

		for (const org of await readdir(join(from.path, account.name), { withFileTypes: true })) {
			if (!org.isDirectory()) continue;

			const sourceDir = join(from.path, account.name, org.name);
			const targetDir = join(toPath, account.name, org.name);

			// Built once. The single-session move re-reads the whole destination for
			// every entry it checks, which is the right trade for one file and the
			// wrong one for a hundred. Read only if the folder already exists —
			// creating it here, before anything is known to be moving into it, is
			// exactly the bug this guards: an org with nothing to move would leave an
			// empty shell behind in the main profile forever.
			const taken = new Set();
			if (await exists(targetDir)) {
				for (const file of (await readdir(targetDir)).filter((f) => f.endsWith('.json'))) {
					const entry = await readEntry(join(targetDir, file));
					if (entry?.cliSessionId) taken.add(entry.cliSessionId);
				}
			}

			const fromAccount = `${from.id}:${account.name}/${org.name}`;

			for (const file of (await readdir(sourceDir)).filter((f) => f.endsWith('.json'))) {
				const source = join(sourceDir, file);
				const entry = await readEntry(source);
				if (!entry) {
					skipped.push({ file, why: 'unreadable' });
					continue;
				}
				if (taken.has(entry.cliSessionId)) {
					skipped.push({ file, title: entry.title ?? null, why: 'already listed there' });
					continue;
				}

				const target = join(targetDir, file);
				// Names are uuid-based, so a clash here means the same entry under a
				// different conversation — vanishingly unlikely, and not worth
				// inventing a new name for on the desktop app's behalf.
				if (await exists(target)) {
					skipped.push({ file, title: entry.title ?? null, why: 'a file of that name is already there' });
					continue;
				}

				// Created only now, with something real about to go into it.
				await mkdir(targetDir, { recursive: true });

				try {
					await rename(source, target);
				} catch (err) {
					if (err.code !== 'EXDEV') throw err;
					await copyFile(source, target);
					await rm(source, { force: true });
				}

				taken.add(entry.cliSessionId);
				moved++;

				// The links move with the entry, so the journal needs the same note it
				// gets from a single move — otherwise the badge would go on claiming
				// they live in a profile that no longer exists.
				const bridges = Array.isArray(entry.bridgeSessionIds) ? entry.bridgeSessionIds : [];
				if (bridges.length) carried.push({ cliSessionId: entry.cliSessionId, bridges, fromAccount });
			}
		}
	}

	return { moved, skipped, carried };
}

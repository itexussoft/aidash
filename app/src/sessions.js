/**
 * Claude Code session management.
 *
 * A Claude Code account keeps its transcripts under
 * `<config dir>/projects/<encoded cwd>/<session id>.jsonl`, where the encoded
 * name is the working directory with its slashes turned into dashes. Two
 * accounts used alternately on the same machine therefore hold sessions for the
 * same project in two different places, and moving one across is a file move.
 *
 * Two details make it more than that:
 *
 *   - `<config dir>/session-env/<session id>/` belongs to the session too and
 *     has to travel with it. On this machine every transcript had a matching
 *     entry, so leaving it behind would quietly split the session in half.
 *   - Transcripts reach tens of megabytes. Metadata is read from the head of
 *     the file only; `ai-title` lands within the first few tens of kilobytes,
 *     and the file's mtime is a better "last active" than parsing to the end.
 */

import { readdir, stat, mkdir, rename, access, open, copyFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const run = promisify(execFile);

// Enough to cover the session header and the ai-title record without ever
// pulling a large transcript into memory.
const HEAD_BYTES = 128 * 1024;

export const DEFAULT_ROOT = join(homedir(), '.claude');

const exists = (p) =>
	access(p).then(
		() => true,
		() => false,
	);

/** Reads the first bytes of a file without loading the whole thing. */
async function readHead(path, bytes = HEAD_BYTES) {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}

/**
 * Session metadata, from the head of the transcript plus filesystem stats.
 *
 * The last line of the head slice is usually truncated, so parse failures are
 * expected and ignored rather than treated as corruption.
 */
async function readSessionMeta(file) {
	const [head, stats] = await Promise.all([readHead(file), stat(file)]);

	let title = null;
	let cwd = null;
	let branch = null;
	let version = null;
	let firstAt = null;
	let messages = 0;

	for (const line of head.split('\n')) {
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type === 'ai-title' && record.aiTitle) title = record.aiTitle;
		if (!cwd && record.cwd) cwd = record.cwd;
		if (!branch && record.gitBranch) branch = record.gitBranch;
		if (!version && record.version) version = record.version;
		if (!firstAt && record.timestamp) firstAt = record.timestamp;
		if (record.type === 'user' || record.type === 'assistant') messages++;
	}

	return {
		id: basename(file, '.jsonl'),
		title,
		cwd,
		branch,
		version,
		firstAt,
		// mtime is both cheaper and more truthful than the last timestamp we
		// could see, since we only ever read the head.
		lastAt: stats.mtimeMs,
		sizeBytes: stats.size,
		// Only what the head showed; enough to tell a stub from real work.
		messagesAtLeast: messages,
	};
}

/** Identifies which account a config directory is signed in as. */
export async function identifyRoot(dir) {
	try {
		const { stdout } = await run('claude', ['auth', 'status'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
		const status = JSON.parse(stdout);
		return { email: status.email ?? null, plan: status.subscriptionType ?? null, loggedIn: Boolean(status.loggedIn) };
	} catch {
		return { email: null, plan: null, loggedIn: false };
	}
}

/** Every project folder and session inside one config directory. */
export async function scanRoot(dir) {
	const projectsDir = join(dir, 'projects');
	if (!(await exists(projectsDir))) return [];

	const entries = await readdir(projectsDir, { withFileTypes: true });
	const projects = await Promise.all(
		entries
			.filter((e) => e.isDirectory())
			.map(async (entry) => {
				const path = join(projectsDir, entry.name);
				const files = (await readdir(path)).filter((f) => f.endsWith('.jsonl'));

				const sessions = (
					await Promise.all(
						files.map((f) =>
							readSessionMeta(join(path, f)).catch(() => null),
						),
					)
				).filter(Boolean);

				sessions.sort((a, b) => b.lastAt - a.lastAt);

				return {
					key: entry.name,
					// The encoded name cannot be decoded reliably — a directory whose
					// own name contains a dash is ambiguous — so prefer the cwd the
					// transcript recorded.
					cwd: sessions.find((s) => s.cwd)?.cwd ?? entry.name,
					sessions,
				};
			}),
	);

	return projects.filter((p) => p.sessions.length > 0);
}

/**
 * Merges the per-root scans into one view keyed by project.
 *
 * Grouping by project rather than by account is what makes the rule visible:
 * a session can only move between accounts within its own row.
 */
export async function scanAll(roots) {
	const scans = await Promise.all(
		roots.map(async (root) => ({
			root,
			identity: await identifyRoot(root.path),
			projects: await scanRoot(root.path),
		})),
	);

	const byProject = new Map();
	for (const scan of scans) {
		for (const project of scan.projects) {
			if (!byProject.has(project.key)) byProject.set(project.key, { key: project.key, cwd: project.cwd, byRoot: {} });
			const entry = byProject.get(project.key);
			if (project.cwd && !entry.cwd.startsWith('/')) entry.cwd = project.cwd;
			entry.byRoot[scan.root.id] = project.sessions;
		}
	}

	const projects = [...byProject.values()].sort((a, b) => a.cwd.localeCompare(b.cwd));

	return {
		roots: scans.map((s) => ({ ...s.root, ...s.identity })),
		projects,
	};
}

/**
 * Moves one session between two config directories.
 *
 * Refuses anything that would lose data: a different project, a name already
 * taken at the destination, or a source that is no longer there.
 */
export async function moveSession({ fromDir, toDir, projectKey, sessionId }) {
	if (fromDir === toDir) throw new Error('source and destination are the same account');

	const source = join(fromDir, 'projects', projectKey, `${sessionId}.jsonl`);
	if (!(await exists(source))) throw new Error('this session is no longer where it was — rescan and try again');

	const targetDir = join(toDir, 'projects', projectKey);
	const target = join(targetDir, `${sessionId}.jsonl`);
	if (await exists(target)) throw new Error('the destination account already has a session with this id');

	await mkdir(targetDir, { recursive: true });
	await moveAcrossDevices(source, target);

	// The session's environment directory belongs with it; a session split
	// across two accounts would be worse than one that never moved.
	const envSource = join(fromDir, 'session-env', sessionId);
	if (await exists(envSource)) {
		const envTarget = join(toDir, 'session-env', sessionId);
		if (!(await exists(envTarget))) {
			await mkdir(join(toDir, 'session-env'), { recursive: true });
			await rename(envSource, envTarget).catch(() => {});
		}
	}

	return { moved: sessionId, to: toDir };
}

/** rename() fails across filesystems; fall back to copy-then-delete. */
async function moveAcrossDevices(source, target) {
	try {
		await rename(source, target);
	} catch (err) {
		if (err.code !== 'EXDEV') throw err;
		await copyFile(source, target);
		await rm(source, { force: true });
	}
}

/**
 * Codex session storage.
 *
 * Simpler than Claude's, and differently shaped:
 *
 *   CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl   the transcript
 *   CODEX_HOME/state_5.sqlite → threads                          the index
 *   CODEX_HOME/session_index.jsonl                               a lighter index
 *
 * The desktop app and the CLI share all of it — there is no separate desktop
 * store — and nothing anywhere records an account or organisation. Sessions are
 * scoped by CODEX_HOME alone, so switching Codex accounts leaves every session
 * visible. That is why Codex appears here as one column rather than one per
 * account.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, appendFile, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CODEX_HOME = join(homedir(), '.codex');

const dbPath = (codexHome) => join(codexHome, 'state_5.sqlite');
const indexPath = (codexHome) => join(codexHome, 'session_index.jsonl');

const exists = (p) =>
	access(p).then(
		() => true,
		() => false,
	);

/** Opens the thread database, or null when this home has never been used. */
async function openDb(codexHome, { readOnly = true } = {}) {
	const file = dbPath(codexHome);
	if (!(await exists(file))) return null;
	try {
		return new DatabaseSync(file, { readOnly });
	} catch {
		return null;
	}
}

/** Every thread Codex knows about in this home. */
export async function listSessions(codexHome = DEFAULT_CODEX_HOME) {
	const db = await openDb(codexHome);
	if (!db) return [];

	try {
		const rows = db
			.prepare(
				`SELECT id, rollout_path, cwd, title, name, model, tokens_used, archived, git_branch,
				        COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms
				   FROM threads
				  ORDER BY updated_ms DESC`,
			)
			.all();

		return rows.map((row) => ({
			id: row.id,
			// A thread's title is its whole first message, which can be a page
			// long; the card shows a single line.
			title: firstLine(row.name || row.title),
			cwd: row.cwd,
			model: row.model ?? null,
			tokens: row.tokens_used ?? 0,
			archived: Boolean(row.archived),
			branch: row.git_branch ?? null,
			lastAt: row.updated_ms ?? null,
			transcript: row.rollout_path ?? null,
		}));
	} finally {
		db.close();
	}
}

const firstLine = (text) => {
	const line = String(text ?? '')
		.split('\n')
		.find((l) => l.trim());
	return line ? (line.length > 120 ? `${line.slice(0, 120)}…` : line) : null;
};

export async function renameSession(codexHome, threadId, title) {
	const next = String(title ?? '').trim();
	if (!next) throw new Error('a name is required');

	const db = await openDb(codexHome, { readOnly: false });
	if (!db) throw new Error('this Codex home has no session database');

	try {
		// `name` is the display title; `title` holds the original first message
		// and is left alone so nothing about the conversation is rewritten.
		const changed = db.prepare('UPDATE threads SET name = ? WHERE id = ?').run(next, threadId);
		if (changed.changes === 0) throw new Error('no such session');
	} finally {
		db.close();
	}

	await rewriteIndexLine(codexHome, threadId, (entry) => ({ ...entry, thread_name: next }));
}

/**
 * Removes a session entirely: the index row, the lighter index line, and the
 * transcript. There is no half-deleted state to explain afterwards.
 */
export async function deleteSession(codexHome, threadId) {
	const db = await openDb(codexHome, { readOnly: false });
	if (!db) throw new Error('this Codex home has no session database');

	let rolloutPath = null;
	try {
		const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId);
		if (!row) throw new Error('no such session');
		rolloutPath = row.rollout_path;
		db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
	} finally {
		db.close();
	}

	await rewriteIndexLine(codexHome, threadId, () => null);
	if (rolloutPath) await rm(rolloutPath, { force: true });
}

/** Rewrites or drops one line of session_index.jsonl. */
async function rewriteIndexLine(codexHome, threadId, transform) {
	const file = indexPath(codexHome);
	if (!(await exists(file))) return;

	const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim());
	const kept = [];
	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			kept.push(line);
			continue;
		}
		if (entry.id !== threadId) {
			kept.push(line);
			continue;
		}
		const next = transform(entry);
		if (next) kept.push(JSON.stringify(next));
	}

	await writeFile(file, kept.length ? `${kept.join('\n')}\n` : '');
}

/**
 * Writes a conversation carried over from Claude as a Codex session.
 *
 * Only messages are written. Codex reads a rollout as a flat stream of
 * `response_item` entries, so the dialogue transfers cleanly while tool calls
 * have no faithful equivalent and are left out — see transfer.js.
 */
export async function importConversation(codexHome, { title, cwd, messages, preamble }) {
	const id = randomUUID();
	const now = new Date();
	const stamp = now.toISOString();
	const folder = join(codexHome, 'sessions', String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1), pad(now.getUTCDate()));
	await mkdir(folder, { recursive: true });

	const fileStamp = stamp.replace(/:/g, '-').replace(/\..*$/, '');
	const rolloutPath = join(folder, `rollout-${fileStamp}-${id}.jsonl`);

	const lines = [
		JSON.stringify({
			timestamp: stamp,
			type: 'session_meta',
			payload: {
				id,
				timestamp: stamp,
				cwd: cwd ?? homedir(),
				originator: 'aidash',
				cli_version: 'imported',
				source: 'import',
				model_provider: 'openai',
			},
		}),
		JSON.stringify(message('user', preamble, stamp)),
		...messages.map((m) => JSON.stringify(message(m.role, m.text, m.at ?? stamp))),
	];

	await writeFile(rolloutPath, `${lines.join('\n')}\n`);

	const db = await openDb(codexHome, { readOnly: false });
	if (!db) throw new Error('this Codex home has no session database');
	try {
		const seconds = Math.floor(now.getTime() / 1000);
		db.prepare(
			`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
			                      sandbox_policy, approval_mode, tokens_used, has_user_event, archived,
			                      cli_version, first_user_message, memory_mode, preview, recency_at, history_mode, name)
			 VALUES (?, ?, ?, ?, 'import', 'openai', ?, ?, 'workspace-write', 'on-request', 0, 1, 0,
			         'imported', ?, 'enabled', ?, ?, 'legacy', ?)`,
		).run(
			id,
			rolloutPath,
			seconds,
			seconds,
			cwd ?? homedir(),
			title,
			messages[0]?.text?.slice(0, 500) ?? '',
			messages[0]?.text?.slice(0, 200) ?? '',
			seconds,
			title,
		);
	} finally {
		db.close();
	}

	await appendFile(indexPath(codexHome), `${JSON.stringify({ id, thread_name: title, updated_at: stamp })}\n`);

	return { id, rolloutPath };
}

const pad = (n) => String(n).padStart(2, '0');

const message = (role, text, at) => ({
	timestamp: at,
	type: 'response_item',
	payload: {
		type: 'message',
		role,
		content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
	},
});

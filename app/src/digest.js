/**
 * A project brief, assembled from transcripts and nothing else.
 *
 * The point is starting work on a project under a different account without
 * beginning from nothing — so it has to be true, and being true here means
 * being derived. No model is called and nothing is summarised: what comes out
 * is what was recorded — the branches worked on, the files the tools touched,
 * and the last things actually said. A paragraph of invented context would read
 * better and be worth less than a list of file paths.
 *
 * It is deliberately partial, and says so in its own text. Only the most recent
 * few sessions are read, and each only up to a cap, because a project's
 * transcripts run to hundreds of megabytes and the recent end is the part that
 * carries the state of play.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';

/** How many of a project's sessions to read, newest first. */
export const SESSIONS_READ = 5;

/** How much of one transcript to read before giving up on the rest. */
export const MAX_BYTES = 8 * 1024 * 1024;

/** How many of the most recent exchanges to quote. */
const MESSAGES_KEPT = 6;

const MESSAGE_CLIP = 600;

const clip = (text, max = MESSAGE_CLIP) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/**
 * Streams a transcript, stopping at the cap.
 *
 * Reports whether it reached the end, because a digest built from half a
 * transcript should not claim to describe the whole of it.
 */
async function* records(file) {
	let read = 0;
	const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	for await (const line of stream) {
		read += Buffer.byteLength(line) + 1;
		if (read > MAX_BYTES) {
			stream.close();
			return false;
		}
		if (!line.trim()) continue;
		try {
			yield JSON.parse(line);
		} catch {
			/* a partially written final line is normal */
		}
	}
	return true;
}

/** Paths a Claude tool call names, whatever the tool calls the argument. */
function pathsFrom(input) {
	if (!input || typeof input !== 'object') return [];
	const found = [];
	for (const key of ['file_path', 'path', 'notebook_path']) {
		if (typeof input[key] === 'string' && input[key].trim()) found.push(input[key]);
	}
	// Multi-edit style calls carry a list rather than a single path.
	if (Array.isArray(input.edits)) for (const edit of input.edits) found.push(...pathsFrom(edit));
	return found;
}

const relativeTo = (cwd, path) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

/**
 * Reads one transcript for what a brief needs.
 *
 * Claude and Codex record tool calls entirely differently, so each is read on
 * its own terms; nothing is translated between them, only collected.
 */
export async function readSession(file, tool, cwd) {
	const files = new Set();
	const branches = new Set();
	const messages = [];
	let complete = true;

	try {
		const stream = records(file);
		for (;;) {
			const next = await stream.next();
			if (next.done) {
				complete = next.value !== false;
				break;
			}
			const record = next.value;

			if (tool === 'codex') {
				const payload = record.payload;
				if (payload?.type === 'function_call' && typeof payload.arguments === 'string') {
					try {
						for (const path of pathsFrom(JSON.parse(payload.arguments))) files.add(relativeTo(cwd, path));
					} catch {
						/* arguments are not always JSON */
					}
				}
				if (payload?.type === 'message' && payload.role === 'user') {
					const text = (payload.content ?? [])
						.filter((b) => typeof b?.text === 'string')
						.map((b) => b.text)
						.join('\n')
						.trim();
					if (text) messages.push({ role: 'user', text: clip(text), at: record.timestamp ?? null });
				}
				continue;
			}

			if (record.gitBranch) branches.add(record.gitBranch);

			const content = record.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === 'tool_use') for (const path of pathsFrom(block.input)) files.add(relativeTo(cwd, path));
				}
			}

			if (record.type === 'user') {
				const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
				// Tool results are recorded as user turns too; they are not things
				// anyone said, and quoting them back would be noise.
				if (text.trim() && !text.startsWith('Result of calling')) {
					messages.push({ role: 'user', text: clip(text.trim()), at: record.timestamp ?? null });
				}
			}
		}
	} catch {
		return { files: [...files], branches: [...branches], messages, complete: false };
	}

	return { files: [...files], branches: [...branches], messages, complete };
}

/**
 * The brief for one project.
 *
 * `sessions` arrives newest first; only the head of that list is read.
 */
export async function buildDigest({ cwd, sessions, sources }) {
	const ordered = (sessions ?? []).filter((s) => s.transcript);
	const read = ordered.slice(0, SESSIONS_READ);

	const files = new Set();
	const branches = new Set();
	const exchanges = [];
	let truncated = ordered.length > read.length;

	for (const session of read) {
		const found = await readSession(session.transcript, session.tool === 'codex' ? 'codex' : 'claude', cwd);
		for (const file of found.files) files.add(file);
		for (const branch of found.branches) branches.add(branch);
		if (!found.complete) truncated = true;

		for (const message of found.messages.slice(-2)) {
			exchanges.push({ ...message, session: session.title ?? '(untitled)', source: session.source });
		}
	}

	exchanges.sort((a, b) => (Date.parse(b.at ?? 0) || 0) - (Date.parse(a.at ?? 0) || 0));

	return {
		cwd,
		branches: [...branches].sort(),
		files: [...files].sort(),
		sources: sources ?? [],
		sessions: ordered.length,
		read: read.length,
		exchanges: exchanges.slice(0, MESSAGES_KEPT),
		truncated,
	};
}

/** The brief as text, which is the form it is actually used in. */
export function digestMarkdown(digest) {
	const lines = [
		`# ${basename(digest.cwd || 'project')}`,
		'',
		`- Working directory: ${digest.cwd}`,
		`- Sessions on this machine: ${digest.sessions}`,
		digest.sources.length ? `- Worked on under: ${digest.sources.join(', ')}` : null,
		digest.branches.length ? `- Branches: ${digest.branches.join(', ')}` : null,
		'',
		`> Assembled from the ${digest.read} most recent transcript${digest.read === 1 ? '' : 's'} on this machine.`,
		'> Nothing here is summarised — it is what was recorded. Sessions run under other',
		'> accounts or on other machines are not included.',
		'',
	].filter((line) => line !== null);

	if (digest.files.length) {
		lines.push('## Files touched', '');
		for (const file of digest.files) lines.push(`- \`${file}\``);
		lines.push('');
	}

	if (digest.exchanges.length) {
		lines.push('## Most recent things asked', '');
		for (const exchange of digest.exchanges) {
			lines.push(`**${exchange.session}**${exchange.source ? ` · ${exchange.source}` : ''}`, '', `> ${exchange.text.replace(/\n/g, '\n> ')}`, '');
		}
	}

	if (digest.truncated) {
		lines.push('---', '', 'Some transcripts were longer than this brief reads, so it describes their recent end rather than the whole of them.', '');
	}

	return lines.join('\n');
}

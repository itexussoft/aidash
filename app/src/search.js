/**
 * Looking through every transcript at once.
 *
 * This is the one thing neither vendor's client can do. Each sees the account
 * it is signed in as, and the answer to "where did I solve this already" is
 * routinely under a different one — or in the other tool entirely. On disk
 * there is no such boundary: the transcripts are all just files.
 *
 * Two passes, because the corpus is hundreds of megabytes and most of it is not
 * prose:
 *
 *   1. a raw substring scan of the file, in chunks, which rejects almost
 *      everything without parsing a single line;
 *   2. for the few files that survive, a line-by-line read to find the match
 *      inside something that was actually *said*.
 *
 * The second pass is what keeps the results honest. A raw hit is often inside a
 * tool result, a file path or a base64 blob — true, and not what anyone meant
 * by "where did I discuss this". A file whose only hits are outside the
 * dialogue is dropped.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { open } from 'node:fs/promises';

/** Read size for the rejecting pass. */
const CHUNK = 1 << 20;

/** How much of one file to scan before giving up on the rest of it. */
const MAX_BYTES = 64 * 1024 * 1024;

/** Characters of context either side of a hit. */
const CONTEXT = 70;

/** How many files to read at once. */
const CONCURRENCY = 8;

const tidy = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Does this file contain the term at all?
 *
 * Chunks overlap by the length of the term so a match straddling a boundary is
 * not lost — the bug this would otherwise have is silent and rare, which is the
 * worst kind.
 */
async function mentions(file, needle) {
	const handle = await open(file, 'r');
	try {
		const overlap = Math.max(0, needle.length - 1);
		const buffer = Buffer.alloc(CHUNK);
		let carry = '';
		let position = 0;

		while (position < MAX_BYTES) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
			if (!bytesRead) return false;
			position += bytesRead;

			const text = carry + buffer.subarray(0, bytesRead).toString('utf8');
			if (text.toLowerCase().includes(needle)) return true;
			carry = overlap ? text.slice(-overlap) : '';
		}
		return false;
	} finally {
		await handle.close();
	}
}

/** The readable text of one record, whichever tool wrote it. */
function saidIn(record, tool) {
	if (tool === 'codex') {
		const payload = record?.payload;
		if (payload?.type !== 'message') return null;
		if (payload.role !== 'user' && payload.role !== 'assistant') return null;
		return (payload.content ?? [])
			.filter((block) => typeof block?.text === 'string')
			.map((block) => block.text)
			.join('\n');
	}

	if (record?.type !== 'user' && record?.type !== 'assistant') return null;
	// Claude Code writes tool results back as user turns, and marks the ones it
	// synthesised. They are the tool talking, not the person, and matching them
	// would answer "where does this string appear" rather than "where did I
	// discuss this" — which is the question the search claims to answer.
	if (record.isMeta) return null;

	const content = record.message?.content;
	if (typeof content === 'string') return content.startsWith('Result of calling') ? null : content;
	if (!Array.isArray(content)) return null;
	return content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n');
}

/**
 * Finds the term inside the dialogue and quotes it.
 *
 * Returns null when every hit was outside anything said, which is how a match
 * in a tool result stops being a result.
 */
async function quote(file, needle, tool) {
	const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	let hits = 0;
	let snippet = null;
	let role = null;

	try {
		for await (const line of stream) {
			if (!line.trim()) continue;
			// Cheap rejection before the expensive parse: most lines do not contain
			// the term at all.
			if (!line.toLowerCase().includes(needle)) continue;

			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}

			const said = saidIn(record, tool);
			if (!said) continue;

			const at = said.toLowerCase().indexOf(needle);
			if (at < 0) continue;

			hits++;
			if (snippet) continue;

			const from = Math.max(0, at - CONTEXT);
			const to = Math.min(said.length, at + needle.length + CONTEXT);
			snippet = `${from > 0 ? '…' : ''}${tidy(said.slice(from, to))}${to < said.length ? '…' : ''}`;
			role = record.type === 'assistant' || record?.payload?.role === 'assistant' ? 'assistant' : 'user';
		}
	} finally {
		stream.close();
	}

	return snippet ? { snippet, hits, role } : null;
}

/**
 * Searches the given transcripts, newest first, stopping when asked.
 *
 * `targets` are `{ transcript, tool }`; everything else the caller already
 * knows, so results are keyed by the transcript path and nothing about a
 * session is passed through here and back again.
 */
export async function searchTranscripts({ targets, query, signal, limit = 500 }) {
	const needle = String(query ?? '')
		.trim()
		.toLowerCase();
	if (needle.length < 2) return { results: [], scanned: 0, complete: true };

	const queue = (targets ?? []).filter((t) => t?.transcript);
	const results = [];
	let scanned = 0;
	let index = 0;

	const worker = async () => {
		for (;;) {
			if (signal?.aborted || results.length >= limit) return;
			const target = queue[index++];
			if (!target) return;

			try {
				if (!(await mentions(target.transcript, needle))) {
					scanned++;
					continue;
				}
				const found = await quote(target.transcript, needle, target.tool);
				scanned++;
				if (found) results.push({ transcript: target.transcript, ...found });
			} catch {
				// A transcript that has gone, or that cannot be read, is not a
				// failed search — it is one fewer place to look.
				scanned++;
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

	return {
		results,
		scanned,
		complete: !signal?.aborted && results.length < limit,
	};
}

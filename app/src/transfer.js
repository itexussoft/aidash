/**
 * Carrying a conversation from one tool to the other.
 *
 * This is a copy, not a move, and it is lossy on purpose — the two formats do
 * not describe the same thing:
 *
 *   Claude   `user` / `assistant` records whose `message.content` is a list of
 *            blocks (`text`, `thinking`, `tool_use`, `tool_result`), linked
 *            into a tree by `uuid` / `parentUuid`.
 *   Codex    a flat stream of `response_item` entries — `message`,
 *            `reasoning`, `function_call`, `function_call_output` — with tools
 *            named and shaped entirely differently.
 *
 * What survives is the dialogue: what was asked and what was answered. Tool
 * calls, their results, reasoning blocks and the branch structure do not,
 * because there is nothing faithful to translate them into. Anything claiming
 * otherwise would be inventing history the other tool would then act on.
 *
 * The copy is titled "<source> imported: <name>" so it is never mistaken for a
 * native session.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** How much of one message to keep; whole transcripts can be tens of megabytes. */
const MAX_TEXT = 100_000;

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[…truncated]` : text);

/** Reads a JSONL file a line at a time, skipping anything unparseable. */
async function* records(file) {
	const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	for await (const line of stream) {
		if (!line.trim()) continue;
		try {
			yield JSON.parse(line);
		} catch {
			/* a partially written final line is normal */
		}
	}
}

/** Joins the readable text out of a Claude content list. */
function claudeText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/**
 * The neutral form both writers take: who said what, in order.
 *
 * Roles other than user and assistant are dropped — Codex records the system
 * prompt as a `developer` message, and carrying that across would hand the
 * other tool someone else's instructions.
 */
export async function readConversation(file, tool) {
	const messages = [];
	let cwd = null;
	let title = null;

	for await (const record of records(file)) {
		if (tool === 'claude') {
			cwd ??= record.cwd ?? null;
			if (record.type === 'ai-title' && record.aiTitle) title = record.aiTitle;
			if (record.type !== 'user' && record.type !== 'assistant') continue;
			const text = claudeText(record.message?.content);
			if (text) messages.push({ role: record.type, text: clip(text), at: record.timestamp ?? null });
			continue;
		}

		const payload = record.payload;
		if (record.type === 'session_meta') cwd ??= payload?.cwd ?? null;
		if (record.type !== 'response_item' || payload?.type !== 'message') continue;
		if (payload.role !== 'user' && payload.role !== 'assistant') continue;

		const text = (payload.content ?? [])
			.filter((block) => typeof block?.text === 'string')
			.map((block) => block.text)
			.join('\n')
			.trim();
		if (text) messages.push({ role: payload.role, text: clip(text), at: record.timestamp ?? null });
	}

	return { title, cwd, messages };
}

export const importedTitle = (sourceTool, title) =>
	`${sourceTool === 'claude' ? 'Claude' : 'Codex'} imported: ${title || 'untitled session'}`;

/**
 * The note placed at the head of a copied conversation.
 *
 * The receiving tool reads this as the first thing in the session, so it says
 * plainly what it is holding and what is missing from it.
 */
export function preamble(sourceTool, title) {
	const source = sourceTool === 'claude' ? 'Claude Code' : 'Codex';
	return [
		`This conversation was imported from ${source}.`,
		'',
		`Original title: ${title || 'untitled session'}`,
		'',
		'It contains the dialogue only. Tool calls, their results, reasoning and any',
		'branch structure were not carried across, because the two tools describe',
		'those differently and inventing them would be worse than omitting them.',
		'Files on disk are unchanged and are the reliable record of what was done.',
	].join('\n');
}

/** Renders a conversation as Markdown, for the export-to-file action. */
export function toMarkdown({ title, cwd, messages }, sourceTool) {
	const lines = [
		`# ${title || 'Untitled session'}`,
		'',
		`- Tool: ${sourceTool === 'claude' ? 'Claude Code' : 'Codex'}`,
		cwd ? `- Working directory: ${cwd}` : null,
		`- Messages: ${messages.length}`,
		'',
		'> Dialogue only — tool calls, results and reasoning are not included.',
		'',
		'---',
		'',
	].filter((line) => line !== null);

	for (const message of messages) {
		lines.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}${message.at ? ` · ${message.at}` : ''}`, '', message.text, '');
	}

	return lines.join('\n');
}

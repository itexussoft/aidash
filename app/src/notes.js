/**
 * What changed, per version, in the app's own words.
 *
 * Two sources, and they answer different questions:
 *
 *   the manifest    what a version you do not have yet would give you. Only the
 *                   server knows this, because the build predates the release.
 *   CHANGELOG.md    what the version you are running brought. It ships inside
 *                   the app, so it works offline and cannot disagree with the
 *                   binary it came with.
 *
 * Keeping them apart matters: a banner that quoted the local file would be
 * describing the wrong version, and an About tab that needed the network would
 * have nothing to say on a train.
 *
 * The file is Markdown because a person maintains it. `## 1.2.3` starts a
 * version and each `-` under it is one line in the interface; anything else is
 * prose for whoever edits the file and is ignored here.
 */

import { readFile } from 'node:fs/promises';

/** A heading that names a version, or `Unreleased` for work not yet shipped. */
const HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.+?)\s*$/;

/**
 * Parses the changelog into entries, in the order the file lists them.
 *
 * Continuation lines are folded into the bullet above, so a note can be wrapped
 * in the file without arriving in the interface as two half-sentences.
 */
export function parseNotes(markdown) {
	const entries = [];
	let current = null;

	for (const raw of String(markdown ?? '').split('\n')) {
		const heading = raw.match(HEADING);
		if (heading) {
			current = { version: heading[1], bullets: [] };
			entries.push(current);
			continue;
		}
		if (!current) continue;

		const bullet = raw.match(BULLET);
		if (bullet) {
			current.bullets.push(bullet[1]);
			continue;
		}

		// An indented continuation of the previous bullet.
		if (/^\s+\S/.test(raw) && current.bullets.length) {
			current.bullets[current.bullets.length - 1] += ` ${raw.trim()}`;
		}
	}

	return entries.filter((entry) => entry.bullets.length);
}

/** The entry for one version, matched exactly. */
export const notesFor = (entries, version) => entries.find((entry) => entry.version === String(version)) ?? null;

/**
 * Reads and parses the shipped changelog.
 *
 * Never throws: a build without the file is missing a nicety, not a working
 * application, and an About tab is no place to learn that.
 */
export async function readNotes(file) {
	try {
		return parseNotes(await readFile(file, 'utf8'));
	} catch {
		return [];
	}
}

/**
 * Normalises whatever the manifest offers into lines.
 *
 * Older manifests carry a single string, and one is still on the server, so the
 * banner has to keep understanding it.
 */
export function manifestNotes(notes) {
	if (Array.isArray(notes)) return notes.map((line) => String(line).trim()).filter(Boolean);
	const text = String(notes ?? '').trim();
	return text ? [text] : [];
}

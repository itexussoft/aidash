/**
 * Update checking.
 *
 * This notifies rather than installs, and that is a constraint rather than a
 * preference: macOS refuses to apply an update to an unsigned application, so
 * electron-updater cannot do its job until the build is signed and notarised
 * with an Apple Developer certificate. Until then, telling the user a new
 * version exists and linking them to it is the honest whole of what works.
 *
 * The shape below is deliberately the same one electron-updater expects — a
 * version and a download per platform — so swapping in a real updater later is
 * a change here and nowhere else.
 */

import { manifestNotes } from './notes.js';

const MANIFEST_URL = 'https://aidash.itex.us/version.json';
const TIMEOUT_MS = 8000;

/** Compares dotted versions numerically, so 0.10.0 outranks 0.9.0. */
export function isNewer(candidate, current) {
	const parse = (v) =>
		String(v ?? '')
			.split('.')
			.map((n) => Number.parseInt(n, 10) || 0);
	const a = parse(candidate);
	const b = parse(current);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
		if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
	}
	return false;
}

function platformKey() {
	const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
	return `${os}-${process.arch}`;
}

/**
 * Returns update information, or null when up to date.
 *
 * Never throws: a machine that is offline, or behind a network that blocks the
 * check, should show the dashboard rather than an error about updates.
 */
export async function checkForUpdate(currentVersion) {
	try {
		const res = await fetch(MANIFEST_URL, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) return null;

		const manifest = await res.json();
		if (!manifest?.version || !isNewer(manifest.version, currentVersion)) return null;

		const key = platformKey();
		return {
			version: manifest.version,
			// Lines rather than a sentence: a release is a list of things, and the
			// banner has room to show it as one. A manifest still carrying a single
			// string arrives as a list of one.
			notes: manifestNotes(manifest.notes),
			// Fall back to the landing page when this platform has no build yet,
			// so the banner still leads somewhere useful.
			downloadUrl: manifest.downloads?.[key] ?? manifest.downloads?.[platformKey().split('-')[0]] ?? manifest.url ?? 'https://aidash.itex.us',
		};
	} catch {
		return null;
	}
}

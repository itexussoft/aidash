/**
 * Finding the vendor clients across platforms.
 *
 * Three things go wrong here and all of them fail quietly:
 *
 *   - Windows has no `which`; the lookup command is `where`.
 *   - npm-installed CLIs on Windows are `.cmd` shims that `spawn` cannot run
 *     without a shell.
 *   - A name on PATH is not necessarily a working program. A stale npm install
 *     of Codex leaves a launcher whose platform binary is gone, so it exits
 *     immediately with ENOENT — and being first on PATH, it would win over the
 *     working copy inside ChatGPT.app.
 *
 * So candidates are ranked, then tried: the first one that actually answers is
 * the one used, and the answer is cached because probing costs a process.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const isWindows = process.platform === 'win32';

/** Where each client tends to live when it is not on PATH. */
export function wellKnownPaths(command) {
	const home = homedir();

	if (command === 'codex') {
		if (process.platform === 'darwin') return ['/Applications/ChatGPT.app/Contents/Resources/codex'];
		if (isWindows) {
			return [
				join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
				join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'codex.cmd'),
			];
		}
		return [join(home, '.local', 'bin', 'codex')];
	}

	if (command === 'claude') {
		if (isWindows) {
			return [
				join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
				join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe'),
			];
		}
		return [join(home, '.local', 'bin', 'claude')];
	}

	return [];
}

/** Every plausible path, PATH entries first, without duplicates. */
export function candidates(command) {
	const found = [];

	try {
		const out = execFileSync(isWindows ? 'where' : 'which', [command], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		// `where` reports every match, one per line.
		found.push(...out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
	} catch {
		/* not on PATH */
	}

	found.push(...wellKnownPaths(command));

	return [...new Set(found.filter((p) => p && existsSync(p)))];
}

/** Spawn options for a located binary. */
export function spawnOptionsFor(binaryPath) {
	// A `.cmd` or `.bat` is a batch script, which Windows can only run through
	// its command interpreter — spawning it directly fails with EINVAL.
	return isWindows && /\.(cmd|bat)$/i.test(binaryPath ?? '') ? { shell: true } : {};
}

/**
 * Whether a candidate is a working program rather than a broken launcher.
 *
 * `--version` is cheap and every client supports it; a stale shim exits
 * non-zero having printed its own spawn failure.
 */
function works(binaryPath) {
	try {
		const result = spawnSync(binaryPath, ['--version'], {
			encoding: 'utf8',
			timeout: 10000,
			stdio: ['ignore', 'pipe', 'pipe'],
			...spawnOptionsFor(binaryPath),
		});
		if (result.error || result.status !== 0) return false;
		// A launcher that cannot find its payload prints the failure and still
		// sometimes exits 0, so treat an ENOENT report as a failure too.
		return !/ENOENT|cannot find|not found/i.test(`${result.stdout}${result.stderr}`);
	} catch {
		return false;
	}
}

const cache = new Map();

/**
 * Absolute path to a working client, or null.
 *
 * Cached for the process lifetime: this runs on every availability check and
 * every scan, and probing is a subprocess each time.
 */
export function locate(command) {
	if (cache.has(command)) return cache.get(command);

	const found = candidates(command).find(works) ?? null;
	cache.set(command, found);
	return found;
}

/** Forgets probe results, for when a client is installed while the app runs. */
export function forgetLocations() {
	cache.clear();
}

/**
 * Finding the vendor clients across platforms.
 *
 * Two things differ on Windows and both are silent failures rather than loud
 * ones: the lookup command is `where` rather than `which`, and npm-installed
 * CLIs are `.cmd` shims that `spawn` cannot execute without a shell. Getting
 * either wrong means the app reports the client as "not installed" on a machine
 * where it is installed.
 */

import { execFileSync } from 'node:child_process';
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

/**
 * Absolute path to a client, or null.
 *
 * PATH is consulted first because a user who installed the client deliberately
 * should win over a guess about install locations.
 */
export function locate(command) {
	const candidates = [];

	try {
		const out = execFileSync(isWindows ? 'where' : 'which', [command], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		// `where` reports every match, one per line.
		candidates.push(...out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
	} catch {
		/* not on PATH */
	}

	candidates.push(...wellKnownPaths(command));

	return candidates.find((p) => p && existsSync(p)) ?? null;
}

/**
 * Spawn options for a located binary.
 *
 * A `.cmd` or `.bat` is a batch script, which Windows can only run through its
 * command interpreter — spawning it directly fails with EINVAL.
 */
export function spawnOptionsFor(binaryPath) {
	return isWindows && /\.(cmd|bat)$/i.test(binaryPath ?? '') ? { shell: true } : {};
}

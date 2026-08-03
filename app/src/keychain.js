/**
 * Reads and writes the credentials Claude Code stores for a config directory.
 *
 * On macOS these live in the login keychain under a service name suffixed with
 * the first 8 hex of sha256(configDir) — which is exactly what lets several
 * accounts coexist without colliding. Other platforms keep a
 * `.credentials.json` inside the directory itself. Both are handled, so this
 * does not depend on guessing the platform right.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { userInfo } from 'node:os';

const run = promisify(execFile);

const serviceFor = (configDir) => `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;

const credFileFor = (configDir) => join(configDir, '.credentials.json');

/** Returns the OAuth block, or null when this directory has no login. */
export async function readClaudeCredentials(configDir) {
	const file = credFileFor(configDir);
	if (existsSync(file)) {
		try {
			const raw = JSON.parse(await readFile(file, 'utf8'));
			return raw.claudeAiOauth ?? raw;
		} catch {
			/* fall through to the keychain */
		}
	}

	if (process.platform !== 'darwin') return null;

	try {
		const { stdout } = await run('security', ['find-generic-password', '-s', serviceFor(configDir), '-w']);
		const raw = JSON.parse(stdout);
		return raw.claudeAiOauth ?? raw;
	} catch {
		return null;
	}
}

/**
 * Persists rotated tokens back where Claude Code expects them.
 *
 * Both providers invalidate the previous tokens when a refresh happens, so
 * writing back is not bookkeeping — skipping it would leave the vendor CLI
 * holding a dead credential for this directory.
 */
export async function writeClaudeCredentials(configDir, oauth) {
	const payload = JSON.stringify({ claudeAiOauth: oauth });

	const file = credFileFor(configDir);
	if (existsSync(file)) {
		await writeFile(file, payload, { mode: 0o600 });
		return;
	}

	if (process.platform !== 'darwin') {
		await writeFile(file, payload, { mode: 0o600 });
		return;
	}

	// -U updates the existing item instead of failing on a duplicate.
	await run('security', [
		'add-generic-password',
		'-U',
		'-a',
		userInfo().username,
		'-s',
		serviceFor(configDir),
		'-w',
		payload,
	]);
}

/** Removes the credential for a directory, used when deleting an account. */
export async function deleteClaudeCredentials(configDir) {
	if (process.platform !== 'darwin') return;
	try {
		await run('security', ['delete-generic-password', '-s', serviceFor(configDir)]);
	} catch {
		/* nothing stored for this directory */
	}
}

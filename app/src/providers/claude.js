/**
 * Claude provider.
 *
 * Sign-in is driven through `claude auth login`, which works fine without a
 * terminal: it prints the authorization URL on stdout and then waits on stdin
 * for a code. Unlike Codex it redirects to a web page rather than to localhost,
 * so the user copies a code back — the interface asks for it instead of a
 * terminal doing so.
 *
 * Usage itself is a plain HTTPS call with the account's access token. Refresh
 * is done here rather than by the CLI, because there is no CLI command that
 * forces one; rotated tokens are written back so the CLI keeps working too.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readClaudeCredentials, writeClaudeCredentials } from '../keychain.js';
import { locate, spawnOptionsFor } from '../locate.js';

const run = promisify(execFile);

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Refresh a little early so a request never races the expiry boundary.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function findBinary() {
	return locate('claude');
}

export async function authStatus(configDir) {
	try {
		const binary = findBinary();
		if (!binary) return { loggedIn: false };
		const { stdout } = await run(binary, ['auth', 'status'], {
			env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
			...spawnOptionsFor(binary),
		});
		return JSON.parse(stdout);
	} catch {
		return { loggedIn: false };
	}
}

export const isAuthenticated = async (configDir) => Boolean((await authStatus(configDir)).loggedIn);

/**
 * Runs the sign-in.
 *
 * `onUrl` gets the authorization URL; `onNeedCode` is awaited when the CLI asks
 * for the code the browser shows, and must resolve to that code.
 */
export async function login(configDir, { onUrl, onNeedCode, signal } = {}) {
	const binary = findBinary();
	if (!binary) throw new Error('Claude Code is not installed on this machine');

	await new Promise((resolve, reject) => {
		const proc = spawn(binary, ['auth', 'login', '--claudeai'], {
			env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
			stdio: ['pipe', 'pipe', 'pipe'],
			...spawnOptionsFor(binary),
		});

		let seen = '';
		let urlSent = false;
		let codeRequested = false;

		const abort = () => {
			proc.kill('SIGKILL');
			reject(new Error('cancelled'));
		};
		signal?.addEventListener('abort', abort, { once: true });

		const consume = async (chunk) => {
			seen += chunk;
			// Strip the CLI's colour codes before matching on its prompts.
			const plain = seen.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

			if (!urlSent) {
				const url = plain.match(/https:\/\/\S*oauth\/authorize\S*/)?.[0];
				if (url) {
					urlSent = true;
					onUrl?.(url);
				}
			}

			if (!codeRequested && /Paste code here/i.test(plain)) {
				codeRequested = true;
				try {
					const code = await onNeedCode?.();
					if (!code) throw new Error('no code supplied');
					proc.stdin.write(`${code}\n`);
				} catch (err) {
					proc.kill('SIGKILL');
					reject(err);
				}
			}
		};

		proc.stdout.on('data', consume);
		proc.stderr.on('data', consume);

		proc.on('error', reject);
		proc.on('exit', (code) => {
			signal?.removeEventListener('abort', abort);
			if (code === 0) resolve();
			else reject(new Error(`sign-in failed${/invalid/i.test(seen) ? ' — the code was not accepted' : ''}`));
		});
	});

	const status = await authStatus(configDir);
	if (!status.loggedIn) throw new Error('Claude reports this account is not signed in');
	return { email: status.email ?? null, plan: status.subscriptionType ?? null };
}

/** Returns a usable access token, refreshing and writing back when needed. */
async function accessToken(configDir) {
	const creds = await readClaudeCredentials(configDir);
	if (!creds?.refreshToken) throw new Error('no stored credentials — re-authorize this account');

	if (creds.accessToken && creds.expiresAt && creds.expiresAt - Date.now() > REFRESH_SKEW_MS) {
		return creds.accessToken;
	}

	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: creds.refreshToken }),
	});

	const text = await res.text();
	if (!res.ok) throw new Error(`could not refresh: HTTP ${res.status} ${text.slice(0, 160)}`);

	const json = JSON.parse(text);
	const updated = {
		...creds,
		accessToken: json.access_token,
		// Absent means the server kept the old one; keeping ours avoids writing
		// undefined over a working credential.
		refreshToken: json.refresh_token ?? creds.refreshToken,
		expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
	};

	await writeClaudeCredentials(configDir, updated);
	return updated.accessToken;
}

export async function fetchUsage(configDir) {
	const token = await accessToken(configDir);

	const res = await fetch(USAGE_URL, {
		headers: {
			authorization: `Bearer ${token}`,
			'anthropic-beta': 'oauth-2025-04-20',
			accept: 'application/json',
		},
	});

	const text = await res.text();
	if (!res.ok) throw new Error(`usage request failed: HTTP ${res.status} ${text.slice(0, 160)}`);
	return JSON.parse(text);
}

export const claude = { id: 'claude', name: 'Claude', findBinary, isAuthenticated, authStatus, login, fetchUsage };

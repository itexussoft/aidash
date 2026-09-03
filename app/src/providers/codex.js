/**
 * Codex provider.
 *
 * Everything goes through `codex app-server`, the JSON-RPC interface the
 * official client itself uses. That choice matters twice over: the binary owns
 * token refresh, so this app never handles a Codex credential at all; and
 * `account/usage/read` returns daily history that the plain HTTP endpoint does
 * not.
 *
 * Running locally also sidesteps the reason the hosted version needed a relay —
 * chatgpt.com refuses the Cloudflare Workers runtime, but has no quarrel with
 * an ordinary machine.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { locate, spawnable } from '../locate.js';

/** Where the binary keeps this account's credential, inside its CODEX_HOME. */
const authFile = (configDir) => join(configDir, 'auth.json');

export function findBinary() {
	return locate('codex');
}

/**
 * Opens an app-server session and hands it to `body`, always tearing the
 * process down afterwards.
 */
async function withSession(configDir, body) {
	const binary = findBinary();
	if (!binary) throw new Error('Codex is not installed on this machine');

	const { command, options } = spawnable(binary);

	const proc = spawn(command, ['app-server'], {
		env: { ...process.env, CODEX_HOME: configDir },
		// stderr is captured rather than discarded: a launcher that cannot start
		// says why there and nowhere else, and discarding it turned an instant,
		// explainable failure into a silent thirty-second timeout.
		stdio: ['pipe', 'pipe', 'pipe'],
		...options,
	});

	const pending = new Map();
	const listeners = new Set();
	let buffer = '';
	let stderr = '';
	let exited = null;

	proc.stderr?.on('data', (chunk) => {
		stderr += chunk;
	});

	// A process that dies takes every outstanding call with it, immediately,
	// rather than leaving them to time out one by one.
	proc.on('exit', (code) => {
		exited = code;
		const reason = stderr.trim().split('\n')[0] || `exited with code ${code}`;
		for (const [id, settle] of pending) {
			settle({ id, error: { message: `Codex could not start: ${reason}` } });
		}
		pending.clear();
	});

	proc.on('error', (err) => {
		exited = -1;
		for (const [id, settle] of pending) settle({ id, error: { message: `Codex could not start: ${err.message}` } });
		pending.clear();
	});

	proc.stdout.on('data', (chunk) => {
		buffer += chunk;
		let nl;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id != null && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
			for (const fn of listeners) fn(msg);
		}
	});

	let nextId = 1;
	const call = (method, params = {}, timeoutMs = 30000) =>
		new Promise((resolve, reject) => {
			if (exited !== null) return reject(new Error(`Codex is not running: ${stderr.trim().split('\n')[0] || 'it exited'}`));

			const id = nextId++;
			pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
			try {
				proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
			} catch (err) {
				pending.delete(id);
				return reject(new Error(`Codex could not be reached: ${err.message}`));
			}
			setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), timeoutMs);
		});

	try {
		await call('initialize', { clientInfo: { name: 'aidash', title: 'AI usage', version: '0.1.0' } });
		proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
		return await body({ call, onMessage: (fn) => (listeners.add(fn), () => listeners.delete(fn)) });
	} finally {
		proc.kill();
	}
}

export async function isAuthenticated(configDir) {
	try {
		return await withSession(configDir, async ({ call }) => Boolean((await call('getAuthStatus', {}))?.authMethod));
	} catch {
		return false;
	}
}

/**
 * Starts the browser sign-in and resolves once the session is authenticated.
 *
 * `onUrl` receives the authorization URL so the caller can open it and show it
 * in the interface; the flow cannot be completed headlessly because the OAuth
 * client is registered against a localhost redirect.
 */
export async function login(configDir, { onUrl, signal } = {}) {
	return withSession(configDir, async ({ call, onMessage }) => {
		let authed = false;
		const stop = onMessage((msg) => {
			if (typeof msg.method === 'string' && msg.method.includes('login') && msg.params?.success) authed = true;
		});

		try {
			const { authUrl } = await call('account/login/start', { type: 'chatgpt' });
			onUrl?.(authUrl);

			for (let i = 0; i < 150 && !authed; i++) {
				if (signal?.aborted) throw new Error('cancelled');
				await new Promise((r) => setTimeout(r, 2000));
				try {
					if ((await call('getAuthStatus', {}))?.authMethod) authed = true;
				} catch {
					/* transient while the browser flow is in progress */
				}
			}
			if (!authed) throw new Error('sign-in was not completed');

			const result = await call('account/read', {});
			return { email: result?.account?.email ?? null, plan: result?.account?.planType ?? null };
		} finally {
			stop();
		}
	});
}

/**
 * Current usage. The nested objects are passed through untouched so a change on
 * the provider's side cannot invalidate what we store.
 */
export async function fetchUsage(configDir) {
	return withSession(configDir, async ({ call }) => {
		const [account, rateLimits, usage] = await Promise.all([
			call('account/read', {}),
			call('account/rateLimits/read', {}, 45000),
			call('account/usage/read', {}, 45000),
		]);

		if (!account?.account) throw new Error('not signed in — re-authorize this account');

		return { account: account.account, rateLimits: rateLimits?.rateLimits ?? null, usage: usage ?? null };
	});
}

/**
 * Clears this directory's credential, handing back the means to restore it.
 *
 * Signing in again has to start from nothing, and here that is not a nicety:
 * `login` above decides it is done as soon as `getAuthStatus` reports a method,
 * so against a directory that is still signed in it would return on the first
 * poll — two seconds, no browser, the same account back. The old file is kept
 * in hand until the new one lands, so an attempt the user abandons leaves the
 * account exactly as it was.
 */
export async function stashCredentials(configDir) {
	let saved = null;
	try {
		saved = await readFile(authFile(configDir), 'utf8');
	} catch {
		/* nothing stored for this directory */
	}
	await rm(authFile(configDir), { force: true });

	return async () => {
		if (saved !== null) await writeFile(authFile(configDir), saved, { mode: 0o600 });
	};
}

export const codex = { id: 'codex', name: 'Codex', findBinary, isAuthenticated, login, stashCredentials, fetchUsage };

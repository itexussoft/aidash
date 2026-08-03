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

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATE_PATHS = ['/Applications/ChatGPT.app/Contents/Resources/codex'];

export function findBinary() {
	const candidates = [...CANDIDATE_PATHS];
	try {
		candidates.push(execFileSync('which', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
	} catch {
		/* not on PATH */
	}
	return candidates.find((p) => p && existsSync(p)) ?? null;
}

/**
 * Opens an app-server session and hands it to `body`, always tearing the
 * process down afterwards.
 */
async function withSession(configDir, body) {
	const binary = findBinary();
	if (!binary) throw new Error('Codex is not installed on this machine');

	const proc = spawn(binary, ['app-server'], {
		env: { ...process.env, CODEX_HOME: configDir },
		stdio: ['pipe', 'pipe', 'ignore'],
	});

	const pending = new Map();
	const listeners = new Set();
	let buffer = '';

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
			const id = nextId++;
			pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
			proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
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

export const codex = { id: 'codex', name: 'Codex', findBinary, isAuthenticated, login, fetchUsage };

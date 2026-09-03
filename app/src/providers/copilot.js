/**
 * GitHub Copilot provider.
 *
 * Credentials belong to `gh`, the GitHub CLI, exactly as Codex's belong to the
 * Codex binary — and for the same reason. `gh` honours `GH_CONFIG_DIR`, so each
 * account signs in to its own directory and this app never holds a token; what
 * makes that worth insisting on here is that a GitHub token is not scoped to
 * Copilot. It is the whole account.
 *
 * Sign-in is GitHub's device flow, which runs the opposite way round to
 * Claude's: the app shows a one-time code and the browser asks for it, rather
 * than the browser showing one and the app asking. That is why this provider
 * reports its code through `onDeviceCode` instead of `onNeedCode`.
 *
 * Usage comes from `copilot_internal/user` — the endpoint the editors call, and
 * the only one that answers "how much is left" for an individual. Everything
 * documented reports spend after the fact instead: what it cost, never what
 * remains. Two things about it were measured rather than assumed:
 *
 *   - it needs no scopes at all, so an ordinary `gh` token reaches it;
 *   - its neighbour `v2/token` refuses the same token with a 403 citing the
 *     scraping terms, which is the line this app stays on the safe side of. We
 *     read our own entitlement and never touch the inference proxy.
 *
 * It caches for sixty seconds, and the app's own refresh interval is an hour,
 * so polite use costs nothing to guarantee.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { locate, spawnable } from '../locate.js';

const run = promisify(execFile);

const USER_URL = 'https://api.github.com/copilot_internal/user';
const API_VERSION = '2025-04-01';

export function findBinary() {
	return locate('gh');
}

/** Each account's own `gh` configuration, which is what keeps them apart. */
const ghEnv = (configDir) => ({ ...process.env, GH_CONFIG_DIR: configDir });

async function gh(configDir, args, timeout = 30000) {
	const binary = findBinary();
	if (!binary) throw new Error('the GitHub CLI (gh) is not installed on this machine');

	const { command, options } = spawnable(binary);
	const { stdout } = await run(command, args, { env: ghEnv(configDir), timeout, ...options });
	return stdout;
}

export async function isAuthenticated(configDir) {
	try {
		await gh(configDir, ['auth', 'status', '--hostname', 'github.com'], 15000);
		return true;
	} catch {
		return false;
	}
}

/**
 * Runs the device-flow sign-in.
 *
 * Unlike Claude and Codex, nothing is cleared first. Those two see a credential
 * already in the directory and decide there is nothing to do, so signing in
 * again against them needs the old one taken away; `gh` was measured doing the
 * opposite — against an already-signed-in directory it goes straight to a fresh
 * one-time code. That also makes cancelling free without arranging anything: the
 * old login is still there, untouched, until a new one replaces it.
 *
 * `onDeviceCode` receives the code and the page to type it into. The CLI waits
 * on a keypress before opening a browser itself, which is answered here rather
 * than shown to the user: the app has already handed them both halves, and a
 * prompt about a browser that has not opened would only be confusing.
 */
export async function login(configDir, { onDeviceCode, signal } = {}) {
	const binary = findBinary();
	if (!binary) throw new Error('the GitHub CLI (gh) is not installed on this machine');

	const { command, options } = spawnable(binary);

	await new Promise((resolve, reject) => {
		const proc = spawn(command, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], {
			env: ghEnv(configDir),
			stdio: ['pipe', 'pipe', 'pipe'],
			...options,
		});

		let seen = '';
		let announced = false;

		const abort = () => {
			proc.kill('SIGKILL');
			reject(new Error('cancelled'));
		};
		signal?.addEventListener('abort', abort, { once: true });

		// The CLI prints its prompts on stderr and its progress on stdout, and
		// which half carries the code has moved between releases, so both are read.
		const consume = (chunk) => {
			seen += chunk;
			const plain = seen.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
			if (announced) return;

			const code = plain.match(/one-time code:\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1];
			if (!code) return;

			announced = true;
			const url = plain.match(/https:\/\/\S*login\/device\S*/)?.[0] ?? 'https://github.com/login/device';
			onDeviceCode?.({ code, url });
			// Answers the "press Enter to open your browser" prompt for them.
			try {
				proc.stdin.write('\n');
			} catch {
				/* the CLI closed it already, which only means it did not ask */
			}
		};

		proc.stdout.on('data', consume);
		proc.stderr.on('data', consume);

		proc.on('error', reject);
		proc.on('exit', (code) => {
			signal?.removeEventListener('abort', abort);
			if (code === 0) return resolve();

			// A non-interactive shell is the one failure worth naming precisely,
			// because the way out of it is a command rather than a retry.
			const why = announced
				? 'the sign-in was not completed in the browser'
				: `the GitHub CLI could not start its sign-in — run "GH_CONFIG_DIR=${configDir} gh auth login" in a terminal once, then add the account again`;
			reject(new Error(why));
		});
	});

	let identity = {};
	try {
		identity = JSON.parse(await gh(configDir, ['api', 'user', '--jq', '{login: .login, email: .email}'], 20000));
	} catch {
		/* the account is signed in; only its display name is unknown */
	}

	const usage = await fetchUsage(configDir).catch(() => null);
	return { email: identity.email ?? identity.login ?? usage?.login ?? null, plan: usage?.copilot_plan ?? null };
}

/**
 * The entitlement snapshot, over whichever transport answers.
 *
 * Two, and the second is not decoration: `gh api` is the one that keeps this app
 * out of the credential business entirely, but it is also a moving CLI with its
 * own opinions about output. Reading the token and making the request here is
 * the fallback for the day one of those opinions changes, and it fails for
 * different reasons than the first — which is the only property that makes a
 * fallback worth having.
 */
export async function fetchUsage(configDir) {
	const attempts = [];

	try {
		const raw = await gh(configDir, ['api', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '/copilot_internal/user'], 30000);
		return { ...JSON.parse(raw), _via: 'gh api' };
	} catch (err) {
		attempts.push(`gh api: ${short(err)}`);
	}

	try {
		const token = (await gh(configDir, ['auth', 'token'], 15000)).trim();
		if (!token) throw new Error('no token stored for this account');

		const res = await fetch(USER_URL, {
			headers: { authorization: `token ${token}`, 'x-github-api-version': API_VERSION, accept: 'application/json' },
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
		return { ...JSON.parse(text), _via: 'direct' };
	} catch (err) {
		attempts.push(`direct: ${short(err)}`);
	}

	throw new Error(`could not read Copilot usage — ${attempts.join('; ')}`);
}

const short = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 160);

export const copilot = { id: 'copilot', name: 'Copilot', findBinary, isAuthenticated, login, fetchUsage };

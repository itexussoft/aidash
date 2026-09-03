/**
 * Cursor provider.
 *
 * Cursor signs in one account at a time, which would have capped this app at
 * one Cursor account if the account lived in the application. It does not: it
 * lives in the user data directory, and Cursor is an Electron app that takes
 * `--user-data-dir` like every other. So each account gets its own profile and
 * its own signed-in copy, the same trick this app already plays on Claude
 * Desktop and for the same measured reasons — the single-instance lock sits
 * inside that directory, and a fresh one starts signed out rather than
 * inheriting the first account.
 *
 * The copy is only needed to sign in. Afterwards the token sits in the
 * profile's own database and is read from there, so watching six accounts does
 * not mean running six editors.
 *
 * Nothing here writes to Cursor's storage. The database is copied before it is
 * read — with its write-ahead log, or the copy would be missing the newest
 * rows — because the alternative is opening a file another process is writing,
 * in a directory where a stray journal file is the app's problem and not ours.
 * A refreshed token is kept in memory for the run rather than written back for
 * the same reason: a corrupted profile would cost the user their sign-in, and
 * an hourly refresh is cheap.
 *
 * Everything past the token is undocumented. These are the calls Cursor's own
 * dashboard makes, and its shape has followed its pricing through three changes
 * in 2026, so there are three transports here and every field is read through
 * shapes.js, which returns nothing rather than zero when it stops recognising
 * an answer.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { locate, spawnable } from '../locate.js';

const AUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const RPC_BASE = 'https://api2.cursor.sh/aiserver.v1.DashboardService';
const TOKEN_URL = 'https://api2.cursor.sh/oauth/token';
const WEB = 'https://cursor.com';

// Cursor's dashboard rejects a request that does not look like a browser, so
// these travel with every call to it. They are not a disguise: this app is
// reading the same account's own dashboard data, through the same door.
const BROWSER_HEADERS = {
	origin: WEB,
	referer: `${WEB}/dashboard`,
	'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
	accept: 'application/json',
};

const exists = (p) => access(p).then(() => true, () => false);

export function findBinary() {
	return locate('cursor');
}

/** Where a profile keeps the database holding its sign-in. */
export const dbIn = (profile) => join(profile, 'User', 'globalStorage', 'state.vscdb');

/* ------------------------------------------------------------ reading it */

/**
 * The rows we care about, read from a copy.
 *
 * Two readers, because the first is the better one and the second is the one
 * that still works without it: `node:sqlite` is built in but flagged
 * experimental, and the `sqlite3` command is everywhere on macOS and Linux and
 * nowhere on Windows. Between them every platform this app ships to is covered.
 */
async function readAuthRows(profile) {
	const source = dbIn(profile);
	if (!(await exists(source))) throw new Error('this account has no Cursor profile yet — sign in to its copy of Cursor first');

	const scratch = await mkdtemp(join(tmpdir(), 'aidash-cursor-'));
	const copy = join(scratch, 'state.vscdb');

	try {
		await copyFile(source, copy);
		// Recent writes live in the write-ahead log until Cursor checkpoints it, so
		// a copy without it can be hours out of date — or miss the sign-in entirely.
		for (const suffix of ['-wal', '-shm']) {
			if (await exists(source + suffix)) await copyFile(source + suffix, copy + suffix);
		}

		const sql = "SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'";
		const rows = (await viaNodeSqlite(copy, sql)) ?? (await viaSqliteCli(copy, sql));
		if (!rows) throw new Error('no way to read the Cursor profile database on this machine');

		const out = {};
		for (const { key, value } of rows) out[key.replace('cursorAuth/', '')] = unquote(value);
		return out;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function viaNodeSqlite(path, sql) {
	try {
		const { DatabaseSync } = await import('node:sqlite');
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return db.prepare(sql).all();
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

async function viaSqliteCli(path, sql) {
	try {
		const { promisify } = await import('node:util');
		const { execFile } = await import('node:child_process');
		const { stdout } = await promisify(execFile)('sqlite3', ['-json', path, sql], { timeout: 15000, maxBuffer: 8 << 20 });
		return stdout.trim() ? JSON.parse(stdout) : [];
	} catch {
		return null;
	}
}

/** Values arrive bare or JSON-quoted depending on which Cursor wrote them. */
function unquote(value) {
	const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
	if (text.startsWith('"') && text.endsWith('"')) {
		try {
			return JSON.parse(text);
		} catch {
			/* not JSON after all */
		}
	}
	return text;
}

/** The account id Cursor puts in its own cookie, taken from the token itself. */
function readJwt(token) {
	try {
		const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
		return { userId: String(claims.sub ?? '').split('|').pop() || null, expiresAt: claims.exp ? claims.exp * 1000 : null };
	} catch {
		return { userId: null, expiresAt: null };
	}
}

/**
 * A token good for a call, refreshing it in memory when the stored one is spent.
 *
 * A profile that has not been opened for weeks holds an expired token, because
 * Cursor is what renews it and Cursor has not been running. Doing it here is
 * what keeps an account watchable without opening its editor.
 */
async function usableToken(profile) {
	const rows = await readAuthRows(profile);
	const stored = rows.accessToken;
	if (!stored) throw new Error('this Cursor profile is signed out — open its copy of Cursor and sign in again');

	const { userId, expiresAt } = readJwt(stored);
	if (!expiresAt || expiresAt - Date.now() > 60000) return { token: stored, userId };

	if (!rows.refreshToken) throw new Error('the stored Cursor sign-in has expired — open its copy of Cursor and sign in again');

	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ grant_type: 'refresh_token', client_id: AUTH_CLIENT_ID, refresh_token: rows.refreshToken }),
	});
	if (!res.ok) throw new Error('the stored Cursor sign-in has expired — open its copy of Cursor and sign in again');

	const json = await res.json();
	const token = json.access_token ?? json.accessToken;
	if (!token) throw new Error('the stored Cursor sign-in has expired — open its copy of Cursor and sign in again');
	return { token, userId: userId ?? readJwt(token).userId };
}

/* ---------------------------------------------------------------- signing in */

export async function isAuthenticated(profile) {
	try {
		return Boolean((await readAuthRows(profile)).accessToken);
	} catch {
		return false;
	}
}

/**
 * Opens this account's own copy of Cursor and waits for a sign-in to land.
 *
 * There is nothing to drive here: the sign-in is a browser flow inside another
 * application. What this does is start the right copy, tell the interface to
 * say so, and watch the profile until the sign-in in it changes.
 *
 * Changes, not appears — and that distinction is the whole of signing in again.
 * A profile being re-authorized still holds the old token, so waiting for a
 * token to exist would find one on the first look: two seconds, no browser, the
 * same account back, and a button that silently did nothing. Waiting for a
 * different one instead makes the same code serve both cases, with no state to
 * carry between them.
 *
 * The other providers clear the old credential first so their client stops
 * short-circuiting. That is not done here, because Cursor's credential lives in
 * a database its own process may have open, and clearing it would mean writing
 * into an application's storage from underneath it to save the user one click
 * inside a window that is about to open anyway. So the sign-out stays theirs to
 * make, and the interface says so. It costs a sentence and leaves cancelling
 * genuinely free: nothing was touched, so there is nothing to put back.
 */
/**
 * Whether what is in the profile now counts as the sign-in we were waiting for.
 *
 * Separated from the loop that calls it because the loop cannot be tested
 * without launching an editor, and this is the part worth protecting: the day
 * someone simplifies it to "is there a token", signing in again quietly stops
 * working and nothing fails.
 */
export const signedInAfresh = (before, token) => Boolean(token) && token !== before;

export async function login(profile, { onExternal, signal } = {}) {
	const binary = findBinary();
	if (!binary) throw new Error('Cursor is not installed on this machine');

	// Read before launching: once Cursor is running this is a moving target.
	const before = (await readAuthRows(profile).catch(() => null))?.accessToken ?? null;

	const { command, options } = spawnable(binary);
	const child = spawn(command, ['--user-data-dir', profile, '--new-window'], { detached: true, stdio: 'ignore', ...options });
	child.unref();

	onExternal?.({
		note: before
			? 'A separate copy of Cursor is opening for this account. Sign out in there, then sign in as the account you want — this window is waiting for the change.'
			: 'A separate copy of Cursor is opening for this account. Sign in there, then come back — this window is waiting.',
	});

	// Five minutes, which is a browser sign-in with a password manager and a
	// second factor in it, and still short enough that a forgotten dialog ends.
	for (let i = 0; i < 150; i++) {
		if (signal?.aborted) throw new Error('cancelled');
		await new Promise((r) => setTimeout(r, 2000));

		const rows = await readAuthRows(profile).catch(() => null);
		if (!signedInAfresh(before, rows?.accessToken)) continue;

		return { email: rows.cachedEmail || null, plan: rows.stripeMembershipType || null };
	}

	throw new Error(before ? 'the sign-in in that copy of Cursor did not change' : 'no sign-in arrived in that copy of Cursor');
}

/* ------------------------------------------------------------------- usage */

/**
 * Current usage, over whichever of three transports answers first.
 *
 * They are ordered by how much they are trusted rather than by convenience. The
 * first is a plain bearer call and the least like impersonation; the second is
 * the dashboard's own fetch and the one every comparable project uses; the third
 * only still exists for accounts left on the pre-2026 request-counting plans,
 * and answers in a shape nothing else does.
 *
 * Each is tried in turn and the winner is recorded on the payload, so a card can
 * say which door opened — and a support question about a wrong number starts
 * from a fact instead of a guess.
 */
export async function fetchUsage(profile) {
	const { token, userId } = await usableToken(profile);
	const cookie = userId ? `WorkosCursorSessionToken=${userId}%3A%3A${token}` : null;
	const attempts = [];

	const transports = [
		{
			via: 'rpc',
			run: async () => {
				const res = await fetch(`${RPC_BASE}/GetCurrentPeriodUsage`, {
					method: 'POST',
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'connect-protocol-version': '1', accept: 'application/json' },
					body: '{}',
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			},
		},
		{
			via: 'dashboard',
			run: async () => {
				if (!cookie) throw new Error('no account id in the token');
				const res = await fetch(`${WEB}/api/usage-summary`, { headers: { ...BROWSER_HEADERS, cookie } });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			},
		},
		{
			via: 'legacy',
			run: async () => {
				if (!cookie) throw new Error('no account id in the token');
				const res = await fetch(`${WEB}/api/usage?user=${encodeURIComponent(userId)}`, { headers: { ...BROWSER_HEADERS, cookie } });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			},
		},
	];

	for (const transport of transports) {
		try {
			const payload = await transport.run();
			if (payload && typeof payload === 'object') return { ...payload, _via: transport.via };
		} catch (err) {
			attempts.push(`${transport.via}: ${String(err?.message ?? err).slice(0, 80)}`);
		}
	}

	throw new Error(`could not read Cursor usage — ${attempts.join('; ')}`);
}

export const cursor = { id: 'cursor', name: 'Cursor', findBinary, isAuthenticated, login, fetchUsage };

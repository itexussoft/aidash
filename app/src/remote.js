/**
 * What the server says each account's Remote Control sessions are.
 *
 * This answers one question and deliberately not the one next to it. It can
 * list the remote sessions an account actually has; it cannot say which account
 * a local `bridgeSessionIds` value belongs to. Measured, not assumed:
 *
 *   /v1/code/sessions              answers, and returns `cse_…` ids
 *   the index stores               `session_…` ids
 *   overlap between the two        none, across all 21 links on the machine
 *                                  this was written against
 *   /v1/session_ingress/session/…  404 even for the asking account's own link
 *
 * So nothing here feeds the badge in bridges.js. The badge stays on local
 * evidence, which is exact; this is a separate view of the other side, and it
 * is allowed to be absent, stale or wrong without anything else noticing.
 *
 * Which is why every failure here is a returned value rather than a thrown
 * error. The endpoint is undocumented: it may change shape, require a header it
 * does not today, or stop answering. When it does, the panel says so and the
 * rest of the app does not learn about it.
 */

import { accessToken } from './providers/claude.js';

const URL = 'https://api.anthropic.com/v1/code/sessions?limit=100';

// Both are required, and each is required by a different part of the stack: the
// beta header for the OAuth credential, the version header by the endpoint
// itself, which answers 400 without it.
const HEADERS = {
	accept: 'application/json',
	'anthropic-beta': 'oauth-2025-04-20',
	'anthropic-version': '2023-06-01',
};

const REQUEST_TIMEOUT_MS = 15000;

/** The fields worth showing, taken defensively — any of them may be absent. */
function describe(session) {
	return {
		id: typeof session?.id === 'string' ? session.id : null,
		title: typeof session?.title === 'string' && session.title.trim() ? session.title.trim() : '(untitled)',
		status: typeof session?.status === 'string' ? session.status : null,
		connection: typeof session?.connection_status === 'string' ? session.connection_status : null,
		model: typeof session?.config?.model === 'string' ? session.config.model : null,
		lastAt: Date.parse(session?.last_event_at ?? session?.created_at ?? '') || null,
	};
}

/**
 * Reads one account's remote sessions.
 *
 * Never throws: an account that cannot be read comes back saying why, so one
 * revoked credential does not blank the panel for the others.
 */
export async function remoteSessionsFor({ dir, label }) {
	try {
		const token = await accessToken(dir);
		const res = await fetch(URL, {
			headers: { ...HEADERS, authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		const text = await res.text();
		if (!res.ok) return { label, ok: false, reason: `HTTP ${res.status}${res.status === 404 ? ' — not available for this account' : ''}` };

		const body = JSON.parse(text);
		const data = Array.isArray(body?.data) ? body.data : null;
		// A shape we do not recognise is reported as such rather than rendered as
		// an empty list, which would read as "no remote sessions".
		if (!data) return { label, ok: false, reason: 'the server answered in a shape this version does not recognise' };

		const bridge = data.filter((s) => s?.environment_kind === 'bridge').map(describe);
		bridge.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));

		return {
			label,
			ok: true,
			sessions: bridge,
			connected: bridge.filter((s) => s.connection === 'connected').length,
			// Sessions of other kinds are counted but not listed: they are cloud
			// sessions, not Remote Control, and mixing them would answer a question
			// nobody asked.
			others: data.length - bridge.length,
			truncated: Boolean(body?.resume_token) && data.length >= 100,
		};
	} catch (err) {
		const reason = err?.name === 'TimeoutError' ? 'the server did not answer in time' : String(err?.message ?? err).slice(0, 160);
		return { label, ok: false, reason };
	}
}

/** Every account, in parallel, and never rejecting. */
export async function remoteSessions(targets) {
	const settled = await Promise.allSettled((targets ?? []).map((t) => remoteSessionsFor(t)));
	return settled.map((r, i) =>
		r.status === 'fulfilled' ? r.value : { label: targets[i]?.label ?? 'account', ok: false, reason: 'could not be read' },
	);
}

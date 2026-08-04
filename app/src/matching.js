/**
 * Attributing a Remote Control link to an account by matching titles.
 *
 * The server lists an account's remote sessions but uses `cse_…` ids, while the
 * index stores `session_…` ids, and the two do not correspond. What both sides
 * do carry is a title and a time, so a session can sometimes be recognised
 * across the gap. Sometimes — and the whole value of this file is in refusing
 * the rest.
 *
 * Measured against 21 links on the machine this was written for: 10 of the 19
 * single-link entries matched a title uniquely, with the time agreeing every
 * time. Eight of those ten matched a list that *two* config directories return
 * identically, so which account they belong to is exactly as unknown as before.
 * Recording them anyway would have written eight wrong owners and struck through
 * eight badges that were probably right.
 *
 * Hence four conditions, and a match is refused unless all hold:
 *
 *   one link      an entry carrying several links says nothing about which of
 *                 them the matched session is.
 *   one title     the title must appear once locally and once on the server.
 *   time agrees   the remote session's last activity must fall inside the local
 *                 session's life, give or take a day.
 *   one account   the matched list must belong to exactly one account. Two
 *                 directories returning the same list is not evidence.
 */

/** How far outside a session's life its remote counterpart may still sit. */
const SLACK_MS = 24 * 3600 * 1000;

const norm = (title) => String(title ?? '').trim().toLowerCase();

/**
 * Collapses sources returning the same list.
 *
 * Two config directories that answer identically are one list, not two, and
 * treating them as two turns every match into a false ambiguity — which is the
 * mistake the first version of this measurement made.
 */
export function collapse(sources) {
	const byList = new Map();

	for (const source of sources ?? []) {
		if (!source?.ok) continue;
		const key = (source.sessions ?? [])
			.map((s) => s.id)
			.sort()
			.join(',');

		if (!byList.has(key)) byList.set(key, { sessions: source.sessions ?? [], accounts: new Set() });
		for (const account of source.accounts ?? []) byList.get(key).accounts.add(account);
	}

	return [...byList.values()].map((list) => ({ sessions: list.sessions, accounts: [...list.accounts] }));
}

/**
 * Works out which links can be attributed, and why the others cannot.
 *
 * Returns proposals rather than writing anything: the caller decides, and the
 * refusals are reported too, because "nothing matched" and "matched but not
 * attributable" are different answers and only one of them means try again.
 */
export function proposeOwners({ sessions, sources }) {
	const lists = collapse(sources);

	// A title appearing twice locally cannot be told apart on the server either.
	const localCount = new Map();
	for (const session of sessions ?? []) {
		const key = norm(session.title);
		if (key) localCount.set(key, (localCount.get(key) ?? 0) + 1);
	}

	const owners = [];
	const refused = { severalLinks: 0, noTitle: 0, notFound: 0, ambiguousTitle: 0, ambiguousAccount: 0, timeDisagrees: 0 };

	for (const session of sessions ?? []) {
		const links = session.bridges ?? [];
		if (links.length !== 1) {
			if (links.length) refused.severalLinks++;
			continue;
		}

		const key = norm(session.title);
		if (!key) {
			refused.noTitle++;
			continue;
		}
		if (localCount.get(key) > 1) {
			refused.ambiguousTitle++;
			continue;
		}

		const hits = [];
		for (const list of lists) for (const remote of list.sessions) if (norm(remote.title) === key) hits.push({ list, remote });

		if (!hits.length) {
			refused.notFound++;
			continue;
		}
		if (hits.length > 1) {
			refused.ambiguousTitle++;
			continue;
		}

		const { list, remote } = hits[0];
		const at = remote.lastAt ?? 0;
		if (!(at >= (session.createdAt ?? 0) - SLACK_MS && at <= (session.lastAt ?? 0) + SLACK_MS)) {
			refused.timeDisagrees++;
			continue;
		}

		// The condition that earns this file its length.
		if (list.accounts.length !== 1) {
			refused.ambiguousAccount++;
			continue;
		}

		owners.push({ bridge: links[0], account: list.accounts[0], title: session.title, cliSessionId: session.cliSessionId });
	}

	return { owners, refused };
}

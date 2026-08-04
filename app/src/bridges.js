/**
 * Which account a session's Remote Control link belongs to.
 *
 * The desktop app records the link as `bridgeSessionIds` on the index entry —
 * an accumulating list of server-side ids like `session_01LZVs…`. The id itself
 * is opaque: it names no account and no organisation. The only local fact tying
 * a link to an account is the folder the entry sits in.
 *
 * Which is exactly the fact a move rewrites. So after moving a session between
 * accounts the file is indistinguishable from one whose link the new account
 * minted itself — unless something remembers, and the only thing that can is
 * whatever did the moving. That is this journal: an entry's bridges and the
 * account they were under, written the first time we move it away.
 *
 * Three answers are possible, and the difference between them matters more than
 * the badge does:
 *
 *   here       bridged, and nothing suggests otherwise. The desktop app writes
 *              the ids into the entry of the account that minted them, so
 *              absent a move this is where they belong.
 *   elsewhere  we moved this entry out of the account that owns every id it
 *              carries. The link is listed there, not here.
 *   shared     the same session is listed under more than one account. Only one
 *              of them can have minted the link, and which one cannot be told
 *              from anything on disk.
 *
 * `shared` is not a weaker `here`. It is the one case where the honest answer is
 * that we do not know, and it happens without this app's involvement — two
 * sessions on the machine this was written against are in exactly that state.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const HERE = 'here';
export const ELSEWHERE = 'elsewhere';
export const SHARED = 'shared';

/**
 * What to say about a session's link, and on what grounds.
 *
 * `owners` is what matching against the server established, `origin` is what
 * the journal remembers moving, `duplicated` says the same conversation is
 * listed by more than one account. Returns the state and the evidence behind
 * it, because a badge resting on a title match and one resting on nothing at
 * all should not look identical to whoever hovers it.
 */
export function bridgeState({ bridges, accountId, owners, origin, duplicated }) {
	if (!bridges?.length) return { state: null, via: null };

	// Server-matched ownership comes first, including ahead of `duplicated`:
	// resolving which of two listings owns a link is the whole point of having
	// asked. Anything it settles, it settles.
	const known = bridges.map((id) => owners?.[id]?.account ?? null);
	if (known.some((account) => account === accountId)) return { state: HERE, via: 'matched' };
	if (known.length && known.every((account) => account && account !== accountId)) return { state: ELSEWHERE, via: 'matched' };

	if (duplicated) return { state: SHARED, via: null };

	// A move only makes the link foreign if every id predates it. Enabling Remote
	// Control again under the new account appends an id this account does own,
	// and one live link is enough to make the badge plainly true again.
	if (origin && origin.account !== accountId && bridges.every((id) => origin.ids.includes(id))) return { state: ELSEWHERE, via: 'moved' };

	return { state: HERE, via: null };
}

/** Remembers where a moved session's links were minted. */
export class BridgeJournal {
	constructor(userDataDir) {
		this.file = join(userDataDir, 'bridges.json');
		this.state = { version: 1, moved: {}, owners: {} };
	}

	async load() {
		try {
			const raw = JSON.parse(await readFile(this.file, 'utf8'));
			this.state = { version: 1, moved: raw.moved ?? {}, owners: raw.owners ?? {} };
		} catch {
			this.state = { version: 1, moved: {}, owners: {} };
		}
		return this.state;
	}

	/** What matching against the server established, keyed by link id. */
	owners() {
		return this.state.owners;
	}

	/**
	 * Records attributions worked out by matching.
	 *
	 * Kept apart from `moved` and stamped with how it was learned, because this
	 * knowledge is inferred rather than observed: it can be wrong in a way a
	 * remembered move cannot, and it has to be possible to throw away without
	 * taking the move history with it.
	 */
	async attribute(owners, at) {
		let changed = false;
		for (const { bridge, account } of owners ?? []) {
			if (!bridge || !account || this.state.owners[bridge]) continue;
			this.state.owners[bridge] = { account, via: 'title-match', at: at ?? Date.now() };
			changed = true;
		}
		if (changed) await this.save();
		return changed;
	}

	/** Throws away every inferred attribution, leaving observed moves alone. */
	async forgetAttributions() {
		this.state.owners = {};
		await this.save();
	}

	async save() {
		await mkdir(dirname(this.file), { recursive: true });
		await writeFile(this.file, JSON.stringify(this.state, null, 2));
	}

	originOf(cliSessionId) {
		return this.state.moved[cliSessionId] ?? null;
	}

	/**
	 * Records a move, keeping the *first* account seen.
	 *
	 * Moving A → B → C leaves the links under A, not B, so a later move must not
	 * overwrite where they actually came from. Moving back to the origin clears
	 * the record instead: the entry is home, and keeping a note saying otherwise
	 * would outlive its truth.
	 */
	async record({ cliSessionId, bridges, fromAccount, at }) {
		if (!cliSessionId || !bridges?.length) return;

		const known = this.state.moved[cliSessionId];
		if (known) return;

		this.state.moved[cliSessionId] = { account: fromAccount, ids: [...bridges], at: at ?? Date.now() };
		await this.save();
	}

	/** Drops the note once a session is back where its links were minted. */
	async settle(cliSessionId, accountId) {
		const known = this.state.moved[cliSessionId];
		if (!known || known.account !== accountId) return;
		delete this.state.moved[cliSessionId];
		await this.save();
	}
}

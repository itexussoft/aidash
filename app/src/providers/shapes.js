/**
 * Reading payloads whose shape is not promised to us.
 *
 * Claude and Codex are read through their vendors' own clients, so their
 * payloads change at the pace of a documented product. Copilot and Cursor are
 * not: both are answered by endpoints their own web and editor front-ends call,
 * with no version, no deprecation notice and no obligation to anyone outside.
 * Cursor's changed three times in 2026 alone, following its pricing; Copilot's
 * grew `credits_used` and `premium_models` when premium requests became credits.
 *
 * So every value read out of those two goes through here, and the module exists
 * to enforce one rule that is easy to state and easy to get wrong:
 *
 *   A field that cannot be read is missing. It is never zero.
 *
 * That is the whole point. A meter drawn at 0% does not say "unknown" — it says
 * "nothing used, full headroom", which is the most damaging thing this app could
 * claim wrongly, and it would claim it most confidently at the exact moment the
 * provider renamed the field. Nothing here ever substitutes a default for a
 * value it failed to find; it returns null and lets the caller say so out loud.
 *
 * The second job is spelling. Renames are the common breakage, not redesigns,
 * so each value is looked up under every spelling seen in the wild — the ones
 * the endpoints use now, the ones they used before, and the camelCase variants
 * their RPC transports return for the same data.
 */

/** Follows a dotted path, giving up quietly at the first thing that is not there. */
function at(source, path) {
	let here = source;
	for (const step of path.split('.')) {
		if (here == null || typeof here !== 'object') return undefined;
		here = here[step];
	}
	return here;
}

/**
 * The first path that holds something real.
 *
 * Null and undefined are both treated as absent, because these endpoints use
 * them interchangeably for "this account has no such thing".
 */
export function pick(source, paths) {
	for (const path of paths) {
		const value = at(source, path);
		if (value != null) return value;
	}
	return undefined;
}

/**
 * A number, or null.
 *
 * Strings are accepted because these payloads carry int64 as text and money as
 * decimal strings, and rejecting those would lose real readings. Everything
 * that does not parse — including the empty string, which `Number` would
 * happily call 0 — comes back null.
 */
export function number(source, paths) {
	const raw = pick(source, paths);
	if (raw == null || raw === '' || typeof raw === 'boolean') return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/**
 * A percentage of a limit that has been consumed.
 *
 * Both directions are read, because these providers disagree about which one to
 * report and one of them reports both: Copilot says how much is left, Cursor's
 * two pools say how much is gone, and the remaining side has to be flipped so
 * every meter in the app still means the same thing.
 */
export function usedPercent(source, { used = [], remaining = [] }) {
	const direct = number(source, used);
	if (direct != null) return direct;

	const left = number(source, remaining);
	return left == null ? null : 100 - left;
}

/**
 * A moment in time, or null.
 *
 * Three encodings appear across these payloads for the same instant — an ISO
 * string, epoch seconds, and epoch milliseconds as a decimal string — and which
 * one arrives depends on the transport rather than the provider, so the caller
 * cannot know in advance which to expect.
 *
 * Zero is rejected rather than read as 1970: Copilot sends `quota_reset_at: 0`
 * on every snapshot as a placeholder for "not this field, look at the date one",
 * and a countdown to 1970 would render as a reset fifty-six years overdue.
 */
export function when(source, paths) {
	const raw = pick(source, paths);
	if (raw == null || raw === '' || raw === 0) return null;

	if (typeof raw === 'string' && !/^\d+$/.test(raw)) {
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? null : parsed;
	}

	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return null;
	// Below ~1e12 is far too small to be milliseconds since 1970.
	return n < 1e12 ? n * 1000 : n;
}

/**
 * What a reader made of a payload, kept together so the card can say it.
 *
 * `windows` is what was understood and `note` is what was not. A reader that
 * finds nothing returns no windows and a note naming the fields it looked for,
 * rather than an empty success — the difference between "this account is idle"
 * and "we no longer understand this response" is the whole reason this exists.
 */
export function reading(windows, { source = null, note = null } = {}) {
	const real = windows.filter((w) => w && w.percent != null);
	return { windows: real, source, note: real.length ? note : (note ?? 'the response carried no reading we recognised') };
}

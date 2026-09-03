/**
 * The usage windows behind the cards, as data rather than markup.
 *
 * Cards stay rendered in each provider's own terms — that does not change, and
 * there is still no shared usage model. But three things ask the same question
 * across every account at once — the outlook above the cards, the menu bar item
 * and the reset notifications — and none of them can read it off rendered HTML.
 * So the two payload shapes are read once, here, and the cards render from the
 * result too rather than knowing the shapes a second time.
 *
 * This sits in src/ rather than renderer/ because the main process needs it as
 * much as the window does: the menu bar and the notification timers are its
 * work. Nothing here touches the DOM, Electron or the filesystem.
 *
 * A window carries `percent` as the provider sent it: null stays null, and
 * readings above 100 stay above 100 — a personal spend control has been seen at
 * 887%. Nothing is clamped on the way in; that is the renderer's business.
 */

import { pick, number, usedPercent, when } from './providers/shapes.js';

/** Accepts epoch seconds, epoch milliseconds, or an ISO 8601 string. */
export function toEpochMs(value) {
	if (value == null) return null;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return null;
	// Anything below ~1e12 is far too small to be milliseconds since 1970.
	return n < 1e12 ? n * 1000 : n;
}

/**
 * A percentage, or null for anything that is not one.
 *
 * Null and the empty string are rejected explicitly, and that is the entire
 * point of the function: `Number(null)` is 0, and 0 is a finite number, so the
 * obvious version of this turns "this field was not in the response" into "this
 * limit is untouched" — a full green bar drawn at the exact moment we stopped
 * understanding the payload. It was caught doing precisely that on a Copilot
 * snapshot whose fields had been renamed.
 */
const asPercent = (value) => {
	if (value == null || value === '' || typeof value === 'boolean') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

const window_ = (label, percent, resetAt, note, severity) => ({
	label,
	percent: asPercent(percent),
	resetAt: toEpochMs(resetAt),
	note: note ?? null,
	severity,
});

/**
 * Codex comes from `codex app-server`, which returns richer data than the HTTP
 * endpoint. The flat `/wham/usage` shape is still read so older snapshots keep
 * rendering.
 */
export function codexWindows(p) {
	const viaAppServer = Boolean(p?.rateLimits);
	const rl = viaAppServer ? p.rateLimits : p?.rate_limit;
	if (!rl) return [];

	const out = [];

	const primary = viaAppServer ? rl.primary : rl.primary_window;
	if (primary) {
		out.push(window_('Weekly window', viaAppServer ? primary.usedPercent : primary.used_percent, viaAppServer ? primary.resetsAt : primary.reset_at));
	}

	const secondary = viaAppServer ? rl.secondary : rl.secondary_window;
	if (secondary) {
		out.push(
			window_('Secondary window', viaAppServer ? secondary.usedPercent : secondary.used_percent, viaAppServer ? secondary.resetsAt : secondary.reset_at),
		);
	}

	// The distinction a single "usage" number would hide: the shared quota can
	// sit at 30% while the personal spend control is entirely consumed.
	const individual = viaAppServer ? rl.individualLimit : p?.spend_control?.individual_limit;
	const reached = viaAppServer ? rl.spendControlReached : p?.spend_control?.reached;
	if (individual) {
		out.push(
			window_(
				'Personal spend control',
				// Only `remainingPercent` is sent by the app server; the HTTP shape
				// reports the used side directly.
				viaAppServer ? (individual.usedPercent ?? 100 - (Number(individual.remainingPercent) || 0)) : individual.used_percent,
				viaAppServer ? individual.resetsAt : individual.reset_at,
				reached ? 'limit reached' : null,
			),
		);
	}

	return out;
}

const claudeLabel = (limit) => {
	const base = String(limit.kind ?? limit.group ?? 'limit').replace(/_/g, ' ');
	const scope = [limit.scope?.model?.display_name, limit.scope?.surface].filter(Boolean).join(' / ');
	return scope ? `${base} · ${scope}` : base;
};

/**
 * Claude reports a `limits` array — one entry per independent window, each with
 * its own percentage, reset time, severity and optional model scope. Any of
 * them can be exhausted alone, which is why there is no single "Claude usage"
 * number.
 *
 * Percentages arrive as whole numbers (1 means 1%) and reset times as ISO
 * strings. Older payloads carrying only the flat windows are still read below.
 */
export function claudeWindows(p) {
	if (Array.isArray(p?.limits) && p.limits.length) {
		return (
			p.limits
				.filter((limit) => limit?.percent != null)
				// Fullest first: what is about to stop you belongs at the top.
				.sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0))
				.map((limit) =>
					window_(
						claudeLabel(limit),
						limit.percent,
						limit.resets_at,
						limit.is_active ? null : 'inactive',
						// Prefer the provider's own severity over our thresholds.
						limit.severity && limit.severity !== 'normal' ? (limit.severity === 'warning' ? 'warn' : 'crit') : undefined,
					),
				)
		);
	}

	const out = [];
	for (const [key, value] of Object.entries(p ?? {})) {
		if (!value || typeof value !== 'object') continue;
		const percent = value.utilization ?? value.used_percent ?? value.usage_percent;
		if (percent == null) continue;
		out.push(window_(key.replace(/_/g, ' '), percent, value.resets_at ?? value.reset_at ?? null));
	}
	return out;
}


/**
 * Copilot reports what is left rather than what is spent, one snapshot per
 * thing it meters, and the snapshots are not interchangeable: a free account is
 * measured in chat turns and completions, a paid one in credits against a
 * monthly allowance. Both are read, because an account can carry a snapshot it
 * does not use and dropping the wrong one leaves the card blank.
 *
 * Two traps, both from the move to credits in June 2026 and both silent:
 *
 *   - `has_quota` is false on every snapshot under the new billing, so reading
 *     it as "no quota here" hides the entire account.
 *   - an entitlement of 0 means the plan does not include this at all, while -1
 *     means it is unlimited. Neither is a reading, and drawing either as a
 *     percentage invents one.
 */
export function copilotWindows(p) {
	const snapshots = p?.quota_snapshots;
	if (!snapshots || typeof snapshots !== 'object') return [];

	// One date for the lot: the allowance runs to the first of the month, and
	// each snapshot carries a placeholder zero where its own reset would go.
	const reset = when(p, ['quota_reset_date_utc', 'quota_reset_date', 'limited_user_reset_date']);

	const names = { premium_models: 'premium requests', premium_interactions: 'premium requests', chat: 'chat', completions: 'completions' };
	const out = [];

	for (const [key, snapshot] of Object.entries(snapshots)) {
		if (!snapshot || typeof snapshot !== 'object') continue;

		const entitlement = number(snapshot, ['entitlement', 'entitlementRequests']);
		const unlimited = snapshot.unlimited === true || entitlement === -1;
		// Not included on this plan. Said with no bar rather than an empty one.
		if (!unlimited && entitlement === 0) continue;
		if (unlimited) continue;

		const percent = usedPercent(snapshot, {
			used: ['percent_used'],
			remaining: ['percent_remaining', 'remainingPercentage'],
		});

		const left = number(snapshot, ['quota_remaining', 'remaining']);
		const note = left != null && entitlement ? `${Math.max(0, Math.round(left))} of ${Math.round(entitlement)} left` : null;

		if (percent == null) continue;
		out.push(window_(names[key] ?? key.replace(/_/g, ' '), percent, reset, note));
	}

	// Fullest first, matching every other provider: what is about to stop you
	// belongs at the top of the card.
	return out.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
}

/**
 * Cursor answers in three shapes and this reads all of them, because which one
 * arrives depends on which door opened rather than on the account.
 *
 * The two current ones name their fields identically and differ only in how
 * deeply they nest them, so both are looked for at every depth they have been
 * seen at. The third belongs to accounts still on the pre-2026 plans that
 * counted requests instead of spending tokens, and shares no field names at all.
 *
 * The pools are kept apart on purpose. One number for "Cursor usage" would
 * average away the case the user actually needs to see: the included models
 * barely touched while the pool that costs money is spent.
 */
export function cursorWindows(p) {
	if (!p || typeof p !== 'object') return [];

	const reset = when(p, ['billingCycleEnd', 'planUsage.billingCycleEnd', 'individualUsage.billingCycleEnd']);

	const pools = [
		{ label: 'included usage', paths: ['totalPercentUsed', 'planUsage.totalPercentUsed', 'individualUsage.plan.totalPercentUsed'] },
		{ label: 'Cursor models', paths: ['autoPercentUsed', 'planUsage.autoPercentUsed', 'individualUsage.plan.autoPercentUsed'] },
		{ label: 'other models', paths: ['apiPercentUsed', 'planUsage.apiPercentUsed', 'individualUsage.plan.apiPercentUsed'] },
	];

	const out = [];
	for (const pool of pools) {
		const percent = number(p, pool.paths);
		if (percent == null) continue;
		out.push(window_(pool.label, percent, reset));
	}

	if (out.length) return out;

	// The pre-2026 shape: a bag of models, each with a request count against a
	// ceiling. Recognised by that ceiling, since a model with none is a model on
	// an unlimited plan and has no percentage to draw.
	for (const [model, value] of Object.entries(p)) {
		if (!value || typeof value !== 'object') continue;
		const ceiling = number(value, ['maxRequestUsage']);
		const used = number(value, ['numRequests']);
		if (!ceiling || used == null) continue;
		out.push(window_(model, (used / ceiling) * 100, when(p, ['startOfMonth']) ? null : null, `${used} of ${ceiling} requests`));
	}

	return out;
}

const BY_PROVIDER = { codex: codexWindows, claude: claudeWindows, copilot: copilotWindows, cursor: cursorWindows };

export function windowsOf(account) {
	if (!account?.payload) return [];
	return BY_PROVIDER[account.provider]?.(account.payload) ?? [];
}

/**
 * The one reading that decides an account: its fullest window.
 *
 * Windows marked inactive are counted like any other, and that is deliberate.
 * Claude marks a window inactive when nothing is currently running against it —
 * the session window on this machine reads 5% and inactive — but the usage is
 * real and the moment you start work it applies. An answer that called an
 * account roomy because it skipped a 95% window would be worse than no answer.
 * The card still shows the flag; it just does not get a vote here.
 */
export function tightest(account) {
	const measured = windowsOf(account).filter((w) => w.percent != null);
	if (!measured.length) return null;
	return measured.reduce((worst, w) => (w.percent > worst.percent ? w : worst));
}

/**
 * Accounts ordered by how much room the fullest window leaves.
 *
 * This ranks headroom, not capacity. A Codex weekly window at 15% and a Claude
 * session window at 15% are not the same amount of work, and nothing here
 * pretends otherwise — the question it answers is "which account is furthest
 * from stopping", which is the one worth asking before starting.
 *
 * Anything that reported no readable window comes back separately rather than
 * sorting to the top as an empty best answer.
 */
export function rankByHeadroom(accounts) {
	const ranked = [];
	const unreadable = [];

	for (const account of accounts ?? []) {
		const worst = tightest(account);
		if (worst) ranked.push({ account, tightest: worst });
		else unreadable.push(account);
	}

	ranked.sort((a, b) => a.tightest.percent - b.tightest.percent || String(a.account.label).localeCompare(String(b.account.label)));
	return { ranked, unreadable };
}

/**
 * Every window with a reset still ahead of it, soonest first.
 *
 * A reset already in the past is dropped rather than drawn at the left edge: it
 * means the snapshot predates the rollover, so the percentage beside it is
 * describing a window that no longer exists.
 */
export function upcomingResets(accounts, now = Date.now()) {
	const out = [];
	for (const account of accounts ?? []) {
		for (const window of windowsOf(account)) {
			if (window.resetAt == null || window.resetAt <= now) continue;
			out.push({ account, window });
		}
	}
	return out.sort((a, b) => a.window.resetAt - b.window.resetAt);
}

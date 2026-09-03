/**
 * Card rendering.
 *
 * Each provider is rendered in its own terms. There is no shared usage model,
 * because the two do not measure the same thing: Codex reports one rolling
 * window plus a separate personal spend control, Claude reports several
 * independent windows that can each be exhausted on their own.
 *
 * What each provider's payload *contains* is read in windows.js, so the card
 * and the outlook above it work from one reading rather than two.
 *
 * Every card also carries the raw payload, so a field not yet rendered is still
 * visible rather than lost.
 */

import { codexWindows, claudeWindows, copilotWindows, cursorWindows, toEpochMs } from '../src/windows.js';
import { icon } from './icons.js';

export { toEpochMs };

export const escapeHtml = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function relativeTime(epochMs) {
	if (!epochMs) return '—';
	const delta = epochMs - Date.now();
	const abs = Math.abs(delta);
	const mins = Math.round(abs / 60000);
	const hours = Math.round(abs / 3600000);
	const days = Math.round(abs / 86400000);
	const span = mins < 60 ? `${mins}m` : hours < 48 ? `${hours}h` : `${days}d`;
	return delta >= 0 ? `in ${span}` : `${span} ago`;
}

/** Colour by headroom, not by provider — red always means "about to stop". */
function severity(percent) {
	if (percent >= 100) return 'crit';
	if (percent >= 80) return 'warn';
	return 'ok';
}

/**
 * The bar's colour, as a continuous scale rather than three buckets.
 *
 * Three colours put 20% and 70% in the same green, which throws away most of
 * what a bar is for. Hue slides from green through amber to red so a glance
 * along a column of bars ranks them without reading a single number.
 *
 * The stops are uneven on purpose: the interesting part of the range is the top
 * of it, so most of the hue travel happens after halfway.
 */
const HUE_STOPS = [
	[0, 145],
	[50, 110],
	[75, 45],
	[90, 22],
	[100, 4],
];

export function barColour(percent) {
	const pct = Math.max(0, Math.min(100, Number(percent) || 0));

	let hue = HUE_STOPS[HUE_STOPS.length - 1][1];
	for (let i = 0; i < HUE_STOPS.length - 1; i++) {
		const [from, hFrom] = HUE_STOPS[i];
		const [to, hTo] = HUE_STOPS[i + 1];
		if (pct <= to) {
			hue = hFrom + ((hTo - hFrom) * (pct - from)) / (to - from);
			break;
		}
	}

	// Saturation rises with the reading so a nearly-full bar is the loudest
	// thing on the card.
	const saturation = 55 + pct * 0.22;
	const lightness = 46 - pct * 0.04;
	return `hsl(${hue.toFixed(0)} ${saturation.toFixed(0)}% ${lightness.toFixed(0)}%)`;
}

function meter(label, percent, resetAt, note, severityOverride) {
	// The last line of defence against a bar that lies. A window with no reading
	// gets no bar at all: an empty track says "we do not know", where a bar at
	// zero would say "nothing used" to anyone glancing at the card.
	if (percent == null) {
		return `
    <div class="meter unread">
      <div class="meter-head">
        <span class="meter-label">${escapeHtml(label)}</span>
        <span class="meter-val">not read</span>
      </div>
      <div class="bar"><i data-pct="0"></i></div>
      <div class="meter-foot">${note ? `<span class="note">${escapeHtml(note)}</span>` : ''}</div>
    </div>`;
	}

	const raw = Number(percent) || 0;
	const pct = Math.max(0, Math.min(100, raw));
	// Values above 100 are real — a personal spend control read 887% — so show
	// the true number while capping the bar.
	const shown = raw > 100 ? `${Math.round(raw)}%` : `${pct.toFixed(0)}%`;
	const resetMs = toEpochMs(resetAt);
	// The width is carried as data and applied by applyBarWidths() below. An
	// inline style attribute would be dropped by the page's `style-src 'self'`
	// policy, leaving the fill at its default auto width — which reads as a
	// permanently full bar rather than as a broken one.
	return `
    <div class="meter ${severityOverride ?? severity(raw)}">
      <div class="meter-head">
        <span class="meter-label">${escapeHtml(label)}</span>
        <span class="meter-val" data-colour="${barColour(raw)}">${shown}</span>
      </div>
      <div class="bar"><i data-pct="${pct.toFixed(2)}" data-colour="${barColour(raw)}"></i></div>
      <div class="meter-foot">
        ${resetMs ? `resets ${escapeHtml(relativeTime(resetMs))}` : ''}
        ${note ? `<span class="note">${escapeHtml(note)}</span>` : ''}
      </div>
    </div>`;
}

const asMeters = (windows) => windows.map((w) => meter(w.label, w.percent, w.resetAt, w.note, w.severity)).join('');

/**
 * Codex comes from `codex app-server`, which returns richer data than the HTTP
 * endpoint — including the daily history. The flat `/wham/usage` shape is still
 * accepted so older snapshots keep rendering.
 */
function renderCodex(p) {
	const viaAppServer = Boolean(p?.rateLimits);
	const rl = viaAppServer ? p.rateLimits : p?.rate_limit;
	if (!rl) return { meters: '', facts: ['no rate limit data in payload'] };

	const meters = asMeters(codexWindows(p));

	const facts = [];
	const credits = viaAppServer ? rl.credits : p?.credits;
	if (credits) {
		facts.push(
			credits.unlimited
				? 'credits: unlimited'
				: (credits.hasCredits ?? credits.has_credits)
					? `credits: ${credits.balance ?? 'yes'}`
					: 'credits: none',
		);
	}

	const summary = p?.usage?.summary;
	if (summary) {
		if (summary.lifetimeTokens) facts.push(`lifetime: ${Number(summary.lifetimeTokens).toLocaleString('en-US')} tokens`);
		if (summary.currentStreakDays != null) facts.push(`streak: ${summary.currentStreakDays}d (best ${summary.longestStreakDays ?? '?'}d)`);
	}
	const buckets = p?.usage?.dailyUsageBuckets;
	if (Array.isArray(buckets) && buckets.length) {
		const last = buckets[buckets.length - 1];
		facts.push(`last active day: ${last.startDate} (${Number(last.tokens).toLocaleString('en-US')} tokens)`);
	}

	if (rl.limit_reached || rl.rateLimitReachedType) facts.push('rate limit reached');

	return { meters, facts };
}

/**
 * Claude's windows are read in windows.js; what is left here is everything
 * beside them — the spend figures and the extra-usage switch, which are not
 * windows and have no percentage of their own.
 */
function renderClaude(p) {
	const facts = [];
	const meters = asMeters(claudeWindows(p));

	const extra = p?.extra_usage;
	if (extra) {
		if (extra.spend_limit_reached) facts.push('extra usage: spend limit reached');
		else if (extra.is_enabled) facts.push(`extra usage: on${extra.utilization != null ? ` (${extra.utilization}%)` : ''}`);
		else facts.push('extra usage: off');
	}

	const spend = p?.spend;
	if (spend?.enabled && spend.used) {
		const amount = (Number(spend.used.amount_minor) || 0) / 10 ** (Number(spend.used.exponent) || 2);
		facts.push(`spend: ${amount.toFixed(2)} ${spend.used.currency ?? ''}`.trim());
	}

	if (!meters) facts.push('no usage windows recognised — see raw payload');

	return { meters, facts };
}


/**
 * Providers still being proved out.
 *
 * Both read endpoints their vendors publish no contract for, so a reading can
 * be wrong in a way the app cannot detect — and a number with no warning on it
 * is trusted exactly as much as one that has been checked for a year. The badge
 * is the difference, and it lives here because it is a statement about how much
 * to believe the card, which is the card's business.
 */
export const ALPHA_PROVIDERS = new Set(['copilot', 'cursor']);

/**
 * Copilot's card is mostly its windows; what is left is the part that has no
 * percentage — which plan is paying, and the two states where the meters alone
 * would mislead.
 */
function renderCopilot(p) {
	const meters = asMeters(copilotWindows(p));
	const facts = [];

	const plan = p?.copilot_plan ?? p?.access_type_sku;
	if (plan) facts.push(`plan: ${String(plan).replace(/_/g, ' ')}`);

	const credits = p?.quota_snapshots?.premium_models?.credits_used ?? p?.quota_snapshots?.premium_interactions?.credits_used;
	if (credits) facts.push(`credits used: ${credits}`);

	// A seat on a company plan draws from a pool the whole organisation shares,
	// so its "remaining" is the organisation's and not this account's. Said
	// plainly, because the bar above it looks personal and is not.
	if (/business|enterprise/i.test(String(p?.copilot_plan ?? ''))) {
		facts.push('company plan — the allowance shown is the organisation’s shared pool, not this seat’s');
	}

	const unlimited = Object.entries(p?.quota_snapshots ?? {})
		.filter(([, s]) => s?.unlimited === true || Number(s?.entitlement) === -1)
		.map(([key]) => key.replace(/_/g, ' '));
	if (unlimited.length) facts.push(`unlimited: ${unlimited.join(', ')}`);

	if (!meters) facts.push('no usage windows recognised — see raw payload');
	if (p?._via) facts.push(`read via ${p._via}`);

	return { meters, facts };
}

/**
 * Cursor's card names the door that answered, which no other provider needs to.
 * Three transports can serve this payload and they do not all carry the same
 * fields, so "which one was it" is the first question worth asking when a number
 * looks wrong.
 */
function renderCursor(p) {
	const meters = asMeters(cursorWindows(p));
	const facts = [];

	const plan = p?.membershipType ?? p?.individualUsage?.membershipType;
	if (plan) facts.push(`plan: ${plan}`);

	// Money is carried in cents by the dashboard and left out entirely by some
	// tiers, so it is shown when it is real and skipped without comment when not.
	const used = Number(p?.individualUsage?.plan?.used ?? p?.planUsage?.used);
	const limit = Number(p?.individualUsage?.plan?.limit ?? p?.planUsage?.limit);
	if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
		facts.push(`spent: $${(used / 100).toFixed(2)} of $${(limit / 100).toFixed(2)}`);
	}

	if (!meters) facts.push('no usage windows recognised — see raw payload');
	if (p?._via) facts.push(`read via ${p._via}`);

	return { meters, facts };
}

const RENDERERS = { codex: renderCodex, claude: renderClaude, copilot: renderCopilot, cursor: renderCursor };

export function renderCard(account, availability = {}) {
	const { id, provider, label, email, plan, payload, lastOkAt, lastError } = account;
	// Only where there is a desktop app to open a second copy of. Codex has no
	// equivalent — its sessions are one pile shared by every account, so a second
	// profile would separate nothing.
	const instance =
		provider === 'claude' && availability.claudeDesktop
			? `<button class="instance" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}"
           title="Opens a second copy of Claude Desktop signed in as this account, running beside your main one. It keeps its own list of sessions; settings and transcripts stay shared.">${icon('copy')}<span>separate instance</span></button>`
			: '';
	const actions =
		instance +
		`<button class="reauth${lastError ? ' urgent' : ''}" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}" data-provider="${escapeHtml(provider)}"
           title="Signs in to this account again through ${escapeHtml(provider === 'claude' ? 'Claude Code' : 'Codex')}, replacing the stored login. The name, the session history and any separate instance stay as they are.">${icon('key')}<span>sign in again</span></button>` +
		`<button class="rename" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}">${icon('pencil')}<span>rename</span></button>` +
		`<button class="remove" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}">${icon('trash')}<span>remove</span></button>`;
	const identity = [email ?? payload?.email ?? payload?.account?.email, plan ?? payload?.plan_type ?? payload?.account?.planType]
		.filter(Boolean)
		.join(' · ');

	const header = `
    <header>
      <div>
        <h2>${escapeHtml(label)}</h2>
        ${identity ? `<p class="ident">${escapeHtml(identity)}</p>` : ''}
      </div>
      <span class="tag ${escapeHtml(provider)}">${escapeHtml(provider)}</span>
      ${ALPHA_PROVIDERS.has(provider) ? '<span class="alpha" title="This provider reads an endpoint its vendor publishes no contract for. The numbers are believed correct but are still being proved out — check them against the vendor before relying on them.">alpha</span>' : ''}
    </header>`;

	if (lastError && !payload) {
		return `<article class="card err">${header}
      <p class="error">${escapeHtml(lastError)}</p>
      <p class="muted">Sign in again to replace the stored login — nothing else about the account changes.</p>
      <footer><span>never reported</span><span class="foot-actions">${actions}</span></footer>
    </article>`;
	}

	// Added but not yet refreshed. Without this the card would show an
	// unexplained blank, which reads as breakage rather than as "not yet".
	if (!payload) {
		return `<article class="card">${header}
      <p class="muted">Waiting for the first refresh.</p>
      <footer><span>no data yet</span><span class="foot-actions">${actions}</span></footer>
    </article>`;
	}

	const { meters, facts } = RENDERERS[provider]?.(payload) ?? { meters: '', facts: ['unknown provider'] };

	return `<article class="card">${header}
    ${meters || '<p class="muted">No usage windows reported.</p>'}
    ${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}
    ${lastError ? `<p class="error">${escapeHtml(lastError)}</p>` : ''}
    <footer>
      <span>updated ${escapeHtml(relativeTime(lastOkAt))}</span>
      <span class="foot-actions">
        <details><summary>raw</summary><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details>
        ${actions}
      </span>
    </footer>
  </article>`;
}

/**
 * Applies the widths the markup carries as data.
 *
 * Setting `.style` from script is not what `style-src` restricts — only inline
 * style attributes and <style> blocks are — so the policy stays strict.
 * Call after inserting any markup containing meters.
 */
export function applyBarWidths(root = document) {
	for (const fill of root.querySelectorAll('.bar i[data-pct]')) {
		fill.style.width = `${fill.dataset.pct}%`;
		fill.style.background = fill.dataset.colour;
	}
	for (const value of root.querySelectorAll('.meter-val[data-colour]')) {
		value.style.color = value.dataset.colour;
	}
}

/**
 * How much a reading has aged, on the same three steps the meters use.
 *
 * The point is not the number of minutes but what it costs to trust it: past
 * twenty, a session window can have moved without the screen knowing; past
 * forty, one can have opened and closed again.
 */
export function staleness(lastRefreshAt) {
	if (!lastRefreshAt) return 'crit';
	const mins = (Date.now() - lastRefreshAt) / 60000;
	return mins > 40 ? 'crit' : mins > 20 ? 'warn' : 'ok';
}

/** "3 min ago", plus wall-clock so a glance separates stale from broken. */
export function refreshLabel(lastRefreshAt) {
	if (!lastRefreshAt) return 'never refreshed';
	const mins = Math.floor((Date.now() - lastRefreshAt) / 60000);
	const clock = new Date(lastRefreshAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const rel = mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : `${mins} min ago`;
	return `updated ${rel} · ${clock}`;
}

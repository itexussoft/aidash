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

import { codexWindows, claudeWindows, toEpochMs } from '../src/windows.js';

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

const RENDERERS = { codex: renderCodex, claude: renderClaude };

export function renderCard(account) {
	const { id, provider, label, email, plan, payload, lastOkAt, lastError } = account;
	const actions =
		`<button class="rename" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}">rename</button>` +
		`<button class="remove" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}">remove</button>`;
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
    </header>`;

	if (lastError && !payload) {
		return `<article class="card err">${header}
      <p class="error">${escapeHtml(lastError)}</p>
      <p class="muted">Remove it and add it again to sign in afresh.</p>
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

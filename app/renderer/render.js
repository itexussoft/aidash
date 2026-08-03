/**
 * Card rendering.
 *
 * Each provider is rendered in its own terms. There is no shared usage model,
 * because the two do not measure the same thing: Codex reports one rolling
 * window plus a separate personal spend control, Claude reports several
 * independent windows that can each be exhausted on their own.
 *
 * Every card also carries the raw payload, so a field not yet rendered is still
 * visible rather than lost.
 */

export const escapeHtml = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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

function meter(label, percent, resetAt, note, severityOverride) {
	const raw = Number(percent) || 0;
	const pct = Math.max(0, Math.min(100, raw));
	// Values above 100 are real — a personal spend control read 887% — so show
	// the true number while capping the bar.
	const shown = raw > 100 ? `${Math.round(raw)}%` : `${pct.toFixed(0)}%`;
	const resetMs = toEpochMs(resetAt);
	return `
    <div class="meter ${severityOverride ?? severity(raw)}">
      <div class="meter-head">
        <span class="meter-label">${escapeHtml(label)}</span>
        <span class="meter-val">${shown}</span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="meter-foot">
        ${resetMs ? `resets ${escapeHtml(relativeTime(resetMs))}` : ''}
        ${note ? `<span class="note">${escapeHtml(note)}</span>` : ''}
      </div>
    </div>`;
}

/**
 * Codex comes from `codex app-server`, which returns richer data than the HTTP
 * endpoint — including the daily history. The flat `/wham/usage` shape is still
 * accepted so older snapshots keep rendering.
 */
function renderCodex(p) {
	const viaAppServer = Boolean(p?.rateLimits);
	const rl = viaAppServer ? p.rateLimits : p?.rate_limit;
	if (!rl) return { meters: '', facts: ['no rate limit data in payload'] };

	const parts = [];
	const primary = viaAppServer ? rl.primary : rl.primary_window;
	if (primary) {
		parts.push(
			meter('Weekly window', viaAppServer ? primary.usedPercent : primary.used_percent, viaAppServer ? primary.resetsAt : primary.reset_at),
		);
	}

	const secondary = viaAppServer ? rl.secondary : rl.secondary_window;
	if (secondary) {
		parts.push(
			meter(
				'Secondary window',
				viaAppServer ? secondary.usedPercent : secondary.used_percent,
				viaAppServer ? secondary.resetsAt : secondary.reset_at,
			),
		);
	}

	// The distinction a single "usage" number would hide: the shared quota can
	// sit at 30% while the personal spend control is entirely consumed.
	const individual = viaAppServer ? rl.individualLimit : p?.spend_control?.individual_limit;
	const reached = viaAppServer ? rl.spendControlReached : p?.spend_control?.reached;
	if (individual) {
		parts.push(
			meter(
				'Personal spend control',
				viaAppServer ? (individual.usedPercent ?? 100 - (Number(individual.remainingPercent) || 0)) : individual.used_percent,
				viaAppServer ? individual.resetsAt : individual.reset_at,
				reached ? 'limit reached' : null,
			),
		);
	}

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

	return { meters: parts.join(''), facts };
}

function claudeLimitLabel(limit) {
	const base = String(limit.kind ?? limit.group ?? 'limit').replace(/_/g, ' ');
	const scope = [limit.scope?.model?.display_name, limit.scope?.surface].filter(Boolean).join(' / ');
	return scope ? `${base} · ${scope}` : base;
}

/**
 * Claude reports a `limits` array — one entry per independent window, each with
 * its own percentage, reset time, severity and optional model scope. Any of
 * them can be exhausted alone, which is why there is no single "Claude usage"
 * number.
 *
 * Percentages arrive as whole numbers (1 means 1%) and reset times as ISO
 * strings. Older payloads carrying only the flat windows still render below.
 */
function renderClaude(p) {
	const parts = [];
	const facts = [];

	if (Array.isArray(p?.limits) && p.limits.length) {
		// Fullest first: what is about to stop you belongs at the top.
		const sorted = [...p.limits].sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0));
		for (const limit of sorted) {
			if (limit?.percent == null) continue;
			// Prefer the provider's own severity over our thresholds.
			const sev = limit.severity && limit.severity !== 'normal' ? (limit.severity === 'warning' ? 'warn' : 'crit') : undefined;
			parts.push(meter(claudeLimitLabel(limit), limit.percent, limit.resets_at, limit.is_active ? null : 'inactive', sev));
		}
	} else {
		for (const [key, value] of Object.entries(p ?? {})) {
			if (!value || typeof value !== 'object') continue;
			const percent = value.utilization ?? value.used_percent ?? value.usage_percent;
			if (percent == null) continue;
			parts.push(meter(key.replace(/_/g, ' '), percent, value.resets_at ?? value.reset_at ?? null));
		}
	}

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

	if (parts.length === 0) facts.push('no usage windows recognised — see raw payload');

	return { meters: parts.join(''), facts };
}

const RENDERERS = { codex: renderCodex, claude: renderClaude };

export function renderCard(account) {
	const { id, provider, label, email, plan, payload, lastOkAt, lastError } = account;
	const remove = `<button class="remove" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}">remove</button>`;
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
      <footer><span>never reported</span>${remove}</footer>
    </article>`;
	}

	// Added but not yet refreshed. Without this the card would show an
	// unexplained blank, which reads as breakage rather than as "not yet".
	if (!payload) {
		return `<article class="card">${header}
      <p class="muted">Waiting for the first refresh.</p>
      <footer><span>no data yet</span>${remove}</footer>
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
        ${remove}
      </span>
    </footer>
  </article>`;
}

/** "3 min ago", plus wall-clock so a glance separates stale from broken. */
export function refreshLabel(lastRefreshAt) {
	if (!lastRefreshAt) return 'never refreshed';
	const mins = Math.floor((Date.now() - lastRefreshAt) / 60000);
	const clock = new Date(lastRefreshAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const rel = mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : `${mins} min ago`;
	return `updated ${rel} · ${clock}`;
}

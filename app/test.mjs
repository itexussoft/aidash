/**
 * Checks for the pure parts: card rendering and the refresh label.
 * Runs on plain Node, no Electron.
 *
 *   npm test
 *
 * The payloads below are verbatim captures from live accounts, so the
 * renderers are exercised against the real shapes rather than invented ones.
 */

import { renderCard, refreshLabel, toEpochMs, relativeTime } from './renderer/render.js';

let failures = 0;
const check = (name, cond) => {
	console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
	if (!cond) failures++;
};

const card = (over = {}) =>
	renderCard({ id: 'a', provider: 'codex', label: 'A', email: null, plan: null, payload: null, lastOkAt: null, lastError: null, ...over });

/* ---------------------------------------------------------- time handling */

console.log('\ntimestamps');
check('epoch seconds understood', toEpochMs(1785913864) === 1785913864000);
check('epoch milliseconds passed through', toEpochMs(1785913864000) === 1785913864000);
check('ISO strings parsed', toEpochMs('2026-08-05T05:00:00.000Z') === Date.parse('2026-08-05T05:00:00.000Z'));
check('null stays null', toEpochMs(null) === null);
check('garbage rejected', toEpochMs('not a date') === null);
check('future renders as "in"', relativeTime(Date.now() + 3600000).startsWith('in '));
check('past renders as "ago"', relativeTime(Date.now() - 3600000).endsWith('ago'));

/* ------------------------------------------------------------------ codex */

console.log('\ncodex (app-server shape)');
const codexPayload = {
	account: { type: 'chatgpt', email: 'andrey@itexus.com', planType: 'team' },
	rateLimits: {
		primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1785913863 },
		secondary: null,
		credits: { hasCredits: false, unlimited: false, balance: null },
		individualLimit: { limit: '1', used: '8.87', remainingPercent: 0, resetsAt: 1785542401 },
		spendControlReached: true,
		planType: 'team',
	},
	usage: {
		summary: { lifetimeTokens: 1090967381, currentStreakDays: 0, longestStreakDays: 14 },
		dailyUsageBuckets: [{ startDate: '2026-07-29', tokens: 29729496 }],
	},
};

const codexCard = card({ provider: 'codex', label: 'Codex', payload: codexPayload, lastOkAt: Date.now() });
check('weekly window rendered', codexCard.includes('Weekly window') && codexCard.includes('30%'));
check('personal spend control surfaced separately', codexCard.includes('Personal spend control'));
check('exhausted spend control marked critical', /class="meter crit"/.test(codexCard));
check('spend control reached is called out', codexCard.includes('limit reached'));
check('daily history surfaced', codexCard.includes('2026-07-29'));
check('lifetime tokens formatted', codexCard.includes('1,090,967,381'));
check('identity from the nested account', codexCard.includes('andrey@itexus.com') && codexCard.includes('team'));

// The flat HTTP shape must keep rendering for snapshots stored earlier.
const flatCodex = card({
	provider: 'codex',
	label: 'Flat',
	payload: {
		email: 'x@y.z',
		plan_type: 'team',
		rate_limit: { primary_window: { used_percent: 15, reset_at: 1785913864 } },
		spend_control: { reached: false, individual_limit: { used_percent: 0, reset_at: 1785542401 } },
	},
	lastOkAt: Date.now(),
});
check('flat /wham/usage shape still renders', flatCodex.includes('Weekly window') && flatCodex.includes('15%'));

/* ----------------------------------------------------------------- claude */

console.log('\nclaude (limits array)');
const claudePayload = {
	five_hour: { utilization: 1, resets_at: '2026-08-03T13:49:59.342006+00:00' },
	seven_day: { utilization: 56, resets_at: '2026-08-05T05:00:00.342030+00:00' },
	limits: [
		{ kind: 'session', percent: 1, severity: 'normal', resets_at: '2026-08-03T13:49:59.342006+00:00', scope: null, is_active: false },
		{ kind: 'weekly_all', percent: 56, severity: 'normal', resets_at: '2026-08-05T05:00:00.342030+00:00', scope: null, is_active: true },
		{
			kind: 'weekly_scoped',
			percent: 46,
			severity: 'normal',
			resets_at: '2026-08-05T05:00:00.342370+00:00',
			scope: { model: { display_name: 'Fable' } },
			is_active: false,
		},
	],
	extra_usage: { is_enabled: false, spend_limit_reached: false },
	spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, enabled: false },
};

const claudeCard = card({ provider: 'claude', label: 'Claude', email: 'claude.dev@itexus.com', plan: 'max', payload: claudePayload, lastOkAt: Date.now() });
const claudeValues = [...claudeCard.matchAll(/meter-val">([^<]+)</g)].map((m) => m[1]);

check('every limit rendered', claudeCard.includes('weekly all') && claudeCard.includes('session') && claudeCard.includes('weekly scoped'));
// The trap this guards: `utilization: 1` means one percent, not a full bar.
check('percentages read as percentages', JSON.stringify(claudeValues) === JSON.stringify(['56%', '46%', '1%']));
check('fullest limit sorted first', claudeValues[0] === '56%');
check('scoped limit names its model', claudeCard.includes('weekly scoped · Fable'));
check('ISO reset times parsed', /resets in \d+[hdm]/.test(claudeCard));
check('inactive windows marked', claudeCard.includes('inactive'));
check('extra usage state shown', claudeCard.includes('extra usage: off'));
check('identity from enrolment', claudeCard.includes('claude.dev@itexus.com') && claudeCard.includes('max'));

/* ------------------------------------------------------------ card states */

console.log('\ncard states');
const pending = card({ label: 'Pending' });
check('freshly added card explains itself', pending.includes('Waiting for the first refresh'));
check('pending card is not an error', !pending.includes('card err'));
check('pending card can be removed', pending.includes('data-id="a"'));
check('every card offers rename alongside remove', ['button class="rename"', 'button class="remove"'].every((s) => pending.includes(s)));
check('rename carries the current label for the dialog', codexCard.includes('class="rename" data-id="a" data-label="Codex"'));
check('a label with markup is escaped on the rename button', card({ label: '<b>x</b>' }).includes('data-label="&lt;b&gt;x&lt;/b&gt;"'));

const broken = card({ label: 'Broken', lastError: 'no stored credentials — re-authorize this account' });
check('failed card shows the reason', broken.includes('no stored credentials'));
check('failed card styled as an error', broken.includes('card err'));
check('failed card says how to recover', broken.includes('add it again'));

const stale = card({ provider: 'codex', label: 'Stale', payload: codexPayload, lastOkAt: Date.now() - 3600000, lastError: 'usage request failed: HTTP 500' });
check('stale data still rendered alongside the error', stale.includes('Weekly window') && stale.includes('HTTP 500'));

/* --------------------------------------------------------- refresh label */

console.log('\nrefresh label');
check('sub-minute reads as "just now"', refreshLabel(Date.now() - 5000).startsWith('updated just now'));
check('singular minute not pluralised', refreshLabel(Date.now() - 60000).startsWith('updated 1 min ago'));
check('elapsed minutes shown', refreshLabel(Date.now() - 3 * 60000).startsWith('updated 3 min ago'));
check('wall-clock time included', /· \d{1,2}:\d{2}/.test(refreshLabel(Date.now())));
check('never-refreshed state', refreshLabel(null) === 'never refreshed');

/* ---------------------------------------------------------------- escaping */

console.log('\nescaping');
const evil = card({
	label: '<img src=x onerror=alert(1)>',
	payload: { rate_limit: { primary_window: { used_percent: 1 } }, email: '</script><script>alert(2)</script>' },
	lastOkAt: Date.now(),
});
check('label escaped', !evil.includes('<img src=x') && evil.includes('&lt;img'));
check('payload escaped in the identity line', !evil.includes('<script>alert(2)'));
check('payload escaped inside the raw block', !/<script>alert\(2\)<\/script>/.test(evil));
check('error text escaped', card({ lastError: '<b>boom</b>' }).includes('&lt;b&gt;'));

/* ---------------------------------------------------------------- meters */

console.log('\nmeter fill widths');
// The regression this guards: an inline style attribute is dropped by the
// page's `style-src 'self'` policy, and .bar i has no width in CSS, so every
// fill silently rendered as a full bar.
check('fill carries its width as data, not as an inline style', /<i data-pct="[\d.]+"><\/i>/.test(codexCard));
check('no inline style attributes anywhere in a card', !/\sstyle="/.test(codexCard));
const pcts = [...claudeCard.matchAll(/data-pct="([\d.]+)"/g)].map((m) => Number(m[1]));
check('widths match the reported percentages', JSON.stringify(pcts) === JSON.stringify([56, 46, 1]));

const overCard = card({
	provider: 'codex',
	label: 'Over',
	payload: { rate_limit: { primary_window: { used_percent: 887 } } },
	lastOkAt: Date.now(),
});
check('a bar past 100% is capped for the fill', /data-pct="100/.test(overCard));
check('but the true figure is still shown', overCard.includes('887%'));

/* ----------------------------------------------------------- sessions tab */

console.log('\nsession index');
{
	const { scanAll, moveSession } = await import('./src/sessions.js');
	const { mkdtemp, mkdir, writeFile, readdir } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');

	// Mirrors the desktop app's own layout:
	//   <index>/<accountUuid>/<orgUuid>/local_<uuid>.json
	// Sessions belong to an account by having an entry here, not by where the
	// transcript sits — the transcripts are shared and carry no account at all.
	const index = await mkdtemp(join(tmpdir(), 'aidash-index-'));
	const A = join(index, 'account-a', 'org-a');
	const B = join(index, 'account-b', 'org-b');
	await mkdir(A, { recursive: true });
	await mkdir(B, { recursive: true });

	const entry = (over) => ({
		sessionId: 'local_1111',
		cliSessionId: 'cli-1111',
		cwd: '/Users/test/demo',
		title: 'Demo session',
		model: 'claude-opus-5',
		lastActivityAt: 1785000000000,
		isArchived: false,
		...over,
	});

	await writeFile(join(A, 'local_1111.json'), JSON.stringify(entry()));
	await writeFile(
		join(A, 'local_2222.json'),
		JSON.stringify(entry({ sessionId: 'local_2222', cliSessionId: 'cli-2222', cwd: '/Users/test/other', title: 'Other' })),
	);

	const before = await scanAll([], index);
	check('both account/org pairs are listed', before.accounts.length === 2);
	check('each project becomes a row', before.projects.length === 2);
	const demo = before.projects.find((p) => p.cwd === '/Users/test/demo');
	check('cwd comes from the entry, not a decoded folder name', Boolean(demo));
	check('sessions sit under the account that lists them', demo.byAccount['account-a/org-a']?.length === 1);
	check('the other account starts empty for that project', !demo.byAccount['account-b/org-b']);
	check('title carried through', demo.byAccount['account-a/org-a'][0].title === 'Demo session');
	// The transcript for a synthetic entry does not exist, and that has to be
	// visible rather than silently rendering as an ordinary session.
	check('a missing transcript is reported', demo.byAccount['account-a/org-a'][0].transcript === null);

	await moveSession({ fromFile: join(A, 'local_1111.json'), toAccountPath: B, cliSessionId: 'cli-1111' });
	const after = await scanAll([], index);
	const moved = after.projects.find((p) => p.cwd === '/Users/test/demo');
	check('session leaves the source account', !moved.byAccount['account-a/org-a']);
	check('session appears under the destination', moved.byAccount['account-b/org-b']?.length === 1);
	check('the entry file itself moved', (await readdir(B)).includes('local_1111.json'));
	check("the other project is untouched", after.projects.find((p) => p.cwd === '/Users/test/other').byAccount['account-a/org-a'].length === 1);

	const rejects = async (fn) => {
		try {
			await fn();
			return null;
		} catch (err) {
			return err.message;
		}
	};

	check(
		'moving a vanished entry is refused',
		/no longer where it was/.test(await rejects(() => moveSession({ fromFile: join(A, 'local_1111.json'), toAccountPath: B, cliSessionId: 'cli-1111' }))),
	);

	// The same transcript listed twice under one account would read as two
	// sessions that are really one.
	await writeFile(join(A, 'local_3333.json'), JSON.stringify(entry({ sessionId: 'local_3333' })));
	check(
		'listing the same transcript twice is refused',
		/already lists this session/.test(await rejects(() => moveSession({ fromFile: join(A, 'local_3333.json'), toAccountPath: B, cliSessionId: 'cli-1111' }))),
	);

	const { claudeEnv, keychainService, DEFAULT_CONFIG_DIR } = await import('./src/claude-config.js');
	check('default directory runs with no CLAUDE_CONFIG_DIR', Object.keys(claudeEnv(DEFAULT_CONFIG_DIR)).length === 0);
	check('other directories do set it', claudeEnv('/tmp/other').CLAUDE_CONFIG_DIR === '/tmp/other');
	check('default keychain entry is unsuffixed', keychainService(DEFAULT_CONFIG_DIR) === 'Claude Code-credentials');
	check('other directories get a hashed suffix', /^Claude Code-credentials-[0-9a-f]{8}$/.test(keychainService('/tmp/other')));
	check('the suffix distinguishes directories', keychainService('/tmp/a') !== keychainService('/tmp/b'));
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);

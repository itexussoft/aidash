/**
 * Checks for the pure parts: card rendering and the refresh label.
 * Runs on plain Node, no Electron.
 *
 *   npm test
 *
 * The payloads below are verbatim captures from live accounts, so the
 * renderers are exercised against the real shapes rather than invented ones.
 */

import { renderCard, refreshLabel, staleness, toEpochMs, relativeTime, barColour } from './renderer/render.js';
import { tightest, rankByHeadroom, upcomingResets } from './src/windows.js';
import { Alerts, crossings, notableResets, MAX_DELAY, NOTIFY_ABOVE } from './src/alerts.js';
import { bridgeState, HERE, ELSEWHERE, SHARED } from './src/bridges.js';
import { proposeOwners, collapse } from './src/matching.js';
import { outlookHtml, position } from './renderer/outlook.js';
import { encodeCwd } from './src/sessions.js';
import { spawnable } from './src/locate.js';

let failures = 0;

// On a runner, a failure also becomes a GitHub annotation. Job logs need admin
// rights to fetch, so a failure on a platform nobody has to hand — which is the
// whole reason these run on Windows — was otherwise a red cross with no name
// attached. Annotations are public.
const annotate = (name) => {
	if (process.env.GITHUB_ACTIONS) console.log(`::error title=test failed::${name}`);
};

// A section that throws never reaches a check, so it would otherwise fail with
// nothing recorded anywhere readable.
for (const event of ['uncaughtException', 'unhandledRejection']) {
	process.on(event, (err) => {
		const detail = `${err?.message ?? err}`.split('\n')[0];
		console.error(`\nthrew during ${event}: ${err?.stack ?? err}\n`);
		annotate(`${event}: ${detail}`);
		process.exit(1);
	});
}

const check = (name, cond) => {
	console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
	if (!cond) {
		failures++;
		annotate(name);
	}
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
const claudeValues = [...claudeCard.matchAll(/class="meter-val"[^>]*>([^<]+)</g)].map((m) => m[1]);

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

// A reading is not wrong when it ages, but it stops being worth acting on: past
// twenty minutes a session window can have moved, past forty it can have opened
// and closed again.
check('a fresh reading is unmarked', staleness(Date.now() - 60000) === 'ok');
check('nineteen minutes is still fresh', staleness(Date.now() - 19 * 60000) === 'ok');
check('past twenty it is amber', staleness(Date.now() - 21 * 60000) === 'warn');
check('past forty it is red', staleness(Date.now() - 41 * 60000) === 'crit');
check('never refreshed is as stale as it gets', staleness(null) === 'crit');

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
check('fill carries its width as data, not as an inline style', /<i data-pct="[\d.]+" data-colour="[^"]+"><\/i>/.test(codexCard));
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

// Three buckets put 20% and 70% in the same green, which wastes most of what a
// bar is for; the scale is continuous so a column of them ranks at a glance.
console.log('\nmeter colour scale');
const hue = (c) => Number(c.match(/hsl\((\d+)/)[1]);
check('empty reads green', hue(barColour(0)) > 130);
check('halfway has moved off green', hue(barColour(50)) < hue(barColour(0)));
check('three quarters is amber', hue(barColour(75)) > 30 && hue(barColour(75)) < 60);
check('full reads red', hue(barColour(100)) < 12);
check('hue only ever falls', [0, 20, 40, 60, 80, 100].every((p, i, a) => i === 0 || hue(barColour(p)) <= hue(barColour(a[i - 1]))));
check('past 100% clamps rather than wrapping back to green', barColour(887) === barColour(100));
check('nonsense is treated as empty', barColour(null) === barColour(0));
check('but the true figure is still shown', overCard.includes('887%'));

/* --------------------------------------------------------------- outlook */

// The summary above the cards answers two questions the cards cannot: which
// account is furthest from stopping you, and when anything comes back. Both are
// pure functions of the same payloads, so they are checked against them here.
console.log('\noutlook');

const NOW = Date.now();
const inHours = (h) => NOW + h * 3600000;

const roomy = {
	id: 'codex-roomy',
	provider: 'codex',
	label: 'Roomy',
	payload: { rateLimits: { primary: { usedPercent: 5, resetsAt: Math.floor(inHours(144) / 1000) } } },
};

const nearlyOut = {
	id: 'claude-tight',
	provider: 'claude',
	label: 'Tight',
	payload: {
		limits: [
			// Inactive and nearly full: the case the ranking must not wave through.
			{ kind: 'session', percent: 92, severity: 'normal', is_active: false, resets_at: new Date(inHours(2)).toISOString() },
			{ kind: 'weekly_all', percent: 30, severity: 'normal', is_active: true, resets_at: new Date(inHours(96)).toISOString() },
		],
	},
};

const silent = { id: 'quiet', provider: 'claude', label: 'Silent', payload: null };

check('the fullest window decides an account', tightest(nearlyOut).percent === 92);
check('an inactive window still counts — it applies the moment work starts', tightest(nearlyOut).label.includes('session'));
check('an account with no readable window has no reading', tightest(silent) === null);

const { ranked, unreadable } = rankByHeadroom([nearlyOut, roomy, silent]);
check('most headroom first', ranked.map((r) => r.account.id).join(',') === 'codex-roomy,claude-tight');
check('an unreadable account is set aside, not ranked as empty', unreadable.length === 1 && unreadable[0].id === 'quiet');

const past = { id: 'stale', provider: 'codex', label: 'Stale', payload: { rateLimits: { primary: { usedPercent: 40, resetsAt: Math.floor(inHours(-3) / 1000) } } } };
check('a reset already passed is dropped rather than drawn at zero', upcomingResets([past], NOW).length === 0);
check('resets come back soonest first', upcomingResets([roomy, nearlyOut], NOW).map((r) => r.window.percent).join(',') === '92,30,5');

const outlook = outlookHtml([nearlyOut, roomy, silent], NOW);
check('the roomiest account is named as the answer', /Most room now[\s\S]*Roomy/.test(outlook));
check('every account still gets a lane', outlook.includes('>Tight<') && outlook.includes('>Roomy<'));
check('the unranked account is named rather than silently dropped', outlook.includes('Not ranked: Silent'));

// The soonest reset is nearly always a session window at 4%, which is true and
// useless; the line only speaks for windows close to stopping someone.
const reliefLine = outlook.match(/<p class="outlook-relief">[\s\S]*?<\/p>/)?.[0] ?? '';
check('relief names the window that is nearly out', reliefLine.includes('Tight') && reliefLine.includes('session'));
check('relief skips the roomy account, whose reset is sooner in nothing that matters', !reliefLine.includes('Roomy'));
check('nothing tight, nothing said', !outlookHtml([roomy], NOW).includes('Nearest relief'));
check('no accounts, no section', outlookHtml([], NOW) === '' && outlookHtml([silent], NOW) === '');

// Same policy as the meters: `style-src 'self'` drops inline style attributes,
// so every position and colour has to travel as data and be applied by script.
check('positions travel as data, not as inline styles', !/\sstyle="/.test(outlook) && /data-at="[\d.]+"/.test(outlook));
check('a label with markup is escaped', outlookHtml([{ ...roomy, label: '<img src=x>' }], NOW).includes('&lt;img'));

// A five-hour window and a monthly spend control share one axis. Spread
// linearly, the whole of tomorrow lands in the first 3% of it.
console.log('\ntimeline scale');
const month = 720 * 3600000;
check('time only ever moves right', [1, 6, 24, 72, 168].every((h, i, a) => i === 0 || position(h * 3600000, month) > position(a[i - 1] * 3600000, month)));
check('now sits at the left edge', position(0, month) === 0);
check('the far end is the far end', position(month, month) === 1);
check('tomorrow gets real width rather than a sliver', position(24 * 3600000, month) > 0.4);
check('a single near reset does not blow up the scale', position(600000, 600000) <= 1);

/* ---------------------------------------------------------------- alerts */

// What the menu bar and the notifications decide, without a menu bar or a
// notification in sight. The timers are real, so the delays here are checked
// rather than waited on.
console.log('\nalerts');

const claudeAt = (percent, hoursAway, id = 'acct') => ({
	id,
	provider: 'claude',
	label: id,
	payload: { limits: [{ kind: 'weekly_all', percent, is_active: true, resets_at: new Date(inHours(hoursAway)).toISOString() }] },
});

check('a quiet window is not worth interrupting anyone for', notableResets([claudeAt(4, 2)], NOW).length === 0);
check('a window near the limit is', notableResets([claudeAt(92, 2)], NOW).length === 1);
check('the threshold is the meters own amber', NOTIFY_ABOVE === 80);

const first = crossings([claudeAt(92, 2)], new Map());
check('the first reading is recorded, not announced', first.crossed.length === 0 && first.seen.get('acct') === 92);
check('a window that stays high is not announced again', crossings([claudeAt(92, 2)], first.seen).crossed.length === 0);
check('rising past the threshold is news', crossings([claudeAt(92, 2)], new Map([['acct', 40]])).crossed[0]?.level === 'nearly');
check('running out entirely is different news', crossings([claudeAt(100, 2)], new Map([['acct', 90]])).crossed[0]?.level === 'exhausted');
check('falling back after a reset is not news', crossings([claudeAt(3, 100)], new Map([['acct', 92]])).crossed.length === 0);

// The regression this guards: setTimeout keeps its delay in a signed 32-bit
// int, so a monthly spend control scheduled directly would fire at once, then
// again, forever.
const delays = [];
const fakeTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
globalThis.setTimeout = (fn, ms) => {
	delays.push(ms);
	return fakeTimers.setTimeout(() => {}, 0);
};

const said = [];
const alerts = new Alerts({ notify: (m) => said.push(m), refresh: () => said.push({ title: 'refreshed' }), now: () => NOW });
alerts.update([claudeAt(95, 24 * 40, 'far'), claudeAt(93, 3, 'near')]);

globalThis.setTimeout = fakeTimers.setTimeout;

check('a wait longer than a timer can hold is served in stages', delays.some((d) => d === MAX_DELAY));
check('and a near one is waited on exactly', delays.some((d) => d === 3 * 3600000));
check('nothing is announced merely by scheduling it', said.length === 0);

const fired = [];
const due = new Alerts({ notify: (m) => fired.push(m), refresh: () => fired.push({ title: 'refreshed' }), now: () => NOW });
// A reset whose stamp has already passed: the notification is owed immediately,
// and the numbers behind it are known to be stale.
due.schedule({ account: { label: 'Work' }, window: { label: 'weekly all', percent: 95, resetAt: NOW - 1000 } });
check('a reset already due is announced at once', fired[0]?.title === 'Work: weekly all is back');
check('it says what the window had reached', fired[0]?.body.includes('95%'));
check('and spends the one request that is now worth spending', fired[1]?.title === 'refreshed');

const off = new Alerts({ notify: () => said.push('should not happen'), refresh: () => {}, now: () => NOW });
off.enabled(false);
off.update([claudeAt(92, 2, 'x')]);
check('switched off, it schedules nothing', off.timers.length === 0);

/* ------------------------------------------------------- remote control */

// A bridge id names no account, so which account a Remote Control link belongs
// to is never in the file — it is in where the file sits, and what this app
// remembers moving. Three answers, and the third is not a weaker first.
console.log('\nremote control links');

const A = 'acctA/orgA';
const B = 'acctB/orgB';
const ids = ['session_01aaa', 'session_01bbb'];

const at = (args) => bridgeState(args).state;

check('no links, nothing to say', at({ bridges: [], accountId: A }) === null);
check('links and no history read as this account’s', at({ bridges: ids, accountId: A, origin: null }) === HERE);
check('moved away, every link predating the move', at({ bridges: ids, accountId: B, origin: { account: A, ids } }) === ELSEWHERE);
check('back where they were minted', at({ bridges: ids, accountId: A, origin: { account: A, ids } }) === HERE);

// Re-enabling Remote Control under the new account appends an id this account
// does own, and one live link is enough to stop calling the badge foreign.
check('a link minted here outweighs the ones that came with it', at({ bridges: [...ids, 'session_01new'], accountId: B, origin: { account: A, ids } }) === HERE);

// The case that exists on the machine this was written against, with no help
// from this app: one conversation, two accounts, the same link in both.
check('listed by two accounts is unresolvable, not foreign', at({ bridges: ids, accountId: B, origin: null, duplicated: true }) === SHARED);
check('and stays unresolvable even with a move on record', at({ bridges: ids, accountId: B, origin: { account: A, ids }, duplicated: true }) === SHARED);

// What matching is for: it settles the case nothing local could.
const owned = { [ids[0]]: { account: A }, [ids[1]]: { account: A } };
check('a matched owner resolves the shared case', at({ bridges: ids, accountId: B, duplicated: true, owners: owned }) === ELSEWHERE);
check('and resolves it in the owner’s favour too', at({ bridges: ids, accountId: A, duplicated: true, owners: owned }) === HERE);
check('the grounds are reported, not just the verdict', bridgeState({ bridges: ids, accountId: A, owners: owned }).via === 'matched');
check('a remembered move says so', bridgeState({ bridges: ids, accountId: B, origin: { account: A, ids } }).via === 'moved');
check('and a badge resting on nothing admits it', bridgeState({ bridges: ids, accountId: A }).via === null);
check(
	'a partly matched set is not called foreign on half the evidence',
	at({ bridges: ids, accountId: B, owners: { [ids[0]]: { account: A } } }) === HERE,
);

/* ---------------------------------------------------------- title matching */

// Every refusal here was a wrong attribution the first version would have made
// against real data: ten titles matched uniquely on the machine this was built
// for, and only two of them could honestly be attributed to an account.
console.log('\nmatching links to accounts');

const remote = (title, lastAt, id) => ({ id, title, lastAt, connection: 'connected' });
const localSession = (over) => ({ cliSessionId: 'c1', title: 'Etico', bridges: ['session_01x'], createdAt: NOW - 3600000, lastAt: NOW, ...over });

const oneList = [{ ok: true, accounts: [A], sessions: [remote('Etico', NOW, 'cse_1')] }];

check('a unique title in one account is attributed', proposeOwners({ sessions: [localSession()], sources: oneList }).owners[0]?.account === A);
check('and names the link it attributed', proposeOwners({ sessions: [localSession()], sources: oneList }).owners[0]?.bridge === 'session_01x');

// The condition the real data made necessary: two directories answering
// identically are one list, and one list belonging to two accounts proves
// nothing about either.
const sharedList = [
	{ ok: true, accounts: [A], sessions: [remote('Etico', NOW, 'cse_1')] },
	{ ok: true, accounts: [B], sessions: [remote('Etico', NOW, 'cse_1')] },
];
check('two directories with the same list collapse into one', collapse(sharedList).length === 1);
check('a list two accounts return attributes nothing', proposeOwners({ sessions: [localSession()], sources: sharedList }).owners.length === 0);
check('and says why it refused', proposeOwners({ sessions: [localSession()], sources: sharedList }).refused.ambiguousAccount === 1);

check(
	'several links on one entry are left alone',
	proposeOwners({ sessions: [localSession({ bridges: ['a', 'b'] })], sources: oneList }).refused.severalLinks === 1,
);
check(
	'a title repeated locally is not resolvable either',
	proposeOwners({ sessions: [localSession(), localSession({ cliSessionId: 'c2', bridges: ['session_01y'] })], sources: oneList }).refused.ambiguousTitle === 2,
);
check(
	'a title that matches but a time that does not is refused',
	proposeOwners({ sessions: [localSession({ createdAt: NOW - 10 * 86400000, lastAt: NOW - 9 * 86400000 })], sources: oneList }).refused.timeDisagrees === 1,
);
check('a title the server does not have is simply absent', proposeOwners({ sessions: [localSession({ title: 'Nowhere' })], sources: oneList }).refused.notFound === 1);
check('an unreadable account contributes nothing and breaks nothing', proposeOwners({ sessions: [localSession()], sources: [{ ok: false }] }).refused.notFound === 1);

/* -------------------------------------------------------- project digest */

// The brief has to be derived rather than composed: what it claims must be
// something a transcript actually recorded.
console.log('\nproject brief');
{
	const { mkdtemp, writeFile: write } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join: j } = await import('node:path');
	const { readSession, buildDigest, digestMarkdown } = await import('./src/digest.js');

	const dir = await mkdtemp(j(tmpdir(), 'aidash-digest-'));
	const cwd = '/Users/someone/work/repo';

	const claude = j(dir, 'claude.jsonl');
	await write(
		claude,
		[
			JSON.stringify({ type: 'user', cwd, gitBranch: 'feature/parser', message: { content: 'Fix the parser' }, timestamp: '2026-08-01T10:00:00Z' }),
			JSON.stringify({
				type: 'assistant',
				gitBranch: 'feature/parser',
				message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/parse.js` } }] },
			}),
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', name: 'MultiEdit', input: { edits: [{ file_path: `${cwd}/src/lex.js` }] } }] },
			}),
			// A tool result is recorded as a user turn but is not a thing anyone said.
			JSON.stringify({ type: 'user', message: { content: 'Result of calling the Edit tool: ok' }, timestamp: '2026-08-01T10:05:00Z' }),
		].join('\n'),
	);

	const read = await readSession(claude, 'claude', cwd);
	check('files a tool touched are collected', read.files.includes('src/parse.js'));
	check('and from list-shaped edits too', read.files.includes('src/lex.js'));
	check('paths are made relative to the project', !read.files.some((f) => f.startsWith('/')));
	check('the branch is picked up', read.branches.includes('feature/parser'));
	check('what was asked is kept', read.messages.some((m) => m.text === 'Fix the parser'));
	check('tool results are not mistaken for things said', !read.messages.some((m) => m.text.startsWith('Result of calling')));

	const codex = j(dir, 'codex.jsonl');
	await write(
		codex,
		[
			JSON.stringify({ type: 'session_meta', payload: { cwd } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ path: `${cwd}/README.md` }) } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Update the readme' }] } }),
			// Not every call carries JSON; it must not take the read down with it.
			JSON.stringify({ type: 'response_item', payload: { type: 'function_call', arguments: 'ls -la' } }),
		].join('\n'),
	);

	const fromCodex = await readSession(codex, 'codex', cwd);
	check('Codex tool calls are read on their own terms', fromCodex.files.includes('README.md'));
	check('and an unparseable argument is skipped, not fatal', fromCodex.messages.some((m) => m.text === 'Update the readme'));

	const digest = await buildDigest({
		cwd,
		sources: ['Work', 'Codex'],
		sessions: [
			{ transcript: claude, tool: 'claude', title: 'Parser work', source: 'Work' },
			{ transcript: codex, tool: 'codex', title: 'Readme', source: 'Codex' },
		],
	});
	check('both tools land in one brief', digest.files.includes('src/parse.js') && digest.files.includes('README.md'));
	check('a transcript that is gone does not break the brief', (await buildDigest({ cwd, sessions: [{ transcript: j(dir, 'nope.jsonl'), tool: 'claude' }] })).files.length === 0);

	const md = digestMarkdown(digest);
	check('the brief names the directory it describes', md.includes(cwd));
	check('it admits what it left out', md.includes('other machines are not included'));
	check('and says it summarised nothing', md.includes('Nothing here is summarised'));
	check('files are listed for pasting', md.includes('`src/parse.js`'));
}

/* -------------------------------------------------------- searching them all */

// The claim this makes is "these sessions said it", so a hit inside a tool
// result or a file path would be a lie told confidently.
console.log('\nsearching every transcript');
{
	const { mkdtemp, writeFile: write } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join: j } = await import('node:path');
	const { searchTranscripts } = await import('./src/search.js');

	const dir = await mkdtemp(j(tmpdir(), 'aidash-search-'));

	const said = j(dir, 'said.jsonl');
	await write(
		said,
		[
			JSON.stringify({ type: 'user', message: { content: 'How do I rotate the refresh token safely?' } }),
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Write the rotated token back so the CLI keeps working.' }] } }),
		].join('\n'),
	);

	const onlyTooling = j(dir, 'tooling.jsonl');
	await write(
		onlyTooling,
		[
			JSON.stringify({ type: 'user', message: { content: 'Fix the build' } }),
			// The term appears, but only in a tool call and its result.
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/src/refresh-token.js' } }] } }),
			JSON.stringify({ type: 'user', message: { content: 'Result of calling the Read tool: refresh token helper' } }),
		].join('\n'),
	);

	const codex = j(dir, 'codex.jsonl');
	await write(
		codex,
		[JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'the refresh token expired again' }] } })].join('\n'),
	);

	const targets = [
		{ transcript: said, tool: 'claude' },
		{ transcript: onlyTooling, tool: 'claude' },
		{ transcript: codex, tool: 'codex' },
		{ transcript: j(dir, 'gone.jsonl'), tool: 'claude' },
	];

	const found = await searchTranscripts({ targets, query: 'refresh token' });
	const paths = found.results.map((r) => r.transcript);
	check('a transcript that said it is found', paths.includes(said));
	check('both tools are searched', paths.includes(codex));
	check('a hit only in tool calls is not a result', !paths.includes(onlyTooling));
	check('a transcript that is gone is one fewer place to look, not a failure', found.scanned === 4);
	check('the match is quoted back', found.results.find((r) => r.transcript === said)?.snippet.includes('refresh token'));
	check('and attributed to who said it', found.results.find((r) => r.transcript === said)?.role === 'user');

	check('case is ignored', (await searchTranscripts({ targets, query: 'REFRESH Token' })).results.length === 2);
	check('a term nobody used finds nothing', (await searchTranscripts({ targets, query: 'quokka' })).results.length === 0);
	check('one letter is not a search', (await searchTranscripts({ targets, query: 'r' })).results.length === 0);

	const stopped = new AbortController();
	stopped.abort();
	const abandoned = await searchTranscripts({ targets, query: 'refresh token', signal: stopped.signal });
	check('an abandoned search returns nothing and says it is incomplete', abandoned.results.length === 0 && abandoned.complete === false);
}

/* --------------------------------------------------------- release notes */

// The file is written by a person and read by the interface, so the parser has
// to survive the prose a person puts around it.
console.log('\nrelease notes');
{
	const { parseNotes, notesFor, manifestNotes } = await import('./src/notes.js');

	const entries = parseNotes(`# What's new

Some prose about how to keep this file, which is not a version and not a note.

## Unreleased

- Something not shipped yet

## 0.1.3

- Notarises the disk image
- Says which test failed on CI, wrapping
  onto a second line

## 0.1.2

Prose under a version heading is for whoever edits the file.

- One thing
`);

	check('versions are found in file order', entries.map((e) => e.version).join(',') === 'Unreleased,0.1.3,0.1.2');
	check('bullets belong to their version', notesFor(entries, '0.1.3').bullets.length === 2);
	check('a wrapped note arrives as one line', notesFor(entries, '0.1.3').bullets[1] === 'Says which test failed on CI, wrapping onto a second line');
	check('prose between the bullets is not a bullet', notesFor(entries, '0.1.2').bullets.length === 1);
	check('a version nobody wrote about is absent', notesFor(entries, '9.9.9') === null);
	check('a heading with no bullets is not an entry', parseNotes('## 1.0.0\n\n## 1.0.1\n- real\n').length === 1);
	check('an empty file is empty, not a crash', parseNotes('').length === 0 && parseNotes(null).length === 0);

	// The manifest on the server still carries a string; the banner has to keep
	// understanding it while newer ones send a list.
	check('a list from the manifest stays a list', manifestNotes(['a', 'b']).length === 2);
	check('a string from the manifest becomes one line', manifestNotes('just one thing').length === 1);
	check('nothing at all is no lines', manifestNotes(null).length === 0 && manifestNotes('  ').length === 0);

	// The file this app actually ships, parsed as the app will parse it.
	const { readNotes } = await import('./src/notes.js');
	const { join: joinPath } = await import('node:path');
	const shipped = await readNotes(joinPath(process.cwd(), 'CHANGELOG.md'));
	check('the shipped changelog parses', shipped.length > 0);
	check('and every entry it lists says something', shipped.every((e) => e.bullets.length > 0));
	check('a changelog that is not there is not a failure', (await readNotes('/nowhere/CHANGELOG.md')).length === 0);
}

/* -------------------------------------------------------------- the store */

console.log('\naccount store');
{
	const { AccountStore } = await import('./src/accounts.js');
	const { mkdtemp } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');

	// A bulk edit once removed save/dirFor/makeId while deleting the code around
	// them; nothing caught it because the suite only covered rendering. This is
	// the cheap guard: the class must still have the shape the app calls.
	for (const method of ['load', 'save', 'dirFor', 'makeId', 'claudeConfigDirs', 'add', 'rename', 'remove', 'refreshAll', 'availability']) {
		check(`store has ${method}()`, typeof AccountStore.prototype[method] === 'function');
	}

	const store = new AccountStore(await mkdtemp(join(tmpdir(), 'aidash-store-')));
	await store.load();
	check('starts with no accounts', store.state.accounts.length === 0);
	check('the default config directory is always consulted', store.claudeConfigDirs().length === 1);

	check('ids keep non-Latin names distinct', store.makeId('claude', 'Работа') !== store.makeId('claude', 'Личный'));
	store.state.accounts.push({ id: 'claude-работа', provider: 'claude' });
	check('a taken id gets a suffix rather than colliding', store.makeId('claude', 'Работа') === 'claude-работа-2');
	check('credentials live under the account id', store.dirFor('x').endsWith(join('accounts', 'x')));

	await store.save();
	// `dirname`, not a regex on the path: a `/accounts\.json$/ ` pattern never
	// matched on Windows, so this reconstructed the store rooted at the file
	// itself and `load()` died trying to mkdir over it.
	const { dirname } = await import('node:path');
	const reloaded = new AccountStore(dirname(store.file));
	await reloaded.load();
	check('state survives a reload', reloaded.state.accounts.length === 1);

	await reloaded.rename('claude-работа', 'Renamed');
	check('rename changes the label', reloaded.state.accounts[0].label === 'Renamed');
	check('rename leaves the id alone', reloaded.state.accounts[0].id === 'claude-работа');
	let renameError = null;
	try {
		await reloaded.rename('claude-работа', '   ');
	} catch (err) {
		renameError = err.message;
	}
	check('an empty name is refused', /name is required/.test(renameError ?? ''));

	// Settings live beside the accounts, so a file written by an older version
	// has to come back with the newer switches on rather than undefined.
	check('settings start at their defaults', reloaded.state.settings.tray === true && reloaded.state.settings.refreshEveryMinutes === 60);

	await reloaded.setSetting('tray', false);
	await reloaded.setSetting('refreshEveryMinutes', '120');
	const again = new AccountStore(dirname(store.file));
	await again.load();
	check('a switch survives a reload', again.state.settings.tray === false);
	check('an interval is stored as a number, whatever it arrived as', again.state.settings.refreshEveryMinutes === 120);
	check('the other settings are left alone', again.state.settings.notifications === true);

	let settingError = null;
	try {
		await again.setSetting('somethingElse', true);
	} catch (err) {
		settingError = err.message;
	}
	check('an unknown setting is refused rather than stored', /unknown setting/.test(settingError ?? ''));

	// A file from before settings existed must not come back with them missing.
	const { writeFile } = await import('node:fs/promises');
	await writeFile(again.file, JSON.stringify({ accounts: [], lastRefreshAt: null }));
	const old = new AccountStore(dirname(store.file));
	await old.load();
	check('a file written before settings existed gets the defaults', old.state.settings.notifications === true);
}

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

	const transcripts = join(index, '__transcripts');
	await mkdir(transcripts, { recursive: true });

	const before = await scanAll([], index, transcripts);
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
	const after = await scanAll([], index, transcripts);
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

	// A transcript no index names is invisible to the desktop app but resumable
	// from the terminal; adopting it writes the entry it was missing.
	const { adoptSession, UNINDEXED } = await import('./src/sessions.js');
	check('the unclaimed column has a stable name', UNINDEXED === 'unindexed');
	check(
		'adopting a transcript that is not there is refused',
		/no longer there/.test(await rejects(() => adoptSession({ transcriptFile: join(index, 'nope.jsonl'), toAccountPath: B }))),
	);

	const { claudeEnv, keychainService, DEFAULT_CONFIG_DIR } = await import('./src/claude-config.js');
	check('default directory runs with no CLAUDE_CONFIG_DIR', Object.keys(claudeEnv(DEFAULT_CONFIG_DIR)).length === 0);
	check('other directories do set it', claudeEnv('/tmp/other').CLAUDE_CONFIG_DIR === '/tmp/other');
	check('default keychain entry is unsuffixed', keychainService(DEFAULT_CONFIG_DIR) === 'Claude Code-credentials');
	check('other directories get a hashed suffix', /^Claude Code-credentials-[0-9a-f]{8}$/.test(keychainService('/tmp/other')));
	check('the suffix distinguishes directories', keychainService('/tmp/a') !== keychainService('/tmp/b'));
}

/* ------------------------------------------------------ across the tools */

console.log('\ncross-tool copy');
{
	const { DatabaseSync } = await import('node:sqlite');
	const { mkdtemp, mkdir, readFile, readdir } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const codex = await import('./src/codex-sessions.js');
	const { readConversation, importedTitle, preamble, toMarkdown } = await import('./src/transfer.js');
	const { importConversation: intoClaude } = await import('./src/sessions.js');

	const home = await mkdtemp(join(tmpdir(), 'aidash-codex-'));
	const db = new DatabaseSync(join(home, 'state_5.sqlite'));
	db.exec(
		`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL,
			title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL,
			tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0,
			archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT, cli_version TEXT NOT NULL DEFAULT '',
			first_user_message TEXT NOT NULL DEFAULT '', memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT,
			created_at_ms INTEGER, updated_at_ms INTEGER, preview TEXT NOT NULL DEFAULT '',
			recency_at INTEGER NOT NULL DEFAULT 0, history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT);`,
	);
	db.close();

	const conversation = {
		title: importedTitle('claude', 'Fix the bug'),
		cwd: '/Users/test/proj',
		messages: [
			{ role: 'user', text: 'fix it' },
			{ role: 'assistant', text: 'fixed' },
		],
		preamble: preamble('claude', 'Fix the bug'),
	};

	const { id, rolloutPath } = await codex.importConversation(home, conversation);
	const listed = await codex.listSessions(home);
	check('the copy appears in Codex', listed.length === 1);
	check('its title names where it came from', listed[0].title === 'Claude imported: Fix the bug');

	const rollout = await readFile(rolloutPath, 'utf8');
	check('the rollout opens with session_meta', JSON.parse(rollout.split('\n')[0]).type === 'session_meta');
	check('the note about what was left out comes first', rollout.includes('imported from Claude Code'));

	// Reading it back with the same parser is what proves the written shape is
	// one the tool can actually consume.
	const back = await readConversation(rolloutPath, 'codex');
	check('Codex can read back what we wrote', back.messages.length === 3);
	check('roles survive the round trip', back.messages[1].role === 'user' && back.messages[2].role === 'assistant');
	check('text survives unaltered', back.messages[2].text === 'fixed');

	await codex.renameSession(home, id, 'Renamed');
	check('renaming a Codex session takes', (await codex.listSessions(home))[0].title === 'Renamed');
	await codex.deleteSession(home, id);
	check('deleting removes it', (await codex.listSessions(home)).length === 0);

	const account = join(home, 'account');
	const transcripts = join(home, 'transcripts');
	await mkdir(account, { recursive: true });
	await mkdir(transcripts, { recursive: true });
	const written = await intoClaude(
		account,
		{
			title: importedTitle('codex', 'Ship it'),
			cwd: '/Users/test/proj',
			messages: [{ role: 'user', text: 'ship' }],
			preamble: preamble('codex', 'Ship it'),
		},
		transcripts,
	);
	const transcript = await readFile(written.transcript, 'utf8');
	check('the Claude transcript is written', transcript.includes('ship'));
	check('its title is recorded', JSON.parse(transcript.split('\n')[0]).aiTitle === 'Codex imported: Ship it');
	check('an index entry makes it listable', (await readdir(account)).length === 1);
	check('Claude can read back what we wrote', (await readConversation(written.transcript, 'claude')).messages.length === 2);

	check('the preamble admits what is missing', /Tool calls[\s\S]*not carried across/.test(preamble('claude', 'X')));
	const markdown = toMarkdown({ title: 'T', cwd: '/c', messages: [{ role: 'user', text: 'a' }] }, 'claude');
	check('the export says it is dialogue only', markdown.startsWith('# T') && markdown.includes('Dialogue only'));
}

/* ------------------------------------------------- cross-platform plumbing */

console.log('\nworking-directory encoding');
// Claude Code replaces every non-alphanumeric character, not just separators.
// Derived by running it in directories built to tell the candidate rules apart.
check('separators become dashes', encodeCwd('/Users/mad/proj') === '-Users-mad-proj');
check('dots become dashes too', encodeCwd('/Users/mad/itexus.com') === '-Users-mad-itexus-com');
check('so do underscores and spaces', encodeCwd('/a_b c') === '-a-b-c');
check('dashes and digits survive', encodeCwd('/ai-usage-2') === '-ai-usage-2');
// A Windows drive letter is the case that would have thrown rather than merely
// missed: a colon cannot appear in an NTFS name.
check('a drive colon is encoded', encodeCwd('C:\\Users\\mad\\proj') === 'C--Users-mad-proj');
check('nothing illegal for NTFS survives', !/[:\\/?*"<>|]/.test(encodeCwd('C:\\a b\\c.d')));
// Non-Latin names collapse to one dash per character. Lossy, but it is what
// Claude Code does, and this has to find its folders rather than improve them.
check('non-Latin collapses the way Claude Code collapses it', encodeCwd('/проект') === '-------');

console.log('\nspawning the vendor clients');
check('a plain binary is spawned directly', spawnable('/usr/local/bin/claude', 'darwin').command === '/usr/local/bin/claude');
check('and needs no shell', spawnable('/usr/local/bin/claude', 'darwin').options.shell === undefined);
check('an .exe needs no shell either', spawnable('C:\\Programs\\claude.exe', 'win32').options.shell === undefined);
// A .cmd is a batch script, so it needs cmd.exe — and once a shell is involved
// Node joins the command line without quoting, so a space in the path splits it.
const shim = spawnable('C:\\Users\\Ivan Petrov\\AppData\\Roaming\\npm\\claude.cmd', 'win32');
check('an npm .cmd shim goes through a shell', shim.options.shell === true);
check('and is quoted, so a space in the home directory survives', shim.command.startsWith('"') && shim.command.endsWith('"'));
check('a .cmd is only special on Windows', spawnable('/opt/claude.cmd', 'darwin').options.shell === undefined);

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);

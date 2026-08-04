/**
 * Electron main process.
 *
 * Holds the account registry and drives the vendor clients. The renderer never
 * touches credentials or spawns anything — it asks for state and reports what
 * the user did.
 */

import { app, BrowserWindow, ipcMain, shell, dialog, Notification, powerMonitor } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountStore } from './src/accounts.js';
import { Alerts, MAX_DELAY } from './src/alerts.js';
import { MenuBar } from './src/tray.js';
import {
	scanEverything,
	moveSession,
	adoptSession,
	renameSession,
	deleteSession,
	importConversation as importIntoClaude,
	CODEX,
} from './src/sessions.js';
import {
	renameSession as renameCodexSession,
	deleteSession as deleteCodexSession,
	importConversation as importIntoCodex,
	DEFAULT_CODEX_HOME,
} from './src/codex-sessions.js';
import { readConversation, importedTitle, preamble, toMarkdown } from './src/transfer.js';
import { BridgeJournal, bridgeState } from './src/bridges.js';
import { remoteSessions } from './src/remote.js';
import { proposeOwners } from './src/matching.js';
import { buildDigest, digestMarkdown } from './src/digest.js';
import { searchTranscripts } from './src/search.js';
import { DEFAULT_CONFIG_DIR } from './src/claude-config.js';
import { identifyRoot } from './src/sessions.js';
import { writeFile } from 'node:fs/promises';
import { checkForUpdate } from './src/updates.js';

const here = dirname(fileURLToPath(import.meta.url));

let store;
let mainWindow;
let menuBar;
let alerts;
let journal;
// Closing the window with a menu bar item present hides rather than quits, so
// the difference between "put it away" and "I am done" has to be recorded.
let quitting = false;

/**
 * Pending sign-in, held here rather than in the renderer.
 *
 * Claude's flow blocks mid-way waiting for a code from the browser, so the
 * promise it needs has to outlive the IPC call that started it.
 */
let pendingLogin = null;

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1100,
		height: 780,
		minWidth: 480,
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
		backgroundColor: '#151513',
		// macOS takes the icon from the bundle; the others need it passed here,
		// including when running unpackaged from source.
		...(process.platform === 'darwin' ? {} : { icon: join(here, '..', 'build', 'icon.png') }),
		webPreferences: {
			preload: join(here, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	mainWindow.loadFile(join(here, 'renderer', 'index.html'));

	// With a menu bar item there, closing the window is "put it away": the app
	// stays running to keep counting down, and reopening it is one click.
	mainWindow.on('close', (event) => {
		if (quitting || !store?.state.settings?.tray) return;
		event.preventDefault();
		mainWindow.hide();
	});

	return mainWindow;
}

function showWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) createWindow();
	else mainWindow.show();
	mainWindow.focus();
}

const send = (channel, payload) => mainWindow?.webContents.send(channel, payload);

/** The whole state as the renderer wants it. */
const fullState = () => ({ ...store.state, availability: store.availability(), version: app.getVersion() });

/**
 * Everything that watches the accounts, brought up to date at once.
 *
 * Called after any refresh and after any settings change, so the menu bar, the
 * timers and the window never disagree about what was last seen.
 */
function republish() {
	menuBar?.update(store.state.accounts, store.state.settings);
	alerts?.enabled(store.state.settings.notifications);
	alerts?.update(store.state.accounts);
	scheduleAutoRefresh();
}

let autoRefreshTimer = null;

/**
 * The one poll there is, and it is measured from the last refresh rather than
 * from a fixed clock: refreshing by hand pushes the next automatic one a whole
 * interval away instead of asking again minutes later.
 *
 * It lives in the main process so it keeps running with the window closed —
 * with a menu bar item, that is the normal state.
 */
function scheduleAutoRefresh() {
	clearTimeout(autoRefreshTimer);
	autoRefreshTimer = null;

	const minutes = store.state.settings.refreshEveryMinutes;
	if (!minutes || store.state.accounts.length === 0) return;

	const due = (store.state.lastRefreshAt ?? 0) + minutes * 60000;
	// Never sooner than a minute: at launch the window does its own catch-up
	// refresh, and two requests a second apart would be one too many.
	const wait = Math.max(60000, Math.min(due - Date.now(), MAX_DELAY));

	autoRefreshTimer = setTimeout(() => {
		if (Date.now() - (store.state.lastRefreshAt ?? 0) >= minutes * 60000) refreshFromMain();
		else scheduleAutoRefresh();
	}, wait);
}

function applyTraySetting() {
	const wanted = Boolean(store.state.settings.tray);
	if (wanted && !menuBar) {
		menuBar = new MenuBar({
			onOpen: showWindow,
			onRefresh: () => refreshFromMain(),
			onSetting: (key, value) => applySetting(key, value),
			onQuit: () => {
				quitting = true;
				app.quit();
			},
		});
	} else if (!wanted && menuBar) {
		menuBar.destroy();
		menuBar = null;
		// Without the item there is nothing left to reopen the app from, so the
		// window must not be hidden behind a closed button any more.
		if (mainWindow?.isDestroyed() === false && !mainWindow.isVisible()) mainWindow.show();
	}
}

async function applySetting(key, value) {
	await store.setSetting(key, value);
	applyTraySetting();
	republish();
	send('state:changed', fullState());
	return fullState();
}

/**
 * A refresh the window did not ask for — from the menu bar, or from a window
 * having just reset. The result is pushed to the renderer so an open window
 * does not sit on numbers the menu bar has already replaced.
 */
async function refreshFromMain() {
	await store.refreshAll();
	republish();
	send('state:changed', fullState());
}

app.whenReady().then(async () => {
	store = new AccountStore(app.getPath('userData'));
	await store.load();

	journal = new BridgeJournal(app.getPath('userData'));
	await journal.load();

	alerts = new Alerts({
		notify: ({ title, body }) => {
			if (!Notification.isSupported()) return;
			const note = new Notification({ title, body });
			note.on('click', showWindow);
			note.show();
		},
		refresh: () => refreshFromMain(),
	});

	createWindow();
	applyTraySetting();
	// Seeds what has been seen without announcing it: everything true at launch
	// is already on the cards.
	republish();

	// A timer set before the lid closed fires late, and the schedule it belonged
	// to may have been overtaken entirely while the machine slept.
	powerMonitor.on('resume', () => republish());

	app.on('activate', () => {
		showWindow();
	});
});

app.on('before-quit', () => {
	quitting = true;
});

app.on('window-all-closed', () => {
	// The menu bar item is the app when no window is open; quitting would take
	// the countdown with it.
	if (process.platform !== 'darwin' && !store?.state.settings?.tray) app.quit();
});

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('state:get', () => fullState());

ipcMain.handle('updates:check', () => checkForUpdate(app.getVersion()));

ipcMain.handle('settings:set', (_event, { key, value }) => applySetting(key, value));

ipcMain.handle('accounts:refresh', async () => {
	await store.refreshAll();
	republish();
	return fullState();
});

ipcMain.handle('accounts:rename', async (_event, { id, label }) => {
	await store.rename(id, label);
	republish();
	return fullState();
});

ipcMain.handle('accounts:remove', async (_event, id) => {
	await store.remove(id);
	republish();
	return fullState();
});

ipcMain.handle('shell:open', (_event, url) => {
	// Only ever a provider authorization URL, which the main process produced.
	if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});

/**
 * Starts a sign-in. Progress arrives on 'login:progress' rather than as a
 * return value, because the flow is interactive and can take minutes.
 */
ipcMain.handle('accounts:add', async (_event, { provider, label }) => {
	if (pendingLogin) throw new Error('a sign-in is already in progress');

	const controller = new AbortController();
	let resolveCode;
	pendingLogin = { controller, supplyCode: (code) => resolveCode?.(code) };

	try {
		const account = await store.add(
			{ provider, label },
			{
				signal: controller.signal,
				onUrl: (url) => {
					shell.openExternal(url);
					send('login:progress', { stage: 'browser', url });
				},
				onNeedCode: () =>
					new Promise((resolve, reject) => {
						resolveCode = resolve;
						send('login:progress', { stage: 'code' });
						controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
					}),
			},
		);
		send('login:progress', { stage: 'done', account });
		return account;
	} finally {
		pendingLogin = null;
	}
});

ipcMain.handle('accounts:supplyCode', (_event, code) => {
	if (!pendingLogin) throw new Error('no sign-in is waiting for a code');
	pendingLogin.supplyCode(String(code).trim());
});

ipcMain.handle('accounts:cancelAdd', () => {
	pendingLogin?.controller.abort();
	pendingLogin = null;
});

/* ------------------------------------------------- Claude Code sessions */

// Passed only so the index's account UUIDs can be given readable names; the
// sessions themselves come from the desktop app's index.
const configDirs = () => store.claudeConfigDirs();

/**
 * Says which account each session's Remote Control link belongs to.
 *
 * Done here rather than in the scan because the answer depends on what this app
 * remembers moving, which is state the scan has no business knowing about.
 */
function withBridgeState(view) {
	for (const project of view.projects) {
		for (const [columnId, sessions] of Object.entries(project.byAccount)) {
			for (const session of sessions) {
				const { state, via } = bridgeState({
					bridges: session.bridges,
					accountId: columnId,
					owners: journal.owners(),
					origin: journal.originOf(session.cliSessionId),
					duplicated: session.duplicated,
				});
				session.bridge = state;
				session.bridgeVia = via;
			}
		}
	}
	return view;
}

const scan = async () => withBridgeState(await scanEverything(configDirs()));

ipcMain.handle('sessions:scan', () => scan());

/**
 * Asks each Claude account what Remote Control sessions the server has for it.
 *
 * Only ever on request. There is no automatic run, and that is not caution but
 * arithmetic: the server cannot resolve a local link to an account (see
 * remote.js), so there is nothing an automatic run could settle.
 *
 * The whole thing is wrapped: this is the one place the app talks to an
 * undocumented endpoint, and nothing else may depend on the answer.
 */
/**
 * Every config directory worth asking, and which index account each stands for.
 *
 * The link between the two is the organisation id, which both sides report. A
 * directory whose organisation matches several index accounts, or none, is kept
 * — its sessions are still worth listing — but carries no account, which is what
 * stops matching from attributing anything to it.
 */
async function remoteTargets(view) {
	const targets = [];
	const emails = new Set();

	const columnsFor = (orgId) => (view?.accounts ?? []).filter((a) => a.orgUuid === orgId).map((a) => a.id);

	for (const account of store.state.accounts) {
		if (account.provider !== 'claude') continue;
		const dir = store.dirFor(account.id);
		const who = await identifyRoot(dir).catch(() => null);
		targets.push({ dir, label: account.label, accounts: who?.orgId ? columnsFor(who.orgId) : [] });
		if (account.email) emails.add(account.email);
	}

	// The plain `claude` on the PATH is an identity too, and usually the one with
	// the most history behind it — but it is often signed in as an account already
	// registered here, and listing one account twice under two names would read as
	// two accounts that happen to agree.
	const fallback = await identifyRoot(DEFAULT_CONFIG_DIR).catch(() => null);
	if (fallback?.loggedIn && !(fallback.email && emails.has(fallback.email))) {
		targets.unshift({
			dir: DEFAULT_CONFIG_DIR,
			label: fallback.email ?? 'default config',
			accounts: fallback.orgId ? columnsFor(fallback.orgId) : [],
		});
	}

	return targets;
}

ipcMain.handle('sessions:remote', async () => {
	try {
		const targets = await remoteTargets(await scan());
		if (!targets.length) return { accounts: [], note: 'no Claude account is signed in on this machine' };
		return { accounts: await remoteSessions(targets) };
	} catch (err) {
		return { accounts: [], note: String(err?.message ?? err).slice(0, 200) };
	}
});

/**
 * Attributes links to accounts by matching titles against the server lists.
 *
 * Refusals are returned alongside the attributions, and they are the larger
 * half of the answer: on the machine this was built against, ten titles matched
 * uniquely and only two could be attributed, because the other eight matched a
 * list two directories return identically. Reporting that is the difference
 * between a cautious feature and a wrong one.
 */
ipcMain.handle('sessions:matchRemote', async () => {
	try {
		const view = await scan();
		const targets = await remoteTargets(view);
		if (!targets.length) return { note: 'no Claude account is signed in on this machine' };

		const answers = await remoteSessions(targets);
		const sources = answers.map((answer, i) => ({ ...answer, accounts: targets[i]?.accounts ?? [] }));

		const sessions = [];
		for (const project of view.projects) {
			for (const [columnId, list] of Object.entries(project.byAccount)) {
				if (!list.length || columnId === CODEX) continue;
				for (const session of list) if (session.bridges?.length) sessions.push(session);
			}
		}

		const { owners, refused } = proposeOwners({ sessions, sources });
		const added = await journal.attribute(owners);

		return {
			matched: owners.length,
			added,
			refused,
			considered: sessions.length,
			unreadable: answers.filter((a) => !a.ok).map((a) => a.label),
			view: added ? await scan() : view,
		};
	} catch (err) {
		return { note: String(err?.message ?? err).slice(0, 200) };
	}
});

/**
 * Searching every transcript at once.
 *
 * One search at a time: typing another letter makes the one in flight useless,
 * so it is abandoned rather than left to finish and race the newer answer back.
 */
let searching = null;

ipcMain.handle('sessions:search', async (_event, { query, targets }) => {
	searching?.abort();
	const controller = new AbortController();
	searching = controller;

	try {
		return await searchTranscripts({ targets, query, signal: controller.signal });
	} catch (err) {
		return { results: [], scanned: 0, complete: false, note: String(err?.message ?? err).slice(0, 200) };
	} finally {
		if (searching === controller) searching = null;
	}
});

/**
 * The brief for one project.
 *
 * Reading transcripts is the expensive thing this app does, so it happens only
 * when asked for and only over the recent end of the list — see digest.js.
 */
ipcMain.handle('sessions:digest', async (_event, request) => {
	const digest = await buildDigest(request);
	return { digest, markdown: digestMarkdown(digest) };
});

ipcMain.handle('sessions:saveDigest', async (_event, { markdown, cwd }) => {
	const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
		title: 'Save project brief',
		defaultPath: `${String(cwd ?? 'project').split(/[/\\]/).pop() || 'project'}-brief.md`,
		filters: [{ name: 'Markdown', extensions: ['md'] }],
	});
	if (canceled || !filePath) return null;

	await writeFile(filePath, markdown);
	return { path: filePath };
});

ipcMain.handle('sessions:forgetMatches', async () => {
	try {
		await journal.forgetAttributions();
		return { view: await scan() };
	} catch (err) {
		return { note: String(err?.message ?? err).slice(0, 200) };
	}
});

ipcMain.handle('sessions:move', async (_event, request) => {
	const { bridges } = await moveSession(request);

	// Written after the move rather than before: a move that threw would
	// otherwise leave a note about something that never happened.
	if (bridges.length && request.fromAccount) {
		await journal.record({ cliSessionId: request.cliSessionId, bridges, fromAccount: request.fromAccount });
	}
	// Back where its links were minted: the note has served its purpose.
	if (request.toAccount) await journal.settle(request.cliSessionId, request.toAccount);

	return scan();
});

// Giving an account a transcript nothing had claimed: the desktop app lists
// only what its index names, so this writes the entry it was missing.
ipcMain.handle('sessions:adopt', async (_event, request) => {
	await adoptSession(request);
	return scan();
});

ipcMain.handle('sessions:rename', async (_event, { tool, entryFile, threadId, title }) => {
	if (tool === CODEX) await renameCodexSession(DEFAULT_CODEX_HOME, threadId, title);
	else await renameSession(entryFile, title);
	return scan();
});

ipcMain.handle('sessions:delete', async (_event, { tool, entryFile, threadId, title }) => {
	const { response } = await dialog.showMessageBox(mainWindow, {
		type: 'warning',
		buttons: ['Delete', 'Cancel'],
		defaultId: 1,
		cancelId: 1,
		message: `Delete "${title}"?`,
		detail: 'The conversation and its transcript are removed from this machine. This cannot be undone.',
	});
	if (response !== 0) return null;

	if (tool === CODEX) await deleteCodexSession(DEFAULT_CODEX_HOME, threadId);
	else await deleteSession(entryFile);
	return scan();
});

ipcMain.handle('sessions:export', async (_event, { tool, transcript, title }) => {
	if (!transcript) throw new Error('this session has no transcript on disk to export');

	const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
		title: 'Export session',
		defaultPath: `${String(title ?? 'session').replace(/[/\\:]/g, '-').slice(0, 80)}.md`,
		filters: [{ name: 'Markdown', extensions: ['md'] }],
	});
	if (canceled || !filePath) return null;

	const conversation = await readConversation(transcript, tool === CODEX ? 'codex' : 'claude');
	await writeFile(filePath, toMarkdown({ ...conversation, title: title ?? conversation.title }, tool === CODEX ? 'codex' : 'claude'));
	return { path: filePath, messages: conversation.messages.length };
});

/**
 * Copies a conversation to the other tool.
 *
 * Confirmed first, because it is not the move the same gesture performs between
 * accounts: the formats differ, so only the dialogue crosses over.
 */
ipcMain.handle('sessions:transfer', async (_event, { fromTool, transcript, title, toAccountPath }) => {
	const source = fromTool === CODEX ? 'codex' : 'claude';
	const target = source === 'codex' ? 'Claude Code' : 'Codex';

	const { response } = await dialog.showMessageBox(mainWindow, {
		type: 'warning',
		buttons: [`Copy to ${target}`, 'Cancel'],
		defaultId: 1,
		cancelId: 1,
		message: `Copy this session to ${target}?`,
		detail:
			'The two tools store conversations differently, so this copies rather than moves, and only the dialogue crosses over. ' +
			'Tool calls, their results and reasoning are not carried across — the files on disk remain the record of what was done. ' +
			'The original session stays where it is.',
	});
	if (response !== 0) return null;

	if (!transcript) throw new Error('this session has no transcript on disk to copy');

	const conversation = await readConversation(transcript, source);
	const name = importedTitle(source, title ?? conversation.title);
	const payload = { ...conversation, title: name, preamble: preamble(source, title ?? conversation.title) };

	if (source === 'codex') await importIntoClaude(toAccountPath, payload);
	else await importIntoCodex(DEFAULT_CODEX_HOME, payload);

	return scan();
});

ipcMain.handle('accounts:confirmRemove', async (_event, label) => {
	const { response } = await dialog.showMessageBox(mainWindow, {
		type: 'warning',
		buttons: ['Remove', 'Cancel'],
		defaultId: 1,
		cancelId: 1,
		message: `Remove "${label}"?`,
		detail: 'Its stored usage is deleted and this machine signs out of the account. The account itself is untouched.',
	});
	return response === 0;
});

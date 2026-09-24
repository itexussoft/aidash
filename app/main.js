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
	mergeIndexRoot,
	listIndexAccounts,
	clearAccountBridges,
	repairIndex,
	importConversation as importIntoClaude,
	THIRD_PARTY_ROOT,
	CODEX,
} from './src/sessions.js';
import { openInstance, readIndexRoot } from './src/instances.js';
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
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { checkForUpdate } from './src/updates.js';
import { readNotes } from './src/notes.js';

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

/**
 * The shipped changelog.
 *
 * Read from beside the app rather than fetched, so what the About tab says
 * about this build cannot disagree with the build, and says it offline.
 */
ipcMain.handle('notes:get', () => readNotes(join(here, '..', 'CHANGELOG.md')));

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
 * Runs an interactive sign-in and reports it to the window.
 *
 * Adding an account and signing an existing one in again are the same flow over
 * a different destination, so both come through here — and both are held to one
 * at a time, since the two would otherwise race for the same code box. Progress
 * arrives on 'login:progress' rather than as a return value, because the flow
 * can take minutes and blocks mid-way waiting for the browser.
 */
async function runSignIn(body) {
	if (pendingLogin) throw new Error('a sign-in is already in progress');

	const controller = new AbortController();
	let resolveCode;
	pendingLogin = { controller, supplyCode: (code) => resolveCode?.(code) };

	try {
		return await body({
			signal: controller.signal,
			onUrl: (url) => {
				shell.openExternal(url);
				send('login:progress', { stage: 'browser', url });
			},
			// GitHub's device flow runs the other way round to Claude's: the app is
			// given the code and the browser asks for it. The page is opened here
			// rather than by the provider so that showing the code and opening the
			// page stay one event, and the interface never replaces the step
			// carrying the code with one that does not.
			onDeviceCode: ({ code, url }) => {
				send('login:progress', { stage: 'device', code, url });
				shell.openExternal(url);
			},
			// A sign-in that happens inside another application entirely, which the
			// provider has just launched. Nothing to open and no code to pass — only
			// something to say, so the window does not look stuck.
			onExternal: ({ note }) => send('login:progress', { stage: 'external', note }),
			onNeedCode: () =>
				new Promise((resolve, reject) => {
					resolveCode = resolve;
					send('login:progress', { stage: 'code' });
					controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
				}),
		});
	} finally {
		pendingLogin = null;
	}
}

ipcMain.handle('accounts:add', async (_event, { provider, label }) => {
	const account = await runSignIn((hooks) => store.add({ provider, label }, hooks));
	send('login:progress', { stage: 'done', account });
	return account;
});

/**
 * Signs an existing account in again, keeping its id.
 *
 * Returns whether the sign-in landed on a different person as well as the new
 * state: the card, the credential folder and any separate instance all stay
 * with the id, so a swapped identity is worth saying rather than leaving to be
 * noticed on the card later.
 */
ipcMain.handle('accounts:reauthorize', async (_event, id) => {
	const { account, switched } = await runSignIn((hooks) => store.reauthorize(id, hooks));
	send('login:progress', { stage: 'done', account });
	republish();
	return { state: fullState(), account, switched };
});

ipcMain.handle('accounts:supplyCode', (_event, code) => {
	if (!pendingLogin) throw new Error('no sign-in is waiting for a code');
	pendingLogin.supplyCode(String(code).trim());
});

ipcMain.handle('accounts:cancelSignIn', () => {
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

/**
 * Repairs what an earlier version broke, then reads. In that order, so the view
 * already shows the repaired entries; `repaired` says what changed, because the
 * desktop app only sees it after a restart and somebody has to say so.
 */
const scan = async () => {
	const roots = await store.indexRoots();
	const repaired = await repairIndex(roots);
	return { ...withBridgeState(await scanEverything(configDirs(), DEFAULT_CODEX_HOME, roots)), repaired };
};

/* ----------------------------------------------------- separate instances */

/**
 * Opens an account's own copy of Claude Desktop, creating its profile on first
 * use. The directory being there is what makes the instance exist, so this is
 * also what registers it — see AccountStore.indexRoots().
 */
ipcMain.handle('instances:open', async (_event, accountId) => {
	const account = store.state.accounts.find((a) => a.id === accountId);
	if (!account) throw new Error('no such account');
	if (account.provider !== 'claude') throw new Error('separate instances are a Claude Desktop feature');

	const dir = store.instanceDirFor(accountId);
	const first = !(await store.hasInstance(accountId));
	await mkdir(dir, { recursive: true });

	openInstance(dir);
	return { first, dir, view: await scan() };
});

/** How many entries a root holds, for a confirmation that can be specific. */
async function countEntries(root) {
	let entries = 0;
	for (const account of await listIndexAccounts([root])) {
		entries += (await readdir(account.path)).filter((f) => f.endsWith('.json')).length;
	}
	return entries;
}

/**
 * Folds a secondary index into the main profile and retires it.
 *
 * One gesture, because the two halves are not separately useful: an emptied
 * instance is a signed-in copy of the app with nothing in it, and a merge that
 * left it standing would refill it the next time it was opened.
 *
 * What "retire" means differs by where the folder came from, and the
 * confirmation says which: an instance this app created is deleted, while a
 * folder someone pointed at by hand is only forgotten. Deleting a directory the
 * app did not create is not ours to do.
 */
ipcMain.handle('instances:merge', async (_event, rootId) => {
	const root = (await store.indexRoots()).find((r) => r.id === rootId);
	if (!root) throw new Error('no such folder');
	if (root.kind === 'main') throw new Error('this is the main profile — there is nothing to merge it into');
	// Merging would empty the list that mode reads, and retiring it is not ours.
	if (root.kind === 'third-party') throw new Error('this is the third-party mode’s own list — move sessions one at a time instead');

	const entries = await countEntries(root);
	const owned = root.kind === 'instance';

	const { response } = await dialog.showMessageBox(mainWindow, {
		type: 'warning',
		buttons: ['Merge and remove', 'Cancel'],
		defaultId: 1,
		cancelId: 1,
		message: `Merge "${root.label ?? rootId}" into the main profile?`,
		detail:
			`${entries} session${entries === 1 ? '' : 's'} move into the main Claude Desktop profile, under the same account. ` +
			'They appear there once it is signed in as that account. Transcripts are shared and are not touched. ' +
			(owned
				? 'This separate instance is then deleted, so opening one for this account again starts from a fresh sign-in. Quit that copy first.'
				: 'This folder is then forgotten by aidash. Nothing on disk is deleted.'),
	});
	if (response !== 0) return null;

	const { moved, skipped, carried } = await mergeIndexRoot({ from: root });

	// Same note a single move leaves, for the same reason: afterwards nothing on
	// disk says which profile a Remote Control link was minted in.
	for (const note of carried) await journal.record(note);

	if (owned) await rm(root.profile, { recursive: true, force: true });
	else await store.removeSessionRoot(root.id);

	return { moved, skipped, owned, view: await scan() };
});

/* ----------------------------------------------------------- extra folders */

ipcMain.handle('roots:add', async () => {
	const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
		title: 'Choose a Claude Desktop profile',
		message: 'Pick the user data folder of another copy of Claude Desktop, or the claude-code-sessions folder inside it',
		properties: ['openDirectory'],
	});
	if (canceled || !filePaths[0]) return null;

	const found = await readIndexRoot(filePaths[0]);
	if (!found) throw new Error('there is no Claude Desktop session index in that folder');

	await store.addSessionRoot({ ...found, label: null });
	return { view: await scan() };
});

ipcMain.handle('roots:forget', async (_event, id) => {
	await store.removeSessionRoot(id);
	return { view: await scan() };
});

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

/**
 * Clears every Remote Control link recorded for one account.
 *
 * Confirmed with a real dialog, because it edits the same file the desktop
 * app reads — and says plainly what it does not do: nothing on the server is
 * touched, so a link that is still genuinely live keeps running until Claude
 * Code itself is quit or told to stop it.
 */
ipcMain.handle('sessions:clearRemoteLinks', async (_event, accountId) => {
	const before = await scan();
	const account = before.accounts.find((a) => a.id === accountId);
	if (!account) throw new Error('no such account — rescan and try again');

	const { response } = await dialog.showMessageBox(mainWindow, {
		type: 'warning',
		buttons: ['Clear links', 'Cancel'],
		defaultId: 1,
		cancelId: 1,
		message: `Clear every Remote Control link for "${account.email ?? account.accountUuid}"?`,
		detail:
			"This edits the local record only — the same one Claude Desktop itself reads, so both stop treating these sessions " +
			"as remote-controlled. It does not stop anything genuinely still running on the server: if a session is still live, " +
			"quit Claude Code, or use `claude remote-control` / `/remote-control`, to actually stop it there. " +
			'Remote Control can be turned on again per session afterwards, as normal.',
	});
	if (response !== 0) return null;

	const { cleared, clearedIds } = await clearAccountBridges(account.path);
	if (clearedIds.length) await journal.forgetLinks(clearedIds);

	return { cleared, view: await scan() };
});

// Decided here from the column ids, not taken from the page: which side of the
// line a column is on is a fact about where its index lives.
const onThirdParty = (columnId) => Boolean(columnId?.startsWith(`${THIRD_PARTY_ROOT.id}:`));

ipcMain.handle('sessions:move', async (_event, request) => {
	const retarget = onThirdParty(request.fromAccount) !== onThirdParty(request.toAccount);
	const { bridges, model } = await moveSession({ ...request, retarget });

	// Written after the move rather than before: a move that threw would
	// otherwise leave a note about something that never happened.
	if (bridges.length && request.fromAccount) {
		await journal.record({ cliSessionId: request.cliSessionId, bridges, fromAccount: request.fromAccount });
	}
	// Back where its links were minted: the note has served its purpose.
	if (request.toAccount) await journal.settle(request.cliSessionId, request.toAccount);

	return { ...(await scan()), retargeted: model };
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

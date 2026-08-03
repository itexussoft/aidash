/**
 * Electron main process.
 *
 * Holds the account registry and drives the vendor clients. The renderer never
 * touches credentials or spawns anything — it asks for state and reports what
 * the user did.
 */

import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountStore } from './src/accounts.js';
import { scanAll, moveSession, adoptSession } from './src/sessions.js';
import { checkForUpdate } from './src/updates.js';

const here = dirname(fileURLToPath(import.meta.url));

let store;
let mainWindow;

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
	return mainWindow;
}

const send = (channel, payload) => mainWindow?.webContents.send(channel, payload);

app.whenReady().then(async () => {
	store = new AccountStore(app.getPath('userData'));
	await store.load();
	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('state:get', () => ({
	...store.state,
	availability: store.availability(),
	version: app.getVersion(),
}));

ipcMain.handle('updates:check', () => checkForUpdate(app.getVersion()));

ipcMain.handle('accounts:refresh', async () => {
	const state = await store.refreshAll();
	return { ...state, availability: store.availability() };
});

ipcMain.handle('accounts:rename', async (_event, { id, label }) => {
	const state = await store.rename(id, label);
	return { ...state, availability: store.availability() };
});

ipcMain.handle('accounts:remove', async (_event, id) => {
	await store.remove(id);
	return { ...store.state, availability: store.availability() };
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

ipcMain.handle('sessions:scan', () => scanAll(configDirs()));

ipcMain.handle('sessions:move', async (_event, request) => {
	await moveSession(request);
	return scanAll(configDirs());
});

// Giving an account a transcript nothing had claimed: the desktop app lists
// only what its index names, so this writes the entry it was missing.
ipcMain.handle('sessions:adopt', async (_event, request) => {
	await adoptSession(request);
	return scanAll(configDirs());
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

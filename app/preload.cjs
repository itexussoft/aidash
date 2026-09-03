/**
 * The renderer's entire surface.
 *
 * Deliberately narrow: the window can ask for state and report user intent, but
 * cannot spawn processes, read credentials, or open arbitrary URLs.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidash', {
	getState: () => ipcRenderer.invoke('state:get'),
	refresh: () => ipcRenderer.invoke('accounts:refresh'),

	addAccount: (provider, label) => ipcRenderer.invoke('accounts:add', { provider, label }),
	// Same flow as adding, aimed at an account that already exists: the id, its
	// credential folder and its separate instance all stay put.
	reauthorizeAccount: (id) => ipcRenderer.invoke('accounts:reauthorize', id),
	supplyCode: (code) => ipcRenderer.invoke('accounts:supplyCode', code),
	cancelSignIn: () => ipcRenderer.invoke('accounts:cancelSignIn'),

	renameAccount: (id, label) => ipcRenderer.invoke('accounts:rename', { id, label }),
	confirmRemove: (label) => ipcRenderer.invoke('accounts:confirmRemove', label),
	removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),

	openUrl: (url) => ipcRenderer.invoke('shell:open', url),
	checkForUpdate: () => ipcRenderer.invoke('updates:check'),
	releaseNotes: () => ipcRenderer.invoke('notes:get'),
	setSetting: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),

	// A second copy of Claude Desktop per account, and the folders it leaves.
	instances: {
		open: (accountId) => ipcRenderer.invoke('instances:open', accountId),
		merge: (rootId) => ipcRenderer.invoke('instances:merge', rootId),
		addRoot: () => ipcRenderer.invoke('roots:add'),
		forgetRoot: (id) => ipcRenderer.invoke('roots:forget', id),
	},

	sessions: {
		scan: () => ipcRenderer.invoke('sessions:scan'),
		move: (request) => ipcRenderer.invoke('sessions:move', request),
		adopt: (request) => ipcRenderer.invoke('sessions:adopt', request),
		transfer: (request) => ipcRenderer.invoke('sessions:transfer', request),
		rename: (request) => ipcRenderer.invoke('sessions:rename', request),
		remove: (request) => ipcRenderer.invoke('sessions:delete', request),
		export: (request) => ipcRenderer.invoke('sessions:export', request),
		remote: () => ipcRenderer.invoke('sessions:remote'),
		matchRemote: () => ipcRenderer.invoke('sessions:matchRemote'),
		search: (request) => ipcRenderer.invoke('sessions:search', request),
		digest: (request) => ipcRenderer.invoke('sessions:digest', request),
		saveDigest: (request) => ipcRenderer.invoke('sessions:saveDigest', request),
		forgetMatches: () => ipcRenderer.invoke('sessions:forgetMatches'),
		clearRemoteLinks: (accountId) => ipcRenderer.invoke('sessions:clearRemoteLinks', accountId),
	},

	onLoginProgress: (handler) => {
		const listener = (_event, payload) => handler(payload);
		ipcRenderer.on('login:progress', listener);
		return () => ipcRenderer.removeListener('login:progress', listener);
	},

	// State can now change without the window asking: the menu bar can refresh,
	// and so can a window that has just reset.
	onStateChanged: (handler) => {
		const listener = (_event, payload) => handler(payload);
		ipcRenderer.on('state:changed', listener);
		return () => ipcRenderer.removeListener('state:changed', listener);
	},
});

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
	supplyCode: (code) => ipcRenderer.invoke('accounts:supplyCode', code),
	cancelAdd: () => ipcRenderer.invoke('accounts:cancelAdd'),

	renameAccount: (id, label) => ipcRenderer.invoke('accounts:rename', { id, label }),
	confirmRemove: (label) => ipcRenderer.invoke('accounts:confirmRemove', label),
	removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),

	openUrl: (url) => ipcRenderer.invoke('shell:open', url),
	checkForUpdate: () => ipcRenderer.invoke('updates:check'),

	sessions: {
		scan: () => ipcRenderer.invoke('sessions:scan'),
		move: (request) => ipcRenderer.invoke('sessions:move', request),
		adopt: (request) => ipcRenderer.invoke('sessions:adopt', request),
		transfer: (request) => ipcRenderer.invoke('sessions:transfer', request),
		rename: (request) => ipcRenderer.invoke('sessions:rename', request),
		remove: (request) => ipcRenderer.invoke('sessions:delete', request),
		export: (request) => ipcRenderer.invoke('sessions:export', request),
	},

	onLoginProgress: (handler) => {
		const listener = (_event, payload) => handler(payload);
		ipcRenderer.on('login:progress', listener);
		return () => ipcRenderer.removeListener('login:progress', listener);
	},
});

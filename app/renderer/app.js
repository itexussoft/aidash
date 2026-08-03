/**
 * Renderer wiring.
 *
 * Talks to the main process through the narrow `window.aidash` bridge — it has
 * no access to credentials, processes or the filesystem.
 */

import { renderCard, refreshLabel, escapeHtml } from './render.js';
import { rescan as rescanSessions } from './utils.js';

// Opening the window refreshes when the data is older than this. There is no
// background polling: the app only reaches out while you are looking at it.
const AUTO_REFRESH_AFTER_MS = 10 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

const grid = $('#grid');
const empty = $('#empty');
const countTag = $('#count');
const refreshBtn = $('#refresh');
const refreshedLabel = $('#refreshed');

const dialog = $('#add-dialog');
const providersBox = $('#providers');
const labelInput = $('#label');
const codeInput = $('#code');
const addError = $('#add-error');
const nextBtn = $('#add-next');
const cancelBtn = $('#add-cancel');
const authUrlBtn = $('#auth-url');

let state = { accounts: [], lastRefreshAt: null, availability: {} };
let chosenProvider = null;
let addInFlight = null;

/* ------------------------------------------------------------------ render */

function paint() {
	const { accounts, lastRefreshAt } = state;

	empty.hidden = accounts.length > 0;
	grid.hidden = accounts.length === 0;
	countTag.textContent = accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : '';
	refreshBtn.hidden = accounts.length === 0;
	refreshedLabel.hidden = accounts.length === 0;
	refreshedLabel.textContent = refreshLabel(lastRefreshAt);

	grid.innerHTML = accounts.map(renderCard).join('');

	for (const btn of grid.querySelectorAll('button.remove')) {
		btn.addEventListener('click', async () => {
			if (!(await window.aidash.confirmRemove(btn.dataset.label))) return;
			btn.textContent = 'removing…';
			state = await window.aidash.removeAccount(btn.dataset.id);
			paint();
		});
	}
}

async function refresh() {
	refreshBtn.disabled = true;
	refreshBtn.textContent = 'refreshing…';
	try {
		state = await window.aidash.refresh();
	} finally {
		refreshBtn.disabled = false;
		refreshBtn.textContent = 'refresh now';
		paint();
	}
}

/* ------------------------------------------------------------- add account */

function showStep(name) {
	for (const step of document.querySelectorAll('.step')) step.hidden = step.dataset.step !== name;
	addError.hidden = true;
	nextBtn.hidden = name === 'browser';
	nextBtn.textContent = name === 'code' ? 'Finish' : 'Continue';
}

function paintProviders() {
	const options = [
		{ id: 'codex', name: 'Codex', missing: 'Codex is not installed on this machine' },
		{ id: 'claude', name: 'Claude', missing: 'Claude Code is not installed on this machine' },
	];

	// Unavailable providers stay visible with the reason: a missing client is
	// usually the thing the user most needs to know.
	providersBox.innerHTML = options
		.map((o) => {
			const available = state.availability?.[o.id];
			return `<button type="button" class="provider" data-provider="${o.id}" ${available ? '' : 'disabled'}>
          <span class="pname">${escapeHtml(o.name)}</span>
          ${available ? '' : `<span class="pnote">${escapeHtml(o.missing)}</span>`}
        </button>`;
		})
		.join('');

	for (const btn of providersBox.querySelectorAll('.provider')) {
		btn.addEventListener('click', () => {
			chosenProvider = btn.dataset.provider;
			for (const other of providersBox.querySelectorAll('.provider')) other.classList.toggle('chosen', other === btn);
		});
	}

	const firstAvailable = options.find((o) => state.availability?.[o.id]);
	chosenProvider = firstAvailable?.id ?? null;
	providersBox.querySelector(`[data-provider="${chosenProvider}"]`)?.classList.add('chosen');
}

function openAddDialog() {
	chosenProvider = null;
	labelInput.value = '';
	codeInput.value = '';
	paintProviders();
	showStep('choose');
	dialog.showModal();
}

function failAdd(message) {
	addError.textContent = message;
	addError.hidden = false;
	showStep('choose');
	nextBtn.disabled = false;
}

async function beginAdd() {
	if (!chosenProvider) return failAdd('Pick a provider first.');
	if (!labelInput.value.trim()) return failAdd('Give the account a name.');

	nextBtn.disabled = true;
	showStep('browser');

	addInFlight = window.aidash
		.addAccount(chosenProvider, labelInput.value.trim())
		.then(async () => {
			dialog.close();
			await refresh();
		})
		.catch((err) => failAdd(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*/, '')))
		.finally(() => {
			addInFlight = null;
			nextBtn.disabled = false;
		});
}

window.aidash.onLoginProgress((progress) => {
	if (progress.stage === 'browser') {
		showStep('browser');
		authUrlBtn.textContent = progress.url;
		authUrlBtn.onclick = () => window.aidash.openUrl(progress.url);
	}
	if (progress.stage === 'code') {
		showStep('code');
		codeInput.focus();
	}
});

nextBtn.addEventListener('click', () => {
	const current = [...document.querySelectorAll('.step')].find((s) => !s.hidden)?.dataset.step;
	if (current === 'choose') return beginAdd();
	if (current === 'code') {
		const code = codeInput.value.trim();
		if (!code) return;
		nextBtn.disabled = true;
		showStep('browser');
		$('.step[data-step="browser"] .status').textContent = 'Finishing sign-in…';
		window.aidash.supplyCode(code);
	}
});

cancelBtn.addEventListener('click', async () => {
	await window.aidash.cancelAdd();
	dialog.close();
});

dialog.addEventListener('cancel', (e) => {
	// Escape must not leave a sign-in running invisibly in the background.
	e.preventDefault();
	cancelBtn.click();
});

$('#add').addEventListener('click', openAddDialog);
empty.querySelector('[data-action="add"]').addEventListener('click', openAddDialog);
refreshBtn.addEventListener('click', refresh);

/* ------------------------------------------------------------------ update */

// A dismissed version stays dismissed until a newer one appears, so the banner
// cannot become something the user learns to ignore.
const DISMISSED_KEY = 'aidash:dismissed-update';

async function checkUpdate() {
	const update = await window.aidash.checkForUpdate();
	if (!update || localStorage.getItem(DISMISSED_KEY) === update.version) return;

	$('#update-text').textContent = `Version ${update.version} is available${update.notes ? ` — ${update.notes}` : ''}`;
	$('#update-download').onclick = () => window.aidash.openUrl(update.downloadUrl);
	$('#update-dismiss').onclick = () => {
		localStorage.setItem(DISMISSED_KEY, update.version);
		$('#update-banner').hidden = true;
	};
	$('#update-banner').hidden = false;
}

/* -------------------------------------------------------------------- tabs */

// Scanning walks hundreds of transcripts, so it waits until the tab is first
// opened rather than delaying the window.
let sessionsLoaded = false;

for (const tab of document.querySelectorAll('.tab')) {
	tab.addEventListener('click', async () => {
		for (const other of document.querySelectorAll('.tab')) other.classList.toggle('chosen', other === tab);
		for (const page of document.querySelectorAll('.page')) page.hidden = page.dataset.page !== tab.dataset.tab;

		if (tab.dataset.tab === 'utils' && !sessionsLoaded) {
			sessionsLoaded = true;
			await rescanSessions();
		}
	});
}

/* -------------------------------------------------------------------- boot */

state = await window.aidash.getState();
paint();

if (state.accounts.length > 0) {
	const age = state.lastRefreshAt ? Date.now() - state.lastRefreshAt : Infinity;
	if (age > AUTO_REFRESH_AFTER_MS) refresh();
}

// Keep the elapsed time honest without re-rendering the cards.
setInterval(() => {
	refreshedLabel.textContent = refreshLabel(state.lastRefreshAt);
}, 30000);

// Never blocks the window: an unreachable manifest simply means no banner.
checkUpdate();

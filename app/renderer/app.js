/**
 * Renderer wiring.
 *
 * Talks to the main process through the narrow `window.aidash` bridge — it has
 * no access to credentials, processes or the filesystem.
 */

import { renderCard, refreshLabel, escapeHtml, applyBarWidths } from './render.js';
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

// Which provider groups are folded away, remembered across restarts so the
// window opens the way it was left.
const COLLAPSED_KEY = 'aidash:collapsed-groups';
const collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));

function toggleGroup(section) {
	const provider = section.dataset.provider;
	const nowCollapsed = !collapsed.has(provider);

	if (nowCollapsed) collapsed.add(provider);
	else collapsed.delete(provider);
	localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));

	section.classList.toggle('collapsed', nowCollapsed);
	section.querySelector('.group-grid').hidden = nowCollapsed;
	section.querySelector('.group-head').setAttribute('aria-expanded', String(!nowCollapsed));
}
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

	// Grouped by provider: the two measure usage in different terms, so reading
	// them as one list invites comparing numbers that are not comparable.
	const order = ['codex', 'claude'];
	const groups = order
		.map((provider) => ({ provider, items: accounts.filter((a) => a.provider === provider) }))
		.concat({ provider: 'other', items: accounts.filter((a) => !order.includes(a.provider)) })
		.filter((g) => g.items.length > 0);

	const names = { codex: 'Codex', claude: 'Claude', other: 'Other' };

	grid.innerHTML = groups
		.map(
			(group) => `
        <section class="provider-group ${collapsed.has(group.provider) ? 'collapsed' : ''}" data-provider="${escapeHtml(group.provider)}">
          <h2 class="group-head" role="button" tabindex="0" aria-expanded="${!collapsed.has(group.provider)}">
            <span class="group-caret">▼</span>
            ${escapeHtml(names[group.provider] ?? group.provider)}
            <span class="group-count">${group.items.length}</span>
          </h2>
          <div class="group-grid" ${collapsed.has(group.provider) ? 'hidden' : ''}>${group.items.map(renderCard).join('')}</div>
        </section>`,
		)
		.join('');
	applyBarWidths(grid);

	for (const head of grid.querySelectorAll('.group-head')) {
		const toggle = () => toggleGroup(head.closest('.provider-group'));
		head.addEventListener('click', toggle);
		head.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		});
	}

	for (const btn of grid.querySelectorAll('button.remove')) {
		btn.addEventListener('click', async () => {
			if (!(await window.aidash.confirmRemove(btn.dataset.label))) return;
			btn.textContent = 'removing…';
			state = await window.aidash.removeAccount(btn.dataset.id);
			paint();
		});
	}

	for (const btn of grid.querySelectorAll('button.rename')) {
		btn.addEventListener('click', () => openRename(btn.dataset.id, btn.dataset.label));
	}
}

/* ------------------------------------------------------------------ rename */

const renameDialog = $('#rename-dialog');
const renameInput = $('#rename-input');
const renameError = $('#rename-error');
let renamingId = null;

function openRename(id, label) {
	renamingId = id;
	renameInput.value = label;
	renameError.hidden = true;
	renameDialog.showModal();
	renameInput.select();
}

async function saveRename() {
	const label = renameInput.value.trim();
	if (!label) {
		renameError.textContent = 'A name is required.';
		renameError.hidden = false;
		return;
	}
	try {
		state = await window.aidash.renameAccount(renamingId, label);
		renameDialog.close();
		paint();
	} catch (err) {
		renameError.textContent = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*/, '');
		renameError.hidden = false;
	}
}

$('#rename-save').addEventListener('click', saveRename);
$('#rename-cancel').addEventListener('click', () => renameDialog.close());
renameInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault();
		saveRename();
	}
});

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
	// Until the provider hands back a URL there is nothing to show, and an empty
	// field reads as breakage. Say what is happening instead.
	$('.step[data-step="browser"] .status').textContent = 'Starting sign-in…';
	authUrlBtn.textContent = '';
	authUrlBtn.hidden = true;

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
		$('.step[data-step="browser"] .status').textContent = 'Waiting for you to sign in…';
		authUrlBtn.hidden = false;
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

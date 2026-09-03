/**
 * Renderer wiring.
 *
 * Talks to the main process through the narrow `window.aidash` bridge — it has
 * no access to credentials, processes or the filesystem.
 */

import { renderCard, refreshLabel, staleness, escapeHtml, applyBarWidths, ALPHA_PROVIDERS } from './render.js';
import { outlookHtml, applyOutlook } from './outlook.js';
import { rescan as rescanSessions } from './utils.js';
import { busy, done, failed, reason } from './notify.js';
import { icon } from './icons.js';

// Opening the window refreshes when the data is older than this. There is no
// background polling: the app only reaches out while you are looking at it.
const AUTO_REFRESH_AFTER_MS = 10 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

const grid = $('#grid');
const outlookBox = $('#outlook');
const empty = $('#empty');
const countTag = $('#count');
const refreshBtn = $('#refresh');
const refreshLabelSpan = $('#refresh-label');
const refreshedLabel = $('#refreshed');

// Injected rather than hand-copied into index.html, so icons.js stays the one
// place a glyph's path data lives.
refreshBtn.insertAdjacentHTML('afterbegin', icon('refresh'));
$('#add').insertAdjacentHTML('afterbegin', icon('plus'));

const dialog = $('#add-dialog');
const providersBox = $('#providers');
const labelInput = $('#label');
const codeInput = $('#code');
const addError = $('#add-error');
const nextBtn = $('#add-next');
const cancelBtn = $('#add-cancel');
const authUrlBtn = $('#auth-url');
const dialogTitle = $('#add-title');

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
// Which account the dialog is signing in again, when it is not adding one.
// The dialog is shared because the flow is identical past the first step.
let reauth = null;

/* ------------------------------------------------------------------ render */

/**
 * The summary above the cards.
 *
 * Kept separate from paint() because it says "resets in 3h", which stops being
 * true on its own — it is repainted on the clock as well as on new data. It
 * holds no state of its own, so redrawing it costs nothing.
 */
/** The age of the reading, and how much that age matters. */
function paintAge() {
	refreshedLabel.textContent = refreshLabel(state.lastRefreshAt);
	refreshedLabel.className = `head-meta aged ${staleness(state.lastRefreshAt)}`;
}

function paintOutlook() {
	const html = outlookHtml(state.accounts);
	outlookBox.hidden = !html;
	outlookBox.innerHTML = html;
	applyOutlook(outlookBox);
}

function paint() {
	const { accounts, lastRefreshAt } = state;

	empty.hidden = accounts.length > 0;
	grid.hidden = accounts.length === 0;
	countTag.textContent = accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : '';
	refreshBtn.hidden = accounts.length === 0;
	refreshedLabel.hidden = accounts.length === 0;
	paintAge();

	paintOutlook();

	// Grouped by provider: the two measure usage in different terms, so reading
	// them as one list invites comparing numbers that are not comparable.
	const order = ['codex', 'claude', 'copilot', 'cursor'];
	const groups = order
		.map((provider) => ({ provider, items: accounts.filter((a) => a.provider === provider) }))
		.concat({ provider: 'other', items: accounts.filter((a) => !order.includes(a.provider)) })
		.filter((g) => g.items.length > 0);

	const names = { codex: 'Codex', claude: 'Claude', copilot: 'Copilot', cursor: 'Cursor', other: 'Other' };

	grid.innerHTML = groups
		.map(
			(group) => `
        <section class="provider-group ${collapsed.has(group.provider) ? 'collapsed' : ''}" data-provider="${escapeHtml(group.provider)}">
          <h2 class="group-head" role="button" tabindex="0" aria-expanded="${!collapsed.has(group.provider)}">
            <span class="group-caret">▼</span>
            ${escapeHtml(names[group.provider] ?? group.provider)}
            ${ALPHA_PROVIDERS.has(group.provider) ? '<span class="alpha">alpha</span>' : ''}
            <span class="group-count">${group.items.length}</span>
          </h2>
          <div class="group-grid" ${collapsed.has(group.provider) ? 'hidden' : ''}>${group.items.map((a) => renderCard(a, state.availability)).join('')}</div>
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
			done('Account removed');
		});
	}

	for (const btn of grid.querySelectorAll('button.rename')) {
		btn.addEventListener('click', () => openRename(btn.dataset.id, btn.dataset.label));
	}

	for (const btn of grid.querySelectorAll('button.reauth')) {
		btn.addEventListener('click', () => beginReauth(btn.dataset.id, btn.dataset.label));
	}

	for (const btn of grid.querySelectorAll('button.instance')) {
		btn.addEventListener('click', async () => {
			btn.disabled = true;
			btn.textContent = 'opening…';
			try {
				const result = await window.aidash.instances.open(btn.dataset.id);
				// The first launch is the one worth explaining: it opens signed out,
				// which looks like a failure if nobody said so.
				done(
					result?.first
						? `Opened a separate instance for ${btn.dataset.label} — sign in there as that account`
						: `Opened the separate instance for ${btn.dataset.label}`,
				);
			} catch (err) {
				failed(reason(err));
			} finally {
				btn.disabled = false;
				btn.textContent = 'separate instance';
			}
		});
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
		done('Account renamed');
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
	// The label span only, so the icon prepended at startup survives the swap.
	refreshLabelSpan.textContent = 'Refreshing…';
	busy('Refreshing usage…');
	try {
		state = await window.aidash.refresh();
		// One card failing is reported on the card itself; this is about the run.
		const failedCount = state.accounts.filter((a) => a.lastError).length;
		if (failedCount) failed(`${failedCount} account${failedCount === 1 ? '' : 's'} could not be refreshed`);
		else done('Usage up to date');
	} catch (err) {
		failed(reason(err));
	} finally {
		refreshBtn.disabled = false;
		refreshLabelSpan.textContent = 'Refresh';
		paint();
	}
}

/* ------------------------------------------------------------- add account */

const NEXT_LABEL = { code: 'Finish', again: 'Try again' };

function showStep(name) {
	for (const step of document.querySelectorAll('.step')) step.hidden = step.dataset.step !== name;
	addError.hidden = true;
	nextBtn.hidden = name === 'browser';
	// Re-enabled here rather than by each caller: a step is shown because it is
	// the one waiting on the user, and the button that carries it forward was
	// disabled by whatever step came before. Missing this left "Finish" dead on
	// the code box — the one step of Claude's sign-in that cannot be skipped.
	nextBtn.disabled = false;
	nextBtn.textContent = NEXT_LABEL[name] ?? 'Continue';
}

function paintProviders() {
	const options = [
		{ id: 'codex', name: 'Codex', missing: 'Codex is not installed on this machine' },
		{ id: 'claude', name: 'Claude', missing: 'Claude Code is not installed on this machine' },
		{ id: 'copilot', name: 'Copilot', missing: 'The GitHub CLI (gh) is not installed on this machine' },
		{ id: 'cursor', name: 'Cursor', missing: 'Cursor is not installed on this machine' },
	];

	// Unavailable providers stay visible with the reason: a missing client is
	// usually the thing the user most needs to know.
	providersBox.innerHTML = options
		.map((o) => {
			const available = state.availability?.[o.id];
			return `<button type="button" class="provider" data-provider="${o.id}" ${available ? '' : 'disabled'}>
          <span class="pname">${escapeHtml(o.name)}${ALPHA_PROVIDERS.has(o.id) ? '<span class="alpha">alpha</span>' : ''}</span>
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
	reauth = null;
	chosenProvider = null;
	dialogTitle.textContent = 'Add an account';
	labelInput.value = '';
	codeInput.value = '';
	paintProviders();
	showStep('choose');
	dialog.showModal();
}

/**
 * Reports a sign-in that did not land, on the step that can act on it.
 *
 * Adding can go back and correct the provider or the name; signing an existing
 * account in again has neither, so it gets a step whose only offer is another
 * attempt. The error is written after the step is shown, because showing one
 * clears whatever the last attempt left behind.
 */
function failSignIn(message) {
	showStep(reauth ? 'again' : 'choose');
	addError.textContent = message;
	addError.hidden = false;
}

/** The browser step, before the provider has handed over a URL to show. */
function awaitBrowser(status) {
	showStep('browser');
	// Until the provider hands back a URL there is nothing to show, and an empty
	// field reads as breakage. Say what is happening instead.
	$('.step[data-step="browser"] .status').textContent = status;
	authUrlBtn.textContent = '';
	authUrlBtn.hidden = true;
}

async function beginAdd() {
	if (!chosenProvider) return failSignIn('Pick a provider first.');
	if (!labelInput.value.trim()) return failSignIn('Give the account a name.');

	awaitBrowser('Starting sign-in…');

	addInFlight = window.aidash
		.addAccount(chosenProvider, labelInput.value.trim())
		.then(async () => {
			dialog.close();
			await refresh();
			done('Account added');
		})
		.catch((err) => failSignIn(reason(err)))
		.finally(() => {
			addInFlight = null;
		});
}

/**
 * Signs an account that already exists in again.
 *
 * Opens straight at the browser step: the provider and the name are settled,
 * and asking for them again would only offer to change things this is not
 * changing. Everything past that point — the URL, the code box, cancelling — is
 * the add flow untouched.
 */
async function beginReauth(id, label) {
	reauth = { id, label };
	dialogTitle.textContent = `Sign in again as ${label}`;
	codeInput.value = '';
	awaitBrowser('Starting sign-in…');
	if (!dialog.open) dialog.showModal();

	addInFlight = window.aidash
		.reauthorizeAccount(id)
		.then(async ({ state: next, account, switched }) => {
			dialog.close();
			reauth = null;
			// Painted from what the sign-in returned before the usage call goes out,
			// so the error the card was showing disappears with the login that
			// caused it rather than a network round trip later.
			state = next;
			paint();
			await refresh();
			// A different person behind the same card is not an error, but it is not
			// what the button said either — so it is named rather than left to be
			// spotted in the identity line later.
			done(switched ? `Now signed in as ${account.email ?? 'another account'} — the name and its sessions stayed` : 'Signed in again');
		})
		.catch((err) => failSignIn(reason(err)))
		.finally(() => {
			addInFlight = null;
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
	if (progress.stage === 'device') {
		showStep('device');
		$('#device-code').textContent = progress.code;
		const link = $('#device-url');
		link.textContent = progress.url;
		link.onclick = () => window.aidash.openUrl(progress.url);
	}
	if (progress.stage === 'external') {
		showStep('external');
		$('#external-note').textContent = progress.note;
	}
	if (progress.stage === 'code') {
		showStep('code');
		codeInput.focus();
	}
});

nextBtn.addEventListener('click', () => {
	const current = [...document.querySelectorAll('.step')].find((s) => !s.hidden)?.dataset.step;
	if (current === 'choose') return beginAdd();
	if (current === 'again' && reauth) return beginReauth(reauth.id, reauth.label);
	if (current === 'code') {
		const code = codeInput.value.trim();
		if (!code) return;
		awaitBrowser('Finishing sign-in…');
		window.aidash.supplyCode(code);
	}
});

cancelBtn.addEventListener('click', async () => {
	await window.aidash.cancelSignIn();
	reauth = null;
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

/* ---------------------------------------------------------------- settings */

const settingBoxes = { tray: $('#set-tray'), notifications: $('#set-notifications') };
const intervalPicker = $('#set-interval');

function paintSettings() {
	for (const [key, box] of Object.entries(settingBoxes)) box.checked = state.settings?.[key] !== false;
	intervalPicker.value = String(state.settings?.refreshEveryMinutes ?? 60);
}

async function changeSetting(key, value, announce) {
	try {
		state = await window.aidash.setSetting(key, value);
		done(announce);
	} catch (err) {
		// Put the control back where the state actually is rather than leaving it
		// showing something that did not happen.
		paintSettings();
		failed(reason(err));
	}
}

for (const [key, box] of Object.entries(settingBoxes)) {
	box.addEventListener('change', () => changeSetting(key, box.checked, box.checked ? 'Turned on' : 'Turned off'));
}

intervalPicker.addEventListener('change', () => {
	const minutes = Number(intervalPicker.value);
	changeSetting('refreshEveryMinutes', minutes, minutes ? `Refreshing every ${minutes < 60 ? `${minutes} min` : `${minutes / 60}h`}` : 'Automatic refresh off');
});

// The menu bar can refresh, and so can a window that has just come back, so the
// window is no longer the only thing that changes the state.
window.aidash.onStateChanged((next) => {
	state = next;
	paint();
	paintSettings();
});

/* ------------------------------------------------------------------ update */

// A dismissed version stays dismissed until a newer one appears, so the banner
// cannot become something the user learns to ignore.
const DISMISSED_KEY = 'aidash:dismissed-update';

const bullets = (lines) => lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');

async function checkUpdate() {
	const update = await window.aidash.checkForUpdate();
	if (!update || localStorage.getItem(DISMISSED_KEY) === update.version) return;

	$('#update-text').textContent = `Version ${update.version} is available`;

	// The release's own list, when it carries one. A banner that only says a
	// number asks the user to go and find out what it is for.
	const notes = update.notes ?? [];
	$('#update-notes').innerHTML = bullets(notes);
	$('#update-notes').hidden = notes.length === 0;
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
paintSettings();

if (state.accounts.length > 0) {
	const age = state.lastRefreshAt ? Date.now() - state.lastRefreshAt : Infinity;
	if (age > AUTO_REFRESH_AFTER_MS) refresh();
}

// Keep the elapsed time and the countdowns honest. The cards are left alone —
// redrawing them would close any raw payload a user had opened, which is a
// worse trade than a card reading "in 3h" for a few minutes longer.
setInterval(() => {
	paintAge();
	paintOutlook();
}, 30000);

// Never blocks the window: an unreachable manifest simply means no banner.
checkUpdate();

/* ------------------------------------------------------------------- about */

$('#about-version').textContent = state.version ?? '—';
$('#about-platform').textContent = `${navigator.platform || 'unknown platform'}`;

/**
 * What this build brought, from the changelog shipped beside it.
 *
 * The version in hand first and named, older ones folded away: after an update
 * the question is "what did I just get", and it should not need unfolding.
 */
async function paintNotes() {
	const box = $('#about-notes');
	const entries = await window.aidash.releaseNotes();
	if (!entries.length) {
		box.innerHTML = '<p class="hint">No release notes shipped with this build.</p>';
		return;
	}

	// An unreleased section exists while the next version is being built; running
	// such a build, it is the honest answer to "what is in this one".
	const current = entries.find((e) => e.version === state.version) ?? entries[0];
	const rest = entries.filter((e) => e !== current);

	box.innerHTML = `
    <div class="notes-current">
      <b>${escapeHtml(current.version === state.version ? `Version ${current.version}` : current.version)}</b>
      <ul>${bullets(current.bullets)}</ul>
    </div>
    ${
			rest.length
				? `<details class="notes-earlier">
             <summary>Earlier versions</summary>
             ${rest.map((e) => `<div class="notes-past"><b>${escapeHtml(e.version)}</b><ul>${bullets(e.bullets)}</ul></div>`).join('')}
           </details>`
				: ''
		}`;
}

paintNotes();

for (const link of document.querySelectorAll('.about-links .link[data-url]')) {
	link.addEventListener('click', () => window.aidash.openUrl(link.dataset.url));
}

$('#about-check').addEventListener('click', async () => {
	busy('Checking for updates…');
	const update = await window.aidash.checkForUpdate();
	if (!update) {
		done('You are on the latest version');
		return;
	}
	// Clearing the dismissal is the point of asking: an explicit check should
	// bring back a banner the user waved away earlier.
	localStorage.removeItem(DISMISSED_KEY);
	await checkUpdate();
	done(`Version ${update.version} is available`);
});

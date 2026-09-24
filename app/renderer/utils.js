/**
 * Local Sessions tab — Claude Code and Codex sessions side by side.
 *
 * One row per project folder, one column per place a session can live. A
 * session belongs to the directory it ran in, so it only ever moves sideways
 * within its own row.
 *
 * What a drag does depends on where it lands:
 *
 *   Claude account → Claude account   moves the index entry
 *   Only in the CLI → Claude account  writes the index entry it lacked
 *   across tools                      copies the dialogue, after a warning
 *
 * The last one is a copy rather than a move because Claude and Codex describe
 * conversations differently; the main process explains that before doing it.
 */

import { escapeHtml, relativeTime } from './render.js';
import { openProject } from './project.js';
import { remoteBadge } from './remote-badge.js';
import { icon } from './icons.js';
import { notify, busy, done, failed, reason } from './notify.js';

/** A cancelled dialog is not an event worth announcing. */
const notifyNothing = () => notify('');

const UNINDEXED = 'unindexed';
const CODEX = 'codex';

const $ = (sel) => document.querySelector(sel);

const rootsBox = $('#roots');
const projectsBox = $('#projects');
const emptyBox = $('#sessions-empty');
const statusLabel = $('#sessions-status');
const remotePanel = $('#remote-panel');
const explainBox = $('#sessions-explain');

const renameDialog = $('#session-rename-dialog');
const renameInput = $('#session-rename-input');
const renameError = $('#session-rename-error');

let view = { accounts: [], projects: [] };
let dragging = null;

/**
 * Which columns are folded out of the project grid.
 *
 * Keyed by root id for a secondary folder or Codex (`instance:…`, `manual-…`,
 * `codex`), and by account id for a main-profile account — the same two shapes
 * `columns()` already tells them apart by. Hiding is purely a display choice:
 * nothing is forgotten, merged or removed, so it costs nothing to reverse and
 * survives a rescan, remembered the same way collapsed usage groups are.
 */
const HIDDEN_KEY = 'aidash:hidden-columns';
const hiddenColumns = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]'));

function setColumnHidden(key, hide) {
	if (hide) hiddenColumns.add(key);
	else hiddenColumns.delete(key);
	localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenColumns]));
	paintSessions();
}

/**
 * Which projects are expanded, kept as the opt-in set rather than its
 * opposite. A project not yet in this set reads as collapsed — which is the
 * default every project starts at, including one that did not exist the last
 * time this ran, without having to seed anything for it up front.
 */
const EXPANDED_KEY = 'aidash:expanded-projects';
const expandedProjects = new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'));

function toggleProject(cwd) {
	if (expandedProjects.has(cwd)) expandedProjects.delete(cwd);
	else expandedProjects.add(cwd);
	localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedProjects]));
	paintSessions();
}
let renaming = null;

/* ------------------------------------------------------------------ search */

/**
 * Two searches at once, deliberately.
 *
 * Titles, paths and branches are already in memory, so filtering on them can
 * happen on every keystroke and does. Transcripts are hundreds of megabytes on
 * disk, so reading them waits until the typing stops — and when it finishes,
 * its hits are added to the same filter rather than replacing it. The list
 * therefore narrows immediately and then narrows again, instead of doing
 * nothing at all until the disk has been read.
 */
let query = '';
let hits = new Map();
let searchNote = '';
let searchTimer = null;

/** How long the typing has to stop before the disk is touched. */
const READ_AFTER_MS = 450;

const matches = (session, project) => {
	const q = query.toLowerCase();
	if (!q) return true;
	// A path match reveals the whole project: searching for a folder means
	// asking about it, not about one session inside it.
	if (project.cwd.toLowerCase().includes(q)) return true;
	for (const field of [session.title, session.branch, session.model]) {
		if (field && String(field).toLowerCase().includes(q)) return true;
	}
	return session.transcript ? hits.has(session.transcript) : false;
};

/** The view, narrowed. Projects with nothing left in them drop out entirely. */
function visibleProjects() {
	if (!query) return view.projects;

	const kept = [];
	for (const project of view.projects) {
		const byAccount = {};
		let any = false;
		for (const [columnId, sessions] of Object.entries(project.byAccount)) {
			const surviving = sessions.filter((s) => matches(s, project));
			if (surviving.length) any = true;
			byAccount[columnId] = surviving;
		}
		if (any) kept.push({ ...project, byAccount });
	}
	return kept;
}

function targets() {
	const out = [];
	for (const project of view.projects) {
		for (const [columnId, sessions] of Object.entries(project.byAccount)) {
			for (const session of sessions) {
				if (session.transcript) out.push({ transcript: session.transcript, tool: columnId === CODEX ? 'codex' : 'claude' });
			}
		}
	}
	// The same transcript is listed by every account that claims it; reading it
	// more than once would cost the same again for nothing.
	return [...new Map(out.map((t) => [t.transcript, t])).values()];
}

async function readTranscripts(forQuery) {
	searchNote = 'reading transcripts…';
	paintSessions();

	try {
		const found = await window.aidash.sessions.search({ query: forQuery, targets: targets() });
		// A slower answer to an older question must not overwrite a newer one.
		if (forQuery !== query) return;

		hits = new Map(found.results.map((r) => [r.transcript, r]));
		searchNote = found.results.length
			? `${found.results.length} said it, of ${found.scanned} transcripts read`
			: `nothing said it, of ${found.scanned} transcripts read`;
		paintSessions();
	} catch (err) {
		if (forQuery !== query) return;
		searchNote = `transcripts could not be read — ${reason(err)}`;
		paintSessions();
	}
}

function onSearch(value) {
	query = value.trim();
	hits = new Map();
	clearTimeout(searchTimer);

	if (query.length < 2) {
		searchNote = query ? 'keep typing to search inside transcripts' : '';
		paintSessions();
		return;
	}

	searchNote = 'filtering on titles…';
	paintSessions();
	searchTimer = setTimeout(() => readTranscripts(query), READ_AFTER_MS);
}

const formatSize = (bytes) =>
	bytes == null ? null : bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The standing summary under the heading — what is here, not what just
 * happened. A search replaces it while one is on, and hands it back after.
 */
let standing = '';

function setSummary(message) {
	standing = message ?? '';
	showSummary();
}

function showSummary() {
	statusLabel.textContent = query ? [`matching “${query}”`, searchNote].filter(Boolean).join(' · ') : standing;
}

const accountName = (account) => account.email ?? `account ${account.accountUuid.slice(0, 8)}`;

/** Columns left to right: unclaimed transcripts, Claude accounts, then Codex. */
function columns() {
	const cols = [];

	if (view.projects.some((p) => (p.byAccount[UNINDEXED]?.length ?? 0) > 0)) {
		cols.push({ id: UNINDEXED, tool: 'claude', orphan: true, name: 'Only in the CLI', under: 'not listed by any account' });
	}

	for (const account of view.accounts) {
		cols.push({
			id: account.id,
			tool: 'claude',
			path: account.path,
			email: account.email,
			expired: account.expired,
			name: accountName(account),
			under: account.orgName ?? account.orgUuid,
			// A listing that belongs to a second copy of the desktop app rather than
			// the one everybody has. It behaves identically — the difference is worth
			// showing, not enforcing.
			secondary: Boolean(account.secondary),
			rootKind: account.rootKind ?? 'main',
			rootLabel: account.rootLabel ?? null,
			// A main account is hidden by its own id; a secondary one also folds away
			// with the whole folder it lives in, so hiding an instance's chip takes
			// every account inside it rather than needing one toggle each.
			hidden: hiddenColumns.has(account.id) || (account.secondary && hiddenColumns.has(account.root)),
		});
	}

	if (view.codex) {
		cols.push({
			id: CODEX,
			tool: CODEX,
			name: 'Codex',
			under: `${view.codex.sessions} sessions · shared by every account`,
			hidden: hiddenColumns.has(CODEX),
		});
	}

	return cols;
}

/* ------------------------------------------------------------------ render */

function sessionCard(session, column, cwd) {
	const hit = session.transcript ? hits.get(session.transcript) : null;
	const meta = [
		session.lastAt ? relativeTime(session.lastAt) : null,
		formatSize(session.sizeBytes),
		session.tokens ? `${Math.round(session.tokens / 1000)}k tokens` : null,
		session.branch,
		session.archived ? 'archived' : null,
		// A listed session whose transcript is gone opens empty; better said than
		// left to look ordinary.
		session.transcript ? null : 'transcript missing',
	]
		.filter(Boolean)
		.join(' · ');

	// Only meaningful where there is something to act on: an unclaimed
	// transcript has no entry to rename and no listing to delete.
	const actions =
		column.id === UNINDEXED
			? ''
			: `<span class="s-actions">
           <button class="s-act" data-act="export" title="Export as Markdown">⤓</button>
           <button class="s-act" data-act="rename" title="Rename">✎</button>
           <button class="s-act" data-act="delete" title="Delete this session and its transcript">✕</button>
         </span>`;

	return `
    <li class="session" draggable="true"
        data-tool="${escapeHtml(column.tool)}"
        data-file="${escapeHtml(session.file ?? '')}"
        data-thread="${escapeHtml(session.id ?? '')}"
        data-transcript="${escapeHtml(session.transcript ?? '')}"
        data-cli="${escapeHtml(session.cliSessionId ?? '')}"
        data-title="${escapeHtml(session.title ?? '')}"
        data-account="${escapeHtml(column.id)}"
        data-bridges="${escapeHtml(String(session.bridges?.length ?? 0))}"
        data-cwd="${escapeHtml(cwd)}">
      <span class="s-head">
        <span class="s-title">${escapeHtml(session.title ?? '(untitled session)')}</span>
        ${remoteBadge(session, columns())}
        ${actions}
      </span>
      <span class="s-meta">${escapeHtml(meta)}</span>
      ${hit ? `<span class="s-hit"><b>${escapeHtml(hit.role === 'assistant' ? 'reply' : 'you')}</b> ${escapeHtml(hit.snippet)}${hit.hits > 1 ? ` <i>+${hit.hits - 1}</i>` : ''}</span>` : ''}
    </li>`;
}

/**
 * Renders one project row, or nothing when there is nothing left to show it
 * with. Hiding every column of a project this way rather than leaving an
 * empty shell behind is the same call already made for search: a section
 * heading over zero columns answers nothing.
 */
function projectRow(project) {
	const visible = columns()
		// Hidden first: a folded-away column is not a drop target either, so it
		// is excluded on the same terms search already excludes an empty one.
		.filter((column) => !column.hidden)
		// While a search is on, a column with nothing left in it is not a drop
		// target anyone is aiming at — it is width taken from the results.
		.filter((column) => !query || (project.byAccount[column.id] ?? []).length > 0);

	if (!visible.length) return null;

	// A search is aimed at finding something, not at re-deciding what's folded
	// away; forcing every project open while one is active means the match is
	// never hidden behind a caret the search itself didn't touch.
	const expanded = Boolean(query) || expandedProjects.has(project.cwd);

	const cols = visible
		.map((column) => {
			const sessions = project.byAccount[column.id] ?? [];
			// An account nobody is signed in as anywhere the app can read shows as
			// a bare id; adding it on the Usage tab is what gives it a name.
			const note = column.orphan
				? ''
				: column.tool === CODEX
					? ''
					: column.email
						? column.expired
							? '<span class="col-stale">credential expired — sign in again</span>'
							: ''
						: '<span class="col-stale">add this account on the Usage tab to name it</span>';

			// Which copy of the desktop app this listing lives in. Only said where it
			// is not the obvious one, and said on every column rather than only on
			// duplicates: the same account can appear twice, and a badge that came
			// and went would leave you working out which of the two is which.
			const where = column.secondary
				? `<span class="col-tag" title="${escapeHtml(
						column.rootKind === 'instance'
							? 'A separate copy of Claude Desktop for this account, with its own list of sessions. Transcripts and settings are shared with the main one.'
							: 'A Claude Desktop profile folder added by hand. Its sessions are listed here the same as any other.',
					)}">${escapeHtml(column.rootKind === 'instance' ? `instance · ${column.rootLabel ?? ''}`.trim() : 'added folder')}</span>`
				: '';

			return `
        <div class="col ${column.orphan ? 'orphan' : ''} ${column.tool === CODEX ? 'codex' : ''} ${column.secondary ? 'secondary' : ''}"
             data-account="${escapeHtml(column.id)}" data-tool="${escapeHtml(column.tool)}" data-cwd="${escapeHtml(project.cwd)}">
          <div class="col-head">
            <span class="col-who">
              <b class="${column.orphan || (column.tool === 'claude' && !column.email) ? 'unknown' : ''}">${escapeHtml(column.name)}</b>
              ${where}
              <span class="col-path">${escapeHtml(column.under)}</span>
              ${note}
            </span>
            <span class="col-count">${sessions.length || ''}</span>
          </div>
          <ul class="sessions">
            ${sessions.map((s) => sessionCard(s, column, project.cwd)).join('') || '<li class="drop-hint">drop here</li>'}
          </ul>
        </div>`;
		})
		.join('');

	return `
    <section class="project ${expanded ? '' : 'collapsed'}">
      <div class="project-head">
        <button type="button" class="project-fold" data-cwd="${escapeHtml(project.cwd)}"
                aria-expanded="${expanded}" title="${expanded ? 'Collapse' : 'Expand'} this project">
          <span class="project-caret">▼</span>
        </button>
        <h3 class="project-open" role="button" tabindex="0" data-cwd="${escapeHtml(project.cwd)}"
            title="Open this project on its own, with every account and both tools in one timeline">
          ${escapeHtml(project.cwd)}<span class="project-arrow">→</span>
        </h3>
      </div>
      <div class="cols" ${expanded ? '' : 'hidden'}>${cols}</div>
    </section>`;
}

/**
 * The strip above the projects: which session folders are being read, and
 * which of their columns are folded away.
 *
 * Every chip is a folder on disk, and now says so with a folder icon rather
 * than leaving the metaphor to a tooltip: Claude Desktop's own session index
 * for an account, a second copy of it for an instance, or one pointed at by
 * hand. Accounts in the main profile get a chip each. A secondary folder gets
 * one chip for the folder rather than one per account inside it, because the
 * folder is the thing that can be merged, retired or hidden — and a freshly
 * opened instance with nothing in it yet still earns a chip, so that "I made
 * one" and "it is empty" are distinguishable.
 */
/** How many sessions under one account still carry a Remote Control link. */
function bridgedCount(accountId) {
	let n = 0;
	for (const project of view.projects) {
		for (const session of project.byAccount[accountId] ?? []) {
			if (session.bridges?.length) n++;
		}
	}
	return n;
}

/** The eye toggle every chip carries, whatever else is on it. */
function hideToggle(key, label) {
	const hidden = hiddenColumns.has(key);
	return `<button class="rc-hide" data-key="${escapeHtml(key)}"
      title="${hidden ? `Show ${escapeHtml(label)}'s column again in the projects below.` : `Hide ${escapeHtml(label)}'s column from the projects below. Nothing is moved or forgotten — this is a display choice, and reverses the same way.`}">
      ${icon(hidden ? 'eyeOff' : 'eye')}
    </button>`;
}

function rootChips() {
	const sessionsIn = (rootId) =>
		view.accounts.filter((a) => (a.root ?? 'main') === rootId).reduce((n, a) => n + (a.sessions ?? 0), 0);

	const counted = (n) => `${n} session${n === 1 ? '' : 's'}`;

	const chips = view.accounts
		.filter((account) => !account.secondary)
		.map((account) => {
			const bridged = bridgedCount(account.id);
			const name = accountName(account);
			// Only shown where there is something to clear: the common case has
			// nothing bridged, and a button that does nothing is worse than none.
			const clear = bridged
				? `<button class="rc-clear-remote" data-account="${escapeHtml(account.id)}"
             title="Clears the local Remote Control record for ${bridged} session${bridged === 1 ? '' : 's'} under this account — the same record Claude Desktop itself reads. Does not stop anything still genuinely running on the server.">
             ${icon('unlink')}<span>clear remote (${bridged})</span>
           </button>`
				: '';
			return `
        <span class="root-chip ${account.expired ? 'stale' : ''} ${hiddenColumns.has(account.id) ? 'is-hidden' : ''}"
              title="Claude Desktop's session folder for this account.">
          <span class="rc-icon">${icon('folder')}</span>
          <span class="rc-body">
            <span class="rc-name">${escapeHtml(name)}</span>
            <span class="rc-count">${escapeHtml(counted(account.sessions))}</span>
          </span>
          <span class="rc-actions">
            ${hideToggle(account.id, name)}
            ${clear}
          </span>
        </span>`;
		});

	for (const root of (view.indexRoots ?? []).filter((r) => r.kind !== 'main')) {
		const count = sessionsIn(root.id);
		const name = root.label ?? root.id;
		const kind = root.kind === 'instance' ? 'Instance' : 'Added folder';
		chips.push(`
      <span class="root-chip secondary ${hiddenColumns.has(root.id) ? 'is-hidden' : ''}" data-root="${escapeHtml(root.id)}"
            title="${escapeHtml(
							root.kind === 'instance'
								? 'A second copy of Claude Desktop, signed in as this account, with its own session folder.'
								: 'A Claude Desktop session folder added by hand, kept on disk wherever it already was.',
						)}">
        <span class="rc-icon">${icon('folder')}</span>
        <span class="rc-body">
          <b class="rc-kind">${escapeHtml(kind)}</b>
          <span class="rc-name">${escapeHtml(name)}</span>
          <span class="rc-count">${escapeHtml(counted(count))}</span>
        </span>
        <span class="rc-actions">
          ${hideToggle(root.id, name)}
          <button class="rc-merge" data-root="${escapeHtml(root.id)}"
            title="${escapeHtml(
							root.kind === 'instance'
								? 'Moves every session here into the main profile under the same account, then deletes this separate instance. Transcripts are untouched. Quit that copy of Claude Desktop first.'
								: 'Moves every session here into the main profile under the same account, then forgets this folder. Nothing on disk is deleted.',
						)}">${icon('merge')}<span>merge and remove</span></button>
        </span>
      </span>`);
	}

	if (view.codex) {
		chips.push(`
      <span class="root-chip ${hiddenColumns.has(CODEX) ? 'is-hidden' : ''}" title="Codex's own session folder — one for every account, since nothing in it records which is signed in.">
        <span class="rc-icon">${icon('folder')}</span>
        <span class="rc-body">
          <span class="rc-name">Codex</span>
          <span class="rc-count">${escapeHtml(counted(view.codex.sessions))}</span>
        </span>
        <span class="rc-actions">${hideToggle(CODEX, 'Codex')}</span>
      </span>`);
	}

	chips.push(
		`<button id="roots-add" class="rc-add" title="Point at another copy of Claude Desktop's user data folder — one this app did not create — to list its sessions here too.">${icon('folderPlus')}<span>+ folder</span></button>`,
	);

	return chips.join('');
}

function wireRoots() {
	// Pure client state — no confirmation, no IPC, nothing to undo but a second
	// click. paintSessions() re-renders both the chip (icon flips) and the grid
	// (the column appears or disappears) from the one flag.
	for (const button of rootsBox.querySelectorAll('.rc-hide')) {
		button.addEventListener('click', () => setColumnHidden(button.dataset.key, !hiddenColumns.has(button.dataset.key)));
	}

	for (const button of rootsBox.querySelectorAll('.rc-merge')) {
		button.addEventListener('click', async () => {
			busy('Merging…');
			try {
				// The confirmation lives in the main process, where it can be a real
				// system dialog and can say how many sessions it is about to move.
				const result = await window.aidash.instances.merge(button.dataset.root);
				if (!result) return notifyNothing();

				view = result.view;
				paintSessions();

				const skipped = result.skipped.length;
				done(
					`Merged ${result.moved} session${result.moved === 1 ? '' : 's'}` +
						(skipped ? ` · ${skipped} left where they were, already listed there` : ''),
				);
			} catch (err) {
				failed(reason(err));
			}
		});
	}

	for (const button of rootsBox.querySelectorAll('.rc-clear-remote')) {
		button.addEventListener('click', async () => {
			busy('Clearing…');
			try {
				// The confirmation lives in the main process, where it can say plainly
				// that this is a local edit and does not stop anything genuinely still
				// running on the server.
				const result = await window.aidash.sessions.clearRemoteLinks(button.dataset.account);
				if (!result) return notifyNothing();

				view = result.view;
				paintSessions();
				done(`Cleared ${result.cleared} link${result.cleared === 1 ? '' : 's'}`);
			} catch (err) {
				failed(reason(err));
			}
		});
	}

	rootsBox.querySelector('#roots-add')?.addEventListener('click', async () => {
		try {
			const result = await window.aidash.instances.addRoot();
			if (!result) return notifyNothing();
			view = result.view;
			paintSessions();
			done('Folder added');
		} catch (err) {
			failed(reason(err));
		}
	});
}

export function paintSessions() {
	rootsBox.innerHTML = rootChips();
	wireRoots();

	const shown = visibleProjects();
	// A project with data survives visibleProjects() but can still render
	// nothing once folded-away columns are taken out — projectRow() returns
	// null for exactly that case, so it has to be filtered here too.
	const rows = shown.map(projectRow).filter(Boolean);
	const hasSessions = rows.length > 0;

	// Three paragraphs of preamble between the search box and its results is the
	// same as having no results.
	explainBox.hidden = Boolean(query);

	// The genuine empty state — nothing on this machine at all — is the only
	// case `emptyBox` owns. A search with no hits and every account hidden both
	// have something specific to say, and say it inside `projectsBox` instead.
	const genuinelyEmpty = !hasSessions && !query && shown.length === 0;
	emptyBox.hidden = !genuinelyEmpty;
	projectsBox.hidden = genuinelyEmpty;
	projectsBox.innerHTML = hasSessions
		? rows.join('')
		: query
			? `<p class="muted">Nothing matches “${escapeHtml(query)}”${searchNote ? ` — ${escapeHtml(searchNote)}` : ''}.</p>`
			: shown.length > 0
				? '<p class="muted">Every account is hidden. Click the eye on a chip above to bring one back.</p>'
				: '';

	showSummary();
	wireCards();
}

$('#sessions-search').addEventListener('input', (e) => onSearch(e.target.value));

/* ------------------------------------------------------------------ actions */

function cardData(card) {
	return {
		tool: card.dataset.tool,
		entryFile: card.dataset.file || null,
		threadId: card.dataset.thread || null,
		transcript: card.dataset.transcript || null,
		title: card.dataset.title || '(untitled session)',
		bridges: Number(card.dataset.bridges) || 0,
	};
}

async function runAction(action, card) {
	const data = cardData(card);

	if (action === 'rename') {
		renaming = data;
		renameInput.value = data.title;
		renameError.hidden = true;
		renameDialog.showModal();
		renameInput.select();
		return;
	}

	if (action === 'export') {
		busy('Exporting…');
		try {
			const result = await window.aidash.sessions.export(data);
			if (result) done(`Exported ${result.messages} messages`);
			else notifyNothing();
		} catch (err) {
			failed(reason(err));
		}
		return;
	}

	if (action === 'delete') {
		try {
			// The confirmation lives in the main process, where it can be a real
			// system dialog rather than something the page draws.
			const next = await window.aidash.sessions.remove(data);
			if (next) {
				view = next;
				paintSessions();
				done('Session deleted');
			} else {
				notifyNothing();
			}
		} catch (err) {
			failed(reason(err));
		}
	}
}

async function saveRename() {
	const title = renameInput.value.trim();
	if (!title) {
		renameError.textContent = 'A name is required.';
		renameError.hidden = false;
		return;
	}
	try {
		view = await window.aidash.sessions.rename({ ...renaming, title });
		renameDialog.close();
		paintSessions();
		done('Session renamed');
	} catch (err) {
		renameError.textContent = reason(err);
		renameError.hidden = false;
	}
}

$('#session-rename-save').addEventListener('click', saveRename);
$('#session-rename-cancel').addEventListener('click', () => renameDialog.close());
renameInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault();
		saveRename();
	}
});

/* -------------------------------------------------------------- drag & drop */

function wireCards() {
	for (const heading of projectsBox.querySelectorAll('.project-open')) {
		const open = () => {
			const project = view.projects.find((p) => p.cwd === heading.dataset.cwd);
			if (project) openProject(project, columns());
		};
		heading.addEventListener('click', open);
		heading.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				open();
			}
		});
	}

	for (const button of projectsBox.querySelectorAll('.project-fold')) {
		button.addEventListener('click', (e) => {
			e.stopPropagation();
			toggleProject(button.dataset.cwd);
		});
	}

	for (const button of projectsBox.querySelectorAll('.s-act')) {
		button.addEventListener('click', (e) => {
			e.stopPropagation();
			runAction(button.dataset.act, button.closest('.session'));
		});
		// Otherwise grabbing a button starts a drag instead of pressing it.
		button.addEventListener('mousedown', (e) => e.stopPropagation());
		button.closest('.session').addEventListener('dragstart', (e) => {
			if (e.target.classList?.contains('s-act')) e.preventDefault();
		});
	}

	for (const card of projectsBox.querySelectorAll('.session')) {
		card.addEventListener('dragstart', (e) => {
			dragging = { ...cardData(card), fromColumn: card.dataset.account, cwd: card.dataset.cwd, cliSessionId: card.dataset.cli };
			card.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'copyMove';
			// Firefox refuses to start a drag without payload; the real state is
			// held above, since dataTransfer is unreadable during dragover.
			e.dataTransfer.setData('text/plain', card.dataset.title);
		});
		card.addEventListener('dragend', () => {
			card.classList.remove('dragging');
			dragging = null;
			for (const col of projectsBox.querySelectorAll('.col')) col.classList.remove('over', 'copy');
		});
	}

	for (const col of projectsBox.querySelectorAll('.col')) {
		// Nothing is dropped back into the unclaimed column: that would mean
		// deleting an index entry along with whatever the desktop app recorded.
		const acceptable = () =>
			dragging && dragging.cwd === col.dataset.cwd && dragging.fromColumn !== col.dataset.account && col.dataset.account !== UNINDEXED;

		const isCopy = () => dragging && dragging.tool !== col.dataset.tool;

		col.addEventListener('dragover', (e) => {
			if (!acceptable()) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = isCopy() ? 'copy' : 'move';
			col.classList.add('over');
			col.classList.toggle('copy', isCopy());
		});

		col.addEventListener('dragleave', () => col.classList.remove('over', 'copy'));

		col.addEventListener('drop', async (e) => {
			e.preventDefault();
			col.classList.remove('over', 'copy');
			if (!acceptable()) return;

			const target = columns().find((c) => c.id === col.dataset.account);
			const source = dragging;
			dragging = null;

			try {
				let next;
				if (source.tool !== target.tool) {
					busy('Copying across tools…');
					next = await window.aidash.sessions.transfer({
						fromTool: source.tool,
						transcript: source.transcript,
						title: source.title,
						toAccountPath: target.path ?? null,
					});
					if (next) done('Copied — restart the receiving app to see it');
					else notifyNothing();
				} else if (source.fromColumn === UNINDEXED) {
					busy('Adding…');
					next = await window.aidash.sessions.adopt({ transcriptFile: source.transcript, toAccountPath: target.path });
					done('Added — restart Claude Code to see it there');
				} else {
					busy('Moving…');
					next = await window.aidash.sessions.move({
						fromFile: source.entryFile,
						cliSessionId: source.cliSessionId,
						toAccountPath: target.path,
						// Which column it left and which it landed in: the Remote
						// Control link cannot follow, and only the mover can remember
						// where it was minted.
						fromAccount: source.fromColumn,
						toAccount: target.id,
					});
					done(
						source.bridges
							? 'Moved — the Remote Control link stays with the old account'
							: 'Moved — restart Claude Code to see it there',
					);
				}

				if (next) {
					view = next;
					paintSessions();
				}
			} catch (err) {
				failed(reason(err));
			}
		});
	}
}

/* ------------------------------------------------- remote sessions panel */

/**
 * The other side of the link, on request.
 *
 * Kept visibly apart from the columns, and worded so nobody reads it as an
 * answer to which account owns a badge — the server cannot say that, and this
 * panel is not evidence for it. It lists what each account has, and it is
 * allowed to be absent.
 */
function renderRemote(result) {
	const rows = (result.accounts ?? [])
		.map((account) => {
			if (!account.ok) {
				return `<li class="rp-acct"><b>${escapeHtml(account.label)}</b>
          <span class="rp-fail">could not be read — ${escapeHtml(account.reason ?? 'no reason given')}</span></li>`;
			}

			const shown = account.sessions.slice(0, 8);
			const rest = account.sessions.length - shown.length;

			const items =
				shown
					.map(
						(s) => `<li class="rp-item">
              <span class="rp-title">${escapeHtml(s.title)}</span>
              <span class="rp-meta">${escapeHtml(
								[s.connection === 'connected' ? 'connected' : s.status, s.lastAt ? relativeTime(s.lastAt) : null].filter(Boolean).join(' · '),
							)}</span>
            </li>`,
					)
					.join('') || '<li class="rp-item"><span class="rp-meta">no Remote Control sessions on the server</span></li>';

			const summary = [
				`${account.sessions.length} remote session${account.sessions.length === 1 ? '' : 's'}`,
				account.connected ? `${account.connected} connected now` : null,
				account.others ? `${account.others} other session${account.others === 1 ? '' : 's'} not shown` : null,
				account.truncated ? 'list truncated' : null,
			]
				.filter(Boolean)
				.join(' · ');

			return `<li class="rp-acct">
        <b>${escapeHtml(account.label)}</b> <span class="rp-sum">${escapeHtml(summary)}</span>
        <ul class="rp-items">${items}${rest > 0 ? `<li class="rp-item"><span class="rp-meta">+${rest} more</span></li>` : ''}</ul>
      </li>`;
		})
		.join('');

	remotePanel.innerHTML = `
    <div class="rp-head">
      <b>Remote sessions on the server</b>
      <span class="rp-actions">
        <button id="remote-match" class="ghost" title="Where a session's title and time single out exactly one remote session, and that list belongs to exactly one account, the link is recorded as that account's. Everything less certain than that is refused and counted.">Match unknown remote sessions</button>
        <button id="remote-forget" class="ghost" title="Throws away every attribution worked out by matching. Moves this app performed are remembered separately and are left alone.">Forget matches</button>
        <button id="remote-close" class="ghost">Hide</button>
      </span>
    </div>
    <p class="rp-note">
      What each account has on Anthropic's side right now. These are not the same objects as the links stored locally — the
      identifiers do not correspond — so this neither confirms nor contradicts the <b>remote</b> badges below.
    </p>
    ${result.note ? `<p class="rp-fail">${escapeHtml(result.note)}</p>` : ''}
    <ul class="rp-accts">${rows}</ul>`;

	remotePanel.hidden = false;
	remotePanel.querySelector('#remote-close')?.addEventListener('click', () => {
		remotePanel.hidden = true;
	});
	remotePanel.querySelector('#remote-match')?.addEventListener('click', matchRemote);
	remotePanel.querySelector('#remote-forget')?.addEventListener('click', forgetMatches);
}

/** Reports what matching did, refusals included — they are the larger half. */
function matchReport({ matched, refused, considered, unreadable }) {
	const r = refused ?? {};
	const kept = [
		r.ambiguousAccount ? `${r.ambiguousAccount} matched a list that more than one account returns` : null,
		r.ambiguousTitle ? `${r.ambiguousTitle} had a title that is not unique` : null,
		r.severalLinks ? `${r.severalLinks} carry more than one link` : null,
		r.timeDisagrees ? `${r.timeDisagrees} matched a title but not a time` : null,
		r.notFound ? `${r.notFound} are not on the server at all` : null,
	].filter(Boolean);

	return `
    <p class="rp-report">
      <b>${matched} of ${considered}</b> link${considered === 1 ? '' : 's'} attributed.
      ${kept.length ? `Left alone: ${escapeHtml(kept.join('; '))}.` : ''}
      ${unreadable?.length ? `Could not read: ${escapeHtml(unreadable.join(', '))}.` : ''}
    </p>`;
}

async function matchRemote() {
	busy('Matching…');
	try {
		const result = await window.aidash.sessions.matchRemote();
		if (result.note) {
			failed(result.note);
			return;
		}
		if (result.view) {
			view = result.view;
			paintSessions();
		}
		remotePanel.querySelector('.rp-report')?.remove();
		remotePanel.querySelector('.rp-note')?.insertAdjacentHTML('afterend', matchReport(result));
		done(result.matched ? `Attributed ${result.matched}` : 'Nothing could be attributed with confidence');
	} catch (err) {
		failed(reason(err));
	}
}

async function forgetMatches() {
	busy('Forgetting…');
	try {
		const result = await window.aidash.sessions.forgetMatches();
		if (result.view) {
			view = result.view;
			paintSessions();
		}
		remotePanel.querySelector('.rp-report')?.remove();
		done('Matches forgotten');
	} catch (err) {
		failed(reason(err));
	}
}

$('#sessions-remote').addEventListener('click', async () => {
	busy('Asking the server…');
	try {
		// The handler swallows its own failures, so this only guards against the
		// bridge itself being unavailable.
		const result = await window.aidash.sessions.remote();
		renderRemote(result);
		const read = (result.accounts ?? []).filter((a) => a.ok).length;
		done(read ? `Read ${read} account${read === 1 ? '' : 's'}` : 'Nothing could be read — the panel says why');
	} catch (err) {
		failed(reason(err));
	}
});

/* -------------------------------------------------------------------- load */

export async function rescan() {
	busy('Scanning…');
	try {
		view = await window.aidash.sessions.scan();
		paintSessions();
		const claude = view.accounts.reduce((n, a) => n + a.sessions, 0);
		const codex = view.codex?.sessions ?? 0;
		const orphans = view.unindexed ?? 0;
		setSummary(
			[
				`${claude} Claude`,
				codex ? `${codex} Codex` : null,
				orphans ? `${orphans} only in the CLI` : null,
				`across ${view.projects.length} project${view.projects.length === 1 ? '' : 's'}`,
			]
				.filter(Boolean)
				.join(' · '),
		);
		const repaired = view.repaired?.length ?? 0;
		if (repaired) done(`Repaired ${repaired} session${repaired === 1 ? '' : 's'} the desktop app was hiding — restart Claude Code to see ${repaired === 1 ? 'it' : 'them'}`);
		else notify('');
	} catch (err) {
		failed(reason(err));
	}
}

$('#sessions-rescan').addEventListener('click', rescan);

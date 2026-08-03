/**
 * Utils tab — Claude Code and Codex sessions side by side.
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

const UNINDEXED = 'unindexed';
const CODEX = 'codex';

const $ = (sel) => document.querySelector(sel);

const rootsBox = $('#roots');
const projectsBox = $('#projects');
const emptyBox = $('#sessions-empty');
const statusLabel = $('#sessions-status');

const renameDialog = $('#session-rename-dialog');
const renameInput = $('#session-rename-input');
const renameError = $('#session-rename-error');

let view = { accounts: [], projects: [] };
let dragging = null;
let renaming = null;

const formatSize = (bytes) =>
	bytes == null ? null : bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function setStatus(message, tone = 'muted') {
	statusLabel.textContent = message ?? '';
	statusLabel.className = tone;
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
		});
	}

	if (view.codex) {
		cols.push({ id: CODEX, tool: CODEX, name: 'Codex', under: `${view.codex.sessions} sessions · shared by every account` });
	}

	return cols;
}

/* ------------------------------------------------------------------ render */

function sessionCard(session, column, cwd) {
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
        data-cwd="${escapeHtml(cwd)}">
      <span class="s-head">
        <span class="s-title">${escapeHtml(session.title ?? '(untitled session)')}</span>
        ${actions}
      </span>
      <span class="s-meta">${escapeHtml(meta)}</span>
    </li>`;
}

function projectRow(project) {
	const cols = columns()
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

			return `
        <div class="col ${column.orphan ? 'orphan' : ''} ${column.tool === CODEX ? 'codex' : ''}"
             data-account="${escapeHtml(column.id)}" data-tool="${escapeHtml(column.tool)}" data-cwd="${escapeHtml(project.cwd)}">
          <div class="col-head">
            <span class="col-who">
              <b class="${column.orphan || (column.tool === 'claude' && !column.email) ? 'unknown' : ''}">${escapeHtml(column.name)}</b>
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
    <section class="project">
      <h3 title="${escapeHtml(project.cwd)}">${escapeHtml(project.cwd)}</h3>
      <div class="cols">${cols}</div>
    </section>`;
}

export function paintSessions() {
	rootsBox.innerHTML = [
		...view.accounts.map(
			(account) => `
        <span class="root-chip ${account.expired ? 'stale' : ''}">
          ${escapeHtml(accountName(account))} · ${escapeHtml(String(account.sessions))} sessions
        </span>`,
		),
		view.codex ? `<span class="root-chip">Codex · ${escapeHtml(String(view.codex.sessions))} sessions</span>` : '',
	].join('');

	const hasSessions = view.projects.length > 0;
	emptyBox.hidden = hasSessions;
	projectsBox.hidden = !hasSessions;
	projectsBox.innerHTML = view.projects.map(projectRow).join('');

	wireCards();
}

/* ------------------------------------------------------------------ actions */

function cardData(card) {
	return {
		tool: card.dataset.tool,
		entryFile: card.dataset.file || null,
		threadId: card.dataset.thread || null,
		transcript: card.dataset.transcript || null,
		title: card.dataset.title || '(untitled session)',
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
		setStatus('exporting…');
		try {
			const result = await window.aidash.sessions.export(data);
			setStatus(result ? `exported ${result.messages} messages to ${result.path}` : '', result ? 'ok-text' : 'muted');
		} catch (err) {
			setStatus(clean(err), 'error');
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
				setStatus('deleted', 'ok-text');
			}
		} catch (err) {
			setStatus(clean(err), 'error');
		}
	}
}

const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*/, '');

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
		setStatus('renamed', 'ok-text');
	} catch (err) {
		renameError.textContent = clean(err);
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
					setStatus('copying across tools…');
					next = await window.aidash.sessions.transfer({
						fromTool: source.tool,
						transcript: source.transcript,
						title: source.title,
						toAccountPath: target.path ?? null,
					});
					if (next) setStatus('copied — restart the receiving app to see it', 'ok-text');
					else setStatus('');
				} else if (source.fromColumn === UNINDEXED) {
					setStatus('adding…');
					next = await window.aidash.sessions.adopt({ transcriptFile: source.transcript, toAccountPath: target.path });
					setStatus('added — restart Claude Code to see it there', 'ok-text');
				} else {
					setStatus('moving…');
					next = await window.aidash.sessions.move({
						fromFile: source.entryFile,
						cliSessionId: source.cliSessionId,
						toAccountPath: target.path,
					});
					setStatus('moved — restart Claude Code to see it there', 'ok-text');
				}

				if (next) {
					view = next;
					paintSessions();
				}
			} catch (err) {
				setStatus(clean(err), 'error');
			}
		});
	}
}

/* -------------------------------------------------------------------- load */

export async function rescan() {
	setStatus('scanning…');
	try {
		view = await window.aidash.sessions.scan();
		paintSessions();
		const claude = view.accounts.reduce((n, a) => n + a.sessions, 0);
		const codex = view.codex?.sessions ?? 0;
		const orphans = view.unindexed ?? 0;
		setStatus(
			[
				`${claude} Claude`,
				codex ? `${codex} Codex` : null,
				orphans ? `${orphans} only in the CLI` : null,
				`across ${view.projects.length} project${view.projects.length === 1 ? '' : 's'}`,
			]
				.filter(Boolean)
				.join(' · '),
		);
	} catch (err) {
		setStatus(clean(err), 'error');
	}
}

$('#sessions-rescan').addEventListener('click', rescan);

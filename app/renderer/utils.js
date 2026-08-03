/**
 * Utils tab — moving Claude Code sessions between accounts.
 *
 * One row per project folder, one column per account. That shape is the rule
 * made visible: a session belongs to the directory it ran in, so it only ever
 * moves sideways within its own row.
 *
 * The columns are accounts as the desktop app knows them — an account/org pair
 * in its session index — not config directories. Several directories can be
 * signed in as the same account, and showing those separately would offer moves
 * that change nothing.
 */

import { escapeHtml, relativeTime } from './render.js';

// The column standing for transcripts no account has claimed: resumable from
// the terminal, invisible to the desktop app until one takes them.
const UNINDEXED = 'unindexed';

const $ = (sel) => document.querySelector(sel);

const rootsBox = $('#roots');
const projectsBox = $('#projects');
const emptyBox = $('#sessions-empty');
const statusLabel = $('#sessions-status');

let view = { accounts: [], projects: [] };
let dragging = null;

const formatSize = (bytes) =>
	bytes == null ? null : bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function setStatus(message, tone = 'muted') {
	statusLabel.textContent = message ?? '';
	statusLabel.className = tone;
}

const accountName = (account) => account.email ?? `account ${account.accountUuid.slice(0, 8)}`;

/** Accounts, with the unclaimed-transcripts column first when it has anything. */
function columns() {
	const hasOrphans = view.projects.some((p) => (p.byAccount[UNINDEXED]?.length ?? 0) > 0);
	const orphanColumn = {
		id: UNINDEXED,
		email: null,
		orphan: true,
		title: 'Only in the CLI',
		subtitle: 'not listed by any account',
	};
	return hasOrphans ? [orphanColumn, ...view.accounts] : view.accounts;
}

/* ------------------------------------------------------------------ render */

function sessionCard(session, accountId, cwd) {
	const meta = [
		session.lastAt ? relativeTime(session.lastAt) : null,
		formatSize(session.sizeBytes),
		session.branch,
		session.archived ? 'archived' : null,
		// A listed session whose transcript is gone will open empty; better to
		// say so than to let it look ordinary.
		session.transcript ? null : 'transcript missing',
	]
		.filter(Boolean)
		.join(' · ');

	return `
    <li class="session" draggable="true"
        data-file="${escapeHtml(session.file ?? '')}"
        data-transcript="${escapeHtml(session.transcript ?? '')}"
        data-cli="${escapeHtml(session.cliSessionId)}"
        data-account="${escapeHtml(accountId)}"
        data-cwd="${escapeHtml(cwd)}">
      <span class="s-title">${escapeHtml(session.title ?? '(untitled session)')}</span>
      <span class="s-meta">${escapeHtml(meta)}</span>
    </li>`;
}

function projectRow(project) {
	const cols = columns()
		.map((account) => {
			const sessions = project.byAccount[account.id] ?? [];
			const name = account.orphan ? account.title : accountName(account);
			const under = account.orphan ? account.subtitle : (account.orgName ?? account.orgUuid);
			// An account nobody is signed in as anywhere the app can read shows as
			// a bare id; adding it on the Usage tab is what gives it a name.
			const hint = account.orphan
				? ''
				: account.email
					? account.expired
						? '<span class="col-stale">credential expired — sign in again</span>'
						: ''
					: '<span class="col-stale">add this account on the Usage tab to name it</span>';
			return `
        <div class="col ${account.orphan ? 'orphan' : ''}" data-account="${escapeHtml(account.id)}" data-cwd="${escapeHtml(project.cwd)}">
          <div class="col-head">
            <span class="col-who">
              <b class="${account.orphan || !account.email ? 'unknown' : ''}">${escapeHtml(name)}</b>
              <span class="col-path">${escapeHtml(under)}</span>
              ${hint}
            </span>
            <span class="col-count">${sessions.length || ''}</span>
          </div>
          <ul class="sessions">
            ${sessions.map((s) => sessionCard(s, account.id, project.cwd)).join('') || '<li class="drop-hint">drop here</li>'}
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
	rootsBox.innerHTML = view.accounts
		.map(
			(account) => `
        <span class="root-chip ${account.expired ? 'stale' : ''}">
          ${escapeHtml(accountName(account))} · ${escapeHtml(String(account.sessions))} sessions
        </span>`,
		)
		.join('');

	const hasSessions = view.projects.length > 0;
	emptyBox.hidden = hasSessions;
	projectsBox.hidden = !hasSessions;
	projectsBox.innerHTML = view.projects.map(projectRow).join('');

	wireDragAndDrop();
}

/* -------------------------------------------------------------- drag & drop */

function wireDragAndDrop() {
	for (const card of projectsBox.querySelectorAll('.session')) {
		card.addEventListener('dragstart', (e) => {
			dragging = {
				file: card.dataset.file || null,
				transcript: card.dataset.transcript || null,
				cliSessionId: card.dataset.cli,
				fromAccount: card.dataset.account,
				cwd: card.dataset.cwd,
			};
			card.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'move';
			// Firefox refuses to start a drag without payload; the real state is
			// held above, since dataTransfer is unreadable during dragover.
			e.dataTransfer.setData('text/plain', card.dataset.cli);
		});
		card.addEventListener('dragend', () => {
			card.classList.remove('dragging');
			dragging = null;
			for (const col of projectsBox.querySelectorAll('.col')) col.classList.remove('over');
		});
	}

	for (const col of projectsBox.querySelectorAll('.col')) {
		// Nothing is ever dropped back into the unclaimed column: that would mean
		// deleting an index entry, and with it whatever the desktop app recorded
		// against the session.
		const acceptable = () =>
			dragging && dragging.cwd === col.dataset.cwd && dragging.fromAccount !== col.dataset.account && col.dataset.account !== UNINDEXED;

		col.addEventListener('dragover', (e) => {
			if (!acceptable()) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			col.classList.add('over');
		});

		col.addEventListener('dragleave', () => col.classList.remove('over'));

		col.addEventListener('drop', async (e) => {
			e.preventDefault();
			col.classList.remove('over');
			if (!acceptable()) return;

			const toAccountPath = view.accounts.find((a) => a.id === col.dataset.account)?.path;
			const fromOrphan = dragging.fromAccount === UNINDEXED;
			const request = fromOrphan
				? { transcriptFile: dragging.transcript, toAccountPath }
				: { fromFile: dragging.file, cliSessionId: dragging.cliSessionId, toAccountPath };
			dragging = null;

			setStatus(fromOrphan ? 'adding…' : 'moving…');
			try {
				view = fromOrphan ? await window.aidash.sessions.adopt(request) : await window.aidash.sessions.move(request);
				paintSessions();
				setStatus(`${fromOrphan ? 'added' : 'moved'} — restart Claude Code to see it there`, 'ok-text');
			} catch (err) {
				setStatus(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*/, ''), 'error');
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
		const total = view.accounts.reduce((n, a) => n + a.sessions, 0);
		const orphans = view.unindexed ?? 0;
		setStatus(
			`${total} session${total === 1 ? '' : 's'} across ${view.projects.length} project${view.projects.length === 1 ? '' : 's'}` +
				(orphans ? ` · ${orphans} only in the CLI` : ''),
		);
	} catch (err) {
		setStatus(String(err?.message ?? err), 'error');
	}
}

$('#sessions-rescan').addEventListener('click', rescan);

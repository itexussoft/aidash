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
        data-file="${escapeHtml(session.file)}"
        data-cli="${escapeHtml(session.cliSessionId)}"
        data-account="${escapeHtml(accountId)}"
        data-cwd="${escapeHtml(cwd)}">
      <span class="s-title">${escapeHtml(session.title ?? '(untitled session)')}</span>
      <span class="s-meta">${escapeHtml(meta)}</span>
    </li>`;
}

function projectRow(project) {
	const columns = view.accounts
		.map((account) => {
			const sessions = project.byAccount[account.id] ?? [];
			return `
        <div class="col" data-account="${escapeHtml(account.id)}" data-cwd="${escapeHtml(project.cwd)}">
          <div class="col-head">
            <span class="col-who">
              <b class="${account.email ? '' : 'unknown'}">${escapeHtml(accountName(account))}</b>
              <span class="col-path" title="${escapeHtml(account.path)}">${escapeHtml(account.orgName ?? account.orgUuid)}</span>
              ${account.expired ? '<span class="col-stale">credential expired — sign in again</span>' : ''}
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
      <div class="cols">${columns}</div>
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
				file: card.dataset.file,
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
		const acceptable = () => dragging && dragging.cwd === col.dataset.cwd && dragging.fromAccount !== col.dataset.account;

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

			const request = {
				fromFile: dragging.file,
				cliSessionId: dragging.cliSessionId,
				toAccountPath: view.accounts.find((a) => a.id === col.dataset.account)?.path,
			};
			dragging = null;

			setStatus('moving…');
			try {
				view = await window.aidash.sessions.move(request);
				paintSessions();
				setStatus('moved — restart Claude Code to see it there', 'ok-text');
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
		setStatus(
			`${total} session${total === 1 ? '' : 's'} across ${view.projects.length} project${view.projects.length === 1 ? '' : 's'}`,
		);
	} catch (err) {
		setStatus(String(err?.message ?? err), 'error');
	}
}

$('#sessions-rescan').addEventListener('click', rescan);

$('#add-root').addEventListener('click', async () => {
	try {
		await window.aidash.sessions.addRoot();
		await rescan();
	} catch (err) {
		setStatus(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*/, ''), 'error');
	}
});

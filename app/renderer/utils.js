/**
 * Utils tab — moving Claude Code sessions between accounts.
 *
 * Laid out as one row per project folder, with a column per account. That
 * shape is the rule made visible: a session belongs to the directory it ran
 * in, so it can only be dropped into a sibling column of its own row.
 */

import { escapeHtml, relativeTime } from './render.js';

const $ = (sel) => document.querySelector(sel);

const rootsBox = $('#roots');
const projectsBox = $('#projects');
const emptyBox = $('#sessions-empty');
const statusLabel = $('#sessions-status');

let view = { roots: [], projects: [] };
let dragging = null;

const formatSize = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function setStatus(message, tone = 'muted') {
	statusLabel.textContent = message ?? '';
	statusLabel.className = tone;
}

/* ------------------------------------------------------------------ render */

function rootLabel(root) {
	// `email` from the enrolled account is the reliable one; the live probe is a
	// fallback for folders the app does not otherwise know about.
	const who = root.email ?? (root.loggedIn ? 'signed in' : 'not signed in');
	return [root.label, who, root.plan].filter(Boolean).join(' · ');
}

function sessionCard(session, rootId, projectKey) {
	const title = session.title ?? '(untitled session)';
	return `
    <li class="session" draggable="true"
        data-session="${escapeHtml(session.id)}"
        data-root="${escapeHtml(rootId)}"
        data-project="${escapeHtml(projectKey)}">
      <span class="s-title">${escapeHtml(title)}</span>
      <span class="s-meta">
        ${escapeHtml(relativeTime(session.lastAt))} · ${escapeHtml(formatSize(session.sizeBytes))}
        ${session.branch ? ` · ${escapeHtml(session.branch)}` : ''}
      </span>
    </li>`;
}

function projectRow(project) {
	const columns = view.roots
		.map((root) => {
			const sessions = project.byRoot[root.id] ?? [];
			// You drag between accounts, not between folders, so the account is
			// what the column is named after. The plan is part of that name
			// because one address can be signed in twice under different plans,
			// and the folder stays as the subtitle to tell those apart for certain.
			const who = root.email ?? (root.loggedIn ? 'signed in' : 'not signed in');
			const subtitle = [root.plan, root.label].filter(Boolean).join(' · ');
			return `
        <div class="col" data-root="${escapeHtml(root.id)}" data-project="${escapeHtml(project.key)}">
          <div class="col-head">
            <span class="col-who">
              <b class="${root.email ? '' : 'unknown'}">${escapeHtml(who)}</b>
              <span class="col-path" title="${escapeHtml(root.path ?? '')}">${escapeHtml(subtitle)}</span>
            </span>
            <span class="col-count">${sessions.length || ''}</span>
          </div>
          <ul class="sessions">
            ${sessions.map((s) => sessionCard(s, root.id, project.key)).join('') || '<li class="drop-hint">drop here</li>'}
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
	rootsBox.innerHTML = view.roots
		.map(
			(root) => `
        <span class="root-chip ${root.loggedIn ? '' : 'stale'}">
          ${escapeHtml(rootLabel(root))}
          ${
						// Only hand-picked folders can be forgotten here; the others follow
						// from an enrolled account, which is removed in the Usage tab.
						root.kind === 'manual'
							? `<button class="root-remove" data-id="${escapeHtml(root.id)}" title="Stop listing this folder">×</button>`
							: ''
					}
        </span>`,
		)
		.join('');

	for (const btn of rootsBox.querySelectorAll('.root-remove')) {
		btn.addEventListener('click', async () => {
			await window.aidash.sessions.removeRoot(btn.dataset.id);
			await rescan();
		});
	}

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
			dragging = { sessionId: card.dataset.session, fromRoot: card.dataset.root, projectKey: card.dataset.project };
			card.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'move';
			// Firefox refuses to start a drag without payload; the real state is
			// held above, since dataTransfer is unreadable during dragover.
			e.dataTransfer.setData('text/plain', card.dataset.session);
		});
		card.addEventListener('dragend', () => {
			card.classList.remove('dragging');
			dragging = null;
			for (const col of projectsBox.querySelectorAll('.col')) col.classList.remove('over', 'refused');
		});
	}

	for (const col of projectsBox.querySelectorAll('.col')) {
		const acceptable = () =>
			dragging && dragging.projectKey === col.dataset.project && dragging.fromRoot !== col.dataset.root;

		col.addEventListener('dragover', (e) => {
			if (!dragging) return;
			// Rows are independent: a column from another project must visibly
			// refuse rather than silently ignore the drop.
			if (dragging.projectKey !== col.dataset.project) return;
			if (dragging.fromRoot === col.dataset.root) return;
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
				fromDir: view.roots.find((r) => r.id === dragging.fromRoot)?.path,
				toDir: view.roots.find((r) => r.id === col.dataset.root)?.path,
				projectKey: dragging.projectKey,
				sessionId: dragging.sessionId,
			};
			dragging = null;

			setStatus('moving…');
			try {
				view = await window.aidash.sessions.move(request);
				paintSessions();
				setStatus('moved', 'ok-text');
				setTimeout(() => setStatus(''), 2500);
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
		const total = view.projects.reduce((n, p) => n + Object.values(p.byRoot).reduce((m, s) => m + s.length, 0), 0);
		setStatus(`${total} session${total === 1 ? '' : 's'} across ${view.projects.length} project${view.projects.length === 1 ? '' : 's'}`);
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

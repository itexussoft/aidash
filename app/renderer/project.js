/**
 * One project, with the account columns collapsed away.
 *
 * The Sessions tab is organised the way the *storage* is: one column per place
 * a session can live, because that is what a drag has to respect. This page is
 * organised the way the work was: one column, in time order, whoever you
 * happened to be signed in as and whichever tool you happened to use.
 *
 * Both views are of the same rows. The question they answer is different —
 * "where does this session live" against "what happened in this repository
 * yesterday" — and the second one has no answer anywhere else, because each
 * vendor's client can only ever see its own account.
 */

import { escapeHtml, relativeTime } from './render.js';
import { remoteBadge } from './remote-badge.js';
import { notify, busy, done, failed, reason } from './notify.js';

const $ = (sel) => document.querySelector(sel);

const page = $('.page[data-page="project"]');
const titleBox = $('#project-title');
const pathBox = $('#project-path');
const summaryBox = $('#project-summary');
const timelineBox = $('#project-timeline');
const digestBox = $('#project-digest');

let current = null;
let markdown = '';

const dayOf = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const formatSize = (bytes) =>
	bytes == null ? null : bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Every session of the project as one list, newest first.
 *
 * `columns` is what names a source: an account, the CLI-only column, or Codex.
 * Without it a merged list would be a heap of titles with no way to tell which
 * identity produced which, which is the one thing this view exists to show.
 */
export function flatten(project, columns) {
	const rows = [];
	for (const column of columns) {
		for (const session of project.byAccount[column.id] ?? []) {
			rows.push({
				...session,
				source: column.name,
				tool: column.tool,
				orphan: Boolean(column.orphan),
			});
		}
	}
	return rows.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

function row(session, columns) {
	const meta = [
		session.model,
		session.branch,
		formatSize(session.sizeBytes),
		session.tokens ? `${Math.round(session.tokens / 1000)}k tokens` : null,
		session.archived ? 'archived' : null,
		session.transcript ? null : 'transcript missing',
	]
		.filter(Boolean)
		.join(' · ');

	return `
    <li class="tl-row">
      <span class="tl-when">${escapeHtml(session.lastAt ? clock(session.lastAt) : '—')}</span>
      <span class="tl-body">
        <span class="tl-line">
          <span class="tl-name">${escapeHtml(session.title ?? '(untitled session)')}</span>
          <span class="tl-src ${escapeHtml(session.tool)} ${session.orphan ? 'orphan' : ''}">${escapeHtml(session.source)}</span>
          ${remoteBadge(session, columns)}
        </span>
        ${meta ? `<span class="tl-meta">${escapeHtml(meta)}</span>` : ''}
      </span>
    </li>`;
}

/** Grouped by day, because "yesterday" is the unit the question is asked in. */
function timeline(rows, columns) {
	if (!rows.length) return '<p class="muted">No sessions recorded for this project.</p>';

	const out = [];
	let day = null;

	for (const session of rows) {
		const stamp = session.lastAt ? dayOf(session.lastAt) : 'undated';
		if (stamp !== day) {
			if (day !== null) out.push('</ul></section>');
			out.push(`<section class="tl-day"><h3>${escapeHtml(stamp)}</h3><ul class="tl-rows">`);
			day = stamp;
		}
		out.push(row(session, columns));
	}
	out.push('</ul></section>');
	return out.join('');
}

export function openProject(project, columns) {
	current = { project, columns };
	markdown = '';

	const rows = flatten(project, columns);
	const bySource = new Map();
	for (const session of rows) bySource.set(session.source, (bySource.get(session.source) ?? 0) + 1);

	const name = project.cwd.split('/').filter(Boolean).pop() ?? project.cwd;
	titleBox.textContent = name;
	pathBox.textContent = project.cwd;
	summaryBox.textContent = [
		`${rows.length} session${rows.length === 1 ? '' : 's'}`,
		`${bySource.size} source${bySource.size === 1 ? '' : 's'}`,
		[...bySource].map(([source, n]) => `${source} ${n}`).join(' · '),
	]
		.filter(Boolean)
		.join(' — ');

	timelineBox.innerHTML = timeline(rows, columns);
	digestBox.innerHTML = '';
	digestBox.hidden = true;

	for (const other of document.querySelectorAll('.page')) other.hidden = other !== page;
	page.hidden = false;
	window.scrollTo(0, 0);
}

function closeProject() {
	current = null;
	for (const other of document.querySelectorAll('.page')) other.hidden = other.dataset.page !== 'utils';
}

/* ------------------------------------------------------------------ digest */

async function makeDigest() {
	if (!current) return;

	busy('Reading transcripts…');
	try {
		const rows = flatten(current.project, current.columns);
		const result = await window.aidash.sessions.digest({
			cwd: current.project.cwd,
			sources: [...new Set(rows.map((r) => r.source))],
			sessions: rows.map((r) => ({ transcript: r.transcript, tool: r.tool, title: r.title, source: r.source })),
		});

		markdown = result.markdown;
		const { digest } = result;

		digestBox.innerHTML = `
      <div class="dg-head">
        <b>Project brief</b>
        <span class="dg-actions">
          <button id="digest-copy" class="primary">Copy</button>
          <button id="digest-save" class="ghost">Save as file…</button>
        </span>
      </div>
      <p class="dg-note">
        Read from the ${digest.read} most recent transcript${digest.read === 1 ? '' : 's'} on this machine — ${digest.files.length}
        file${digest.files.length === 1 ? '' : 's'} touched${digest.branches.length ? `, ${digest.branches.length} branch${digest.branches.length === 1 ? '' : 'es'}` : ''}.
        Nothing is summarised: paste it as the first message of a session under another account.
      </p>
      <pre class="dg-body">${escapeHtml(markdown)}</pre>`;
		digestBox.hidden = false;

		$('#digest-copy').addEventListener('click', copyDigest);
		$('#digest-save').addEventListener('click', saveDigest);
		done(`Read ${digest.read} transcript${digest.read === 1 ? '' : 's'}`);
	} catch (err) {
		failed(reason(err));
	}
}

async function copyDigest() {
	try {
		await navigator.clipboard.writeText(markdown);
		done('Brief copied');
	} catch (err) {
		failed(reason(err));
	}
}

async function saveDigest() {
	try {
		const saved = await window.aidash.sessions.saveDigest({ markdown, cwd: current?.project.cwd });
		if (saved) done('Brief saved');
		else notify('');
	} catch (err) {
		failed(reason(err));
	}
}

$('#project-back').addEventListener('click', closeProject);
$('#project-digest-make').addEventListener('click', makeDigest);

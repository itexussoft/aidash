/**
 * The Remote Control badge markup, shared by every place a session is listed.
 *
 * Kept in one place because the explanation is the point of the badge — three
 * states that look almost identical (a solid pill, a struck-through one, a
 * dashed one) and mean different things, so the hover text is what actually
 * tells them apart. A badge drawn without it would be decoration.
 *
 * The explanation is drawn by this app rather than left to the browser's own
 * `title` tooltip: the badge sits inside a `draggable="true"` card on the
 * Sessions tab, and Chromium's native tooltip is unreliable on descendants of
 * a draggable element — it can simply never appear, with no error to notice.
 * A tooltip built from ordinary CSS has no such dependency, and unlike the
 * native one it is themed, does not clip at the window edge behind a
 * scrollbar, and can be reasoned about like the rest of the interface.
 */

import { escapeHtml } from './render.js';

/**
 * `columns` names the places a session can be listed, so the tooltip can say
 * *which* accounts a link is set up under rather than just how many.
 */
export function remoteBadge(session, columns) {
	const count = session.bridges?.length ?? 0;
	if (!session.bridge || !count) return '';

	const links = `${count} link${count === 1 ? '' : 's'}`;

	const explain = {
		here: `Remote Control has been enabled for this session (${links}). It belongs to this account.`,
		elsewhere:
			`This session was moved here from another account, which is where its Remote Control link (${links}) stays — ` +
			'it is listed there, not here. Drag it back to that account to restore it.',
		shared:
			`This session is listed by more than one account, and its Remote Control link (${links}) can only belong to one of them. ` +
			'Nothing stored on this machine says which, so neither listing is treated as the owner.',
	}[session.bridge];

	if (!explain) return '';

	// Which accounts have it set up, by name rather than by uuid. Read off the
	// listings themselves, so it is exact and costs nothing.
	const configured = (session.remoteAccounts ?? [])
		.map((id) => columns?.find((c) => c.id === id)?.name ?? id)
		.sort((a, b) => a.localeCompare(b));

	const where = configured.length ? `\n\nSet up under: ${configured.join(', ')}` : '';

	// How it is known, when it is known by more than "nothing says otherwise".
	const evidence =
		session.bridgeVia === 'matched'
			? '\n\nEstablished by matching the title against the remote sessions the server lists for each account.'
			: session.bridgeVia === 'moved'
				? '\n\nKnown because this app performed the move.'
				: '';

	const text = session.bridge === 'shared' ? 'remote?' : 'remote';
	// `data-explain`, not `title`: the tooltip below is drawn by this app's own
	// CSS (`content: attr(data-explain)`), not the browser's native one.
	// `tabindex` makes it reachable — and the tooltip visible — without a mouse.
	return `<span class="s-remote ${escapeHtml(session.bridge)}" tabindex="0" data-explain="${escapeHtml(explain + where + evidence)}">${escapeHtml(text)}</span>`;
}

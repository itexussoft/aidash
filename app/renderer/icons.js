/**
 * The line-icon set, in one place.
 *
 * A button whose only signal is text colour on hover is not discoverable —
 * that is the whole reason "merge and remove" went unnoticed on a chip that
 * looked, at rest, like a label rather than a control. An icon fixes that even
 * before colour does: shape is visible at a glance, colour only once you look.
 *
 * Every icon shares one geometry (18×18, 1.6 stroke, round caps and joins) so a
 * row of them reads as one alphabet rather than several typefaces, and every
 * one uses `currentColor` so it inherits whatever colour its button already
 * carries — semantic tinting is CSS's job, not this file's.
 */

const svg = (body, size = 14) =>
	`<svg class="icon" viewBox="0 0 18 18" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
	refresh: (size) => svg('<path d="M3 8a6 6 0 0 1 10.2-4.2M15 8a6 6 0 0 1-10.2 4.2"/><path d="M13.5 2.5v3.5H10"/><path d="M4.5 15.5V12H8"/>', size),
	plus: (size) => svg('<path d="M9 3.5v11M3.5 9h11"/>', size),
	pencil: (size) => svg('<path d="M11.3 2.8 15.2 6.7 6 15.9 2.3 16.7l.8-3.7z"/><path d="M9.9 4.2l3.9 3.9"/>', size),
	trash: (size) => svg('<path d="M3.5 5h11M7 5V3.3h4V5M6 5v10h6V5M7.5 8v4M10.5 8v4"/>', size),
	// Two overlapping frames — a second copy of the same window, which is
	// literally what a separate instance is.
	copy: (size) => svg('<rect x="3" y="5.5" width="9" height="9" rx="1.6"/><path d="M6 5.5V3.6C6 3 6.5 2.5 7 2.5h6.4c.6 0 1.1.5 1.1 1.1v6.4c0 .6-.5 1-1.1 1H12"/>', size),
	// A key: what "sign in again" hands over, and the one glyph in this set that
	// says credentials rather than records.
	key: (size) =>
		svg('<circle cx="6.4" cy="11.6" r="3.4"/><path d="M8.8 9.2 15.4 2.6"/><path d="M12.2 5.8l1.8 1.8"/><path d="M14 4l1.8 1.8"/>', size),
	folder: (size) => svg('<path d="M2.5 4.8c0-.7.6-1.3 1.3-1.3h3l1.4 1.6h6c.7 0 1.3.6 1.3 1.3v6.3c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3z"/>', size),
	folderPlus: (size) => svg('<path d="M2.5 4.8c0-.7.6-1.3 1.3-1.3h3l1.4 1.6h6c.7 0 1.3.6 1.3 1.3v6.3c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3z"/><path d="M9 8v4M7 10h4"/>', size),
	// The familiar git-graph merge: a branch curving in to join a trunk that
	// carries on — the second folder's sessions folding into the one everything
	// else already reads from.
	merge: (size) =>
		svg(
			'<path d="M13.5 5.3V14"/><path d="M4.5 5.3v3.2c0 2.3 1.9 4 4.2 4h4.8"/><circle cx="4.5" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="13.5" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="13.5" cy="14" r="1.5" fill="currentColor" stroke="none"/>',
			size,
		),
	eye: (size) => svg('<path d="M1.5 9S4.2 4 9 4s7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="9" cy="9" r="2.2"/>', size),
	eyeOff: (size) =>
		svg(
			'<path d="M2.7 2.7l12.6 12.6"/><path d="M7.2 4.3C8 4.1 8.5 4 9 4c4.8 0 7.5 5 7.5 5a13.6 13.6 0 0 1-2.9 3.5M4.9 5.5A13.5 13.5 0 0 0 1.5 9s2.7 5 7.5 5c.9 0 1.7-.2 2.5-.4"/><path d="M7.1 7.1a2.2 2.2 0 0 0 3 3"/>',
			size,
		),
	unlink: (size) =>
		svg('<path d="M7.5 10.5 10.5 7.5"/><path d="M8.3 5.3l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1"/><path d="M9.7 12.7l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/><path d="M2.5 2.5l2 2M15.5 15.5l-2-2"/>', size),
};

/** `${icon('pencil')}` — the common case, at the common size. */
export const icon = (name, size) => icons[name]?.(size) ?? '';

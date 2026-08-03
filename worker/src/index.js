/**
 * aidash.itex.us — landing page and update manifest.
 *
 * All the dashboard machinery this Worker used to carry is gone: usage is now
 * read by the desktop app, on the machine that owns the credentials. What
 * remains is a page describing the app and the manifest it checks for updates.
 */

import { renderLanding } from './landing.js';

// Bumped together with the app's version in package.json when a build is
// published. Kept here rather than in a database because it changes exactly as
// often as this Worker is deployed.
const REPO = 'https://github.com/itexussoft/aidash';

/** Release assets are served straight from the GitHub release. */
const asset = (version, file) => `${REPO}/releases/download/v${version}/${file}`;

// The one line `npm run release` rewrites. Everything below derives from it, so
// a bump cannot leave a download link pointing at the previous version's files.
const VERSION = '0.1.3';

/**
 * Where each platform's installer lives, under the names electron-builder gives
 * them. The Windows one has spaces — "aidash Setup 0.1.0.exe" — and GitHub
 * serves such assets with the spaces turned into dots, which is what the link
 * has to say.
 *
 * A platform missing here is shown on the landing as not yet built rather than
 * linked to a 404. Windows on ARM is deliberately absent: it runs the x64 build
 * under emulation, and shipping an untested native build is worse than that.
 */
const downloadsFor = (version) => ({
	'darwin-arm64': asset(version, `aidash-${version}-arm64.dmg`),
	'darwin-x64': asset(version, `aidash-${version}.dmg`),
	'win32-x64': asset(version, `aidash.Setup.${version}.exe`),
});

/** The published release. */
const RELEASE = {
	version: VERSION,
	notes: null,
	url: 'https://aidash.itex.us',
	repo: REPO,
	downloads: downloadsFor(VERSION),
};

export default {
	async fetch(request) {
		const { pathname } = new URL(request.url);

		if (pathname === '/version.json') {
			return Response.json(RELEASE, {
				headers: {
					// Short enough that a new release is noticed promptly, long
					// enough that launching the app is not a request per second.
					'cache-control': 'public, max-age=300',
					'access-control-allow-origin': '*',
				},
			});
		}

		if (pathname === '/' || pathname === '/index.html') {
			const html = renderLanding({
				version: RELEASE.version,
				downloads: RELEASE.downloads,
				repoUrl: RELEASE.repo,
			});
			return new Response(html, {
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' },
			});
		}

		return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
	},
};

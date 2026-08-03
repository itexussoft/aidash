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

/**
 * The published release.
 *
 * Bumped by `npm run release`, which tags and pushes; GitHub Actions builds
 * every platform and attaches the files under exactly these names. A platform
 * missing from `downloads` is shown on the landing as not yet built rather than
 * linked to a 404.
 */
const RELEASE = {
	version: '0.1.0',
	notes: null,
	url: 'https://aidash.itex.us',
	repo: REPO,
	downloads: {
		'darwin-arm64': asset('0.1.0', 'aidash-0.1.0-arm64.dmg'),
		'darwin-x64': asset('0.1.0', 'aidash-0.1.0.dmg'),
		'win32-x64': asset('0.1.0', 'aidash Setup 0.1.0.exe'),
	},
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

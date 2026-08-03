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
const RELEASE = {
	version: '0.1.0',
	notes: null,
	url: 'https://aidash.itex.us',
	repo: 'https://gitlab.itexus.com/tools/aidash',
	// Per-platform builds, keyed the way the app asks for them. The permalink
	// always points at the newest release, so publishing does not require
	// editing these.
	downloads: {
		'darwin-arm64': 'https://gitlab.itexus.com/tools/aidash/-/releases/permalink/latest',
		'darwin-x64': 'https://gitlab.itexus.com/tools/aidash/-/releases/permalink/latest',
		darwin: 'https://gitlab.itexus.com/tools/aidash/-/releases/permalink/latest',
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
				downloadUrl: RELEASE.downloads.darwin,
				repoUrl: RELEASE.repo,
			});
			return new Response(html, {
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' },
			});
		}

		return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
	},
};

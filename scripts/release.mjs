#!/usr/bin/env node
/**
 * Cuts a release.
 *
 * The version in package.json is the single source of truth: it names the
 * artefacts, the git tag, the package-registry folder and the manifest the app
 * checks. Everything downstream is derived, so the three can never drift.
 *
 *   npm run release -- 0.2.0
 *
 * Needs GITLAB_TOKEN with api scope to publish. Without one it still builds and
 * prints what would be uploaded, so a dry run costs nothing.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ID = 1189;
const HOST = 'https://gitlab.itexus.com';
const PACKAGE = 'aidash';

const token = process.env.GITLAB_TOKEN;
const say = (msg) => console.log(`  ${msg}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

/* ------------------------------------------------------------------ version */

const requested = process.argv[2];
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

if (requested) {
	if (!/^\d+\.\d+\.\d+$/.test(requested)) {
		console.error(`Version must look like 1.2.3, not "${requested}".`);
		process.exit(1);
	}
	pkg.version = requested;
	await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
	say(`version set to ${requested}`);
}

const version = pkg.version;
const tag = `v${version}`;

// A dirty tree means the artefacts would not match the tag.
const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty && !requested) {
	console.error('Working tree is not clean — commit first, or pass a version to bump.');
	process.exit(1);
}

/* -------------------------------------------------------------------- build */

console.log(`\nBuilding ${tag}\n`);
run('npx', ['electron-builder', '--mac', 'dmg', '--arm64', '--x64']);

const dist = join(ROOT, 'dist');
const artefacts = (await readdir(dist)).filter((f) => /\.(dmg|exe|AppImage|zip)$/.test(f) && f.includes(version));

if (artefacts.length === 0) {
	console.error('\nNothing was built. Check the electron-builder output above.');
	process.exit(1);
}

console.log('');
for (const file of artefacts) {
	const { size } = await stat(join(dist, file));
	say(`${file}  ${(size / 1048576).toFixed(0)} MB`);
}

/* ------------------------------------------------------------------ publish */

const packageUrl = (file) => `${HOST}/api/v4/projects/${PROJECT_ID}/packages/generic/${PACKAGE}/${version}/${file}`;

if (!token) {
	console.log('\nGITLAB_TOKEN is not set, so nothing was published. To finish:\n');
	say(`git tag ${tag} && git push origin ${tag}`);
	say(`then upload the files above at ${HOST}/tools/aidash/-/releases/new`);
	console.log('\nOr set GITLAB_TOKEN (api scope) and run this again.\n');
	process.exit(0);
}

console.log('\nUploading\n');
for (const file of artefacts) {
	// The generic package registry gives each file a stable, public URL — which
	// is what the landing page and the update manifest both point at.
	const res = await fetch(packageUrl(file), {
		method: 'PUT',
		headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/octet-stream' },
		body: createReadStream(join(dist, file)),
		duplex: 'half',
	});
	if (!res.ok) {
		console.error(`  failed to upload ${file}: HTTP ${res.status} ${await res.text()}`);
		process.exit(1);
	}
	say(`${file} → package registry`);
}

try {
	run('git', ['tag', tag]);
} catch {
	say(`tag ${tag} already exists`);
}
run('git', ['push', 'origin', 'main', '--tags']);

const release = await fetch(`${HOST}/api/v4/projects/${PROJECT_ID}/releases`, {
	method: 'POST',
	headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
	body: JSON.stringify({
		tag_name: tag,
		name: tag,
		description: `aidash ${version}`,
		assets: { links: artefacts.map((file) => ({ name: file, url: packageUrl(file), link_type: 'package' })) },
	}),
});

if (!release.ok) {
	console.error(`\nCould not create the release: HTTP ${release.status} ${await release.text()}`);
	process.exit(1);
}

console.log(`\n  released ${tag} — ${HOST}/tools/aidash/-/releases/${tag}`);
console.log('  now update RELEASE in worker/src/index.js and run npm run site:deploy\n');

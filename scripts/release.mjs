#!/usr/bin/env node
/**
 * Cuts a release.
 *
 * The version in package.json is the single source of truth: it names the tag,
 * the artefacts and the manifest the app checks, so the three cannot drift.
 * This script only bumps and tags — the building and publishing happen on
 * GitHub Actions, which has the Windows runner that packaging NSIS needs and
 * that no Mac has.
 *
 *   npm run release -- 0.2.0
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'itexussoft/aidash';

const say = (msg) => console.log(`  ${msg}`);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });

const requested = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(requested ?? '')) {
	console.error('\nUsage: npm run release -- 1.2.3\n');
	process.exit(1);
}

const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty) {
	console.error('\nWorking tree is not clean — commit first.\n');
	process.exit(1);
}

/* ------------------------------------------------------------------ version */

const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
pkg.version = requested;
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// The Worker serves the manifest the app polls, so it has to name the same
// version the build will carry.
const workerPath = join(ROOT, 'worker', 'src', 'index.js');
const worker = await readFile(workerPath, 'utf8');
const bumped = worker.replace(/(version:\s*')[\d.]+(')/, `$1${requested}$2`);
if (bumped === worker) {
	console.error('\nCould not find the version in worker/src/index.js — check the RELEASE block.\n');
	process.exit(1);
}
await writeFile(workerPath, bumped);

const tag = `v${requested}`;
say(`version set to ${requested}`);

run('git', ['add', 'package.json', 'worker/src/index.js']);
run('git', ['commit', '-m', `Release ${tag}`]);
run('git', ['tag', tag]);
run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', tag]);

console.log(`
  Pushed ${tag}. GitHub Actions is now building macOS and Windows:
  https://github.com/${REPO}/actions

  When it finishes, the release appears at
  https://github.com/${REPO}/releases/tag/${tag}

  Then deploy the site so the download links and update manifest point at it:
  npm run site:deploy
`);

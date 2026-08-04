/**
 * Second copies of Claude Desktop, one per account.
 *
 * Claude Desktop is an Electron app, and everything that makes an account an
 * account lives in its user data directory: the web session it is signed in
 * with, and — the part that matters here — the session index at
 * `<user data>/claude-code-sessions/<accountUuid>/<orgUuid>/`.
 *
 * So pointing a second copy at a second directory gives a second signed-in
 * account running beside the first, with its own index. Two facts make it work,
 * and both were measured rather than assumed:
 *
 *   - Electron's single-instance lock lives *inside* the user data directory,
 *     so two copies with different directories do not fight over it. Two ran
 *     side by side.
 *   - The directory is populated from scratch on first launch — its own
 *     `config.json`, cookies and storage — so the second copy starts signed
 *     out rather than inheriting the first one's account.
 *
 * What is deliberately *not* done here is set `CLAUDE_CONFIG_DIR`. Every
 * instance shares `~/.claude`, which means one set of settings, one CLAUDE.md,
 * one skills directory, and — the part the rest of the app leans on — one
 * transcripts directory. A session therefore still belongs to an account by
 * virtue of an index entry alone, so moving one between instances stays the
 * move of a single small JSON file, exactly as it is between accounts within
 * one instance. Splitting the config directory too would have made every move
 * a file copy and every instance a separate pile of settings to keep in step.
 *
 * That choice also removes the reason to care that `open` does not pass an
 * environment through LaunchServices: with nothing to pass, the macOS-native
 * launcher is simply the right one.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

/** Where Claude Desktop keeps its own session index inside a profile. */
export const indexIn = (userDataDir) => join(userDataDir, 'claude-code-sessions');

/** The profile directory for an account, derived rather than remembered. */
export const instanceDirIn = (instancesDir, accountId) => join(instancesDir, accountId);

/**
 * Makes sense of a folder chosen by hand.
 *
 * Both readings are reasonable from a file dialog — the profile directory, or
 * the `claude-code-sessions` folder inside it — so both are accepted rather
 * than one being declared correct and the other silently producing a column
 * that never appears. Returns null when the folder is neither, which is the
 * answer the caller should show rather than adding a root that reads nothing.
 */
export async function readIndexRoot(picked) {
	const reachable = (p) => access(p).then(() => true, () => false);

	const inside = indexIn(picked);
	if (await reachable(inside)) return { profile: picked, path: inside };
	if (basename(picked) === 'claude-code-sessions') return { profile: dirname(picked), path: picked };
	return null;
}

/**
 * Where Claude Desktop is installed.
 *
 * Unlike the CLI clients in locate.js there is nothing to probe: a GUI bundle
 * does not answer `--version`, and asking would mean launching it. Existence on
 * disk is the whole test.
 */
export function findDesktop(platform = process.platform) {
	const candidates =
		platform === 'darwin'
			? ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')]
			: platform === 'win32'
				? [
						join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Claude', 'Claude.exe'),
						join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Claude', 'Claude.exe'),
					]
				: // Anthropic ships no Linux desktop build, so there is nothing to find
					// and nothing to pretend about.
					[];

	return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Opens a second Claude Desktop against a profile directory.
 *
 * On macOS this goes through `open -n`, which is what actually produces a
 * second instance with its own dock entry and normal activation behaviour;
 * spawning the executable directly works too but leaves an app the window
 * server treats as a stray. Elsewhere the executable is spawned detached, so
 * closing this app does not take the instance with it.
 */
export function openInstance(userDataDir, platform = process.platform, desktop = findDesktop(platform)) {
	if (!desktop) throw new Error('Claude Desktop is not installed on this machine');

	const [command, args] =
		platform === 'darwin'
			? ['open', ['-na', desktop, '--args', `--user-data-dir=${userDataDir}`]]
			: [desktop, [`--user-data-dir=${userDataDir}`]];

	const child = spawn(command, args, { detached: true, stdio: 'ignore' });
	child.unref();
	return { command, args };
}

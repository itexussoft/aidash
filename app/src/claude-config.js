/**
 * How Claude Code identifies a config directory.
 *
 * There is one asymmetry that is easy to get wrong and silent when you do: the
 * default directory is *not* the same as passing that same path in
 * `CLAUDE_CONFIG_DIR`.
 *
 * Claude Code derives its keychain entry from the environment variable, so with
 * the variable unset it reads `Claude Code-credentials`, and with the variable
 * set — even to `~/.claude` itself — it reads
 * `Claude Code-credentials-<first 8 hex of sha256(dir)>`, which for the default
 * directory does not exist. Setting the variable "for consistency" therefore
 * makes a signed-in account report itself as signed out.
 *
 * Everything that talks to a config directory goes through here so that
 * distinction lives in exactly one place.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG_DIR = join(homedir(), '.claude');

export const isDefaultConfigDir = (dir) => dir === DEFAULT_CONFIG_DIR;

/**
 * Environment additions for running `claude` against a directory.
 *
 * Deliberately empty for the default one — see above.
 */
export function claudeEnv(configDir) {
	return isDefaultConfigDir(configDir) ? {} : { CLAUDE_CONFIG_DIR: configDir };
}

/** The keychain service name Claude Code uses for a directory. */
export function keychainService(configDir) {
	if (isDefaultConfigDir(configDir)) return 'Claude Code-credentials';
	return `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
}

/**
 * backup.ts — Dev-only backup/restore utility for the test-evolve harness.
 *
 * Backs up the user's live `state.json`, `config.json`, and the installed
 * plugin's `hooks/hooks.json` to `.tokenmon/test-backup/<ISO-timestamp>/`.
 * Restores byte-perfect copies on completion or via `--restore`.
 *
 * `swapHooksJson()` supports BOTH baked-absolute paths (post-install form) AND
 * `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` template form for parity
 * with `src/setup/postinstall.ts:bakeHookPaths()`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { DATA_DIR, PLUGIN_ROOT, configPath, statePath } from '../core/paths.js';

export interface BackupManifest {
  timestamp: string;
  dir: string;
  generation: string;
  hooksSource: string;
  files: {
    state: string;
    config: string;
    hooks: string;
  };
}

/**
 * Resolve the user's active hooks.json path. Prefers `CLAUDE_PLUGIN_ROOT`
 * (via `core/paths.ts:PLUGIN_ROOT` which walks up to find `package.json`),
 * then checks the canonical plugin marketplace install location under
 * `~/.claude/plugins/marketplaces/tkm/`. Throws if none exist so the dev
 * harness fails loudly instead of writing to a non-existent path.
 */
export function getInstalledHooksPath(): string {
  const checked: string[] = [];

  const pluginRootHooks = join(PLUGIN_ROOT, 'hooks', 'hooks.json');
  checked.push(pluginRootHooks);
  if (existsSync(pluginRootHooks)) return pluginRootHooks;

  const marketplaceHooks = join(homedir(), '.claude', 'plugins', 'marketplaces', 'tkm', 'hooks', 'hooks.json');
  checked.push(marketplaceHooks);
  if (existsSync(marketplaceHooks)) return marketplaceHooks;

  // Cached install location: ~/.claude/plugins/cache/tkm/tkm/<version>/hooks/hooks.json
  // Scan every installed version directory so a release-style install still works.
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'tkm', 'tkm');
  checked.push(join(cacheBase, '<version>', 'hooks', 'hooks.json'));
  if (existsSync(cacheBase)) {
    try {
      const versions = readdirSync(cacheBase).sort().reverse();
      for (const v of versions) {
        const candidate = join(cacheBase, v, 'hooks', 'hooks.json');
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Directory read errors fall through to the throw below.
    }
  }

  throw new Error(
    `Cannot locate active hooks.json. Checked:\n${checked.map(p => `  - ${p}`).join('\n')}\n` +
    `Set CLAUDE_PLUGIN_ROOT to your tkm install location and retry.`,
  );
}

/** Byte-copy helper with ancestor mkdir. */
function byteCopy(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

/**
 * Create a timestamped backup of state, config, and hooks.json.
 * @param gen Active generation from `getActiveGeneration()` at call time.
 */
export function createBackup(gen: string): BackupManifest {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(DATA_DIR, 'test-backup', timestamp);
  mkdirSync(dir, { recursive: true });

  const statefile = statePath(gen);
  const configfile = configPath(gen);
  const hooksfile = getInstalledHooksPath();

  const backupState = join(dir, 'state.json');
  const backupConfig = join(dir, 'config.json');
  const backupHooks = join(dir, 'hooks.json');

  if (existsSync(statefile)) byteCopy(statefile, backupState);
  if (existsSync(configfile)) byteCopy(configfile, backupConfig);
  if (existsSync(hooksfile)) byteCopy(hooksfile, backupHooks);

  const manifest: BackupManifest = {
    timestamp,
    dir,
    generation: gen,
    hooksSource: hooksfile,
    files: { state: backupState, config: backupConfig, hooks: backupHooks },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  return manifest;
}

/**
 * Restore all 3 files from a backup directory. Byte-identical restore.
 */
export function restoreBackup(backupDir: string, gen: string): void {
  const manifestPath = join(backupDir, 'manifest.json');
  let hooksTarget = getInstalledHooksPath();
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;
      if (m.hooksSource) hooksTarget = m.hooksSource;
    } catch {
      /* fall through */
    }
  }

  const backupState = join(backupDir, 'state.json');
  const backupConfig = join(backupDir, 'config.json');
  const backupHooks = join(backupDir, 'hooks.json');

  if (existsSync(backupState)) {
    try {
      byteCopy(backupState, statePath(gen));
    } catch (err) {
      process.stderr.write(`test-evolve restore state: ${err}\n`);
    }
  }
  if (existsSync(backupConfig)) {
    try {
      byteCopy(backupConfig, configPath(gen));
    } catch (err) {
      process.stderr.write(`test-evolve restore config: ${err}\n`);
    }
  }
  if (existsSync(backupHooks)) {
    try {
      byteCopy(backupHooks, hooksTarget);
    } catch (err) {
      process.stderr.write(`test-evolve restore hooks: ${err}\n`);
    }
  }
}

/** Restore only hooks.json from a backup dir (independent restore for finally blocks). */
export function restoreHooksJson(backupDir: string): void {
  const manifestPath = join(backupDir, 'manifest.json');
  let hooksTarget = getInstalledHooksPath();
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;
      if (m.hooksSource) hooksTarget = m.hooksSource;
    } catch {
      /* fall through */
    }
  }
  const backupHooks = join(backupDir, 'hooks.json');
  if (existsSync(backupHooks)) {
    try {
      byteCopy(backupHooks, hooksTarget);
    } catch (err) {
      process.stderr.write(`test-evolve restoreHooksJson: ${err}\n`);
    }
  }
}

/** Find the most recent backup directory (lexicographic timestamp sort). */
export function getLatestBackup(): string | null {
  const base = join(DATA_DIR, 'test-backup');
  if (!existsSync(base)) return null;
  try {
    const entries = readdirSync(base)
      .map((name) => ({ name, full: join(base, name) }))
      .filter((e) => statSync(e.full).isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name));
    return entries[0]?.full ?? null;
  } catch {
    return null;
  }
}

/**
 * Rewrite hooks.json so all plugin paths point at the worktree.
 *
 * Detects both forms:
 *   - Template: `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` present
 *   - Baked: absolute path prefix (post-install form, where each hook
 *     command has the plugin's install directory inlined as a literal path)
 *
 * Writes the rewritten content to the same path. The ORIGINAL is preserved in
 * the backup dir via `createBackup()`, so callers MUST create a backup first.
 */
export function swapHooksJson(worktreePath: string): { mode: 'template' | 'baked' | 'noop'; hooksPath: string } {
  const hooksPath = getInstalledHooksPath();
  if (!existsSync(hooksPath)) {
    return { mode: 'noop', hooksPath };
  }
  const original = readFileSync(hooksPath, 'utf-8');

  // Template form first — preserve parity with postinstall.ts:bakeHookPaths()
  if (original.includes('${CLAUDE_PLUGIN_ROOT}') || original.includes('${CLAUDE_PLUGIN_DATA}')) {
    const rewritten = original
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, worktreePath)
      .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, worktreePath);
    writeFileSync(hooksPath, rewritten, 'utf-8');
    return { mode: 'template', hooksPath };
  }

  // Baked form: extract the common plugin-root prefix and replace.
  // Heuristic: find the first baked absolute path ending in `/bin/tsx-resolve.sh`.
  // Terminator is NOT required to be `"` because hook command strings store the
  // quote as the JSON escape `\"`, leaving `\` right after `.sh`. Accept anything.
  const m = original.match(/(\/(?:[^"\s$\\]|\\(?!["\s$]))+)\/bin\/tsx-resolve\.sh/);
  if (m?.[1]) {
    const bakedRoot = m[1];
    if (bakedRoot !== worktreePath) {
      // Escape regex metacharacters in bakedRoot
      const escaped = bakedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rewritten = original.replace(new RegExp(escaped, 'g'), worktreePath);
      writeFileSync(hooksPath, rewritten, 'utf-8');
      return { mode: 'baked', hooksPath };
    }
  }

  return { mode: 'noop', hooksPath };
}

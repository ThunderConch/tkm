/**
 * tmux-driver.ts — Thin TypeScript wrapper over the tmux CLI.
 *
 * Called from the single orchestrator process (no tsx boot per pane).
 * Each spawned pane runs the `claude` binary directly; this module only
 * shells out to tmux via `child_process.execFileSync` / `spawn`.
 */
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface SpawnPaneOpts {
  sessionName: string;
  windowName?: string;
  envVars: Record<string, string>;
  cwd: string;
  command: string; // shell command line to run in the pane (e.g. `claude -p "..."`)
}

export interface PaneHandle {
  sessionName: string;
  paneId: string; // tmux pane id like `%12`
  configDir: string; // `CLAUDE_CONFIG_DIR` passed to the pane
}

/**
 * Verify tmux is installed. Exits with clear error if not (AC17).
 */
export function checkTmux(): void {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
  } catch {
    process.stderr.write(
      'test-evolve: tmux CLI not found. Install with e.g. `sudo apt install tmux` or `brew install tmux`.\n',
    );
    process.exit(1);
  }
}

function tmuxCall(args: string[]): string {
  try {
    return execFileSync('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.('utf-8') ?? '';
    throw new Error(`tmux ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

function tmuxCallSafe(args: string[]): string | null {
  try {
    return tmuxCall(args);
  } catch {
    return null;
  }
}

/**
 * Create a fresh CLAUDE_CONFIG_DIR tempdir for the scenario.
 * Returns `<tempdir>/.claude` — caller seeds state under this path.
 */
export function makeScenarioConfigDir(scenarioName: string): string {
  const prefix = join(tmpdir(), `tkm-test-evolve-${scenarioName}-`);
  const base = mkdtempSync(prefix);
  const configDir = join(base, '.claude');
  mkdirSync(configDir, { recursive: true });
  return configDir;
}

/**
 * Spawn a new tmux session with a single pane. The pane inherits
 * `opts.envVars` (including `CLAUDE_CONFIG_DIR`). Returns the pane id.
 */
export function spawnPane(opts: SpawnPaneOpts): PaneHandle {
  // Kill any pre-existing session with the same name (idempotent)
  tmuxCallSafe(['kill-session', '-t', opts.sessionName]);

  // Build env arg list for `new-session`: `-e KEY=VAL` pairs
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(opts.envVars)) {
    envArgs.push('-e', `${k}=${v}`);
  }

  // Create a detached session running the command. If command is empty, spawn a shell.
  const args = [
    'new-session',
    '-d',
    '-s',
    opts.sessionName,
    ...(opts.windowName ? ['-n', opts.windowName] : []),
    '-c',
    opts.cwd,
    ...envArgs,
    opts.command,
  ];
  tmuxCall(args);

  // Resolve pane id — first pane of the session
  const paneId = tmuxCall(['list-panes', '-t', opts.sessionName, '-F', '#{pane_id}']).trim().split('\n')[0];
  if (!paneId) {
    throw new Error(`spawnPane: no pane id returned for session ${opts.sessionName}`);
  }

  return {
    sessionName: opts.sessionName,
    paneId,
    configDir: opts.envVars.CLAUDE_CONFIG_DIR ?? '',
  };
}

/**
 * Capture the pane's plaintext buffer (ANSI stripped by default via `-p`
 * without `-e`). Returns the most recent visible buffer.
 */
export function capturePane(paneId: string, opts?: { history?: boolean }): string {
  const args = ['capture-pane', '-p', '-t', paneId];
  if (opts?.history) {
    // `-S -` means start of history
    args.push('-S', '-');
  }
  return tmuxCallSafe(args) ?? '';
}

/**
 * Send keys to the pane. By default appends Enter. For AskUserQuestion
 * injection, pass a numeric index (1-4) or literal string for Other.
 */
export function sendKeys(paneId: string, keys: string, opts?: { enter?: boolean }): void {
  const sendEnter = opts?.enter !== false;
  tmuxCall(['send-keys', '-t', paneId, keys]);
  if (sendEnter) {
    tmuxCall(['send-keys', '-t', paneId, 'Enter']);
  }
}

/**
 * Kill a pane. Idempotent — does not throw if the pane is already dead.
 */
export function killPane(paneId: string): void {
  tmuxCallSafe(['kill-pane', '-t', paneId]);
}

/** Kill an entire session (all panes + window). Idempotent. */
export function killSession(sessionName: string): void {
  tmuxCallSafe(['kill-session', '-t', sessionName]);
}

/**
 * Poll `capturePane` at `intervalMs` until `regex` matches the captured
 * text or `timeoutMs` elapses. Returns the match or null on timeout.
 */
export async function waitForPattern(
  paneId: string,
  regex: RegExp,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<RegExpMatchArray | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = capturePane(paneId, { history: true });
    const match = text.match(regex);
    if (match) return match;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * Default AskUserQuestion UI detection regex. Matches numbered option prefixes
 * rendered by Claude Code's question UI (e.g. `  1. Vaporeon`, `2. …`).
 */
export const ASK_USER_QUESTION_UI_REGEX = /^\s*[1-4]\.\s/m;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Helper: detached spawn with stdio inherited (used for spawning non-tmux
 * helper processes). Exported for symmetry; not used in the orchestrator
 * directly but available for manual smoke checks.
 */
export function spawnDetached(command: string, args: string[], env: Record<string, string>): number {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  return child.pid ?? -1;
}

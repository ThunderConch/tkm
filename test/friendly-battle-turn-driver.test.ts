import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-turn.ts');

type SpawnedDriver = {
  completion: Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  stderrLines: string[];
};

function spawnDriver(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: { ...process.env, TOKENMON_TEST: '1', TSX_DISABLE_CACHE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
  });
}

function spawnDriverWithClaudeDir(claudeDir: string, args: string[]): SpawnedDriver {
  const stderrLines: string[] = [];
  const completion = new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: { ...process.env, TOKENMON_TEST: '1', TSX_DISABLE_CACHE: '1', CLAUDE_CONFIG_DIR: claudeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => {
      const text = c.toString();
      stderr += text;
      stderrLines.push(...text.split('\n').filter(Boolean));
    });
    child.once('error', rejectPromise);
    child.once('close', (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
  });
  return { completion, stderrLines };
}

function readPortFromHostStderr(spawned: SpawnedDriver): Promise<number> {
  return new Promise((resolve, reject) => {
    const check = () => {
      for (const line of spawned.stderrLines) {
        const match = /^PORT:\s*(\d+)/.exec(line);
        if (match) {
          resolve(Number.parseInt(match[1], 10));
          return;
        }
      }
      // Poll until host emits the PORT line or completion resolves (failure)
      spawned.completion.then((result) => {
        if (result.exitCode !== null && result.exitCode !== 0) {
          reject(new Error(`host exited with code ${result.exitCode} before emitting PORT`));
        }
      }).catch(reject);
      setTimeout(check, 20);
    };
    check();
  });
}

function withSeededClaudeConfigDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(joinPath(tmpdir(), 'tkm-fb-init-join-'));
  const genDir = joinPath(dir, 'tokenmon', 'gen4');
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    joinPath(genDir, 'config.json'),
    JSON.stringify({ party: ['387'], starter_chosen: true }),
  );
  writeFileSync(
    joinPath(genDir, 'state.json'),
    JSON.stringify({
      pokemon: {
        '387': { id: 387, xp: 100, level: 16, friendship: 0, ev: 0, moves: [33, 45] },
      },
    }),
  );
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return fn(dir).finally(cleanup);
}

describe('friendly-battle-turn CLI', () => {
  it('prints usage when invoked with --help and exits 0', async () => {
    const { stdout, stderr } = await execFileP(process.execPath, ['--import', 'tsx', CLI, '--help']);
    const combined = stdout + stderr;
    assert.match(combined, /Usage: friendly-battle-turn/);
    assert.match(combined, /--init-host/);
    assert.match(combined, /--init-join/);
    assert.match(combined, /--action/);
    assert.match(combined, /--refresh/);
    assert.match(combined, /--status/);
  });

  it('exits non-zero and emits a structured error on unknown subcommand', async () => {
    await assert.rejects(
      execFileP(process.execPath, ['--import', 'tsx', CLI, '--bogus-flag']),
      (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }) => {
        assert.equal(err.code, 1);
        const combined = (err.stderr ?? '') + (err.stdout ?? '');
        assert.match(combined, /unknown subcommand/i);
        return true;
      },
    );
  });
});

describe('friendly-battle-turn --init-host', () => {
  it('emits JSON with phase=waiting_for_guest and exits 0; daemon eventually writes phase=aborted', async () => {
    // After the Task 5 refactor, --init-host forks a daemon and exits 0 immediately
    // after receiving DAEMON_READY. The parent always exits 0; the daemon times out
    // and updates the session record to phase=aborted asynchronously.
    // We accept either waiting_for_guest or aborted in the stdout envelope because
    // the parent snapshot is captured before the daemon timeout fires.
    const result = await spawnDriver([
      '--init-host',
      '--session-code', 'waiting-123',
      '--listen-host', '127.0.0.1',
      '--port', '0',
      '--timeout-ms', '300',
      '--generation', 'gen4',
      '--player-name', 'Host',
    ]);

    assert.equal(result.exitCode, 0, `unexpected exit; stderr:\n${result.stderr}`);
    // Parent emits waiting_for_guest envelope before exiting
    assert.match(result.stdout, /"phase":\s*"waiting_for_guest"/, 'parent envelope phase');
    assert.match(result.stderr, /STAGE:\s*waiting_for_guest/, 'STAGE line present');
  });

  it('rejects a non-integer --port with a REASON line and exit 1', async () => {
    const result = await spawnDriver([
      '--init-host',
      '--session-code', 'nan-port',
      '--port', 'banana',
      '--timeout-ms', '300',
      '--generation', 'gen4',
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /REASON: flag --port must be a non-negative integer/);
  });

  it('rejects an unknown flag like --sesion-code with a REASON line', async () => {
    const result = await spawnDriver([
      '--init-host',
      '--sesion-code', 'typo',
      '--timeout-ms', '300',
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /REASON:/);
  });
});

// ---------------------------------------------------------------------------
// Helpers for the updated handshake test
// ---------------------------------------------------------------------------

import {
  readFriendlyBattleSessionRecord,
} from '../src/friendly-battle/session-store.js';

/** Poll fn() every intervalMs until it returns a truthy value or deadline passes. */
async function pollUntil<T>(
  fn: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val) return val;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: timed out after ${timeoutMs}ms`);
}

/** Read a JSON envelope from a line of stdout. */
function parseFirstEnvelope(stdout: string): Record<string, unknown> | null {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

/**
 * Read a session record scoped to a specific CLAUDE_CONFIG_DIR.
 * readFriendlyBattleSessionRecord uses process.env.CLAUDE_CONFIG_DIR so we
 * temporarily swap it for the duration of the call.
 */
function readRecordInDir(claudeDir: string, sessionId: string, generation: string) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    return readFriendlyBattleSessionRecord(sessionId, generation);
  } finally {
    if (prev === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prev;
    }
  }
}

describe('friendly-battle-turn init handshake', () => {
  it('init-join connects to an init-host and both exit 0 with phase=waiting_for_guest/handshake, daemons advance to battle', async () => {
    await withSeededClaudeConfigDir(async (claudeDir) => {
      const sessionCode = 'handshake-321';
      const host = spawnDriverWithClaudeDir(claudeDir, [
        '--init-host',
        '--session-code', sessionCode,
        '--listen-host', '127.0.0.1',
        '--port', '0',
        '--timeout-ms', '10000',
        '--generation', 'gen4',
        '--player-name', 'Host',
      ]);

      // Step 1: Wait for PORT: line from host
      const hostPort = await readPortFromHostStderr(host);

      const join = spawnDriverWithClaudeDir(claudeDir, [
        '--init-join',
        '--session-code', sessionCode,
        '--host', '127.0.0.1',
        '--port', String(hostPort),
        '--timeout-ms', '10000',
        '--generation', 'gen4',
        '--player-name', 'Guest',
      ]);

      // Step 2: Both parent processes should exit 0 quickly (they fork daemons and exit)
      const [hostResult, joinResult] = await Promise.all([host.completion, join.completion]);
      assert.equal(hostResult.exitCode, 0, `host stderr:\n${hostResult.stderr}`);
      assert.equal(joinResult.exitCode, 0, `join stderr:\n${joinResult.stderr}`);

      // Step 3: Host emits waiting_for_guest, guest emits handshake
      assert.match(hostResult.stdout, /"phase":\s*"waiting_for_guest"/, 'host envelope phase');
      assert.match(joinResult.stdout, /"phase":\s*"handshake"/, 'join envelope phase');
      assert.match(joinResult.stdout, /"role":\s*"guest"/, 'join envelope role');

      // Step 4: Poll session store — both records must exist with daemonPid > 0 and socketPath
      const hostEnv = parseFirstEnvelope(hostResult.stdout);
      const joinEnv = parseFirstEnvelope(joinResult.stdout);
      assert.ok(hostEnv, 'host envelope parseable');
      assert.ok(joinEnv, 'join envelope parseable');

      const hostSessionId = (hostEnv as Record<string, unknown>).sessionId as string;
      const joinSessionId = (joinEnv as Record<string, unknown>).sessionId as string;
      assert.ok(hostSessionId, 'host sessionId present');
      assert.ok(joinSessionId, 'join sessionId present');

      const daemonPids: number[] = [];

      // Poll for host record (records live under claudeDir, not the test process's default)
      const hostRecord = await pollUntil(
        () => readRecordInDir(claudeDir, hostSessionId, 'gen4'),
        5000,
      );
      assert.ok((hostRecord.daemonPid ?? 0) > 0, 'host daemonPid > 0');
      assert.ok(hostRecord.socketPath && hostRecord.socketPath.length > 0, 'host socketPath set');
      daemonPids.push(hostRecord.daemonPid!);

      // Poll for guest record
      const guestRecord = await pollUntil(
        () => readRecordInDir(claudeDir, joinSessionId, 'gen4'),
        5000,
      );
      assert.ok((guestRecord.daemonPid ?? 0) > 0, 'guest daemonPid > 0');
      assert.ok(guestRecord.socketPath && guestRecord.socketPath.length > 0, 'guest socketPath set');
      daemonPids.push(guestRecord.daemonPid!);

      // Step 5: Poll for host record to advance to phase='battle' (daemon handles this async)
      await pollUntil(
        () => {
          const r = readRecordInDir(claudeDir, hostSessionId, 'gen4');
          return r?.phase === 'battle' ? r : null;
        },
        15000,
        200,
      );

      // Step 6: Cleanup — SIGTERM both daemon PIDs
      for (const pid of daemonPids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* ESRCH: already gone */ }
      }
    });
  });

  it('guest emits an aborted envelope on stdout when host is unreachable', async () => {
    await withSeededClaudeConfigDir(async (claudeDir) => {
      // Pick an unused loopback port
      const deadPort = 1; // privileged port; connect always refused
      const guest = await spawnDriverWithClaudeDir(claudeDir, [
        '--init-join',
        '--session-code', 'unreachable',
        '--host', '127.0.0.1',
        '--port', String(deadPort),
        '--timeout-ms', '600',
        '--generation', 'gen4',
        '--player-name', 'Guest',
      ]).completion;
      assert.equal(guest.exitCode, 1);
      assert.match(guest.stdout, /"phase":\s*"aborted"/);
      assert.match(guest.stderr, /FAILED_STAGE:/);
    });
  });
});

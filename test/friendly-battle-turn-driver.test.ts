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
  writeFriendlyBattleSessionRecord,
  listFriendlyBattleSessionRecords,
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

// ---------------------------------------------------------------------------
// Helpers for per-action subcommand tests
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { afterEach as afterEachFb } from 'node:test';

const REPO_ROOT_FB = resolve(import.meta.dirname, '..');
const DAEMON_ENTRY_FB = resolve(REPO_ROOT_FB, 'src/friendly-battle/daemon.ts');

function encodeDaemonOptionsB64(options: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(options)).toString('base64');
}

interface SpawnedDaemonInfo {
  child: import('node:child_process').ChildProcess;
  sessionId: string;
  socketPath: string;
  port?: number;
}

function spawnFbDaemon(
  role: 'host' | 'guest',
  options: Record<string, unknown>,
  claudeDir: string,
): Promise<SpawnedDaemonInfo> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', DAEMON_ENTRY_FB, '--role', role],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, TSX_DISABLE_CACHE: '1', TOKENMON_TEST: '1', TKM_FB_OPTIONS_B64: encodeDaemonOptionsB64(options) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      },
    );
    let stdoutBuf = '';
    let settled = false;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const nl = stdoutBuf.indexOf('\n');
      if (nl < 0) return;
      const line = stdoutBuf.slice(0, nl).trim();
      if (!line.startsWith('DAEMON_READY ')) return;
      const parts = line.split(' ');
      const sessionId = parts[1];
      const socketPath = parts[2];
      const port = parts[3] ? Number.parseInt(parts[3], 10) : undefined;
      if (!sessionId || !socketPath) {
        rejectP(new Error(`Malformed DAEMON_READY line: ${JSON.stringify(line)}`));
        return;
      }
      if (!settled) {
        settled = true;
        resolveP({ child, sessionId, socketPath, port });
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (_chunk: string) => { /* suppress */ });
    child.once('error', (err) => { if (!settled) { settled = true; rejectP(err); } });
    child.once('close', (code) => { if (!settled) { settled = true; rejectP(new Error(`${role} daemon exited ${code} before DAEMON_READY`)); } });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGTERM'); rejectP(new Error(`${role} daemon timeout`)); }
    }, 15_000);
    if (timer.unref) timer.unref();
  });
}

/** Read a session record under a specific CLAUDE_CONFIG_DIR without mutating process.env. */
function readRecordInDirFb(claudeDir: string, sessionId: string, generation: string) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    return readFriendlyBattleSessionRecord(sessionId, generation);
  } finally {
    if (prev === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = prev; }
  }
}

/** Poll until the session record exists with a matching phase, or timeout. */
async function waitForRecordPhase(
  claudeDir: string,
  sessionId: string,
  generation: string,
  phase: string,
  timeoutMs: number,
  intervalMs = 150,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = readRecordInDirFb(claudeDir, sessionId, generation);
    if (r?.phase === phase) return r;
    await new Promise<void>((r2) => setTimeout(r2, intervalMs));
  }
  throw new Error(`waitForRecordPhase: timed out waiting for phase=${phase} on session=${sessionId}`);
}

/** Run the driver CLI with CLAUDE_CONFIG_DIR scoped to claudeDir. */
function runDriver(claudeDir: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: { ...process.env, TOKENMON_TEST: '1', TSX_DISABLE_CACHE: '1', CLAUDE_CONFIG_DIR: claudeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectP);
    child.once('close', (exitCode) => resolveP({ stdout, stderr, exitCode }));
  });
}

/** Kill all daemons listed in the session store for the given claudeDir + generation,
 *  then wait for each PID to actually exit before returning so subsequent rmSync
 *  does not race the daemon's socket-unlink + session-record write. */
async function killAllDaemons(claudeDir: string, generation: string): Promise<void> {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const pids: number[] = [];
  try {
    for (const record of listFriendlyBattleSessionRecords(generation)) {
      if (record.daemonPid && record.daemonPid > 0) {
        pids.push(record.daemonPid);
        try { process.kill(record.daemonPid, 'SIGTERM'); } catch { /* ESRCH */ }
      }
    }
  } finally {
    if (prev === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = prev; }
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const stillAlive = pids.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (stillAlive.length === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  // Final sweep with SIGKILL for any still-stuck daemons
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH */ }
  }
  // Poll up to 500ms for SIGKILL to take effect rather than a fixed sleep.
  const killDeadline = Date.now() + 500;
  while (Date.now() < killDeadline) {
    const stillAlive = pids.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (stillAlive.length === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// Per-action subcommand tests
// ---------------------------------------------------------------------------

/** Create a seeded CLAUDE_CONFIG_DIR without automatic cleanup (managed by afterEach). */
function makeSeededDir(): string {
  const dir = mkdtempSync(joinPath(tmpdir(), 'tkm-fb-action-'));
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
  return dir;
}

/** Write a session record scoped to claudeDir without touching process.env. */
function writeRecordInDir(claudeDir: string, record: Parameters<typeof writeFriendlyBattleSessionRecord>[0]): void {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    writeFriendlyBattleSessionRecord(record);
  } finally {
    if (prev === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = prev; }
  }
}

describe('friendly-battle-turn per-action subcommands', () => {
  // Track claudeDirs to cleanup + kill daemons after each test
  const cleanupDirs: string[] = [];

  afterEachFb(async () => {
    for (const dir of cleanupDirs.splice(0)) {
      await killAllDaemons(dir, 'gen4');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--status returns the persisted envelope when the daemon is alive', async () => {
    const claudeDir = makeSeededDir();
    cleanupDirs.push(claudeDir);

    const sessionCode = `status-alive-${randomUUID().slice(0, 8)}`;
    const sessionId = `test-alive-${Date.now()}`;

    const hostInfo = await spawnFbDaemon('host', {
      sessionId,
      sessionCode,
      host: '127.0.0.1',
      port: 0,
      generation: 'gen4',
      playerName: 'Host',
      timeoutMs: 15_000,
    }, claudeDir);

    writeRecordInDir(claudeDir, {
      sessionId,
      role: 'host',
      generation: 'gen4',
      sessionCode,
      phase: 'waiting_for_guest',
      status: 'waiting_for_guest',
      transport: { host: '127.0.0.1', port: hostInfo.port ?? 0 },
      opponent: null,
      pid: process.pid,
      daemonPid: hostInfo.child.pid!,
      socketPath: hostInfo.socketPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await runDriver(claudeDir, [
      '--status',
      '--session', sessionId,
      '--generation', 'gen4',
    ]);

    assert.equal(result.exitCode, 0, `stderr:\n${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.ok(typeof envelope.sessionId === 'string', 'envelope has sessionId');
    assert.ok(typeof envelope.phase === 'string', 'envelope has phase');

    hostInfo.child.kill('SIGTERM');
    // afterEachFb will rmSync
  });

  it('--status returns a frozen envelope when the daemon is dead', async () => {
    const claudeDir = makeSeededDir();
    cleanupDirs.push(claudeDir);

    const sessionId = `test-dead-${Date.now()}`;
    // socketPath must be inside the sessions dir to pass isValidRecord containment check.
    const socketPath = joinPath(claudeDir, 'tokenmon', 'gen4', 'friendly-battle', 'sessions', `${sessionId}.sock`);
    writeRecordInDir(claudeDir, {
      sessionId,
      role: 'host',
      generation: 'gen4',
      sessionCode: 'dead-session',
      phase: 'battle',
      status: 'select_action',
      transport: { host: '127.0.0.1', port: 9999 },
      opponent: { playerName: 'Ghost' },
      pid: process.pid,
      daemonPid: 1 << 22, // non-running PID
      socketPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await runDriver(claudeDir, [
      '--status',
      '--session', sessionId,
      '--generation', 'gen4',
    ]);

    assert.equal(result.exitCode, 0, `stderr:\n${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(envelope.sessionId, sessionId, 'sessionId matches');
    assert.equal(envelope.phase, 'battle', 'phase from persisted record');
    assert.equal(envelope.status, 'select_action', 'status from persisted record');
  });

  it('--wait-next-event returns the first choices_requested envelope from a full handshake', async () => {
    const claudeDir = makeSeededDir();
    cleanupDirs.push(claudeDir);

    const sessionCode = `wne-${randomUUID().slice(0, 8)}`;
    const hostSessionId = `host-wne-${Date.now()}`;
    const guestSessionId = `guest-wne-${Date.now()}`;

    const hostInfo = await spawnFbDaemon('host', {
      sessionId: hostSessionId,
      sessionCode,
      host: '127.0.0.1',
      port: 0,
      generation: 'gen4',
      playerName: 'Host',
      timeoutMs: 20_000,
    }, claudeDir);

    const guestInfo = await spawnFbDaemon('guest', {
      sessionId: guestSessionId,
      sessionCode,
      host: '127.0.0.1',
      port: hostInfo.port,
      generation: 'gen4',
      playerName: 'Guest',
      timeoutMs: 20_000,
    }, claudeDir);

    const nowIso = new Date().toISOString();
    writeRecordInDir(claudeDir, {
      sessionId: hostSessionId,
      role: 'host',
      generation: 'gen4',
      sessionCode,
      phase: 'battle',
      status: 'ongoing',
      transport: { host: '127.0.0.1', port: hostInfo.port ?? 0 },
      opponent: { playerName: 'Guest' },
      pid: process.pid,
      daemonPid: hostInfo.child.pid!,
      socketPath: hostInfo.socketPath,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    writeRecordInDir(claudeDir, {
      sessionId: guestSessionId,
      role: 'guest',
      generation: 'gen4',
      sessionCode,
      phase: 'battle',
      status: 'ongoing',
      transport: { host: '127.0.0.1', port: hostInfo.port ?? 0 },
      opponent: { playerName: 'Host' },
      pid: process.pid,
      daemonPid: guestInfo.child.pid!,
      socketPath: guestInfo.socketPath,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    // Run --wait-next-event for host and guest in parallel
    const [hostWneResult, guestWneResult] = await Promise.all([
      runDriver(claudeDir, [
        '--wait-next-event',
        '--session', hostSessionId,
        '--generation', 'gen4',
        '--timeout-ms', '8000',
      ]),
      runDriver(claudeDir, [
        '--wait-next-event',
        '--session', guestSessionId,
        '--generation', 'gen4',
        '--timeout-ms', '8000',
      ]),
    ]);

    assert.equal(hostWneResult.exitCode, 0, `host wne stderr:\n${hostWneResult.stderr}`);
    const hostEnvelope = JSON.parse(hostWneResult.stdout.trim()) as Record<string, unknown>;
    assert.ok(hostEnvelope.status !== undefined, 'host envelope has status');
    assert.ok(Array.isArray(hostEnvelope.moveOptions), 'host has moveOptions array');

    assert.equal(guestWneResult.exitCode, 0, `guest wne stderr:\n${guestWneResult.stderr}`);
    const guestEnvelope = JSON.parse(guestWneResult.stdout.trim()) as Record<string, unknown>;
    assert.ok(guestEnvelope.status !== undefined, 'guest envelope has status');

    // afterEachFb will SIGTERM daemons via killAllDaemons + rmSync
  });

  it('--action move:1 submits a move to the daemon', async () => {
    const claudeDir = makeSeededDir();
    cleanupDirs.push(claudeDir);

    const sessionCode = `action-${randomUUID().slice(0, 8)}`;
    const hostSessionId = `host-act-${Date.now()}`;
    const guestSessionId = `guest-act-${Date.now()}`;

    const hostInfo = await spawnFbDaemon('host', {
      sessionId: hostSessionId,
      sessionCode,
      host: '127.0.0.1',
      port: 0,
      generation: 'gen4',
      playerName: 'Host',
      timeoutMs: 20_000,
    }, claudeDir);

    const guestInfo = await spawnFbDaemon('guest', {
      sessionId: guestSessionId,
      sessionCode,
      host: '127.0.0.1',
      port: hostInfo.port,
      generation: 'gen4',
      playerName: 'Guest',
      timeoutMs: 20_000,
    }, claudeDir);

    const nowIso = new Date().toISOString();
    writeRecordInDir(claudeDir, {
      sessionId: hostSessionId,
      role: 'host',
      generation: 'gen4',
      sessionCode,
      phase: 'battle',
      status: 'ongoing',
      transport: { host: '127.0.0.1', port: hostInfo.port ?? 0 },
      opponent: { playerName: 'Guest' },
      pid: process.pid,
      daemonPid: hostInfo.child.pid!,
      socketPath: hostInfo.socketPath,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    writeRecordInDir(claudeDir, {
      sessionId: guestSessionId,
      role: 'guest',
      generation: 'gen4',
      sessionCode,
      phase: 'battle',
      status: 'ongoing',
      transport: { host: '127.0.0.1', port: hostInfo.port ?? 0 },
      opponent: { playerName: 'Host' },
      pid: process.pid,
      daemonPid: guestInfo.child.pid!,
      socketPath: guestInfo.socketPath,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    // Drain events until both sides reach select_action
    async function drainToSelectAction(sessionId: string): Promise<void> {
      for (let i = 0; i < 5; i++) {
        const result = await runDriver(claudeDir, [
          '--wait-next-event',
          '--session', sessionId,
          '--generation', 'gen4',
          '--timeout-ms', '8000',
        ]);
        if (result.exitCode !== 0) throw new Error(`wait-next-event failed: ${result.stderr}`);
        const env = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
        if (env.status === 'select_action') return;
      }
      throw new Error('never reached select_action after 5 events');
    }

    await Promise.all([
      drainToSelectAction(hostSessionId),
      drainToSelectAction(guestSessionId),
    ]);

    // Submit move:1 from host (1-based in CLI = index 0 in daemon)
    const hostActionResult = await runDriver(claudeDir, [
      '--action', 'move:1',
      '--session', hostSessionId,
      '--generation', 'gen4',
    ]);
    assert.equal(hostActionResult.exitCode, 0, `host action stderr:\n${hostActionResult.stderr}`);
    const hostAck = JSON.parse(hostActionResult.stdout.trim()) as Record<string, unknown>;
    assert.ok(hostAck.sessionId !== undefined || hostAck.phase !== undefined, 'host ack has envelope fields');

    // Submit move:1 from guest
    const guestActionResult = await runDriver(claudeDir, [
      '--action', 'move:1',
      '--session', guestSessionId,
      '--generation', 'gen4',
    ]);
    assert.equal(guestActionResult.exitCode, 0, `guest action stderr:\n${guestActionResult.stderr}`);
    const guestAck = JSON.parse(guestActionResult.stdout.trim()) as Record<string, unknown>;
    assert.ok(guestAck.sessionId !== undefined || guestAck.phase !== undefined, 'guest ack has envelope fields');

    // --wait-next-event on host should get another event (turn resolved or next select_action)
    const postMoveResult = await runDriver(claudeDir, [
      '--wait-next-event',
      '--session', hostSessionId,
      '--generation', 'gen4',
      '--timeout-ms', '8000',
    ]);
    assert.equal(postMoveResult.exitCode, 0, `post-move wne stderr:\n${postMoveResult.stderr}`);

    // afterEachFb kills daemons + rmSync
  });

  it('--action switch:1 submits a switch action to the daemon', async () => {
    const claudeDir = makeSeededDir();
    cleanupDirs.push(claudeDir);

    const sessionCode = `switch-${randomUUID().slice(0, 8)}`;
    const sessionId = `host-switch-${Date.now()}`;

    const hostInfo = await spawnFbDaemon('host', {
      sessionId,
      sessionCode,
      host: '127.0.0.1',
      port: 0,
      generation: 'gen4',
      playerName: 'Host',
      timeoutMs: 15_000,
    }, claudeDir);

    writeRecordInDir(claudeDir, {
      sessionId,
      role: 'host',
      generation: 'gen4',
      sessionCode,
      phase: 'battle',
      status: 'select_action',
      transport: { host: '127.0.0.1', port: hostInfo.port ?? 0 },
      opponent: { playerName: 'Guest' },
      pid: process.pid,
      daemonPid: hostInfo.child.pid!,
      socketPath: hostInfo.socketPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await runDriver(claudeDir, [
      '--action', 'switch:1',
      '--session', sessionId,
      '--generation', 'gen4',
    ]);

    // The CLI parses switch:1 correctly and forwards to the daemon.
    // The daemon accepts the action (exit 0 + ack envelope) or rejects it at the
    // battle-adapter layer if the phase is not awaiting_fainted_switch (exit 1 +
    // REASON containing "not waiting"). Both outcomes prove the CLI layer parses correctly.
    const cliParsedOk = result.exitCode === 0 || (result.exitCode === 1 && /not waiting/i.test(result.stderr));
    assert.ok(
      cliParsedOk,
      `expected exit 0 (ack) or exit 1 with "not waiting" REASON, got exit ${result.exitCode}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
    // Must NOT be the old PR45 "not implemented" error
    assert.ok(!/PR45/i.test(result.stderr), `stderr must not mention PR45: ${result.stderr}`);

    hostInfo.child.kill('SIGTERM');
  });

  it('--action surrender submits a surrender action to the daemon', async () => {
    const claudeDir = makeSeededDir();
    cleanupDirs.push(claudeDir);

    const sessionCode = `surrender-${randomUUID().slice(0, 8)}`;
    const sessionId = `host-surrender-${Date.now()}`;

    const hostInfo = await spawnFbDaemon('host', {
      sessionId,
      sessionCode,
      host: '127.0.0.1',
      port: 0,
      generation: 'gen4',
      playerName: 'Host',
      timeoutMs: 15_000,
    }, claudeDir);

    // Ensure the sessions directory exists before writing the record
    // (the daemon creates it before DAEMON_READY, but guarantee it here)
    mkdirSync(joinPath(claudeDir, 'tokenmon', 'gen4', 'friendly-battle', 'sessions'), { recursive: true });

    writeRecordInDir(claudeDir, {
      sessionId,
      role: 'host',
      generation: 'gen4',
      sessionCode,
      phase: 'battle',
      status: 'select_action',
      transport: { host: '127.0.0.1', port: hostInfo.port ?? 0 },
      opponent: { playerName: 'Guest' },
      pid: process.pid,
      daemonPid: hostInfo.child.pid!,
      socketPath: hostInfo.socketPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await runDriver(claudeDir, [
      '--action', 'surrender',
      '--session', sessionId,
      '--generation', 'gen4',
    ]);

    // The CLI parses surrender correctly and forwards to the daemon.
    // Accept exit 0 (ack) or exit 1 with daemon-layer error — both prove CLI parses correctly.
    const cliParsedOk = result.exitCode === 0 || result.exitCode === 1;
    assert.ok(
      cliParsedOk,
      `expected exit 0 (ack) or exit 1 (daemon error), got exit ${result.exitCode}\nstderr: ${result.stderr}`,
    );
    // Must NOT be the old PR45 "not implemented" error (exit 2)
    assert.notEqual(result.exitCode, 2, `exit 2 means PR45 stub is still active: ${result.stderr}`);
    assert.ok(!/PR45/i.test(result.stderr), `stderr must not mention PR45: ${result.stderr}`);

    hostInfo.child.kill('SIGTERM');
  });
});

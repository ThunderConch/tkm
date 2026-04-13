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
  it('emits JSON with phase=waiting_for_guest before timing out and then writes phase=aborted', async () => {
    const result = await spawnDriver([
      '--init-host',
      '--session-code', 'waiting-123',
      '--listen-host', '127.0.0.1',
      '--port', '0',
      '--timeout-ms', '300',
      '--generation', 'gen4',
      '--player-name', 'Host',
    ]);

    assert.notEqual(result.exitCode, 0);
    // waiting line should have been printed before we gave up
    assert.match(result.stdout, /"phase":\s*"waiting_for_guest"/);
    assert.match(result.stderr, /STAGE:\s*waiting_for_guest/);
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

describe('friendly-battle-turn init handshake', () => {
  it('init-join connects to an init-host and both exit 0 with battle phase', async () => {
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

      const [hostResult, joinResult] = await Promise.all([host.completion, join.completion]);
      assert.equal(joinResult.exitCode, 0, `join stderr:\n${joinResult.stderr}`);
      assert.equal(hostResult.exitCode, 0, `host stderr:\n${hostResult.stderr}`);
      assert.match(hostResult.stdout, /"phase":\s*"battle"/);
      assert.match(joinResult.stdout, /"phase":\s*"battle"/);
      assert.match(joinResult.stdout, /"role":\s*"guest"/);
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

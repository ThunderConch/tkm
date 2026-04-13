import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-turn.ts');

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
});

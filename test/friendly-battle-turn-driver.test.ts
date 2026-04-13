import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(REPO_ROOT, 'src/cli/friendly-battle-turn.ts');

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

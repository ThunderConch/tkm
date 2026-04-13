import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  friendlyBattleSessionRecordPath,
  friendlyBattleSessionsDir,
  readFriendlyBattleSessionRecord,
  writeFriendlyBattleSessionRecord,
  listFriendlyBattleSessionRecords,
  reapStaleFriendlyBattleSessions,
  type FriendlyBattleSessionRecord,
} from '../src/friendly-battle/session-store.js';

function withTempClaudeDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tkm-fb-session-'));
  const prevEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compute the canonical socket path for a session (must be called inside withTempClaudeDir). */
function makeSocketPath(sessionId: string, generation = 'gen4'): string {
  return join(friendlyBattleSessionsDir(generation), `${sessionId}.sock`);
}

function makeRecord(overrides: Partial<FriendlyBattleSessionRecord> = {}): FriendlyBattleSessionRecord {
  const sessionId = overrides.sessionId ?? 'fb-session-001';
  const generation = overrides.generation ?? 'gen4';
  return {
    sessionId,
    role: 'host',
    generation,
    sessionCode: 'alpha-123',
    phase: 'waiting_for_guest',
    status: 'waiting_for_guest',
    transport: { host: '127.0.0.1', port: 52345 },
    opponent: null,
    pid: process.pid,
    daemonPid: process.pid,
    socketPath: makeSocketPath(sessionId, generation),
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('friendly-battle session store', () => {
  it('resolves a per-generation session record path under CLAUDE_CONFIG_DIR', () => {
    withTempClaudeDir((dir) => {
      const path = friendlyBattleSessionRecordPath('fb-session-001', 'gen4');
      assert.equal(
        path,
        join(dir, 'tokenmon', 'gen4', 'friendly-battle', 'sessions', 'fb-session-001.json'),
      );
    });
  });

  it('round-trips a session record through disk', () => {
    withTempClaudeDir(() => {
      const record = makeRecord();
      writeFriendlyBattleSessionRecord(record);
      const loaded = readFriendlyBattleSessionRecord('fb-session-001', 'gen4');
      assert.deepEqual(loaded, record);
    });
  });

  it('returns null for a missing session', () => {
    withTempClaudeDir(() => {
      const loaded = readFriendlyBattleSessionRecord('does-not-exist', 'gen4');
      assert.equal(loaded, null);
    });
  });

  it('reaps records whose daemonPids are no longer running', () => {
    withTempClaudeDir(() => {
      const liveRecord = makeRecord({ sessionId: 'alive', pid: process.pid, daemonPid: process.pid });
      const deadRecord = makeRecord({ sessionId: 'dead', pid: process.pid, daemonPid: 1 << 22 });
      writeFriendlyBattleSessionRecord(liveRecord);
      writeFriendlyBattleSessionRecord(deadRecord);

      const reaped = reapStaleFriendlyBattleSessions('gen4');

      assert.deepEqual(reaped, ['dead']);
      const remaining = listFriendlyBattleSessionRecords('gen4').map((r) => r.sessionId);
      assert.deepEqual(remaining.sort(), ['alive']);
    });
  });

  it('rejects sessionId values that would escape the sessions directory', () => {
    withTempClaudeDir(() => {
      assert.throws(
        () => friendlyBattleSessionRecordPath('../etc/passwd', 'gen4'),
        /invalid sessionId/,
      );
      assert.throws(
        () => writeFriendlyBattleSessionRecord(makeRecord({ sessionId: '../oops' })),
        /invalid sessionId/,
      );
    });
  });

  it('rejects generation values that would escape the per-gen directory', () => {
    withTempClaudeDir(() => {
      assert.throws(
        () => friendlyBattleSessionRecordPath('fb-ok', '../../etc'),
        /invalid generation/,
      );
    });
  });

  it('returns null when an on-disk record fails shape validation', () => {
    withTempClaudeDir(() => {
      const valid = makeRecord({ sessionId: 'corrupt' });
      writeFriendlyBattleSessionRecord(valid);
      const path = friendlyBattleSessionRecordPath('corrupt', 'gen4');
      // Corrupt the file — overwrite with an object missing required keys.
      writeFileSync(path, JSON.stringify({ sessionId: 'corrupt', role: 'observer' }), 'utf8');
      const loaded = readFriendlyBattleSessionRecord('corrupt', 'gen4');
      assert.equal(loaded, null);
    });
  });

  it('returns null when daemonPid is missing from an on-disk record', () => {
    withTempClaudeDir(() => {
      const valid = makeRecord({ sessionId: 'no-daemon-pid' });
      writeFriendlyBattleSessionRecord(valid);
      const path = friendlyBattleSessionRecordPath('no-daemon-pid', 'gen4');
      // Write a record with daemonPid removed (simulates a PR43 on-disk record).
      const withoutDaemonPid = { ...valid, daemonPid: undefined as unknown as number };
      writeFileSync(path, JSON.stringify(withoutDaemonPid), 'utf8');
      const loaded = readFriendlyBattleSessionRecord('no-daemon-pid', 'gen4');
      assert.equal(loaded, null);
    });
  });

  it('reap uses daemonPid: does not reap when daemonPid is alive even if parent pid is dead', () => {
    withTempClaudeDir(() => {
      // pid = dead CLI parent (1 << 22), daemonPid = live process — should NOT be reaped
      const liveRecord = makeRecord({ sessionId: 'live-daemon', pid: 1 << 22, daemonPid: process.pid });
      writeFriendlyBattleSessionRecord(liveRecord);

      const reaped = reapStaleFriendlyBattleSessions('gen4');
      assert.deepEqual(reaped, [], 'live daemonPid should not be reaped');

      const remaining = listFriendlyBattleSessionRecords('gen4').map((r) => r.sessionId);
      assert.deepEqual(remaining, ['live-daemon'], 'record should still exist');

      // Now write a second record with a dead daemonPid — it SHOULD be reaped
      const deadRecord = makeRecord({ sessionId: 'dead-daemon', pid: process.pid, daemonPid: 1 << 22 });
      writeFriendlyBattleSessionRecord(deadRecord);

      const reaped2 = reapStaleFriendlyBattleSessions('gen4');
      assert.deepEqual(reaped2, ['dead-daemon'], 'dead daemonPid should be reaped');
      const remaining2 = listFriendlyBattleSessionRecords('gen4').map((r) => r.sessionId);
      assert.deepEqual(remaining2, ['live-daemon'], 'only the dead-daemon record should be removed');
    });
  });

  it('returns null when socketPath is outside the sessions directory (path traversal)', () => {
    withTempClaudeDir(() => {
      const valid = makeRecord({ sessionId: 'tampered' });
      writeFriendlyBattleSessionRecord(valid);
      const path = friendlyBattleSessionRecordPath('tampered', 'gen4');
      // Overwrite with a tampered socketPath pointing outside the sessions dir
      const tampered = { ...valid, socketPath: '/tmp/evil.sock' };
      writeFileSync(path, JSON.stringify(tampered), 'utf8');
      const loaded = readFriendlyBattleSessionRecord('tampered', 'gen4');
      assert.equal(loaded, null, 'tampered socketPath should be rejected');
    });
  });
});

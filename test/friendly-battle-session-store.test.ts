import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  friendlyBattleSessionRecordPath,
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

function makeRecord(overrides: Partial<FriendlyBattleSessionRecord> = {}): FriendlyBattleSessionRecord {
  return {
    sessionId: 'fb-session-001',
    role: 'host',
    generation: 'gen4',
    sessionCode: 'alpha-123',
    phase: 'waiting_for_guest',
    status: 'waiting_for_guest',
    transport: { host: '127.0.0.1', port: 52345 },
    opponent: null,
    pid: process.pid,
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

  it('reaps records whose pids are no longer running', () => {
    withTempClaudeDir(() => {
      const liveRecord = makeRecord({ sessionId: 'alive', pid: process.pid });
      const deadRecord = makeRecord({ sessionId: 'dead', pid: 1 << 22 });
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
});

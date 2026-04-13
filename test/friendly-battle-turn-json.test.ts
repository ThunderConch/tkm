import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFriendlyBattleTurnJson,
} from '../src/friendly-battle/turn-json.js';
import type { FriendlyBattleSessionRecord } from '../src/friendly-battle/session-store.js';

function makeRecord(overrides: Partial<FriendlyBattleSessionRecord> = {}): FriendlyBattleSessionRecord {
  return {
    sessionId: 'fb-001',
    role: 'host',
    generation: 'gen4',
    sessionCode: 'alpha-123',
    phase: 'battle',
    status: 'select_action',
    transport: { host: '127.0.0.1', port: 52345 },
    opponent: { playerName: 'Guest' },
    pid: 12345,
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('friendly-battle turn-json formatter', () => {
  it('emits the gym-compatible envelope with sessionId/phase/status', () => {
    const json = formatFriendlyBattleTurnJson({
      record: makeRecord(),
      questionContext: '🤝 vs Guest | 디아루가 Lv.53 HP:169/169',
      moveOptions: [
        { index: 1, nameKo: '용의파동', pp: 10, maxPp: 10, disabled: false },
      ],
      partyOptions: [
        { index: 1, name: '디아루가', hp: 169, maxHp: 169, fainted: false },
      ],
      animationFrames: [],
      currentFrameIndex: 0,
    });

    assert.equal(json.sessionId, 'fb-001');
    assert.equal(json.phase, 'battle');
    assert.equal(json.status, 'select_action');
    assert.equal(json.questionContext, '🤝 vs Guest | 디아루가 Lv.53 HP:169/169');
    assert.equal(json.moveOptions.length, 1);
    assert.equal(json.moveOptions[0].nameKo, '용의파동');
    assert.equal(json.currentFrameIndex, 0);
    assert.deepEqual(json.animationFrames, []);
  });

  it('propagates role so the skill knows which side it is driving', () => {
    const json = formatFriendlyBattleTurnJson({
      record: makeRecord({ role: 'guest' }),
      questionContext: 'ctx',
      moveOptions: [],
      partyOptions: [],
      animationFrames: [],
      currentFrameIndex: 0,
    });
    assert.equal(json.role, 'guest');
  });

  it('serializes to stable JSON with all contract keys present', () => {
    const json = formatFriendlyBattleTurnJson({
      record: makeRecord(),
      questionContext: 'ctx',
      moveOptions: [],
      partyOptions: [],
      animationFrames: [{ kind: 'hit', durationMs: 150, target: 'opponent' }],
      currentFrameIndex: 0,
    });
    const serialized = JSON.parse(JSON.stringify(json));
    assert.ok('sessionId' in serialized);
    assert.ok('role' in serialized);
    assert.ok('phase' in serialized);
    assert.ok('status' in serialized);
    assert.ok('questionContext' in serialized);
    assert.ok('moveOptions' in serialized);
    assert.ok('partyOptions' in serialized);
    assert.ok('animationFrames' in serialized);
    assert.ok('currentFrameIndex' in serialized);
    assert.equal(serialized.animationFrames[0].kind, 'hit');
    assert.equal(serialized.animationFrames[0].durationMs, 150);
  });
});

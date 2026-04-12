import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRIENDLY_BATTLE_PROTOCOL_VERSION,
  canFriendlyBattleStart,
  createFriendlyBattleBattleRef,
  createFriendlyBattleParticipant,
  createFriendlyBattleReadyState,
  createFriendlyBattleSessionState,
  isFriendlyBattlePeerMessageType,
} from '../src/friendly-battle/contracts.js';

describe('friendly battle contracts', () => {
  it('derives ready-state startability from both participants', () => {
    const notReady = createFriendlyBattleReadyState(true, false);
    const ready = createFriendlyBattleReadyState(true, true);

    assert.deepEqual(notReady, {
      hostReady: true,
      guestReady: false,
      canStart: false,
    });
    assert.equal(canFriendlyBattleStart(notReady), false);
    assert.equal(canFriendlyBattleStart(ready), true);
  });

  it('creates role-aware participant defaults', () => {
    const host = createFriendlyBattleParticipant('host', 'Host');
    const guest = createFriendlyBattleParticipant('guest', 'Guest');

    assert.equal(host.connectionState, 'connected');
    assert.equal(guest.connectionState, 'invited');
    assert.equal(host.ready, false);
    assert.equal(guest.ready, false);
  });

  it('creates an idle battle reference for session startup', () => {
    assert.deepEqual(createFriendlyBattleBattleRef(), {
      layer: 'battle',
      battleId: null,
      turn: 0,
      phase: 'idle',
      startedAt: null,
      endedAt: null,
    });
  });

  it('creates a session state that keeps progression, snapshot, session, and battle boundaries separate', () => {
    const session = createFriendlyBattleSessionState({
      sessionId: 'sess-123',
      sessionCode: 'alpha-123',
      generation: 'gen4',
      hostPlayerName: 'Host',
      createdAt: '2026-04-12T10:00:00.000Z',
      hostProgression: {
        layer: 'progression',
        generation: 'gen4',
        partySource: 'current_party',
        partyPokemonIds: ['025', '006', '149'],
      },
    });

    assert.equal(session.layer, 'session');
    assert.equal(session.protocolVersion, FRIENDLY_BATTLE_PROTOCOL_VERSION);
    assert.equal(session.phase, 'awaiting_guest');
    assert.equal(session.hostProgression.layer, 'progression');
    assert.equal(session.hostSnapshot, null);
    assert.equal(session.guestProgression, null);
    assert.equal(session.guestSnapshot, null);
    assert.deepEqual(session.pendingChoices, {});
    assert.deepEqual(session.battle, createFriendlyBattleBattleRef());
    assert.equal(session.guest.playerName, 'Guest');
    assert.equal(canFriendlyBattleStart(session), false);
  });

  it('rejects session state creation when the session generation and progression generation differ', () => {
    assert.throws(
      () =>
        createFriendlyBattleSessionState({
          sessionId: 'sess-123',
          sessionCode: 'alpha-123',
          generation: 'gen4',
          hostPlayerName: 'Host',
          createdAt: '2026-04-12T10:00:00.000Z',
          hostProgression: {
            layer: 'progression',
            generation: 'gen5',
            partySource: 'current_party',
            partyPokemonIds: ['025', '006', '149'],
          },
        }),
      /Friendly battle session generation must match host progression generation/,
    );
  });

  it('recognizes supported peer message types', () => {
    assert.equal(isFriendlyBattlePeerMessageType('hello'), true);
    assert.equal(isFriendlyBattlePeerMessageType('battle_event'), true);
    assert.equal(isFriendlyBattlePeerMessageType('bogus'), false);
  });
});

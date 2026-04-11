import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  BattleCommandRejectedPayload,
  BattleServerEventEnvelope,
  ViewerVisibleState,
} from '../src/server/battle/index.js';
import {
  applyPvpServerEvent,
  createBattleCommandEnvelope,
  createPvpSessionState,
  hasPendingAction,
  isCommandLocked,
} from '../src/pvp/index.js';

const BASE_VISIBLE_STATE: ViewerVisibleState = {
  self: {
    active: {
      slot: 1,
      speciesId: '001',
      nickname: 'Bulba',
      levelActual: 55,
      levelEffective: 52,
      hp: 120,
      hpMax: 120,
      status: null,
      fainted: false,
      moves: [
        { slot: 1, id: 'tackle', disabled: false, currentPp: 35 },
        { slot: 2, id: 'growl', disabled: false, currentPp: 40 },
      ],
    },
    bench: [
      { slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false },
      { slot: 3, speciesId: '007', nickname: 'Squirt', fainted: false },
    ],
  },
  opponent: {
    active: {
      slot: 1,
      speciesId: '133',
      nickname: 'Eevee',
      levelActual: 54,
      levelEffective: 52,
      hp: 110,
      hpMax: 110,
      status: null,
      fainted: false,
    },
    benchCount: 2,
  },
};

function cloneVisibleState(overrides?: Partial<ViewerVisibleState>): ViewerVisibleState {
  return {
    self: {
      active: { ...BASE_VISIBLE_STATE.self.active },
      bench: BASE_VISIBLE_STATE.self.bench.map((entry) => ({ ...entry })),
      ...(overrides?.self ?? {}),
    },
    opponent: {
      active: { ...BASE_VISIBLE_STATE.opponent.active },
      benchCount: BASE_VISIBLE_STATE.opponent.benchCount,
      ...(overrides?.opponent ?? {}),
    },
  };
}

function makeSnapshot(seq = 1): BattleServerEventEnvelope {
  return {
    type: 'room.snapshot',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      roomStatus: 'in_progress',
      battleStatus: 'awaiting_actions',
      generation: 'gen4',
      rulesetKey: 'tkm-friendly-gen4-v1',
      yourSeat: 'host',
      turn: 3,
      visibleState: cloneVisibleState(),
      pendingRequest: {
        kind: 'choose_move_or_switch',
        deadlineMs: 30_000,
        commandSubmitted: false,
      },
    },
  };
}

function makeActionRequest(seq = 2): BattleServerEventEnvelope {
  return {
    type: 'battle.request_action',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      turn: 3,
      phase: 'awaiting_actions',
      requestId: 'req-turn-3',
      deadlineMs: 25_000,
      request: {
        kind: 'choose_move_or_switch',
        activePokemon: { ...cloneVisibleState().self.active },
        availableMoves: [
          { slot: 1, id: 'tackle', disabled: false, currentPp: 35 },
          { slot: 2, id: 'growl', disabled: false, currentPp: 40 },
        ],
        availableSwitches: [
          { slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false },
          { slot: 3, speciesId: '007', nickname: 'Squirt', fainted: false },
        ],
      },
    },
  };
}

function makeAccepted(clientCommandId = 'cmd-1', seq = 3): BattleServerEventEnvelope {
  return {
    type: 'battle.command_accepted',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      clientCommandId,
      turn: 3,
      phase: 'awaiting_actions',
      lockedIn: true,
    },
  };
}

function makeRejected(
  payload: Partial<BattleCommandRejectedPayload> = {},
  seq = 4,
): BattleServerEventEnvelope {
  return {
    type: 'battle.command_rejected',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      clientCommandId: payload.clientCommandId ?? 'cmd-1',
      code: payload.code ?? 'PVP_COMMAND_PHASE_MISMATCH',
      message: payload.message ?? 'phase mismatch',
      retryable: payload.retryable ?? true,
    },
  };
}

function makeTurnResolved(seq = 5): BattleServerEventEnvelope {
  return {
    type: 'battle.turn_resolved',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      turn: 3,
      events: [
        {
          eventType: 'move_used',
          actor: 'self',
          actorSlot: 1,
          actorSpeciesId: '001',
          moveSlot: 1,
          moveId: 'tackle',
        },
      ],
      postTurnVisibleState: cloneVisibleState({
        self: {
          active: {
            ...BASE_VISIBLE_STATE.self.active,
            hp: 95,
            hpMax: 120,
          },
        },
      }),
      nextPhase: 'awaiting_actions',
    },
  };
}

function makeForceReplacement(seq = 6): BattleServerEventEnvelope {
  return {
    type: 'battle.force_replacement',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      turn: 4,
      phase: 'awaiting_replacement',
      requestId: 'replace-turn-4',
      deadlineMs: 20_000,
      faintedSlot: 1,
      availableReplacements: [
        { slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false },
        { slot: 3, speciesId: '007', nickname: 'Squirt', fainted: false },
      ],
    },
  };
}

function makeEnded(seq = 7): BattleServerEventEnvelope {
  return {
    type: 'battle.ended',
    roomId: 'room_000001',
    battleId: 'battle_000001',
    seq,
    sentAt: `2026-04-11T10:00:0${seq}.000Z`,
    payload: {
      result: 'win',
      reason: 'all_opponent_pokemon_fainted',
      finalVisibleState: {
        self: { remainingCount: 2 },
        opponent: { remainingCount: 0 },
      },
    },
  };
}

describe('pvp session store', () => {
  it('snapshot bootstraps state', () => {
    const state = applyPvpServerEvent(createPvpSessionState(), makeSnapshot());

    assert.equal(state.roomId, 'room_000001');
    assert.equal(state.battleId, 'battle_000001');
    assert.equal(state.battleStatus, 'awaiting_actions');
    assert.equal(state.turn, 3);
    assert.equal(state.pendingRequest?.kind, 'choose_move_or_switch');
    assert.equal(state.visibleState?.self.active.speciesId, '001');
    assert.equal(hasPendingAction(state), true);
    assert.equal(isCommandLocked(state), false);
  });

  it('request_action sets actionable request', () => {
    const snapshot = applyPvpServerEvent(createPvpSessionState(), makeSnapshot());
    const state = applyPvpServerEvent(snapshot, makeActionRequest());

    assert.equal(state.pendingRequest?.kind, 'choose_move_or_switch');
    assert.equal(state.pendingRequest?.requestId, 'req-turn-3');
    assert.equal(state.pendingRequest?.availableMoves?.length, 2);
    assert.equal(state.pendingRequest?.availableSwitches?.length, 2);
    assert.equal(hasPendingAction(state), true);
    assert.equal(isCommandLocked(state), false);
  });

  it('accepted command locks input', () => {
    const requested = applyPvpServerEvent(
      applyPvpServerEvent(createPvpSessionState(), makeSnapshot()),
      makeActionRequest(),
    );
    const submitted = createBattleCommandEnvelope(requested, {
      clientCommandId: 'cmd-1',
      sentAt: '2026-04-11T10:01:00.000Z',
      command: { type: 'choose_move', moveSlot: 1 },
    });
    const locked = applyPvpServerEvent(submitted.state, makeAccepted('cmd-1'));

    assert.equal(submitted.envelope.payload.phase, 'awaiting_actions');
    assert.equal(locked.pendingRequest?.commandSubmitted, true);
    assert.equal(locked.pendingCommand?.status, 'accepted');
    assert.equal(isCommandLocked(locked), true);
  });

  it('retryable rejection unlocks input', () => {
    const requested = applyPvpServerEvent(
      applyPvpServerEvent(createPvpSessionState(), makeSnapshot()),
      makeActionRequest(),
    );
    const submitted = createBattleCommandEnvelope(requested, {
      clientCommandId: 'cmd-1',
      sentAt: '2026-04-11T10:01:00.000Z',
      command: { type: 'choose_move', moveSlot: 1 },
    });
    const rejected = applyPvpServerEvent(
      submitted.state,
      makeRejected({ clientCommandId: 'cmd-1', retryable: true }),
    );

    assert.equal(rejected.pendingRequest?.commandSubmitted, false);
    assert.equal(rejected.pendingCommand, null);
    assert.equal(rejected.lastRejectedCommand?.retryable, true);
    assert.equal(hasPendingAction(rejected), true);
    assert.equal(isCommandLocked(rejected), false);
  });

  it('turn_resolved clears transient state and updates visibleState', () => {
    const requested = applyPvpServerEvent(
      applyPvpServerEvent(createPvpSessionState(), makeSnapshot()),
      makeActionRequest(),
    );
    const submitted = createBattleCommandEnvelope(requested, {
      clientCommandId: 'cmd-1',
      sentAt: '2026-04-11T10:01:00.000Z',
      command: { type: 'choose_move', moveSlot: 1 },
    });
    const resolved = applyPvpServerEvent(submitted.state, makeTurnResolved());

    assert.equal(resolved.pendingRequest, null);
    assert.equal(resolved.pendingCommand, null);
    assert.equal(resolved.lastResolvedTurn, 3);
    assert.equal(resolved.visibleState?.self.active.hp, 95);
    assert.equal(isCommandLocked(resolved), false);
  });

  it('force_replacement creates replacement request', () => {
    const state = applyPvpServerEvent(createPvpSessionState(), makeForceReplacement());

    assert.equal(state.battleStatus, 'awaiting_replacement');
    assert.equal(state.pendingRequest?.kind, 'choose_replacement');
    assert.equal(state.pendingRequest?.faintedSlot, 1);
    assert.equal(state.pendingRequest?.availableReplacements?.length, 2);
    assert.equal(hasPendingAction(state), true);
  });

  it('ended clears pending request and marks terminal state', () => {
    const requested = applyPvpServerEvent(
      applyPvpServerEvent(createPvpSessionState(), makeSnapshot()),
      makeActionRequest(),
    );
    const ended = applyPvpServerEvent(requested, makeEnded());

    assert.equal(ended.battleStatus, 'finished');
    assert.equal(ended.pendingRequest, null);
    assert.equal(ended.pendingCommand, null);
    assert.equal(ended.terminalResult?.result, 'win');
    assert.equal(hasPendingAction(ended), false);
  });

  it('authoritative snapshot clears stale local pending submission on resync', () => {
    const requested = applyPvpServerEvent(
      applyPvpServerEvent(createPvpSessionState(), makeSnapshot()),
      makeActionRequest(),
    );
    const submitted = createBattleCommandEnvelope(requested, {
      clientCommandId: 'cmd-stale',
      sentAt: '2026-04-11T10:01:00.000Z',
      command: { type: 'choose_move', moveSlot: 1 },
    });
    const resynced = applyPvpServerEvent(
      submitted.state,
      {
        ...makeSnapshot(50),
        payload: {
          ...makeSnapshot(50).payload,
          pendingRequest: {
            kind: 'choose_move_or_switch',
            deadlineMs: 10_000,
            commandSubmitted: false,
          },
        },
      },
    );

    assert.ok(submitted.state.pendingCommand);
    assert.equal(resynced.pendingCommand, null);
    assert.equal(resynced.pendingRequest?.commandSubmitted, false);
    assert.equal(resynced.resyncCount, 1);
    assert.equal(isCommandLocked(resynced), false);
  });

  it('createBattleCommandEnvelope builds valid envelope from current pending request and rejects impossible cases', () => {
    const requested = applyPvpServerEvent(
      applyPvpServerEvent(createPvpSessionState(), makeSnapshot()),
      makeActionRequest(),
    );
    const created = createBattleCommandEnvelope(requested, {
      clientCommandId: 'cmd-switch',
      sentAt: '2026-04-11T10:02:00.000Z',
      command: { type: 'choose_switch', targetSlot: 2 },
    });

    assert.equal(created.envelope.type, 'battle.command');
    assert.equal(created.envelope.roomId, 'room_000001');
    assert.equal(created.envelope.battleId, 'battle_000001');
    assert.equal(created.envelope.seq, 1);
    assert.equal(created.envelope.payload.turn, 3);
    assert.equal(created.envelope.payload.phase, 'awaiting_actions');
    assert.deepEqual(created.envelope.payload.command, { type: 'choose_switch', targetSlot: 2 });
    assert.equal(created.state.nextClientSeq, 2);
    assert.equal(isCommandLocked(created.state), true);

    assert.throws(
      () =>
        createBattleCommandEnvelope(requested, {
          clientCommandId: 'cmd-bad',
          sentAt: '2026-04-11T10:02:10.000Z',
          command: { type: 'choose_replacement', targetSlot: 2 },
        }),
      /current pending request/i,
    );

    assert.throws(
      () =>
        createBattleCommandEnvelope(created.state, {
          clientCommandId: 'cmd-duplicate',
          sentAt: '2026-04-11T10:02:20.000Z',
          command: { type: 'choose_move', moveSlot: 1 },
        }),
      /locked/i,
    );
  });
});

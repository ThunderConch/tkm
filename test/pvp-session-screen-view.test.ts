import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpClientState,
  createPvpSessionScreenView,
  createPvpSessionState,
  type PvpSessionClientState,
  type PvpSessionState,
  type PvpTurnResolvedPayloadLike,
} from '../src/pvp/index.js';

function createBaseClientState(): PvpSessionClientState {
  const session = createPvpSessionState();
  const protocol = createPvpClientState();
  protocol.session = session;

  return {
    transportStatus: 'idle',
    session,
    protocol,
    reconnect: {
      autoReconnectEnabled: true,
      attempt: 0,
      scheduled: false,
      delay: null,
      nextReconnectAt: null,
      lastTrigger: null,
    },
    canSendCommand: false,
    hasPendingRequest: false,
    activeRequestKind: null,
  };
}

function buildActionRequest(overrides: Partial<PvpSessionState['pendingRequest']> = {}) {
  return {
    kind: 'choose_move_or_switch' as const,
    phase: 'awaiting_actions' as const,
    turn: 18,
    deadlineMs: 30_000,
    commandSubmitted: false,
    requestId: 'req-18',
    activePokemon: {
      slot: 1,
      speciesId: '025',
      nickname: 'Pika',
      levelActual: 66,
      levelEffective: 60,
      hp: 88,
      hpMax: 120,
      status: null,
      fainted: false,
    },
    availableMoves: [
      { slot: 1, id: 'thunderbolt', disabled: false, currentPp: 10 },
      { slot: 2, id: 'quick_attack', disabled: false, currentPp: 30 },
    ],
    availableSwitches: [
      { slot: 2, speciesId: '133', nickname: 'Eevee', fainted: false },
    ],
    ...overrides,
  };
}

function createVisibleState() {
  return {
    self: {
      active: {
        slot: 1,
        speciesId: '025',
        nickname: 'Pika',
        levelActual: 66,
        levelEffective: 60,
        hp: 88,
        hpMax: 120,
        status: null,
        fainted: false,
      },
      bench: [
        { slot: 2, speciesId: '133', nickname: 'Eevee', fainted: false },
        { slot: 3, speciesId: '143', nickname: 'Snorlax', fainted: true },
      ],
    },
    opponent: {
      active: {
        slot: 1,
        speciesId: '006',
        nickname: 'Zard',
        levelActual: 72,
        levelEffective: 60,
        hp: 30,
        hpMax: 150,
        status: 'burn',
        fainted: false,
      },
      benchCount: 2,
    },
  };
}

describe('pvp session screen view', () => {
  it('returns null for null state', () => {
    assert.equal(createPvpSessionScreenView(null), null);
  });

  it('summarizes transport, session meta, request/command/turn subviews into one deterministic screen model', () => {
    const state = createBaseClientState();
    state.transportStatus = 'connected';
    state.canSendCommand = false;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    state.reconnect = {
      autoReconnectEnabled: true,
      attempt: 0,
      scheduled: false,
      delay: null,
      nextReconnectAt: null,
      lastTrigger: null,
    };
    state.session.roomId = 'room-17';
    state.session.battleId = 'battle-17';
    state.session.roomStatus = 'in_battle';
    state.session.battleStatus = 'awaiting_actions';
    state.session.generation = 'gen2';
    state.session.rulesetKey = 'tkm-gen2-friendly';
    state.session.yourSeat = 'host';
    state.session.turn = 18;
    state.session.lastEventType = 'battle.command_accepted';
    state.session.lastEventAt = '2026-04-11T15:00:00.000Z';
    state.session.pendingRequest = buildActionRequest({ commandSubmitted: true });
    state.session.pendingCommand = {
      clientCommandId: 'cmd-18',
      turn: 18,
      phase: 'awaiting_actions',
      command: { type: 'choose_move', moveSlot: 1 },
      seq: 9,
      sentAt: '2026-04-11T15:00:00.000Z',
      status: 'accepted',
      lockedIn: true,
    };
    state.session.visibleState = createVisibleState();
    state.session.lastResolvedTurn = 17;

    const payload: PvpTurnResolvedPayloadLike = {
      turn: 17,
      nextPhase: 'awaiting_actions',
      postTurnVisibleState: createVisibleState(),
      events: [
        {
          eventType: 'move_used',
          actor: 'self',
          actorSlot: 1,
          actorSpeciesId: '025',
          moveSlot: 1,
          moveId: 'thunderbolt',
        },
      ],
    };

    const view = createPvpSessionScreenView(state, payload);

    assert.ok(view);
    assert.equal(view.source, 'session');
    assert.equal(view.status, 'command_locked');
    assert.equal(view.statusLabel, '명령 제출 완료');
    assert.equal(view.emptyStateLabel, null);
    assert.equal(view.terminal, false);
    assert.equal(view.transport.summaryLabel, '실시간 연결됨');
    assert.equal(view.transport.detailLabel, '자동 재접속 대기 없음');
    assert.equal(view.transport.reconnectLabel, '자동 재접속 켜짐');
    assert.equal(view.session.summaryLabel, 'gen2 · 룰 tkm-gen2-friendly · 18턴 · host');
    assert.equal(view.session.detailLabel, 'room room-17 · battle battle-17 · room in_battle · battle awaiting_actions');
    assert.equal(view.session.lastEventLabel, '마지막 이벤트 battle.command_accepted · 2026-04-11T15:00:00.000Z');
    assert.equal(view.actionRequest?.title, 'Pika (025) 행동 선택');
    assert.equal(view.commandStatus?.statusLabel, '명령 접수 완료');
    assert.equal(view.turnResult?.turn, 17);
    assert.equal(view.turnResult?.source, 'payload');
    assert.equal(view.hasPendingRequest, true);
    assert.equal(view.hasTurnResult, true);
  });

  it('renders reconnecting empty states without requiring a pending request or turn result', () => {
    const state = createBaseClientState();
    state.transportStatus = 'reconnecting';
    state.reconnect = {
      autoReconnectEnabled: true,
      attempt: 2,
      scheduled: true,
      delay: 2000,
      nextReconnectAt: '2026-04-11T15:10:02.000Z',
      lastTrigger: 'transport_close',
    };

    const view = createPvpSessionScreenView(state);

    assert.ok(view);
    assert.equal(view.status, 'reconnecting');
    assert.equal(view.statusLabel, '재접속 중');
    assert.equal(view.emptyStateLabel, '아직 표시할 배틀 요청이나 결과가 없습니다.');
    assert.equal(view.transport.summaryLabel, '재접속 시도 중');
    assert.equal(view.transport.detailLabel, '2회차 재접속 예약 · 2026-04-11T15:10:02.000Z');
    assert.equal(view.transport.reconnectLabel, '자동 재접속 켜짐');
    assert.equal(view.session.summaryLabel, '세션 메타 대기 중');
    assert.equal(view.actionRequest, null);
    assert.equal(view.commandStatus?.statusLabel, '제출 대기 없음');
    assert.equal(view.turnResult, null);
    assert.equal(view.hasRenderableContent, false);
  });

  it('marks terminal sessions and can fall back to session-only turn summaries', () => {
    const state = createBaseClientState();
    state.transportStatus = 'closed';
    state.session.roomId = 'room-final';
    state.session.battleId = 'battle-final';
    state.session.battleStatus = 'finished';
    state.session.turn = 19;
    state.session.visibleState = createVisibleState();
    state.session.lastResolvedTurn = 19;
    state.session.terminalResult = {
      result: 'win',
      reason: 'forfeit',
      finalVisibleState: {
        self: { remainingCount: 3 },
        opponent: { remainingCount: 0 },
      },
    };

    const view = createPvpSessionScreenView(state);

    assert.ok(view);
    assert.equal(view.status, 'terminal');
    assert.equal(view.statusLabel, '전투 종료');
    assert.equal(view.terminal, true);
    assert.equal(view.transport.summaryLabel, '연결 종료');
    assert.equal(view.turnResult?.source, 'session');
    assert.equal(view.turnResult?.summary.terminalResultLabel, '승리 · 종료 사유 forfeit');
  });
});

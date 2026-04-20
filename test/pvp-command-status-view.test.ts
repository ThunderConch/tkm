import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpCommandStatusView,
  createPvpCommandStatusViewFromSession,
  createPvpSessionState,
  type PvpSessionClientState,
  type PvpSessionState,
} from '../src/pvp/index.js';

function buildActionRequest(overrides: Partial<PvpSessionState['pendingRequest']> = {}) {
  return {
    kind: 'choose_move_or_switch' as const,
    phase: 'awaiting_actions' as const,
    turn: 12,
    deadlineMs: 30_000,
    commandSubmitted: false,
    requestId: 'req-turn-12',
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

function createBaseSession(): PvpSessionState {
  const session = createPvpSessionState();
  session.turn = 12;
  session.battleStatus = 'awaiting_actions';
  session.pendingRequest = buildActionRequest();
  return session;
}

function createClientState(session: PvpSessionState): PvpSessionClientState {
  return {
    transportStatus: 'connected',
    session,
    protocol: {
      session,
      lastInboundEnvelope: null,
      lastOutboundEnvelope: null,
    },
    reconnect: {
      autoReconnectEnabled: true,
      attempt: 0,
      scheduled: false,
      delay: null,
      nextReconnectAt: null,
      lastTrigger: 'manual',
    },
    canSendCommand: Boolean(session.pendingRequest),
    hasPendingRequest: Boolean(session.pendingRequest),
    activeRequestKind: session.pendingRequest?.kind ?? null,
  };
}

describe('pvp command status view', () => {
  it('returns null for null input and renders an idle session as none state', () => {
    assert.equal(createPvpCommandStatusView(null), null);
    assert.equal(createPvpCommandStatusViewFromSession(null), null);

    const session = createPvpSessionState();
    const view = createPvpCommandStatusViewFromSession(session);

    assert.ok(view);
    assert.equal(view.submissionState, 'none');
    assert.equal(view.statusLabel, '제출 대기 없음');
    assert.equal(view.commandSummary, null);
    assert.equal(view.locked, false);
    assert.equal(view.canInteract, false);
    assert.equal(view.relationSummary, '활성 요청이 없어 commandSubmitted / pendingCommand 관계를 추적하지 않습니다.');
    assert.equal(view.rejection, null);
  });

  it('renders created state as waiting for battle.command_accepted', () => {
    const session = createBaseSession();
    session.pendingCommand = {
      clientCommandId: 'cmd-1',
      turn: 12,
      phase: 'awaiting_actions',
      command: { type: 'choose_move', moveSlot: 1 },
      seq: 3,
      sentAt: '2026-04-11T14:20:00.000Z',
      status: 'created',
      lockedIn: false,
    };

    const view = createPvpCommandStatusView(createClientState(session));

    assert.ok(view);
    assert.equal(view.submissionState, 'created');
    assert.equal(view.commandSummary, '기술 1번');
    assert.equal(view.statusLabel, '서버 접수 확인 대기');
    assert.equal(view.locked, true);
    assert.equal(view.canInteract, false);
    assert.equal(view.requestCommandSubmitted, false);
    assert.equal(view.pendingCommandStatus, 'created');
    assert.equal(
      view.relationSummary,
      '로컬 pendingCommand는 created 상태이지만 서버의 battle.command_accepted를 아직 받지 않아 request.commandSubmitted=false 입니다.',
    );
  });

  it('renders accepted state with pendingCommand and commandSubmitted as fully consistent', () => {
    const session = createBaseSession();
    session.pendingRequest = buildActionRequest({ commandSubmitted: true });
    session.pendingCommand = {
      clientCommandId: 'cmd-2',
      turn: 12,
      phase: 'awaiting_actions',
      command: { type: 'choose_switch', targetSlot: 2 },
      seq: 4,
      sentAt: '2026-04-11T14:21:00.000Z',
      status: 'accepted',
      lockedIn: true,
    };

    const view = createPvpCommandStatusView(createClientState(session));

    assert.ok(view);
    assert.equal(view.submissionState, 'accepted');
    assert.equal(view.commandSummary, '교체 슬롯 2');
    assert.equal(view.statusLabel, '명령 접수 완료');
    assert.equal(view.detailLabel, '상대 입력/턴 해석 대기');
    assert.equal(view.locked, true);
    assert.equal(view.canInteract, false);
    assert.equal(view.pendingCommandStatus, 'accepted');
    assert.equal(view.pendingCommandLockedIn, true);
    assert.equal(
      view.relationSummary,
      '서버가 명령을 접수해 pendingCommand.status=accepted, request.commandSubmitted=true 로 일치합니다.',
    );
  });

  it('renders permanently rejected state with rejection summary and locked interaction', () => {
    const session = createBaseSession();
    session.pendingCommand = {
      clientCommandId: 'cmd-3',
      turn: 12,
      phase: 'awaiting_actions',
      command: { type: 'forfeit' },
      seq: 5,
      sentAt: '2026-04-11T14:22:00.000Z',
      status: 'rejected_permanent',
      lockedIn: true,
    };
    session.lastRejectedCommand = {
      clientCommandId: 'cmd-3',
      code: 'COMMAND_PHASE_MISMATCH',
      message: '이미 다른 phase로 전환되었습니다.',
      retryable: false,
    };

    const view = createPvpCommandStatusView(createClientState(session));

    assert.ok(view);
    assert.equal(view.submissionState, 'rejected_permanent');
    assert.equal(view.commandSummary, '항복');
    assert.equal(view.statusLabel, '명령 영구 거부');
    assert.equal(view.locked, true);
    assert.equal(view.canInteract, false);
    assert.deepEqual(view.rejection, {
      code: 'COMMAND_PHASE_MISMATCH',
      message: '이미 다른 phase로 전환되었습니다.',
      retryable: false,
      statusLabel: '재제출 불가',
      summary: '재제출 불가 · COMMAND_PHASE_MISMATCH · 이미 다른 phase로 전환되었습니다.',
    });
    assert.equal(
      view.relationSummary,
      '마지막 제출이 영구 거부되어 pendingCommand.status=rejected_permanent 입니다. 현재 요청은 잠긴 상태로 간주합니다.',
    );
  });

  it('treats request.commandSubmitted=true snapshots without pendingCommand as accepted fallback', () => {
    const session = createBaseSession();
    session.pendingRequest = buildActionRequest({ commandSubmitted: true });

    const view = createPvpCommandStatusView(createClientState(session));

    assert.ok(view);
    assert.equal(view.submissionState, 'accepted');
    assert.equal(view.commandSummary, null);
    assert.equal(view.statusLabel, '이미 제출됨');
    assert.equal(view.detailLabel, '스냅샷 기준 제출 완료');
    assert.equal(view.locked, true);
    assert.equal(view.canInteract, false);
    assert.equal(view.pendingCommandStatus, null);
    assert.equal(
      view.relationSummary,
      '서버 스냅샷 기준으로 request.commandSubmitted=true 이지만 로컬 pendingCommand 세부 정보는 없습니다.',
    );
  });
});

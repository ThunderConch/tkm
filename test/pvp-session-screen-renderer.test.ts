import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpClientState,
  createPvpSessionState,
  renderPvpSessionClientScreen,
  renderPvpSessionScreen,
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

describe('pvp session screen renderer', () => {
  it('renders null/empty screens into a deterministic placeholder layout', () => {
    const direct = renderPvpSessionScreen(null);
    const fromState = renderPvpSessionClientScreen(null);

    assert.equal(direct, fromState);
    assert.equal(
      direct,
      [
        '=== PvP Session Screen ===',
        '상태: 세션 없음',
        '',
        '[transport]',
        '- 상태: 세션 없음',
        '- 상세: 세션 스냅샷이 아직 없습니다.',
        '',
        '[session]',
        '- 요약: 세션 스냅샷이 아직 없습니다.',
        '',
        '[action-request]',
        '- 대기 중인 행동 요청이 없습니다.',
        '',
        '[command-status]',
        '- 제출 상태를 표시할 세션이 없습니다.',
        '',
        '[turn-result]',
        '- 표시할 턴 결과가 없습니다.',
      ].join('\n'),
    );
  });

  it('renders awaiting_input screens with summaries, menu entries, command state, and turn result blocks', () => {
    const state = createBaseClientState();
    state.transportStatus = 'connected';
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    state.session.roomId = 'room-18';
    state.session.battleId = 'battle-18';
    state.session.roomStatus = 'in_battle';
    state.session.battleStatus = 'awaiting_actions';
    state.session.generation = 'gen3';
    state.session.rulesetKey = 'tkm-gen3-friendly';
    state.session.yourSeat = 'guest';
    state.session.turn = 18;
    state.session.lastEventType = 'battle.turn_resolved';
    state.session.lastEventAt = '2026-04-11T16:00:00.000Z';
    state.session.pendingRequest = buildActionRequest();
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

    const rendered = renderPvpSessionClientScreen(state, payload);

    assert.match(rendered, /^=== PvP Session Screen ===/);
    assert.match(rendered, /상태: 행동 선택 가능/);
    assert.match(rendered, /- 상세: 기술을 쓰거나 교체할 포켓몬을 선택하세요\./);
    assert.match(rendered, /\[transport\]\n- 상태: 실시간 연결됨/);
    assert.match(rendered, /\[session\]\n- 요약: gen3 · 룰 tkm-gen3-friendly · 18턴 · guest/);
    assert.match(rendered, /- 마지막 이벤트: 마지막 이벤트 battle.turn_resolved · 2026-04-11T16:00:00.000Z/);
    assert.match(rendered, /\[action-request\]\n- 제목: Pika \(025\) 행동 선택/);
    assert.match(rendered, /  \* \[가능\] 1\. thunderbolt \| token=1 \| PP 10/);
    assert.match(rendered, /  \* \[가능\] Eevee \(133\) \| token=switch:2 \| 슬롯 2/);
    assert.match(rendered, /\[command-status\]\n- 상태: 명령 선택 가능/);
    assert.match(rendered, /\[turn-result\]\n- 제목: 턴 17 결과/);
    assert.match(rendered, /  \* 기술 사용: 내 025 \(슬롯 1\)이\(가\) thunderbolt 사용/);
  });

  it('renders reconnecting screens with consistent empty placeholders', () => {
    const state = createBaseClientState();
    state.transportStatus = 'reconnecting';
    state.reconnect = {
      autoReconnectEnabled: true,
      attempt: 2,
      scheduled: true,
      delay: 2000,
      nextReconnectAt: '2026-04-11T16:10:02.000Z',
      lastTrigger: 'transport_close',
    };

    const rendered = renderPvpSessionClientScreen(state);

    const lines = rendered.split('\n');
    assert.equal(lines[0], '=== PvP Session Screen ===');
    assert.equal(lines[1], '상태: 재접속 중');
    assert.match(rendered, /- 상세: 2회차 재접속 예약 · 2026-04-11T16:10:02.000Z/);
    assert.match(rendered, /\[action-request\]\n- 아직 표시할 배틀 요청이나 결과가 없습니다\./);
    assert.match(rendered, /\[turn-result\]\n- 아직 표시할 배틀 요청이나 결과가 없습니다\./);
  });

  it('renders terminal sessions with final summaries and logs when available', () => {
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

    const rendered = renderPvpSessionClientScreen(state);

    assert.match(rendered, /상태: 전투 종료/);
    assert.match(rendered, /- 상세: 승리 · 종료 사유 forfeit/);
    assert.match(rendered, /\[transport\]\n- 상태: 연결 종료/);
    assert.match(rendered, /\[turn-result\]\n- 제목: 턴 19 결과/);
    assert.match(rendered, /- 종료: 승리 · 종료 사유 forfeit/);
  });
});

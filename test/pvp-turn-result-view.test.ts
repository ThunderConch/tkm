import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpSessionState,
  createPvpTurnResultView,
  createPvpTurnResultViewFromPayload,
  type PvpSessionState,
  type PvpTurnResolvedPayloadLike,
} from '../src/pvp/index.js';

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

function createSessionState(): { session: PvpSessionState } {
  const session = createPvpSessionState();
  return { session };
}

describe('pvp turn result view', () => {
  it('renders a 기본 액션 턴 payload into deterministic Korean log entries and summary labels', () => {
    const payload: PvpTurnResolvedPayloadLike = {
      turn: 7,
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
        {
          eventType: 'damage_applied',
          target: 'opponent',
          targetSlot: 1,
          targetSpeciesId: '006',
          hp: 30,
          hpMax: 150,
          damage: 40,
          fainted: false,
        },
        {
          eventType: 'heal_applied',
          target: 'self',
          targetSlot: 1,
          targetSpeciesId: '025',
          hp: 88,
          hpMax: 120,
          heal: 12,
        },
        {
          eventType: 'status_applied',
          target: 'opponent',
          targetSlot: 1,
          targetSpeciesId: '006',
          status: 'burn',
        },
      ],
    };

    const view = createPvpTurnResultViewFromPayload(payload);

    assert.ok(view);
    assert.equal(view.source, 'payload');
    assert.equal(view.turn, 7);
    assert.equal(view.title, '턴 7 결과');
    assert.equal(view.eventCount, 4);
    assert.equal(view.hasEventLog, true);
    assert.deepEqual(
      view.logs.map((entry) => ({ title: entry.title, message: entry.message, emphasis: entry.emphasis })),
      [
        {
          title: '기술 사용',
          message: '내 025 (슬롯 1)이(가) thunderbolt 사용',
          emphasis: 'neutral',
        },
        {
          title: '피해',
          message: '상대 006 (슬롯 1) HP 30/150 (-40)',
          emphasis: 'positive',
        },
        {
          title: '회복',
          message: '내 025 (슬롯 1) HP 88/120 (+12)',
          emphasis: 'positive',
        },
        {
          title: '상태이상',
          message: '상대 006 (슬롯 1) 상태이상 화상',
          emphasis: 'positive',
        },
      ],
    );
    assert.equal(view.summary.self.activeLabel, 'Pika (025) · 슬롯 1 · Lv.60 (실레벨 66) · HP 88/120');
    assert.equal(view.summary.self.benchLabel, '벤치 2마리 · 출전 가능 1 · 기절 1');
    assert.equal(view.summary.self.remainingBenchCount, 1);
    assert.deepEqual(view.summary.self.benchEntries, [
      { slot: 2, label: 'Eevee (133) · 슬롯 2 · 대기', fainted: false },
      { slot: 3, label: 'Snorlax (143) · 슬롯 3 · 기절', fainted: true },
    ]);
    assert.equal(view.summary.opponent.activeLabel, 'Zard (006) · 슬롯 1 · Lv.60 (실레벨 72) · HP 30/150 · 상태 화상');
    assert.equal(view.summary.opponent.benchLabel, '상대 벤치 2칸 비공개');
    assert.equal(view.summary.nextPhaseLabel, '다음 행동 선택');
    assert.equal(view.summary.statusLabel, '다음 턴 진행 가능');
    assert.equal(view.summary.terminalResultLabel, null);
  });

  it('renders a 교체 유도 턴 payload with fainting and replacement events', () => {
    const payload: PvpTurnResolvedPayloadLike = {
      turn: 8,
      nextPhase: 'awaiting_replacement',
      postTurnVisibleState: createVisibleState(),
      events: [
        {
          eventType: 'switch_used',
          actor: 'opponent',
          fromSlot: 2,
          toSlot: 1,
          speciesId: '130',
        },
        {
          eventType: 'damage_applied',
          target: 'self',
          targetSlot: 1,
          targetSpeciesId: '025',
          hp: 0,
          hpMax: 120,
          damage: 88,
          fainted: true,
        },
        {
          eventType: 'pokemon_fainted',
          target: 'self',
          targetSlot: 1,
          targetSpeciesId: '025',
        },
        {
          eventType: 'replacement_selected',
          actor: 'self',
          slot: 2,
          speciesId: '133',
        },
      ],
    };

    const view = createPvpTurnResultViewFromPayload(payload);

    assert.ok(view);
    assert.equal(view.summary.nextPhase, 'awaiting_replacement');
    assert.equal(view.summary.nextPhaseLabel, '교체 포켓몬 선택');
    assert.equal(view.summary.statusLabel, '교체 필요');
    assert.deepEqual(
      view.logs.map((entry) => entry.message),
      [
        '상대 130 · 슬롯 2 → 1 교체',
        '내 025 (슬롯 1) HP 0/120 (-88) · 기절',
        '내 025 (슬롯 1) 기절',
        '내 133 · 슬롯 2 선택',
      ],
    );
    assert.deepEqual(view.logs.map((entry) => entry.emphasis), ['neutral', 'negative', 'negative', 'neutral']);
  });

  it('fills terminal summary from session state for finished turns and supports session-only fallback', () => {
    const state = createSessionState();
    state.session.visibleState = createVisibleState();
    state.session.lastResolvedTurn = 9;
    state.session.battleStatus = 'finished';
    state.session.terminalResult = {
      result: 'win',
      reason: 'forfeit',
      finalVisibleState: {
        self: { remainingCount: 3 },
        opponent: { remainingCount: 0 },
      },
    };

    const payload: PvpTurnResolvedPayloadLike = {
      turn: 9,
      nextPhase: 'finished',
      postTurnVisibleState: createVisibleState(),
      events: [
        {
          eventType: 'forfeit',
          actor: 'opponent',
        },
      ],
    };

    const payloadBackedView = createPvpTurnResultView(state, payload);
    const sessionOnlyView = createPvpTurnResultView(state);

    assert.ok(payloadBackedView);
    assert.equal(payloadBackedView.source, 'payload');
    assert.equal(payloadBackedView.summary.nextPhaseLabel, '배틀 종료');
    assert.equal(payloadBackedView.summary.statusLabel, '전투 종료');
    assert.equal(payloadBackedView.summary.terminalResultLabel, '승리 · 종료 사유 forfeit');
    assert.deepEqual(payloadBackedView.logs.map((entry) => entry.message), ['상대 플레이어가 항복']);
    assert.deepEqual(payloadBackedView.logs.map((entry) => entry.emphasis), ['positive']);

    assert.ok(sessionOnlyView);
    assert.equal(sessionOnlyView.source, 'session');
    assert.equal(sessionOnlyView.turn, 9);
    assert.equal(sessionOnlyView.hasEventLog, false);
    assert.deepEqual(sessionOnlyView.logs, []);
    assert.equal(sessionOnlyView.summary.terminalResultLabel, '승리 · 종료 사유 forfeit');
    assert.equal(sessionOnlyView.summary.nextPhase, 'finished');
  });

  it('returns null for null or insufficient inputs', () => {
    const emptyState = createSessionState();

    assert.equal(createPvpTurnResultViewFromPayload(null), null);
    assert.equal(createPvpTurnResultView(null), null);
    assert.equal(createPvpTurnResultView(emptyState), null);
  });
});

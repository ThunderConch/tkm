import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpActionRequestView,
  createPvpActionRequestViewFromPendingRequest,
  createPvpClientState,
  createPvpSessionState,
  type PendingCommandState,
  type PvpPendingRequest,
  type PvpSessionClientState,
} from '../src/pvp/index.js';

function createBaseSessionClientState(): PvpSessionClientState {
  const session = createPvpSessionState();
  const protocol = createPvpClientState();
  protocol.session = session;

  return {
    transportStatus: 'connected',
    session,
    protocol,
    reconnect: {
      autoReconnectEnabled: true,
      attempt: 0,
      scheduled: false,
      delay: null,
      nextReconnectAt: null,
      lastTrigger: 'manual_connect',
    },
    canSendCommand: false,
    hasPendingRequest: false,
    activeRequestKind: null,
  };
}

function buildActionRequest(overrides: Partial<Extract<PvpPendingRequest, { kind: 'choose_move_or_switch' }>> = {}): Extract<PvpPendingRequest, { kind: 'choose_move_or_switch' }> {
  return {
    kind: 'choose_move_or_switch',
    phase: 'awaiting_actions',
    turn: 12,
    deadlineMs: 30_000,
    commandSubmitted: false,
    requestId: 'req-action-12',
    activePokemon: {
      slot: 1,
      speciesId: '001',
      nickname: 'Bulba',
      levelActual: 55,
      levelEffective: 52,
      hp: 120,
      hpMax: 150,
      status: 'poison',
      fainted: false,
    },
    availableMoves: [
      { slot: 2, id: 'growl', disabled: true, currentPp: 40 },
      { slot: 1, id: 'tackle', disabled: false, currentPp: 35 },
    ],
    availableSwitches: [
      { slot: 3, speciesId: '007', nickname: 'Squirt', fainted: true },
      { slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false },
    ],
    ...overrides,
  };
}

function buildReplacementRequest(overrides: Partial<Extract<PvpPendingRequest, { kind: 'choose_replacement' }>> = {}): Extract<PvpPendingRequest, { kind: 'choose_replacement' }> {
  return {
    kind: 'choose_replacement',
    phase: 'awaiting_replacement',
    turn: 13,
    deadlineMs: 20_000,
    commandSubmitted: false,
    requestId: 'req-replace-13',
    faintedSlot: 1,
    availableReplacements: [
      { slot: 3, speciesId: '007', nickname: 'Squirt', fainted: true },
      { slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false },
    ],
    ...overrides,
  };
}

function setPendingCommand(state: PvpSessionClientState, overrides: Partial<PendingCommandState> = {}): void {
  state.session.pendingCommand = {
    clientCommandId: 'cmd-1',
    turn: state.session.pendingRequest?.turn ?? 12,
    phase: state.session.pendingRequest?.phase ?? 'awaiting_actions',
    command: { type: 'choose_move', moveSlot: 1 },
    seq: 1,
    sentAt: '2026-04-11T14:00:00.000Z',
    status: 'created',
    lockedIn: false,
    ...overrides,
  };
}

describe('pvp action request view', () => {
  it('renders choose_move_or_switch requests into menu sections and command previews', () => {
    const state = createBaseSessionClientState();
    state.session.pendingRequest = buildActionRequest();
    state.session.battleStatus = 'awaiting_actions';
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';

    const view = createPvpActionRequestView(state);

    assert.ok(view);
    assert.equal(view.requestKind, 'choose_move_or_switch');
    assert.equal(view.title, 'Bulba (001) 행동 선택');
    assert.equal(view.statusLabel, '선택 가능');
    assert.equal(view.locked, false);
    assert.equal(view.canInteract, true);
    assert.equal(view.activePokemonLabel, 'Bulba (001) · Lv.52 (actual 55) · HP 120/150 · status: poison');
    assert.deepEqual(view.sections.map((section) => section.id), ['moves', 'switches', 'system']);

    const moves = view.sections[0]?.entries;
    assert.equal(moves?.length, 2);
    assert.equal(moves?.[0]?.label, '1. tackle');
    assert.equal(moves?.[0]?.enabled, true);
    assert.equal(moves?.[0]?.inputToken, '1');
    assert.deepEqual(moves?.[0]?.command, { type: 'choose_move', moveSlot: 1 });
    assert.equal(moves?.[1]?.label, '2. growl');
    assert.equal(moves?.[1]?.enabled, false);
    assert.equal(moves?.[1]?.disabledReason, '사용할 수 없는 기술');

    const switches = view.sections[1]?.entries;
    assert.equal(switches?.length, 2);
    assert.equal(switches?.[0]?.label, 'Charmy (004)');
    assert.equal(switches?.[0]?.inputToken, 'switch:2');
    assert.deepEqual(switches?.[0]?.command, { type: 'choose_switch', targetSlot: 2 });
    assert.equal(switches?.[1]?.enabled, false);
    assert.equal(switches?.[1]?.disabledReason, '기절한 포켓몬은 교체할 수 없음');

    const system = view.sections[2]?.entries;
    assert.equal(system?.length, 1);
    assert.equal(system?.[0]?.label, '항복');
    assert.deepEqual(system?.[0]?.command, { type: 'forfeit' });
  });

  it('marks submitted requests as locked and disables every menu entry', () => {
    const state = createBaseSessionClientState();
    state.session.pendingRequest = buildActionRequest({ commandSubmitted: true });
    state.session.battleStatus = 'awaiting_actions';
    state.canSendCommand = false;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';

    const view = createPvpActionRequestView(state);

    assert.ok(view);
    assert.equal(view.commandSubmitted, true);
    assert.equal(view.locked, true);
    assert.equal(view.canInteract, false);
    assert.equal(view.statusLabel, '이미 제출됨');
    assert.equal(view.sections.every((section) => section.entries.every((entry) => entry.enabled === false)), true);
  });

  it('marks pending-command state as waiting for server confirmation', () => {
    const state = createBaseSessionClientState();
    state.session.pendingRequest = buildActionRequest();
    state.session.battleStatus = 'awaiting_actions';
    state.canSendCommand = false;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    setPendingCommand(state);

    const view = createPvpActionRequestView(state);

    assert.ok(view);
    assert.equal(view.locked, true);
    assert.equal(view.commandSubmitted, false);
    assert.equal(view.statusLabel, '서버 확인 대기 중');
    assert.equal(view.sections[0]?.entries[0]?.enabled, false);
  });

  it('renders choose_replacement requests with replacement-specific labels', () => {
    const state = createBaseSessionClientState();
    state.session.pendingRequest = buildReplacementRequest();
    state.session.battleStatus = 'awaiting_replacement';
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_replacement';

    const view = createPvpActionRequestView(state);

    assert.ok(view);
    assert.equal(view.requestKind, 'choose_replacement');
    assert.equal(view.title, '교체 포켓몬 선택');
    assert.equal(view.prompt, '1번 슬롯이 기절했습니다. 교체 포켓몬을 선택하세요.');
    assert.equal(view.activePokemonLabel, null);
    assert.deepEqual(view.sections.map((section) => section.id), ['replacements', 'system']);

    const replacements = view.sections[0]?.entries;
    assert.equal(replacements?.length, 2);
    assert.equal(replacements?.[0]?.label, 'Charmy (004)');
    assert.equal(replacements?.[0]?.inputToken, 'replace:2');
    assert.deepEqual(replacements?.[0]?.command, { type: 'choose_replacement', targetSlot: 2 });
    assert.equal(replacements?.[1]?.enabled, false);
    assert.equal(replacements?.[1]?.disabledReason, '기절한 포켓몬은 교체할 수 없음');
  });

  it('can build a view directly from a pending request without full session client state', () => {
    const view = createPvpActionRequestViewFromPendingRequest(buildReplacementRequest(), {
      canInteract: false,
    });

    assert.ok(view);
    assert.equal(view.statusLabel, '현재 선택 불가');
    assert.equal(view.canInteract, false);
    assert.equal(view.sections[0]?.entries[0]?.enabled, false);
  });

  it('returns null when there is no pending request', () => {
    const state = createBaseSessionClientState();

    assert.equal(createPvpActionRequestView(state), null);
  });
});

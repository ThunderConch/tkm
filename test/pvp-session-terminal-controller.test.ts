import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PvpSessionTerminalController,
  createBattleCommandEnvelope,
  createPvpActionRequestView,
  createPvpClientState,
  createPvpSessionState,
  createPvpSessionTerminalSnapshot,
  renderPvpSessionClientScreen,
  resolvePvpSessionTerminalInputToken,
  type CreateBattleCommandEnvelopeOptions,
  type PvpPendingRequest,
  type PvpSessionClientState,
  type SendPvpSessionBattleCommandResult,
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

function setPendingCommand(state: PvpSessionClientState): void {
  state.session.pendingCommand = {
    clientCommandId: 'cmd-1',
    turn: state.session.pendingRequest?.turn ?? 12,
    phase: state.session.pendingRequest?.phase ?? 'awaiting_actions',
    command: { type: 'choose_move', moveSlot: 1 },
    seq: 1,
    sentAt: '2026-04-11T14:00:00.000Z',
    status: 'created',
    lockedIn: false,
  };
}

function syncProtocolSession(state: PvpSessionClientState): void {
  state.protocol.session = state.session;
}

class FakeSessionClient {
  private state: PvpSessionClientState;

  readonly sentCommands: CreateBattleCommandEnvelopeOptions[] = [];

  throwOnSend: Error | null = null;

  constructor(initialState: PvpSessionClientState) {
    this.state = structuredClone(initialState);
  }

  getState(): PvpSessionClientState {
    return structuredClone(this.state);
  }

  sendBattleCommand(options: CreateBattleCommandEnvelopeOptions): SendPvpSessionBattleCommandResult {
    this.sentCommands.push(structuredClone(options));

    if (this.throwOnSend) {
      throw this.throwOnSend;
    }

    const created = createBattleCommandEnvelope(this.state.session, options);
    const protocol = structuredClone(this.state.protocol);
    protocol.session = created.state;

    this.state = {
      ...this.state,
      session: created.state,
      protocol,
      canSendCommand: false,
      hasPendingRequest: created.state.pendingRequest !== null,
      activeRequestKind: created.state.pendingRequest?.kind ?? null,
    };

    return {
      envelope: created.envelope,
      serialized: JSON.stringify(created.envelope),
      state: this.getState(),
    };
  }
}

describe('pvp session terminal controller', () => {
  it('builds a terminal snapshot with the current plain-text screen and token mappings', () => {
    const state = createBaseSessionClientState();
    state.session.roomId = 'room-12';
    state.session.battleId = 'battle-12';
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(state);

    const snapshot = createPvpSessionTerminalSnapshot(state);
    const actionRequest = createPvpActionRequestView(state);

    assert.equal(snapshot.screen, renderPvpSessionClientScreen(state));
    assert.deepEqual(snapshot.availableInputTokens, ['1', 'switch:2', 'forfeit']);
    assert.deepEqual(snapshot.inputEntries.map((entry) => entry.inputToken), ['1', '2', 'switch:2', 'switch:3', 'forfeit']);
    assert.equal(snapshot.actionRequest?.requestId, actionRequest?.requestId ?? null);
    assert.deepEqual(snapshot.inputEntries[0]?.command, { type: 'choose_move', moveSlot: 1 });
    assert.equal(snapshot.inputEntries[0]?.section.id, 'moves');
  });

  it('resolves current menu input tokens back to authoritative battle commands', () => {
    const state = createBaseSessionClientState();
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(state);

    const result = resolvePvpSessionTerminalInputToken(state, 'switch:2');

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.command, { type: 'choose_switch', targetSlot: 2 });
    assert.equal(result.entry.inputToken, 'switch:2');
  });

  it('submits a valid input token through sessionClient.sendBattleCommand(...)', () => {
    const state = createBaseSessionClientState();
    state.session.roomId = 'room-12';
    state.session.battleId = 'battle-12';
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(state);

    const client = new FakeSessionClient(state);
    const controller = new PvpSessionTerminalController({
      sessionClient: client,
      now: () => new Date('2026-04-11T16:30:00.000Z'),
      createClientCommandId: (_state, command) => `det-${command.type}`,
    });

    const result = controller.submitInputToken('1');

    assert.equal(result.status, 'submitted');
    assert.equal(client.sentCommands.length, 1);
    assert.deepEqual(client.sentCommands[0], {
      clientCommandId: 'det-choose_move',
      sentAt: '2026-04-11T16:30:00.000Z',
      command: { type: 'choose_move', moveSlot: 1 },
    });
    assert.equal(result.sendResult.envelope.payload.clientCommandId, 'det-choose_move');
    assert.equal(result.snapshot.availableInputTokens.includes('1'), true);
  });

  it('returns invalid_token deterministically when the token does not match the current request', () => {
    const state = createBaseSessionClientState();
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(state);

    const controller = new PvpSessionTerminalController({
      sessionClient: new FakeSessionClient(state),
    });

    const result = controller.submitInputToken('switch:999');

    assert.equal(result.status, 'invalid_token');
  });

  it('returns no_request when there is no current pending request', () => {
    const state = createBaseSessionClientState();
    state.session.battleStatus = 'awaiting_actions';
    syncProtocolSession(state);

    const controller = new PvpSessionTerminalController({
      sessionClient: new FakeSessionClient(state),
    });

    const result = controller.submitInputToken('1');

    assert.equal(result.status, 'no_request');
  });

  it('returns locked when the pending request already has a submitted/pending command', () => {
    const state = createBaseSessionClientState();
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = false;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    setPendingCommand(state);
    syncProtocolSession(state);

    const controller = new PvpSessionTerminalController({
      sessionClient: new FakeSessionClient(state),
    });

    const result = controller.submitInputToken('1');

    assert.equal(result.status, 'locked');
  });

  it('returns transport_not_ready before trying to submit when the socket is not connected', () => {
    const state = createBaseSessionClientState();
    state.transportStatus = 'reconnecting';
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = false;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(state);

    const client = new FakeSessionClient(state);
    const controller = new PvpSessionTerminalController({
      sessionClient: client,
    });

    const result = controller.submitInputToken('1');

    assert.equal(result.status, 'transport_not_ready');
    assert.equal(client.sentCommands.length, 0);
  });

  it('returns unavailable when the underlying transport wrapper throws unexpectedly', () => {
    const state = createBaseSessionClientState();
    state.session.roomId = 'room-12';
    state.session.battleId = 'battle-12';
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(state);

    const client = new FakeSessionClient(state);
    client.throwOnSend = new Error('socket unexpectedly missing');
    const controller = new PvpSessionTerminalController({
      sessionClient: client,
    });

    const result = controller.submitInputToken('1');

    assert.equal(result.status, 'unavailable');
    assert.match(result.message, /socket unexpectedly missing/);
  });
});

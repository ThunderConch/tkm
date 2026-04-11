import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createBattleCommandEnvelope,
  createPvpClientState,
  createPvpSessionState,
  createPvpSessionTerminalRunner,
  renderPvpSessionClientScreen,
  type CreateBattleCommandEnvelopeOptions,
  type PvpPendingRequest,
  type PvpSessionClientState,
  type PvpSessionTerminalRunnerState,
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

function syncProtocolSession(state: PvpSessionClientState): void {
  state.protocol.session = state.session;
}

class FakeSessionClient {
  private state: PvpSessionClientState;

  private readonly listeners = new Set<(state: PvpSessionClientState) => void>();

  readonly sentCommands: CreateBattleCommandEnvelopeOptions[] = [];

  constructor(initialState: PvpSessionClientState) {
    this.state = structuredClone(initialState);
  }

  getState(): PvpSessionClientState {
    return structuredClone(this.state);
  }

  subscribe(listener: (state: PvpSessionClientState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());

    return () => {
      this.listeners.delete(listener);
    };
  }

  pushState(nextState: PvpSessionClientState): void {
    this.state = structuredClone(nextState);
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  sendBattleCommand(options: CreateBattleCommandEnvelopeOptions): SendPvpSessionBattleCommandResult {
    this.sentCommands.push(structuredClone(options));

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

describe('pvp session terminal runner', () => {
  it('starts a live subscription and emits the latest deterministic snapshot state', () => {
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
    const runner = createPvpSessionTerminalRunner({
      sessionClient: client,
    });
    const observed: PvpSessionTerminalRunnerState[] = [];
    const unsubscribe = runner.subscribe((runnerState) => {
      observed.push(runnerState);
    });

    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.running, false);
    assert.equal(observed[0]?.revision, 0);

    const started = runner.start();

    assert.equal(started.running, true);
    assert.equal(started.revision, 1);
    assert.equal(started.screen, renderPvpSessionClientScreen(client.getState()));
    assert.deepEqual(started.availableInputTokens, ['1', 'switch:2', 'forfeit']);
    assert.equal(observed.length, 2);
    assert.equal(observed[1]?.running, true);
    assert.equal(observed[1]?.revision, 1);

    unsubscribe();
  });

  it('propagates live session updates while running', () => {
    const initialState = createBaseSessionClientState();
    initialState.session.battleStatus = 'awaiting_actions';
    initialState.session.pendingRequest = buildActionRequest();
    initialState.canSendCommand = true;
    initialState.hasPendingRequest = true;
    initialState.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(initialState);

    const client = new FakeSessionClient(initialState);
    const runner = createPvpSessionTerminalRunner({
      sessionClient: client,
    });

    runner.start();

    const nextState = client.getState();
    nextState.transportStatus = 'reconnecting';
    nextState.reconnect = {
      autoReconnectEnabled: true,
      attempt: 2,
      scheduled: true,
      delay: 2_000,
      nextReconnectAt: '2026-04-12T10:00:02.000Z',
      lastTrigger: 'transport_close',
    };
    nextState.session.pendingRequest = null;
    nextState.session.battleStatus = 'in_progress';
    nextState.canSendCommand = false;
    nextState.hasPendingRequest = false;
    nextState.activeRequestKind = null;
    syncProtocolSession(nextState);

    client.pushState(nextState);

    const runnerState = runner.getState();
    assert.equal(runnerState.running, true);
    assert.equal(runnerState.revision, 2);
    assert.deepEqual(runnerState.availableInputTokens, []);
    assert.match(runnerState.screen, /상태: 재접속 중/);
    assert.equal(runnerState.lastSubmitResult, null);
  });

  it('recomputes the latest snapshot after submit and stores the last submit result', () => {
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
    const runner = createPvpSessionTerminalRunner({
      sessionClient: client,
    });

    runner.start();
    const result = runner.submitInputToken('1');
    const runnerState = runner.getState();

    assert.equal(result.status, 'submitted');
    assert.equal(client.sentCommands.length, 1);
    assert.equal(runnerState.revision, 2);
    assert.equal(runnerState.lastSubmitResult?.status, 'submitted');
    assert.deepEqual(runnerState.lastSubmitResult?.snapshot, runnerState.snapshot);
    assert.equal(runnerState.snapshot.state?.session.pendingCommand?.command.type, 'choose_move');
    assert.equal(runnerState.snapshot.state?.canSendCommand, false);
  });

  it('stops forwarding session-client updates after stop()', () => {
    const initialState = createBaseSessionClientState();
    initialState.session.battleStatus = 'awaiting_actions';
    initialState.session.pendingRequest = buildActionRequest();
    initialState.canSendCommand = true;
    initialState.hasPendingRequest = true;
    initialState.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(initialState);

    const client = new FakeSessionClient(initialState);
    const runner = createPvpSessionTerminalRunner({
      sessionClient: client,
    });

    const observed: PvpSessionTerminalRunnerState[] = [];
    runner.subscribe((runnerState) => {
      observed.push(runnerState);
    });

    runner.start();
    const stopped = runner.stop();
    const revisionAfterStop = stopped.revision;

    assert.equal(stopped.running, false);

    const nextState = client.getState();
    nextState.transportStatus = 'closed';
    nextState.session.battleStatus = 'finished';
    nextState.session.pendingRequest = null;
    nextState.hasPendingRequest = false;
    nextState.canSendCommand = false;
    nextState.activeRequestKind = null;
    syncProtocolSession(nextState);

    client.pushState(nextState);

    assert.equal(runner.getState().revision, revisionAfterStop);
    assert.equal(runner.getState().running, false);
    assert.equal(observed.at(-1)?.revision, revisionAfterStop);
  });
});

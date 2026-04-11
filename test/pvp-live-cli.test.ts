import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpClientState,
  createPvpSessionState,
  startPvpLiveSessionCli,
  type CreateBattleCommandEnvelopeOptions,
  type PvpPendingRequest,
  type PvpSessionBootstrapResult,
  type PvpSessionClientState,
  type PvpSessionTerminalCliInputListener,
  type PvpSessionTerminalCliInputSource,
  type PvpSessionTerminalCliScreenOutput,
  type PvpSessionTerminalRunnerState,
  type SendPvpSessionBattleCommandResult,
} from '../src/pvp/index.js';
import type { RoomView } from '../src/server/projection/index.js';

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
    turn: 1,
    deadlineMs: 30_000,
    commandSubmitted: false,
    requestId: 'req-live-1',
    activePokemon: {
      slot: 1,
      speciesId: '001',
      nickname: 'Bulba',
      levelActual: 55,
      levelEffective: 55,
      hp: 120,
      hpMax: 120,
      status: null,
      fainted: false,
    },
    availableMoves: [{ slot: 1, id: 'tackle', disabled: false, currentPp: 35 }],
    availableSwitches: [{ slot: 2, speciesId: '004', nickname: 'Charmy', fainted: false }],
    ...overrides,
  };
}

function syncProtocolSession(state: PvpSessionClientState): void {
  state.protocol.session = state.session;
}

class FakeSessionClient {
  private state: PvpSessionClientState;

  private readonly listeners = new Set<(state: PvpSessionClientState) => void>();

  connectCalls = 0;

  readonly disconnectCalls: Array<{ code?: number; reason?: string }> = [];

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

  connect(): void {
    this.connectCalls += 1;
  }

  disconnect(closeInfo: { code?: number; reason?: string } = {}): PvpSessionClientState {
    this.disconnectCalls.push({ ...closeInfo });
    return this.getState();
  }

  sendBattleCommand(options: CreateBattleCommandEnvelopeOptions): SendPvpSessionBattleCommandResult {
    this.sentCommands.push(structuredClone(options));

    return {
      envelope: {
        type: 'battle_command',
        roomId: 'room-live',
        battleId: 'battle-live',
        clientCommandId: options.clientCommandId,
        sentAt: options.sentAt,
        command: structuredClone(options.command),
      },
      serialized: JSON.stringify(options),
      state: this.getState(),
    };
  }
}

class FakeAdapter implements PvpSessionTerminalCliInputSource, PvpSessionTerminalCliScreenOutput {
  private listener: PvpSessionTerminalCliInputListener | null = null;

  private abortHandler: (() => void) | null = null;

  readonly repaints: Array<{ screen: string; state: PvpSessionTerminalRunnerState }> = [];

  subscribe(listener: PvpSessionTerminalCliInputListener): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  repaint(screen: string, state: PvpSessionTerminalRunnerState): void {
    this.repaints.push({ screen, state: structuredClone(state) });
  }

  setAbortHandler(handler: (() => void) | null): void {
    this.abortHandler = handler;
  }

  emit(token: string): void {
    this.listener?.(token);
  }

  triggerAbort(): void {
    this.abortHandler?.();
  }
}

function createRoomView(): RoomView {
  return {
    room: {
      roomId: 'room-live',
      code: 'ABCDE',
      status: 'open',
      rulesetKey: 'gen1-open',
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z',
      battleId: null,
      hostPartyId: 'party-host',
      guestPartyId: null,
      players: [],
    },
    viewer: {
      playerSlot: 'host',
      authToken: 'token-host',
      canStartBattle: false,
      canCancelRoom: true,
      canJoinRoom: false,
      canSelectParty: false,
      isReady: true,
      registeredPartyId: 'party-host',
    },
  };
}

describe('startPvpLiveSessionCli', () => {
  it('starts the live cli from a bootstrap result and disconnects on stop', async () => {
    const state = createBaseSessionClientState();
    state.session.roomId = 'room-live';
    state.session.battleId = 'battle-live';
    state.session.battleStatus = 'awaiting_actions';
    state.session.pendingRequest = buildActionRequest();
    state.canSendCommand = true;
    state.hasPendingRequest = true;
    state.activeRequestKind = 'choose_move_or_switch';
    syncProtocolSession(state);

    const sessionClient = new FakeSessionClient(state);
    const adapter = new FakeAdapter();
    const bootstrap: PvpSessionBootstrapResult<FakeSessionClient> = {
      roomView: createRoomView(),
      roomId: 'room-live',
      sessionClient,
    };

    const liveCli = await startPvpLiveSessionCli({
      bootstrap,
      adapter,
    });

    assert.equal(sessionClient.connectCalls, 1);
    assert.equal(liveCli.getState().running, true);
    assert.equal(adapter.repaints.length, 1);

    adapter.emit('1');
    assert.equal(sessionClient.sentCommands.length, 1);

    await liveCli.stop();

    assert.deepEqual(sessionClient.disconnectCalls, [{ code: 1000, reason: 'terminal_cli_stop' }]);
    assert.equal(liveCli.getState().running, false);
  });
});

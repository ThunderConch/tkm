import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ViewerVisibleState } from '../src/server/battle/index.js';
import {
  createPvpWebSocketClient,
  createPvpWebSocketUrl,
  type PvpWebSocketCloseEvent,
  type PvpWebSocketErrorEvent,
  type PvpWebSocketLike,
  type PvpWebSocketMessageEvent,
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

function cloneVisibleState(): ViewerVisibleState {
  return {
    self: {
      active: { ...BASE_VISIBLE_STATE.self.active },
      bench: BASE_VISIBLE_STATE.self.bench.map((entry) => ({ ...entry })),
    },
    opponent: {
      active: { ...BASE_VISIBLE_STATE.opponent.active },
      benchCount: BASE_VISIBLE_STATE.opponent.benchCount,
    },
  };
}

function makeSnapshot(seq = 1) {
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
  } as const;
}

function makeActionRequest(seq = 2) {
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
  } as const;
}

class FakeSocket implements PvpWebSocketLike {
  onopen: (() => void) | null = null;

  onmessage: ((event: PvpWebSocketMessageEvent) => void) | null = null;

  onclose: ((event: PvpWebSocketCloseEvent) => void) | null = null;

  onerror: ((event: PvpWebSocketErrorEvent) => void) | null = null;

  readonly sent: string[] = [];

  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }

  emitClose(event: PvpWebSocketCloseEvent = {}): void {
    this.onclose?.(event);
  }

  emitError(event: PvpWebSocketErrorEvent = {}): void {
    this.onerror?.(event);
  }
}

function createClock(start = '2026-04-11T10:00:00.000Z') {
  let current = new Date(start).getTime();

  return {
    now: () => new Date(current),
    tick(ms = 1_000) {
      current += ms;
    },
  };
}

describe('pvp websocket client', () => {
  it('builds websocket URLs from http origins', () => {
    assert.equal(
      createPvpWebSocketUrl('https://pvp.example.com', 'room_123', 'token_456'),
      'wss://pvp.example.com/ws/pvp?roomId=room_123&token=token_456',
    );
    assert.equal(
      createPvpWebSocketUrl('http://localhost:4317/custom/ws', 'room_123', 'token_456'),
      'ws://localhost:4317/custom/ws?roomId=room_123&token=token_456',
    );
  });

  it('connects, subscribes, and hydrates battle state from room snapshots', () => {
    const clock = createClock();
    const sockets: FakeSocket[] = [];
    const client = createPvpWebSocketClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: clock.now,
      createSocket(url) {
        assert.equal(url, 'wss://pvp.example.com/ws/pvp?roomId=room_000001&token=auth-token');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const observedStatuses: string[] = [];
    const unsubscribe = client.subscribe((state) => {
      observedStatuses.push(state.transportStatus);
    });

    const connectingState = client.connect();
    assert.equal(connectingState.transportStatus, 'connecting');
    assert.equal(connectingState.connectCount, 1);

    sockets[0].emitOpen();
    clock.tick();
    sockets[0].emitMessage(JSON.stringify(makeSnapshot()));

    const state = client.getState();
    assert.equal(state.transportStatus, 'connected');
    assert.equal(state.lastConnectedAt, '2026-04-11T10:00:00.000Z');
    assert.equal(state.protocol.session.roomId, 'room_000001');
    assert.equal(state.protocol.session.battleId, 'battle_000001');
    assert.equal(state.protocol.session.pendingRequest?.kind, 'choose_move_or_switch');
    assert.equal(state.lastInboundRawMessage, JSON.stringify(makeSnapshot()));
    assert.deepEqual(observedStatuses, ['idle', 'connecting', 'connected', 'connected']);

    unsubscribe();
  });

  it('replies to ws.ping with ws.pong and records outbound payloads', () => {
    const clock = createClock();
    const socket = new FakeSocket();
    const client = createPvpWebSocketClient({
      serverUrl: 'wss://pvp.example.com/ws/pvp',
      roomId: 'room_000001',
      token: 'auth-token',
      now: clock.now,
      createSocket() {
        return socket;
      },
    });

    client.connect();
    socket.emitOpen();
    clock.tick(250);
    socket.emitMessage(JSON.stringify({ type: 'ws.ping', sentAt: '2026-04-11T10:05:00.000Z' }));

    assert.equal(socket.sent.length, 1);
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: 'ws.pong',
      sentAt: '2026-04-11T10:00:00.250Z',
    });

    const state = client.getState();
    assert.equal(state.protocol.lastPingAt, '2026-04-11T10:05:00.000Z');
    assert.equal(state.protocol.lastPongSentAt, '2026-04-11T10:00:00.250Z');
    assert.equal(state.lastOutboundRawMessage, socket.sent[0]);
  });

  it('serializes battle commands through the websocket after an action request', () => {
    const clock = createClock();
    const socket = new FakeSocket();
    const client = createPvpWebSocketClient({
      serverUrl: 'wss://pvp.example.com/ws/pvp',
      roomId: 'room_000001',
      token: 'auth-token',
      now: clock.now,
      createSocket() {
        return socket;
      },
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage(JSON.stringify(makeSnapshot()));
    socket.emitMessage(JSON.stringify(makeActionRequest()));
    clock.tick(2_000);

    const result = client.sendBattleCommand({
      clientCommandId: 'cmd-1',
      sentAt: clock.now().toISOString(),
      command: {
        type: 'choose_move',
        moveSlot: 1,
      },
    });

    assert.equal(socket.sent.length, 1);
    assert.equal(result.serialized, socket.sent[0]);
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: 'battle.command',
      roomId: 'room_000001',
      battleId: 'battle_000001',
      seq: 1,
      sentAt: '2026-04-11T10:00:02.000Z',
      payload: {
        clientCommandId: 'cmd-1',
        turn: 3,
        phase: 'awaiting_actions',
        command: {
          type: 'choose_move',
          moveSlot: 1,
        },
      },
    });

    const state = client.getState();
    assert.equal(state.protocol.session.pendingCommand?.clientCommandId, 'cmd-1');
    assert.equal(state.protocol.session.pendingCommand?.status, 'created');
    assert.equal(state.lastOutboundRawMessage, socket.sent[0]);
  });

  it('records parse failures as transport errors without mutating the battle session', () => {
    const clock = createClock();
    const socket = new FakeSocket();
    const client = createPvpWebSocketClient({
      serverUrl: 'wss://pvp.example.com/ws/pvp',
      roomId: 'room_000001',
      token: 'auth-token',
      now: clock.now,
      createSocket() {
        return socket;
      },
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage(JSON.stringify(makeSnapshot()));
    const before = client.getState();

    socket.emitMessage('{bad json');

    const after = client.getState();
    assert.equal(after.transportStatus, 'error');
    assert.equal(after.lastTransportError?.code, 'PVP_CLIENT_MESSAGE_PARSE_ERROR');
    assert.equal(after.protocol.session.roomId, before.protocol.session.roomId);
    assert.equal(after.protocol.session.battleId, before.protocol.session.battleId);
    assert.equal(after.protocol.lastTransportMessageType, before.protocol.lastTransportMessageType);
  });

  it('records socket close metadata and supports reconnecting with a new socket', () => {
    const clock = createClock();
    const sockets: FakeSocket[] = [];
    const client = createPvpWebSocketClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: clock.now,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].emitOpen();
    clock.tick(5_000);
    sockets[0].emitClose({ code: 4002, reason: 'PVP_WS_HEARTBEAT_TIMEOUT', wasClean: false });

    let state = client.getState();
    assert.equal(state.transportStatus, 'closed');
    assert.deepEqual(state.lastClose, {
      code: 4002,
      reason: 'PVP_WS_HEARTBEAT_TIMEOUT',
      wasClean: false,
      at: '2026-04-11T10:00:05.000Z',
    });

    const reconnecting = client.reconnect();
    assert.equal(reconnecting.transportStatus, 'reconnecting');
    assert.equal(reconnecting.connectCount, 2);
    sockets[1].emitOpen();

    state = client.getState();
    assert.equal(state.transportStatus, 'connected');
    assert.equal(sockets.length, 2);
  });
});

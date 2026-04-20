import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ViewerVisibleState } from '../src/server/battle/index.js';
import {
  createPvpSessionClient,
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
    sentAt: `2026-04-11T12:00:0${seq}.000Z`,
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
    sentAt: `2026-04-11T12:00:0${seq}.000Z`,
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

function createTimeHarness(start = '2026-04-11T12:00:00.000Z') {
  let current = new Date(start).getTime();
  let nextId = 1;
  const timers = new Map<number, { runAt: number; callback: () => void }>();

  const scheduler = {
    setTimeout(callback: () => void, delayMs: number): number {
      const id = nextId++;
      timers.set(id, {
        runAt: current + delayMs,
        callback,
      });
      return id;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === 'number') {
        timers.delete(handle);
      }
    },
  };

  function advance(ms: number): void {
    const target = current + ms;

    while (true) {
      let nextTimer: { id: number; runAt: number; callback: () => void } | null = null;
      for (const [id, timer] of timers.entries()) {
        if (timer.runAt > target) {
          continue;
        }

        if (!nextTimer || timer.runAt < nextTimer.runAt || (timer.runAt === nextTimer.runAt && id < nextTimer.id)) {
          nextTimer = { id, runAt: timer.runAt, callback: timer.callback };
        }
      }

      if (!nextTimer) {
        break;
      }

      current = nextTimer.runAt;
      timers.delete(nextTimer.id);
      nextTimer.callback();
    }

    current = target;
  }

  return {
    now: () => new Date(current),
    scheduler,
    advance,
  };
}

describe('pvp session client', () => {
  it('exposes derived session and protocol state after a snapshot', () => {
    const time = createTimeHarness();
    const sockets: FakeSocket[] = [];
    const client = createPvpSessionClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      scheduler: time.scheduler,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].emitOpen();
    sockets[0].emitMessage(JSON.stringify(makeSnapshot()));

    const state = client.getState();
    assert.equal(state.transportStatus, 'connected');
    assert.equal(state.session.roomId, 'room_000001');
    assert.equal(state.session.battleId, 'battle_000001');
    assert.equal(state.protocol.session.roomId, 'room_000001');
    assert.equal(state.protocol.lastTransportMessageType, 'room.snapshot');
    assert.equal(state.hasPendingRequest, true);
    assert.equal(state.activeRequestKind, 'choose_move_or_switch');
    assert.equal(state.canSendCommand, true);
    assert.equal(state.reconnect.scheduled, false);
  });

  it('locks command sending in derived state after sending a battle command', () => {
    const time = createTimeHarness();
    const socket = new FakeSocket();
    const client = createPvpSessionClient({
      serverUrl: 'wss://pvp.example.com/ws/pvp',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      scheduler: time.scheduler,
      createSocket() {
        return socket;
      },
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage(JSON.stringify(makeSnapshot()));
    socket.emitMessage(JSON.stringify(makeActionRequest()));
    time.advance(2_000);

    assert.equal(client.getState().canSendCommand, true);

    const result = client.sendBattleCommand({
      clientCommandId: 'cmd-1',
      sentAt: time.now().toISOString(),
      command: {
        type: 'choose_move',
        moveSlot: 1,
      },
    });

    assert.equal(socket.sent.length, 1);
    assert.equal(result.state.canSendCommand, false);
    assert.equal(result.state.hasPendingRequest, true);
    assert.equal(result.state.session.pendingCommand?.clientCommandId, 'cmd-1');
    assert.equal(result.state.protocol.session.pendingCommand?.clientCommandId, 'cmd-1');
  });

  it('surfaces reconnect scheduling metadata after an unexpected close', () => {
    const time = createTimeHarness();
    const sockets: FakeSocket[] = [];
    const client = createPvpSessionClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      scheduler: time.scheduler,
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      multiplier: 2,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].emitOpen();
    time.advance(500);
    sockets[0].emitClose({ code: 4002, reason: 'PVP_WS_HEARTBEAT_TIMEOUT', wasClean: false });

    const state = client.getState();
    assert.equal(state.transportStatus, 'closed');
    assert.equal(state.reconnect.autoReconnectEnabled, true);
    assert.equal(state.reconnect.scheduled, true);
    assert.equal(state.reconnect.attempt, 1);
    assert.equal(state.reconnect.delay, 1_000);
    assert.equal(state.reconnect.nextReconnectAt, '2026-04-11T12:00:01.500Z');
    assert.equal(state.reconnect.lastTrigger, 'transport_close');
  });

  it('returns to connected after a successful reconnect', () => {
    const time = createTimeHarness();
    const sockets: FakeSocket[] = [];
    const client = createPvpSessionClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      scheduler: time.scheduler,
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      multiplier: 2,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].emitOpen();
    sockets[0].emitMessage(JSON.stringify(makeSnapshot()));
    time.advance(500);
    sockets[0].emitClose({ code: 4002, reason: 'PVP_WS_HEARTBEAT_TIMEOUT', wasClean: false });

    time.advance(1_000);
    assert.equal(sockets.length, 2);
    assert.equal(client.getState().transportStatus, 'reconnecting');

    sockets[1].emitOpen();

    const state = client.getState();
    assert.equal(state.transportStatus, 'connected');
    assert.equal(state.reconnect.scheduled, false);
    assert.equal(state.reconnect.attempt, 0);
    assert.equal(state.reconnect.delay, null);
    assert.equal(state.reconnect.nextReconnectAt, null);
    assert.equal(state.reconnect.lastTrigger, null);
    assert.equal(state.session.roomId, 'room_000001');
  });
});

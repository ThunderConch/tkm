import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPvpReconnectController,
  createPvpWebSocketClient,
  type PvpWebSocketCloseEvent,
  type PvpWebSocketErrorEvent,
  type PvpWebSocketLike,
  type PvpWebSocketMessageEvent,
} from '../src/pvp/index.js';

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

  emitClose(event: PvpWebSocketCloseEvent = {}): void {
    this.onclose?.(event);
  }

  emitError(event: PvpWebSocketErrorEvent = {}): void {
    this.onerror?.(event);
  }
}

function createTimeHarness(start = '2026-04-11T11:00:00.000Z') {
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
    pendingTimerCount: () => timers.size,
  };
}

describe('pvp reconnect controller', () => {
  it('schedules an automatic reconnect after an unexpected close', () => {
    const time = createTimeHarness();
    const sockets: FakeSocket[] = [];
    const client = createPvpWebSocketClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const controller = createPvpReconnectController({
      client,
      now: time.now,
      scheduler: time.scheduler,
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      multiplier: 2,
    });

    controller.connect();
    sockets[0].emitOpen();
    time.advance(500);
    sockets[0].emitClose({ code: 4002, reason: 'PVP_WS_HEARTBEAT_TIMEOUT', wasClean: false });

    let state = controller.getState();
    assert.equal(state.reconnectScheduled, true);
    assert.equal(state.reconnectAttempt, 1);
    assert.equal(state.reconnectDelayMs, 1_000);
    assert.equal(state.nextReconnectAt, '2026-04-11T11:00:01.500Z');
    assert.equal(state.client.transportStatus, 'closed');
    assert.equal(time.pendingTimerCount(), 1);

    time.advance(999);
    assert.equal(sockets.length, 1);

    time.advance(1);
    assert.equal(sockets.length, 2);
    assert.equal(client.getState().transportStatus, 'reconnecting');

    sockets[1].emitOpen();
    state = controller.getState();
    assert.equal(state.reconnectScheduled, false);
    assert.equal(state.reconnectAttempt, 0);
    assert.equal(state.reconnectDelayMs, null);
    assert.equal(state.nextReconnectAt, null);
    assert.equal(state.client.transportStatus, 'connected');
  });

  it('backs off across repeated reconnect failures and resets after a successful open', () => {
    const time = createTimeHarness();
    const sockets: FakeSocket[] = [];
    const client = createPvpWebSocketClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const controller = createPvpReconnectController({
      client,
      now: time.now,
      scheduler: time.scheduler,
      baseDelayMs: 500,
      maxDelayMs: 4_000,
      multiplier: 2,
    });

    controller.connect();
    sockets[0].emitOpen();
    sockets[0].emitClose({ code: 4001, reason: 'network_drop', wasClean: false });
    assert.equal(controller.getState().reconnectDelayMs, 500);

    time.advance(500);
    assert.equal(sockets.length, 2);
    sockets[1].emitClose({ code: 4001, reason: 'network_drop', wasClean: false });

    let state = controller.getState();
    assert.equal(state.reconnectAttempt, 2);
    assert.equal(state.reconnectDelayMs, 1_000);

    time.advance(1_000);
    assert.equal(sockets.length, 3);
    sockets[2].emitOpen();
    assert.equal(controller.getState().reconnectAttempt, 0);

    sockets[2].emitClose({ code: 4001, reason: 'network_drop', wasClean: false });
    state = controller.getState();
    assert.equal(state.reconnectAttempt, 1);
    assert.equal(state.reconnectDelayMs, 500);
  });

  it('does not double-schedule when an error is followed by a close', () => {
    const time = createTimeHarness();
    const sockets: FakeSocket[] = [];
    const client = createPvpWebSocketClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const controller = createPvpReconnectController({
      client,
      now: time.now,
      scheduler: time.scheduler,
      baseDelayMs: 750,
      maxDelayMs: 4_000,
      multiplier: 2,
    });

    controller.connect();
    sockets[0].emitOpen();
    sockets[0].emitError({ message: 'socket transport failure' });

    const afterError = controller.getState();
    assert.equal(afterError.reconnectScheduled, true);
    assert.equal(afterError.reconnectAttempt, 1);
    assert.equal(time.pendingTimerCount(), 1);

    time.advance(200);
    sockets[0].emitClose({ code: 4000, reason: 'abnormal_close', wasClean: false });

    const afterClose = controller.getState();
    assert.equal(afterClose.reconnectScheduled, true);
    assert.equal(afterClose.reconnectAttempt, 1);
    assert.equal(time.pendingTimerCount(), 1);

    time.advance(550);
    assert.equal(sockets.length, 2);
    assert.equal(client.getState().transportStatus, 'reconnecting');
  });

  it('does not reconnect after a manual disconnect', () => {
    const time = createTimeHarness();
    const sockets: FakeSocket[] = [];
    const client = createPvpWebSocketClient({
      serverUrl: 'https://pvp.example.com',
      roomId: 'room_000001',
      token: 'auth-token',
      now: time.now,
      createSocket() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const controller = createPvpReconnectController({
      client,
      now: time.now,
      scheduler: time.scheduler,
      baseDelayMs: 1_000,
      maxDelayMs: 4_000,
      multiplier: 2,
    });

    controller.connect();
    sockets[0].emitOpen();
    controller.disconnect({ code: 1000, reason: 'user_left_room' });
    sockets[0].emitClose({ code: 1000, reason: 'user_left_room', wasClean: true });

    const state = controller.getState();
    assert.equal(state.autoReconnectEnabled, false);
    assert.equal(state.reconnectScheduled, false);
    assert.equal(state.reconnectAttempt, 0);
    assert.equal(state.client.lastClose.reason, 'user_left_room');

    time.advance(5_000);
    assert.equal(sockets.length, 1);
  });
});

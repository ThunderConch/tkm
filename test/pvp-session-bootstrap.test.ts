import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PvpSessionBootstrapError,
  createPvpSessionBootstrap,
  type PvpRoomHttpClient,
  type PvpWebSocketCloseEvent,
  type PvpWebSocketErrorEvent,
  type PvpWebSocketLike,
  type PvpWebSocketMessageEvent,
} from '../src/pvp/index.js';
import type { RoomView } from '../src/server/index.js';

const ROOM_VIEW: RoomView = {
  room: {
    roomId: 'room_000001',
    roomCode: 'A7KQ2M',
    mode: 'friendly_private',
    status: 'awaiting_presence',
    generation: 'gen4',
    rulesetKey: 'tkm-friendly-gen4-v1',
    createdAt: '2026-04-11T07:10:00.000Z',
    expiresAt: '2026-04-11T07:25:00.000Z',
  },
  you: {
    seat: 'host',
    partySnapshotId: 'party_000001',
    partyValidationStatus: 'accepted',
    presence: 'offline',
    battleReady: false,
  },
  opponent: null,
  match: {
    freezeStatus: 'waiting_for_opponent',
    battleId: null,
    battleStartedAt: null,
  },
};

class FakeSocket implements PvpWebSocketLike {
  onopen: (() => void) | null = null;

  onmessage: ((event: PvpWebSocketMessageEvent) => void) | null = null;

  onclose: ((event: PvpWebSocketCloseEvent) => void) | null = null;

  onerror: ((event: PvpWebSocketErrorEvent) => void) | null = null;

  send(): void {}

  close(): void {}
}

describe('pvp session bootstrap', () => {
  it('createRoomSession creates a room then auto-connects a session client', async () => {
    const roomClient: PvpRoomHttpClient = {
      createRoom: async (request) => {
        assert.deepEqual(request, {
          authToken: 'auth-token',
          generation: 'gen4',
          visibility: 'private_friend',
          rulesetKey: 'tkm-friendly-gen4-v1',
        });
        return ROOM_VIEW;
      },
      joinRoom: async () => {
        throw new Error('not used');
      },
      getRoom: async () => {
        throw new Error('not used');
      },
    };
    const createdSocketUrls: string[] = [];
    const bootstrap = createPvpSessionBootstrap({
      roomClient,
      serverUrl: 'https://pvp.example.com',
      createSocket(url) {
        createdSocketUrls.push(url);
        return new FakeSocket();
      },
    });

    const result = await bootstrap.createRoomSession({
      authToken: 'auth-token',
      generation: 'gen4',
      visibility: 'private_friend',
      rulesetKey: 'tkm-friendly-gen4-v1',
      autoConnect: true,
    });

    assert.equal(result.roomId, 'room_000001');
    assert.deepEqual(result.roomView, ROOM_VIEW);
    assert.equal(createdSocketUrls.length, 1);
    assert.equal(
      createdSocketUrls[0],
      'wss://pvp.example.com/ws/pvp?roomId=room_000001&token=auth-token',
    );
    assert.equal(result.sessionClient.getState().transportStatus, 'connecting');
  });

  it('joinRoomSession delegates to the room client and keeps the session idle by default', async () => {
    const roomClient: PvpRoomHttpClient = {
      createRoom: async () => {
        throw new Error('not used');
      },
      joinRoom: async (request) => {
        assert.deepEqual(request, {
          authToken: 'guest-token',
          roomId: 'room_000001',
          roomCode: 'A7KQ2M',
          generation: 'gen4',
        });
        return ROOM_VIEW;
      },
      getRoom: async () => {
        throw new Error('not used');
      },
    };
    const createdSocketUrls: string[] = [];
    const bootstrap = createPvpSessionBootstrap({
      roomClient,
      serverUrl: 'https://pvp.example.com',
      createSocket(url) {
        createdSocketUrls.push(url);
        return new FakeSocket();
      },
    });

    const result = await bootstrap.joinRoomSession({
      authToken: 'guest-token',
      roomId: 'room_000001',
      roomCode: 'A7KQ2M',
      generation: 'gen4',
    });

    assert.equal(result.roomId, 'room_000001');
    assert.equal(result.sessionClient.getState().transportStatus, 'idle');
    assert.deepEqual(createdSocketUrls, []);
  });

  it('can build a session directly from an existing RoomView', () => {
    const bootstrap = createPvpSessionBootstrap({
      roomClient: {
        createRoom: async () => ROOM_VIEW,
        joinRoom: async () => ROOM_VIEW,
        getRoom: async () => ROOM_VIEW,
      },
      serverUrl: 'https://pvp.example.com',
      createSocket() {
        return new FakeSocket();
      },
    });

    const result = bootstrap.createSessionFromRoomView({
      authToken: 'auth-token',
      roomView: ROOM_VIEW,
    });

    assert.equal(result.roomId, 'room_000001');
    assert.equal(result.sessionClient.getState().transportStatus, 'idle');
  });

  it('rejects malformed room views before constructing a session client', () => {
    const bootstrap = createPvpSessionBootstrap({
      roomClient: {
        createRoom: async () => ROOM_VIEW,
        joinRoom: async () => ROOM_VIEW,
        getRoom: async () => ROOM_VIEW,
      },
      serverUrl: 'https://pvp.example.com',
      createSocket() {
        return new FakeSocket();
      },
    });

    assert.throws(
      () => bootstrap.createSessionFromRoomView({
        authToken: 'auth-token',
        roomView: {
          ...ROOM_VIEW,
          room: {
            ...ROOM_VIEW.room,
            roomId: '',
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PvpSessionBootstrapError);
        assert.equal(error.code, 'PVP_SESSION_BOOTSTRAP_ROOM_ID_INVALID');
        return true;
      },
    );
  });
});

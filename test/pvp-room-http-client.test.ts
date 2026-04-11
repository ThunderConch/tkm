import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PvpRoomHttpClientError,
  createPvpRoomHttpClient,
  type PvpFetchLikeResponse,
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
    presence: 'connected',
    battleReady: true,
  },
  opponent: {
    seat: 'guest',
    presence: 'offline',
    battleReady: true,
    displayName: 'player-guest',
  },
  match: {
    freezeStatus: 'pending_presence',
    battleId: null,
    battleStartedAt: null,
  },
};

function createJsonResponse(status: number, body: unknown): PvpFetchLikeResponse {
  return {
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

describe('pvp room http client', () => {
  it('createRoom posts JSON with auth headers and returns RoomView', async () => {
    const requests: Array<{ url: string; init?: unknown }> = [];
    const client = createPvpRoomHttpClient({
      serverUrl: 'https://pvp.example.com',
      fetch: async (url, init) => {
        requests.push({ url, init });
        return createJsonResponse(200, ROOM_VIEW);
      },
    });

    const roomView = await client.createRoom({
      authToken: 'auth-token',
      generation: 'gen4',
      visibility: 'private_friend',
      rulesetKey: 'tkm-friendly-gen4-v1',
    });

    assert.deepEqual(roomView, ROOM_VIEW);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      url: 'https://pvp.example.com/api/pvp/rooms',
      init: {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer auth-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          generation: 'gen4',
          visibility: 'private_friend',
          rulesetKey: 'tkm-friendly-gen4-v1',
        }),
      },
    });
  });

  it('joinRoom posts to the room join route with room id and code', async () => {
    const requests: Array<{ url: string; init?: unknown }> = [];
    const client = createPvpRoomHttpClient({
      serverUrl: 'https://pvp.example.com',
      fetch: async (url, init) => {
        requests.push({ url, init });
        return createJsonResponse(200, ROOM_VIEW);
      },
    });

    await client.joinRoom({
      authToken: 'guest-token',
      roomId: 'room_000001',
      roomCode: 'A7KQ2M',
      generation: 'gen4',
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      url: 'https://pvp.example.com/api/pvp/rooms/room_000001/join',
      init: {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer guest-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          roomCode: 'A7KQ2M',
          generation: 'gen4',
        }),
      },
    });
  });

  it('getRoom fetches the room projection without a request body', async () => {
    const requests: Array<{ url: string; init?: unknown }> = [];
    const client = createPvpRoomHttpClient({
      serverUrl: 'https://pvp.example.com',
      fetch: async (url, init) => {
        requests.push({ url, init });
        return createJsonResponse(200, ROOM_VIEW);
      },
    });

    const roomView = await client.getRoom({
      authToken: 'viewer-token',
      roomId: 'room_000001',
    });

    assert.deepEqual(roomView, ROOM_VIEW);
    assert.deepEqual(requests[0], {
      url: 'https://pvp.example.com/api/pvp/rooms/room_000001',
      init: {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer viewer-token',
        },
      },
    });
  });

  it('surfaces non-2xx error envelopes as typed http errors', async () => {
    const client = createPvpRoomHttpClient({
      serverUrl: 'https://pvp.example.com',
      fetch: async () => createJsonResponse(409, {
        error: {
          code: 'PVP_ROOM_CODE_MISMATCH',
          message: 'Room code does not match.',
          retryable: false,
          details: {
            roomId: 'room_000001',
          },
        },
      }),
    });

    await assert.rejects(
      () => client.joinRoom({
        authToken: 'guest-token',
        roomId: 'room_000001',
        roomCode: 'WRONG1',
        generation: 'gen4',
      }),
      (error: unknown) => {
        assert.ok(error instanceof PvpRoomHttpClientError);
        assert.equal(error.kind, 'http_error');
        assert.equal(error.operation, 'join_room');
        assert.equal(error.status, 409);
        assert.equal(error.code, 'PVP_ROOM_CODE_MISMATCH');
        assert.equal(error.retryable, false);
        assert.deepEqual(error.details, { roomId: 'room_000001' });
        return true;
      },
    );
  });

  it('treats malformed success payloads as invalid client responses', async () => {
    const client = createPvpRoomHttpClient({
      serverUrl: 'https://pvp.example.com',
      fetch: async () => createJsonResponse(200, {
        room: {
          roomId: 'room_000001',
        },
      }),
    });

    await assert.rejects(
      () => client.getRoom({ authToken: 'viewer-token', roomId: 'room_000001' }),
      (error: unknown) => {
        assert.ok(error instanceof PvpRoomHttpClientError);
        assert.equal(error.kind, 'invalid_response');
        assert.equal(error.operation, 'get_room');
        assert.equal(error.status, 200);
        assert.equal(error.code, 'PVP_ROOM_HTTP_INVALID_RESPONSE');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('wraps fetch rejections as network errors', async () => {
    const client = createPvpRoomHttpClient({
      serverUrl: 'https://pvp.example.com',
      fetch: async () => {
        throw new Error('socket hang up');
      },
    });

    await assert.rejects(
      () => client.getRoom({ authToken: 'viewer-token', roomId: 'room_000001' }),
      (error: unknown) => {
        assert.ok(error instanceof PvpRoomHttpClientError);
        assert.equal(error.kind, 'network_error');
        assert.equal(error.operation, 'get_room');
        assert.equal(error.status, null);
        assert.equal(error.code, 'PVP_ROOM_HTTP_NETWORK_ERROR');
        assert.equal(error.retryable, true);
        assert.equal(error.cause instanceof Error, true);
        return true;
      },
    );
  });
});

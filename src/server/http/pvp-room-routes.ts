import { projectRoomView, RoomProjectionError, type RoomView } from '../projection/index.js';
import { RoomService, RoomServiceError } from '../rooms/index.js';
import type { ErrorEnvelope, HttpRequest, HttpResponse } from './http-types.js';

interface CreateRoomBody {
  generation: string;
  visibility: string;
  rulesetKey?: string;
}

interface JoinRoomBody {
  roomCode: string;
  generation: string;
}

interface PvpRoomRoutesOptions {
  service?: RoomService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCreateRoomBody(value: unknown): value is CreateRoomBody {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.generation === 'string'
    && typeof value.visibility === 'string'
    && (value.rulesetKey === undefined || typeof value.rulesetKey === 'string');
}

function isJoinRoomBody(value: unknown): value is JoinRoomBody {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.roomCode === 'string' && typeof value.generation === 'string';
}

function requirePlayerId(request: HttpRequest): string | HttpResponse<ErrorEnvelope> {
  const playerId = request.auth?.playerId?.trim();
  if (!playerId) {
    return {
      status: 401,
      body: {
        error: {
          code: 'PVP_UNAUTHORIZED',
          message: 'Authentication is required for PvP routes.',
          retryable: true,
        },
      },
    };
  }

  return playerId;
}

function invalidRequest(message: string, details?: Record<string, unknown>): HttpResponse<ErrorEnvelope> {
  return {
    status: 400,
    body: {
      error: {
        code: 'PVP_INVALID_REQUEST',
        message,
        retryable: false,
        details,
      },
    },
  };
}

function toErrorResponse(error: RoomServiceError | RoomProjectionError): HttpResponse<ErrorEnvelope> {
  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    },
  };
}

function requireRoomId(request: HttpRequest): string | HttpResponse<ErrorEnvelope> {
  const roomId = request.params?.roomId?.trim();
  if (!roomId) {
    return invalidRequest('The PvP room route requires a roomId parameter.');
  }

  return roomId;
}

export function createPvpRoomRoutes(options: PvpRoomRoutesOptions = {}) {
  const service = options.service ?? new RoomService();

  return {
    createRoom(request: HttpRequest): HttpResponse<RoomView | ErrorEnvelope> {
      const playerId = requirePlayerId(request);
      if (typeof playerId !== 'string') {
        return playerId;
      }

      if (!isCreateRoomBody(request.body)) {
        return invalidRequest('The PvP room create payload is malformed.');
      }

      try {
        const room = service.createRoom({
          playerId,
          generation: request.body.generation,
          visibility: request.body.visibility,
          rulesetKey: request.body.rulesetKey,
        });

        return {
          status: 200,
          body: projectRoomView(room, playerId),
        };
      } catch (error) {
        if (error instanceof RoomServiceError || error instanceof RoomProjectionError) {
          return toErrorResponse(error);
        }

        throw error;
      }
    },

    joinRoom(request: HttpRequest): HttpResponse<RoomView | ErrorEnvelope> {
      const playerId = requirePlayerId(request);
      if (typeof playerId !== 'string') {
        return playerId;
      }

      const roomId = requireRoomId(request);
      if (typeof roomId !== 'string') {
        return roomId;
      }

      if (!isJoinRoomBody(request.body)) {
        return invalidRequest('The PvP room join payload is malformed.');
      }

      try {
        const room = service.joinRoom({
          playerId,
          roomId,
          roomCode: request.body.roomCode,
          generation: request.body.generation,
        });

        return {
          status: 200,
          body: projectRoomView(room, playerId),
        };
      } catch (error) {
        if (error instanceof RoomServiceError || error instanceof RoomProjectionError) {
          return toErrorResponse(error);
        }

        throw error;
      }
    },

    getRoom(request: HttpRequest): HttpResponse<RoomView | ErrorEnvelope> {
      const playerId = requirePlayerId(request);
      if (typeof playerId !== 'string') {
        return playerId;
      }

      const roomId = requireRoomId(request);
      if (typeof roomId !== 'string') {
        return roomId;
      }

      try {
        const room = service.getRoom(roomId);
        return {
          status: 200,
          body: projectRoomView(room, playerId),
        };
      } catch (error) {
        if (error instanceof RoomServiceError || error instanceof RoomProjectionError) {
          return toErrorResponse(error);
        }

        throw error;
      }
    },
  };
}

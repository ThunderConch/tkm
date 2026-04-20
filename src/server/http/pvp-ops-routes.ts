import type { BattleDebugView } from '../battle/battle-types.js';
import type { ErrorEnvelope, HttpRequest, HttpResponse } from './http-types.js';

interface PvpOpsRoutesOptions {
  getBattleDebugView(roomId: string): BattleDebugView | undefined;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): HttpResponse<ErrorEnvelope> {
  return {
    status,
    body: {
      error: {
        code,
        message,
        retryable,
        details,
      },
    },
  };
}

function requireOperator(request: HttpRequest): HttpResponse<ErrorEnvelope> | undefined {
  const playerId = request.auth?.playerId?.trim();
  if (!playerId) {
    return errorResponse(401, 'PVP_UNAUTHORIZED', 'Authentication is required for PvP routes.', true);
  }

  if (request.auth?.operator !== true) {
    return errorResponse(403, 'PVP_OPERATOR_FORBIDDEN', 'Operator access is required for PvP ops routes.', false);
  }

  return undefined;
}

function requireRoomId(request: HttpRequest): string | HttpResponse<ErrorEnvelope> {
  const roomId = request.params?.roomId?.trim();
  if (!roomId) {
    return errorResponse(400, 'PVP_INVALID_REQUEST', 'The PvP ops route requires a roomId parameter.', false);
  }

  return roomId;
}

export function createPvpOpsRoutes(options: PvpOpsRoutesOptions) {
  return {
    getBattleDebug(request: HttpRequest): HttpResponse<BattleDebugView | ErrorEnvelope> {
      const authError = requireOperator(request);
      if (authError) {
        return authError;
      }

      const roomId = requireRoomId(request);
      if (typeof roomId !== 'string') {
        return roomId;
      }

      const view = options.getBattleDebugView(roomId);
      if (!view) {
        return errorResponse(
          404,
          'PVP_BATTLE_DEBUG_NOT_FOUND',
          'No PvP battle debug state exists for the requested room.',
          false,
          { roomId },
        );
      }

      return {
        status: 200,
        body: view,
      };
    },
  };
}

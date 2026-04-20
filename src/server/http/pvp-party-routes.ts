import {
  PartyRegistrationService,
  PartyRegistrationServiceError,
  type ActivePartySnapshot,
  type GrowthProofInput,
  type OnlinePartyMemberInput,
  type RegisterActivePartyResult,
} from '../parties/index.js';
import type { ErrorEnvelope, HttpRequest, HttpResponse } from './http-types.js';

interface PutActivePartyBody {
  sourceStateHash: string;
  sourceConfigHash: string;
  clientBuild?: string;
  members: OnlinePartyMemberInput[];
  growthProof: GrowthProofInput;
}

interface PvpPartyRoutesOptions {
  service?: PartyRegistrationService;
}

interface ActivePartyResponseBody {
  generation: RegisterActivePartyResult['generation'];
  rulesetKey: RegisterActivePartyResult['rulesetKey'];
  party: ReturnType<typeof serializeParty>;
}

interface PutActivePartyResponseBody extends ActivePartyResponseBody {
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGrowthProofInput(value: unknown): value is GrowthProofInput {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.proofVersion === 'string'
    && typeof value.capturedAt === 'string'
    && typeof value.sourceSaveId === 'string'
    && typeof value.sourceSaveRevision === 'number'
    && isRecord(value.cheatFlags)
    && typeof value.cheatFlags.hasCheatHistory === 'boolean'
    && Array.isArray(value.cheatFlags.flags)
    && Array.isArray(value.memberProofs);
}

function isOnlinePartyMemberInput(value: unknown): value is OnlinePartyMemberInput {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.slot === 'number'
    && typeof value.pokemonInstanceId === 'string'
    && typeof value.speciesId === 'string'
    && typeof value.levelActual === 'number'
    && Array.isArray(value.moves)
    && (value.nickname === undefined || typeof value.nickname === 'string');
}

function isPutActivePartyBody(value: unknown): value is PutActivePartyBody {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.sourceStateHash === 'string'
    && typeof value.sourceConfigHash === 'string'
    && (value.clientBuild === undefined || typeof value.clientBuild === 'string')
    && Array.isArray(value.members)
    && value.members.every(isOnlinePartyMemberInput)
    && isGrowthProofInput(value.growthProof);
}

function toErrorResponse(error: PartyRegistrationServiceError): HttpResponse<ErrorEnvelope> {
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

function serializeParty(snapshot: ActivePartySnapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.snapshotVersion,
    status: snapshot.status,
    registeredAt: snapshot.registeredAt,
    sourceStateHash: snapshot.sourceStateHash,
    sourceConfigHash: snapshot.sourceConfigHash,
    validationStatus: snapshot.validationStatus,
    partySummary: structuredClone(snapshot.partySummary),
    members: structuredClone(snapshot.members),
  };
}

export function createPvpPartyRoutes(options: PvpPartyRoutesOptions = {}) {
  const service = options.service ?? new PartyRegistrationService();

  return {
    getActiveParty(
      request: HttpRequest,
    ): HttpResponse<ActivePartyResponseBody | ErrorEnvelope> {
      const playerId = requirePlayerId(request);
      if (typeof playerId !== 'string') {
        return playerId;
      }

      try {
        const activeParty = service.getActiveParty({
          playerId,
          generation: request.params?.generation ?? '',
        });

        return {
          status: 200,
          body: {
            generation: activeParty.generation,
            rulesetKey: activeParty.rulesetKey,
            party: serializeParty(activeParty),
          },
        };
      } catch (error) {
        if (error instanceof PartyRegistrationServiceError) {
          return toErrorResponse(error);
        }

        throw error;
      }
    },

    putActiveParty(
      request: HttpRequest,
    ): HttpResponse<PutActivePartyResponseBody | ErrorEnvelope> {
      const playerId = requirePlayerId(request);
      if (typeof playerId !== 'string') {
        return playerId;
      }

      if (!isPutActivePartyBody(request.body)) {
        return invalidRequest('The PvP party registration payload is malformed.');
      }

      try {
        const result = service.registerActiveParty({
          playerId,
          generation: request.params?.generation ?? '',
          sourceStateHash: request.body.sourceStateHash,
          sourceConfigHash: request.body.sourceConfigHash,
          clientBuild: request.body.clientBuild,
          members: structuredClone(request.body.members),
          growthProof: structuredClone(request.body.growthProof),
        });

        return {
          status: 200,
          body: {
            generation: result.generation,
            rulesetKey: result.rulesetKey,
            changed: result.changed,
            party: serializeParty(result.party),
          },
        };
      } catch (error) {
        if (error instanceof PartyRegistrationServiceError) {
          return toErrorResponse(error);
        }

        throw error;
      }
    },
  };
}

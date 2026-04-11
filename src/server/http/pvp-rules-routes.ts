import type { RulesetSummary } from '../rules/index.js';
import { PartyRegistrationService, PartyRegistrationServiceError } from '../parties/index.js';
import type { ErrorEnvelope, HttpRequest, HttpResponse } from './http-types.js';

interface PvpRulesRoutesOptions {
  service?: PartyRegistrationService;
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

function serializeRuleset(ruleset: RulesetSummary): RulesetSummary {
  return structuredClone(ruleset);
}

export function createPvpRulesRoutes(options: PvpRulesRoutesOptions = {}) {
  const service = options.service ?? new PartyRegistrationService();

  return {
    getRuleset(request: HttpRequest): HttpResponse<RulesetSummary | ErrorEnvelope> {
      const playerId = requirePlayerId(request);
      if (typeof playerId !== 'string') {
        return playerId;
      }

      try {
        const ruleset = service.getRuleset(request.params?.generation ?? '');
        return {
          status: 200,
          body: serializeRuleset(ruleset),
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

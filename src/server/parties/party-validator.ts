import { getPokemonDB, speciesIdToGeneration } from '../../core/pokemon-data.js';
import type { Rarity } from '../../core/types.js';
import {
  computeGenerationEffectiveLevel,
  getRulesetByGeneration,
  isRestrictedSpecies,
} from '../rules/index.js';
import { validateGrowthProof } from './growth-proof.js';
import {
  PARTY_VALIDATION_ERROR_CODES,
  type OnlinePartyMemberSnapshotDraft,
  type OnlinePartySnapshotDraft,
  type PartyValidationIssue,
  type PartyValidationResult,
  type ValidateOnlinePartyInput,
} from './party-types.js';

interface NormalizedCandidateMember {
  slot: number;
  pokemonInstanceId: string;
  speciesId: string;
  nickname?: string;
  levelActual: number;
  moves: string[];
  rarity: Rarity;
  restricted: boolean;
}

function pushIssue(issues: PartyValidationIssue[], issue: PartyValidationIssue): void {
  if (issues.some((existing) => existing.code === issue.code && existing.field === issue.field)) {
    return;
  }

  issues.push(issue);
}

function normalizeNickname(nickname: string | undefined): string | undefined {
  if (typeof nickname !== 'string') {
    return undefined;
  }

  const trimmed = nickname.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMoves(moves: string[]): string[] {
  return moves.map((move) => move.trim());
}

function hasDuplicateValues(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function validateCandidateMembers(input: ValidateOnlinePartyInput): {
  issues: PartyValidationIssue[];
  members: NormalizedCandidateMember[];
} {
  const issues: PartyValidationIssue[] = [];
  const ruleset = getRulesetByGeneration(input.generation);
  const pokemonDb = getPokemonDB(input.generation);
  const slotSet = new Set<number>();
  const normalizedMembers: NormalizedCandidateMember[] = [];

  if (input.members.length !== ruleset.party.size) {
    pushIssue(issues, {
      code: PARTY_VALIDATION_ERROR_CODES.PVP_PARTY_SIZE_INVALID,
      field: 'members',
      meta: { expectedSize: ruleset.party.size, actualSize: input.members.length },
    });
  }

  for (const [index, member] of input.members.entries()) {
    const fieldPrefix = `members[${index}]`;
    let hasMemberIssue = false;

    if (!Number.isInteger(member.slot) || member.slot < 1 || member.slot > ruleset.party.size) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_PARTY_SLOT_INVALID,
        field: `${fieldPrefix}.slot`,
        meta: { slot: member.slot },
      });
      hasMemberIssue = true;
    }

    if (!hasMemberIssue && slotSet.has(member.slot)) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_PARTY_SLOT_DUPLICATE,
        field: `${fieldPrefix}.slot`,
        meta: { slot: member.slot },
      });
      hasMemberIssue = true;
    }
    if (!hasMemberIssue) {
      slotSet.add(member.slot);
    }

    if (typeof member.pokemonInstanceId !== 'string' || member.pokemonInstanceId.trim().length === 0) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_PARTY_INSTANCE_ID_INVALID,
        field: `${fieldPrefix}.pokemonInstanceId`,
      });
      hasMemberIssue = true;
    }

    if (!Number.isInteger(member.levelActual) || member.levelActual < 1) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_LEVEL_INVALID,
        field: `${fieldPrefix}.levelActual`,
        meta: { levelActual: member.levelActual },
      });
      hasMemberIssue = true;
    }

    const parsedSpeciesId = Number(member.speciesId);
    if (!Number.isInteger(parsedSpeciesId) || parsedSpeciesId < 1) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_SPECIES_INVALID,
        field: `${fieldPrefix}.speciesId`,
        meta: { speciesId: member.speciesId },
      });
      hasMemberIssue = true;
    }

    const normalizedSpeciesId = String(parsedSpeciesId);
    const generationBySpecies = Number.isInteger(parsedSpeciesId)
      ? speciesIdToGeneration(parsedSpeciesId)
      : undefined;
    if (
      Number.isInteger(parsedSpeciesId)
      && parsedSpeciesId >= 1
      && (generationBySpecies !== input.generation || !pokemonDb.pokemon[normalizedSpeciesId])
    ) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_SPECIES_UNKNOWN,
        field: `${fieldPrefix}.speciesId`,
        meta: { speciesId: member.speciesId, generation: input.generation },
      });
      hasMemberIssue = true;
    }

    if (!Array.isArray(member.moves) || member.moves.length !== 4) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_MOVES_INVALID,
        field: `${fieldPrefix}.moves`,
      });
      hasMemberIssue = true;
    }

    const moves = Array.isArray(member.moves) ? normalizeMoves(member.moves) : [];
    if (
      Array.isArray(member.moves)
      && (moves.some((move) => move.length === 0) || hasDuplicateValues(moves))
    ) {
      pushIssue(issues, {
        code: PARTY_VALIDATION_ERROR_CODES.PVP_MOVES_INVALID,
        field: `${fieldPrefix}.moves`,
      });
      hasMemberIssue = true;
    }

    if (hasMemberIssue) {
      continue;
    }

    normalizedMembers.push({
      slot: member.slot,
      pokemonInstanceId: member.pokemonInstanceId.trim(),
      speciesId: normalizedSpeciesId,
      nickname: normalizeNickname(member.nickname),
      levelActual: member.levelActual,
      moves,
      rarity: pokemonDb.pokemon[normalizedSpeciesId].rarity,
      restricted: isRestrictedSpecies(input.generation, normalizedSpeciesId),
    });
  }

  const duplicateSpecies = normalizedMembers.length > 0
    && new Set(normalizedMembers.map((member) => member.speciesId)).size !== normalizedMembers.length;
  if (duplicateSpecies) {
    pushIssue(issues, {
      code: PARTY_VALIDATION_ERROR_CODES.PVP_SPECIES_DUPLICATE,
      field: 'members[].speciesId',
    });
  }

  const legendaryMythicalCount = normalizedMembers.filter(
    (member) => member.rarity === 'legendary' || member.rarity === 'mythical',
  ).length;
  if (legendaryMythicalCount > ruleset.specialLimits.legendaryMythicalTotal) {
    pushIssue(issues, {
      code: PARTY_VALIDATION_ERROR_CODES.PVP_SPECIAL_LIMIT_LEGENDARY_MYTHICAL_EXCEEDED,
      field: 'members',
      meta: {
        limit: ruleset.specialLimits.legendaryMythicalTotal,
        actualCount: legendaryMythicalCount,
      },
    });
  }

  const restrictedCount = normalizedMembers.filter((member) => member.restricted).length;
  if (restrictedCount > ruleset.specialLimits.restrictedTotal) {
    pushIssue(issues, {
      code: PARTY_VALIDATION_ERROR_CODES.PVP_SPECIAL_LIMIT_RESTRICTED_EXCEEDED,
      field: 'members',
      meta: {
        limit: ruleset.specialLimits.restrictedTotal,
        actualCount: restrictedCount,
      },
    });
  }

  return { issues, members: normalizedMembers };
}

function toSnapshotMembers(
  generation: ValidateOnlinePartyInput['generation'],
  members: NormalizedCandidateMember[],
): OnlinePartyMemberSnapshotDraft[] {
  return [...members]
    .sort((left, right) => left.slot - right.slot)
    .map((member) => ({
      slot: member.slot,
      pokemonInstanceId: member.pokemonInstanceId,
      speciesId: member.speciesId,
      nickname: member.nickname,
      levelActual: member.levelActual,
      levelEffective: computeGenerationEffectiveLevel(member.levelActual, generation),
      specialClass: {
        legendary: member.rarity === 'legendary',
        mythical: member.rarity === 'mythical',
        restricted: member.restricted,
      },
      moves: [...member.moves],
    }));
}

function toFailure(issues: PartyValidationIssue[]): PartyValidationResult {
  return {
    ok: false,
    errorCodes: [...new Set(issues.map((issue) => issue.code))],
    issues,
  };
}

function buildSnapshotDraft(input: ValidateOnlinePartyInput, members: NormalizedCandidateMember[]): OnlinePartySnapshotDraft {
  const ruleset = getRulesetByGeneration(input.generation);
  const snapshotMembers = toSnapshotMembers(input.generation, members);

  return {
    generation: input.generation,
    rulesetKey: ruleset.rulesetKey,
    validationStatus: 'accepted',
    proofVersion: input.growthProof.proofVersion,
    capturedAt: input.growthProof.capturedAt,
    sourceSaveId: input.growthProof.sourceSaveId,
    sourceSaveRevision: input.growthProof.sourceSaveRevision,
    partySummary: {
      memberCount: snapshotMembers.length,
      legendaryMythicalCount: snapshotMembers.filter(
        (member) => member.specialClass.legendary || member.specialClass.mythical,
      ).length,
      restrictedCount: snapshotMembers.filter((member) => member.specialClass.restricted).length,
      speciesDupClause: ruleset.party.speciesDupClause,
    },
    members: snapshotMembers,
  };
}

export function validateOnlineParty(input: ValidateOnlinePartyInput): PartyValidationResult {
  const candidateResult = validateCandidateMembers(input);
  const growthProofResult = validateGrowthProof(input.growthProof, input.members);
  const issues = [...candidateResult.issues, ...growthProofResult.issues];

  if (issues.length > 0) {
    return toFailure(issues);
  }

  return {
    ok: true,
    snapshot: buildSnapshotDraft(input, candidateResult.members),
  };
}

import type { PvpGeneration, RulesetKey } from '../rules/index.js';

export const PARTY_VALIDATION_ERROR_CODES = {
  PVP_PARTY_SIZE_INVALID: 'PVP_PARTY_SIZE_INVALID',
  PVP_PARTY_SLOT_INVALID: 'PVP_PARTY_SLOT_INVALID',
  PVP_PARTY_SLOT_DUPLICATE: 'PVP_PARTY_SLOT_DUPLICATE',
  PVP_PARTY_INSTANCE_ID_INVALID: 'PVP_PARTY_INSTANCE_ID_INVALID',
  PVP_SPECIES_INVALID: 'PVP_SPECIES_INVALID',
  PVP_SPECIES_UNKNOWN: 'PVP_SPECIES_UNKNOWN',
  PVP_LEVEL_INVALID: 'PVP_LEVEL_INVALID',
  PVP_MOVES_INVALID: 'PVP_MOVES_INVALID',
  PVP_SPECIES_DUPLICATE: 'PVP_SPECIES_DUPLICATE',
  PVP_SPECIAL_LIMIT_LEGENDARY_MYTHICAL_EXCEEDED: 'PVP_SPECIAL_LIMIT_LEGENDARY_MYTHICAL_EXCEEDED',
  PVP_SPECIAL_LIMIT_RESTRICTED_EXCEEDED: 'PVP_SPECIAL_LIMIT_RESTRICTED_EXCEEDED',
  PVP_CHEAT_SAVE_DISALLOWED: 'PVP_CHEAT_SAVE_DISALLOWED',
  PVP_GROWTH_PROOF_VERSION_UNSUPPORTED: 'PVP_GROWTH_PROOF_VERSION_UNSUPPORTED',
  PVP_GROWTH_PROOF_MEMBER_COUNT_MISMATCH: 'PVP_GROWTH_PROOF_MEMBER_COUNT_MISMATCH',
  PVP_GROWTH_PROOF_MEMBER_MISMATCH: 'PVP_GROWTH_PROOF_MEMBER_MISMATCH',
} as const;

export type PartyValidationErrorCode =
  (typeof PARTY_VALIDATION_ERROR_CODES)[keyof typeof PARTY_VALIDATION_ERROR_CODES];

export interface OnlinePartyMemberInput {
  slot: number;
  pokemonInstanceId: string;
  speciesId: string;
  nickname?: string;
  levelActual: number;
  moves: string[];
}

export interface GrowthProofMemberInput {
  slot: number;
  pokemonInstanceId: string;
  speciesId: string;
  levelActual: number;
  movesHash: string;
  stateHash: string;
}

export interface GrowthProofInput {
  proofVersion: string;
  capturedAt: string;
  sourceSaveId: string;
  sourceSaveRevision: number;
  cheatFlags: {
    hasCheatHistory: boolean;
    flags: string[];
  };
  memberProofs: GrowthProofMemberInput[];
}

export interface PartyValidationIssue {
  code: PartyValidationErrorCode;
  field?: string;
  meta?: Record<string, unknown>;
}

export interface OnlinePartyMemberSnapshotDraft {
  slot: number;
  pokemonInstanceId: string;
  speciesId: string;
  nickname?: string;
  levelActual: number;
  levelEffective: number;
  specialClass: {
    legendary: boolean;
    mythical: boolean;
    restricted: boolean;
  };
  moves: string[];
}

export interface OnlinePartySnapshotDraft {
  generation: PvpGeneration;
  rulesetKey: RulesetKey;
  validationStatus: 'accepted';
  proofVersion: string;
  capturedAt: string;
  sourceSaveId: string;
  sourceSaveRevision: number;
  partySummary: {
    memberCount: number;
    legendaryMythicalCount: number;
    restrictedCount: number;
    speciesDupClause: boolean;
  };
  members: OnlinePartyMemberSnapshotDraft[];
}

export interface ValidateOnlinePartyInput {
  generation: PvpGeneration;
  members: OnlinePartyMemberInput[];
  growthProof: GrowthProofInput;
}

export type PartyValidationResult =
  | {
      ok: true;
      snapshot: OnlinePartySnapshotDraft;
    }
  | {
      ok: false;
      errorCodes: PartyValidationErrorCode[];
      issues: PartyValidationIssue[];
    };

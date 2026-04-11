import { getRulesetByGeneration, type PvpGeneration, type RulesetSummary } from '../rules/index.js';
import {
  InMemoryPartySnapshotRepository,
  type PartySnapshotRepository,
} from './party-snapshot-repository.js';
import { validateOnlineParty } from './party-validator.js';
import {
  PARTY_VALIDATION_ERROR_CODES,
  type ActivePartySnapshot,
  type PartyValidationIssue,
  type RegisterActivePartyInput,
  type RegisterActivePartyResult,
} from './party-types.js';

export interface PartyRegistrationServiceOptions {
  repository?: PartySnapshotRepository;
  now?: () => string;
}

interface ServiceErrorOptions {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function cloneSnapshot(snapshot: ActivePartySnapshot): ActivePartySnapshot {
  return structuredClone(snapshot);
}

function buildValidationDetails(
  generation: PvpGeneration,
  issues: PartyValidationIssue[],
): Record<string, unknown> {
  const [firstIssue] = issues;

  return {
    generation,
    issueCount: issues.length,
    field: firstIssue?.field,
    issues: issues.map((issue) => ({
      code: issue.code,
      field: issue.field,
      meta: issue.meta,
    })),
    ...firstIssue?.meta,
  };
}

function mapValidationStatus(issueCode: PartyValidationIssue['code']): number {
  switch (issueCode) {
    case PARTY_VALIDATION_ERROR_CODES.PVP_CHEAT_SAVE_DISALLOWED:
      return 403;
    default:
      return 422;
  }
}

function mapValidationMessage(issueCode: PartyValidationIssue['code']): string {
  switch (issueCode) {
    case PARTY_VALIDATION_ERROR_CODES.PVP_CHEAT_SAVE_DISALLOWED:
      return 'Cheat-contaminated saves cannot be registered for online PvP.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_PARTY_SIZE_INVALID:
      return 'Online PvP parties must contain exactly 6 members.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_PARTY_SLOT_DUPLICATE:
      return 'Duplicate party slots are not allowed.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_SPECIES_DUPLICATE:
      return 'Duplicate species are not allowed in an online party.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_SPECIAL_LIMIT_LEGENDARY_MYTHICAL_EXCEEDED:
      return 'Legendary and mythical Pokémon exceed the allowed total.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_SPECIAL_LIMIT_RESTRICTED_EXCEEDED:
      return 'Restricted Pokémon exceed the allowed total.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_VERSION_UNSUPPORTED:
      return 'The submitted growth proof version is not supported.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_MEMBER_COUNT_MISMATCH:
    case PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_MEMBER_MISMATCH:
      return 'The submitted growth proof does not match the registered party.';
    case PARTY_VALIDATION_ERROR_CODES.PVP_MOVES_INVALID:
      return 'The submitted moveset is invalid for online PvP registration.';
    default:
      return 'The submitted party failed online PvP validation.';
  }
}

function buildRegistrationFingerprint(snapshot: ActivePartySnapshot): string {
  return stableStringify({
    rulesetKey: snapshot.rulesetKey,
    sourceStateHash: snapshot.sourceStateHash,
    sourceConfigHash: snapshot.sourceConfigHash,
    proofVersion: snapshot.proofVersion,
    sourceSaveId: snapshot.sourceSaveId,
    sourceSaveRevision: snapshot.sourceSaveRevision,
    partySummary: snapshot.partySummary,
    members: snapshot.members,
  });
}

function buildCandidateFingerprint(
  input: RegisterActivePartyInput,
  ruleset: RulesetSummary,
  snapshot: RegisterActivePartyResult['party'],
): string {
  return stableStringify({
    rulesetKey: ruleset.rulesetKey,
    sourceStateHash: input.sourceStateHash,
    sourceConfigHash: input.sourceConfigHash,
    proofVersion: input.growthProof.proofVersion,
    sourceSaveId: input.growthProof.sourceSaveId,
    sourceSaveRevision: input.growthProof.sourceSaveRevision,
    partySummary: snapshot.partySummary,
    members: snapshot.members,
  });
}

export class PartyRegistrationServiceError extends Error {
  readonly status: number;

  readonly code: string;

  readonly retryable: boolean;

  readonly details?: Record<string, unknown>;

  constructor(options: ServiceErrorOptions) {
    super(options.message);
    this.name = 'PartyRegistrationServiceError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}

export class PartyRegistrationService {
  private readonly repository: PartySnapshotRepository;

  private readonly now: () => string;

  constructor(options: PartyRegistrationServiceOptions = {}) {
    this.repository = options.repository ?? new InMemoryPartySnapshotRepository();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getRuleset(generation: string): RulesetSummary {
    return structuredClone(this.resolveRuleset(generation));
  }

  getActiveParty(input: { playerId: string; generation: string }): ActivePartySnapshot {
    const ruleset = this.resolveRuleset(input.generation);
    const activeSnapshot = this.repository.getActiveSnapshot(input.playerId, ruleset.generation);

    if (!activeSnapshot) {
      throw new PartyRegistrationServiceError({
        status: 404,
        code: 'PVP_ACTIVE_PARTY_NOT_FOUND',
        message: 'No active online party is registered for this generation.',
        retryable: false,
        details: { generation: ruleset.generation },
      });
    }

    if (activeSnapshot.rulesetKey !== ruleset.rulesetKey) {
      throw new PartyRegistrationServiceError({
        status: 409,
        code: 'PVP_RULESET_MISMATCH',
        message: 'The active party is pinned to an outdated PvP ruleset.',
        retryable: true,
        details: {
          generation: ruleset.generation,
          activeRulesetKey: ruleset.rulesetKey,
          snapshotRulesetKey: activeSnapshot.rulesetKey,
          snapshotId: activeSnapshot.snapshotId,
        },
      });
    }

    return cloneSnapshot(activeSnapshot);
  }

  registerActiveParty(input: RegisterActivePartyInput): RegisterActivePartyResult {
    const ruleset = this.resolveRuleset(input.generation);
    const validationResult = validateOnlineParty({
      generation: ruleset.generation,
      members: structuredClone(input.members),
      growthProof: structuredClone(input.growthProof),
    });

    if (!validationResult.ok) {
      const [primaryIssue] = validationResult.issues;
      const primaryCode = primaryIssue?.code ?? 'PVP_INVALID_REQUEST';
      throw new PartyRegistrationServiceError({
        status: mapValidationStatus(primaryCode),
        code: primaryCode,
        message: mapValidationMessage(primaryCode),
        retryable: false,
        details: buildValidationDetails(ruleset.generation, validationResult.issues),
      });
    }

    const activeSnapshot = this.repository.getActiveSnapshot(input.playerId, ruleset.generation);
    const candidateSnapshot: ActivePartySnapshot = {
      ...validationResult.snapshot,
      snapshotId: '__candidate__',
      snapshotVersion: activeSnapshot?.snapshotVersion ?? 1,
      playerId: input.playerId,
      generation: ruleset.generation,
      rulesetKey: ruleset.rulesetKey,
      status: 'active',
      isActive: true,
      registeredAt: activeSnapshot?.registeredAt ?? this.now(),
      sourceStateHash: input.sourceStateHash,
      sourceConfigHash: input.sourceConfigHash,
      clientBuild: input.clientBuild,
      growthProof: structuredClone(input.growthProof),
    };
    const candidateFingerprint = buildCandidateFingerprint(input, ruleset, candidateSnapshot);

    if (activeSnapshot && buildRegistrationFingerprint(activeSnapshot) === candidateFingerprint) {
      return {
        generation: ruleset.generation,
        rulesetKey: ruleset.rulesetKey,
        changed: false,
        party: cloneSnapshot(activeSnapshot),
      };
    }

    const nextSnapshot: ActivePartySnapshot = {
      ...candidateSnapshot,
      snapshotId: this.repository.createSnapshotId(ruleset.generation),
      snapshotVersion: this.repository.getNextSnapshotVersion(input.playerId, ruleset.generation),
      registeredAt: this.now(),
    };

    this.repository.replaceActiveSnapshot(nextSnapshot);

    return {
      generation: ruleset.generation,
      rulesetKey: ruleset.rulesetKey,
      changed: true,
      party: cloneSnapshot(nextSnapshot),
    };
  }

  private resolveRuleset(generation: string): RulesetSummary {
    try {
      return getRulesetByGeneration(generation);
    } catch {
      throw new PartyRegistrationServiceError({
        status: 404,
        code: 'PVP_RULESET_NOT_FOUND',
        message: 'No active PvP ruleset is configured for this generation.',
        retryable: false,
        details: { generation },
      });
    }
  }
}

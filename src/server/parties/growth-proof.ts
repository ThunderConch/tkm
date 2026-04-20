import type {
  GrowthProofInput,
  GrowthProofMemberInput,
  OnlinePartyMemberInput,
  PartyValidationIssue,
} from './party-types.js';
import { PARTY_VALIDATION_ERROR_CODES } from './party-types.js';

const SUPPORTED_GROWTH_PROOF_VERSION = 'v1';

export interface NormalizedGrowthProof {
  proofVersion: string;
  capturedAt: string;
  sourceSaveId: string;
  sourceSaveRevision: number;
  memberProofs: GrowthProofMemberInput[];
}

export function validateGrowthProof(
  growthProof: GrowthProofInput,
  members: OnlinePartyMemberInput[],
): { issues: PartyValidationIssue[]; normalizedProof?: NormalizedGrowthProof } {
  const issues: PartyValidationIssue[] = [];

  if (growthProof.proofVersion !== SUPPORTED_GROWTH_PROOF_VERSION) {
    issues.push({
      code: PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_VERSION_UNSUPPORTED,
      field: 'growthProof.proofVersion',
      meta: { proofVersion: growthProof.proofVersion },
    });
  }

  if (growthProof.cheatFlags?.hasCheatHistory === true) {
    issues.push({
      code: PARTY_VALIDATION_ERROR_CODES.PVP_CHEAT_SAVE_DISALLOWED,
      field: 'growthProof.cheatFlags.hasCheatHistory',
    });
  }

  if (growthProof.memberProofs.length !== members.length) {
    issues.push({
      code: PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_MEMBER_COUNT_MISMATCH,
      field: 'growthProof.memberProofs',
      meta: {
        expectedCount: members.length,
        actualCount: growthProof.memberProofs.length,
      },
    });
  }

  const proofBySlot = new Map<number, GrowthProofMemberInput>();
  for (const proof of growthProof.memberProofs) {
    proofBySlot.set(proof.slot, proof);
  }

  for (const member of members) {
    const proof = proofBySlot.get(member.slot);
    if (!proof) {
      issues.push({
        code: PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_MEMBER_MISMATCH,
        field: `growthProof.memberProofs[slot=${member.slot}]`,
        meta: { reason: 'missing-proof', slot: member.slot },
      });
      continue;
    }

    if (
      proof.slot !== member.slot
      || proof.pokemonInstanceId !== member.pokemonInstanceId
      || proof.speciesId !== member.speciesId
      || proof.levelActual !== member.levelActual
    ) {
      issues.push({
        code: PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_MEMBER_MISMATCH,
        field: `growthProof.memberProofs[slot=${member.slot}]`,
        meta: { reason: 'member-mismatch', slot: member.slot },
      });
    }
  }

  if (issues.length > 0) {
    return { issues };
  }

  return {
    issues,
    normalizedProof: {
      proofVersion: growthProof.proofVersion,
      capturedAt: growthProof.capturedAt,
      sourceSaveId: growthProof.sourceSaveId,
      sourceSaveRevision: growthProof.sourceSaveRevision,
      memberProofs: [...growthProof.memberProofs].sort((left, right) => left.slot - right.slot),
    },
  };
}

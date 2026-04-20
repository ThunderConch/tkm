import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PARTY_VALIDATION_ERROR_CODES,
  validateOnlineParty,
  type GrowthProofInput,
  type OnlinePartyMemberInput,
  type PvpGeneration,
} from '../src/server/parties/index.js';

function makeMember(slot: number, speciesId: string, levelActual = 50): OnlinePartyMemberInput {
  return {
    slot,
    pokemonInstanceId: `pkm-${slot}`,
    speciesId,
    nickname: `P-${slot}`,
    levelActual,
    moves: [`move-${slot}-1`, `move-${slot}-2`, `move-${slot}-3`, `move-${slot}-4`],
  };
}

function makeGrowthProof(members: OnlinePartyMemberInput[]): GrowthProofInput {
  return {
    proofVersion: 'v1',
    capturedAt: '2026-04-11T08:00:00Z',
    sourceSaveId: 'save_main',
    sourceSaveRevision: 12,
    cheatFlags: {
      hasCheatHistory: false,
      flags: [],
    },
    memberProofs: members.map((member) => ({
      slot: member.slot,
      pokemonInstanceId: member.pokemonInstanceId,
      speciesId: member.speciesId,
      levelActual: member.levelActual,
      movesHash: `sha256:moves-${member.slot}`,
      stateHash: `sha256:state-${member.slot}`,
    })),
  };
}

function makeRequest(generation: PvpGeneration = 'gen4') {
  const members = [
    makeMember(1, '387', 12),
    makeMember(2, '390', 18),
    makeMember(3, '393', 24),
    makeMember(4, '403', 31),
    makeMember(5, '483', 72),
    makeMember(6, '490', 55),
  ];

  return {
    generation,
    members,
    growthProof: makeGrowthProof(members),
  };
}

test('6마리 정상 파티를 정규화된 snapshot draft로 승인한다', () => {
  const result = validateOnlineParty(makeRequest());

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(`expected success but got ${result.errorCodes.join(',')}`);
  }

  assert.equal(result.snapshot.generation, 'gen4');
  assert.equal(result.snapshot.validationStatus, 'accepted');
  assert.equal(result.snapshot.partySummary.memberCount, 6);
  assert.equal(result.snapshot.partySummary.legendaryMythicalCount, 2);
  assert.equal(result.snapshot.partySummary.restrictedCount, 1);
  assert.equal(result.snapshot.partySummary.speciesDupClause, true);
  assert.deepEqual(
    result.snapshot.members.map((member) => member.slot),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(result.snapshot.members[4].specialClass.legendary, true);
  assert.equal(result.snapshot.members[4].specialClass.restricted, true);
  assert.equal(result.snapshot.members[4].levelActual, 72);
  assert.equal(result.snapshot.members[4].levelEffective, 55);
  assert.equal(result.snapshot.members[5].specialClass.mythical, true);
});

test('중복 종 파티를 거부한다', () => {
  const request = makeRequest();
  request.members[5] = makeMember(6, '387', 22);
  request.growthProof = makeGrowthProof(request.members);

  const result = validateOnlineParty(request);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errorCodes, [PARTY_VALIDATION_ERROR_CODES.PVP_SPECIES_DUPLICATE]);
});

test('legendary + mythical 총량 2 초과를 거부한다', () => {
  const request = makeRequest();
  request.members[0] = makeMember(1, '480', 50);
  request.members[1] = makeMember(2, '481', 50);
  request.members[2] = makeMember(3, '491', 50);
  request.growthProof = makeGrowthProof(request.members);

  const result = validateOnlineParty(request);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errorCodes.includes(
      PARTY_VALIDATION_ERROR_CODES.PVP_SPECIAL_LIMIT_LEGENDARY_MYTHICAL_EXCEEDED,
    ),
  );
});

test('restricted 2마리 파티를 거부한다', () => {
  const request = makeRequest();
  request.members[5] = makeMember(6, '484', 66);
  request.growthProof = makeGrowthProof(request.members);

  const result = validateOnlineParty(request);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errorCodes.includes(PARTY_VALIDATION_ERROR_CODES.PVP_SPECIAL_LIMIT_RESTRICTED_EXCEEDED),
  );
});

test('치트 오염 save는 기본 거부한다', () => {
  const request = makeRequest();
  request.growthProof.cheatFlags.hasCheatHistory = true;

  const result = validateOnlineParty(request);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errorCodes.includes(PARTY_VALIDATION_ERROR_CODES.PVP_CHEAT_SAVE_DISALLOWED));
});

test('growth proof slot 불일치를 거부한다', () => {
  const request = makeRequest();
  request.growthProof.memberProofs[0].slot = 2;

  const result = validateOnlineParty(request);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errorCodes.includes(PARTY_VALIDATION_ERROR_CODES.PVP_GROWTH_PROOF_MEMBER_MISMATCH));
});

test('slot/moves/species 기본 입력 검증을 수행한다', () => {
  const request = makeRequest();
  request.members[0] = {
    ...request.members[0],
    slot: 0,
    speciesId: '99999',
    moves: ['solo-move'],
  };
  request.growthProof = makeGrowthProof(request.members);

  const result = validateOnlineParty(request);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errorCodes.includes(PARTY_VALIDATION_ERROR_CODES.PVP_PARTY_SLOT_INVALID));
  assert.ok(result.errorCodes.includes(PARTY_VALIDATION_ERROR_CODES.PVP_SPECIES_UNKNOWN));
  assert.ok(result.errorCodes.includes(PARTY_VALIDATION_ERROR_CODES.PVP_MOVES_INVALID));
});

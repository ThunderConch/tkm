import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryPartySnapshotRepository,
  PartyRegistrationService,
  PartyRegistrationServiceError,
  type ActivePartySnapshot,
  type GrowthProofInput,
  type OnlinePartyMemberInput,
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
    capturedAt: '2026-04-11T09:00:00Z',
    sourceSaveId: 'save_main',
    sourceSaveRevision: 101,
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

function makeMembers(): OnlinePartyMemberInput[] {
  return [
    makeMember(1, '387', 12),
    makeMember(2, '390', 18),
    makeMember(3, '393', 24),
    makeMember(4, '403', 31),
    makeMember(5, '483', 72),
    makeMember(6, '490', 55),
  ];
}

function makeRegisterInput() {
  const members = makeMembers();

  return {
    playerId: 'player-1',
    generation: 'gen4' as const,
    sourceStateHash: 'sha256:state-a',
    sourceConfigHash: 'sha256:config-a',
    clientBuild: 'tokenmon-cli/0.120.0',
    members,
    growthProof: makeGrowthProof(members),
  };
}

test('활성 파티를 최초 등록하고 동일 입력은 멱등 처리한다', () => {
  const repository = new InMemoryPartySnapshotRepository();
  const service = new PartyRegistrationService({ repository });
  const input = makeRegisterInput();

  const firstResult = service.registerActiveParty(input);

  assert.equal(firstResult.changed, true);
  assert.equal(firstResult.party.snapshotVersion, 1);
  assert.match(firstResult.party.snapshotId, /^ops_gen4_\d{6}$/);
  assert.equal(firstResult.party.rulesetKey, 'tkm-friendly-gen4-v1');
  assert.equal(firstResult.party.members[4].levelEffective, 55);

  const secondResult = service.registerActiveParty(input);

  assert.equal(secondResult.changed, false);
  assert.equal(secondResult.party.snapshotId, firstResult.party.snapshotId);
  assert.equal(secondResult.party.snapshotVersion, 1);
});

test('다른 입력으로 재등록하면 snapshotVersion을 증가시키고 활성 스냅샷을 교체한다', () => {
  const repository = new InMemoryPartySnapshotRepository();
  const service = new PartyRegistrationService({ repository });
  const firstInput = makeRegisterInput();
  const secondInput = makeRegisterInput();
  secondInput.sourceStateHash = 'sha256:state-b';
  secondInput.members[0] = {
    ...secondInput.members[0],
    nickname: 'Starter',
  };
  secondInput.growthProof = makeGrowthProof(secondInput.members);

  const firstResult = service.registerActiveParty(firstInput);
  const secondResult = service.registerActiveParty(secondInput);
  const activeParty = service.getActiveParty({ playerId: 'player-1', generation: 'gen4' });

  assert.equal(secondResult.changed, true);
  assert.notEqual(secondResult.party.snapshotId, firstResult.party.snapshotId);
  assert.equal(secondResult.party.snapshotVersion, 2);
  assert.equal(activeParty.snapshotId, secondResult.party.snapshotId);
  assert.equal(activeParty.members[0].nickname, 'Starter');
});

test('ruleset이 바뀐 활성 스냅샷은 조회 시 mismatch로 거부한다', () => {
  const repository = new InMemoryPartySnapshotRepository();
  const service = new PartyRegistrationService({ repository });
  const registered = service.registerActiveParty(makeRegisterInput());

  repository.seedSnapshots([
    {
      ...registered.party,
      playerId: 'player-1',
      generation: 'gen4',
      rulesetKey: 'tkm-friendly-gen4-v999',
      isActive: true,
    } as ActivePartySnapshot,
  ]);

  assert.throws(
    () => service.getActiveParty({ playerId: 'player-1', generation: 'gen4' }),
    (error: unknown) => {
      assert.ok(error instanceof PartyRegistrationServiceError);
      assert.equal(error.code, 'PVP_RULESET_MISMATCH');
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test('검증 실패는 서비스 에러로 승격한다', () => {
  const repository = new InMemoryPartySnapshotRepository();
  const service = new PartyRegistrationService({ repository });
  const input = makeRegisterInput();
  input.members[5] = makeMember(6, '387', 44);
  input.growthProof = makeGrowthProof(input.members);

  assert.throws(
    () => service.registerActiveParty(input),
    (error: unknown) => {
      assert.ok(error instanceof PartyRegistrationServiceError);
      assert.equal(error.code, 'PVP_SPECIES_DUPLICATE');
      assert.equal(error.status, 422);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

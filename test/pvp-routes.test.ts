import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPvpPartyRoutes } from '../src/server/http/pvp-party-routes.js';
import { createPvpRulesRoutes } from '../src/server/http/pvp-rules-routes.js';
import {
  InMemoryPartySnapshotRepository,
  PartyRegistrationService,
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

function createRoutes() {
  const repository = new InMemoryPartySnapshotRepository();
  const service = new PartyRegistrationService({ repository });

  return {
    rulesRoutes: createPvpRulesRoutes({ service }),
    partyRoutes: createPvpPartyRoutes({ service }),
  };
}

test('ruleset 조회는 인증이 없으면 401을 반환한다', () => {
  const { rulesRoutes } = createRoutes();

  const response = rulesRoutes.getRuleset({
    params: { generation: 'gen4' },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'PVP_UNAUTHORIZED');
});

test('ruleset 조회는 현재 활성 ruleset summary를 반환한다', () => {
  const { rulesRoutes } = createRoutes();

  const response = rulesRoutes.getRuleset({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.generation, 'gen4');
  assert.equal(response.body.rulesetKey, 'tkm-friendly-gen4-v1');
});

test('활성 파티가 없으면 404 envelope를 반환한다', () => {
  const { partyRoutes } = createRoutes();

  const response = partyRoutes.getActiveParty({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'PVP_ACTIVE_PARTY_NOT_FOUND');
});

test('활성 파티 등록 후 조회할 수 있다', () => {
  const { partyRoutes } = createRoutes();
  const members = makeMembers();

  const putResponse = partyRoutes.putActiveParty({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
    body: {
      sourceStateHash: 'sha256:state-a',
      sourceConfigHash: 'sha256:config-a',
      clientBuild: 'tokenmon-cli/0.120.0',
      members,
      growthProof: makeGrowthProof(members),
    },
  });

  assert.equal(putResponse.status, 200);
  assert.equal(putResponse.body.changed, true);
  assert.equal(putResponse.body.party.snapshotVersion, 1);

  const getResponse = partyRoutes.getActiveParty({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
  });

  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.party.snapshotId, putResponse.body.party.snapshotId);
  assert.equal(getResponse.body.party.members[4].levelEffective, 55);
});

test('같은 입력 재등록은 changed false를 반환한다', () => {
  const { partyRoutes } = createRoutes();
  const members = makeMembers();
  const body = {
    sourceStateHash: 'sha256:state-a',
    sourceConfigHash: 'sha256:config-a',
    clientBuild: 'tokenmon-cli/0.120.0',
    members,
    growthProof: makeGrowthProof(members),
  };

  partyRoutes.putActiveParty({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
    body,
  });

  const secondResponse = partyRoutes.putActiveParty({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
    body,
  });

  assert.equal(secondResponse.status, 200);
  assert.equal(secondResponse.body.changed, false);
  assert.equal(secondResponse.body.party.snapshotVersion, 1);
});

test('검증 실패는 422 error envelope로 노출한다', () => {
  const { partyRoutes } = createRoutes();
  const members = makeMembers();
  members[5] = makeMember(6, '387', 55);

  const response = partyRoutes.putActiveParty({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
    body: {
      sourceStateHash: 'sha256:state-a',
      sourceConfigHash: 'sha256:config-a',
      clientBuild: 'tokenmon-cli/0.120.0',
      members,
      growthProof: makeGrowthProof(members),
    },
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'PVP_SPECIES_DUPLICATE');
  assert.equal(response.body.error.retryable, false);
});

test('shape이 잘못된 등록 요청은 400을 반환한다', () => {
  const { partyRoutes } = createRoutes();

  const response = partyRoutes.putActiveParty({
    auth: { playerId: 'player-1' },
    params: { generation: 'gen4' },
    body: {
      sourceStateHash: 'sha256:state-a',
      members: [],
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'PVP_INVALID_REQUEST');
});
